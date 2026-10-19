package db

import (
	"context"
	"errors"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// cutOffRows yields one restricted profile, then reports the result cut off,
// as a connection lost mid-read does. Its other methods are never called.
type cutOffRows struct {
	pgx.Rows
	served bool
}

func (r *cutOffRows) Next() bool {
	served := r.served
	r.served = true
	return !served
}

func (r *cutOffRows) Scan(dest ...any) error {
	*dest[0].(*string) = "PG"
	return nil
}

func (r *cutOffRows) Err() error { return errors.New("connection lost") }
func (r *cutOffRows) Close()     {}

type cutOffQuerier struct{}

func (cutOffQuerier) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return &cutOffRows{}, nil
}

// TestHasUnrestrictedProfileFailsOnACutOffResult pins the check's failure to
// close: read as an answer, a list cut off after its restricted profiles says
// the account has no unrestricted one, and internal/api's admin exception
// grants a restricted session the admin powers.
func TestHasUnrestrictedProfileFailsOnACutOffResult(t *testing.T) {
	if _, err := hasUnrestrictedProfile(context.Background(), cutOffQuerier{}, 1); err == nil {
		t.Error("a result cut off after a restricted profile read as an answer")
	}
}

// TestLimitingAWhitespaceCeilingKeepsAnUnrestrictedProfile: a profile stored
// with a hand-written tab is unrestricted to the ladder and so to the admin
// exception's check, so limiting or deleting it with only restricted profiles
// beside it is refused. Allowed, the write put the account in internal/api's
// admin exception and gave its kid's sessions the admin powers. A boot
// canonicalization in another package rewrites the tab to NULL, which reads
// the same. Opt-in via TEST_DATABASE_URL.
func TestLimitingAWhitespaceCeilingKeepsAnUnrestrictedProfile(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	tab := &models.UserProfile{UserID: userID, Name: "tab", Language: "en", SubtitleMode: "off"}
	kid := &models.UserProfile{UserID: userID, Name: "kid", MaxAgeRating: "PG", Language: "en", SubtitleMode: "off"}
	for _, p := range []*models.UserProfile{tab, kid} {
		if err := q.CreateProfile(ctx, p); err != nil {
			t.Fatalf("seed %s: %v", p.Name, err)
		}
	}
	if _, err := q.pool.Exec(ctx, `UPDATE user_profiles SET max_age_rating = E'\t' WHERE id = $1`, tab.ID); err != nil {
		t.Fatalf("store a tab: %v", err)
	}
	pg := "PG"
	limit := &models.UpdateProfileRequest{MaxAgeRating: &pg}
	if err := q.UpdateProfile(ctx, tab.ID, limit, nil); !errors.Is(err, ErrLastUnrestrictedProfile) {
		t.Errorf("limiting the one profile the ladder leaves unrestricted: err = %v, want ErrLastUnrestrictedProfile", err)
	}
	if _, err := q.DeleteProfile(ctx, tab.ID, nil); !errors.Is(err, ErrLastUnrestrictedProfile) {
		t.Errorf("deleting the one profile the ladder leaves unrestricted: err = %v, want ErrLastUnrestrictedProfile", err)
	}
	if has, err := q.HasUnrestrictedProfile(ctx, userID); err != nil || !has {
		t.Fatalf("after the refusals HasUnrestrictedProfile = %v, %v; want true", has, err)
	}
	// With another profile free of a limit, it can be limited.
	free := &models.UserProfile{UserID: userID, Name: "free", Language: "en", SubtitleMode: "off"}
	if err := q.CreateProfile(ctx, free); err != nil {
		t.Fatalf("seed free: %v", err)
	}
	if err := q.UpdateProfile(ctx, tab.ID, limit, nil); err != nil {
		t.Errorf("limiting it beside a profile free of a limit: %v", err)
	}
}
