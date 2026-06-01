# Library hybrid — finish-up plan (PR 2 + episode-version bug)

_Status after research: the hybrid redesign is **already implemented and committed**
(`dcfc266`, this branch `feat/library-hybrid-redesign`). So "add it in" is largely done.
This plan covers the two things left: the **HDR badge follow-up (PR 2)** and the
**show-detail episode-version bug** you reported._

---

## What's already shipped in `dcfc266` (verified, not assumed)

- `BrowseView` (App.tsx) has the **hero + genre chips + Grid/List density toggle**
  (persisted to `localStorage` key `aurora.browse.density`), and a Continue-Watching
  context. Imports `MediaCardCinema` (grid) + `MediaListRow` (list), passes
  `showLength` + `showBadges`.
- `MediaListRow.tsx` (new) — the dense list row.
- `MediaCardCinema.tsx` (+77) — opt-in `showBadges` / `showLength` / `tags` props.
- **Badges already work with zero backend changes:** `mapMedia()` in
  [`lib/api.ts`](../../static/redesign/app/src/lib/api.ts) builds
  `tags: [ ...(has_4k ? ['4K'] : []), ...(content_rating ? [content_rating] : []) ]`.
  - `has_4k` is computed server-side, cross-library, in the `/api/media` List handler
    (`internal/api/media_handlers.go` → `GetMediaItemsWith4KCrossLibrary`).
  - `content_rating` (e.g. `TV-MA`) is a real column on `media_items`, populated by the
    TMDB enricher (`internal/metadata/tmdb.go` `content_ratings`/`certification`).

**So the "maturity rating + 4K" you asked for are LIVE already.** The only badge not yet
present is **HDR** — that's PR 2.

> ⚠️ Visual verify still pending from the original redesign (needs a live `:8484` backend).
> Not strictly part of these two tasks, but worth doing in the same pass.

---

## Sequencing — two separate PRs, bug first

Per the standing [fix-request pipeline](../../docs/dev-workflow.md): research → branch →
implement + tests → build/test → deep-debug review → merge clean → delete branch.

The two tasks are unrelated (different components, different root causes), so they ship as
**two branches** off `main`, smallest/most-isolated first.

| Order | Branch | Scope | Backend? |
|------|--------|-------|----------|
| **1** | `fix/show-detail-all-versions` | Episode/show version bug | No — frontend only |
| **2** | `feat/library-hdr-badge` | HDR badge on browse cards/rows | Small — 1 query + 1 field |

---

## TASK 1 — Bug: show detail only shows the 2160p version (frontend-only)

### Root cause (confirmed in code)
- The backend **already returns every file**, ordered 4K-first:
  `queries_phase2.go:955` → `ORDER BY CASE version_tag WHEN '4K' THEN 1 WHEN '1080p' THEN 2 …`.
- `DetailView`'s multi-file **"Play in 4K/1080p" chooser is gated to movies only**:
  `App.tsx:2113` → `media.type !== 'show' && files && files.length > 1`.
- For shows, the play path just calls `pickFile(ep.files, preferQuality)`
  ([`VideoPlayer.tsx:200`](../../static/redesign/app/src/components/VideoPlayer.tsx)) whose
  **`auto` order is `['1080p','720p','4k','other']`** — so auto actually prefers 1080p,
  but the **UI never surfaces that a second version exists**, and the descriptive
  `QualityChips` are derived from a single `trackFile` (`deriveQualityChips(trackFile, …)`),
  so they show one resolution. Net effect the user sees: "only the 2160p version shows."

### Fix approach (chosen)
Surface **per-episode version availability** so the multi-version state is visible and
selectable, instead of silently collapsing to one file:

1. **Episodes tab — per-episode version chips.** Thread each episode's available
   resolutions into `EpisodeRowVM` (new optional `versions?: { id:number; tag:string;
   is4k:boolean }[]`, derived from `ep.files` via the existing `version_tag`/`resolution`).
   `EpisodeRow` renders small resolution chips when `versions.length > 1`; clicking one
   plays that specific file. Wire `onPlayEpisode` to accept an optional `fileId`
   (`handlePlayEpisode(ep, fileId?)` → pass to `pickFile`-bypass when an explicit file is
   chosen). Single-version episodes are unchanged (no chips).
2. **Descriptive QualityChips for shows** — when an episode has multiple resolutions, show
   all of them (e.g. `4K · 1080p`) rather than just `trackFile`'s. Low-risk: this strip is
   descriptive, not actionable.
3. (Optional, smaller alt if you prefer minimal change) — **just lift the movie-only gate**
   so the existing "Play in …" chooser also renders for shows using the *currently selected
   episode's* files. Less code, but the chooser sits oddly above a whole-season episode
   list. The per-episode chips (option 1) is the better UX and is what I'd build.

### Files
- `static/redesign/app/src/App.tsx` — `episodeRows` VM build (~1992), `handlePlayEpisode`
  (~7628) optional `fileId`, `qualityChips`/`deriveQualityChips` for shows (~1955).
- `static/redesign/app/src/components/detail/EpisodeRow.tsx` — `EpisodeRowVM.versions` +
  chip rendering.
- `static/redesign/app/src/components/detail/EpisodeList.tsx` — pass-through of the new
  `onPlay(id, fileId?)`.
- `static/redesign/app/src/components/detail/QualityChips.tsx` — multi-resolution display
  (likely no change; logic lives in the deriver).

### Tests / verify
- `tsc -b && vite build` green.
- Manual (live `:8484`): a show with both a 1080p and a 2160p episode shows **both** chips
  and each plays the right file. A single-version show shows **no** chips (no regression).

---

## TASK 2 — PR 2: HDR badge on browse cards + rows

### What exists vs. what's missing
- `4K` and maturity (`content_rating`) badges already render (see above). HDR does not.
- HDR source data **already exists at the file level**: `color_transfer` column on
  `media_files` + `episode_files` (migration `025_video_color_metadata`), populated by
  ffprobe (`internal/library/ffprobe.go`). HDR = `smpte2084` (PQ) or `arib-std-b67` (HLG).
- But the **`/api/media` list payload has no `has_hdr`** — only `has_4k`. So this badge
  genuinely needs a small backend addition (this is the part that voided the original
  "frontend-only" claim).

### Backend (mirror the `has_4k` pattern exactly)
1. **New query** `GetMediaItemsWithHDRCrossLibrary` in `internal/db/queries_crosslib.go`,
   copying `GetMediaItemsWith4KCrossLibrary` but testing
   `color_transfer IN ('smpte2084','arib-std-b67')` instead of `version_tag LIKE '4K%'`
   (base direct query mirrors `GetMediaItemsWith4K` in `queries_phase2.go`). Same
   cross-library tmdb_id sibling logic.
2. **Model + handler** — add `Has HDR bool \`json:"has_hdr,omitempty"\`` to the media item
   model (`internal/models/models.go`) and annotate it in the three List handlers in
   `internal/api/media_handlers.go` (List, ListGenres-adjacent, and the personalized one)
   right next to the existing `item.Has4K = fourKMap[item.ID]` lines.

### Frontend (one line of real logic)
3. `ServerMediaItem` (`lib/api.ts`) — add `has_hdr?: boolean`.
4. `mapMedia` (`lib/api.ts`) — extend tags:
   `...(item.has_hdr ? ['HDR'] : [])` (place after `4K`, before `content_rating`).
5. `MediaCardCinema` badge styling — `HDR` reuses the existing chip styling; if we want a
   distinct hue (amber, like quality elsewhere) that's a tiny class branch on tag text.

### Tests / verify
- Go: unit test for `GetMediaItemsWithHDRCrossLibrary` (table-driven, mirrors the existing
  4K query test). `go build ./...` + `go test ./internal/db/... ./internal/api/...`.
- Frontend: `tsc -b && vite build`.
- Manual: an HDR title shows an `HDR` chip alongside `4K`; an SDR title doesn't.

---

## Cross-cutting

- **Both** go through the deep-debug agent review loop before merge (caught real
  regressions every prior round per project history).
- Edit the **worktree** path (`…/worktrees/busy-raman-f4214a/…`), always `git -C <worktree>`;
  remember `gh pr merge --delete-branch` fails locally → delete remote branch via API/manually.
- Re-anchor on `origin/main` before branching (it moved +4 commits under the last redesign).

## Open question for you
- **Task 1 UX:** per-episode version chips (richer, recommended) vs. just un-gating the
  existing movie chooser for shows (minimal)? Plan assumes the former.
