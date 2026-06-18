package metadata

import "testing"

func bpDeref(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

// TMDB's default backdrop_path is frequently logo / title key-art (e.g. a
// bare Netflix "N"); pickBackdropPath should prefer a textless backdrop from
// the images list instead, falling back to the default only when none exists.
func TestPickBackdropPath(t *testing.T) {
	lang := func(s string) *string { return &s }

	t.Run("prefers first textless over default backdrop_path", func(t *testing.T) {
		imgs := &TMDBImages{Backdrops: []TMDBImage{
			{FilePath: "/logo-en.jpg", Lang: lang("en"), VoteAverage: 9}, // tagged, highest vote
			{FilePath: "/scene-textless.jpg", Lang: nil, VoteAverage: 5}, // textless
		}}
		if got := pickBackdropPath(imgs, lang("/tmdb-default-N.jpg")); bpDeref(got) != "/scene-textless.jpg" {
			t.Fatalf("want /scene-textless.jpg, got %q", bpDeref(got))
		}
	})

	t.Run("treats empty iso_639_1 as textless", func(t *testing.T) {
		imgs := &TMDBImages{Backdrops: []TMDBImage{
			{FilePath: "/a.jpg", Lang: lang("fr")},
			{FilePath: "/b.jpg", Lang: lang("")}, // empty string == textless
		}}
		if got := pickBackdropPath(imgs, nil); bpDeref(got) != "/b.jpg" {
			t.Fatalf("want /b.jpg, got %q", bpDeref(got))
		}
	})

	t.Run("falls back to default when no textless backdrop", func(t *testing.T) {
		imgs := &TMDBImages{Backdrops: []TMDBImage{
			{FilePath: "/a.jpg", Lang: lang("en")},
			{FilePath: "/b.jpg", Lang: lang("ja")},
		}}
		if got := pickBackdropPath(imgs, lang("/default.jpg")); bpDeref(got) != "/default.jpg" {
			t.Fatalf("want /default.jpg, got %q", bpDeref(got))
		}
	})

	t.Run("falls back when images nil", func(t *testing.T) {
		if got := pickBackdropPath(nil, lang("/default.jpg")); bpDeref(got) != "/default.jpg" {
			t.Fatalf("want /default.jpg, got %q", bpDeref(got))
		}
	})

	t.Run("skips textless entries with empty file paths", func(t *testing.T) {
		imgs := &TMDBImages{Backdrops: []TMDBImage{
			{FilePath: "", Lang: nil},          // textless but empty → skip
			{FilePath: "/real.jpg", Lang: nil}, // textless, real
		}}
		if got := pickBackdropPath(imgs, nil); bpDeref(got) != "/real.jpg" {
			t.Fatalf("want /real.jpg, got %q", bpDeref(got))
		}
	})
}

func TestFirstTextlessIndex(t *testing.T) {
	lang := func(s string) *string { return &s }
	imgs := []TMDBImage{
		{Lang: lang("en")},
		{Lang: lang("de")},
		{Lang: nil},      // index 2 == first textless
		{Lang: lang("")}, // also textless, but later
	}
	if got := firstTextlessIndex(imgs, 5); got != 2 {
		t.Fatalf("want 2, got %d", got)
	}
	// the textless entry is beyond the stored limit → fall back to 0
	if got := firstTextlessIndex(imgs, 2); got != 0 {
		t.Fatalf("want 0 (textless beyond limit), got %d", got)
	}
	// none textless → 0
	allTagged := []TMDBImage{{Lang: lang("en")}, {Lang: lang("fr")}}
	if got := firstTextlessIndex(allTagged, 5); got != 0 {
		t.Fatalf("want 0, got %d", got)
	}
}
