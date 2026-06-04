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
  // 2026-05-31 (library hybrid redesign) — formatted runtime from
  // mapMedia (formatDuration(runtime_minutes)): "2h 55m" for movies, a
  // per-episode runtime like "45m" for shows, or "" when unknown. NOTE:
  // this is a RUNTIME, not a season count — there is no "N Seasons"
  // path today. Shown in the meta row ONLY when `showLength` is set
  // (the Movies/TV grid); rails keep the compact star·year·genre meta.
  // Empty just omits the token (no stray separator).
  duration?: string
  // 2026-05-31 — quality / maturity chips already assembled by
  // mapMedia (e.g. ["4K", "TV-MA"]) from the list payload's has_4k +
  // content_rating. Rendered as poster badges ONLY when `showBadges`
  // is set. Continue-Watching items carry no tags, so even if a future
  // caller sets showBadges on a CW card nothing spurious renders.
  tags?: string[]
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
  // 2026-05-27 — Continue Watching one-click resume affordance.
  // When set, a small "Resume" pill appears at the bottom-right of
  // the poster on hover / focus. Click on the pill resumes; click
  // anywhere else on the card still opens detail (preserves the
  // "click → detail → act" design language for the rest of the
  // surfaces). Caller decides whether to provide it — typically
  // only the Continue Watching rail / grid wire this so a
  // partially-watched title that ALSO appears in (e.g.) Top Rated
  // doesn't get a Resume pill there.
  onResume?: () => void
  // 2026-05-31 (library hybrid redesign) — opt-in enrichments used ONLY
  // by the Movies/TV browse grid. Defaulting them off keeps the 5 other
  // callers (home rails, library, search, collections, CW) pixel-identical.
  //  • showLength: append the formatted `duration` to the meta row.
  //  • showBadges: render quality/maturity chips (from `tags`) as poster
  //    badges in the bottom-left.
  //  • hoverPreview: reveal the cinematic hover scrim + center play
  //    glyph. NOTE: clicking it still calls onSelect (open detail) — it
  //    does NOT play directly, preserving the established
  //    "click → detail → act" language so we don't have to thread an
  //    onPlay through every surface. Purely a richer affordance.
  showLength?: boolean
  showBadges?: boolean
  hoverPreview?: boolean
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
  className = '', subtitle, aspect = 'poster', topRightOverlay, onResume,
  showLength = false, showBadges = false, hoverPreview = false,
}: MediaCardCinemaProps) {
  const isInLib = !!libraryIds?.has(item.id)
  const landscapeStyle: CSSProperties | undefined =
    aspect === 'landscape' ? { aspectRatio: '16 / 9' } : undefined
  // Poster badges (quality / maturity). Only when the caller opts in
  // AND the item actually carries tags — keeps Continue-Watching and
  // metadata-less rows clean.
  const badges = showBadges && item.tags ? item.tags.filter(Boolean) : []
  // Length token only when opted in and present (movies → "2h 55m",
  // shows → episode runtime like "45m"). Empty string from mapMedia
  // (no runtime_minutes) omits it without leaving a stray separator.
  const lengthText = showLength && item.duration ? item.duration : ''

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
      // 2026-06-04 — the AI reason is NO LONGER a native title= tooltip on
      // the card. Native tooltips clash with the dark theme, lag ~1s, fire
      // from anywhere on the card (fighting the inner .title tooltip) and
      // are invisible on touch. The reason now surfaces via the
      // reveal-on-intent .reason-scrim over the poster bottom (hover /
      // focus / tap the gem). The inner .title div keeps its own
      // title={item.title} for the truncated-title case.
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
        {/* 2026-05-31 — cinematic hover preview (browse grid only). A
            scrim + center play glyph that fades in on hover/focus. It is
            DECORATIVE: the click is the card's own onSelect (open detail),
            so we deliberately don't attach a separate handler here — that
            keeps the "click → detail → act" language intact and avoids
            threading an onPlay through every caller. aria-hidden + the
            scrim ignoring pointer events means it never intercepts the
            library/resume buttons stacked above it. */}
        {hoverPreview && (
          <div className="card-hover-preview" aria-hidden="true">
            <span className="chp-play">
              <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="5 3 19 12 5 21" />
              </svg>
            </span>
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
        {/* AI-matched gem + reveal affordance — only when the recommender
            attached an LLM reason. The gem is BOTH the always-on
            "AI-picked" signal AND the explicit control that surfaces the
            full reason:
              • desktop  — hovering the card fades .reason-scrim up (CSS).
              • keyboard — tabbing to this button reveals it (the card's
                           :focus-within drives the same scrim).
              • touch    — tapping the gem focuses it → :focus-within →
                           reveal; tapping elsewhere opens detail.
            The onClick both stops the tap from navigating AND explicitly
            focuses the gem: Safari / iOS / Firefox do NOT focus a <button>
            on tap by default, so without the focus() the touch reveal
            would silently fail there. The reason TEXT lives in
            .reason-scrim (kept in the DOM, only opacity-hidden) so screen
            readers get it without interaction — this button just carries a
            short label. */}
        {item.reason && (
          <button
            type="button"
            className="ai-gem"
            onClick={(e) => {
              e.stopPropagation()
              // preventScroll: focusing must not yank the rail into view.
              e.currentTarget.focus({ preventScroll: true })
            }}
            aria-label="Why this is recommended"
          >
            <SparkleSvg />
          </button>
        )}
        {/* Reveal-on-intent reason scrim — the full LLM reason over the
            poster bottom. Hidden by default (opacity 0), faded up on card
            :hover / :focus-within (see index.css). NOT aria-hidden: the
            text stays in the accessibility tree so screen readers read the
            reason regardless of the visual reveal. pointer-events stay off
            so it never intercepts the card's click-to-detail. */}
        {item.reason && (
          <div className="reason-scrim">
            <p className="reason-text">{item.reason}</p>
          </div>
        )}
        {/* Optional caller-controlled overlay (CollectionsView's admin
            remove-X). Rendered AFTER the gem so it stacks on top —
            collections items rarely have a reason so the conflict is
            unusual; when it happens the X takes precedence (it's the
            actionable control). */}
        {topRightOverlay}
        {/* 2026-05-27 — Resume pill. Caller-supplied onResume keeps
            the component generic; rail/grid components decide whether
            to wire it per-card. Bottom-right of poster, above the
            progress bar (which carries CW state visually). Hidden
            until card hover/focus so it doesn't compete with the
            poster art on first paint. e.stopPropagation prevents the
            card's onClick (open detail) from firing alongside. */}
        {onResume && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onResume() }}
            className="resume-pill"
            // Deep-debug L2 — only aria-label (no title) so NVDA /
            // VoiceOver don't double-announce. The aria-label carries
            // the title context; visible "Resume" text is the label
            // sighted users see.
            aria-label={`Resume ${item.title}`}
          >
            {/* Play triangle — same visual cue as Hero / DetailView.
                Deep-debug L1 — 3-point polygon (auto-closes), matches
                Hero/detail rendering exactly. */}
            <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="5 3 19 12 5 21" />
            </svg>
            Resume
          </button>
        )}
        {/* 2026-05-31 — quality / maturity badges (browse grid only).
            Bottom-left of the poster so they don't collide with the
            top-corner lib badge / AI gem. First tag (quality, e.g. "4K")
            gets the accent treatment; the rest (maturity) are neutral
            glass. Hidden behind the progress bar's 3px strip is fine —
            badges sit 14px up. */}
        {badges.length > 0 && (
          <div className="card-badges" aria-hidden="true">
            {badges.map((b, i) => (
              <span
                key={b}
                // HDR always gets its amber accent; otherwise the first
                // tag (the resolution, e.g. 4K) gets the purple quality
                // accent and the rest (maturity rating) stay neutral. The
                // two accents are mutually exclusive: an HDR-but-not-4K
                // item has 'HDR' at index 0, and we want amber there, not
                // purple — so the HDR check wins over the i===0 check.
                className={`card-badge ${b === 'HDR' ? 'is-hdr' : i === 0 ? 'is-quality' : ''}`}
              >{b}</span>
            ))}
          </div>
        )}
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
                {(item.genre || lengthText) && <span className="sep">·</span>}
              </>
            )}
            {/* Runtime token (browse grid only). Placed before genre so
                the row reads "★ 9.5 · 2008 · 2h 55m · Crime". Only
                renders when showLength is set AND duration is non-empty
                (shows with no per-episode runtime simply omit it). */}
            {lengthText && (
              <>
                <span>{lengthText}</span>
                {item.genre && <span className="sep">·</span>}
              </>
            )}
            {item.genre && <span>{item.genre}</span>}
          </div>
        )}
        {/* The reason is no longer an always-on truncated caption here —
            it moved to the reveal-on-intent .reason-scrim over the poster
            (above), so the shelf stays compact and rail heights uniform. */}
      </div>
    </div>
  )
}
