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
	library := func(kind string) int64 {
		id := scalar(`INSERT INTO libraries (name, type, paths, owner_id)
			VALUES ('endmedia_lib_'||md5(random()::text), $2, '{"/tmp/endmedia"}', $1) RETURNING id`, hostID, kind)
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id = $1`, id) })
		return id
	}
	movies, shows := library("movie"), library("show")
	title := func(lib int64, kind, name, rating string) int64 {
		return scalar(`INSERT INTO media_items (library_id, type, title, sort_title, content_rating, last_metadata_attempt)
			VALUES ($1, $2, $3, $3, $4, NOW()) RETURNING id`, lib, kind, name, rating)
	}
	episode := func(show int64) int64 {
		season := scalar(`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1, 1) RETURNING id`, show)
		return scalar(`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1, $2, 1) RETURNING id`, season, show)
	}
	gMovie, rMovie := title(movies, "movie", "endmedia g", "G"), title(movies, "movie", "endmedia r", "R")
	showA, showB := title(shows, "show", "endmedia show a", "TV-G"), title(shows, "show", "endmedia show b", "TV-MA")
	episodeA, episodeB := episode(showA), episode(showB)

	m := NewManager(q, nil)
	t.Cleanup(m.Shutdown)
	type row struct {
		media         int64
		episode       *int64
		title, poster string
		active        bool
	}
	// end starts a party on (media, ep, name), moves its in-memory title as
	// change does, with no save, ends it, and reads its row back.
	end := func(t *testing.T, media int64, ep *int64, name string, change func(ps *PartyState)) row {
		t.Helper()
		ps, err := m.CreateParty(ctx, hostID, "host", media, ep, "Movie Night", name, "", 8,
			PartySettings{AllowPause: true, AllowChat: true}, 0, nil)
		if err != nil {
			t.Fatalf("create party: %v", err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM watch_parties WHERE party_code = $1`, ps.Code)
		})
		ps.mu.Lock()
		change(ps)
		ps.mu.Unlock()
		if err := m.EndParty(ps.Code, hostID); err != nil {
			t.Fatalf("end party: %v", err)
		}
		var r row
		if err := pool.QueryRow(ctx, `SELECT media_item_id, episode_id, media_title, media_poster, is_active
			FROM watch_parties WHERE party_code = $1`, ps.Code).Scan(&r.media, &r.episode, &r.title, &r.poster, &r.active); err != nil {
			t.Fatalf("read the party row: %v", err)
		}
		return r
	}
	same := func(a, b *int64) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

	t.Run("the final title, with its name", func(t *testing.T) {
		r := end(t, gMovie, nil, "endmedia g", func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle = rMovie, "endmedia r"
		})
		if r.active || r.media != rMovie || r.title != "endmedia r" {
			t.Errorf("row %+v; want ended on the R title %d with its name", r, rMovie)
		}
	})

	// A merge can delete the title a live party still names. The end used to
	// write that id too, fail its foreign key, and leave the party active for
	// good, blocking its room. It now ends on the row's own title, name kept.
	t.Run("a title deleted meanwhile", func(t *testing.T) {
		gone := title(movies, "movie", "endmedia gone", "G")
		r := end(t, gMovie, nil, "endmedia g", func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle = gone, "endmedia gone"
			if _, err := pool.Exec(ctx, `DELETE FROM media_items WHERE id = $1`, gone); err != nil {
				t.Fatalf("delete the title: %v", err)
			}
		})
		if r.active || r.media != gMovie || r.title != "endmedia g" {
			t.Errorf("row %+v; want ended on its own title %d, name kept", r, gMovie)
		}
	})

	// Text the column refuses (NUL) failed every write of the title, so the
	// end fell back to the row's earlier title, which the reel gate reads.
	// The ids are now recorded without the text.
	t.Run("a name the database refuses", func(t *testing.T) {
		r := end(t, gMovie, nil, "endmedia g", func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle = rMovie, "endmedia r\x00"
		})
		if r.active || r.media != rMovie || r.title != "" {
			t.Errorf("row %+v; want ended on the R title %d with no name", r, rMovie)
		}
	})

	// An episode that is not the title's own would pair one show's id with
	// another's episode, so the row keeps its own title.
	t.Run("an episode of another show", func(t *testing.T) {
		r := end(t, showA, &episodeA, "endmedia show a", func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle = showB, "endmedia show b"
		})
		if r.active || r.media != showA || !same(r.episode, &episodeA) || r.title != "endmedia show a" {
			t.Errorf("row %+v; want ended on its own show %d and episode %d", r, showA, episodeA)
		}
	})

	t.Run("an episode, name and poster recorded together", func(t *testing.T) {
		r := end(t, showA, &episodeA, "endmedia show a", func(ps *PartyState) {
			ep := episodeB
			ps.MediaItemID, ps.EpisodeID, ps.MediaTitle, ps.MediaPoster = showB, &ep, "endmedia show b", "/b.jpg"
		})
		if r.active || r.media != showB || !same(r.episode, &episodeB) || r.title != "endmedia show b" || r.poster != "/b.jpg" {
			t.Errorf("row %+v; want ended on show %d, episode %d, its name and poster", r, showB, episodeB)
		}
	})
}
