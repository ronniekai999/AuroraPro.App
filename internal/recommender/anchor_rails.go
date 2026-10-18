package recommender

import (
	"context"
	"log/slog"

	"github.com/aurora-media/aurora/internal/models"
)

// AnchorRail is one "Because You Watched X" section: an anchor reference
// (the specific item the user finished or made progress on) plus items
// most-similar to that anchor's embedding.
//
// Unlike Discover (LLM-themed rails) and the flat "More like what you
// watched" rail (centroid-based), AnchorRail is pinned to ONE specific
// thing the user actually watched. The connection is explicit and
// undeniable: "you watched X, here's more in that exact vibe."
type AnchorRail struct {
	Anchor *models.AnchorRef   `json:"anchor"`
	Items  []*models.MediaItem `json:"items"`
}

const (
	// anchorRailMaxRails caps how many anchor-pinned rails we surface.
	// 3 keeps the home page from drowning in personalization sections —
	// after Continue Watching + Discover (3-5 rails) + these 3, we're
	// already at 6-8 personalized rails. More than that and the page
	// feels cluttered.
	anchorRailMaxRails = 3

	// anchorRailMaxItems is per-rail item cap. 12 fills a standard 2-row
	// grid at typical card widths; larger pools waste the LLM-less query
	// budget on items the user won't scroll to anyway.
	anchorRailMaxItems = 12

	// anchorRailOverfetch widens the kNN pull so cross-rail dedup has
	// headroom — if Buffy lands in both the Scooby-Doo and Dead Boy
	// Detectives anchor pools, it goes to whichever rail saw it first
	// and the later rail needs other items to fill the slot.
	anchorRailOverfetch = anchorRailMaxItems * 2

	// anchorRailMinItems is the floor below which we drop a rail entirely.
	// A rail with 2 items looks broken; 3+ feels intentional. Cross-rail
	// dedup can drain the later rails below this threshold, in which case
	// we hide them rather than showing a sparse strip.
	anchorRailMinItems = 3
)

// AnchorRailsFor returns up to 3 "Because You Watched X" rails for the
// active profile. Pure vector retrieval — one kNN query per anchor — so
// this surface is fast (sub-300ms total) and doesn't need caching.
//
// Dedup rule: an item appears in AT MOST ONE rail. Earlier anchors
// (more recent watches) win, so the freshest anchor gets its strongest
// matches and later rails get the rest. Without this, the user would see
// the same Buffy item under all three anchor rails for a horror watcher.
//
// On any failure (no anchors, kNN error) returns nil, nil — the UI
// hides the section gracefully. We never 500 on what is a personalization
// nice-to-have.
func (h *Hero) AnchorRailsFor(ctx context.Context, profileID int64) ([]AnchorRail, error) {
	anchors, err := h.q.RecentAnchorsWithEmbeddings(ctx, profileID, anchorRailMaxRails)
	if err != nil {
		slog.Warn("anchor rails: fetch anchors failed", "profile", profileID, "error", err)
		return nil, nil
	}
	if len(anchors) == 0 {
		return nil, nil
	}

	allowed, ok := h.allowedRatings(ctx, profileID)
	if !ok {
		return nil, nil
	}
	out := make([]AnchorRail, 0, len(anchors))
	used := make(map[int64]bool)
	// anchorSeen dedupes anchors by their underlying title so a show
	// watched across many episodes (each a watch_progress row) yields ONE
	// "Because you watched X" rail, not one per episode. The query already
	// collapses these via DISTINCT ON; this is defense-in-depth so a future
	// query change can't reintroduce duplicate rails.
	anchorSeen := make(map[int64]bool)

	for _, a := range anchors {
		if a.MediaItemID != 0 {
			if anchorSeen[a.MediaItemID] {
				continue
			}
			anchorSeen[a.MediaItemID] = true
		}
		// NearestUnwatched takes a pgvector text literal — the anchor's
		// EmbeddingText is already in that exact format, so we pass it
		// through without re-parsing/re-formatting. Same code path the
		// centroid rail uses; only the input vector differs.
		// "", 0 → no anti-repetition demotion: the "Because You Watched X" anchor
		// rails are intentionally anchor-pinned, not part of B2's per-surface
		// temporal de-dup. applyTonePenalty=false for the same reason: this
		// rail promises "more like THAT title", so it must stay pure
		// similarity-to-anchor — the profile-wide content-tone lean would
		// evict the on-tone-with-the-anchor items exactly when the anchor's
		// tier differs from the profile's usual one.
		items, ierr := h.q.NearestUnwatched(ctx, profileID, a.EmbeddingText, anchorRailOverfetch, allowed, "", 0, false)
		if ierr != nil {
			slog.Warn("anchor rails: kNN failed",
				"anchor", a.Title, "profile", profileID, "error", ierr)
			continue
		}
		anchorRef := &models.AnchorRef{
			Title: a.Title,
			Year:  a.Year,
			Type:  a.Type,
		}
		rail := AnchorRail{Anchor: anchorRef}
		for _, item := range items {
			if used[item.ID] {
				continue
			}
			used[item.ID] = true
			// Shallow-copy so the NearestAnchor mutation can't leak back
			// into the candidate slice (which other goroutines may be
			// reading). Same defensive pattern as Discover.
			cp := *item
			// Set NearestAnchor so the existing card-reason caption logic
			// renders "Because you watched X" without any new frontend
			// branch. The rail-level title shows the SAME anchor at the
			// section header — redundant but reinforcing.
			cp.NearestAnchor = anchorRef
			rail.Items = append(rail.Items, &cp)
			if len(rail.Items) >= anchorRailMaxItems {
				break
			}
		}
		// Drop sparse rails — better to show 2 strong rails than 3 where
		// one looks half-empty after dedup ate its items.
		if len(rail.Items) >= anchorRailMinItems {
			out = append(out, rail)
		}
	}

	if len(out) == 0 {
		return nil, nil
	}
	h.annotateAnchorRails(ctx, out)
	return out, nil
}

// annotateAnchorRails fills Has4K + Genres across every item in every rail
// in two batched queries (one for 4K, one for genres) rather than per-rail.
// Mirrors annotateDiscoverItems — same pattern, different container type.
func (h *Hero) annotateAnchorRails(ctx context.Context, rails []AnchorRail) {
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
		slog.Warn("anchor rails: 4K annotate failed", "error", err)
		fourK = map[int64]bool{}
	}
	genres, err := h.q.GetMediaGenresBatch(ctx, ids)
	if err != nil {
		slog.Warn("anchor rails: genre annotate failed", "error", err)
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
