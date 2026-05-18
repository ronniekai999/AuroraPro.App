package library

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseNFO_KodiXML(t *testing.T) {
	nfoPath := filepath.Join("testdata", "nfo", "movie_kodi.nfo")
	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO(%q) error: %v", nfoPath, err)
	}

	if result.Title != "The Matrix" {
		t.Errorf("Title = %q, want %q", result.Title, "The Matrix")
	}
	if result.Year != 1999 {
		t.Errorf("Year = %d, want %d", result.Year, 1999)
	}
	if result.TMDBID != 603 {
		t.Errorf("TMDBID = %d, want %d", result.TMDBID, 603)
	}
	if result.IMDbID != "tt0133093" {
		t.Errorf("IMDbID = %q, want %q", result.IMDbID, "tt0133093")
	}
	if !result.HasExternalID() {
		t.Error("HasExternalID() = false, want true")
	}
}

func TestParseNFO_TMDBURL(t *testing.T) {
	nfoPath := filepath.Join("testdata", "nfo", "movie_url.nfo")
	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO(%q) error: %v", nfoPath, err)
	}

	if result.TMDBID != 603 {
		t.Errorf("TMDBID = %d, want %d", result.TMDBID, 603)
	}
	if !result.HasExternalID() {
		t.Error("HasExternalID() = false, want true")
	}
}

func TestParseNFO_IMDbURL(t *testing.T) {
	nfoPath := filepath.Join("testdata", "nfo", "movie_imdb.nfo")
	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO(%q) error: %v", nfoPath, err)
	}

	if result.IMDbID != "tt0133093" {
		t.Errorf("IMDbID = %q, want %q", result.IMDbID, "tt0133093")
	}
	if !result.HasExternalID() {
		t.Error("HasExternalID() = false, want true")
	}
}

func TestParseNFO_LegacyTags(t *testing.T) {
	// Create a temp NFO with legacy <tmdbid> tag
	content := `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Legacy Movie</title>
  <year>2005</year>
  <tmdbid>12345</tmdbid>
  <imdbid>tt1234567</imdbid>
</movie>`

	dir := t.TempDir()
	nfoPath := filepath.Join(dir, "legacy.nfo")
	if err := os.WriteFile(nfoPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO error: %v", err)
	}

	if result.TMDBID != 12345 {
		t.Errorf("TMDBID = %d, want %d", result.TMDBID, 12345)
	}
	if result.IMDbID != "tt1234567" {
		t.Errorf("IMDbID = %q, want %q", result.IMDbID, "tt1234567")
	}
	if result.Title != "Legacy Movie" {
		t.Errorf("Title = %q, want %q", result.Title, "Legacy Movie")
	}
	if result.Year != 2005 {
		t.Errorf("Year = %d, want %d", result.Year, 2005)
	}
}

func TestParseNFO_BareIMDbID(t *testing.T) {
	dir := t.TempDir()
	nfoPath := filepath.Join(dir, "bare.nfo")
	if err := os.WriteFile(nfoPath, []byte("tt1234567\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO error: %v", err)
	}

	if result.IMDbID != "tt1234567" {
		t.Errorf("IMDbID = %q, want %q", result.IMDbID, "tt1234567")
	}
}

func TestParseNFO_TVDBInURL(t *testing.T) {
	dir := t.TempDir()
	nfoPath := filepath.Join(dir, "tvdb.nfo")
	content := "https://www.thetvdb.com/series/some-show/12345\n"
	if err := os.WriteFile(nfoPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO error: %v", err)
	}

	if result.TVDBID != 12345 {
		t.Errorf("TVDBID = %d, want %d", result.TVDBID, 12345)
	}
}

func TestParseNFO_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	nfoPath := filepath.Join(dir, "empty.nfo")
	if err := os.WriteFile(nfoPath, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO error: %v", err)
	}

	if result.HasExternalID() {
		t.Error("HasExternalID() = true for empty file, want false")
	}
}

func TestParseNFO_MalformedXML(t *testing.T) {
	dir := t.TempDir()
	nfoPath := filepath.Join(dir, "malformed.nfo")
	content := `<movie><title>Broken</title><year>not-a-year</year`
	if err := os.WriteFile(nfoPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO error: %v", err)
	}

	// Should not crash; the result may be partial or empty
	_ = result
}

func TestParseNFO_MixedXMLAndURL(t *testing.T) {
	// A Kodi NFO that also has URLs in comments or trailing text
	dir := t.TempDir()
	nfoPath := filepath.Join(dir, "mixed.nfo")
	content := `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Mixed</title>
  <year>2020</year>
  <uniqueid type="tmdb">999</uniqueid>
</movie>
<!-- https://www.imdb.com/title/tt9999999/ -->`
	if err := os.WriteFile(nfoPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO error: %v", err)
	}

	if result.TMDBID != 999 {
		t.Errorf("TMDBID = %d, want %d", result.TMDBID, 999)
	}
	// IMDb from the text scan should also be picked up
	if result.IMDbID != "tt9999999" {
		t.Errorf("IMDbID = %q, want %q", result.IMDbID, "tt9999999")
	}
}

func TestParseNFO_NonexistentFile(t *testing.T) {
	_, err := ParseNFO("/nonexistent/path/movie.nfo")
	if err == nil {
		t.Error("expected error for nonexistent file, got nil")
	}
}

func TestParseNFO_TMDBTV_URL(t *testing.T) {
	dir := t.TempDir()
	nfoPath := filepath.Join(dir, "tvshow.nfo")
	content := "https://www.themoviedb.org/tv/1396-breaking-bad\n"
	if err := os.WriteFile(nfoPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO error: %v", err)
	}

	if result.TMDBID != 1396 {
		t.Errorf("TMDBID = %d, want %d", result.TMDBID, 1396)
	}
}

func TestNFOResult_HasExternalID(t *testing.T) {
	tests := []struct {
		name   string
		result NFOResult
		want   bool
	}{
		{name: "tmdb set", result: NFOResult{TMDBID: 1}, want: true},
		{name: "tvdb set", result: NFOResult{TVDBID: 1}, want: true},
		{name: "imdb set", result: NFOResult{IMDbID: "tt1234567"}, want: true},
		{name: "none set", result: NFOResult{}, want: false},
		{name: "all set", result: NFOResult{TMDBID: 1, TVDBID: 2, IMDbID: "tt1234567"}, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.result.HasExternalID()
			if got != tt.want {
				t.Errorf("HasExternalID() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestFindNFO(t *testing.T) {
	dir := t.TempDir()

	// Create a "video" file and a matching .nfo
	videoPath := filepath.Join(dir, "movie.mkv")
	nfoPath := filepath.Join(dir, "movie.nfo")
	if err := os.WriteFile(videoPath, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nfoPath, []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := FindNFO(videoPath)
	if got != nfoPath {
		t.Errorf("FindNFO(%q) = %q, want %q", videoPath, got, nfoPath)
	}
}

func TestFindNFO_MovieNFO(t *testing.T) {
	dir := t.TempDir()

	videoPath := filepath.Join(dir, "some-file.mkv")
	movieNFO := filepath.Join(dir, "movie.nfo")
	if err := os.WriteFile(movieNFO, []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := FindNFO(videoPath)
	if got != movieNFO {
		t.Errorf("FindNFO(%q) = %q, want %q", videoPath, got, movieNFO)
	}
}

func TestFindNFO_NoNFO(t *testing.T) {
	dir := t.TempDir()

	videoPath := filepath.Join(dir, "movie.mkv")

	got := FindNFO(videoPath)
	if got != "" {
		t.Errorf("FindNFO(%q) = %q, want empty string", videoPath, got)
	}
}

func TestIsIMDbID(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{name: "valid 7 digit", input: "tt1234567", want: true},
		{name: "valid 8 digit", input: "tt12345678", want: true},
		{name: "too short", input: "tt12345", want: false},
		{name: "no prefix", input: "1234567", want: false},
		{name: "wrong prefix", input: "nm1234567", want: false},
		{name: "empty", input: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isIMDbID(tt.input)
			if got != tt.want {
				t.Errorf("isIMDbID(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseNFO_UniqueIDWithTVDB(t *testing.T) {
	dir := t.TempDir()
	nfoPath := filepath.Join(dir, "tvshow.nfo")
	content := `<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title>Breaking Bad</title>
  <year>2008</year>
  <uniqueid type="tvdb">81189</uniqueid>
  <uniqueid type="tmdb">1396</uniqueid>
  <uniqueid type="imdb">tt0903747</uniqueid>
</tvshow>`
	if err := os.WriteFile(nfoPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := ParseNFO(nfoPath)
	if err != nil {
		t.Fatalf("ParseNFO error: %v", err)
	}

	if result.TVDBID != 81189 {
		t.Errorf("TVDBID = %d, want %d", result.TVDBID, 81189)
	}
	if result.TMDBID != 1396 {
		t.Errorf("TMDBID = %d, want %d", result.TMDBID, 1396)
	}
	if result.IMDbID != "tt0903747" {
		t.Errorf("IMDbID = %q, want %q", result.IMDbID, "tt0903747")
	}
	if result.Title != "Breaking Bad" {
		t.Errorf("Title = %q, want %q", result.Title, "Breaking Bad")
	}
}
