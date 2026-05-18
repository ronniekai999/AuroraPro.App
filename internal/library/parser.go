package library

import (
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Supported video extensions
var videoExtensions = map[string]bool{
	".mkv": true, ".mp4": true, ".avi": true, ".mov": true,
	".wmv": true, ".flv": true, ".webm": true, ".m4v": true,
	".mpg": true, ".mpeg": true, ".ts": true, ".m2ts": true,
}

func IsVideoFile(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return videoExtensions[ext]
}

// ParsedFile holds structured data extracted from a media file path
type ParsedFile struct {
	Title      string
	Year       int
	Season     int
	Episode    int
	Resolution string
	IsTV       bool
	FilePath   string
}

var (
	// TV Show patterns
	// S01E02, s01e02, S1E2
	reSeasonEpisode = regexp.MustCompile(`(?i)[Ss](\d{1,2})[Ee](\d{1,3})`)
	// 1x02, 01x02
	reSeasonX = regexp.MustCompile(`(\d{1,2})[xX](\d{1,3})`)

	// Year pattern: (2023) or .2023. or _2023_
	reYear = regexp.MustCompile(`[\.\s_\(]*((?:19|20)\d{2})[\.\s_\)]*`)

	// Resolution patterns
	reResolution = regexp.MustCompile(`(?i)(2160p|1080p|720p|480p|4[kK])`)

	// Quality/edition suffixes in brackets to strip from folder names before title matching.
	// Matches [4K], (UHD), [2160p], [1080p], [HDR], [REMUX], [3D], etc.
	reQualitySuffix = regexp.MustCompile(`(?i)\s*[\[\(]\s*(4K|UHD|2160p|1080p|720p|480p|HDR|HDR10\+?|DV|Dolby\s*Vision|REMUX|3D)\s*[\]\)]`)

	// Characters to strip from titles
	reClean = regexp.MustCompile(`[\.\-_]+`)
	reMultiSpace = regexp.MustCompile(`\s{2,}`)
)

// ParseMoviePath parses a movie file path
// Expected structure: Movies/Title (Year)/filename.ext
func ParseMoviePath(filePath string) ParsedFile {
	parsed := ParsedFile{
		FilePath: filePath,
		IsTV:     false,
	}

	dir := filepath.Dir(filePath)
	folderName := stripQualitySuffix(filepath.Base(dir))

	// Try to extract title and year from folder name first
	parsed.Title, parsed.Year = extractTitleYear(folderName)

	// If folder didn't yield results, try the filename — but strip the
	// quality suffix here too. Without this, "Inception (2010) [4K].mkv" in
	// a bare-Movies-folder layout yields title "Inception [4K]", which then
	// creates a *separate* media_items row from "Inception" elsewhere — the
	// exact cross-library duplicate bug we already fixed for the folder path.
	if parsed.Title == "" {
		baseName := strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))
		parsed.Title, parsed.Year = extractTitleYear(stripQualitySuffix(baseName))
	}

	// Extract resolution from filename
	if match := reResolution.FindString(filepath.Base(filePath)); match != "" {
		parsed.Resolution = strings.ToLower(match)
		if parsed.Resolution == "4k" {
			parsed.Resolution = "2160p"
		}
	}

	return parsed
}

// ParseTVPath parses a TV show episode path
// Expected: TV Shows/Show Name/Season 01/Show.Name.S01E02.mkv
func ParseTVPath(filePath string) ParsedFile {
	parsed := ParsedFile{
		FilePath: filePath,
		IsTV:     true,
	}

	baseName := strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))

	// Extract season and episode from filename
	if matches := reSeasonEpisode.FindStringSubmatch(baseName); len(matches) == 3 {
		parsed.Season, _ = strconv.Atoi(matches[1])
		parsed.Episode, _ = strconv.Atoi(matches[2])
	} else if matches := reSeasonX.FindStringSubmatch(baseName); len(matches) == 3 {
		parsed.Season, _ = strconv.Atoi(matches[1])
		parsed.Episode, _ = strconv.Atoi(matches[2])
	}

	// Extract show title from directory structure
	// Walk up to find the show folder (parent of Season XX folder)
	parts := strings.Split(filepath.ToSlash(filePath), "/")
	for i := len(parts) - 2; i >= 0; i-- {
		lower := strings.ToLower(parts[i])
		if strings.HasPrefix(lower, "season") || strings.HasPrefix(lower, "specials") {
			// The folder above this is the show name
			if i > 0 {
				parsed.Title = stripQualitySuffix(parts[i-1])
				break
			}
		}
	}

	// Fallback: extract title from filename (everything before SxxExx)
	if parsed.Title == "" {
		if idx := reSeasonEpisode.FindStringIndex(baseName); idx != nil {
			parsed.Title = cleanTitle(baseName[:idx[0]])
		}
	}

	// Extract year from show folder name
	if parsed.Title != "" {
		title, year := extractTitleYear(parsed.Title)
		if title != "" {
			parsed.Title = title
		}
		parsed.Year = year
	}

	// Resolution
	if match := reResolution.FindString(baseName); match != "" {
		parsed.Resolution = strings.ToLower(match)
		if parsed.Resolution == "4k" {
			parsed.Resolution = "2160p"
		}
	}

	return parsed
}

func extractTitleYear(s string) (string, int) {
	var year int
	yearIdx := -1

	// Find all year candidates. When the string starts with a 4-digit number
	// that looks like a year (e.g. "2012 (2009)"), the leading number is the
	// title, not the year. Prefer a later match over one at position 0.
	allMatches := reYear.FindAllStringSubmatchIndex(s, -1)
	for _, loc := range allMatches {
		// loc[2]:loc[3] is the capture group (the 4-digit year)
		y, _ := strconv.Atoi(s[loc[2]:loc[3]])
		if y < 1900 || y > 2099 {
			continue
		}
		if yearIdx == -1 {
			year = y
			yearIdx = loc[2]
		} else if loc[2] > 0 {
			// Later candidate not at position 0 — prefer it
			year = y
			yearIdx = loc[2]
		}
	}

	// If the only year candidate is at position 0, it IS the title (e.g. "2012")
	if year > 0 && yearIdx == 0 {
		year = 0
		yearIdx = -1
	}

	// Remove year and everything after it for the title
	title := s
	if year > 0 && yearIdx > 0 {
		title = title[:yearIdx]
	}

	title = cleanTitle(title)
	title = strings.TrimRight(title, " (")
	return title, year
}

// stripQualitySuffix removes bracketed quality tags like [4K], (UHD), [2160p]
// from folder names so "Inception [4K]" matches "Inception".
func stripQualitySuffix(s string) string {
	return strings.TrimSpace(reQualitySuffix.ReplaceAllString(s, ""))
}

func cleanTitle(s string) string {
	s = reClean.ReplaceAllString(s, " ")
	s = reMultiSpace.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	return s
}

// GenerateSortTitle creates a sort-friendly version of a title
// Strips leading "The ", "A ", "An " for proper alphabetical sorting
func GenerateSortTitle(title string) string {
	lower := strings.ToLower(title)
	for _, prefix := range []string{"the ", "a ", "an "} {
		if strings.HasPrefix(lower, prefix) {
			return strings.TrimSpace(title[len(prefix):])
		}
	}
	return title
}
