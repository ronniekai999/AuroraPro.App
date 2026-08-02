package library

import (
	"context"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// deep-debug H9 — a zero-discovered prune (e.g. an empty-but-present NFS/SMB
// mountpoint, which returns no walk error) must NOT delete the library's file
// rows. The guard returns before s.queries is touched, so a nil-queries
// Scanner is a valid way to assert the early bail.
func TestPruneDeletedFilesRefusesZeroDiscovered(t *testing.T) {
	s := &Scanner{} // queries is nil on purpose: the guard must return before it is used
	lib := &models.Library{Name: "Movies"}

	pruned, err := s.pruneDeletedFiles(context.Background(), lib, nil, nil)
	if err != nil {
		t.Fatalf("expected nil error from zero-discovered prune, got %v", err)
	}
	if pruned != 0 {
		t.Fatalf("expected 0 rows pruned when zero files discovered, got %d", pruned)
	}
}
