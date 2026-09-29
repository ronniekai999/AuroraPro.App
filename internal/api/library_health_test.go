package api

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// The report is the cheapest of the three #510 fixes and the only one that
// would have CAUGHT it rather than recovered from it, so its decision is pinned
// as data in / data out. No database: the policy is the thing under test.

func tally(id int64, typ models.LibraryType, items, matched int64) db.LibraryMatchHealth {
	return db.LibraryMatchHealth{
		LibraryID: id, Name: "lib", Type: typ, Items: items, Matched: matched,
	}
}

func noneScanning(int64) bool { return false }

func TestLibraryHealthReportWarnsAboutTheMistypedLibraryShape(t *testing.T) {
	// The exact production shape: a shows library recorded as movies, 80 series,
	// zero matched — beside a movies library that is working fine, which is what
	// makes it this library's problem and not the install's.
	rep := libraryHealthReport([]db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 400, 396),
		tally(8, models.LibraryMovies, 80, 0),
	}, noneScanning)

	if rep.InstallWarning != "" {
		t.Errorf("install-level warning raised while a library is matching fine: %q", rep.InstallWarning)
	}
	if w := rep.Libraries[0].Warning; w != "" {
		t.Errorf("healthy library warned: %q", w)
	}
	w := rep.Libraries[1].Warning
	if w == "" {
		t.Fatal("80 titles with 0 metadata matches raised no warning — this is the #510 state exactly, and nothing surfacing it is why it survived repeated scans")
	}
	// It must point at the type, and name the OTHER type, or it sends the admin
	// looking for a library of the kind it already claims to be.
	if !strings.Contains(w, "TV shows") {
		t.Errorf("warning on a type=movie library does not mention TV shows, so it does not state the hypothesis: %q", w)
	}
	if rep.Libraries[1].MatchedPct != 0 {
		t.Errorf("matched_pct = %d, want 0", rep.Libraries[1].MatchedPct)
	}
}

func TestLibraryHealthReportStaysQuietOnHealthyAndTinyLibraries(t *testing.T) {
	cases := []struct {
		name string
		in   db.LibraryMatchHealth
	}{
		{"fully matched", tally(1, models.LibraryShows, 50, 50)},
		{"mostly matched", tally(2, models.LibraryMovies, 100, 94)},
		// Exactly at the threshold: 5 of 100 is 5%, which is "at or below", so
		// this one DOES warn — pinned in the boundary test below. Here we take
		// one above it.
		{"just above the threshold", tally(3, models.LibraryMovies, 100, 6)},
		{"too few titles to mean anything", tally(4, models.LibraryShows, 9, 0)},
		{"empty library", tally(5, models.LibraryShows, 0, 0)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Paired with a healthy library so the install-wide rule cannot be
			// what is keeping it quiet — that would pass for the wrong reason.
			rep := libraryHealthReport([]db.LibraryMatchHealth{
				c.in, tally(99, models.LibraryMovies, 200, 200),
			}, noneScanning)
			if w := rep.Libraries[0].Warning; w != "" {
				t.Errorf("warned about a library that needs no attention: %q", w)
			}
		})
	}
}

func TestLibraryHealthReportThresholdBoundary(t *testing.T) {
	// 5 of 100 is exactly the threshold and warns; 6 does not. Pinned because
	// "at or below" is a choice, and a float ratio here would put it on a
	// rounding edge.
	at := libraryHealthReport([]db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 100, 5), tally(99, models.LibraryMovies, 200, 200),
	}, noneScanning)
	if at.Libraries[0].Warning == "" {
		t.Error("5/100 (exactly the threshold) did not warn; the rule is at-or-below")
	}
	above := libraryHealthReport([]db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 100, 6), tally(99, models.LibraryMovies, 200, 200),
	}, noneScanning)
	if above.Libraries[0].Warning != "" {
		t.Error("6/100 warned; that is above the threshold")
	}
	// And the item floor is a floor, not a rounding artefact.
	tiny := libraryHealthReport([]db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 10, 0), tally(99, models.LibraryMovies, 200, 200),
	}, noneScanning)
	if tiny.Libraries[0].Warning == "" {
		t.Error("10 titles is the minimum and must be reported; 9 must not")
	}
}

func TestLibraryHealthReportBlamesTheInstallWhenEveryLibraryIsStarved(t *testing.T) {
	// An absent or invalid TMDB key starves everything. Telling the admin to
	// check each library's type would send them the wrong way entirely.
	rep := libraryHealthReport([]db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 400, 0),
		tally(2, models.LibraryShows, 80, 0),
	}, noneScanning)

	if rep.InstallWarning == "" {
		t.Fatal("every library starved and no install-level warning was raised")
	}
	if !strings.Contains(rep.InstallWarning, "TMDB") {
		t.Errorf("install warning does not name the provider: %q", rep.InstallWarning)
	}
	for _, l := range rep.Libraries {
		if l.Warning != "" {
			t.Errorf("library %d still carries a type warning under an install-level fault: %q", l.LibraryID, l.Warning)
		}
	}
	// Libraries too small to judge must not count toward "every library".
	mixed := libraryHealthReport([]db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 400, 0),
		tally(2, models.LibraryShows, 3, 0),
		tally(3, models.LibraryMovies, 200, 190),
	}, noneScanning)
	if mixed.InstallWarning != "" {
		t.Errorf("install-level warning raised while a third library matches fine: %q", mixed.InstallWarning)
	}
}

func TestLibraryHealthReportStillWarnsOnASingleLibraryInstall(t *testing.T) {
	// The asymmetry that matters. With ONE library the two explanations — a bad
	// key and a mis-typed library — are indistinguishable from these numbers, and
	// suppressing would silence exactly the single-library install whose one
	// library is mis-typed. A false warning costs a look at a settings page; a
	// false all-clear costs the catalog being invisible for months.
	rep := libraryHealthReport([]db.LibraryMatchHealth{
		tally(8, models.LibraryMovies, 80, 0),
	}, noneScanning)

	if rep.InstallWarning != "" {
		t.Errorf("one library is not evidence of an install-wide fault: %q", rep.InstallWarning)
	}
	if rep.Libraries[0].Warning == "" {
		t.Error("the only library on the install was starved and said nothing; this is the report's whole job")
	}
}

func TestLibraryHealthReportSaysNothingWhileAScanIsRunning(t *testing.T) {
	// Rows are being written as we look, so a partial tally warns and then
	// resolves itself a minute later. A warning that fires during every scan is
	// one nobody reads by the time it means something.
	scanning := func(id int64) bool { return id == 8 }
	rep := libraryHealthReport([]db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 400, 396),
		tally(8, models.LibraryMovies, 80, 0),
	}, scanning)

	if !rep.Libraries[1].Scanning {
		t.Error("the scanning flag is not reported, so a client cannot tell a quiet library from a busy one")
	}
	if w := rep.Libraries[1].Warning; w != "" {
		t.Errorf("warned about a library mid-scan: %q", w)
	}
}

func TestLibraryHealthReportKeepsEveryLibraryInThePayload(t *testing.T) {
	// Including the empty and the healthy ones: the report is a list an admin
	// reads, not just the exceptions, and an empty library vanishing would read
	// as "deleted" rather than "no titles yet".
	in := []db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 0, 0),
		tally(2, models.LibraryShows, 500, 500),
		tally(3, models.LibraryMovies, 80, 0),
	}
	rep := libraryHealthReport(in, noneScanning)
	if len(rep.Libraries) != len(in) {
		t.Fatalf("report carries %d libraries, want %d", len(rep.Libraries), len(in))
	}
	for i := range in {
		if rep.Libraries[i].LibraryID != in[i].LibraryID {
			t.Errorf("row %d is library %d, want %d — order must follow the input", i, rep.Libraries[i].LibraryID, in[i].LibraryID)
		}
	}
	if rep.Libraries[1].MatchedPct != 100 {
		t.Errorf("matched_pct = %d for a fully matched library, want 100", rep.Libraries[1].MatchedPct)
	}
}

// A nil scanner must not be read as "everything is scanning" (which would
// silence the report entirely) nor panic. The handler and the scan hook both
// pass a concrete scanner today, but LibraryHealthReportFor is the only adapter
// and tests construct handlers without one.
func TestLibraryHealthReportForTreatsANilScannerAsIdle(t *testing.T) {
	rep := LibraryHealthReportFor([]db.LibraryMatchHealth{
		tally(8, models.LibraryMovies, 80, 0),
	}, nil)
	if rep.Libraries[0].Scanning {
		t.Error("a nil scanner reported a library as scanning")
	}
	if rep.Libraries[0].Warning == "" {
		t.Error("a nil scanner silenced the report; 'unknown' must not read as 'busy'")
	}
}

type fakeProgress struct{ running map[int64]bool }

func (f fakeProgress) GetProgress(id int64) *models.ScanProgress {
	st := models.ScanIdle
	if f.running[id] {
		st = models.ScanRunning
	}
	return &models.ScanProgress{LibraryID: id, Status: st}
}

func TestLogLibraryHealthWritesOneLinePerFlaggedLibrary(t *testing.T) {
	tallies := []db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 400, 396),
		tally(8, models.LibraryMovies, 80, 0),
		tally(9, models.LibraryShows, 60, 1),
	}
	rep := LibraryHealthReportFor(tallies, fakeProgress{})

	if n := LogLibraryHealth(rep, 0); n != 2 {
		t.Errorf("logged %d lines for 2 flagged libraries, want 2", n)
	}
	// Scoped to the library whose scan just finished: the hook fires per scan,
	// and re-warning about every other library each time is how a log line stops
	// being read.
	if n := LogLibraryHealth(rep, 8); n != 1 {
		t.Errorf("logged %d lines when scoped to one library, want 1", n)
	}
	if n := LogLibraryHealth(rep, 1); n != 0 {
		t.Errorf("logged %d lines for a healthy library, want 0", n)
	}

	// An install-level fault is ONE line, not one per library — the remedy is
	// the same for all of them and repeating it per library buries it.
	installWide := LibraryHealthReportFor([]db.LibraryMatchHealth{
		tally(1, models.LibraryMovies, 400, 0),
		tally(2, models.LibraryShows, 80, 0),
	}, fakeProgress{})
	if n := LogLibraryHealth(installWide, 0); n != 1 {
		t.Errorf("logged %d lines for an install-level fault, want exactly 1", n)
	}

	// And nothing at all while that library is scanning.
	busy := LibraryHealthReportFor(tallies, fakeProgress{running: map[int64]bool{8: true, 9: true}})
	if n := LogLibraryHealth(busy, 0); n != 0 {
		t.Errorf("logged %d lines while the libraries were mid-scan, want 0", n)
	}
}
