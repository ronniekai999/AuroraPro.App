package api

import (
	"context"
	"errors"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// TestRetryListQuery exercises the transient-error retry policy for the media
// list query without a database (the seam is a plain func).
func TestRetryListQuery(t *testing.T) {
	boom := errors.New("transient db error")
	data := []*models.MediaItem{{ID: 1}}

	t.Run("success: no retry", func(t *testing.T) {
		calls := 0
		items, total, err := retryListQuery(context.Background(), func() ([]*models.MediaItem, int64, error) {
			calls++
			return data, 1, nil
		})
		if err != nil || total != 1 || len(items) != 1 || calls != 1 {
			t.Errorf("calls=%d items=%d total=%d err=%v", calls, len(items), total, err)
		}
	})

	t.Run("err then success: retries once", func(t *testing.T) {
		calls := 0
		items, _, err := retryListQuery(context.Background(), func() ([]*models.MediaItem, int64, error) {
			calls++
			if calls == 1 {
				return nil, 0, boom
			}
			return data, 1, nil
		})
		if err != nil || len(items) != 1 || calls != 2 {
			t.Errorf("want retry-then-success: calls=%d items=%d err=%v", calls, len(items), err)
		}
	})

	t.Run("err twice: returns error after two calls", func(t *testing.T) {
		calls := 0
		_, _, err := retryListQuery(context.Background(), func() ([]*models.MediaItem, int64, error) {
			calls++
			return nil, 0, boom
		})
		if err == nil || calls != 2 {
			t.Errorf("want 2 calls + error: calls=%d err=%v", calls, err)
		}
	})

	t.Run("canceled context: does NOT retry", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		calls := 0
		_, _, err := retryListQuery(ctx, func() ([]*models.MediaItem, int64, error) {
			calls++
			return nil, 0, boom
		})
		if calls != 1 || err == nil {
			t.Errorf("canceled ctx should not retry: calls=%d err=%v", calls, err)
		}
	})
}
