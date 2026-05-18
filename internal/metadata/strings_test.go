package metadata

import (
	"testing"
)

func TestLevenshteinDistance(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
		want int
	}{
		{name: "identical strings", a: "hello", b: "hello", want: 0},
		{name: "one char different", a: "hello", b: "hallo", want: 1},
		{name: "one insertion", a: "hello", b: "helloo", want: 1},
		{name: "one deletion", a: "hello", b: "helo", want: 1},
		{name: "completely different", a: "abc", b: "xyz", want: 3},
		{name: "empty first", a: "", b: "hello", want: 5},
		{name: "empty second", a: "hello", b: "", want: 5},
		{name: "both empty", a: "", b: "", want: 0},
		{name: "single char match", a: "a", b: "a", want: 0},
		{name: "single char diff", a: "a", b: "b", want: 1},
		{name: "prefix", a: "abc", b: "abcdef", want: 3},
		{name: "suffix", a: "def", b: "abcdef", want: 3},
		{name: "transposition", a: "ab", b: "ba", want: 2},
		{name: "unicode characters", a: "cafe", b: "caf\u00e9", want: 1},
		{name: "unicode identical", a: "\u00e9l\u00e8ve", b: "\u00e9l\u00e8ve", want: 0},
		{name: "unicode mixed", a: "naive", b: "na\u00efve", want: 1},
		{name: "longer strings", a: "sitting", b: "kitten", want: 3},
		{name: "classic example", a: "saturday", b: "sunday", want: 3},
		{name: "case sensitive", a: "Hello", b: "hello", want: 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := levenshteinDistance(tt.a, tt.b)
			if got != tt.want {
				t.Errorf("levenshteinDistance(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestLevenshteinDistance_Symmetry(t *testing.T) {
	// Levenshtein distance should be symmetric
	pairs := [][2]string{
		{"hello", "world"},
		{"abc", "xyz"},
		{"test", "testing"},
		{"", "nonempty"},
	}

	for _, pair := range pairs {
		d1 := levenshteinDistance(pair[0], pair[1])
		d2 := levenshteinDistance(pair[1], pair[0])
		if d1 != d2 {
			t.Errorf("levenshteinDistance(%q, %q) = %d, but reverse = %d (not symmetric)",
				pair[0], pair[1], d1, d2)
		}
	}
}

func TestLevenshteinSimilarity(t *testing.T) {
	tests := []struct {
		name    string
		a       string
		b       string
		wantMin float64
		wantMax float64
	}{
		{name: "identical", a: "hello", b: "hello", wantMin: 1.0, wantMax: 1.0},
		{name: "both empty", a: "", b: "", wantMin: 1.0, wantMax: 1.0},
		{name: "completely different", a: "abc", b: "xyz", wantMin: 0.0, wantMax: 0.01},
		{name: "one off", a: "hello", b: "hallo", wantMin: 0.7, wantMax: 0.9},
		{name: "empty vs nonempty", a: "", b: "hello", wantMin: 0.0, wantMax: 0.01},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := levenshteinSimilarity(tt.a, tt.b)
			if got < tt.wantMin || got > tt.wantMax {
				t.Errorf("levenshteinSimilarity(%q, %q) = %f, want in [%f, %f]",
					tt.a, tt.b, got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestEqFold(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
		want bool
	}{
		{name: "exact match", a: "hello", b: "hello", want: true},
		{name: "case diff", a: "Hello", b: "hello", want: true},
		{name: "all caps", a: "HELLO", b: "hello", want: true},
		{name: "different strings", a: "hello", b: "world", want: false},
		{name: "both empty", a: "", b: "", want: true},
		{name: "whitespace trim", a: "  hello  ", b: "hello", want: true},
		{name: "both with whitespace", a: " Hello ", b: " hello ", want: true},
		{name: "substring not equal", a: "hello", b: "hell", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := eqFold(tt.a, tt.b)
			if got != tt.want {
				t.Errorf("eqFold(%q, %q) = %v, want %v", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestContainsFold(t *testing.T) {
	tests := []struct {
		name     string
		haystack string
		needle   string
		want     bool
	}{
		{name: "exact match", haystack: "hello", needle: "hello", want: true},
		{name: "substring", haystack: "hello world", needle: "world", want: true},
		{name: "case insensitive", haystack: "Hello World", needle: "hello", want: true},
		{name: "not found", haystack: "hello", needle: "world", want: false},
		{name: "empty needle", haystack: "hello", needle: "", want: true},
		{name: "empty haystack", haystack: "", needle: "hello", want: false},
		{name: "both empty", haystack: "", needle: "", want: true},
		{name: "whitespace trim", haystack: "  Hello World  ", needle: " world ", want: true},
		{name: "needle longer", haystack: "hi", needle: "hello world", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := containsFold(tt.haystack, tt.needle)
			if got != tt.want {
				t.Errorf("containsFold(%q, %q) = %v, want %v", tt.haystack, tt.needle, got, tt.want)
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
		{name: "underscores to spaces", input: "The_Dark_Knight", want: "The Dark Knight"},
		{name: "mixed", input: "The.Dark_Knight.Returns", want: "The Dark Knight Returns"},
		{name: "collapse spaces", input: "Title   with    spaces", want: "Title with spaces"},
		{name: "trim whitespace", input: "  Title  ", want: "Title"},
		{name: "empty string", input: "", want: ""},
		{name: "already clean", input: "Already Clean Title", want: "Already Clean Title"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CleanTitle(tt.input)
			if got != tt.want {
				t.Errorf("CleanTitle(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
