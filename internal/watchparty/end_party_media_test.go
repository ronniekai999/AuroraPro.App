package watchparty

import (
	"context"
	"fmt"
	"testing"
)

// TestEndingAPartyRecordsTheTitleItEndedOn: a change-media saves the new
// title in the background, and that save skips an inactive row, so a party
// ended before it landed kept the earlier title in its row. The highlight
// reel was cut from the final title but gated on the row's, so a kid could be
// served a reel of an R title the row said was G. Here the in-memory title
// moves with no save at all, the worst case of that race. Every case also
// checks that the reel is cut from the title the row records.
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
	season := func(show int64) int64 {
		return scalar(`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1, 1) RETURNING id`, show)
	}
	episode := func(season, show int64, number int) int64 {
		return scalar(`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1, $2, $3) RETURNING id`, season, show, number)
	}
	gMovie, rMovie := title(movies, "movie", "endmedia g", "G"), title(movies, "movie", "endmedia r", "R")
	showA, showB := title(shows, "show", "endmedia show a", "TV-G"), title(shows, "show", "endmedia show b", "TV-MA")
	seasonA := season(showA)
	episodeA, episodeB := episode(seasonA, showA, 1), episode(season(showB), showB, 1)

	m := NewManager(q, nil)
	t.Cleanup(m.Shutdown)
	var reelMedia int64
	var reelTitle string
	m.onReelForTest = func(media int64, name string) { reelMedia, reelTitle = media, name }
	type row struct {
		media         int64
		episode       *int64
		title, poster string
		active        bool
	}
	// end starts a party on (media, ep, name), runs before (database work,
	// outside the party's lock), moves its in-memory title as change does,
	// with no save, ends it, and reads its row back. It fails the test unless
	// the reel was handed the row's title id and name.
	end := func(t *testing.T, media int64, ep *int64, name string, before func(partyID int64), change func(ps *PartyState)) row {
		t.Helper()
		ps, err := m.CreateParty(ctx, hostID, "host", media, ep, "Movie Night", name, "", 8,
			PartySettings{AllowPause: true, AllowChat: true}, 0, nil)
		if err != nil {
			t.Fatalf("create party: %v", err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM watch_parties WHERE party_code = $1`, ps.Code)
		})
		if before != nil {
			ps.mu.Lock()
			partyID := ps.dbID
			ps.mu.Unlock()
			before(partyID)
		}
		func() {
			ps.mu.Lock()
			defer ps.mu.Unlock()
			change(ps)
		}()
		reelMedia, reelTitle = -1, "unset"
		if err := m.EndParty(ps.Code, hostID); err != nil {
			t.Fatalf("end party: %v", err)
		}
		var r row
		if err := pool.QueryRow(ctx, `SELECT media_item_id, episode_id, media_title, media_poster, is_active
			FROM watch_parties WHERE party_code = $1`, ps.Code).Scan(&r.media, &r.episode, &r.title, &r.poster, &r.active); err != nil {
			t.Fatalf("read the party row: %v", err)
		}
		if reelMedia != r.media || reelTitle != r.title {
			t.Errorf("reel cut from title %d %q; the row, which gates it, records %d %q", reelMedia, reelTitle, r.media, r.title)
		}
		return r
	}
	// refuse makes the database refuse the first n updates of party row
	// partyID, and counts every update that reaches the row, refused or not
	// (a sequence keeps its count when the statement fails). The trigger
	// fires only for that row.
	refuse := func(t *testing.T, partyID int64, n int) (updates func() int64) {
		t.Helper()
		name := fmt.Sprintf("endmedia_refuse_%d", partyID)
		drop := func() {
			for _, sql := range []string{
				`DROP TRIGGER IF EXISTS ` + name + ` ON watch_parties`,
				`DROP FUNCTION IF EXISTS ` + name + `()`,
				`DROP SEQUENCE IF EXISTS ` + name,
			} {
				_, _ = pool.Exec(context.Background(), sql)
			}
		}
		t.Cleanup(drop)
		for _, sql := range []string{
			`CREATE SEQUENCE ` + name,
			fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					IF nextval('%s') <= %d THEN
						RAISE EXCEPTION 'endmedia: update refused';
					END IF;
					RETURN NEW;
				END $$`, name, name, n),
			fmt.Sprintf(`CREATE TRIGGER %s BEFORE UPDATE ON watch_parties
				FOR EACH ROW WHEN (OLD.id = %d) EXECUTE FUNCTION %s()`, name, partyID, name),
		} {
			if _, err := pool.Exec(ctx, sql); err != nil {
				t.Fatalf("install the refusal: %v", err)
			}
		}
		return func() int64 {
			var n int64
			if err := pool.QueryRow(ctx, `SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM `+name).Scan(&n); err != nil {
				t.Fatalf("count the updates: %v", err)
			}
			return n
		}
	}
	same := func(a, b *int64) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

	t.Run("the final title, with its name", func(t *testing.T) {
		r := end(t, gMovie, nil, "endmedia g", nil, func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle = rMovie, "endmedia r"
		})
		if r.active || r.media != rMovie || r.title != "endmedia r" {
			t.Errorf("row %+v; want ended on the R title %d with its name", r, rMovie)
		}
	})

	// A merge can delete the title a live party still names. The end used to
	// write that id too, fail its foreign key, and leave the party active for
	// good, blocking its room. It now ends on the row's own title, name kept,
	// in one update: the existence check, not the fallbacks, keeps the id out.
	t.Run("a title deleted meanwhile", func(t *testing.T) {
		gone := title(movies, "movie", "endmedia gone", "G")
		var updates func() int64
		r := end(t, gMovie, nil, "endmedia g", func(partyID int64) {
			if _, err := pool.Exec(ctx, `DELETE FROM media_items WHERE id = $1`, gone); err != nil {
				t.Fatalf("delete the title: %v", err)
			}
			updates = refuse(t, partyID, 0)
		}, func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle = gone, "endmedia gone"
		})
		if r.active || r.media != gMovie || r.title != "endmedia g" {
			t.Errorf("row %+v; want ended on its own title %d, name kept", r, gMovie)
		}
		if n := updates(); n != 1 {
			t.Errorf("%d updates reached the row; want 1", n)
		}
	})

	// Text the column refuses (NUL) failed every write of the title, so the
	// end fell back to the row's earlier title, which the reel gate reads.
	// The ids are now recorded without the text.
	t.Run("a name the database refuses", func(t *testing.T) {
		r := end(t, gMovie, nil, "endmedia g", nil, func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle = rMovie, "endmedia r\x00"
		})
		if r.active || r.media != rMovie || r.title != "" {
			t.Errorf("row %+v; want ended on the R title %d with no name", r, rMovie)
		}
	})

	// Any other failure keeps the name for the retry: only a refusal of the
	// text itself is a reason to drop it.
	t.Run("a failure that is not the name's", func(t *testing.T) {
		var updates func() int64
		r := end(t, gMovie, nil, "endmedia g", func(partyID int64) {
			updates = refuse(t, partyID, 1)
		}, func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle = rMovie, "endmedia r"
		})
		if r.active || r.media != rMovie || r.title != "endmedia r" {
			t.Errorf("row %+v; want ended on the R title %d with its name", r, rMovie)
		}
		if n := updates(); n != 2 {
			t.Errorf("%d updates reached the row; want 2", n)
		}
	})

	// When neither write of the title lands, the party still ends, on the
	// row's own title, and the reel follows the row rather than memory.
	t.Run("every write of the title refused", func(t *testing.T) {
		var updates func() int64
		r := end(t, gMovie, nil, "endmedia g", func(partyID int64) {
			updates = refuse(t, partyID, 2)
		}, func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle = rMovie, "endmedia r"
		})
		if r.active || r.media != gMovie || r.title != "endmedia g" {
			t.Errorf("row %+v; want ended on its own title %d, name kept", r, gMovie)
		}
		if n := updates(); n != 3 {
			t.Errorf("%d updates reached the row; want 3", n)
		}
	})

	// An episode that is not the title's own would pair one show's id with
	// another's episode, so the row takes the title alone, with no episode,
	// name or poster from the same suspect change.
	t.Run("an episode of another show", func(t *testing.T) {
		r := end(t, showA, &episodeA, "endmedia show a", nil, func(ps *PartyState) {
			ps.MediaItemID, ps.MediaTitle, ps.MediaPoster = showB, "endmedia show b", "/b.jpg"
		})
		if r.active || r.media != showB || r.episode != nil || r.title != "" || r.poster != "" {
			t.Errorf("row %+v; want ended on show %d alone", r, showB)
		}
	})

	// The episode's own row can name the show while its season is another
	// show's; the season decides too.
	t.Run("an episode in another show's season", func(t *testing.T) {
		stray := episode(seasonA, showB, 2)
		r := end(t, showA, &episodeA, "endmedia show a", nil, func(ps *PartyState) {
			ep := stray
			ps.MediaItemID, ps.EpisodeID, ps.MediaTitle = showB, &ep, "endmedia show b"
		})
		if r.active || r.media != showB || r.episode != nil || r.title != "" {
			t.Errorf("row %+v; want ended on show %d alone", r, showB)
		}
	})

	t.Run("an episode, name and poster recorded together", func(t *testing.T) {
		r := end(t, showA, &episodeA, "endmedia show a", nil, func(ps *PartyState) {
			ep := episodeB
			ps.MediaItemID, ps.EpisodeID, ps.MediaTitle, ps.MediaPoster = showB, &ep, "endmedia show b", "/b.jpg"
		})
		if r.active || r.media != showB || !same(r.episode, &episodeB) || r.title != "endmedia show b" || r.poster != "/b.jpg" {
			t.Errorf("row %+v; want ended on show %d, episode %d, its name and poster", r, showB, episodeB)
		}
	})
}
