package api

import (
	"fmt"
	"log/slog"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// The mis-typed-library report (issue #510 follow-up).
//
// The owner's "TV Shows" library was created with type='movie'. scanner.go's
// `isTV := lib.Type == models.LibraryShows` then routed all 80 series through
// ParseMoviePath, stored them as media_items.type='movie' with their files in
// media_files rather than episode_files, and enriched them against TMDB's MOVIE
// index — where none of them matched. They were invisible to
// GET /api/media?type=show. Nothing said a word: every scan reported success,
// and from the outside the library looked healthy.
//
// This is a REPORT, never a corrective action. It states an observation and the
// leading hypothesis; deciding what to do with a library is the admin's, and
// doing it destroys catalog rows (see the retype action, which is deliberately
// explicit about what it deletes).

const (
	// libraryHealthMinItems is how many rows a library needs before its match
	// rate means anything. A library with three films and no matches is noise;
	// one with eighty and no matches is a defect.
	libraryHealthMinItems = 10
	// libraryHealthMaxMatchedPct is the rate at or below which a library is
	// reported. Deliberately very low: the rule is AT-or-below, so an
	// eighty-item library has to match FIVE titles to stay quiet (four is
	// exactly 5% and still reports). A genuinely obscure collection normally
	// clears that easily while a mis-typed one sits at exactly zero.
	libraryHealthMaxMatchedPct = 5
)

// LibraryHealthRow is one library's tally plus the verdict on it.
type LibraryHealthRow struct {
	db.LibraryMatchHealth
	// MatchedPct is rounded down, for display only; the decision below uses
	// integer arithmetic on the raw counts so it never turns on a rounding edge.
	MatchedPct int    `json:"matched_pct"`
	Scanning   bool   `json:"scanning"`
	Warning    string `json:"warning,omitempty"`
}

// LibraryHealthReport is the endpoint's whole payload.
type LibraryHealthReport struct {
	Libraries []LibraryHealthRow `json:"libraries"`
	// InstallWarning is set INSTEAD of the per-library warnings when every
	// library with enough rows is at or below the threshold. That pattern is a
	// provider-level fault — an absent or invalid TMDB key, a blocked host —
	// and telling an admin to check each library's type would send them the
	// wrong way. See the note in libraryHealthReport about why this needs two
	// libraries before it fires.
	InstallWarning string `json:"install_warning,omitempty"`
}

// libraryHealthReport turns the raw tallies into the report. Pure: `scanning`
// is injected so the decision can be tested without a scanner, and so the
// caller owns where "is a scan running" comes from.
//
// A library being scanned RIGHT NOW is never warned about. Its rows are being
// written as we look, so a partial tally would produce a warning that resolves
// itself a minute later — and a warning that cries wolf during every scan is one
// nobody reads by the time it matters.
func libraryHealthReport(tallies []db.LibraryMatchHealth, scanning func(int64) bool) LibraryHealthReport {
	rep := LibraryHealthReport{Libraries: make([]LibraryHealthRow, 0, len(tallies))}

	// A library mid-scan is excluded from the install-wide tally as well as from
	// its own warning, and that second half was missing. Freshly scanned rows
	// have no tmdb_id until the deferred enrichment pass finishes, so a library
	// being scanned for the first time reliably reads as starved — and on a
	// two-library install that flipped the whole report to "check your TMDB key"
	// AND suppressed the real per-library warning on the mis-typed one. The exact
	// failure this report exists to prevent, caused by the guard meant to avoid
	// false alarms. A review demonstrated it.
	eligible, starved := 0, 0
	for _, t := range tallies {
		if t.Items < libraryHealthMinItems || scanning(t.LibraryID) {
			continue
		}
		eligible++
		if belowMatchThreshold(t) {
			starved++
		}
	}

	// Every library with enough rows is starved: that is the install, not any
	// one library's type.
	//
	// It takes TWO eligible libraries to say so, and that asymmetry is the whole
	// point. With a single library the two explanations are indistinguishable
	// from these numbers alone — and suppressing there would silence exactly the
	// single-library install whose one library is mis-typed, which is the case
	// this report exists for. A false warning costs an admin one look at a
	// settings page; a false all-clear costs what #510 cost.
	installWide := eligible >= 2 && starved == eligible
	if installWide {
		rep.InstallWarning = "Every library with enough titles has almost no metadata matches. " +
			"That pattern points at the metadata provider rather than at any one library: " +
			"check the TMDB API key and that the server can reach api.themoviedb.org. " +
			"Per-library type warnings are suppressed while this holds."
	}

	for _, t := range tallies {
		row := LibraryHealthRow{LibraryMatchHealth: t, Scanning: scanning(t.LibraryID)}
		if t.Items > 0 {
			row.MatchedPct = int(t.Matched * 100 / t.Items)
		}
		if !installWide && !row.Scanning && t.Items >= libraryHealthMinItems && belowMatchThreshold(t) {
			row.Warning = libraryTypeWarning(t)
		}
		rep.Libraries = append(rep.Libraries, row)
	}
	return rep
}

// belowMatchThreshold is integer-only on purpose: matched/items as a float
// would put the decision on a rounding edge for no benefit.
func belowMatchThreshold(t db.LibraryMatchHealth) bool {
	return t.Matched*100 <= t.Items*libraryHealthMaxMatchedPct
}

// libraryTypeWarning words the observation first and the hypothesis second, and
// names the check rather than the fix. The type is genuinely the most likely
// cause — it is the one that produces exactly zero — but wrong paths, a private
// collection and a provider outage all land in the same tally, and this report
// cannot tell them apart.
func libraryTypeWarning(t db.LibraryMatchHealth) string {
	other := "TV shows"
	if t.Type == models.LibraryShows {
		other = "movies"
	}
	return fmt.Sprintf(
		"%d titles, %d with provider metadata. A library of %s recorded as %q is the usual cause: "+
			"every title is parsed and searched against the wrong index, so almost nothing matches and "+
			"the titles do not appear under the other type at all. Check the library's type first, then "+
			"its paths. (Wrong paths and a provider outage produce a similar tally.)",
		t.Items, t.Matched, other, t.Type)
}

// libraryIsStarved reports whether this library is one of the ones dragging the
// install-wide verdict down.
//
// It replaces a `reportCovers` helper that did nothing at all: it asked whether
// the library was IN the report, and the report carries every library, so the
// guard always fell through and the install line was still written on every
// completed scan of every library — exactly what it claimed to have fixed. Its
// test passed only because the negative case probed an id that did not exist. A
// review caught both.
func libraryIsStarved(rep LibraryHealthReport, libraryID int64) bool {
	for _, l := range rep.Libraries {
		if l.LibraryID == libraryID {
			// Mirrors the eligibility rule at the top of libraryHealthReport,
			// INCLUDING the mid-scan exclusion. Without that a library excluded
			// from the verdict could still authorise the install-level line —
			// reachable when a new scan starts between ScanComplete and the
			// tally fetch.
			return !l.Scanning &&
				l.Items >= libraryHealthMinItems &&
				belowMatchThreshold(l.LibraryMatchHealth)
		}
	}
	return false
}

// ScanProgressSource is the slice of the scanner LibraryHealthReportFor needs.
// Narrow on purpose: the report only ever asks whether a library is mid-scan.
type ScanProgressSource interface {
	GetProgress(libraryID int64) *models.ScanProgress
}

// LibraryHealthReportFor builds the report from tallies plus a live scanner. The
// pure decision stays in libraryHealthReport; this is the one adapter.
func LibraryHealthReportFor(tallies []db.LibraryMatchHealth, s ScanProgressSource) LibraryHealthReport {
	return libraryHealthReport(tallies, func(id int64) bool {
		if s == nil {
			return false
		}
		p := s.GetProgress(id)
		return p != nil && p.Status == models.ScanRunning
	})
}

// LogLibraryHealth writes a warning line for each library the report flags, and
// one for an install-level fault. Returns how many lines it wrote, so a caller
// can test it without capturing a logger.
//
// This is the half an operator actually sees. The endpoint above is a page
// somebody has to think to visit; the #510 library sat mis-typed through
// repeated successful scans precisely because nothing ever said anything. Called
// from the scan-completion hook, so it fires once per scan of the library that
// just finished, on whichever entry point started it.
func LogLibraryHealth(rep LibraryHealthReport, only int64) int {
	n := 0
	if rep.InstallWarning != "" {
		// Scoped, so the line is not re-written on every scan of every library —
		// which is how a warning stops being read. `only` is the library whose
		// scan just finished; 0 means a full sweep (the endpoint), which always
		// reports.
		//
		// The test is whether THAT library is itself starved. A scan finishing on
		// a library that matches nothing is exactly the moment the line is worth
		// reading, and it says the right thing: this library has no matches, and
		// so does everything else, so look at the provider rather than at this
		// library's type.
		if only != 0 && !libraryIsStarved(rep, only) {
			return 0
		}
		slog.Warn("library metadata matching looks broken install-wide",
			"detail", rep.InstallWarning)
		return 1
	}
	for _, l := range rep.Libraries {
		if l.Warning == "" || (only != 0 && l.LibraryID != only) {
			continue
		}
		slog.Warn("library has almost no metadata matches",
			"library", l.Name, "library_id", l.LibraryID, "type", l.Type,
			"items", l.Items, "matched", l.Matched, "detail", l.Warning)
		n++
	}
	return n
}
