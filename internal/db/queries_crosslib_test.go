package db

import (
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

func TestMetadataRichness(t *testing.T) {
	tests := []struct {
		name    string
		item    *models.MediaItem
		wantMin int // minimum expected score
		wantMax int // maximum expected score
	}{
		{
			name:    "empty item",
			item:    &models.MediaItem{},
			wantMin: 0,
			wantMax: 0,
		},
		{
			name: "fully populated",
			item: &models.MediaItem{
				Overview:      "A movie about...",
				PosterPath:    "/abc.jpg",
				BackdropPath:  "/bg.jpg",
				Rating:        8.5,
				RuntimeMin:    120,
				ContentRating: "PG-13",
				Year:          2020,
				Genres:        []string{"Action", "Sci-Fi"},
			},
			wantMin: 14, // 3+3+2+2+1+1+1+1
			wantMax: 14,
		},
		{
			name: "partial - poster and overview only",
			item: &models.MediaItem{
				Overview:   "A movie",
				PosterPath: "/abc.jpg",
			},
			wantMin: 6, // 3+3
			wantMax: 6,
		},
		{
			name: "partial - rating and year",
			item: &models.MediaItem{
				Rating: 7.0,
				Year:   2021,
			},
			wantMin: 3, // 2+1
			wantMax: 3,
		},
		{
			name: "zero rating does not count",
			item: &models.MediaItem{
				Rating: 0.0,
				Year:   2021,
			},
			wantMin: 1,
			wantMax: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := metadataRichness(tt.item)
			if got < tt.wantMin || got > tt.wantMax {
				t.Errorf("metadataRichness() = %d, want between %d and %d", got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestMetadataRichness_Ordering(t *testing.T) {
	// The richer item should always score higher
	rich := &models.MediaItem{
		Overview:      "Full overview",
		PosterPath:    "/poster.jpg",
		BackdropPath:  "/bg.jpg",
		Rating:        8.0,
		RuntimeMin:    120,
		ContentRating: "PG-13",
		Year:          2020,
		Genres:        []string{"Action"},
	}
	poor := &models.MediaItem{
		Year: 2020,
	}

	richScore := metadataRichness(rich)
	poorScore := metadataRichness(poor)

	if richScore <= poorScore {
		t.Errorf("rich item score (%d) should be > poor item score (%d)", richScore, poorScore)
	}
}

func TestMetadataRichness_SameContentDifferentLibrary(t *testing.T) {
	// Simulate two items from different libraries with different metadata quality.
	// The one from the "Movies" library has full enrichment, the "4K Movies" one
	// was scanned but not yet enriched.
	enriched := &models.MediaItem{
		ID:            1,
		LibraryID:     3,
		Title:         "Inception",
		Year:          2010,
		Overview:      "A thief who steals corporate secrets through dream-sharing...",
		PosterPath:    "/inception.jpg",
		BackdropPath:  "/inception_bg.jpg",
		Rating:        8.8,
		RuntimeMin:    148,
		ContentRating: "PG-13",
		Genres:        []string{"Action", "Sci-Fi", "Thriller"},
	}
	unenriched := &models.MediaItem{
		ID:        2,
		LibraryID: 5,
		Title:     "Inception",
		Year:      2010,
	}

	enrichedScore := metadataRichness(enriched)
	unenrichedScore := metadataRichness(unenriched)

	if enrichedScore <= unenrichedScore {
		t.Errorf("enriched item score (%d) should be > unenriched item score (%d)", enrichedScore, unenrichedScore)
	}
}
