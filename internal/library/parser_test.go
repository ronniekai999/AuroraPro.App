package library

import (
	"testing"
)

func TestParseMoviePath(t *testing.T) {
	tests := []struct {
		name      string
		path      string
		wantTitle string
		wantYear  int
		wantRes   string
	}{
		{
			name:      "dot-separated with year and resolution",
			path:      "Movies/The.Dark.Knight.2008.1080p.BluRay.x265/The.Dark.Knight.2008.1080p.BluRay.x265.mkv",
			wantTitle: "The Dark Knight",
			wantYear:  2008,
			wantRes:   "1080p",
		},
		{
			name:      "parenthesized year",
			path:      "Movies/Movie (2023)/Movie (2023).mp4",
			wantTitle: "Movie",
			wantYear:  2023,
			wantRes:   "",
		},
		{
			name:      "720p resolution no year",
			path:      "Movies/Some Movie/Some.Movie.720p.mkv",
			wantTitle: "Some Movie",
			wantYear:  0,
			wantRes:   "720p",
		},
		{
			name:      "4K resolution normalized to 2160p",
			path:      "Movies/Big.Hero.6.2014.4K/Big.Hero.6.2014.4K.mkv",
			wantTitle: "Big Hero 6",
			wantYear:  2014,
			wantRes:   "2160p",
		},
		{
			name:      "2160p resolution",
			path:      "Movies/Dune.2021.2160p/Dune.2021.2160p.mkv",
			wantTitle: "Dune",
			wantYear:  2021,
			wantRes:   "2160p",
		},
		{
			name:      "480p resolution",
			path:      "Movies/Old.Movie.1995.480p/Old.Movie.1995.480p.avi",
			wantTitle: "Old Movie",
			wantYear:  1995,
			wantRes:   "480p",
		},
		{
			name:      "title extracted from folder when filename is generic",
			path:      "Movies/Inception (2010)/movie.mkv",
			wantTitle: "Inception",
			wantYear:  2010,
			wantRes:   "",
		},
		{
			name:      "underscore separated title",
			path:      "Movies/The_Shawshank_Redemption_1994/The_Shawshank_Redemption_1994.mkv",
			wantTitle: "The Shawshank Redemption",
			wantYear:  1994,
			wantRes:   "",
		},
		{
			name:      "spaces in folder name",
			path:      "Movies/The Grand Budapest Hotel 2014/movie.mp4",
			wantTitle: "The Grand Budapest Hotel",
			wantYear:  2014,
			wantRes:   "",
		},
		{
			name:      "isTV is false for movies",
			path:      "Movies/Test Movie (2020)/test.mkv",
			wantTitle: "Test Movie",
			wantYear:  2020,
			wantRes:   "",
		},
		{
			name:      "4K bracket folder with year strips quality suffix",
			path:      "Movies/Inception (2010) [4K]/Inception.2010.2160p.mkv",
			wantTitle: "Inception",
			wantYear:  2010,
			wantRes:   "2160p",
		},
		{
			name:      "4K bracket folder without year strips quality suffix",
			path:      "Movies/Inception [4K]/Inception.2160p.mkv",
			wantTitle: "Inception",
			wantYear:  0,
			wantRes:   "2160p",
		},
		{
			name:      "UHD bracket folder strips quality suffix",
			path:      "Movies/Dune (2021) [UHD]/Dune.2021.2160p.mkv",
			wantTitle: "Dune",
			wantYear:  2021,
			wantRes:   "2160p",
		},
		{
			name:      "2160p bracket folder strips quality suffix",
			path:      "Movies/Movie (2020) [2160p]/movie.mkv",
			wantTitle: "Movie",
			wantYear:  2020,
			wantRes:   "",
		},
		{
			name:      "HDR bracket folder strips quality suffix",
			path:      "Movies/Movie (2020) [HDR]/movie.mkv",
			wantTitle: "Movie",
			wantYear:  2020,
			wantRes:   "",
		},
		{
			name:      "REMUX paren folder strips quality suffix",
			path:      "Movies/Movie (2020) (REMUX)/movie.mkv",
			wantTitle: "Movie",
			wantYear:  2020,
			wantRes:   "",
		},
		{
			name:      "numeric movie title 2012 with year",
			path:      "Movies/2012 (2009)/2012.2009.1080p.mkv",
			wantTitle: "2012",
			wantYear:  2009,
			wantRes:   "1080p",
		},
		{
			name:      "numeric movie title 1917 with year",
			path:      "Movies/1917 (2019)/1917.2019.1080p.mkv",
			wantTitle: "1917",
			wantYear:  2019,
			wantRes:   "1080p",
		},
		{
			name:      "bare numeric movie title no year",
			path:      "Movies/2012/2012.mkv",
			wantTitle: "2012",
			wantYear:  0,
			wantRes:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseMoviePath(tt.path)

			if got.Title != tt.wantTitle {
				t.Errorf("Title = %q, want %q", got.Title, tt.wantTitle)
			}
			if got.Year != tt.wantYear {
				t.Errorf("Year = %d, want %d", got.Year, tt.wantYear)
			}
			if got.Resolution != tt.wantRes {
				t.Errorf("Resolution = %q, want %q", got.Resolution, tt.wantRes)
			}
			if got.IsTV {
				t.Error("IsTV = true, want false")
			}
			if got.FilePath != tt.path {
				t.Errorf("FilePath = %q, want %q", got.FilePath, tt.path)
			}
		})
	}
}

func TestParseTVPath(t *testing.T) {
	tests := []struct {
		name        string
		path        string
		wantTitle   string
		wantSeason  int
		wantEpisode int
		wantRes     string
	}{
		{
			name:        "S01E01 format with dots",
			path:        "TV Shows/Breaking Bad/Season 01/Breaking.Bad.S01E01.Pilot.1080p.mkv",
			wantTitle:   "Breaking Bad",
			wantSeason:  1,
			wantEpisode: 1,
			wantRes:     "1080p",
		},
		{
			name:        "season folder with SxxExx filename",
			path:        "TV Shows/Show Name/Season 02/S02E05.mkv",
			wantTitle:   "Show Name",
			wantSeason:  2,
			wantEpisode: 5,
			wantRes:     "",
		},
		{
			name:        "1x03 format (fallback from SxxExx)",
			path:        "TV Shows/My Show/Season 01/Show.1x03.mkv",
			wantTitle:   "My Show",
			wantSeason:  1,
			wantEpisode: 3,
			wantRes:     "",
		},
		{
			name:        "lowercase sxxexx",
			path:        "TV Shows/The Office/Season 03/the.office.s03e12.720p.mkv",
			wantTitle:   "The Office",
			wantSeason:  3,
			wantEpisode: 12,
			wantRes:     "720p",
		},
		{
			name:        "double digit season and episode",
			path:        "TV Shows/Long Show/Season 12/Long.Show.S12E24.mkv",
			wantTitle:   "Long Show",
			wantSeason:  12,
			wantEpisode: 24,
			wantRes:     "",
		},
		{
			name:        "three digit episode number",
			path:        "TV Shows/Anime Show/Season 01/Anime.Show.S01E120.mkv",
			wantTitle:   "Anime Show",
			wantSeason:  1,
			wantEpisode: 120,
			wantRes:     "",
		},
		{
			name:        "title extracted from filename when no season folder",
			path:        "Breaking.Bad.S01E01.Pilot.1080p.mkv",
			wantTitle:   "Breaking Bad",
			wantSeason:  1,
			wantEpisode: 1,
			wantRes:     "1080p",
		},
		{
			name:        "isTV is true for TV paths",
			path:        "TV Shows/Test/Season 01/S01E01.mkv",
			wantTitle:   "Test",
			wantSeason:  1,
			wantEpisode: 1,
			wantRes:     "",
		},
		{
			name:        "specials folder",
			path:        "TV Shows/Some Show/Specials/S00E01.mkv",
			wantTitle:   "Some Show",
			wantSeason:  0,
			wantEpisode: 1,
			wantRes:     "",
		},
		{
			name:        "4K bracket show folder strips quality suffix",
			path:        "TV Shows/Breaking Bad [4K]/Season 01/Breaking.Bad.S01E01.2160p.mkv",
			wantTitle:   "Breaking Bad",
			wantSeason:  1,
			wantEpisode: 1,
			wantRes:     "2160p",
		},
		{
			name:        "UHD bracket show folder strips quality suffix",
			path:        "TV Shows/The Office [UHD]/Season 03/S03E12.2160p.mkv",
			wantTitle:   "The Office",
			wantSeason:  3,
			wantEpisode: 12,
			wantRes:     "2160p",
		},
		{
			name:        "2160p paren show folder strips quality suffix",
			path:        "TV Shows/My Show (2160p)/Season 01/S01E01.mkv",
			wantTitle:   "My Show",
			wantSeason:  1,
			wantEpisode: 1,
			wantRes:     "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseTVPath(tt.path)

			if got.Title != tt.wantTitle {
				t.Errorf("Title = %q, want %q", got.Title, tt.wantTitle)
			}
			if got.Season != tt.wantSeason {
				t.Errorf("Season = %d, want %d", got.Season, tt.wantSeason)
			}
			if got.Episode != tt.wantEpisode {
				t.Errorf("Episode = %d, want %d", got.Episode, tt.wantEpisode)
			}
			if got.Resolution != tt.wantRes {
				t.Errorf("Resolution = %q, want %q", got.Resolution, tt.wantRes)
			}
			if !got.IsTV {
				t.Error("IsTV = false, want true")
			}
		})
	}
}

func TestGenerateSortTitle(t *testing.T) {
	tests := []struct {
		name  string
		title string
		want  string
	}{
		{name: "strip The", title: "The Matrix", want: "Matrix"},
		{name: "strip A", title: "A Beautiful Mind", want: "Beautiful Mind"},
		{name: "strip An", title: "An Officer and a Gentleman", want: "Officer and a Gentleman"},
		{name: "no prefix", title: "Inception", want: "Inception"},
		{name: "The in middle", title: "Into The Wild", want: "Into The Wild"},
		{name: "lowercase the", title: "the godfather", want: "godfather"},
		{name: "case insensitive THE", title: "THE DARK KNIGHT", want: "DARK KNIGHT"},
		{name: "empty string", title: "", want: ""},
		{name: "just The", title: "The", want: "The"},
		{name: "A with no trailing space match", title: "Alien", want: "Alien"},
		{name: "An with no trailing space match", title: "Ant-Man", want: "Ant-Man"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GenerateSortTitle(tt.title)
			if got != tt.want {
				t.Errorf("GenerateSortTitle(%q) = %q, want %q", tt.title, got, tt.want)
			}
		})
	}
}

func TestIsVideoFile(t *testing.T) {
	tests := []struct {
		name string
		path string
		want bool
	}{
		{name: "mkv", path: "/media/movie.mkv", want: true},
		{name: "mp4", path: "/media/movie.mp4", want: true},
		{name: "avi", path: "/media/movie.avi", want: true},
		{name: "mov", path: "/media/movie.mov", want: true},
		{name: "wmv", path: "/media/movie.wmv", want: true},
		{name: "flv", path: "/media/movie.flv", want: true},
		{name: "webm", path: "/media/movie.webm", want: true},
		{name: "m4v", path: "/media/movie.m4v", want: true},
		{name: "mpg", path: "/media/movie.mpg", want: true},
		{name: "mpeg", path: "/media/movie.mpeg", want: true},
		{name: "ts", path: "/media/movie.ts", want: true},
		{name: "m2ts", path: "/media/movie.m2ts", want: true},
		{name: "uppercase MKV", path: "/media/movie.MKV", want: true},
		{name: "uppercase MP4", path: "/media/movie.MP4", want: true},
		{name: "mixed case Mp4", path: "/media/movie.Mp4", want: true},
		{name: "srt subtitle", path: "/media/movie.srt", want: false},
		{name: "nfo file", path: "/media/movie.nfo", want: false},
		{name: "jpg image", path: "/media/poster.jpg", want: false},
		{name: "txt file", path: "/media/readme.txt", want: false},
		{name: "no extension", path: "/media/movie", want: false},
		{name: "hidden file", path: "/media/.movie.mkv", want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsVideoFile(tt.path)
			if got != tt.want {
				t.Errorf("IsVideoFile(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestStripQualitySuffix(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "4K in brackets", input: "Inception [4K]", want: "Inception"},
		{name: "UHD in brackets", input: "Movie [UHD]", want: "Movie"},
		{name: "2160p in brackets", input: "Movie [2160p]", want: "Movie"},
		{name: "1080p in brackets", input: "Movie [1080p]", want: "Movie"},
		{name: "720p in brackets", input: "Movie [720p]", want: "Movie"},
		{name: "HDR in parens", input: "Movie (HDR)", want: "Movie"},
		{name: "HDR10 in brackets", input: "Movie [HDR10]", want: "Movie"},
		{name: "REMUX in brackets", input: "Movie [REMUX]", want: "Movie"},
		{name: "3D in brackets", input: "Movie [3D]", want: "Movie"},
		{name: "case insensitive 4k", input: "Movie [4k]", want: "Movie"},
		{name: "case insensitive uhd", input: "Movie [uhd]", want: "Movie"},
		{name: "with year before suffix", input: "Movie (2020) [4K]", want: "Movie (2020)"},
		{name: "no suffix", input: "Movie (2020)", want: "Movie (2020)"},
		{name: "no brackets just 4K", input: "Movie 4K", want: "Movie 4K"},
		{name: "empty string", input: "", want: ""},
		{name: "multiple suffixes", input: "Movie [4K] [HDR]", want: "Movie"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripQualitySuffix(tt.input)
			if got != tt.want {
				t.Errorf("stripQualitySuffix(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestCleanTitle(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "dots to spaces", input: "The.Dark.Knight", want: "The Dark Knight"},
		{name: "dashes to spaces", input: "The-Dark-Knight", want: "The Dark Knight"},
		{name: "underscores to spaces", input: "The_Dark_Knight", want: "The Dark Knight"},
		{name: "mixed separators", input: "The.Dark-Knight_Returns", want: "The Dark Knight Returns"},
		{name: "trailing whitespace", input: "  Title  ", want: "Title"},
		{name: "multiple dots", input: "Title...More", want: "Title More"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cleanTitle(tt.input)
			if got != tt.want {
				t.Errorf("cleanTitle(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestExtractTitleYear(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantTitle string
		wantYear  int
	}{
		{name: "parens year", input: "Movie (2023)", wantTitle: "Movie", wantYear: 2023},
		{name: "dot year", input: "Movie.2008.1080p", wantTitle: "Movie", wantYear: 2008},
		{name: "no year", input: "Some Movie", wantTitle: "Some Movie", wantYear: 0},
		{name: "year at boundary 1900", input: "Old.1900", wantTitle: "Old", wantYear: 1900},
		{name: "year at boundary 2099", input: "Future.2099", wantTitle: "Future", wantYear: 2099},
		{name: "numeric title with year in parens", input: "2012 (2009)", wantTitle: "2012", wantYear: 2009},
		{name: "numeric title with dot year", input: "1917.2019.1080p", wantTitle: "1917", wantYear: 2019},
		{name: "numeric title only", input: "2012", wantTitle: "2012", wantYear: 0},
		{name: "numeric title no year parens", input: "1984", wantTitle: "1984", wantYear: 0},
		{name: "2001 with subtitle and year", input: "2001 A Space Odyssey (1968)", wantTitle: "2001 A Space Odyssey", wantYear: 1968},
		{name: "2001 colon with year", input: "2001: A Space Odyssey (1968)", wantTitle: "2001: A Space Odyssey", wantYear: 1968},
		{name: "blade runner 2049 with year", input: "Blade Runner 2049 (2017)", wantTitle: "Blade Runner 2049", wantYear: 2017},
		{name: "two year-range numbers dot sep", input: "1984.2010.BluRay", wantTitle: "1984", wantYear: 2010},
		{name: "short numeric title 300", input: "300 (2006)", wantTitle: "300", wantYear: 2006},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			title, year := extractTitleYear(tt.input)
			if title != tt.wantTitle {
				t.Errorf("title = %q, want %q", title, tt.wantTitle)
			}
			if year != tt.wantYear {
				t.Errorf("year = %d, want %d", year, tt.wantYear)
			}
		})
	}
}
