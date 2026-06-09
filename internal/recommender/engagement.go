package recommender

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// Phase C — proprietary engagement-driven rails. Four rows built from Aurora's
// own first-party signals (heat, completion, runtime, rating), NOT the taste
// vector or the LLM — so they're cheap, fast, and keep working when the Cloud
// LLM is down. Each rail is independently graceful (empty → dropped). The three
// "unwatched" rails de-dup against each other (first-wins) so a title shows in
// at most one; Comfort Rewatch is watched-only and never collides.

// EngagementRail is one signal-driven section. Mirrors api.EngagementRail /
// DiscoverRail at the boundary; Description is a fixed (non-LLM) theme line.
type EngagementRail struct {
	Title       string
	Description string
	Items       []*models.MediaItem
}

const (
	// engagementCacheTTL is shorter than Discover's 24h so "Trending Now" stays
	// current; the queries are cheap (no LLM) so re-running hourly is fine.
	engagementCacheTTL = 1 * time.Hour

	// engagementBuildBudget bounds the detached build (4 cheap SQL + 2 batched
	// annotate). Generous — these never touch the LLM.
	engagementBuildBudget = 10 * time.Second

	engagementRailLimit = 12

	// Trending Now: shorter decay + recency window than the Aurora Score's heat
	// so it reflects "right now," gated so a single play can't trend.
	trendingDecayDays  = 10.0
	trendingWindowDays = 30
	trendingMinStarts  = 3

	// Hidden Gems: high TMDB rating (trustworthy via min votes) × low LOCAL plays.
	hiddenMinRating = 7.0
	hiddenMinVotes  = 50
	hiddenMaxStarts = 3

	// Finish It Tonight: unwatched movies short enough to finish in one sitting.
	finishRuntimeMin = 30
	finishRuntimeMax = 110
)

// engagementCacheEntry is the in-memory cache shape (mirrors discoverCacheEntry).
type engagementCacheEntry struct {
	rails   []EngagementRail
	builtAt time.Time
}

// EngagementRailsFor returns the four signal-driven rails for a profile, cached
// (engagementCacheTTL) + singleflighted + epoch-guarded — the exact pattern as
// DiscoverFor, with its own cache slot so a hero/discover refresh doesn't evict
// it (and vice versa).
func (h *Hero) EngagementRailsFor(ctx context.Context, profileID int64) ([]EngagementRail, error) {
	if cached, ok := h.engagementCache.Load(profileID); ok {
		e := cached.(engagementCacheEntry)
		if time.Since(e.builtAt) < engagementCacheTTL {
			return e.rails, nil
		}
	}
	key := strconv.FormatInt(profileID, 10)
	startEpoch := h.epochFor(profileID).Load()
	result, err, _ := h.engagementGroup.Do(key, func() (any, error) {
		if cached, ok := h.engagementCache.Load(profileID); ok {
			e := cached.(engagementCacheEntry)
			if time.Since(e.builtAt) < engagementCacheTTL {
				return e.rails, nil
			}
		}
		// Detach from the request ctx (mirrors DiscoverFor) so a lead caller
		// navigating away mid-build doesn't blank the rails for singleflight
		// waiters on the same profile; the budget bounds the cheap SQL.
		buildCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), engagementBuildBudget)
		defer cancel()
		rails := h.buildEngagementRails(buildCtx, profileID)
		if len(rails) > 0 && h.epochFor(profileID).Load() == startEpoch {
			h.engagementCache.Store(profileID, engagementCacheEntry{rails: rails, builtAt: time.Now()})
		}
		return rails, nil
	})
	if err != nil {
		return nil, err
	}
	return result.([]EngagementRail), nil
}

// buildEngagementRails runs the four signal queries, de-dups the unwatched rails,
// drops empties, and annotates items (4K + genres) for the card badges. Each
// query is best-effort: a failure yields an empty rail (dropped), never an error.
func (h *Hero) buildEngagementRails(ctx context.Context, profileID int64) []EngagementRail {
	allowed := h.allowedRatings(ctx, profileID)

	fetch := func(name string, fn func() ([]*models.MediaItem, error)) []*models.MediaItem {
		items, err := fn()
		if err != nil {
			slog.Warn("engagement: rail query failed", "rail", name, "profile", profileID, "error", err)
			return nil
		}
		return items
	}

	trending := fetch("trending", func() ([]*models.MediaItem, error) {
		return h.q.TrendingUnwatched(ctx, profileID, allowed, trendingDecayDays, trendingWindowDays, trendingMinStarts, engagementRailLimit)
	})
	hidden := fetch("hidden_gems", func() ([]*models.MediaItem, error) {
		return h.q.HiddenGems(ctx, profileID, allowed, hiddenMinRating, hiddenMinVotes, hiddenMaxStarts, engagementRailLimit)
	})
	finish := fetch("finish_tonight", func() ([]*models.MediaItem, error) {
		return h.q.FinishTonightShortMovies(ctx, profileID, allowed, finishRuntimeMin, finishRuntimeMax, engagementRailLimit)
	})
	comfort := fetch("comfort_rewatch", func() ([]*models.MediaItem, error) {
		return h.q.ComfortRewatch(ctx, profileID, allowed, engagementRailLimit)
	})

	// Cross-rail de-dup (first-wins) + drop empties. The three unwatched rails
	// can overlap; Comfort is watched-only so it can't collide with them, which
	// makes one global pass equivalent to deduping just the unwatched three.
	rails := dedupRailsInOrder([]EngagementRail{
		{Title: "Trending Now", Description: "Catching fire across Aurora right now", Items: trending},
		{Title: "Hidden Gems", Description: "Great titles few here have found yet", Items: hidden},
		{Title: "Finish It Tonight", Description: "Picks that fit the evening you've got", Items: finish},
		{Title: "Comfort Rewatch", Description: "Worth watching again", Items: comfort},
	})
	h.annotateEngagementItems(ctx, rails)
	return rails
}

// dedupRailsInOrder removes items already shown in an earlier rail (first-wins)
// and drops rails left empty, preserving order. Pure — unit tested.
func dedupRailsInOrder(rails []EngagementRail) []EngagementRail {
	seen := make(map[int64]bool)
	out := make([]EngagementRail, 0, len(rails))
	for _, r := range rails {
		kept := make([]*models.MediaItem, 0, len(r.Items))
		for _, it := range r.Items {
			if it == nil || seen[it.ID] {
				continue
			}
			seen[it.ID] = true
			kept = append(kept, it)
		}
		if len(kept) > 0 {
			out = append(out, EngagementRail{Title: r.Title, Description: r.Description, Items: kept})
		}
	}
	return out
}

// annotateEngagementItems fills Has4K + Genres on every rail item in two batched
// queries (mirrors annotateDiscoverItems). Best-effort: failures leave the
// badges/genres empty rather than failing the rail.
func (h *Hero) annotateEngagementItems(ctx context.Context, rails []EngagementRail) {
	var ids []int64
	seen := make(map[int64]bool)
	for _, r := range rails {
		for _, it := range r.Items {
			if !seen[it.ID] {
				seen[it.ID] = true
				ids = append(ids, it.ID)
			}
		}
	}
	if len(ids) == 0 {
		return
	}
	fourK, err := h.q.GetMediaItemsWith4KCrossLibrary(ctx, ids)
	if err != nil {
		slog.Warn("engagement: 4K annotate failed", "error", err)
		fourK = map[int64]bool{}
	}
	genres, err := h.q.GetMediaGenresBatch(ctx, ids)
	if err != nil {
		slog.Warn("engagement: genres annotate failed", "error", err)
		genres = map[int64][]string{}
	}
	for _, r := range rails {
		for _, it := range r.Items {
			it.Has4K = fourK[it.ID]
			if g, ok := genres[it.ID]; ok {
				it.Genres = g
			}
		}
	}
}
