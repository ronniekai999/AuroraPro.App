package library

import (
	"testing"
)

func BenchmarkParseMoviePath(b *testing.B) {
	paths := []string{
		"Movies/The.Dark.Knight.2008.1080p.BluRay.x265/The.Dark.Knight.2008.1080p.BluRay.x265.mkv",
		"Movies/Movie (2023)/Movie (2023).mp4",
		"Movies/Some.Movie.720p/Some.Movie.720p.mkv",
		"Movies/Inception (2010)/Inception.2010.2160p.UHD.BluRay.mkv",
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ParseMoviePath(paths[i%len(paths)])
	}
}

func BenchmarkParseTVPath(b *testing.B) {
	paths := []string{
		"TV Shows/Breaking Bad/Season 01/Breaking.Bad.S01E01.Pilot.1080p.mkv",
		"TV Shows/Show Name/Season 02/S02E05.mkv",
		"TV Shows/My Show/Season 01/Show.1x03.mkv",
		"TV Shows/The Office/Season 03/the.office.s03e12.720p.mkv",
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ParseTVPath(paths[i%len(paths)])
	}
}

func BenchmarkGenerateSortTitle(b *testing.B) {
	titles := []string{
		"The Matrix",
		"A Beautiful Mind",
		"An Officer and a Gentleman",
		"Inception",
		"The Dark Knight",
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		GenerateSortTitle(titles[i%len(titles)])
	}
}

func BenchmarkIsVideoFile(b *testing.B) {
	paths := []string{
		"/media/movie.mkv",
		"/media/movie.mp4",
		"/media/movie.srt",
		"/media/movie.nfo",
		"/media/movie.avi",
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		IsVideoFile(paths[i%len(paths)])
	}
}

func BenchmarkExtractTitleYear(b *testing.B) {
	inputs := []string{
		"The.Dark.Knight.2008.1080p.BluRay",
		"Movie (2023)",
		"Some.Movie.Without.Year.720p",
		"Inception.2010.UHD",
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		extractTitleYear(inputs[i%len(inputs)])
	}
}
