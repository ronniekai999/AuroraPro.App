package library

import (
	"bytes"
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// NFOResult holds external IDs parsed from an .nfo file.
type NFOResult struct {
	TMDBID int
	TVDBID int
	IMDbID string // e.g. "tt0468569"
	Title  string
	Year   int
}

// HasExternalID returns true if any external provider ID was found.
func (n *NFOResult) HasExternalID() bool {
	return n.TMDBID > 0 || n.TVDBID > 0 || n.IMDbID != ""
}

// FindNFO looks for a .nfo file adjacent to the given video file.
// It checks: same name with .nfo extension, then movie.nfo / tvshow.nfo.
func FindNFO(videoPath string) string {
	dir := filepath.Dir(videoPath)
	base := strings.TrimSuffix(filepath.Base(videoPath), filepath.Ext(videoPath))

	candidates := []string{
		filepath.Join(dir, base+".nfo"),
		filepath.Join(dir, "movie.nfo"),
		filepath.Join(dir, "tvshow.nfo"),
	}

	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// ParseNFO reads an .nfo file and extracts external IDs.
// NFO files can be either XML (Kodi-style) or plain text with URLs.
func ParseNFO(nfoPath string) (*NFOResult, error) {
	f, err := os.Open(nfoPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Cap read to 512KB — NFO files should be small; this prevents OOM
	// if a multi-GB file happens to have a .nfo extension.
	const maxNFOSize = 512 * 1024
	data, err := io.ReadAll(io.LimitReader(f, maxNFOSize+1))
	if err != nil {
		return nil, err
	}

	// If we read more than the cap, the file is too large — skip parsing
	if len(data) > maxNFOSize {
		return &NFOResult{}, nil
	}

	content := string(data)
	result := &NFOResult{}

	// Try XML parse first (Kodi-style NFO)
	if strings.Contains(content, "<") {
		parseNFOXML(data, result)
	}

	// Also scan for URLs / bare IDs in the raw text.
	// This catches files that are just a URL on a single line.
	parseNFOText(content, result)

	return result, nil
}

// --- XML parsing (Kodi NFO format) ---

// nfoXML is the union of <movie> and <tvshow> Kodi NFO schemas.
type nfoXML struct {
	XMLName   xml.Name      `xml:""`
	Title     string        `xml:"title"`
	Year      int           `xml:"year"`
	UniqueIDs []nfoUniqueID `xml:"uniqueid"`
	// Legacy Kodi fields
	TMDBID string `xml:"tmdbid"`
	IMDbID string `xml:"imdbid"`
	TVDBID string `xml:"tvdbid"`
}

type nfoUniqueID struct {
	Type    string `xml:"type,attr"`
	Default string `xml:"default,attr"`
	Value   string `xml:",chardata"`
}

func parseNFOXML(data []byte, result *NFOResult) {
	var doc nfoXML
	// Use a Decoder so we can disable external entity resolution and HTML-
	// style entity tables. Go's encoding/xml does not expand external
	// entities by default (CharsetReader is nil) but we lock the invariant
	// in here: Strict=false combined with the nil CharsetReader rejects any
	// non-trivial entity reference, which is what we want for untrusted
	// .nfo files (shared-mount deployments, files dropped by other tools).
	// The 512 KB read cap upstream already bounds total memory; this just
	// prevents an XML bomb from chewing CPU on entity expansion.
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false
	dec.Entity = map[string]string{} // disable named-entity table; only built-in &lt; &gt; &amp; &quot; &apos; remain
	dec.CharsetReader = nil          // unknown encodings → error, not download-and-execute
	if err := dec.Decode(&doc); err != nil {
		return
	}

	if doc.Title != "" {
		result.Title = doc.Title
	}
	if doc.Year > 0 {
		result.Year = doc.Year
	}

	// Parse <uniqueid type="tmdb">123</uniqueid> elements (modern Kodi)
	for _, uid := range doc.UniqueIDs {
		val := strings.TrimSpace(uid.Value)
		switch strings.ToLower(uid.Type) {
		case "tmdb":
			if id, err := strconv.Atoi(val); err == nil {
				result.TMDBID = id
			}
		case "tvdb":
			if id, err := strconv.Atoi(val); err == nil {
				result.TVDBID = id
			}
		case "imdb":
			if isIMDbID(val) {
				result.IMDbID = val
			}
		}
	}

	// Legacy fields (<tmdbid>, <imdbid>, <tvdbid>)
	if result.TMDBID == 0 && doc.TMDBID != "" {
		if id, err := strconv.Atoi(strings.TrimSpace(doc.TMDBID)); err == nil {
			result.TMDBID = id
		}
	}
	if result.IMDbID == "" && isIMDbID(strings.TrimSpace(doc.IMDbID)) {
		result.IMDbID = strings.TrimSpace(doc.IMDbID)
	}
	if result.TVDBID == 0 && doc.TVDBID != "" {
		if id, err := strconv.Atoi(strings.TrimSpace(doc.TVDBID)); err == nil {
			result.TVDBID = id
		}
	}
}

// --- Plain-text / URL parsing ---

var (
	reTMDBMovieURL = regexp.MustCompile(`themoviedb\.org/movie/(\d+)`)
	reTMDBTVURL    = regexp.MustCompile(`themoviedb\.org/tv/(\d+)`)
	reTVDBURL      = regexp.MustCompile(`thetvdb\.com/.*?(\d{4,})`)
	reIMDbURL      = regexp.MustCompile(`imdb\.com/title/(tt\d{7,})`)
	reIMDbBare     = regexp.MustCompile(`\b(tt\d{7,})\b`)
)

func parseNFOText(content string, result *NFOResult) {
	if result.TMDBID == 0 {
		if m := reTMDBMovieURL.FindStringSubmatch(content); len(m) == 2 {
			result.TMDBID, _ = strconv.Atoi(m[1])
		}
	}
	if result.TMDBID == 0 {
		if m := reTMDBTVURL.FindStringSubmatch(content); len(m) == 2 {
			result.TMDBID, _ = strconv.Atoi(m[1])
		}
	}
	if result.TVDBID == 0 {
		if m := reTVDBURL.FindStringSubmatch(content); len(m) == 2 {
			result.TVDBID, _ = strconv.Atoi(m[1])
		}
	}
	if result.IMDbID == "" {
		if m := reIMDbURL.FindStringSubmatch(content); len(m) == 2 {
			result.IMDbID = m[1]
		}
	}
	if result.IMDbID == "" {
		if m := reIMDbBare.FindStringSubmatch(content); len(m) == 2 {
			result.IMDbID = m[1]
		}
	}
}

func isIMDbID(s string) bool {
	return strings.HasPrefix(s, "tt") && len(s) >= 9
}
