package watchparty

import (
	"context"
	"testing"
)

// TestEndingAPartyRecordsTheTitleItEndedOn: a change-media saves the new
// title in the background, and that save skips an inactive row, so a party
// ended before it landed kept the earlier title in its row. The highlight
// reel is cut from the final title but gated on the row's, so a kid could be
// served a reel of an R title the row said was G. Here the in-memory title
// moves with no save at all, the worst case of that race.
func TestEndingAPartyRecordsTheTitleItEndedOn(t *testing.T) {
	q, pool := requireRehydrateDB(t)
	ctx := context.Background()
	scalar := func(sql string, args ...any) int64 {
		t.Helper()
		var id int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&id); err != nil {
			t.Fatalf("seed: %v", err)
		}
		return id
	}
	hostID := scalar(`INSERT INTO users (username, email, password_hash)
		VALUES ('endmedia_t_'||md5(random()::text), md5(random()::text)||'@example.com', 'x') RETURNING id`)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, hostID) })
	libID := scalar(`INSERT INTO libraries (name, type, paths, owner_id)
		VALUES ('endmedia_lib_'||md5(random()::text), 'movie', '{"/tmp/endmedia"}', $1) RETURNING id`, hostID)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id = $1`, libID) })
	movie := func(title, rating string) int64 {
		return scalar(`INSERT INTO media_items (library_id, type, title, sort_title, content_rating, last_metadata_attempt)
			VALUES ($1, 'movie', $2, $2, $3, NOW()) RETURNING id`, libID, title, rating)
	}
	gMovie, rMovie := movie("endmedia g", "G"), movie("endmedia r", "R")

	m := NewManager(q, nil)
	t.Cleanup(m.Shutdown)
	ps, err := m.CreateParty(ctx, hostID, "host", gMovie, nil, "Movie Night", "endmedia g", "", 8,
		PartySettings{AllowPause: true, AllowChat: true}, 0, nil)
	if err != nil {
		t.Fatalf("create party: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM watch_parties WHERE party_code = $1`, ps.Code)
	})
	ps.mu.Lock()
	ps.MediaItemID, ps.MediaTitle = rMovie, "endmedia r"
	ps.mu.Unlock()

	if err := m.EndParty(ps.Code, hostID); err != nil {
		t.Fatalf("end party: %v", err)
	}
	var mediaID int64
	var title string
	var active bool
	if err := pool.QueryRow(ctx, `SELECT media_item_id, COALESCE(media_title, ''), is_active FROM watch_parties WHERE party_code = $1`, ps.Code).
		Scan(&mediaID, &title, &active); err != nil {
		t.Fatalf("read the party row: %v", err)
	}
	if active || mediaID != rMovie || title != "endmedia r" {
		t.Errorf("the ended party's row: active %v, media %d %q; want ended on the R title %d it ended on, with its name",
			active, mediaID, title, rMovie)
	}

	// A merge can delete the title a live party still names. The end used to
	// write that id too, fail its foreign key, and leave the party active for
	// good, blocking its room; now it ends on the row's own title.
	gone := movie("endmedia gone", "G")
	ps2, err := m.CreateParty(ctx, hostID, "host", gMovie, nil, "Movie Night 2", "endmedia g", "", 8,
		PartySettings{AllowPause: true, AllowChat: true}, 0, nil)
	if err != nil {
		t.Fatalf("create the second party: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM watch_parties WHERE party_code = $1`, ps2.Code)
	})
	ps2.mu.Lock()
	ps2.MediaItemID, ps2.MediaTitle = gone, "endmedia gone"
	ps2.mu.Unlock()
	if _, err := pool.Exec(ctx, `DELETE FROM media_items WHERE id = $1`, gone); err != nil {
		t.Fatalf("delete the title: %v", err)
	}
	if err := m.EndParty(ps2.Code, hostID); err != nil {
		t.Fatalf("end the second party: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT media_item_id, COALESCE(media_title, ''), is_active FROM watch_parties WHERE party_code = $1`, ps2.Code).
		Scan(&mediaID, &title, &active); err != nil {
		t.Fatalf("read the second party row: %v", err)
	}
	if active || mediaID != gMovie || title != "endmedia g" {
		t.Errorf("a party ended on a deleted title: active %v, media %d %q; want ended on its row's own title %d", active, mediaID, title, gMovie)
	}
}
