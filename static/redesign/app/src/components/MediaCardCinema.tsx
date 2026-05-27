// Aurora V2 — MediaCardCinema
//
// 2028-05-28 — Extracted from App.tsx so the same card design renders
// consistently across the home rails (via MediaRail) AND the grid views
// (Movies, TV Shows, My Library, Search, Collections detail). Single
// source of truth for: poster, library badge, AI gem, progress bar,
// shelf with title/meta/reason. Future tweaks happen here once instead
// of in 6 inline copies.
//
// Defined here rather than in App.tsx because CollectionsView lives in
// its own file and needs to render this card too — App.tsx → component
// imports are one-directional; we deliberately don't have components
// reach back into App.
//
// SVG icons are inlined here (not pulled from App.tsx's `Icon` shared
// component) so this file has zero dependencies on the parent. That
// also keeps the rendered SVG markup smaller — `Icon` ships every
// listed glyph in its lookup table even when only one is used.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'

// MediaLike is the structural subset of App.tsx's `Media` interface
// that this card actually reads. Using a local interface lets callers
// pass any compatible shape (UI `Media`, server `ServerMediaItem`)
// without a cross-file type import — and keeps this file completely
// independent of App.tsx.
//
// The fields are intentionally narrow: the card doesn't need
// `type`/`backdrop`/etc., so we don't pull them in.
export interface MediaLike {
  id: number
  title: string
  poster?: string
  year?: number
  rating?: number
  genre?: string
  // LLM-generated per-pick reason. Surfaces as a tooltip on the outer
  // card + a visible italic caption in the shelf. Triggers the AI gem
  // top-right badge.
  reason?: string
  // 0..1 fraction; when > 0 renders a progress bar at the bottom of
  // the poster (e.g. Continue Watching).
  progress?: number
}

export interface MediaCardCinemaProps {
  item: MediaLike
  onSelect: () => void
  onCardContext?: (e: ReactMouseEvent) => void
  // Library state. When BOTH provided the lib badge renders.
  libraryIds?: Set<number>
  onToggleLib?: () => void
  // Optional sizing class — rails pass `w-[180px]`, grids leave empty
  // (parent grid sets column width).
  className?: string
  // Optional subtitle override (e.g. "S2E5" for Continue Watching).
  // Replaces the star/year/genre meta when provided.
  subtitle?: string
  // Image aspect. Default 'poster' (2:3) matches all current callers
  // except the Continue Watching rail which uses 'landscape' (16:9).
  aspect?: 'poster' | 'landscape'
  // Optional overlay slot — currently used by CollectionsView for the
  // admin "remove from collection" X button that sits on the card.
  // Rendered as a sibling absolutely-positioned over the poster, so it
  // overlaps the AI gem when both are present (collections typically
  // don't carry a reason so the conflict is rare).
  topRightOverlay?: React.ReactNode
}

// ─── Inlined SVG icons (decorative — wrapped in aria-hidden) ───
// Same path data as App.tsx's Icon component for visual consistency.
function PlusSvg() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}
function CheckSvg() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
function SparkleSvg() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2L13.5 8.5 20 10 13.5 11.5 12 18 10.5 11.5 4 10 10.5 8.5z" />
    </svg>
  )
}
function StarSvg() {
  // 2028-05-28 (deep-debug Bug E) — dropped `className="fill-yellow-400"`.
  // The Tailwind class was overriding `fill="currentColor"` and pinning the
  // glyph yellow regardless of context. With it removed the SVG inherits
  // color from `.media-card-cinema .star { color: #facc15 }` in index.css —
  // same yellow today, but now themeable from one place if we ever recolor.
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}
function MovieSvg() {
  return (
    <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-white/20">
      <rect x="2" y="2" width="20" height="20" rx="2.18" />
      <path d="M7 2v20M17 2v20M2 12h20" />
    </svg>
  )
}

export function MediaCardCinema({
  item, onSelect, onCardContext, libraryIds, onToggleLib,
  className = '', subtitle, aspect = 'poster', topRightOverlay,
}: MediaCardCinemaProps) {
  const isInLib = !!libraryIds?.has(item.id)
  const landscapeStyle: CSSProperties | undefined =
    aspect === 'landscape' ? { aspectRatio: '16 / 9' } : undefined

  return (
    // 2028-05-28 (deep-debug Bug A) — `group` class so the
    // topRightOverlay slot (and any future overlay children) can use
    // Tailwind's `group-hover:opacity-100` to reveal on card hover
    // instead of only on hovering the overlay itself. Without this, an
    // initially-invisible overlay (like CollectionsView's admin X)
    // becomes undiscoverable — the user can't see it to know where to
    // point. Class is harmless when no overlay is passed.
    <div
      className={`media-card-cinema group ${className}`}
      onClick={onSelect}
      onContextMenu={onCardContext}
      // outer title= = AI reason (so hovering the card shows the
      // recommender's rationale). The inner .title div has its own
      // title={item.title} so the browser picks the more-specific
      // tooltip when the user hovers the truncated title text.
      title={item.reason || undefined}
    >
      <div className="poster-wrap">
        {item.poster ? (
          <img
            src={item.poster}
            alt={item.title}
            className="poster-img"
            loading="lazy"
            style={landscapeStyle}
          />
        ) : (
          // Placeholder for items with no poster (search hits mid-
          // enrichment, library entries pre-metadata-sync). Same
          // aspect so grid alignment doesn't shift when a real poster
          // lands.
          <div className="poster-img bg-white/[0.03] flex items-center justify-center" style={landscapeStyle}>
            <MovieSvg />
          </div>
        )}
        {/* + / ✓ library badge. stopPropagation so the click toggles
            the library entry without also opening the detail view. */}
        {onToggleLib && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleLib() }}
            title={isInLib ? 'In My Library — click to remove' : 'Add to My Library'}
            aria-label={isInLib ? `Remove ${item.title} from My Library` : `Add ${item.title} to My Library`}
            className={`lib-badge ${isInLib ? 'in-lib' : ''}`}
          >
            {isInLib ? <CheckSvg /> : <PlusSvg />}
          </button>
        )}
        {/* AI-matched gem — only when the recommender attached an LLM
            reason. Decorative; reason text is shown in the shelf below
            and via the outer card's title attr. */}
        {item.reason && (
          <div className="ai-gem" aria-hidden="true">
            <SparkleSvg />
          </div>
        )}
        {/* Optional caller-controlled overlay (CollectionsView's admin
            remove-X). Rendered AFTER the gem so it stacks on top —
            collections items rarely have a reason so the conflict is
            unusual; when it happens the X takes precedence (it's the
            actionable control). */}
        {topRightOverlay}
        {/* Progress bar — only when progress > 0. */}
        {item.progress !== undefined && item.progress > 0 && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${item.progress * 100}%` }} />
          </div>
        )}
      </div>
      <div className="shelf">
        <div className="title" title={item.title}>{item.title}</div>
        {subtitle ? (
          // Custom subtitle (e.g. "S2E5" for Continue Watching) — keeps
          // the shelf height consistent without the star/year/genre row.
          <div className="meta"><span>{subtitle}</span></div>
        ) : (
          <div className="meta">
            {/* Star only when we have a real rating. Continue Watching
                items have rating=0 (the progress endpoint doesn't return
                TMDB rating) — without this guard we'd show "★ 0", a
                visible lie. */}
            {item.rating !== undefined && item.rating > 0 && (
              <>
                <span className="star"><StarSvg /> {item.rating.toFixed(1)}</span>
                {((item.year ?? 0) > 0 || item.genre) && <span className="sep">·</span>}
              </>
            )}
            {item.year !== undefined && item.year > 0 && (
              <>
                <span>{item.year}</span>
                {item.genre && <span className="sep">·</span>}
              </>
            )}
            {item.genre && <span>{item.genre}</span>}
          </div>
        )}
        {item.reason && <p className="reason">{item.reason}</p>}
      </div>
    </div>
  )
}
