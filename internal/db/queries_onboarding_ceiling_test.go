package db

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

// TestPartialTasteVectorCountsOnlyAllowedPicks: the onboarding grid and
// preview take any media ids as picks, so over-ceiling ones must not count.
// Otherwise a restricted profile could pull the preview toward an R title's
// neighbours, and tell from the answer whether an id exists.
func TestPartialTasteVectorCountsOnlyAllowedPicks(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	libID := seedTypedLibrary(t, q, seedTestUser(t, q), "movie")
	token := "tastevec" + randomSuffix(t)
	var rIDs []int64
	for i := 0; i < minHistoryItems; i++ {
		rIDs = append(rIDs, seedSearchCeilingItem(t, q, libID, fmt.Sprintf("%s r%d", token, i), ratingPtr("R"),
			sparseVec768(map[int]float64{620 + i: 1})))
	}
	if _, err := q.PartialTasteVector(ctx, rIDs, nil); err != nil {
		t.Fatalf("precondition: unrestricted, %d embedded picks should build a vector: %v", len(rIDs), err)
	}
	if _, err := q.PartialTasteVector(ctx, rIDs, AllowedRatingsForMax("PG")); !errors.Is(err, ErrInsufficientHistory) {
		t.Errorf("under a PG ceiling, %d R picks built a vector (err %v); want ErrInsufficientHistory", len(rIDs), err)
	}
}
