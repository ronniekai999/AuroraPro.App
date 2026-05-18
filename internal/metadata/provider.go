package metadata

import "context"

// MetadataProvider defines the common search and detail operations shared
// by TMDB and TVDB. This is a thin interface for documentation and testing
// purposes; the Enricher continues to use concrete types because TMDB and
// TVDB have significantly different detail APIs.
//
// Both TMDBClient and TVDBClient satisfy the TV search portion; movie search
// is TMDB-only in the current implementation.
type MetadataProvider interface {
	// SearchTV searches for TV shows by title. year=0 means no year filter.
	SearchTV(ctx context.Context, query string, year int) (*TMDBSearchResult, error)
}

// Compile-time interface check: TMDBClient satisfies MetadataProvider.
var _ MetadataProvider = (*TMDBClient)(nil)
