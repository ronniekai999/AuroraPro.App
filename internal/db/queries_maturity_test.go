package db

// Integration test for the Phase E2c content-tone lean (maturity_pref penalty in
// NearestUnwatched). Opt-in via TEST_DATABASE_URL.

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// vec768 builds a 768-dim pgvector literal from the given leading components
// (rest zero), matching the vector(768) column.
func vec768(lead ...float64) string {
	parts := make([]string, 768)
	for i := range parts {
		parts[i] = "0"
	}
	for i, v := range lead {
		if i < 768 {
			parts[i] = fmt.Sprintf("%g", v)
		}
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func seedRatedItem(t *testing.T, q *Queries, libID int64, vecLit, rating string) int64 {
	t.Helper()
	id := seedTestMediaItem(t, q, libID)
	if _, err := q.pool.Exec(context.Background(),
		`UPDATE media_items SET embedding = $1::vector, backdrop_path = '/bd.jpg', content_rating = $2 WHERE id = $3`,
		vecLit, rating, id); err != nil {
		t.Fatalf("seed rated item: %v", err)
	}
	return id
}

func TestMaturityPrefLean(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	query := vec768(1, 0)
	family := seedRatedItem(t, q, libID, vec768(1, 0), "G")        // cosine dist 0
	mature := seedRatedItem(t, q, libID, vec768(0.98, 0.199), "R") // cosine dist ~0.02

	// Returns the result-list ranks of the two seeded items (−1 if absent)
	// for the given profile, with the tone penalty opted in or out.
	ranksFor := func(pid int64, applyPenalty bool) (fam, mat int) {
		items, err := q.NearestUnwatched(ctx, pid, query, 50, nil, "", 0, applyPenalty)
		if err != nil {
			t.Fatalf("nearest: %v", err)
		}
		fam, mat = -1, -1
		for i, it := range items {
			switch it.ID {
			case family:
				fam = i
			case mature:
				mat = i
			}
		}
		if fam < 0 || mat < 0 {
			t.Fatalf("seeded items missing from recall (fam=%d mat=%d)", fam, mat)
		}
		return fam, mat
	}
	ranks := func() (fam, mat int) { return ranksFor(profileID, true) }
	setPref := func(p int) {
		if _, err := q.pool.Exec(ctx, `UPDATE user_profiles SET maturity_pref=$1 WHERE id=$2`, p, profileID); err != nil {
			t.Fatalf("set pref: %v", err)
		}
	}

	// AUTO (-1) with NO rated watch history: nothing to derive → pure cosine,
	// the closer (family) item ranks ahead of the farther.
	setPref(-1)
	if fam, mat := ranks(); !(fam < mat) {
		t.Errorf("auto, no history: family (closer) should rank ahead of mature; fam=%d mat=%d", fam, mat)
	}
	// MATURE: the family item's ~0.02 cosine lead is overcome by a 0.08 penalty.
	setPref(2)
	if fam, mat := ranks(); !(mat < fam) {
		t.Errorf("pref mature: mature should rank ahead despite being farther; fam=%d mat=%d", fam, mat)
	}
	// FAMILY: reinforces the already-closer family item.
	setPref(0)
	if fam, mat := ranks(); !(fam < mat) {
		t.Errorf("pref family: family should rank ahead; fam=%d mat=%d", fam, mat)
	}

	// AUTO (-1) with watch history: the lean now DERIVES from the DOMINANT
	// tier across the profile's distinct watched/seeded titles (2026-07-20
	// fix — a family-history profile was getting R-horror heroes because the
	// unset dial meant no lean at all). Watch an R-rated title (tier 2, 100%
	// of rated history): derived pref = 2, so the family item eats the 0.08
	// penalty and the mature item overtakes it despite the ~0.02 cosine gap —
	// the mirror image of the explicit pref=2 case above. The watched item
	// itself is a third title (far from the query vector) and is excluded
	// from recall by the watch anyway.
	watched := seedRatedItem(t, q, libID, vec768(0, 0, 1), "R")
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed, completed_at, updated_at)
		 VALUES ($1, $2, $3, 5000, 6000, TRUE, now(), now())`,
		userID, profileID, watched); err != nil {
		t.Fatalf("seed watched R item: %v", err)
	}
	setPref(-1)
	if fam, mat := ranks(); !(mat < fam) {
		t.Errorf("auto, R history (derived mature lean): mature should rank ahead; fam=%d mat=%d", fam, mat)
	}
	// Opt-out callers (anchor-pinned rails) must see pure cosine order even
	// while the derived lean is active for opted-in surfaces.
	if fam, mat := ranksFor(profileID, false); !(fam < mat) {
		t.Errorf("applyTonePenalty=false must keep pure cosine order; fam=%d mat=%d", fam, mat)
	}
	// An explicit dial pick still overrides the derived lean.
	setPref(0)
	if fam, mat := ranks(); !(fam < mat) {
		t.Errorf("explicit family must override derived mature lean; fam=%d mat=%d", fam, mat)
	}
	setPref(-1)

	// Majority gate: add a family-tier watch → history is now 1×R + 1×G with
	// no ≥60% dominant tier, so NO lean applies (the old mean-based idea
	// would have leaned a mixed household toward PG-13 content nobody
	// watches). Neutral order = closer family item first.
	watchedG := seedRatedItem(t, q, libID, vec768(0, 0, 0, 1), "G")
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed, completed_at, updated_at)
		 VALUES ($1, $2, $3, 5000, 6000, TRUE, now(), now())`,
		userID, profileID, watchedG); err != nil {
		t.Fatalf("seed watched G item: %v", err)
	}
	if fam, mat := ranks(); !(fam < mat) {
		t.Errorf("auto, mixed 50/50 history: majority gate must yield neutral order; fam=%d mat=%d", fam, mat)
	}

	// Thumbs-down exclusion: disliking the R title removes it from the
	// derivation, leaving a 100% family history → family lean (and never the
	// inverted "disliked R ⇒ more R" behavior). Family stays first.
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO item_feedback (profile_id, media_item_id, feedback) VALUES ($1, $2, 'down')`,
		profileID, watched); err != nil {
		t.Fatalf("dislike watched R item: %v", err)
	}
	if fam, mat := ranks(); !(fam < mat) {
		t.Errorf("auto, disliked R excluded (family-only history): family should rank ahead; fam=%d mat=%d", fam, mat)
	}

	// Seeds-only cold start (second user/profile, no watches): taste-
	// onboarding picks are the only tone signal and must drive the derived
	// lean too. Seeding the R title gives a 100% mature seed history →
	// mature lean → the farther mature item overtakes.
	user2 := seedTestUser(t, q)
	profile2 := seedDefaultProfile(t, q, user2)
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO taste_seeds (profile_id, media_item_id, source) VALUES ($1, $2, 'onboarding')`,
		profile2, watched); err != nil {
		t.Fatalf("seed taste_seeds: %v", err)
	}
	if fam, mat := ranksFor(profile2, true); !(mat < fam) {
		t.Errorf("auto, seeds-only mature history: mature should rank ahead for profile2; fam=%d mat=%d", fam, mat)
	}
}
