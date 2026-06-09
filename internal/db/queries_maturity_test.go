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

	// Returns the result-list ranks of the two seeded items (−1 if absent).
	ranks := func() (fam, mat int) {
		items, err := q.NearestUnwatched(ctx, profileID, query, 50, nil, "", 0)
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
	setPref := func(p int) {
		if _, err := q.pool.Exec(ctx, `UPDATE user_profiles SET maturity_pref=$1 WHERE id=$2`, p, profileID); err != nil {
			t.Fatalf("set pref: %v", err)
		}
	}

	// OFF: pure cosine → the closer (family) item ranks ahead of the farther.
	setPref(-1)
	if fam, mat := ranks(); !(fam < mat) {
		t.Errorf("pref off: family (closer) should rank ahead of mature; fam=%d mat=%d", fam, mat)
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
}
