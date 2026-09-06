package library

// C1 regression: a repointed library must keep pruning and sweeping.
//
// Deleting phase 3 removed the only caller that released the repoint marker,
// so isRepointed stayed true forever and every later scan of that library took
// the "delete nothing" branch — no deleted file was ever pruned and no emptied
// catalog entry was ever swept, silently, until a restart. The marker is gone
// now; this drives a repoint followed by a real deletion and asserts the
// ordinary cleanup still happens.

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
)

func TestPruneStillWorksAfterARepoint(t *testing.T) {
	pool, queries := repointTestPool(t)
	ctx := context.Background()

	oldRoot, newRoot := t.TempDir(), t.TempDir()
	keepDir := filepath.Join(newRoot, "Keeper (2001)")
	goneDir := filepath.Join(newRoot, "Doomed (2002)")
	for _, d := range []string{keepDir, goneDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	keepNew := filepath.Join(keepDir, "Keeper (2001).mkv")
	goneNew := filepath.Join(goneDir, "Doomed (2002).mkv")
	for _, f := range []string{keepNew, goneNew} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	keepOld := filepath.Join(oldRoot, "Keeper (2001)", "Keeper (2001).mkv")
	goneOld := filepath.Join(oldRoot, "Doomed (2002)", "Doomed (2002).mkv")

	ownerID, _ := seedOwner(t, ctx, pool, "c1probe")
	lib := &models.Library{Name: "C1 Probe", Type: models.LibraryMovies,
		Paths: []string{oldRoot}, ScanInterval: 360, OwnerID: ownerID}
	if err := queries.CreateLibrary(ctx, lib); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id=$1`, lib.ID) })

	keepItem := seedMovie(t, ctx, pool, lib.ID, "Keeper", keepOld)
	goneItem := seedMovie(t, ctx, pool, lib.ID, "Doomed", goneOld)

	recorded, err := queries.GetMediaFilePathsForLibrary(ctx, lib.ID)
	if err != nil {
		t.Fatal(err)
	}
	moves := map[int64]string{recorded[keepOld]: keepNew, recorded[goneOld]: goneNew}
	updated, err := queries.RepointLibrary(ctx, lib.ID, lib.Name, []string{newRoot}, moves, nil)
	if err != nil {
		t.Fatalf("repoint: %v", err)
	}

	s := NewScanner(config.ScannerConfig{Workers: 2}, queries)
	if err := s.ScanLibrary(ctx, updated, nil); err != nil {
		t.Fatal(err)
	}

	// Now genuinely delete one film and rescan. This MUST be pruned and swept.
	if err := os.RemoveAll(goneDir); err != nil {
		t.Fatal(err)
	}
	if err := s.ScanLibrary(ctx, updated, nil); err != nil {
		t.Fatal(err)
	}

	var goneRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM media_files WHERE path=$1`, goneNew).Scan(&goneRows); err != nil {
		t.Fatal(err)
	}
	if goneRows != 0 {
		t.Error("a deleted file was NOT pruned after a repoint — the relocation suppression is latched on again")
	}
	var ghost bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_items WHERE id=$1)`, goneItem).Scan(&ghost); err != nil {
		t.Fatal(err)
	}
	if ghost {
		t.Error("the emptied catalog entry was NOT swept after a repoint — the 'no files available' ghost is back")
	}
	var keeper bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_items WHERE id=$1)`, keepItem).Scan(&keeper); err != nil {
		t.Fatal(err)
	}
	if !keeper {
		t.Error("the surviving film was swept too — the prune is now over-eager")
	}
}
