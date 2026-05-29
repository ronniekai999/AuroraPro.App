package db

import (
	"context"
	"fmt"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// ============================================================
// Media Requests
// ============================================================

// InsertRequest creates a new media request.
func (q *Queries) InsertRequest(ctx context.Context, req *models.Request) error {
	err := q.pool.QueryRow(ctx,
		`INSERT INTO requests
			(user_id, media_type, tmdb_id, title, poster_path, overview, year,
			 status, quality_1080p, quality_4k, arr_job_ids, error_message,
			 requested_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		 RETURNING id`,
		req.UserID, req.MediaType, req.TMDBID, req.Title, req.PosterPath,
		req.Overview, req.Year, req.Status, req.Quality1080p, req.Quality4K,
		req.ArrJobIDs, req.ErrorMessage, req.RequestedAt, req.UpdatedAt,
	).Scan(&req.ID)
	if err != nil {
		return fmt.Errorf("insert request: %w", err)
	}
	return nil
}

// scanRequest scans a row into a models.Request.
// Column order must match the SELECT used by the caller.
func scanRequest(row pgx.Row) (*models.Request, error) {
	r := &models.Request{}
	err := row.Scan(
		&r.ID, &r.UserID, &r.MediaType, &r.TMDBID, &r.Title,
		&r.PosterPath, &r.Overview, &r.Year, &r.Status,
		&r.Quality1080p, &r.Quality4K, &r.ArrJobIDs, &r.ErrorMessage,
		&r.RequestedAt, &r.ProcessedAt, &r.CompletedAt, &r.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return r, nil
}

// requestColumns is the standard SELECT column list for the requests table.
const requestColumns = `id, user_id, media_type, tmdb_id, title,
	poster_path, overview, year, status,
	quality_1080p, quality_4k, arr_job_ids, error_message,
	requested_at, processed_at, completed_at, updated_at`

// GetRequestsByUserID returns all requests for a specific user, newest first.
func (q *Queries) GetRequestsByUserID(ctx context.Context, userID int64) ([]models.Request, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT `+requestColumns+`
		 FROM requests
		 WHERE user_id = $1
		 ORDER BY requested_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("get requests by user: %w", err)
	}
	defer rows.Close()

	var requests []models.Request
	for rows.Next() {
		var r models.Request
		err := rows.Scan(
			&r.ID, &r.UserID, &r.MediaType, &r.TMDBID, &r.Title,
			&r.PosterPath, &r.Overview, &r.Year, &r.Status,
			&r.Quality1080p, &r.Quality4K, &r.ArrJobIDs, &r.ErrorMessage,
			&r.RequestedAt, &r.ProcessedAt, &r.CompletedAt, &r.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan request row: %w", err)
		}
		requests = append(requests, r)
	}
	return requests, rows.Err()
}

// GetAllRequests returns all requests across all users, newest first.
// Used by admin list endpoint.
func (q *Queries) GetAllRequests(ctx context.Context) ([]models.Request, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT `+requestColumns+`
		 FROM requests
		 ORDER BY requested_at DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("get all requests: %w", err)
	}
	defer rows.Close()

	var requests []models.Request
	for rows.Next() {
		var r models.Request
		err := rows.Scan(
			&r.ID, &r.UserID, &r.MediaType, &r.TMDBID, &r.Title,
			&r.PosterPath, &r.Overview, &r.Year, &r.Status,
			&r.Quality1080p, &r.Quality4K, &r.ArrJobIDs, &r.ErrorMessage,
			&r.RequestedAt, &r.ProcessedAt, &r.CompletedAt, &r.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan request row: %w", err)
		}
		requests = append(requests, r)
	}
	return requests, rows.Err()
}

// GetRequestByID returns a single request by its ID.
// Returns nil if not found.
func (q *Queries) GetRequestByID(ctx context.Context, id int64) (*models.Request, error) {
	r, err := scanRequest(q.pool.QueryRow(ctx,
		`SELECT `+requestColumns+`
		 FROM requests
		 WHERE id = $1`,
		id,
	))
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get request by id: %w", err)
	}
	return r, nil
}

// UpdateRequestStatus updates the status of a request along with optional
// arr_job_ids and error_message fields. It also sets processed_at or
// completed_at timestamps based on the new status.
func (q *Queries) UpdateRequestStatus(ctx context.Context, id int64, status string, arrJobIDs string, errorMsg string) error {
	now := time.Now()

	var processedAt, completedAt *time.Time
	switch status {
	case models.RequestProcessing:
		processedAt = &now
	case models.RequestAvailable, models.RequestFailed:
		completedAt = &now
	}

	_, err := q.pool.Exec(ctx,
		`UPDATE requests
		 SET status = $2,
		     arr_job_ids = COALESCE(NULLIF($3, ''), arr_job_ids),
		     error_message = COALESCE(NULLIF($4, ''), error_message),
		     processed_at = COALESCE($5, processed_at),
		     completed_at = COALESCE($6, completed_at),
		     updated_at = $7
		 WHERE id = $1`,
		id, status, arrJobIDs, errorMsg, processedAt, completedAt, now,
	)
	if err != nil {
		return fmt.Errorf("update request status: %w", err)
	}
	return nil
}

// DeleteRequest removes a request by its ID.
func (q *Queries) DeleteRequest(ctx context.Context, id int64) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM requests WHERE id = $1`,
		id,
	)
	if err != nil {
		return fmt.Errorf("delete request: %w", err)
	}
	return nil
}

// GetProcessingRequests returns all requests with status='processing'.
// Used by the background request monitor to poll ARR services for completion.
func (q *Queries) GetProcessingRequests(ctx context.Context) ([]models.Request, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT `+requestColumns+`
		 FROM requests
		 WHERE status = 'processing'
		 ORDER BY requested_at ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("get processing requests: %w", err)
	}
	defer rows.Close()

	var requests []models.Request
	for rows.Next() {
		var r models.Request
		err := rows.Scan(
			&r.ID, &r.UserID, &r.MediaType, &r.TMDBID, &r.Title,
			&r.PosterPath, &r.Overview, &r.Year, &r.Status,
			&r.Quality1080p, &r.Quality4K, &r.ArrJobIDs, &r.ErrorMessage,
			&r.RequestedAt, &r.ProcessedAt, &r.CompletedAt, &r.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan request row: %w", err)
		}
		requests = append(requests, r)
	}
	return requests, rows.Err()
}

// GetStalePendingRequests returns requests stuck in 'pending' whose
// requested_at is older than olderThan. A request only stays 'pending' if its
// fire-and-forget dispatch goroutine never completed — i.e. the process
// crashed/restarted or graceful shutdown cancelled the root context between the
// INSERT and dispatchToARR finishing. A live dispatch resolves to 'processing'
// or 'failed' within its 30s timeout, so anything still pending well past that
// window was orphaned and must be re-dispatched. See audit H4.
func (q *Queries) GetStalePendingRequests(ctx context.Context, olderThan time.Time) ([]models.Request, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT `+requestColumns+`
		 FROM requests
		 WHERE status = 'pending' AND requested_at < $1
		 ORDER BY requested_at ASC`,
		olderThan,
	)
	if err != nil {
		return nil, fmt.Errorf("get stale pending requests: %w", err)
	}
	defer rows.Close()

	var requests []models.Request
	for rows.Next() {
		var r models.Request
		err := rows.Scan(
			&r.ID, &r.UserID, &r.MediaType, &r.TMDBID, &r.Title,
			&r.PosterPath, &r.Overview, &r.Year, &r.Status,
			&r.Quality1080p, &r.Quality4K, &r.ArrJobIDs, &r.ErrorMessage,
			&r.RequestedAt, &r.ProcessedAt, &r.CompletedAt, &r.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan request row: %w", err)
		}
		requests = append(requests, r)
	}
	return requests, rows.Err()
}

// GetRequestCountByStatus returns the count of requests with the given status.
func (q *Queries) GetRequestCountByStatus(ctx context.Context, status string) (int64, error) {
	var count int64
	err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM requests WHERE status = $1`,
		status,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("get request count by status: %w", err)
	}
	return count, nil
}

// CountActiveRequestsByUser returns the number of in-flight requests for a
// user — those still pending, awaiting admin approval, or processing. Used by
// the per-user active-request quota gate in the Create handler.
func (q *Queries) CountActiveRequestsByUser(ctx context.Context, userID int64) (int, error) {
	var count int
	err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM requests
		 WHERE user_id = $1 AND status IN ('pending', 'processing', 'pending_approval')`,
		userID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count active requests by user: %w", err)
	}
	return count, nil
}

// CountUserRequestsSince returns the number of requests a user has submitted
// at or after the given time. Used by the per-user rolling daily quota gate.
func (q *Queries) CountUserRequestsSince(ctx context.Context, userID int64, since time.Time) (int, error) {
	var count int
	err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM requests
		 WHERE user_id = $1 AND requested_at >= $2`,
		userID, since,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count user requests since: %w", err)
	}
	return count, nil
}

// GetPendingApprovalRequests returns all requests awaiting admin approval,
// oldest first. Used by the admin approval-queue endpoint.
func (q *Queries) GetPendingApprovalRequests(ctx context.Context) ([]models.Request, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT `+requestColumns+`
		 FROM requests
		 WHERE status = 'pending_approval'
		 ORDER BY requested_at ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("get pending approval requests: %w", err)
	}
	defer rows.Close()

	var requests []models.Request
	for rows.Next() {
		var r models.Request
		err := rows.Scan(
			&r.ID, &r.UserID, &r.MediaType, &r.TMDBID, &r.Title,
			&r.PosterPath, &r.Overview, &r.Year, &r.Status,
			&r.Quality1080p, &r.Quality4K, &r.ArrJobIDs, &r.ErrorMessage,
			&r.RequestedAt, &r.ProcessedAt, &r.CompletedAt, &r.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan request row: %w", err)
		}
		requests = append(requests, r)
	}
	return requests, rows.Err()
}

// RequestExistsActive checks if a non-failed request already exists for this
// user+media combination. Used to prevent duplicate requests.
func (q *Queries) RequestExistsActive(ctx context.Context, userID int64, mediaType string, tmdbID int) (bool, error) {
	var exists bool
	err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM requests
			WHERE user_id = $1 AND media_type = $2 AND tmdb_id = $3
			  AND status NOT IN ('failed')
		)`,
		userID, mediaType, tmdbID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check active request exists: %w", err)
	}
	return exists, nil
}
