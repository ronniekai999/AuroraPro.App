package watchparty

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// A reaction's abs_ms is a position on the timeline of the title the party
// was playing when it was sent. A media change (the next-episode button)
// starts a different timeline, so the earlier title's reactions must not be
// read against the new one: the reel would cut them from the wrong file at
// positions that mean nothing there, and the reaction timeline would paint
// them on the wrong seekbar.
func TestChangeMediaStartsANewReactionTimeline(t *testing.T) {
	m := mockPartyManager()
	ep1, ep2 := int64(11), int64(12)
	ps := &PartyState{
		Code:            "REACTS",
		HostUserID:      1,
		MediaItemID:     100,
		EpisodeID:       &ep1,
		MaxParticipants: 4,
		Participants: map[int64]*Participant{
			1: {UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()},
		},
		roomConns:      make(map[int64]*SafeConn),
		syncConns:      make(map[int64]*SafeConn),
		ChatHistory:    make([]ChatMessage, 0),
		Settings:       PartySettings{AllowChat: true, AllowPause: true},
		CreatedAt:      time.Now(),
		AnchorAbsMs:    600_000,
		AnchorServerAt: time.Now(),
	}
	m.mu.Lock()
	m.parties[ps.Code] = ps
	m.mu.Unlock()

	react := func() {
		t.Helper()
		if err := m.HandleReaction(ps.Code, 1, "host", "😂", 0); err != nil {
			t.Fatalf("reaction: %v", err)
		}
	}
	react()
	react()

	// The same title again (a re-sent change) keeps its timeline.
	same := ep1
	if err := m.ChangeMedia(ps.Code, 1, nil, 100, &same, "Show", ""); err != nil {
		t.Fatalf("change to the same episode: %v", err)
	}
	if got := len(m.RecentReactions(ps.Code)); got != 2 {
		t.Fatalf("after a change to the same episode: %d reactions; want the 2 recorded on it", got)
	}

	// Another episode of the same show (the series id does not change).
	if err := m.ChangeMedia(ps.Code, 1, nil, 100, &ep2, "Show", ""); err != nil {
		t.Fatalf("change to the next episode: %v", err)
	}
	if got := m.RecentReactions(ps.Code); len(got) != 0 {
		t.Fatalf("after the next episode: %d reactions from the previous episode survive; want 0", len(got))
	}
	react()
	if got := len(m.RecentReactions(ps.Code)); got != 1 {
		t.Fatalf("after one reaction on the next episode: %d reactions; want 1", got)
	}

	// Another title altogether.
	if err := m.ChangeMedia(ps.Code, 1, nil, 200, nil, "Movie", ""); err != nil {
		t.Fatalf("change to a movie: %v", err)
	}
	if got := len(m.RecentReactions(ps.Code)); got != 0 {
		t.Fatalf("after a change of title: %d reactions survive; want 0", got)
	}
}

// The reel of a TV party used to be cut from the SERIES' first episode: the
// party records the series id as its title (the episode rides beside it), and
// the reel's source lookup took any file of that id, ordered by season and
// episode number. A party that watched S03E05 got clips of S01E01 at the
// moments people reacted to S03E05.
func TestHighlightReelIsCutFromTheEpisodeThePartyWatched(t *testing.T) {
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
		VALUES ('reelsrc_t_'||md5(random()::text), md5(random()::text)||'@example.com', 'x') RETURNING id`)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, hostID) })
	library := func(kind string) int64 {
		id := scalar(`INSERT INTO libraries (name, type, paths, owner_id)
			VALUES ('reelsrc_lib_'||md5(random()::text), $2, '{"/tmp/reelsrc"}', $1) RETURNING id`, hostID, kind)
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id = $1`, id) })
		return id
	}
	shows, movies := library("show"), library("movie")
	// Paths are unique per run: episode_files.path and media_files.path are.
	tag := scalar(`SELECT (random() * 1e15)::bigint`)
	path := func(name string) string { return fmt.Sprintf("/tmp/reelsrc/%d/%s.mkv", tag, name) }

	show := scalar(`INSERT INTO media_items (library_id, type, title, sort_title, last_metadata_attempt)
		VALUES ($1, 'show', 'reelsrc show', 'reelsrc show', NOW()) RETURNING id`, shows)
	season := func(n int) int64 {
		return scalar(`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1, $2) RETURNING id`, show, n)
	}
	episode := func(seasonID int64, n int) int64 {
		return scalar(`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1, $2, $3) RETURNING id`, seasonID, show, n)
	}
	episodeFile := func(episodeID int64, p string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO episode_files (episode_id, path, file_hash) VALUES ($1, $2, $3)`,
			episodeID, p, p); err != nil {
			t.Fatalf("seed episode file: %v", err)
		}
	}
	pilot, watched := episode(season(1), 1), episode(season(3), 5)
	pilotPath, watchedPath := path("s01e01"), path("s03e05")
	episodeFile(pilot, pilotPath)
	episodeFile(watched, watchedPath)
	// An episode with no file at all: there is nothing honest to cut from.
	fileless := episode(season(4), 1)

	movie := scalar(`INSERT INTO media_items (library_id, type, title, sort_title, last_metadata_attempt)
		VALUES ($1, 'movie', 'reelsrc movie', 'reelsrc movie', NOW()) RETURNING id`, movies)
	moviePath := path("movie")
	if _, err := pool.Exec(ctx, `INSERT INTO media_files (media_item_id, path, file_hash) VALUES ($1, $2, $3)`,
		movie, moviePath, moviePath); err != nil {
		t.Fatalf("seed media file: %v", err)
	}

	m := NewManager(q, nil)
	shutdown, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m.SetShutdownContext(shutdown)
	m.SetHighlightCacheDir(t.TempDir())
	t.Cleanup(m.Shutdown)

	type handed struct {
		media   int64
		episode *int64
	}
	reels := make(chan handed, 1)
	sources := make(chan string, 1)
	m.onReelForTest = func(media int64, ep *int64, _ string) { reels <- handed{media, ep} }
	m.onReelSourceForTest = func(p string) { sources <- p }

	end := func(t *testing.T, media int64, ep *int64) (handed, string) {
		t.Helper()
		ps, err := m.CreateParty(ctx, hostID, "host", media, ep, "Reel Night", "reelsrc", "", 8,
			PartySettings{AllowPause: true, AllowChat: true}, 600_000, nil)
		if err != nil {
			t.Fatalf("create party: %v", err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM watch_parties WHERE party_code = $1`, ps.Code)
		})
		if _, err := m.JoinPartyV3Room(ps.Code, hostID, "host", nil); err != nil {
			t.Fatalf("join: %v", err)
		}
		for i := 0; i < highlightReelTopN; i++ {
			if err := m.HandleReaction(ps.Code, hostID, "host", "😂", 0); err != nil {
				t.Fatalf("reaction: %v", err)
			}
		}
		if err := m.EndParty(ps.Code, hostID); err != nil {
			t.Fatalf("end party: %v", err)
		}
		var h handed
		select {
		case h = <-reels:
		case <-time.After(5 * time.Second):
			t.Fatal("the reel was never handed a title")
		}
		select {
		case src := <-sources:
			return h, src
		case <-time.After(5 * time.Second):
			t.Fatal("the reel never resolved a source")
		}
		return h, ""
	}

	t.Run("an episode is cut from that episode", func(t *testing.T) {
		ep := watched
		h, src := end(t, show, &ep)
		if h.media != show || h.episode == nil || *h.episode != watched {
			t.Fatalf("reel handed %+v; want show %d, episode %d (the row records both)", h, show, watched)
		}
		if src != watchedPath {
			t.Fatalf("reel source %q; want the watched episode's file %q (not the pilot %q)", src, watchedPath, pilotPath)
		}
	})

	t.Run("an episode without a file cuts nothing", func(t *testing.T) {
		ep := fileless
		_, src := end(t, show, &ep)
		if src != "" {
			t.Fatalf("reel source %q; want none: another episode's file would carry the wrong moments", src)
		}
	})

	t.Run("a show without an episode cuts nothing", func(t *testing.T) {
		_, src := end(t, show, nil)
		if src != "" {
			t.Fatalf("reel source %q; want none: the party never said which episode its reactions belong to", src)
		}
	})

	t.Run("a movie is cut from its file", func(t *testing.T) {
		h, src := end(t, movie, nil)
		if h.media != movie || h.episode != nil {
			t.Fatalf("reel handed %+v; want movie %d with no episode", h, movie)
		}
		if src != moviePath {
			t.Fatalf("reel source %q; want the movie's file %q", src, moviePath)
		}
	})
}
