package db

// Opt-in integration coverage for migration 052 and the persistence invariants
// behind Ask Previously. Set TEST_DATABASE_URL to run against a migrated dev DB.

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestRecapConversationPersistenceIdempotencyAndRewindSafety(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	libraryID := seedTestLibrary(t, q, userID)

	var profileID, otherProfileID, mediaID, seasonID, episode2ID, episode3ID int64
	if err := q.pool.QueryRow(ctx, `
		INSERT INTO user_profiles (user_id, name, is_default) VALUES ($1, 'Viewer', TRUE) RETURNING id`, userID).Scan(&profileID); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	if err := q.pool.QueryRow(ctx, `
		INSERT INTO user_profiles (user_id, name, is_default) VALUES ($1, 'Other viewer', FALSE) RETURNING id`, userID).Scan(&otherProfileID); err != nil {
		t.Fatalf("seed other profile: %v", err)
	}
	if err := q.pool.QueryRow(ctx, `
		INSERT INTO media_items (library_id, type, title, sort_title)
		VALUES ($1, 'show', 'Ask Previously Test', 'Ask Previously Test') RETURNING id`, libraryID).Scan(&mediaID); err != nil {
		t.Fatalf("seed show: %v", err)
	}
	if err := q.pool.QueryRow(ctx, `INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1, 1) RETURNING id`, mediaID).Scan(&seasonID); err != nil {
		t.Fatalf("seed season: %v", err)
	}
	for episode := 1; episode <= 3; episode++ {
		var id int64
		if err := q.pool.QueryRow(ctx, `
			INSERT INTO tv_episodes (season_id, media_item_id, episode_number, title, overview)
			VALUES ($1, $2, $3, $4, $5) RETURNING id`, seasonID, mediaID, episode,
			"Episode", "A spoiler-safe synopsis.").Scan(&id); err != nil {
			t.Fatalf("seed episode %d: %v", episode, err)
		}
		if episode == 2 {
			episode2ID = id
		}
		if episode == 3 {
			episode3ID = id
		}
	}

	e2 := &RecapBoundary{EpisodeID: episode2ID, SeasonNumber: 1, EpisodeNumber: 2, Title: "Episode 2"}
	if _, err := q.pool.Exec(ctx, `
		INSERT INTO watch_progress (user_id, profile_id, media_item_id, episode_id, completed)
		VALUES ($1, $2, $3, $4, TRUE)`, userID, profileID, mediaID, episode2ID); err != nil {
		t.Fatalf("seed episode 2 progress: %v", err)
	}
	if err := q.UpsertRecap(ctx, mediaID, episode2ID, "Previously…", []string{"Who is Paige?", "Who is Sam?", "What changed?"}, "test-model", "test-hash"); err != nil {
		t.Fatalf("upsert recap suggestions: %v", err)
	}
	if cached, found, err := q.GetCachedRecap(ctx, mediaID, episode2ID); err != nil || !found || len(cached.SuggestedQuestions) != 3 {
		t.Fatalf("cached recap suggestions: found=%v cached=%+v err=%v", found, cached, err)
	}
	firstID := "550e8400-e29b-41d4-a716-446655440000"
	firstQuestion := "Who is Paige?"
	firstHash := testQuestionHash(firstQuestion)
	reservation, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		firstID, firstHash, 2*time.Minute, 20, time.Hour)
	if err != nil || reservation.ExistingTurn != nil {
		t.Fatalf("reserve first turn: reservation=%+v err=%v", reservation, err)
	}
	first, current, err := q.InsertRecapConversationTurn(ctx, reservation.ID, profileID, mediaID,
		firstID, firstHash, firstQuestion, "Paige is a Halliwell.", e2, "grounded")
	if err != nil || current.EpisodeNumber != 2 {
		t.Fatalf("insert first turn: current=%+v err=%v", current, err)
	}
	duplicateReservation, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		firstID, firstHash, 2*time.Minute, 20, time.Hour)
	if err != nil || duplicateReservation.ExistingTurn == nil {
		t.Fatalf("reserve completed duplicate: reservation=%+v err=%v", duplicateReservation, err)
	}
	duplicate := duplicateReservation.ExistingTurn
	if duplicate.ID != first.ID || duplicate.Question != first.Question || duplicate.Answer != first.Answer {
		t.Fatalf("duplicate changed immutable turn: first=%+v duplicate=%+v", first, duplicate)
	}
	if _, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		firstID, testQuestionHash("Changed question"), 2*time.Minute, 20, time.Hour); !errors.Is(err, ErrRecapRequestConflict) {
		t.Fatalf("changed duplicate err=%v, want ErrRecapRequestConflict", err)
	}

	e3 := &RecapBoundary{EpisodeID: episode3ID, SeasonNumber: 1, EpisodeNumber: 3, Title: "Episode 3"}
	if _, err := q.pool.Exec(ctx, `
		INSERT INTO watch_progress (user_id, profile_id, media_item_id, episode_id, completed)
		VALUES ($1, $2, $3, $4, TRUE)`, userID, profileID, mediaID, episode3ID); err != nil {
		t.Fatalf("seed episode 3 progress: %v", err)
	}
	secondID, secondQuestion := "8c2f94a0-837f-4ac2-90b6-44ef2a768f05", "What changed?"
	secondReservation, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		secondID, testQuestionHash(secondQuestion), 2*time.Minute, 20, time.Hour)
	if err != nil {
		t.Fatalf("reserve later turn: %v", err)
	}
	if _, _, err := q.InsertRecapConversationTurn(ctx, secondReservation.ID, profileID, mediaID,
		secondID, testQuestionHash(secondQuestion), secondQuestion, "The sisters reunited.", e3, "caught-up"); err != nil {
		t.Fatalf("insert later turn: %v", err)
	}
	if _, err := q.pool.Exec(ctx, `DELETE FROM watch_progress WHERE profile_id = $1 AND episode_id = $2`, profileID, episode3ID); err != nil {
		t.Fatalf("rewind progress: %v", err)
	}
	rewoundID, rewoundQuestion := "aaf7e4f6-c7dc-43dc-9950-14665e9f84f4", "Is episode three safe?"
	rewoundReservation, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		rewoundID, testQuestionHash(rewoundQuestion), 2*time.Minute, 20, time.Hour)
	if err != nil {
		t.Fatalf("reserve rewound turn: %v", err)
	}
	if _, _, err := q.InsertRecapConversationTurn(ctx, rewoundReservation.ID, profileID, mediaID,
		rewoundID, testQuestionHash(rewoundQuestion), rewoundQuestion, "No.", e3, "caught-up"); !errors.Is(err, ErrRecapBoundaryChanged) {
		t.Fatalf("rewound insert err=%v, want ErrRecapBoundaryChanged", err)
	}
	if err := q.FailRecapConversationRequest(ctx, rewoundReservation.ID); err != nil {
		t.Fatalf("fail rewound reservation: %v", err)
	}

	page, err := q.ListRecapConversationTurns(ctx, profileID, mediaID, 1, 2, 0, 20)
	if err != nil {
		t.Fatalf("list rewound conversation: %v", err)
	}
	if len(page.Turns) != 1 || page.Turns[0].ID != first.ID {
		t.Fatalf("safe turns=%+v want only first", page.Turns)
	}
	if page.HiddenTurnCount != 1 || page.HighestHiddenTurn == nil || page.HighestHiddenTurn.BoundaryEpisode != 3 {
		t.Fatalf("hidden summary=%+v", page)
	}
	other, err := q.ListRecapConversationTurns(ctx, otherProfileID, mediaID, 1, 3, 0, 20)
	if err != nil || len(other.Turns) != 0 || other.HiddenTurnCount != 0 {
		t.Fatalf("other profile leaked turns: page=%+v err=%v", other, err)
	}

	if err := q.ClearUnsafeRecapTurnsAtCurrentBoundary(ctx, profileID, mediaID); err != nil {
		t.Fatalf("clear unsafe: %v", err)
	}
	page, err = q.ListRecapConversationTurns(ctx, profileID, mediaID, 1, 3, 0, 20)
	if err != nil || len(page.Turns) != 1 || page.HiddenTurnCount != 0 {
		t.Fatalf("after clear unsafe: page=%+v err=%v", page, err)
	}
	reusedReservation, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		secondID, testQuestionHash(secondQuestion), 2*time.Minute, 20, time.Hour)
	if err != nil || reusedReservation.ExistingTurn != nil {
		t.Fatalf("unsafe clear must remove completed idempotency state: reservation=%+v err=%v", reusedReservation, err)
	}
	if err := q.FailRecapConversationRequest(ctx, reusedReservation.ID); err != nil {
		t.Fatalf("fail reused unsafe reservation: %v", err)
	}

	if _, err := q.pool.Exec(ctx, `DELETE FROM watch_progress WHERE profile_id = $1 AND episode_id = $2`, profileID, episode2ID); err != nil {
		t.Fatalf("rewind all progress: %v", err)
	}
	snapshot, err := q.LoadRecapConversationSnapshot(ctx, profileID, mediaID, 0, 20)
	if err != nil || snapshot.Boundary != nil || snapshot.Page.HiddenTurnCount != 1 || len(snapshot.Page.Turns) != 0 {
		t.Fatalf("zero-progress snapshot=%+v err=%v", snapshot, err)
	}
	if err := q.ClearUnsafeRecapTurnsAtCurrentBoundary(ctx, profileID, mediaID); err != nil {
		t.Fatalf("clear all now-unsafe turns without progress: %v", err)
	}
	snapshot, err = q.LoadRecapConversationSnapshot(ctx, profileID, mediaID, 0, 20)
	if err != nil || snapshot.Page.HiddenTurnCount != 0 || len(snapshot.Page.Turns) != 0 || snapshot.HasHistory {
		t.Fatalf("zero-progress clear snapshot=%+v err=%v", snapshot, err)
	}
	if _, err := q.pool.Exec(ctx, `
		INSERT INTO watch_progress (user_id, profile_id, media_item_id, episode_id, completed)
		VALUES ($1, $2, $3, $4, TRUE)`, userID, profileID, mediaID, episode2ID); err != nil {
		t.Fatalf("restore episode 2 progress: %v", err)
	}

	guardID, guardQuestion := "6d8f32e5-bbac-4893-93d2-e53a97464cc1", "Does clear wait for the response?"
	guardHash := testQuestionHash(guardQuestion)
	guardReservation, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		guardID, guardHash, 2*time.Minute, 100, time.Hour)
	if err != nil {
		t.Fatalf("reserve response-guard turn: %v", err)
	}
	if _, _, err := q.InsertRecapConversationTurn(ctx, guardReservation.ID, profileID, mediaID,
		guardID, guardHash, guardQuestion, "The response is guarded. Clear waits until it is written.", e2, "grounded"); err != nil {
		t.Fatalf("insert response-guard turn: %v", err)
	}
	guardEntered := make(chan struct{})
	releaseGuard := make(chan struct{})
	guardResult := make(chan error, 1)
	guardCtx, cancelGuard := context.WithTimeout(ctx, 5*time.Second)
	defer cancelGuard()
	go func() {
		guardResult <- q.WithRecapTurnResponseGuard(guardCtx, guardReservation.ID, profileID, mediaID, guardID, guardHash,
			func(_ *RecapConversationTurn, _ *RecapBoundary) {
				close(guardEntered)
				<-releaseGuard
			})
	}()
	select {
	case <-guardEntered:
	case guardErr := <-guardResult:
		t.Fatalf("response guard did not enter callback: %v", guardErr)
	case <-guardCtx.Done():
		t.Fatalf("response guard timed out before callback: %v", guardCtx.Err())
	}
	guardedClearResult := make(chan error, 1)
	go func() { guardedClearResult <- q.ClearRecapConversation(guardCtx, profileID, mediaID) }()
	select {
	case clearErr := <-guardedClearResult:
		t.Fatalf("clear completed before guarded response was released: %v", clearErr)
	case <-time.After(100 * time.Millisecond):
		// Expected: full clear is blocked on the conversation's shared lock.
	}
	close(releaseGuard)
	if err := <-guardResult; err != nil {
		t.Fatalf("response guard: %v", err)
	}
	if err := <-guardedClearResult; err != nil {
		t.Fatalf("clear after guarded response: %v", err)
	}
	cancelGuard()
	if err := q.WithRecapTurnResponseGuard(ctx, guardReservation.ID, profileID, mediaID, guardID, guardHash,
		func(_ *RecapConversationTurn, _ *RecapBoundary) {}); !errors.Is(err, ErrRecapRequestInvalidated) {
		t.Fatalf("post-clear response guard err=%v, want ErrRecapRequestInvalidated", err)
	}

	clearID, clearQuestion := "7f7f86f8-b983-4e7e-a51d-29c6839dbd3b", "Will clearing win the race?"
	clearReservation, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		clearID, testQuestionHash(clearQuestion), 2*time.Minute, 20, time.Hour)
	if err != nil {
		t.Fatalf("reserve clear-race request: %v", err)
	}
	var clearConversationID, clearEpochBefore int64
	if err := q.pool.QueryRow(ctx, `
		SELECT id, generation_epoch FROM recap_conversations
		WHERE profile_id = $1 AND media_item_id = $2`, profileID, mediaID).Scan(&clearConversationID, &clearEpochBefore); err != nil {
		t.Fatalf("load conversation clear epoch: %v", err)
	}
	if err := q.ClearRecapConversation(ctx, profileID, mediaID); err != nil {
		t.Fatalf("clear conversation: %v", err)
	}
	var clearConversationAfterID, clearEpochAfter int64
	if err := q.pool.QueryRow(ctx, `
		SELECT id, generation_epoch FROM recap_conversations
		WHERE profile_id = $1 AND media_item_id = $2`, profileID, mediaID).Scan(&clearConversationAfterID, &clearEpochAfter); err != nil {
		t.Fatalf("load conversation tombstone: %v", err)
	}
	if clearConversationAfterID != clearConversationID || clearEpochAfter != clearEpochBefore+1 {
		t.Fatalf("clear tombstone=(id=%d epoch=%d), want stable id=%d epoch=%d", clearConversationAfterID, clearEpochAfter, clearConversationID, clearEpochBefore+1)
	}
	if _, _, err := q.InsertRecapConversationTurn(ctx, clearReservation.ID, profileID, mediaID,
		clearID, testQuestionHash(clearQuestion), clearQuestion, "No cleared answer may return.", e2, "grounded"); !errors.Is(err, ErrRecapRequestInvalidated) {
		t.Fatalf("post-clear insert err=%v, want ErrRecapRequestInvalidated", err)
	}
	page, err = q.ListRecapConversationTurns(ctx, profileID, mediaID, 1, 3, 0, 20)
	if err != nil || len(page.Turns) != 0 {
		t.Fatalf("after clear conversation: page=%+v err=%v", page, err)
	}

	// Race provider commits against confirmed clears repeatedly. Whichever
	// obtains the parent lock first, the final state must be empty: a commit
	// either lands before the clear and is deleted, or observes the advanced
	// epoch/missing reservation and is invalidated. The shared start barrier
	// also exercises the parent/request lock order under PostgreSQL.
	for i := 0; i < 8; i++ {
		raceID := fmt.Sprintf("10000000-0000-4000-8000-%012x", i+1)
		raceQuestion := fmt.Sprintf("Clear race %d?", i+1)
		raceHash := testQuestionHash(raceQuestion)
		reserved, reserveErr := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
			raceID, raceHash, 2*time.Minute, 100, time.Hour)
		if reserveErr != nil {
			t.Fatalf("reserve clear race %d: %v", i, reserveErr)
		}
		raceCtx, cancelRace := context.WithTimeout(ctx, 5*time.Second)
		startRace := make(chan struct{})
		insertResult := make(chan error, 1)
		clearResult := make(chan error, 1)
		go func() {
			<-startRace
			_, _, insertErr := q.InsertRecapConversationTurn(raceCtx, reserved.ID, profileID, mediaID,
				raceID, raceHash, raceQuestion, "This answer is safe. It has two sentences.", e2, "grounded")
			insertResult <- insertErr
		}()
		go func() {
			<-startRace
			clearResult <- q.ClearRecapConversation(raceCtx, profileID, mediaID)
		}()
		close(startRace)
		insertErr := <-insertResult
		clearErr := <-clearResult
		cancelRace()
		if clearErr != nil {
			t.Fatalf("concurrent clear %d: %v", i, clearErr)
		}
		if insertErr != nil && !errors.Is(insertErr, ErrRecapRequestInvalidated) {
			t.Fatalf("concurrent insert %d err=%v, want success or invalidation", i, insertErr)
		}
		racePage, listErr := q.ListRecapConversationTurns(ctx, profileID, mediaID, 1, 3, 0, 20)
		if listErr != nil || len(racePage.Turns) != 0 {
			t.Fatalf("concurrent clear %d left turns=%+v err=%v", i, racePage.Turns, listErr)
		}
	}
	concurrentID, concurrentQuestion := "21ec2020-3aea-4069-a2dd-9ce0d7d98713", "Can only one request lead?"
	start := make(chan struct{})
	type reserveResult struct {
		reservation *RecapRequestReservation
		err         error
	}
	results := make(chan reserveResult, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			reserved, reserveErr := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
				concurrentID, testQuestionHash(concurrentQuestion), 2*time.Minute, 20, time.Hour)
			results <- reserveResult{reservation: reserved, err: reserveErr}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	leaders, inFlight := 0, 0
	for result := range results {
		switch {
		case result.err == nil:
			leaders++
			if err := q.FailRecapConversationRequest(ctx, result.reservation.ID); err != nil {
				t.Fatalf("fail concurrent leader: %v", err)
			}
		case errors.Is(result.err, ErrRecapRequestInFlight):
			inFlight++
		default:
			t.Fatalf("concurrent reserve err=%v", result.err)
		}
	}
	if leaders != 1 || inFlight != 1 {
		t.Fatalf("concurrent reservation leaders=%d in_flight=%d, want 1/1", leaders, inFlight)
	}

	if _, err := q.pool.Exec(ctx, `DELETE FROM recap_question_rate_events WHERE user_id = $1`, userID); err != nil {
		t.Fatalf("reset rate events: %v", err)
	}
	rateIDs := []string{"d82fd537-f0f7-44fb-b8a1-d989068f3771", "9ef713a8-4871-4117-bb31-7819f64d6575"}
	var retryReservation *RecapRequestReservation
	for i, requestID := range rateIDs {
		question := fmt.Sprintf("Question %d?", i)
		reserved, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
			requestID, testQuestionHash(question), 2*time.Minute, 2, time.Hour)
		if err != nil {
			t.Fatalf("reserve quota request %d: %v", i, err)
		}
		if i == 0 {
			retryReservation = reserved
		}
	}
	if _, err := q.ReserveRecapConversationRequest(ctx, userID, otherProfileID, mediaID,
		rateIDs[0], testQuestionHash("Same UUID, another profile?"), 2*time.Minute, 2, time.Hour); !errors.Is(err, ErrRecapRateLimited) {
		t.Fatalf("cross-profile same UUID err=%v, want durable ErrRecapRateLimited", err)
	}
	if err := q.FailRecapConversationRequest(ctx, retryReservation.ID); err != nil {
		t.Fatalf("mark quota request failed: %v", err)
	}
	if _, err := q.ReserveRecapConversationRequest(ctx, userID, profileID, mediaID,
		rateIDs[0], testQuestionHash("Question 0?"), 2*time.Minute, 2, time.Hour); err != nil {
		t.Fatalf("same-key retry should reuse its quota slot: %v", err)
	}
	var conversationID int64
	if err := q.pool.QueryRow(ctx, `SELECT id FROM recap_conversations WHERE profile_id = $1 AND media_item_id = $2`, profileID, mediaID).Scan(&conversationID); err != nil {
		t.Fatalf("load conversation before cascade: %v", err)
	}
	if _, err := q.pool.Exec(ctx, `DELETE FROM user_profiles WHERE id = $1`, profileID); err != nil {
		t.Fatalf("delete profile cascade: %v", err)
	}
	var conversations, requests, turns int
	if err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM recap_conversations WHERE id = $1`, conversationID).Scan(&conversations); err != nil {
		t.Fatalf("count cascaded conversation: %v", err)
	}
	if err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM recap_conversation_requests WHERE conversation_id = $1`, conversationID).Scan(&requests); err != nil {
		t.Fatalf("count cascaded requests: %v", err)
	}
	if err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM recap_conversation_turns WHERE conversation_id = $1`, conversationID).Scan(&turns); err != nil {
		t.Fatalf("count cascaded turns: %v", err)
	}
	if conversations != 0 || requests != 0 || turns != 0 {
		t.Fatalf("profile cascade left conversation=%d requests=%d turns=%d", conversations, requests, turns)
	}
}

func testQuestionHash(question string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(question)))
}
