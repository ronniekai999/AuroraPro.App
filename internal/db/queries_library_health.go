package db

import (
	"context"
	"fmt"

	"github.com/aurora-media/aurora/internal/models"
)

// LibraryMatchHealth is one library's metadata-match tally: how many catalog
// rows it holds, and how many of those actually carry a provider id.
//
// The ratio is the cheapest signal there is for the failure behind issue #510.
// A "TV Shows" library created with type='movie' has every title parsed by
// ParseMoviePath and searched against TMDB's MOVIE index, so essentially nothing
// matches — 80 series, 0 tmdb_ids, and the whole library invisible to
// GET /api/media?type=show. Nothing surfaced that, and the state survived
// repeated scans looking entirely healthy from the outside.
//
// Note it carries no files-vs-metadata distinction: a library whose PATHS are
// wrong produces a similar tally for an unrelated reason, and this cannot tell
// the two apart. The warning text says so rather than pretending otherwise.
type LibraryMatchHealth struct {
	LibraryID int64              `json:"library_id"`
	Name      string             `json:"name"`
	Type      models.LibraryType `json:"type"`
	Items     int64              `json:"items"`
	Matched   int64              `json:"matched"`
}

// GetLibraryMatchHealth returns the tally for every library, including ones with
// no catalog rows at all (LEFT JOIN, so they report Items=0 rather than vanishing
// — an empty library is a legitimate state and a caller deciding what to warn
// about needs to see it rather than infer it from absence).
//
// COUNT(mi.tmdb_id) counts non-NULL only, which is the definition of "matched"
// here. Note it is deliberately NOT match_status: that column DEFAULTs to
// 'matched' (migration 007) and UpsertMediaItem never sets it, while
// EnrichMediaItem writes a status only at or above the review threshold — so a
// show that matched nothing reads as 'matched' with a NULL tmdb_id and would
// make this report say everything is fine. tmdb_id is the load-bearing field.
func (q *Queries) GetLibraryMatchHealth(ctx context.Context) ([]LibraryMatchHealth, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT l.id, l.name, l.type,
		       COUNT(mi.id)      AS items,
		       COUNT(mi.tmdb_id) AS matched
		FROM libraries l
		LEFT JOIN media_items mi ON mi.library_id = l.id
		GROUP BY l.id, l.name, l.type
		ORDER BY l.id`)
	if err != nil {
		return nil, fmt.Errorf("get library match health: %w", err)
	}
	defer rows.Close()

	var out []LibraryMatchHealth
	for rows.Next() {
		var h LibraryMatchHealth
		if err := rows.Scan(&h.LibraryID, &h.Name, &h.Type, &h.Items, &h.Matched); err != nil {
			return nil, fmt.Errorf("scan library match health: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}
