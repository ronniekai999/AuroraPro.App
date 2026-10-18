package watchparty

import (
	"context"
	"strings"
	"testing"
)

// TestChangeMediaUsesTheProfileResolvedAtConnect: the room socket passed its
// connect-time session id to ChangeMedia, which resolved it on every change.
// The client rotates its session about every 15 minutes and the purge
// deletes the old row soon after; a row that is gone resolves to the
// account's most restrictive profile, so an unrestricted host's next episode
// was refused partway into a party. The socket now resolves the profile once
// (CallerProfile) and ChangeMedia applies that.
func TestChangeMediaUsesTheProfileResolvedAtConnect(t *testing.T) {
	q, pool := requireRehydrateDB(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	scalar := func(sql string, args ...any) int64 {
		t.Helper()
		var id int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
			t.Fatalf("seed: %v", err)
		}
		return id
	}
	hostID := scalar(`INSERT INTO users (username, email, password_hash)
		VALUES ('changemedia_t_'||md5(random()::text), md5(random()::text)||'@example.com', 'x') RETURNING id`)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, hostID) })
	parentID := scalar(`INSERT INTO user_profiles (user_id, name, is_default) VALUES ($1, 'parent', TRUE) RETURNING id`, hostID)
	exec(`INSERT INTO user_profiles (user_id, name, is_default, max_age_rating) VALUES ($1, 'kid', FALSE, 'PG')`, hostID)
	rt := scalar(`INSERT INTO refresh_tokens (user_id, token, expires_at, active_profile_id)
		VALUES ($1, 'changemedia_'||md5(random()::text), NOW() + interval '1 hour', $2) RETURNING id`, hostID, parentID)
	libID := scalar(`INSERT INTO libraries (name, type, paths, owner_id)
		VALUES ('changemedia_lib_'||md5(random()::text), 'movie', '{"/tmp/changemedia"}', $1) RETURNING id`, hostID)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id = $1`, libID) })
	movie := func(title, rating string) int64 {
		return scalar(`INSERT INTO media_items (library_id, type, title, sort_title, content_rating, last_metadata_attempt)
			VALUES ($1, 'movie', $2, $2, $3, NOW()) RETURNING id`, libID, title, rating)
	}
	gMovie, rMovie := movie("changemedia g", "G"), movie("changemedia r", "R")

	m := NewManager(q, nil)
	t.Cleanup(m.Shutdown)
	ps, err := m.CreateParty(ctx, hostID, "host", gMovie, nil, "Movie Night", "changemedia g", "", 8,
		PartySettings{AllowPause: true, AllowChat: true}, 0, nil)
	if err != nil {
		t.Fatalf("create party: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM watch_parties WHERE party_code = $1`, ps.Code) })

	caller := m.CallerProfile(ctx, hostID, rt)
	if caller == nil || caller.ID != parentID {
		t.Fatalf("at connect the host acts as %+v, want the parent (%d)", caller, parentID)
	}
	// The session rotates and its old row is purged.
	exec(`DELETE FROM refresh_tokens WHERE id = $1`, rt)
	if late := m.CallerProfile(ctx, hostID, rt); late == nil || late.MaxAgeRating == "" {
		t.Fatalf("precondition: a purged session should resolve to the restricted profile, got %+v", late)
	}

	if err := m.ChangeMedia(ps.Code, hostID, caller, rMovie, nil, "changemedia r", ""); err != nil {
		t.Errorf("the unrestricted host's change to an R title after its session row was purged: %v", err)
	}
	// The check still applies a restricted caller's ceiling.
	kid := m.CallerProfile(ctx, hostID, rt)
	if err := m.ChangeMedia(ps.Code, hostID, kid, rMovie, nil, "changemedia r", ""); err == nil ||
		!strings.Contains(err.Error(), "content rating") {
		t.Errorf("a restricted caller's change to an R title: %v, want the content rating refusal", err)
	}
}
