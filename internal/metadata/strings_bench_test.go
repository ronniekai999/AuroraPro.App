package metadata

import (
	"strings"
	"testing"
)

func BenchmarkLevenshteinDistance_Short(b *testing.B) {
	a := "hello"
	s := "hallo"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		levenshteinDistance(a, s)
	}
}

func BenchmarkLevenshteinDistance_Medium(b *testing.B) {
	a := "The Dark Knight Rises"
	s := "The Dark Knight Returns"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		levenshteinDistance(a, s)
	}
}

func BenchmarkLevenshteinDistance_Long(b *testing.B) {
	a := strings.Repeat("abcdefghij", 10) // 100 chars
	s := strings.Repeat("abcdefghik", 10) // 100 chars, differs by 1 char per 10
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		levenshteinDistance(a, s)
	}
}

func BenchmarkLevenshteinDistance_VeryLong(b *testing.B) {
	a := strings.Repeat("the quick brown fox ", 25) // ~500 chars
	s := strings.Repeat("the quick brown dog ", 25)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		levenshteinDistance(a, s)
	}
}

func BenchmarkLevenshteinDistance_Identical(b *testing.B) {
	a := "The Shawshank Redemption"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		levenshteinDistance(a, a)
	}
}

func BenchmarkLevenshteinSimilarity(b *testing.B) {
	a := "The Dark Knight"
	s := "The Dark Knigh"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		levenshteinSimilarity(a, s)
	}
}

func BenchmarkEqFold(b *testing.B) {
	a := "The Dark Knight"
	s := "the dark knight"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		eqFold(a, s)
	}
}

func BenchmarkContainsFold(b *testing.B) {
	haystack := "The Dark Knight Rises: A Christopher Nolan Film"
	needle := "dark knight"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		containsFold(haystack, needle)
	}
}

func BenchmarkCleanTitle(b *testing.B) {
	titles := []string{
		"The.Dark.Knight.2008.1080p.BluRay.x265",
		"Movie_Name_With_Underscores",
		"Already Clean Title",
		"Dots.And_Mixed.Separators-Everywhere",
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		CleanTitle(titles[i%len(titles)])
	}
}
