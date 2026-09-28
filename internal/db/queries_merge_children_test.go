package db

// MergeMediaItems collapses a duplicate media item into a canonical one. It ends
// in `DELETE FROM media_items WHERE id = duplicate`, and media_items has 19
// children with ON DELETE CASCADE — so anything the function does not explicitly
// re-parent is destroyed, silently and unrecoverably.
//
// It handled 8 of the 19. The other 11 arrived in migrations written after it:
// watchlist_items, user_ratings, collection_items, taste_seeds,
// recently_surfaced_items, item_feedback, episode_recaps, recap_conversations,
// watch_parties, recommendation_impressions, recommendation_watch_events. A
// watchlist entry and a 5-star rating on the duplicate both read back as zero
// after a merge.
//
// CLAUDE.md calls the catalog-delete path the most dangerous code in this repo,
// and records that four of the five defects in the withdrawn library-repointing
// work were found by RUNNING code against Postgres rather than by reading it.
// These tests run it.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.

import (
	"context"
	"sort"
	"strings"
	"testing"
)

// cascadeChildren returns the tables with an ON DELETE CASCADE or ON DELETE SET
// NULL foreign key to the given parent. SET NULL is included deliberately: it
// does not delete the row but silently strips its link, which for
// watch_parties.episode_id meant an active room for a show with no episode. The
// media_items guard used to check CASCADE only while the tv_episodes guard checked
// both — an inconsistency between two trees this code treats as equally dangerous. The authority is Postgres, not a hand-maintained list: the
// original defect was not a mistake in the merge logic but eleven tables added
// over time without anyone revisiting it.
func cascadeChildren(t *testing.T, q *Queries, parent string) map[string]bool {
	t.Helper()
	rows, err := q.pool.Query(context.Background(), `
		SELECT DISTINCT c.conrelid::regclass::text
		FROM pg_constraint c
		WHERE c.contype = 'f'
		  AND c.confrelid = $1::regclass
		  AND c.confdeltype IN ('c','n')`, parent)
	if err != nil {
		t.Fatalf("list cascade children of %s: %v", parent, err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[table] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate: %v", err)
	}
	if len(out) == 0 {
		t.Fatalf("no cascade children found for %s — the query is wrong, not the schema", parent)
	}
	return out
}

// TestMergeMediaItemsCoversEveryCascadeChild is the drift guard. Adding a cascade
// child without an entry in mergeChildren fails here — and because the generic
// loop in MergeMediaItems is DRIVEN by mergeChildren, adding the entry actually
// handles the table. An earlier version used the list only as a cross-check, and
// a review defeated it in one line: add an entry, the test goes green, every row
// in the new table is still destroyed.
func TestMergeMediaItemsCoversEveryCascadeChild(t *testing.T) {
	q := requireIntegrationDB(t)
	schema := cascadeChildren(t, q, "media_items")

	listed := map[string]bool{}
	for _, m := range mergeChildren {
		if listed[m.table] {
			t.Errorf("%s appears twice in mergeChildren", m.table)
		}
		listed[m.table] = true
	}

	for table := range schema {
		if !listed[table] {
			t.Errorf("%s cascades from media_items but mergeChildren does not list it: every row in it is silently destroyed by a merge. Add an entry (which is also what makes the generic loop handle it) and give it a row in TestMergeMediaItemsPreservesUserDataOnEveryChild.", table)
		}
	}
	// The reverse: a stale entry means the list is no longer a reliable checklist.
	for table := range listed {
		if !schema[table] {
			t.Errorf("%s is listed in mergeChildren but is not a DIRECT ON DELETE CASCADE child of media_items — the list has gone stale (episode_files is the classic case: it cascades from tv_episodes)", table)
		}
	}
}

// The same guard for tv_episodes. Deleting a duplicate episode cascades some of
// its children away and NULLs others, so a new child of tv_episodes needs the
// same decision.
func TestMergeMediaItemsCoversEveryEpisodeChild(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	// Both CASCADE and SET NULL children matter: a SET NULL silently strips the
	// episode from a live watch party rather than removing the row.
	rows, err := q.pool.Query(ctx, `
		SELECT DISTINCT c.conrelid::regclass::text, c.confdeltype::text, a.attname::text
		FROM pg_constraint c
		JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
		WHERE c.contype = 'f' AND c.confrelid = 'tv_episodes'::regclass
		  AND c.confdeltype IN ('c','n')`)
	if err != nil {
		t.Fatalf("list episode children: %v", err)
	}
	defer rows.Close()
	schema := map[string]string{}
	fkCol := map[string]string{}
	for rows.Next() {
		var table, del, col string
		if err := rows.Scan(&table, &del, &col); err != nil {
			t.Fatalf("scan: %v", err)
		}
		schema[table] = del
		fkCol[table] = col
	}
	if len(schema) == 0 {
		t.Fatal("no tv_episodes children found — the query is wrong, not the schema")
	}

	listed := map[string]bool{}
	for _, m := range mergeEpisodeChildren {
		listed[m.table] = true
	}
	for table, del := range schema {
		if !listed[table] {
			action := "destroyed (ON DELETE CASCADE)"
			if del == "n" {
				action = "silently stripped of its episode (ON DELETE SET NULL)"
			}
			t.Errorf("%s references tv_episodes but mergeEpisodeChildren does not list it: on an episode collision its rows are %s. Decide and add an entry.", table, action)
		}
	}
	for table := range listed {
		if _, ok := schema[table]; !ok {
			t.Errorf("%s is listed in mergeEpisodeChildren but no longer references tv_episodes with CASCADE/SET NULL — stale entry", table)
		}
	}
	// The referencing column is NOT uniform: most tables use episode_id, the
	// recap tables use up_to_episode_id. Assuming otherwise produced a runtime
	// "column episode_id does not exist", so pin each declaration to the real FK.
	for _, m := range mergeEpisodeChildren {
		want, ok := fkCol[m.table]
		if !ok {
			continue
		}
		if m.episodeCol == "" {
			t.Errorf("%s declares no episodeCol; its foreign key is on %s", m.table, want)
			continue
		}
		if m.episodeCol != want {
			t.Errorf("%s declares episodeCol %q but its foreign key to tv_episodes is on %q — the UPDATE would fail at runtime", m.table, m.episodeCol, want)
		}
	}
}

// TestMergeMediaItemsKeyColumnsMatchTheSchema guards the subtler half, and reads
// the PRODUCTION list rather than a copy of it — an earlier version transcribed
// the keys into the test, so mutating production alone left it green.
//
// The collision check must compare the FULL unique key minus media_item_id. A
// PARTIAL key does not error, it silently drops rows: with only {"surface"} for
// recently_surfaced_items, a duplicate's row for profile 1 "collides" with a
// canonical row for profile 2 on the same surface and is deleted. The same
// mistake sat on watch_progress, whose unique indexes are PARTIAL — which is why
// this test must not filter them out, as an earlier version's `indpred IS NULL`
// did, excluding precisely the table with the bug.
func TestMergeMediaItemsKeyColumnsMatchTheSchema(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	for _, m := range mergeChildren {
		t.Run(m.table, func(t *testing.T) {
			rows, err := q.pool.Query(ctx, `
				SELECT COALESCE(array_agg(a.attname::text ORDER BY a.attname), '{}'),
				       COALESCE(pg_get_expr(i.indpred, i.indrelid), '')
				FROM pg_index i
				JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
				WHERE i.indisunique
				  AND i.indrelid = $1::regclass
				  AND EXISTS (
				    SELECT 1 FROM pg_attribute m
				    WHERE m.attrelid = i.indrelid AND m.attnum = ANY(i.indkey)
				      AND m.attname = 'media_item_id')
				GROUP BY i.indexrelid, i.indpred, i.indrelid`, m.table)
			if err != nil {
				t.Fatalf("read unique indexes: %v", err)
			}
			type schemaKey struct {
				cols      []string
				predicate string
			}
			var keys []schemaKey
			for rows.Next() {
				var cols []string
				var pred string
				if err := rows.Scan(&cols, &pred); err != nil {
					t.Fatalf("scan: %v", err)
				}
				var others []string
				for _, c := range cols {
					if c != "media_item_id" {
						others = append(others, c)
					}
				}
				sort.Strings(others)
				keys = append(keys, schemaKey{cols: others, predicate: pred})
			}
			rows.Close()

			if len(m.keyCols) == 0 {
				// Declared as "nothing can collide": the schema must agree, or the
				// generic loop's plain UPDATE will hit a unique violation.
				for _, k := range keys {
					if len(k.cols) > 0 {
						t.Errorf("declared with no keyCols (plain UPDATE) but the schema has a unique key on media_item_id + %v — the UPDATE would raise a unique violation and abort the merge", k.cols)
					}
				}
				return
			}

			if len(keys) == 0 {
				t.Errorf("declares keyCols %v but no unique index involves media_item_id, so the collision check is dead weight — it should move every row with a plain UPDATE instead (leave keyCols empty)", m.keyCols)
				return
			}
			want := append([]string(nil), m.keyCols...)
			sort.Strings(want)

			// Every matching index is checked, not just the first. An earlier
			// version returned on the first match, so a table with two
			// media_item_id-bearing unique keys — one of them partial — passed
			// while the loop's check covered only one of them.
			matched := 0
			distinct := map[string]bool{}
			for _, k := range keys {
				distinct[strings.Join(k.cols, ",")+" WHERE "+k.predicate] = true
				if !equalStrings(k.cols, want) {
					continue
				}
				matched++
				if k.predicate != "" && m.keyPredicate == "" {
					t.Errorf("matches the PARTIAL unique index on media_item_id + %v WHERE %s, but declares no keyPredicate", k.cols, k.predicate)
				}
			}
			if len(distinct) > 1 {
				var got []string
				for d := range distinct {
					got = append(got, d)
				}
				sort.Strings(got)
				t.Errorf("has %d distinct unique keys involving media_item_id (%v). keyCols names ONE of them, so the generic collision check covers one and a collision on any other raises a unique violation that aborts the whole merge. Handle the table bespoke.", len(distinct), got)
			}
			if matched == 0 {
				var got [][]string
				for _, k := range keys {
					got = append(got, k.cols)
				}
				t.Errorf("compares %v, but the schema's unique key(s) minus media_item_id are %v. A partial key does not error — it silently drops rows belonging to another profile or parent.", want, got)
			}
		})
	}
}

// The behavioural test: every table a merge is supposed to preserve is populated
// on the duplicate, the merge runs, and the rows must be on the canonical
// afterwards. Before the fix, eleven of these went to zero.
func TestMergeMediaItemsPreservesUserDataOnEveryChild(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	mkItem := func(title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	canonical := mkItem("Canonical " + sfx)
	duplicate := mkItem("Duplicate " + sfx)

	var profileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
		 VALUES ($1,'merge-probe',TRUE,'en','off') RETURNING id`, ownerID).Scan(&profileID); err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	// Parents for the rows whose unique key involves something other than a profile.
	var watchlistID, collectionID, seasonID, episodeID, slateID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO watchlists (profile_id, name) VALUES ($1,'List '||$2) RETURNING id`,
		profileID, sfx).Scan(&watchlistID); err != nil {
		t.Fatalf("insert watchlist: %v", err)
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO collections (owner_user_id, name) VALUES ($1, 'Coll '||$2) RETURNING id`,
		ownerID, sfx).Scan(&collectionID); err != nil {
		t.Fatalf("insert collection: %v", err)
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1, 1) RETURNING id`,
		duplicate).Scan(&seasonID); err != nil {
		t.Fatalf("insert season: %v", err)
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1,$2,1) RETURNING id`,
		seasonID, duplicate).Scan(&episodeID); err != nil {
		t.Fatalf("insert episode: %v", err)
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO recommendation_slates (profile_id, surface, slate_token)
		 VALUES ($1,'hero','tok-'||$2) RETURNING id`, profileID, sfx).Scan(&slateID); err != nil {
		t.Fatalf("insert slate: %v", err)
	}

	// One row per preserved child, all on the DUPLICATE.
	seed := []struct {
		table string
		sql   string
		args  []any
	}{
		{"watchlist_items", `INSERT INTO watchlist_items (watchlist_id, media_item_id) VALUES ($1,$2)`, []any{watchlistID, duplicate}},
		{"collection_items", `INSERT INTO collection_items (collection_id, media_item_id, position) VALUES ($1,$2,1)`, []any{collectionID, duplicate}},
		{"user_ratings", `INSERT INTO user_ratings (profile_id, media_item_id, stars) VALUES ($1,$2,5)`, []any{profileID, duplicate}},
		{"taste_seeds", `INSERT INTO taste_seeds (profile_id, media_item_id, source) VALUES ($1,$2,'onboarding')`, []any{profileID, duplicate}},
		{"item_feedback", `INSERT INTO item_feedback (profile_id, media_item_id, feedback) VALUES ($1,$2,'up')`, []any{profileID, duplicate}},
		{"recap_conversations", `INSERT INTO recap_conversations (profile_id, media_item_id, generation_epoch) VALUES ($1,$2,1)`, []any{profileID, duplicate}},
		{"recently_surfaced_items", `INSERT INTO recently_surfaced_items (profile_id, media_item_id, surface) VALUES ($1,$2,'hero')`, []any{profileID, duplicate}},
		{"episode_recaps", `INSERT INTO episode_recaps (media_item_id, up_to_episode_id, recap, model, source_hash, suggested_questions) VALUES ($1,$2,'r','m','h','[]'::jsonb)`, []any{duplicate, episodeID}},
		{"watch_parties", `INSERT INTO watch_parties (party_code, host_user_id, media_item_id, party_name, media_title, media_poster) VALUES (left($3,6),$1,$2,'p','t','')`, []any{ownerID, duplicate, sfx}},
		{"recommendation_impressions", `INSERT INTO recommendation_impressions (slate_id, profile_id, media_item_id, position, match, confidence, model_version, similarity, evidence) VALUES ($1,$2,$3,1,50,0.5,'test',0.5,1)`, []any{slateID, profileID, duplicate}},
		{"recommendation_watch_events", `INSERT INTO recommendation_watch_events (profile_id, media_item_id, event_type, progress) VALUES ($1,$2,'started',0.1)`, []any{profileID, duplicate}},
		{"watch_progress", `INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms) VALUES ($1,$2,$3,10000,100000)`, []any{ownerID, profileID, duplicate}},

		// The bespoke children — the ones the hand-written walk handles — are
		// seeded too. They used to be skipped, and a review showed exactly what
		// that cost: adding `{table: "anything", bespoke: true}` with NO
		// hand-written code passed all three guards while a merge destroyed every
		// row in it. The drift guard proved membership, the key guard proved the
		// schema agreed, and the behavioural guard skipped it — the same
		// "classification without handling" defect this commit's own message says
		// was already killed once, coming back through the bespoke door. Seeding
		// them closes it structurally: an entry with no working code now fails
		// here, bespoke or not.
		{"media_files", `INSERT INTO media_files (media_item_id, path, file_hash) VALUES ($1,'/tmp/merge-'||$2||'.mkv','h')`, []any{duplicate, sfx}},
		{"artwork", `INSERT INTO artwork (media_item_id, art_type, source, remote_path) VALUES ($1,'poster','tmdb','/p-'||$2||'.jpg')`, []any{duplicate, sfx}},
		{"external_ids", `INSERT INTO external_ids (media_item_id, provider, external_id) VALUES ($1,'imdb','tt'||$2)`, []any{duplicate, sfx}},
	}
	// tv_seasons and tv_episodes already have exactly one row each on the
	// duplicate, created for the episode_recaps fixture above; they are asserted
	// through alsoAssert rather than seeded a second time.
	alsoAssert := []string{"tv_seasons", "tv_episodes"}

	var personID, genreID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO people (name) VALUES ('Merge Probe '||$1) RETURNING id`, sfx).Scan(&personID); err != nil {
		t.Fatalf("seed person: %v", err)
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO genres (name) VALUES ('MergeProbe'||$1) RETURNING id`, sfx).Scan(&genreID); err != nil {
		t.Fatalf("seed genre: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM people WHERE id=$1`, personID)
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM genres WHERE id=$1`, genreID)
	})
	seed = append(seed,
		struct {
			table string
			sql   string
			args  []any
		}{"media_cast", `INSERT INTO media_cast (media_item_id, person_id, role_type, character) VALUES ($1,$2,'cast','Probe')`, []any{duplicate, personID}},
		struct {
			table string
			sql   string
			args  []any
		}{"media_genres", `INSERT INTO media_genres (media_item_id, genre_id) VALUES ($1,$2)`, []any{duplicate, genreID}},
	)
	// Phase 1: everything except the rows that need a just-created parent.
	for _, s := range seed {
		if s.table == "media_cast" || s.table == "media_genres" {
			continue
		}
		if _, err := q.pool.Exec(ctx, s.sql, s.args...); err != nil {
			t.Fatalf("seed %s: %v", s.table, err)
		}
	}
	// Phase 2: the dependents, now that people/genres exist.
	for _, s := range seed {
		if s.table != "media_cast" && s.table != "media_genres" {
			continue
		}
		if _, err := q.pool.Exec(ctx, s.sql, s.args...); err != nil {
			t.Fatalf("seed %s: %v", s.table, err)
		}
	}

	count := func(table string, itemID int64) int {
		t.Helper()
		var n int
		if err := q.pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM `+table+` WHERE media_item_id = $1`, itemID).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		return n
	}
	assertTables := make([]string, 0, len(seed)+len(alsoAssert))
	for _, s := range seed {
		assertTables = append(assertTables, s.table)
	}
	assertTables = append(assertTables, alsoAssert...)
	for _, table := range assertTables {
		if got := count(table, duplicate); got != 1 {
			t.Fatalf("precondition: %s has %d rows on the duplicate, want 1", table, got)
		}
	}

	// Coverage is derived from the production list, not hand-maintained: adding a
	// table to mergeChildren without giving it a row here fails. Without this, the
	// cheapest way to green a failing drift guard is to add an entry and write no
	// test for it.
	seeded := map[string]bool{}
	for _, table := range assertTables {
		seeded[table] = true
	}
	for _, m := range mergeChildren {
		if !seeded[m.table] {
			t.Errorf("mergeChildren lists %s but this test seeds no row for it, so nothing proves a merge preserves it", m.table)
		}
	}

	if err := q.MergeMediaItems(ctx, canonical, duplicate); err != nil {
		t.Fatalf("merge: %v", err)
	}

	for _, table := range assertTables {
		if got := count(table, canonical); got != 1 {
			t.Errorf("%s: %d rows on the canonical after the merge, want 1 — the merge destroyed a row it was supposed to re-parent", table, got)
		}
		if got := count(table, duplicate); got != 0 {
			t.Errorf("%s: %d rows still reference the deleted duplicate", table, got)
		}
	}

	var stillThere bool
	if err := q.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM media_items WHERE id = $1)`, duplicate).Scan(&stillThere); err != nil {
		t.Fatalf("check dup: %v", err)
	}
	if stillThere {
		t.Error("the duplicate media item survived the merge")
	}
}

// A collision must cost the DUPLICATE's row, never the canonical's, and never a
// third party's. The second half is the one a partial key list gets wrong: a
// second profile's row on the same surface is not a collision and must survive.
func TestMergeMediaItemsCollisionKeepsCanonicalAndSparesOtherProfiles(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	mkItem := func(title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	canonical := mkItem("Collide Canonical " + sfx)
	duplicate := mkItem("Collide Duplicate " + sfx)

	mkProfile := func(name string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
			 VALUES ($1,$2,FALSE,'en','off') RETURNING id`, ownerID, name).Scan(&id); err != nil {
			t.Fatalf("insert profile: %v", err)
		}
		return id
	}
	p1 := mkProfile("p1-" + sfx)
	p2 := mkProfile("p2-" + sfx)

	// p1 rated both items: a real collision. p2 rated only the duplicate.
	for _, r := range []struct {
		profile int64
		item    int64
		stars   int
	}{
		{p1, canonical, 4},
		{p1, duplicate, 1},
		{p2, duplicate, 3},
	} {
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO user_ratings (profile_id, media_item_id, stars) VALUES ($1,$2,$3)`,
			r.profile, r.item, r.stars); err != nil {
			t.Fatalf("seed rating: %v", err)
		}
	}
	// Same shape on the three-column key, where a partial key list silently
	// drops the other profile's row.
	for _, s := range []struct {
		profile int64
		item    int64
		surface string
	}{
		{p1, canonical, "hero"},
		{p1, duplicate, "hero"},
		{p2, duplicate, "hero"},
	} {
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO recently_surfaced_items (profile_id, media_item_id, surface) VALUES ($1,$2,$3)`,
			s.profile, s.item, s.surface); err != nil {
			t.Fatalf("seed surfaced: %v", err)
		}
	}

	if err := q.MergeMediaItems(ctx, canonical, duplicate); err != nil {
		t.Fatalf("merge: %v", err)
	}

	var stars int
	if err := q.pool.QueryRow(ctx,
		`SELECT stars FROM user_ratings WHERE profile_id=$1 AND media_item_id=$2`, p1, canonical).Scan(&stars); err != nil {
		t.Fatalf("read p1 rating: %v", err)
	}
	if stars != 4 {
		t.Errorf("p1's rating on the canonical is %d, want the canonical's own 4 — a collision must cost the duplicate's row, not the canonical's", stars)
	}
	var p2Count int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM user_ratings WHERE profile_id=$1 AND media_item_id=$2`, p2, canonical).Scan(&p2Count); err != nil {
		t.Fatalf("read p2 rating: %v", err)
	}
	if p2Count != 1 {
		t.Errorf("p2's rating was lost (%d rows on the canonical) — it did not collide with anything", p2Count)
	}
	var p2Surfaced int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recently_surfaced_items WHERE profile_id=$1 AND media_item_id=$2 AND surface='hero'`,
		p2, canonical).Scan(&p2Surfaced); err != nil {
		t.Fatalf("read p2 surfaced: %v", err)
	}
	if p2Surfaced != 1 {
		t.Errorf("p2's recently_surfaced row was lost (%d rows) — the collision check compared only part of the (profile_id, media_item_id, surface) key", p2Surfaced)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// H1: watch_progress's unique indexes are PARTIAL and include profile_id, so
// comparing user_id alone judged a SIBLING PROFILE's progress a collision and the
// following DELETE destroyed it. On one account: the adult has progress on the
// canonical, the kid has progress on the duplicate, and the kid's is silently
// lost. Both the item-level and the episode-level paths had it.
func TestMergeMediaItemsKeepsEveryProfilesWatchProgress(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	mkItem := func(title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	canonical := mkItem("WP Canonical " + sfx)
	duplicate := mkItem("WP Duplicate " + sfx)

	mkProfile := func(name string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
			 VALUES ($1,$2,FALSE,'en','off') RETURNING id`, ownerID, name).Scan(&id); err != nil {
			t.Fatalf("insert profile: %v", err)
		}
		return id
	}
	adult := mkProfile("adult-" + sfx)
	kid := mkProfile("kid-" + sfx)

	// Episode rows on both items, same season/episode number, so the episode
	// collision path runs.
	mkEpisode := func(itemID int64) int64 {
		var seasonID, epID int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1,1) RETURNING id`, itemID).Scan(&seasonID); err != nil {
			t.Fatalf("insert season: %v", err)
		}
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1,$2,1) RETURNING id`,
			seasonID, itemID).Scan(&epID); err != nil {
			t.Fatalf("insert episode: %v", err)
		}
		return epID
	}
	canonEp := mkEpisode(canonical)
	dupEp := mkEpisode(duplicate)

	addProgress := func(profile, itemID int64, epID *int64, posMs int) {
		t.Helper()
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO watch_progress (user_id, profile_id, media_item_id, episode_id, position_ms, duration_ms)
			 VALUES ($1,$2,$3,$4,$5,100000)`, ownerID, profile, itemID, epID, posMs); err != nil {
			t.Fatalf("insert watch_progress: %v", err)
		}
	}
	// Item level: adult on canonical (a real collision), kid only on duplicate.
	addProgress(adult, canonical, nil, 1000)
	addProgress(adult, duplicate, nil, 2000)
	addProgress(kid, duplicate, nil, 3000)
	// Episode level: same shape.
	addProgress(adult, canonical, &canonEp, 4000)
	addProgress(adult, duplicate, &dupEp, 5000)
	addProgress(kid, duplicate, &dupEp, 6000)

	if err := q.MergeMediaItems(ctx, canonical, duplicate); err != nil {
		t.Fatalf("merge: %v", err)
	}

	pos := func(profile int64, epID *int64) (int, bool) {
		t.Helper()
		var p int
		var err error
		if epID == nil {
			err = q.pool.QueryRow(ctx,
				`SELECT position_ms FROM watch_progress
				 WHERE profile_id=$1 AND media_item_id=$2 AND episode_id IS NULL`, profile, canonical).Scan(&p)
		} else {
			err = q.pool.QueryRow(ctx,
				`SELECT position_ms FROM watch_progress WHERE profile_id=$1 AND episode_id=$2`, profile, *epID).Scan(&p)
		}
		if err != nil {
			return 0, false
		}
		return p, true
	}

	if p, ok := pos(kid, nil); !ok {
		t.Error("the kid profile's item-level watch progress was destroyed by the merge — it never collided with anything; the collision check compared user_id without profile_id")
	} else if p != 3000 {
		t.Errorf("kid item progress = %d, want the duplicate's 3000 moved across", p)
	}
	if p, ok := pos(kid, &canonEp); !ok {
		t.Error("the kid profile's episode-level watch progress was destroyed by the merge — the episode path had the same partial key")
	} else if p != 6000 {
		t.Errorf("kid episode progress = %d, want the duplicate's 6000 moved across", p)
	}
	// And the canonical's own rows still win their genuine collisions.
	if p, ok := pos(adult, nil); !ok || p != 1000 {
		t.Errorf("adult item progress = %d (found=%v), want the canonical's own 1000", p, ok)
	}
	if p, ok := pos(adult, &canonEp); !ok || p != 4000 {
		t.Errorf("adult episode progress = %d (found=%v), want the canonical's own 4000", p, ok)
	}
}

// M3/M4: deleting a colliding duplicate episode cascades some of its children
// away and NULLs others. recommendation_watch_events vanished; watch_parties and
// recap_conversation_turns silently lost which episode they referred to — and an
// active party then reads as a show with no episode, which
// internal/watchparty/rehydrate.go reloads pointing at nothing after a restart.
func TestMergeMediaItemsRepointsEpisodeChildrenOnCollision(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	mkItem := func(title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	canonical := mkItem("Ep Canonical " + sfx)
	duplicate := mkItem("Ep Duplicate " + sfx)

	mkEpisode := func(itemID int64) int64 {
		var seasonID, epID int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1,1) RETURNING id`, itemID).Scan(&seasonID); err != nil {
			t.Fatalf("insert season: %v", err)
		}
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1,$2,1) RETURNING id`,
			seasonID, itemID).Scan(&epID); err != nil {
			t.Fatalf("insert episode: %v", err)
		}
		return epID
	}
	canonEp := mkEpisode(canonical)
	dupEp := mkEpisode(duplicate)

	var profileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
		 VALUES ($1,'ep-probe',TRUE,'en','off') RETURNING id`, ownerID).Scan(&profileID); err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	if _, err := q.pool.Exec(ctx,
		`INSERT INTO recommendation_watch_events (profile_id, media_item_id, episode_id, event_type, progress)
		 VALUES ($1,$2,$3,'started',0.1)`, profileID, duplicate, dupEp); err != nil {
		t.Fatalf("seed watch event: %v", err)
	}
	var partyID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO watch_parties (party_code, host_user_id, media_item_id, episode_id, party_name, media_title, media_poster, is_active)
		 VALUES (left($4,6),$1,$2,$3,'p','t','',TRUE) RETURNING id`,
		ownerID, duplicate, dupEp, sfx).Scan(&partyID); err != nil {
		t.Fatalf("seed party: %v", err)
	}
	var convID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO recap_conversations (profile_id, media_item_id, generation_epoch) VALUES ($1,$2,1) RETURNING id`,
		profileID, duplicate).Scan(&convID); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO recap_conversation_turns
		   (conversation_id, request_id, question, answer, up_to_episode_id,
		    boundary_season, boundary_episode, boundary_title, grounding_mode)
		 VALUES ($1,gen_random_uuid(),'q','a',$2,1,1,'t','grounded')`, convID, dupEp); err != nil {
		t.Fatalf("seed turn: %v", err)
	}

	if err := q.MergeMediaItems(ctx, canonical, duplicate); err != nil {
		t.Fatalf("merge: %v", err)
	}

	var events int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recommendation_watch_events WHERE episode_id = $1`, canonEp).Scan(&events); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if events != 1 {
		t.Errorf("recommendation_watch_events on the canonical episode = %d, want 1 — the row was cascade-deleted with the duplicate episode", events)
	}

	var partyEp *int64
	var active bool
	if err := q.pool.QueryRow(ctx,
		`SELECT episode_id, is_active FROM watch_parties WHERE id = $1`, partyID).Scan(&partyEp, &active); err != nil {
		t.Fatalf("read party: %v", err)
	}
	if partyEp == nil {
		t.Error("the live watch party's episode_id was set to NULL — an active room for a show with no episode, which rehydrate.go reloads pointing at nothing")
	} else if *partyEp != canonEp {
		t.Errorf("party episode_id = %d, want the canonical episode %d", *partyEp, canonEp)
	}

	var turnEp *int64
	if err := q.pool.QueryRow(ctx,
		`SELECT up_to_episode_id FROM recap_conversation_turns WHERE conversation_id = (
		   SELECT id FROM recap_conversations WHERE media_item_id = $1 AND profile_id = $2)`,
		canonical, profileID).Scan(&turnEp); err != nil {
		t.Fatalf("read turn: %v", err)
	}
	if turnEp == nil {
		t.Error("the recap turn's up_to_episode_id was set to NULL — it no longer records which episode it was about")
	} else if *turnEp != canonEp {
		t.Errorf("turn up_to_episode_id = %d, want the canonical episode %d", *turnEp, canonEp)
	}
}

// M5: recap_conversations is not a per-profile opinion like a rating — it OWNS
// recap_conversation_turns and _requests. "Canonical wins" therefore destroyed a
// person's whole Q&A thread whenever the surviving conversation was the empty one.
func TestMergeMediaItemsKeepsTheRecapThreadOnCollision(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	mkItem := func(title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	canonical := mkItem("Recap Canonical " + sfx)
	duplicate := mkItem("Recap Duplicate " + sfx)

	var profileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
		 VALUES ($1,'recap-probe',TRUE,'en','off') RETURNING id`, ownerID).Scan(&profileID); err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	mkConv := func(itemID int64) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO recap_conversations (profile_id, media_item_id, generation_epoch) VALUES ($1,$2,1) RETURNING id`,
			profileID, itemID).Scan(&id); err != nil {
			t.Fatalf("insert conversation: %v", err)
		}
		return id
	}
	// The canonical's conversation is EMPTY; the duplicate's holds the thread.
	mkConv(canonical)
	dupConv := mkConv(duplicate)
	for i := 0; i < 3; i++ {
		var reqID string
		if err := q.pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&reqID); err != nil {
			t.Fatalf("uuid: %v", err)
		}
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO recap_conversation_turns
			   (conversation_id, request_id, question, answer,
			    boundary_season, boundary_episode, boundary_title, grounding_mode)
			 VALUES ($1,$2::uuid,$3,'a',1,1,'t','grounded')`, dupConv, reqID, "q"+string(rune('1'+i))); err != nil {
			t.Fatalf("insert turn: %v", err)
		}
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO recap_conversation_requests (conversation_id, request_id, question_hash, conversation_epoch, status)
			 VALUES ($1,$2::uuid,repeat('a',64),1,'completed')`, dupConv, reqID); err != nil {
			t.Fatalf("insert request: %v", err)
		}
	}

	if err := q.MergeMediaItems(ctx, canonical, duplicate); err != nil {
		t.Fatalf("merge: %v", err)
	}

	var turns, requests int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recap_conversation_turns t
		   JOIN recap_conversations c ON c.id = t.conversation_id
		 WHERE c.media_item_id = $1 AND c.profile_id = $2`, canonical, profileID).Scan(&turns); err != nil {
		t.Fatalf("count turns: %v", err)
	}
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recap_conversation_requests r
		   JOIN recap_conversations c ON c.id = r.conversation_id
		 WHERE c.media_item_id = $1 AND c.profile_id = $2`, canonical, profileID).Scan(&requests); err != nil {
		t.Fatalf("count requests: %v", err)
	}
	if turns != 3 {
		t.Errorf("%d recap turns survived on the canonical, want 3 — the person's whole Q&A thread was destroyed because the surviving conversation was the empty one", turns)
	}
	if requests != 3 {
		t.Errorf("%d recap requests survived on the canonical, want 3", requests)
	}
}

// L3: a self-merge must be a no-op. Without the guard it is strictly
// destructive — every collision check matches the row against ITSELF, so nothing
// moves and the DELETEs then strip the item's own watchlist entries, ratings,
// feedback, taste seeds and recaps before the final DELETE removes the item too.
// The only production caller cannot do this (findCanonicalItem excludes the row
// by id), which is exactly why the guard is worth pinning rather than trusting.
func TestMergeMediaItemsSelfMergeIsANoOp(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	var itemID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
		 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, "Self Merge "+sfx).Scan(&itemID); err != nil {
		t.Fatalf("insert item: %v", err)
	}
	var profileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
		 VALUES ($1,'self-probe',TRUE,'en','off') RETURNING id`, ownerID).Scan(&profileID); err != nil {
		t.Fatalf("insert profile: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO user_ratings (profile_id, media_item_id, stars) VALUES ($1,$2,5)`, profileID, itemID); err != nil {
		t.Fatalf("seed rating: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO item_feedback (profile_id, media_item_id, feedback) VALUES ($1,$2,'up')`, profileID, itemID); err != nil {
		t.Fatalf("seed feedback: %v", err)
	}

	if err := q.MergeMediaItems(ctx, itemID, itemID); err != nil {
		t.Fatalf("self-merge returned an error: %v", err)
	}

	var exists bool
	if err := q.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM media_items WHERE id=$1)`, itemID).Scan(&exists); err != nil {
		t.Fatalf("check item: %v", err)
	}
	if !exists {
		t.Fatal("a self-merge DELETED the item")
	}
	for _, table := range []string{"user_ratings", "item_feedback"} {
		var n int
		if err := q.pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM `+table+` WHERE media_item_id=$1`, itemID).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if n != 1 {
			t.Errorf("a self-merge destroyed the item's own %s row (%d rows left)", table, n)
		}
	}
}

// HIGH-1 from the round-4 review: keyPredicate was declared, schema-validated,
// and never applied in the generated SQL. A reviewer registered a new child with
// two disjoint PARTIAL unique indexes, declared keyCols and keyPredicate exactly
// as the doc comments instruct, and watched the merge delete a second profile's
// row that was never a genuine collision — the watch_progress bug reintroduced
// for any future non-bespoke partial-keyed table. It was inert only because both
// predicate-bearing entries happen to be bespoke.
//
// The generic loops now REFUSE that shape. This pins both halves: the shipped
// lists are honourable, and the refusal actually fires.
func TestMergeChildrenSpecIsHonourable(t *testing.T) {
	if err := mergeChildStrategyError(mergeChildren, mergeEpisodeChildren); err != nil {
		t.Errorf("the shipped merge spec is not honourable: %v", err)
	}
	bad := []mergeChildStrategy{
		{table: "probe", keyCols: []string{"profile_id"}, keyPredicate: "flag IS TRUE"},
	}
	if err := mergeChildStrategyError(bad); err == nil {
		t.Error("a non-bespoke entry declaring a keyPredicate was accepted — the generic loop ignores predicates, so its collision check would delete rows the partial index does not cover")
	}
	// A bespoke entry may carry one: its SQL is hand-written and encodes the
	// condition itself.
	ok := []mergeChildStrategy{
		{table: "probe", keyCols: []string{"profile_id"}, keyPredicate: "flag IS TRUE", bespoke: true},
	}
	if err := mergeChildStrategyError(ok); err != nil {
		t.Errorf("a bespoke entry with a keyPredicate was refused: %v", err)
	}
}

// MEDIUM-4: mergeEpisodeChildren had no analogue of the media_items key guard, so
// a wrong or partial keyCols on the tv_episodes path would reach production
// unchecked — the same class of mistake that motivated the other guard.
func TestMergeEpisodeChildrenKeyColumnsMatchTheSchema(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	for _, m := range mergeEpisodeChildren {
		t.Run(m.table, func(t *testing.T) {
			if m.episodeCol == "" {
				t.Fatal("no episodeCol declared")
			}
			// Unique indexes on this table that involve the episode column.
			rows, err := q.pool.Query(ctx, `
				SELECT COALESCE(array_agg(a.attname::text ORDER BY a.attname), '{}')
				FROM pg_index i
				JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
				WHERE i.indisunique AND i.indrelid = $1::regclass
				  AND EXISTS (
				    SELECT 1 FROM pg_attribute e
				    WHERE e.attrelid = i.indrelid AND e.attnum = ANY(i.indkey) AND e.attname = $2)
				GROUP BY i.indexrelid`, m.table, m.episodeCol)
			if err != nil {
				t.Fatalf("read unique indexes: %v", err)
			}
			var keys [][]string
			for rows.Next() {
				var cols []string
				if err := rows.Scan(&cols); err != nil {
					t.Fatalf("scan: %v", err)
				}
				var others []string
				for _, c := range cols {
					if c != m.episodeCol {
						others = append(others, c)
					}
				}
				sort.Strings(others)
				keys = append(keys, others)
			}
			rows.Close()

			if len(m.keyCols) == 0 {
				// Declared as "plain UPDATE". Prove the re-point cannot collide:
				// either no unique index involves the episode column at all, or
				// the row the UPDATE would create is necessarily free. Only
				// episode_recaps is in the latter case, and its reasoning is
				// recorded beside its entry.
				if len(keys) > 0 && m.table != "episode_recaps" {
					t.Errorf("declared with no keyCols but a unique index involves %s (%v) — the plain UPDATE could raise a unique violation and abort the merge", m.episodeCol, keys)
				}
				return
			}
			want := append([]string(nil), m.keyCols...)
			sort.Strings(want)
			for _, k := range keys {
				if equalStrings(k, want) {
					return
				}
			}
			t.Errorf("compares %v, but the schema's unique key(s) minus %s are %v — a partial key silently drops rows belonging to another profile or parent", want, m.episodeCol, keys)
		})
	}
}

// HIGH-2: the episode-level collision check for episode_recaps compared the row
// against its OWN media_item_id (still the duplicate's at that point), so it
// could never detect a collision. The outcome was nonetheless correct, but only
// via an accidental two-stage interaction with the later mergeChildren pass —
// and nothing pinned it, so a plausible "fix" to either pass could break it
// silently. episode_recaps is now an explicit plain UPDATE; this is the case
// that proves the two passes still compose.
func TestMergeMediaItemsResolvesCollidingEpisodeRecaps(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	mkItem := func(title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	canonical := mkItem("Recap Collide Canonical " + sfx)
	duplicate := mkItem("Recap Collide Duplicate " + sfx)

	mkEpisode := func(itemID int64) int64 {
		var seasonID, epID int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1,1) RETURNING id`, itemID).Scan(&seasonID); err != nil {
			t.Fatalf("insert season: %v", err)
		}
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1,$2,1) RETURNING id`,
			seasonID, itemID).Scan(&epID); err != nil {
			t.Fatalf("insert episode: %v", err)
		}
		return epID
	}
	canonEp := mkEpisode(canonical)
	dupEp := mkEpisode(duplicate)

	// A recap on BOTH sides for the same logical episode — the collision the
	// no-op check could never see.
	addRecap := func(itemID, epID int64, text string) {
		t.Helper()
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO episode_recaps (media_item_id, up_to_episode_id, recap, model, source_hash, suggested_questions)
			 VALUES ($1,$2,$3,'m','h','[]'::jsonb)`, itemID, epID, text); err != nil {
			t.Fatalf("insert recap: %v", err)
		}
	}
	addRecap(canonical, canonEp, "canonical recap")
	addRecap(duplicate, dupEp, "duplicate recap")

	if err := q.MergeMediaItems(ctx, canonical, duplicate); err != nil {
		t.Fatalf("merge: %v", err)
	}

	var n int
	var text string
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM episode_recaps WHERE media_item_id = $1`, canonical).Scan(&n); err != nil {
		t.Fatalf("count recaps: %v", err)
	}
	if n != 1 {
		t.Fatalf("%d recaps on the canonical after the merge, want exactly 1 (its own, the duplicate's dropped as a collision)", n)
	}
	if err := q.pool.QueryRow(ctx,
		`SELECT recap FROM episode_recaps WHERE media_item_id = $1`, canonical).Scan(&text); err != nil {
		t.Fatalf("read recap: %v", err)
	}
	if text != "canonical recap" {
		t.Errorf("surviving recap is %q, want the canonical's own — a collision must cost the duplicate's row", text)
	}
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM episode_recaps WHERE up_to_episode_id = $1`, dupEp).Scan(&n); err != nil {
		t.Fatalf("count dangling: %v", err)
	}
	if n != 0 {
		t.Errorf("%d recaps still point at the deleted duplicate episode", n)
	}
}

// Third-party sparing, for every generic collision-checked child that did not
// already have its own case.
//
// A round-5 review noted that only user_ratings and recently_surfaced_items were
// covered behaviourally; the rest shared the same generic loop and were verified
// only structurally. Given the two partial-key bugs found in this function were
// both "an unrelated party's row treated as a collision and deleted", proving
// that property per table is worth the lines. episode_recaps and
// recap_conversations have their own dedicated collision tests
// (TestMergeMediaItemsResolvesCollidingEpisodeRecaps,
// TestMergeMediaItemsKeepsTheRecapThreadOnCollision); watch_progress has
// TestMergeMediaItemsKeepsEveryProfilesWatchProgress. This covers the remainder.
//
// The shape per table: party A owns a row on BOTH items (a genuine collision),
// party B owns one on the duplicate only (not a collision). After the merge the
// canonical must hold one row per party — two. Under a partial key, B's row is
// judged a collision and deleted, leaving one.
func TestMergeMediaItemsCollisionSparesThirdPartiesOnEveryGenericChild(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	mkItem := func(title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	mkProfile := func(name string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
			 VALUES ($1,$2,FALSE,'en','off') RETURNING id`, ownerID, name).Scan(&id); err != nil {
			t.Fatalf("insert profile: %v", err)
		}
		return id
	}
	mkWatchlist := func(profileID int64, name string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO watchlists (profile_id, name) VALUES ($1,$2) RETURNING id`, profileID, name).Scan(&id); err != nil {
			t.Fatalf("insert watchlist: %v", err)
		}
		return id
	}
	mkCollection := func(name string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO collections (owner_user_id, name) VALUES ($1,$2) RETURNING id`, ownerID, name).Scan(&id); err != nil {
			t.Fatalf("insert collection: %v", err)
		}
		return id
	}

	cases := []struct {
		table string
		// insert puts one row for the given party on the given item.
		insert func(t *testing.T, itemID, partyID int64)
		partyA func(t *testing.T) int64
		partyB func(t *testing.T) int64
	}{
		{
			table: "watchlist_items",
			insert: func(t *testing.T, itemID, partyID int64) {
				if _, err := q.pool.Exec(ctx,
					`INSERT INTO watchlist_items (watchlist_id, media_item_id) VALUES ($1,$2)`, partyID, itemID); err != nil {
					t.Fatalf("insert watchlist_items: %v", err)
				}
			},
			partyA: func(t *testing.T) int64 { return mkWatchlist(mkProfile("wl-a-"+sfx), "A "+sfx) },
			partyB: func(t *testing.T) int64 { return mkWatchlist(mkProfile("wl-b-"+sfx), "B "+sfx) },
		},
		{
			table: "collection_items",
			insert: func(t *testing.T, itemID, partyID int64) {
				if _, err := q.pool.Exec(ctx,
					`INSERT INTO collection_items (collection_id, media_item_id, position) VALUES ($1,$2,1)`, partyID, itemID); err != nil {
					t.Fatalf("insert collection_items: %v", err)
				}
			},
			partyA: func(t *testing.T) int64 { return mkCollection("CollA " + sfx) },
			partyB: func(t *testing.T) int64 { return mkCollection("CollB " + sfx) },
		},
		{
			table: "item_feedback",
			insert: func(t *testing.T, itemID, partyID int64) {
				if _, err := q.pool.Exec(ctx,
					`INSERT INTO item_feedback (profile_id, media_item_id, feedback) VALUES ($1,$2,'up')`, partyID, itemID); err != nil {
					t.Fatalf("insert item_feedback: %v", err)
				}
			},
			partyA: func(t *testing.T) int64 { return mkProfile("fb-a-" + sfx) },
			partyB: func(t *testing.T) int64 { return mkProfile("fb-b-" + sfx) },
		},
		{
			table: "taste_seeds",
			insert: func(t *testing.T, itemID, partyID int64) {
				if _, err := q.pool.Exec(ctx,
					`INSERT INTO taste_seeds (profile_id, media_item_id, source) VALUES ($1,$2,'onboarding')`, partyID, itemID); err != nil {
					t.Fatalf("insert taste_seeds: %v", err)
				}
			},
			partyA: func(t *testing.T) int64 { return mkProfile("ts-a-" + sfx) },
			partyB: func(t *testing.T) int64 { return mkProfile("ts-b-" + sfx) },
		},
	}

	for _, tc := range cases {
		t.Run(tc.table, func(t *testing.T) {
			canonical := mkItem("Spare Canonical " + tc.table + " " + sfx)
			duplicate := mkItem("Spare Duplicate " + tc.table + " " + sfx)
			a := tc.partyA(t)
			b := tc.partyB(t)

			tc.insert(t, canonical, a) // party A on the canonical
			tc.insert(t, duplicate, a) // party A on the duplicate — a real collision
			tc.insert(t, duplicate, b) // party B on the duplicate only — NOT a collision

			if err := q.MergeMediaItems(ctx, canonical, duplicate); err != nil {
				t.Fatalf("merge: %v", err)
			}

			var n int
			if err := q.pool.QueryRow(ctx,
				`SELECT COUNT(*) FROM `+tc.table+` WHERE media_item_id = $1`, canonical).Scan(&n); err != nil {
				t.Fatalf("count: %v", err)
			}
			if n != 2 {
				t.Errorf("%d rows on the canonical, want 2 (party A's own, plus party B's moved across) — a partial collision key judges an unrelated party's row a collision and deletes it", n)
			}
			var dangling int
			if err := q.pool.QueryRow(ctx,
				`SELECT COUNT(*) FROM `+tc.table+` WHERE media_item_id = $1`, duplicate).Scan(&dangling); err != nil {
				t.Fatalf("count dangling: %v", err)
			}
			if dangling != 0 {
				t.Errorf("%d rows still reference the deleted duplicate", dangling)
			}
		})
	}

	// Structural cross-check: the name says "every generic child", so a new one
	// must not be able to appear with no third-party case. The behavioural test
	// derives its seed set from mergeChildren and so fails on a new entry
	// automatically; this test's case list is hand-written, so the coverage is
	// asserted instead. A child covered by a sibling test is recorded here with
	// which one — that is a decision, not a silence.
	coveredBySibling := map[string]string{
		"user_ratings":            "TestMergeMediaItemsCollisionKeepsCanonicalAndSparesOtherProfiles",
		"recently_surfaced_items": "TestMergeMediaItemsCollisionKeepsCanonicalAndSparesOtherProfiles",
		"episode_recaps":          "TestMergeMediaItemsResolvesCollidingEpisodeRecaps",
		"recap_conversations":     "TestMergeMediaItemsKeepsTheRecapThreadOnCollision",
	}
	here := map[string]bool{}
	for _, tc := range cases {
		here[tc.table] = true
	}
	for _, m := range mergeChildren {
		if m.bespoke || len(m.keyCols) == 0 {
			continue // no collision check to get wrong
		}
		if here[m.table] {
			continue
		}
		if _, ok := coveredBySibling[m.table]; ok {
			continue
		}
		t.Errorf("%s is collision-checked by the generic loop but no test proves the check spares a THIRD party's row. A partial collision key does not error — it decides an unrelated profile's or parent's row is a collision and deletes it. Add a case above, or record which sibling test covers it.", m.table)
	}
	for table, sibling := range coveredBySibling {
		if here[table] {
			t.Errorf("%s is recorded as covered by %s but also has a case here — drop one", table, sibling)
		}
	}
}

// TestMergeMediaItemsCoversEveryTvSeasonChild is the third drift guard, and it
// exists because the other two framed themselves as the complete set while the
// merge also DELETEs tv_seasons rows (`DELETE FROM tv_seasons WHERE id = $1`, on a
// duplicate season number the canonical already has).
//
// tv_seasons' only child today is tv_episodes, which the walk re-parents onto the
// surviving season before that DELETE — so the gap is currently inert. That is
// exactly the state media_items was in before the eleven later migrations: a
// season_artwork or season_recaps table would be cascade-destroyed by that DELETE
// with both other guards green, which is the drift this whole commit exists to
// stop. A new child here needs the same decision every other child got, so it
// fails until someone makes it.
func TestMergeMediaItemsCoversEveryTvSeasonChild(t *testing.T) {
	q := requireIntegrationDB(t)
	schema := cascadeChildren(t, q, "tv_seasons")

	// Handled by the bespoke season walk in MergeMediaItems: episodes on a
	// duplicate season are re-parented onto the canonical season (and their own
	// children re-pointed by repointEpisodeChildren) before the season is deleted.
	handled := map[string]string{
		"tv_episodes": "re-parented onto the surviving season by the bespoke walk",
	}
	for table := range schema {
		if _, ok := handled[table]; !ok {
			t.Errorf("%s cascades from tv_seasons but the merge's season walk does not handle it: `DELETE FROM tv_seasons` destroys every row in it when a duplicate season number collides. Decide what a merge owes it, handle it in the walk, and add it here with the reason.", table)
		}
	}
	for table := range handled {
		if !schema[table] {
			t.Errorf("%s is recorded here as a tv_seasons child but no longer cascades from it — stale entry", table)
		}
	}
}

// TestMergeRefusesAPartialKeyedGenericChild is the runtime half of the
// partial-key rule, and covers the case the static check cannot see.
//
// mergeChildStrategyError refuses an entry that DECLARES a keyPredicate without
// being bespoke. The adjacent case is the dangerous one: a partial unique index
// where the developer simply does not declare the predicate. The spec then looks
// complete, the generic loop builds its collision check from keyCols alone, and
// the merge deletes a duplicate row the index does not even cover — the
// watch_progress bug one door along. A review reproduced exactly that against
// live Postgres and MergeMediaItems returned nil while destroying the row.
//
// Partiality is a property of the schema, not of the list, so only the schema can
// answer. mergeChildPartialKeyError asks it on every merge; this test pins that
// it does, using the same probe shape the review used.
func TestMergeRefusesAPartialKeyedGenericChild(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	// A future child of media_items with a PARTIAL unique key, registered on the
	// generic path with no keyPredicate — the shape that used to pass.
	if _, err := q.pool.Exec(ctx, `
		CREATE TABLE zz_partial_key_probe (
			id BIGSERIAL PRIMARY KEY,
			media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
			profile_id BIGINT NOT NULL,
			archived BOOLEAN NOT NULL DEFAULT FALSE
		)`); err != nil {
		t.Fatalf("create probe table: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DROP TABLE IF EXISTS zz_partial_key_probe`)
	})
	if _, err := q.pool.Exec(ctx, `
		CREATE UNIQUE INDEX zz_partial_key_probe_uq
		ON zz_partial_key_probe (profile_id, media_item_id) WHERE archived = FALSE`); err != nil {
		t.Fatalf("create probe index: %v", err)
	}

	restore := mergeChildren
	mergeChildren = append(append([]mergeChildStrategy(nil), mergeChildren...),
		mergeChildStrategy{table: "zz_partial_key_probe", keyCols: []string{"profile_id"}, why: "probe"})
	t.Cleanup(func() { mergeChildren = restore })

	// The static check passes it — no keyPredicate is declared, so there is
	// nothing for it to object to. That is the gap.
	if err := mergeChildStrategyError(mergeChildren, mergeEpisodeChildren); err != nil {
		t.Fatalf("precondition: the static check was expected to pass an entry with no keyPredicate, got %v", err)
	}

	err := q.mergeChildPartialKeyError(ctx)
	if err == nil {
		t.Fatal("a generic-path child with a PARTIAL unique index over media_item_id was accepted: the collision check ignores the index's WHERE clause, so a duplicate row the index does not cover is deleted outright")
	}
	if !strings.Contains(err.Error(), "zz_partial_key_probe") {
		t.Errorf("error does not name the offending table: %v", err)
	}

	// And a merge must not proceed past it. Seeding rows is unnecessary — the
	// refusal happens before the transaction opens — but the caller's contract is
	// what matters: MergeMediaItems returns the error rather than deleting.
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)
	mkItem := func(title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	canonical := mkItem("Probe Canonical " + sfx)
	duplicate := mkItem("Probe Duplicate " + sfx)
	if err := q.MergeMediaItems(ctx, canonical, duplicate); err == nil {
		t.Error("MergeMediaItems ran with a partial-keyed generic child registered, want a refusal")
	}
	var alive int
	if err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM media_items WHERE id = $1`, duplicate).Scan(&alive); err != nil {
		t.Fatalf("count duplicate: %v", err)
	}
	if alive != 1 {
		t.Error("the duplicate was deleted despite the refusal")
	}

	// Declaring the predicate instead is refused too, by the static check — a
	// partial-keyed table cannot reach the generic path either way.
	mergeChildren[len(mergeChildren)-1].keyPredicate = "archived = FALSE"
	if err := mergeChildStrategyError(mergeChildren, mergeEpisodeChildren); err == nil {
		t.Error("declaring keyPredicate on a non-bespoke entry was accepted; the generic loop does not apply predicates")
	}

	// And the other shape: an entry declaring NO keyCols, whose unique index is
	// partial and covers media_item_id alone. It takes the plain UPDATE, so it
	// cannot delete — but the claim is that a partial-keyed child cannot reach
	// the generic path AT ALL, and an earlier version of the check filtered
	// keyCols-less entries out, which made that claim false for exactly this
	// table. A review found the arm unpinned; it is the shape the next one would
	// try.
	if _, err := q.pool.Exec(ctx, `
		CREATE UNIQUE INDEX zz_partial_key_probe_solo
		ON zz_partial_key_probe (media_item_id) WHERE archived = TRUE`); err != nil {
		t.Fatalf("create solo probe index: %v", err)
	}
	if _, err := q.pool.Exec(ctx, `DROP INDEX zz_partial_key_probe_uq`); err != nil {
		t.Fatalf("drop composite probe index: %v", err)
	}
	mergeChildren[len(mergeChildren)-1].keyCols = nil
	mergeChildren[len(mergeChildren)-1].keyPredicate = ""
	if err := mergeChildStrategyError(mergeChildren, mergeEpisodeChildren); err != nil {
		t.Fatalf("precondition: an entry with no keyCols and no keyPredicate should pass the static check, got %v", err)
	}
	err = q.mergeChildPartialKeyError(ctx)
	if err == nil {
		t.Error("a generic-path child with NO keyCols but a PARTIAL unique index over media_item_id was accepted; the plain UPDATE cannot delete, but it raises 23505 and aborts the merge, and the rule is that a partial-keyed child does not reach this path at all")
	} else if !strings.Contains(err.Error(), "zz_partial_key_probe") {
		t.Errorf("error does not name the offending table: %v", err)
	}
}

// TestMergeMediaItemsDoesNotMoveARecapThreadIntoAnotherProfilesConversation is
// the sibling of the test above, and it exists because that one could not see
// the defect.
//
// mergeRecapConversationChildren moves a duplicate conversation's turns and
// requests onto the SURVIVING conversation for the SAME profile, and the join
// that expresses "same profile" is one predicate. A review deleted it and
// nothing in the suite went red: with two candidate canonical conversations the
// unconstrained join picks one arbitrarily, so the single-profile test passes
// whenever Postgres happens to choose correctly. Recaps are a person's own Q&A
// thread; landing one in another profile's conversation is a disclosure, not a
// misplacement, so it must not be pinned by a coin toss.
//
// The shape here removes the toss. The canonical carries a conversation for
// ANOTHER profile only, and the duplicate carries this profile's thread — so
// under the predicate there is no canonical conversation to move into (the
// generic recap_conversations pass re-parents the duplicate's own conversation,
// turns and all), and without it there is exactly ONE candidate and it is the
// wrong one. Both assertions below then fail on the mutation, every run.
func TestMergeMediaItemsDoesNotMoveARecapThreadIntoAnotherProfilesConversation(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, ownerID)
	sfx := randomSuffix(t)

	mkItem := func(title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, overview, rating, runtime_minutes, content_rating, year)
			 VALUES ($1,'show',$2,$2,'',0,0,'',0) RETURNING id`, libID, title).Scan(&id); err != nil {
			t.Fatalf("insert item: %v", err)
		}
		return id
	}
	canonical := mkItem("Recap Xprofile Canonical " + sfx)
	duplicate := mkItem("Recap Xprofile Duplicate " + sfx)

	mkProfile := func(name string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
			 VALUES ($1,$2,FALSE,'en','off') RETURNING id`, ownerID, name).Scan(&id); err != nil {
			t.Fatalf("insert profile %s: %v", name, err)
		}
		return id
	}
	mine := mkProfile("recap-mine-" + sfx)
	theirs := mkProfile("recap-theirs-" + sfx)

	mkConv := func(profile, itemID int64) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO recap_conversations (profile_id, media_item_id, generation_epoch) VALUES ($1,$2,1) RETURNING id`,
			profile, itemID).Scan(&id); err != nil {
			t.Fatalf("insert conversation: %v", err)
		}
		return id
	}
	theirConv := mkConv(theirs, canonical)
	myConv := mkConv(mine, duplicate)

	for i := 0; i < 3; i++ {
		var reqID string
		if err := q.pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&reqID); err != nil {
			t.Fatalf("uuid: %v", err)
		}
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO recap_conversation_turns
			   (conversation_id, request_id, question, answer,
			    boundary_season, boundary_episode, boundary_title, grounding_mode)
			 VALUES ($1,$2::uuid,$3,'a',1,1,'t','grounded')`, myConv, reqID, "private q"+string(rune('1'+i))); err != nil {
			t.Fatalf("insert turn: %v", err)
		}
		if _, err := q.pool.Exec(ctx,
			`INSERT INTO recap_conversation_requests (conversation_id, request_id, question_hash, conversation_epoch, status)
			 VALUES ($1,$2::uuid,repeat('b',64),1,'completed')`, myConv, reqID); err != nil {
			t.Fatalf("insert request: %v", err)
		}
	}

	if err := q.MergeMediaItems(ctx, canonical, duplicate); err != nil {
		t.Fatalf("merge: %v", err)
	}

	var leakedTurns, leakedRequests int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recap_conversation_turns WHERE conversation_id = $1`, theirConv).Scan(&leakedTurns); err != nil {
		t.Fatalf("count turns on the other profile's conversation: %v", err)
	}
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recap_conversation_requests WHERE conversation_id = $1`, theirConv).Scan(&leakedRequests); err != nil {
		t.Fatalf("count requests on the other profile's conversation: %v", err)
	}
	if leakedTurns != 0 || leakedRequests != 0 {
		t.Errorf("%d turns and %d requests were moved into ANOTHER profile's recap conversation; the move must be keyed on profile_id", leakedTurns, leakedRequests)
	}

	// And this profile still has its own thread, on the canonical.
	var mineTurns int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recap_conversation_turns t
		   JOIN recap_conversations c ON c.id = t.conversation_id
		 WHERE c.media_item_id = $1 AND c.profile_id = $2`, canonical, mine).Scan(&mineTurns); err != nil {
		t.Fatalf("count own turns: %v", err)
	}
	if mineTurns != 3 {
		t.Errorf("%d of this profile's recap turns survived on the canonical, want 3", mineTurns)
	}
}
