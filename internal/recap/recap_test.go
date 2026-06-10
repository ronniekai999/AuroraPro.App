package recap

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/db"
)

// The spoiler guarantee is the whole feature — these lock the ordinal compare.
func TestWithinBoundary(t *testing.T) {
	// boundary = S2E4
	const bS, bE = 2, 4
	cases := []struct {
		s, e int
		want bool
		name string
	}{
		{1, 1, true, "earlier season, first ep"},
		{1, 99, true, "earlier season, later ep number still within"},
		{2, 3, true, "same season, before boundary"},
		{2, 4, true, "exactly the boundary"},
		{2, 5, false, "same season, one past boundary"},
		{3, 1, false, "later season, first ep is a spoiler"},
	}
	for _, c := range cases {
		if got := withinBoundary(c.s, c.e, bS, bE); got != c.want {
			t.Errorf("%s: withinBoundary(%d,%d | %d,%d)=%v want %v", c.name, c.s, c.e, bS, bE, got, c.want)
		}
	}
}

func TestFilterWithinBoundaryDropsSpoilers(t *testing.T) {
	eps := []db.RecapEpisode{
		{SeasonNumber: 1, EpisodeNumber: 1},
		{SeasonNumber: 2, EpisodeNumber: 4}, // boundary
		{SeasonNumber: 2, EpisodeNumber: 5}, // spoiler — must be dropped
		{SeasonNumber: 3, EpisodeNumber: 1}, // spoiler — must be dropped
	}
	got := filterWithinBoundary(eps, 2, 4)
	if len(got) != 2 {
		t.Fatalf("expected 2 episodes within boundary, got %d: %+v", len(got), got)
	}
	for _, e := range got {
		if !withinBoundary(e.SeasonNumber, e.EpisodeNumber, 2, 4) {
			t.Errorf("leaked spoiler episode S%dE%d", e.SeasonNumber, e.EpisodeNumber)
		}
	}
}

func TestTailWindow(t *testing.T) {
	mk := func(n int) []db.RecapEpisode {
		out := make([]db.RecapEpisode, n)
		for i := range out {
			out[i] = db.RecapEpisode{SeasonNumber: 1, EpisodeNumber: i + 1}
		}
		return out
	}
	if w, trunc := tailWindow(mk(5), 12); trunc || len(w) != 5 {
		t.Errorf("under cap: got len=%d trunc=%v, want len=5 trunc=false", len(w), trunc)
	}
	w, trunc := tailWindow(mk(20), 12)
	if !trunc || len(w) != 12 {
		t.Fatalf("over cap: got len=%d trunc=%v, want len=12 trunc=true", len(w), trunc)
	}
	// Keeps the MOST RECENT episodes (the tail).
	if w[0].EpisodeNumber != 9 || w[len(w)-1].EpisodeNumber != 20 {
		t.Errorf("tail window wrong slice: first=E%d last=E%d, want E9..E20", w[0].EpisodeNumber, w[len(w)-1].EpisodeNumber)
	}
}

func TestSourceHashStableAndSensitive(t *testing.T) {
	a := []db.RecapEpisode{{SeasonNumber: 1, EpisodeNumber: 1, Overview: "x"}}
	b := []db.RecapEpisode{{SeasonNumber: 1, EpisodeNumber: 1, Overview: "x"}}
	c := []db.RecapEpisode{{SeasonNumber: 1, EpisodeNumber: 1, Overview: "y"}}
	if sourceHash(modeGrounded, a) != sourceHash(modeGrounded, b) {
		t.Error("identical inputs should hash identically (cache stability)")
	}
	if sourceHash(modeGrounded, a) == sourceHash(modeGrounded, c) {
		t.Error("changed overview should change the hash (cache invalidation)")
	}
	// Each mode produces different text for the same episodes, so the cache
	// must distinguish all three pairwise.
	modes := []recapMode{modeGrounded, modeSeasonClosure, modeCaughtUp}
	for i, m1 := range modes {
		for _, m2 := range modes[i+1:] {
			if sourceHash(m1, a) == sourceHash(m2, a) {
				t.Errorf("modes %s and %s must hash differently", m1, m2)
			}
		}
	}
}

// A prompt change is shipped by bumping recapTemplateVersion; that must change
// the digest so every cached recap regenerates on next request.
func TestSourceHashVersionBustsCache(t *testing.T) {
	eps := []db.RecapEpisode{{SeasonNumber: 1, EpisodeNumber: 1, Overview: "x"}}
	if sourceHashWith("v1", modeGrounded, eps) == sourceHashWith("v2", modeGrounded, eps) {
		t.Error("a template-version bump must change the hash (so prompt changes invalidate the cache)")
	}
	if sourceHashWith("v1", modeGrounded, eps) != sourceHashWith("v1", modeGrounded, eps) {
		t.Error("same version + inputs must hash identically (cache stability)")
	}
}

// The mode policy in one table: knowledge use is only enabled where the
// forward boundary is robust (nothing ahead, or a season-level bound).
func TestSelectMode(t *testing.T) {
	cases := []struct {
		hasAfter, seasonLast bool
		want                 recapMode
		name                 string
	}{
		{false, false, modeCaughtUp, "nothing ahead → caught-up"},
		{false, true, modeCaughtUp, "nothing ahead wins even at a finale (tighter bound)"},
		{true, true, modeSeasonClosure, "finale with later seasons → season-closure"},
		{true, false, modeGrounded, "true mid-season → grounded"},
	}
	for _, c := range cases {
		if got := selectMode(c.hasAfter, c.seasonLast); got != c.want {
			t.Errorf("%s: selectMode(%v,%v)=%s want %s", c.name, c.hasAfter, c.seasonLast, got, c.want)
		}
	}
}

func TestSystemPromptFor(t *testing.T) {
	b := &db.RecapBoundary{SeasonNumber: 1, EpisodeNumber: 8}
	if got := systemPromptFor(modeGrounded, b); got != recapSystemGrounded {
		t.Error("grounded mode must use the grounded prompt")
	}
	if got := systemPromptFor(modeCaughtUp, b); got != recapSystemCaughtUp {
		t.Error("caught-up mode must use the caught-up prompt")
	}
	sc := systemPromptFor(modeSeasonClosure, b)
	for _, want := range []string{
		"Season 1 through episode 8", // the watched bound, stated twice over
		"Season 2 or later",          // the forward season bound
		"how its central conflicts resolved",
	} {
		if !strings.Contains(sc, want) {
			t.Errorf("season-closure prompt missing %q", want)
		}
	}
	if strings.Contains(sc, "%!") || strings.Contains(sc, "%[") {
		t.Errorf("season-closure prompt has unrendered format verbs: %q", sc)
	}
}

func TestParseRecap(t *testing.T) {
	cases := []struct {
		name, raw, want string
		wantErr         bool
	}{
		{"exact schema", `{"recap":"They escaped the island."}`, "They escaped the island.", false},
		{"fenced", "```json\n{\"recap\":\"All is well.\"}\n```", "All is well.", false},
		{"alias summary", `{"summary":"The crew regroups."}`, "The crew regroups.", false},
		{"uppercase key", `{"Recap":"Mixed case key."}`, "Mixed case key.", false},
		{"bare prose", `Mark uncovers the truth about Lumon.`, "Mark uncovers the truth about Lumon.", false},
		{"empty object", `{}`, "", true},
		{"empty recap string", `{"recap":"   "}`, "", true},
	}
	for _, c := range cases {
		got, err := parseRecap(c.raw)
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: expected error, got %q", c.name, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: unexpected error: %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestSanitizeStripsControlAndCollapses(t *testing.T) {
	in := "line one\nline\ttwo   with    spaces\r\nand a prompt-injection attempt"
	got := sanitize(in, 0)
	if want := "line one line two with spaces and a prompt-injection attempt"; got != want {
		t.Errorf("sanitize=%q want %q", got, want)
	}
	// Rune-boundary truncation.
	if got := sanitize("abcdef", 3); got != "abc" {
		t.Errorf("truncate=%q want abc", got)
	}
}
