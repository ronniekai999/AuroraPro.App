package db

import (
	"context"
	"fmt"
	"time"
)

// Phase 6 — Calendar.
//
// UpcomingEpisode is a forward-looking episode airing within a
// window (typically 30 days). Aggregated across shows present in
// the user's accessible libraries — admins see everything; regular
// users see episodes for shows in libraries they can read.
//
// Date filtering is server-side via the SQL WHERE clause so the
// frontend's calendar grid receives only relevant rows.

type UpcomingEpisode struct {
	MediaItemID   int64     `json:"media_item_id"`
	ShowTitle     string    `json:"show_title"`
	PosterPath    string    `json:"poster_path,omitempty"`
	BackdropPath  string    `json:"backdrop_path,omitempty"`
	EpisodeID     int64     `json:"episode_id"`
	SeasonNumber  int       `json:"season_number"`
	EpisodeNumber int       `json:"episode_number"`
	EpisodeTitle  string    `json:"episode_title,omitempty"`
	Overview      string    `json:"overview,omitempty"`
	AirDate       time.Time `json:"air_date"`
}

// UpcomingEpisodes returns all episodes airing between from and to
// (inclusive). Used by the Calendar view. Ordered by air_date asc
// so the frontend can render in chronological order without a
// re-sort.
//
// Note: this is library-wide. Future iteration could scope by
// "shows the user is currently watching" (joined to watch_progress)
// for a personalized calendar, but library-wide is the right
// default — TV shows on the server are inherently of interest.
//
// allowedRatings is the viewer's ceiling (db.AllowedRatingsForMax; nil is
// unrestricted): a show over it is left out, before the LIMIT.
func (q *Queries) UpcomingEpisodes(ctx context.Context, from, to time.Time, allowedRatings []string) ([]*UpcomingEpisode, error) {
	// 2026-05-19 audit (BE-M8) — LIMIT 1000. Aurora's calendar UI
	// shows a forward-looking window of upcoming episodes; even a
	// massive library wouldn't sensibly display more than ~1000
	// items in a single fetch. The cap defends against unbounded
	// row growth as years of episode data accrue.
	rows, err := q.pool.Query(ctx, `
		SELECT m.id, m.title, COALESCE(m.poster_path, ''), COALESCE(m.backdrop_path, ''),
		       e.id, s.season_number, e.episode_number,
		       COALESCE(e.title, ''), COALESCE(e.overview, ''), e.air_date
		  FROM tv_episodes e
		  JOIN tv_seasons s ON s.id = e.season_id
		  JOIN media_items m ON m.id = s.media_item_id
		 WHERE e.air_date IS NOT NULL
		   AND e.air_date >= $1
		   AND e.air_date <= $2
		   AND m.type = 'show'
		   AND ($3::text[] IS NULL OR m.content_rating = ANY($3))
		 ORDER BY e.air_date ASC, m.title ASC
		 LIMIT 1000
	`, from, to, allowedRatings)
	if err != nil {
		return nil, fmt.Errorf("upcoming episodes: %w", err)
	}
	defer rows.Close()
	out := []*UpcomingEpisode{}
	for rows.Next() {
		e := &UpcomingEpisode{}
		if err := rows.Scan(&e.MediaItemID, &e.ShowTitle, &e.PosterPath, &e.BackdropPath,
			&e.EpisodeID, &e.SeasonNumber, &e.EpisodeNumber,
			&e.EpisodeTitle, &e.Overview, &e.AirDate); err != nil {
			return nil, fmt.Errorf("scan upcoming episode: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
