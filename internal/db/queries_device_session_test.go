package db

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

func TestDeviceSessionIssuanceWaitsForRevocationUserLock(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	// Hold the same non-key update lock as RevokeAllUserSessions while its
	// new version is still uncommitted. An unfenced SELECT can see version 0.
	if _, err := tx.Exec(ctx, `UPDATE users SET token_version=token_version+1 WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	entered := make(chan struct{})
	go func() {
		close(entered)
		rt := &models.RefreshToken{UserID: userID, Token: fmt.Sprintf("device-lock-%d", userID), ExpiresAt: time.Now().Add(time.Hour)}
		created, err := q.CreateRefreshTokenAtVersion(ctx, rt, 0)
		if err == nil && created {
			err = fmt.Errorf("stale version issued a session")
		}
		result <- err
	}()
	<-entered
	select {
	case err := <-result:
		t.Fatalf("issuance did not wait for revocation lock: %v", err)
	case <-time.After(250 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestDeviceSessionIssuedBeforeRevocationIsNotRenewable(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	ctx := context.Background()
	rt := &models.RefreshToken{UserID: userID, Token: fmt.Sprintf("device-revoke-%d", userID), ExpiresAt: time.Now().Add(time.Hour)}
	if created, err := q.CreateRefreshTokenAtVersion(ctx, rt, 0); err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	if version, err := q.RevokeAllUserSessions(ctx, userID); err != nil || version != 1 {
		t.Fatalf("revoke: version=%d error=%v", version, err)
	}
	if current, err := q.GetRefreshToken(ctx, rt.Token); err != nil || current != nil {
		t.Fatalf("revoked session remains renewable: %+v %v", current, err)
	}
	if created, err := q.CreateRefreshTokenAtVersion(ctx, rt, 0); err != nil || created {
		t.Fatalf("revoked version created a session: %v %v", created, err)
	}
}

func TestRefreshRotationRevocationBetweenLookupAndUserLock(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	old := &models.RefreshToken{UserID: userID, Token: fmt.Sprintf("refresh-lock-old-%d", userID), ExpiresAt: time.Now().Add(time.Hour)}
	if err := q.CreateRefreshToken(ctx, old); err != nil {
		t.Fatal(err)
	}
	lookedUp := make(chan struct{})
	resume := make(chan struct{}, 1)
	defer close(resume)
	q.testHookBeforeRefreshUserLock = func() {
		close(lookedUp)
		select {
		case <-resume:
		case <-ctx.Done():
		}
	}
	result := make(chan error, 1)
	go func() {
		next := &models.RefreshToken{Token: fmt.Sprintf("refresh-lock-next-%d", userID), ExpiresAt: time.Now().Add(time.Hour)}
		user, err := q.RotateRefreshToken(ctx, old.Token, next)
		if err == nil && user != nil {
			err = fmt.Errorf("pre-revocation refresh restored version %d", user.TokenVersion)
		}
		result <- err
	}()
	select {
	case <-lookedUp:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// Unlike the vulnerable sequence, the pending request has not consumed
	// anything outside the user lock. Commit real account revocation before
	// allowing it to read the newly bumped identity/version.
	if active, err := q.GetRefreshToken(ctx, old.Token); err != nil || active == nil {
		t.Fatalf("rotation consumed the token before obtaining the user lock: %+v %v", active, err)
	}
	if version, err := q.RevokeAllUserSessions(ctx, userID); err != nil || version != 1 {
		t.Fatalf("revoke: version=%d error=%v", version, err)
	}
	resume <- struct{}{}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var active int
	if err := q.pool.QueryRow(ctx, `SELECT count(*) FROM refresh_tokens WHERE user_id=$1 AND NOT revoked`, userID).Scan(&active); err != nil || active != 0 {
		t.Fatalf("renewable sessions=%d error=%v", active, err)
	}
}

func TestRefreshRotationSingleUseRollbackAndRevocation(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	ctx := context.Background()
	profile, err := q.CreateDefaultProfileForUser(ctx, userID, "Viewer")
	if err != nil {
		t.Fatal(err)
	}
	old := &models.RefreshToken{UserID: userID, Token: fmt.Sprintf("refresh-atomic-old-%d", userID), ExpiresAt: time.Now().Add(time.Hour), ActiveProfileID: &profile.ID}
	if err := q.CreateRefreshToken(ctx, old); err != nil {
		t.Fatal(err)
	}
	// Force insertion to fail through the real unique constraint. Consuming
	// the old token separately would strand the client after this failure.
	duplicate := &models.RefreshToken{Token: old.Token, ExpiresAt: time.Now().Add(time.Hour)}
	if user, err := q.RotateRefreshToken(ctx, old.Token, duplicate); err == nil || user != nil {
		t.Fatalf("duplicate insertion unexpectedly succeeded: %+v %v", user, err)
	}
	if active, err := q.GetRefreshToken(ctx, old.Token); err != nil || active == nil {
		t.Fatalf("failed rotation consumed its input: %+v %v", active, err)
	}
	next := &models.RefreshToken{Token: fmt.Sprintf("refresh-atomic-next-%d", userID), ExpiresAt: time.Now().Add(time.Hour)}
	user, err := q.RotateRefreshToken(ctx, old.Token, next)
	if err != nil || user == nil || user.ID != userID || user.TokenVersion != 0 || next.ActiveProfileID == nil || *next.ActiveProfileID != profile.ID {
		t.Fatalf("rotation lost identity/profile: user=%+v session=%+v error=%v", user, next, err)
	}
	if user, err := q.RotateRefreshToken(ctx, old.Token, duplicate); err != nil || user != nil {
		t.Fatalf("consumed token was reused: %+v %v", user, err)
	}
	if _, err := q.RevokeAllUserSessions(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if user, err := q.RotateRefreshToken(ctx, next.Token, duplicate); err != nil || user != nil {
		t.Fatalf("revoked replacement renewed: %+v %v", user, err)
	}
}
