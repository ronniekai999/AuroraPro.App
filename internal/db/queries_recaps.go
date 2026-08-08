package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	// ErrRecapBoundaryChanged means viewing progress no longer reaches the
	// boundary an Ask Previously answer was generated against. Callers must not
	// expose or persist that answer.
	ErrRecapBoundaryChanged = errors.New("recap spoiler boundary changed")
	// ErrRecapRequestInFlight means another process already owns this exact
	// idempotency key. It must not trigger a second provider request.
	ErrRecapRequestInFlight = errors.New("recap request already in flight")
	// ErrRecapRequestConflict means a UUID was reused for different normalized
	// question content within the same conversation.
	ErrRecapRequestConflict = errors.New("recap request id reused with different question")
	// ErrRecapRequestInvalidated means the conversation/request reservation was
	// cleared while generation was running. The completed answer must be dropped.
	ErrRecapRequestInvalidated = errors.New("recap request was invalidated")
	// ErrRecapRateLimited is returned after the durable per-account rolling
	// window is exhausted. RecapRequestReservation.RetryAfter tells the handler
	// how long to advertise in Retry-After.
	ErrRecapRateLimited = errors.New("recap question rate limit exceeded")
)

// Queries backing the "Previously" spoiler-safe recap feature (catch-me-up).
//
// The spoiler boundary is a NUMBER, not a vibe: a viewer's last completed
// episode (season, episode) ordinal. RecapEpisodesUpToBoundary returns only
// episodes at or before that ordinal, so "no spoilers" is guaranteed by the
// query — the LLM never sees anything past where the viewer is.

// RecapBoundary identifies the last episode a profile finished for a show —
// the spoiler boundary the recap is generated up to.
type RecapBoundary struct {
	EpisodeID     int64
	SeasonNumber  int
	EpisodeNumber int
	Title         string
}

// RecapEpisode is one bounded input synopsis for the recap prompt.
type RecapEpisode struct {
	SeasonNumber  int
	EpisodeNumber int
	Title         string
	Overview      string
}

// CachedRecap is a stored recap plus the validity keys (model + source_hash)
// the service compares against before serving it.
type CachedRecap struct {
	Recap              string
	SuggestedQuestions []string
	Model              string
	SourceHash         string
}

// RecapConversationTurn is one immutable question/answer pair. The boundary
// snapshot is stored with the answer so a later progress rewind can hide turns
// that are no longer spoiler-safe without deleting the viewer's history.
type RecapConversationTurn struct {
	ID              int64     `json:"id"`
	RequestID       string    `json:"request_id"`
	Question        string    `json:"question"`
	Answer          string    `json:"answer"`
	UpToEpisodeID   *int64    `json:"-"`
	BoundarySeason  int       `json:"-"`
	BoundaryEpisode int       `json:"-"`
	BoundaryTitle   string    `json:"-"`
	GroundingMode   string    `json:"mode"`
	CreatedAt       time.Time `json:"created_at"`
}

// RecapConversationPage is a newest-first cursor page returned in
// chronological order, plus the spoiler-unsafe history summary.
type RecapConversationPage struct {
	Turns             []RecapConversationTurn
	NextBeforeTurnID  *int64
	HiddenTurnCount   int
	HighestHiddenTurn *RecapConversationTurn
}

// RecapConversationSnapshot binds a page of turns to the exact completed-
// episode snapshot used to filter it. Boundary is nil when the profile has no
// completed episode; in that case every stored turn is reported as hidden.
// HasHistory ignores empty request-only conversations left by failed attempts.
type RecapConversationSnapshot struct {
	Boundary   *RecapBoundary
	Page       RecapConversationPage
	HasHistory bool
}

// RecapRequestReservation is the durable leader election result for one
// client UUID. ExistingTurn is populated for completed idempotent retries;
// otherwise ID identifies the reservation the leader must present at commit.
type RecapRequestReservation struct {
	ID           int64
	ExistingTurn *RecapConversationTurn
	RetryAfter   time.Duration
}

// LastCompletedEpisode returns the highest (season, episode) ordinal the
// profile has marked completed for the given show — the recap boundary.
// Returns pgx.ErrNoRows when the profile hasn't finished any episode (the
// caller treats that as "nothing to recap yet" and hides the affordance).
//
// Keyed off wp.episode_id joined through tv_episodes to the show, so it is
// correct regardless of what watch_progress.media_item_id holds for an
// episode row. Per-profile (migration 029) by wp.profile_id.
func (q *Queries) LastCompletedEpisode(ctx context.Context, profileID, mediaItemID int64) (*RecapBoundary, error) {
	return lastCompletedEpisode(ctx, q.pool, profileID, mediaItemID)
}

type recapQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func lastCompletedEpisode(ctx context.Context, querier recapQuerier, profileID, mediaItemID int64) (*RecapBoundary, error) {
	row := querier.QueryRow(ctx, `
		SELECT e.id, s.season_number, e.episode_number, COALESCE(e.title, '')
		FROM watch_progress wp
		JOIN tv_episodes e ON e.id = wp.episode_id
		JOIN tv_seasons  s ON s.id = e.season_id
		WHERE wp.profile_id = $1
		  AND e.media_item_id = $2
		  AND wp.completed = TRUE
		ORDER BY s.season_number DESC, e.episode_number DESC
		LIMIT 1`,
		profileID, mediaItemID,
	)
	var b RecapBoundary
	if err := row.Scan(&b.EpisodeID, &b.SeasonNumber, &b.EpisodeNumber, &b.Title); err != nil {
		return nil, err
	}
	return &b, nil
}

// CountRecapEpisodesUpToBoundary performs the inexpensive availability check
// used by status/conversation endpoints without loading every synopsis.
func (q *Queries) CountRecapEpisodesUpToBoundary(ctx context.Context, mediaItemID int64, boundarySeason, boundaryEpisode int) (int, error) {
	var count int
	err := q.pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM tv_episodes e
		JOIN tv_seasons s ON s.id = e.season_id AND s.media_item_id = e.media_item_id
		WHERE e.media_item_id = $1
		  AND (s.season_number < $2 OR (s.season_number = $2 AND e.episode_number <= $3))
		  AND COALESCE(e.overview, '') <> ''`, mediaItemID, boundarySeason, boundaryEpisode).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count recap episodes up to boundary: %w", err)
	}
	return count, nil
}

// RecapEpisodesUpToBoundary returns the show's episodes at or before the
// (boundarySeason, boundaryEpisode) ordinal, in air order, with a non-empty
// overview. This is the spoiler-safe input set: everything the viewer has
// reached, nothing beyond it.
//
// The JOIN constrains s.media_item_id = e.media_item_id (not just e.media_item_id)
// for the same reason GetEpisodes does — a corrupt episode row pointing at
// another show's season can't leak in.
func (q *Queries) RecapEpisodesUpToBoundary(ctx context.Context, mediaItemID int64, boundarySeason, boundaryEpisode int) ([]RecapEpisode, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT s.season_number, e.episode_number,
		       COALESCE(e.title, ''), COALESCE(e.overview, '')
		FROM tv_episodes e
		JOIN tv_seasons  s ON s.id = e.season_id AND s.media_item_id = e.media_item_id
		WHERE e.media_item_id = $1
		  AND ( s.season_number < $2
		        OR (s.season_number = $2 AND e.episode_number <= $3) )
		  AND COALESCE(e.overview, '') <> ''
		ORDER BY s.season_number, e.episode_number`,
		mediaItemID, boundarySeason, boundaryEpisode,
	)
	if err != nil {
		return nil, fmt.Errorf("recap episodes up to boundary: %w", err)
	}
	defer rows.Close()

	var out []RecapEpisode
	for rows.Next() {
		var e RecapEpisode
		if err := rows.Scan(&e.SeasonNumber, &e.EpisodeNumber, &e.Title, &e.Overview); err != nil {
			return nil, fmt.Errorf("scan recap episode: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// RecapBoundaryFacts are the two library facts the recap's mode selection
// needs about a boundary episode.
type RecapBoundaryFacts struct {
	// HasEpisodesAfter — any episode exists after the (season, episode)
	// ordinal. False means the viewer is caught up to the latest available.
	HasEpisodesAfter bool
	// BoundaryIsSeasonLast — no higher-numbered episode of the SAME season
	// exists, i.e. the boundary is a season finale as far as the library knows.
	BoundaryIsSeasonLast bool
}

// GetRecapBoundaryFacts answers both mode-selection probes in ONE statement so
// they read a single consistent snapshot — two separate queries could see a
// concurrent library scan in between and return contradictory facts (review
// finding on the season-closure PR). Same corruption-proof JOIN shape as the
// other recap queries. Errors are returned verbatim: the caller hard-fails
// rather than guessing a mode, so a transient DB error can't flip the mode,
// mismatch the cache hash, and trigger a spurious LLM regeneration.
func (q *Queries) GetRecapBoundaryFacts(ctx context.Context, mediaItemID int64, boundarySeason, boundaryEpisode int) (RecapBoundaryFacts, error) {
	var f RecapBoundaryFacts
	err := q.pool.QueryRow(ctx, `
		SELECT
		  EXISTS (
			SELECT 1
			FROM tv_episodes e
			JOIN tv_seasons s ON s.id = e.season_id AND s.media_item_id = e.media_item_id
			WHERE e.media_item_id = $1
			  AND ( s.season_number > $2
			        OR (s.season_number = $2 AND e.episode_number > $3) )
		  ) AS has_after,
		  NOT EXISTS (
			SELECT 1
			FROM tv_episodes e
			JOIN tv_seasons s ON s.id = e.season_id AND s.media_item_id = e.media_item_id
			WHERE e.media_item_id = $1
			  AND s.season_number = $2
			  AND e.episode_number > $3
		  ) AS season_last`,
		mediaItemID, boundarySeason, boundaryEpisode,
	).Scan(&f.HasEpisodesAfter, &f.BoundaryIsSeasonLast)
	if err != nil {
		return RecapBoundaryFacts{}, fmt.Errorf("recap boundary facts: %w", err)
	}
	return f, nil
}

// GetCachedRecap returns the cached recap for a (show, boundary) pair, if one
// exists. ok is false (with nil error) on a cache miss.
func (q *Queries) GetCachedRecap(ctx context.Context, mediaItemID, upToEpisodeID int64) (CachedRecap, bool, error) {
	row := q.pool.QueryRow(ctx, `
		SELECT recap, suggested_questions, model, source_hash
		FROM episode_recaps
		WHERE media_item_id = $1 AND up_to_episode_id = $2`,
		mediaItemID, upToEpisodeID,
	)
	var c CachedRecap
	var suggestedJSON []byte
	if err := row.Scan(&c.Recap, &suggestedJSON, &c.Model, &c.SourceHash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CachedRecap{}, false, nil // clean cache miss
		}
		return CachedRecap{}, false, fmt.Errorf("get cached recap: %w", err)
	}
	if err := json.Unmarshal(suggestedJSON, &c.SuggestedQuestions); err != nil {
		return CachedRecap{}, false, fmt.Errorf("decode cached recap suggestions: %w", err)
	}
	return c, true, nil
}

// UpsertRecap stores (or replaces) the recap for a (show, boundary) pair.
func (q *Queries) UpsertRecap(ctx context.Context, mediaItemID, upToEpisodeID int64, recap string, suggestedQuestions []string, model, sourceHash string) error {
	suggestedJSON, err := json.Marshal(suggestedQuestions)
	if err != nil {
		return fmt.Errorf("encode recap suggestions: %w", err)
	}
	_, err = q.pool.Exec(ctx, `
		INSERT INTO episode_recaps (media_item_id, up_to_episode_id, recap, suggested_questions, model, source_hash)
		VALUES ($1, $2, $3, $4::jsonb, $5, $6)
		ON CONFLICT (media_item_id, up_to_episode_id)
		DO UPDATE SET recap = EXCLUDED.recap,
		              suggested_questions = EXCLUDED.suggested_questions,
		              model = EXCLUDED.model,
		              source_hash = EXCLUDED.source_hash,
		              created_at = now()`,
		mediaItemID, upToEpisodeID, recap, suggestedJSON, model, sourceHash,
	)
	if err != nil {
		return fmt.Errorf("upsert recap: %w", err)
	}
	return nil
}

// ReserveRecapConversationRequest elects exactly one provider-call leader for
// a client UUID across every Aurora process. New leaders consume one durable
// account-wide rolling-window slot; failed/stale retries of the same normalized
// question reuse their original slot. No raw question is stored here.
func (q *Queries) ReserveRecapConversationRequest(ctx context.Context, userID, profileID, mediaItemID int64, requestID, questionHash string, staleAfter time.Duration, rate int, window time.Duration) (*RecapRequestReservation, error) {
	if rate < 1 || window <= 0 || staleAfter <= 0 {
		return nil, errors.New("invalid recap reservation limits")
	}
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin recap request reservation: %w", err)
	}
	defer tx.Rollback(ctx)

	// Serialize reservations account-wide before taking any conversation lock.
	// The namespaced hash avoids colliding with unrelated advisory-lock keys.
	if _, err := tx.Exec(ctx, `
		SELECT pg_advisory_xact_lock(
			hashtextextended('recap-question-quota:' || ($1::bigint)::text, 0)
		)`, userID); err != nil {
		return nil, fmt.Errorf("lock recap question quota: %w", err)
	}
	// Cross-process idempotency and quota decisions must share one clock. Using
	// the database clock after the account lock prevents skewed Aurora hosts from
	// reclaiming live work or opening/closing the rolling window early.
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return nil, fmt.Errorf("read recap reservation clock: %w", err)
	}

	// This upsert takes the conversation (parent) row lock before any request
	// (child) lock. Clear and commit use the same order, avoiding parent/child
	// deadlocks. generation_epoch is a persistent clear tombstone.
	var conversationID, conversationEpoch int64
	err = tx.QueryRow(ctx, `
		INSERT INTO recap_conversations (profile_id, media_item_id)
		VALUES ($1, $2)
		ON CONFLICT (profile_id, media_item_id)
		DO UPDATE SET updated_at = recap_conversations.updated_at
		RETURNING id, generation_epoch`, profileID, mediaItemID).Scan(&conversationID, &conversationEpoch)
	if err != nil {
		return nil, fmt.Errorf("upsert recap conversation for reservation: %w", err)
	}

	var reservationID, storedEpoch int64
	var storedHash, status string
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `
		SELECT id, question_hash, conversation_epoch, status, updated_at
		FROM recap_conversation_requests
		WHERE conversation_id = $1 AND request_id = $2::uuid
		FOR UPDATE`, conversationID, requestID).Scan(&reservationID, &storedHash, &storedEpoch, &status, &updatedAt)
	if err == nil {
		if storedEpoch != conversationEpoch {
			return nil, ErrRecapRequestInvalidated
		}
		if storedHash != questionHash {
			return nil, ErrRecapRequestConflict
		}
		switch status {
		case "completed":
			turn, scanErr := scanRecapTurn(tx.QueryRow(ctx, `
				SELECT id, request_id::text, question, answer, up_to_episode_id,
				       boundary_season, boundary_episode, boundary_title,
				       grounding_mode, created_at
				FROM recap_conversation_turns
				WHERE conversation_id = $1 AND request_id = $2::uuid`, conversationID, requestID))
			if scanErr != nil {
				return nil, fmt.Errorf("load completed recap request: %w", scanErr)
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, fmt.Errorf("commit completed recap request lookup: %w", err)
			}
			return &RecapRequestReservation{ID: reservationID, ExistingTurn: turn}, nil
		case "pending":
			if now.Sub(updatedAt) < staleAfter {
				if err := tx.Commit(ctx); err != nil {
					return nil, fmt.Errorf("commit in-flight recap request lookup: %w", err)
				}
				return &RecapRequestReservation{ID: reservationID}, ErrRecapRequestInFlight
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE recap_conversation_requests
			SET status = 'pending', updated_at = $2
			WHERE id = $1`, reservationID, now); err != nil {
			return nil, fmt.Errorf("reclaim recap request reservation: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit reclaimed recap request reservation: %w", err)
		}
		return &RecapRequestReservation{ID: reservationID}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("lookup recap request reservation: %w", err)
	}

	cutoff := now.Add(-window)
	if _, err := tx.Exec(ctx, `DELETE FROM recap_question_rate_events WHERE created_at <= $1`, cutoff); err != nil {
		return nil, fmt.Errorf("prune recap question quota: %w", err)
	}
	var count int
	var oldest time.Time
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(MIN(created_at), $2)
		FROM recap_question_rate_events
		WHERE user_id = $1 AND created_at > $2`, userID, cutoff).Scan(&count, &oldest); err != nil {
		return nil, fmt.Errorf("read recap question quota: %w", err)
	}
	if count >= rate {
		retryAfter := oldest.Add(window).Sub(now)
		if retryAfter < time.Second {
			retryAfter = time.Second
		}
		return &RecapRequestReservation{RetryAfter: retryAfter}, ErrRecapRateLimited
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO recap_conversation_requests (
			conversation_id, request_id, question_hash, conversation_epoch,
			status, created_at, updated_at
		)
		VALUES ($1, $2::uuid, $3, $4, 'pending', $5, $5)
		RETURNING id`, conversationID, requestID, questionHash, conversationEpoch, now).Scan(&reservationID); err != nil {
		return nil, fmt.Errorf("insert recap request reservation: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO recap_question_rate_events (user_id, created_at) VALUES ($1, $2)`, userID, now); err != nil {
		return nil, fmt.Errorf("record recap question quota: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit recap request reservation: %w", err)
	}
	return &RecapRequestReservation{ID: reservationID}, nil
}

// FailRecapConversationRequest releases a leader after a retryable generation,
// progress, or persistence failure. A later retry of the same UUID/hash can
// reclaim it without consuming another quota slot.
func (q *Queries) FailRecapConversationRequest(ctx context.Context, reservationID int64) error {
	_, err := q.pool.Exec(ctx, `
		UPDATE recap_conversation_requests
		SET status = 'failed', updated_at = clock_timestamp()
		WHERE id = $1 AND status = 'pending'`, reservationID)
	if err != nil {
		return fmt.Errorf("fail recap request reservation: %w", err)
	}
	return nil
}

// InsertRecapConversationTurn validates the still-live request reservation and
// current spoiler boundary, then inserts a complete immutable Q/A pair and
// marks the reservation complete in one transaction. It never recreates a
// conversation cleared while the provider was running.
func (q *Queries) InsertRecapConversationTurn(ctx context.Context, reservationID, profileID, mediaItemID int64, requestID, questionHash, question, answer string, boundary *RecapBoundary, groundingMode string) (*RecapConversationTurn, *RecapBoundary, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("begin recap turn: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after Commit

	// Always lock the stable parent first. Full/unsafe clears and reservations
	// use this same order, so a clear either runs after this complete commit and
	// removes the new turn, or runs first and invalidates the child reservation.
	var conversationID, conversationEpoch int64
	err = tx.QueryRow(ctx, `
		SELECT id, generation_epoch
		FROM recap_conversations
		WHERE profile_id = $1 AND media_item_id = $2
		FOR UPDATE`, profileID, mediaItemID).Scan(&conversationID, &conversationEpoch)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrRecapRequestInvalidated
	}
	if err != nil {
		return nil, nil, fmt.Errorf("lock recap conversation: %w", err)
	}

	var requestEpoch int64
	err = tx.QueryRow(ctx, `
		SELECT conversation_epoch
		FROM recap_conversation_requests
		WHERE id = $1 AND conversation_id = $2
		  AND request_id = $3::uuid AND question_hash = $4
		  AND status = 'pending'
		FOR UPDATE`, reservationID, conversationID, requestID, questionHash).Scan(&requestEpoch)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrRecapRequestInvalidated
	}
	if err != nil {
		return nil, nil, fmt.Errorf("lock recap request reservation: %w", err)
	}
	if requestEpoch != conversationEpoch {
		return nil, nil, ErrRecapRequestInvalidated
	}

	// Lock the current highest completed progress row through commit. A rewind
	// racing this insert must wait, so the complete Q/A pair either commits
	// while its boundary is still safe or does not commit at all.
	currentBoundary := &RecapBoundary{}
	err = tx.QueryRow(ctx, `
		SELECT e.id, s.season_number, e.episode_number, COALESCE(e.title, '')
		FROM watch_progress wp
		JOIN tv_episodes e ON e.id = wp.episode_id
		JOIN tv_seasons s ON s.id = e.season_id
		WHERE wp.profile_id = $1
		  AND e.media_item_id = $2
		  AND wp.completed = TRUE
		ORDER BY s.season_number DESC, e.episode_number DESC
		LIMIT 1
		FOR SHARE OF wp`, profileID, mediaItemID).Scan(&currentBoundary.EpisodeID, &currentBoundary.SeasonNumber, &currentBoundary.EpisodeNumber, &currentBoundary.Title)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrRecapBoundaryChanged
	}
	if err != nil {
		return nil, nil, fmt.Errorf("lock recap spoiler boundary: %w", err)
	}
	if currentBoundary.SeasonNumber < boundary.SeasonNumber ||
		(currentBoundary.SeasonNumber == boundary.SeasonNumber && currentBoundary.EpisodeNumber < boundary.EpisodeNumber) {
		return nil, nil, ErrRecapBoundaryChanged
	}

	row := tx.QueryRow(ctx, `
		INSERT INTO recap_conversation_turns (
			conversation_id, request_id, question, answer, up_to_episode_id,
			boundary_season, boundary_episode, boundary_title, grounding_mode
		)
		VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (conversation_id, request_id) DO NOTHING
		RETURNING id, request_id::text, question, answer, up_to_episode_id,
		          boundary_season, boundary_episode, boundary_title,
		          grounding_mode, created_at`,
		conversationID, requestID, question, answer, boundary.EpisodeID,
		boundary.SeasonNumber, boundary.EpisodeNumber, boundary.Title, groundingMode,
	)
	turn, scanErr := scanRecapTurn(row)
	created := scanErr == nil
	if errors.Is(scanErr, pgx.ErrNoRows) {
		turn, scanErr = scanRecapTurn(tx.QueryRow(ctx, `
			SELECT id, request_id::text, question, answer, up_to_episode_id,
			       boundary_season, boundary_episode, boundary_title,
			       grounding_mode, created_at
			FROM recap_conversation_turns
			WHERE conversation_id = $1 AND request_id = $2::uuid`, conversationID, requestID))
	}
	if scanErr != nil {
		return nil, nil, fmt.Errorf("insert recap conversation turn: %w", scanErr)
	}
	if created {
		if _, err := tx.Exec(ctx, `UPDATE recap_conversations SET updated_at = NOW() WHERE id = $1`, conversationID); err != nil {
			return nil, nil, fmt.Errorf("touch recap conversation: %w", err)
		}
	}
	result, err := tx.Exec(ctx, `
		UPDATE recap_conversation_requests
		SET status = 'completed', updated_at = clock_timestamp()
		WHERE id = $1 AND status = 'pending' AND conversation_epoch = $2`, reservationID, conversationEpoch)
	if err != nil {
		return nil, nil, fmt.Errorf("complete recap request reservation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return nil, nil, ErrRecapRequestInvalidated
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, fmt.Errorf("commit recap turn: %w", err)
	}
	return turn, currentBoundary, nil
}

// WithRecapTurnResponseGuard verifies a completed request and holds shared
// locks on both its conversation and the current spoiler-boundary progress row
// while respond writes the HTTP response. A confirmed clear or rewind must
// therefore happen entirely before the guard (and the response is rejected)
// or after the answer has been written; it cannot return first and then have a
// deleted/unsafe answer visibly resurface on the requesting client.
func (q *Queries) WithRecapTurnResponseGuard(
	ctx context.Context,
	reservationID, profileID, mediaItemID int64,
	requestID, questionHash string,
	respond func(*RecapConversationTurn, *RecapBoundary),
) error {
	if respond == nil {
		return errors.New("nil recap response callback")
	}
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin recap response guard: %w", err)
	}
	// This transaction is lock-only. Rolling it back after the synchronous
	// response write releases the locks without creating a commit-after-write
	// failure that could no longer be reported to the client.
	defer tx.Rollback(ctx)

	turn, err := scanRecapTurn(tx.QueryRow(ctx, `
		SELECT t.id, t.request_id::text, t.question, t.answer, t.up_to_episode_id,
		       t.boundary_season, t.boundary_episode, t.boundary_title,
		       t.grounding_mode, t.created_at
		FROM recap_conversations c
		JOIN recap_conversation_requests r ON r.conversation_id = c.id
		JOIN recap_conversation_turns t
		  ON t.conversation_id = c.id AND t.request_id = r.request_id
		WHERE c.profile_id = $1 AND c.media_item_id = $2
		  AND r.id = $3 AND r.request_id = $4::uuid
		  AND r.question_hash = $5 AND r.status = 'completed'
		  AND r.conversation_epoch = c.generation_epoch
		FOR SHARE OF c`, profileID, mediaItemID, reservationID, requestID, questionHash))
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRecapRequestInvalidated
	}
	if err != nil {
		return fmt.Errorf("lock completed recap response: %w", err)
	}

	currentBoundary := &RecapBoundary{}
	err = tx.QueryRow(ctx, `
		SELECT e.id, s.season_number, e.episode_number, COALESCE(e.title, '')
		FROM watch_progress wp
		JOIN tv_episodes e ON e.id = wp.episode_id
		JOIN tv_seasons s ON s.id = e.season_id
		WHERE wp.profile_id = $1
		  AND e.media_item_id = $2
		  AND wp.completed = TRUE
		ORDER BY s.season_number DESC, e.episode_number DESC
		LIMIT 1
		FOR SHARE OF wp`, profileID, mediaItemID).Scan(
		&currentBoundary.EpisodeID,
		&currentBoundary.SeasonNumber,
		&currentBoundary.EpisodeNumber,
		&currentBoundary.Title,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRecapBoundaryChanged
	}
	if err != nil {
		return fmt.Errorf("lock recap response boundary: %w", err)
	}
	if currentBoundary.SeasonNumber < turn.BoundarySeason ||
		(currentBoundary.SeasonNumber == turn.BoundarySeason && currentBoundary.EpisodeNumber < turn.BoundaryEpisode) {
		return ErrRecapBoundaryChanged
	}

	respond(turn, currentBoundary)
	return nil
}

// ListRecapConversationTurns returns only turns at or before the current
// boundary. Later answers remain stored but are summarized separately.
func (q *Queries) ListRecapConversationTurns(ctx context.Context, profileID, mediaItemID int64, boundarySeason, boundaryEpisode int, beforeTurnID int64, limit int) (RecapConversationPage, error) {
	page, _, err := listRecapConversationTurns(ctx, q.pool, profileID, mediaItemID, boundarySeason, boundaryEpisode, beforeTurnID, limit)
	return page, err
}

// LoadRecapConversationSnapshot resolves progress and filters turns inside one
// repeatable-read transaction. A concurrent rewind therefore cannot be
// observed between the boundary lookup and the turn query.
func (q *Queries) LoadRecapConversationSnapshot(ctx context.Context, profileID, mediaItemID int64, beforeTurnID int64, limit int) (RecapConversationSnapshot, error) {
	tx, err := q.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return RecapConversationSnapshot{}, fmt.Errorf("begin recap conversation snapshot: %w", err)
	}
	defer tx.Rollback(ctx)

	boundary, err := lastCompletedEpisode(ctx, tx, profileID, mediaItemID)
	if errors.Is(err, pgx.ErrNoRows) {
		boundary = nil
	} else if err != nil {
		return RecapConversationSnapshot{}, fmt.Errorf("load recap conversation boundary: %w", err)
	}
	boundarySeason, boundaryEpisode := 0, 0
	if boundary != nil {
		boundarySeason, boundaryEpisode = boundary.SeasonNumber, boundary.EpisodeNumber
	}
	page, exists, err := listRecapConversationTurns(ctx, tx, profileID, mediaItemID,
		boundarySeason, boundaryEpisode, beforeTurnID, limit)
	if err != nil {
		return RecapConversationSnapshot{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RecapConversationSnapshot{}, fmt.Errorf("commit recap conversation snapshot: %w", err)
	}
	return RecapConversationSnapshot{Boundary: boundary, Page: page, HasHistory: exists}, nil
}

func (q *Queries) RecapConversationHasHistory(ctx context.Context, profileID, mediaItemID int64) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM recap_conversations c
			JOIN recap_conversation_turns t ON t.conversation_id = c.id
			WHERE c.profile_id = $1 AND c.media_item_id = $2
		)`, profileID, mediaItemID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check recap conversation: %w", err)
	}
	return exists, nil
}

func listRecapConversationTurns(ctx context.Context, querier recapQuerier, profileID, mediaItemID int64, boundarySeason, boundaryEpisode int, beforeTurnID int64, limit int) (RecapConversationPage, bool, error) {
	if limit < 1 || limit > 50 {
		limit = 20
	}
	var conversationID int64
	var hasHistory bool
	err := querier.QueryRow(ctx, `
		SELECT c.id, EXISTS (
			SELECT 1 FROM recap_conversation_turns t WHERE t.conversation_id = c.id
		)
		FROM recap_conversations c
		WHERE c.profile_id = $1 AND c.media_item_id = $2`,
		profileID, mediaItemID).Scan(&conversationID, &hasHistory)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecapConversationPage{Turns: []RecapConversationTurn{}}, false, nil
	}
	if err != nil {
		return RecapConversationPage{}, false, fmt.Errorf("get recap conversation: %w", err)
	}

	rows, err := querier.Query(ctx, `
		SELECT id, request_id::text, question, answer, up_to_episode_id,
		       boundary_season, boundary_episode, boundary_title,
		       grounding_mode, created_at
		FROM recap_conversation_turns
		WHERE conversation_id = $1
		  AND (boundary_season < $2 OR (boundary_season = $2 AND boundary_episode <= $3))
		  AND ($4::bigint = 0 OR id < $4)
		ORDER BY id DESC
		LIMIT $5`, conversationID, boundarySeason, boundaryEpisode, beforeTurnID, limit+1)
	if err != nil {
		return RecapConversationPage{}, hasHistory, fmt.Errorf("list recap conversation turns: %w", err)
	}
	defer rows.Close()
	turns := make([]RecapConversationTurn, 0, limit+1)
	for rows.Next() {
		turn, err := scanRecapTurn(rows)
		if err != nil {
			return RecapConversationPage{}, hasHistory, fmt.Errorf("scan recap conversation turn: %w", err)
		}
		turns = append(turns, *turn)
	}
	if err := rows.Err(); err != nil {
		return RecapConversationPage{}, hasHistory, fmt.Errorf("iterate recap conversation turns: %w", err)
	}
	var next *int64
	if len(turns) > limit {
		cursor := turns[limit-1].ID
		next = &cursor
		turns = turns[:limit]
	}
	// Query order is newest-first for efficient cursoring; the UI consumes a
	// natural oldest-to-newest conversation page.
	for i, j := 0, len(turns)-1; i < j; i, j = i+1, j-1 {
		turns[i], turns[j] = turns[j], turns[i]
	}

	page := RecapConversationPage{Turns: turns, NextBeforeTurnID: next}
	var hiddenCount int
	hidden, hiddenErr := scanRecapTurnWithCount(querier.QueryRow(ctx, `
		SELECT id, request_id::text, question, answer, up_to_episode_id,
		       boundary_season, boundary_episode, boundary_title,
		       grounding_mode, created_at, COUNT(*) OVER()
		FROM recap_conversation_turns
		WHERE conversation_id = $1
		  AND (boundary_season > $2 OR (boundary_season = $2 AND boundary_episode > $3))
		ORDER BY boundary_season DESC, boundary_episode DESC, id DESC
		LIMIT 1`, conversationID, boundarySeason, boundaryEpisode), &hiddenCount)
	if hiddenErr != nil && !errors.Is(hiddenErr, pgx.ErrNoRows) {
		return RecapConversationPage{}, hasHistory, fmt.Errorf("summarize hidden recap turns: %w", hiddenErr)
	}
	if hiddenErr == nil {
		page.HiddenTurnCount = hiddenCount
		page.HighestHiddenTurn = hidden
	}
	return page, hasHistory, nil
}

// RecentSafeRecapTurns returns the last safe turns in chronological order for
// conversational continuity in the prompt.
func (q *Queries) RecentSafeRecapTurns(ctx context.Context, profileID, mediaItemID int64, boundarySeason, boundaryEpisode, limit int) ([]RecapConversationTurn, error) {
	if limit < 1 || limit > 20 {
		limit = 8
	}
	rows, err := q.pool.Query(ctx, `
		SELECT t.id, t.request_id::text, t.question, t.answer, t.up_to_episode_id,
		       t.boundary_season, t.boundary_episode, t.boundary_title,
		       t.grounding_mode, t.created_at
		FROM recap_conversation_turns t
		JOIN recap_conversations c ON c.id = t.conversation_id
		WHERE c.profile_id = $1 AND c.media_item_id = $2
		  AND (t.boundary_season < $3 OR (t.boundary_season = $3 AND t.boundary_episode <= $4))
		ORDER BY t.id DESC LIMIT $5`, profileID, mediaItemID, boundarySeason, boundaryEpisode, limit)
	if err != nil {
		return nil, fmt.Errorf("recent safe recap turns: %w", err)
	}
	defer rows.Close()
	var turns []RecapConversationTurn
	for rows.Next() {
		turn, err := scanRecapTurn(rows)
		if err != nil {
			return nil, fmt.Errorf("scan recent recap turn: %w", err)
		}
		turns = append(turns, *turn)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, j := 0, len(turns)-1; i < j; i, j = i+1, j-1 {
		turns[i], turns[j] = turns[j], turns[i]
	}
	return turns, nil
}

func (q *Queries) ClearRecapConversation(ctx context.Context, profileID, mediaItemID int64) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin clear recap conversation: %w", err)
	}
	defer tx.Rollback(ctx)

	var conversationID int64
	err = tx.QueryRow(ctx, `
		SELECT id
		FROM recap_conversations
		WHERE profile_id = $1 AND media_item_id = $2
		FOR UPDATE`, profileID, mediaItemID).Scan(&conversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit empty recap conversation clear: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("lock recap conversation for clear: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE recap_conversations
		SET generation_epoch = generation_epoch + 1
		WHERE id = $1`, conversationID); err != nil {
		return fmt.Errorf("advance recap conversation clear epoch: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM recap_conversation_requests WHERE conversation_id = $1`, conversationID); err != nil {
		return fmt.Errorf("clear recap conversation requests: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM recap_conversation_turns WHERE conversation_id = $1`, conversationID); err != nil {
		return fmt.Errorf("clear recap conversation turns: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit recap conversation clear: %w", err)
	}
	return nil
}

// ClearUnsafeRecapTurnsAtCurrentBoundary recalculates progress and deletes
// later turns in one parent-locked transaction. It also removes idempotency rows
// for deleted turns and cancels unfinished requests so an in-flight generation
// cannot resurrect history immediately after the confirmed clear.
func (q *Queries) ClearUnsafeRecapTurnsAtCurrentBoundary(ctx context.Context, profileID, mediaItemID int64) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin current-boundary unsafe clear: %w", err)
	}
	defer tx.Rollback(ctx)
	var conversationID int64
	err = tx.QueryRow(ctx, `
		SELECT id
		FROM recap_conversations
		WHERE profile_id = $1 AND media_item_id = $2
		FOR UPDATE`, profileID, mediaItemID).Scan(&conversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit empty unsafe recap clear: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("lock recap conversation for unsafe clear: %w", err)
	}
	boundary, err := lastCompletedEpisode(ctx, tx, profileID, mediaItemID)
	if errors.Is(err, pgx.ErrNoRows) {
		boundary = &RecapBoundary{}
	} else if err != nil {
		return fmt.Errorf("resolve unsafe-clear boundary: %w", err)
	}
	if err := clearUnsafeRecapTurns(ctx, tx, conversationID, boundary.SeasonNumber, boundary.EpisodeNumber); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit current-boundary unsafe clear: %w", err)
	}
	return nil
}

func clearUnsafeRecapTurns(ctx context.Context, tx pgx.Tx, conversationID int64, boundarySeason, boundaryEpisode int) error {
	if _, err := tx.Exec(ctx, `
		DELETE FROM recap_conversation_requests r
		WHERE r.conversation_id = $1
		  AND (
			r.status <> 'completed'
			OR EXISTS (
				SELECT 1 FROM recap_conversation_turns t
				WHERE t.conversation_id = r.conversation_id AND t.request_id = r.request_id
				  AND (t.boundary_season > $2 OR (t.boundary_season = $2 AND t.boundary_episode > $3))
			)
		  )`, conversationID, boundarySeason, boundaryEpisode); err != nil {
		return fmt.Errorf("clear unsafe recap request reservations: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM recap_conversation_turns t
		WHERE t.conversation_id = $1
		  AND (t.boundary_season > $2 OR (t.boundary_season = $2 AND t.boundary_episode > $3))`,
		conversationID, boundarySeason, boundaryEpisode); err != nil {
		return fmt.Errorf("clear unsafe recap turns: %w", err)
	}
	return nil
}

type recapTurnScanner interface {
	Scan(dest ...any) error
}

func scanRecapTurn(s recapTurnScanner) (*RecapConversationTurn, error) {
	var turn RecapConversationTurn
	err := s.Scan(&turn.ID, &turn.RequestID, &turn.Question, &turn.Answer, &turn.UpToEpisodeID,
		&turn.BoundarySeason, &turn.BoundaryEpisode, &turn.BoundaryTitle,
		&turn.GroundingMode, &turn.CreatedAt)
	return &turn, err
}

func scanRecapTurnWithCount(s recapTurnScanner, count *int) (*RecapConversationTurn, error) {
	var turn RecapConversationTurn
	err := s.Scan(&turn.ID, &turn.RequestID, &turn.Question, &turn.Answer, &turn.UpToEpisodeID,
		&turn.BoundarySeason, &turn.BoundaryEpisode, &turn.BoundaryTitle,
		&turn.GroundingMode, &turn.CreatedAt, count)
	return &turn, err
}
