// Aurora V2 — MediaCardCinema
//
// 2028-05-28 — Extracted from App.tsx so the same card design renders
// consistently across the home rails (via MediaRail) AND the grid views
// (Movies, TV Shows, My Library, Search, Collections detail). Single
// source of truth for: poster, library badge, AI gem, progress bar, and
// the on-art title/meta overlay. Future tweaks happen here once instead
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

import { memo, useState } from 'react'
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
  // 2026-06-05 (Home redesign) — landscape (16:9) cards (Continue
  // Watching) use the backdrop so the art fills the frame instead of
  // center-cropping a 2:3 poster into a sliver. Portrait callers ignore
  // it; landscape callers fall back to the poster when no backdrop.
  backdrop?: string
  year?: number
  rating?: number
  genre?: string
  // LLM-generated per-pick reason. Triggers the AI gem top-right badge and
  // the reveal-on-intent .reason-scrim over the poster bottom. (It is NOT a
  // tooltip on the card, and no longer a caption below it — the shelf that
  // held one was removed in Aurora Stage Phase 3.)
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

export interface MediaCardCinemaProps<T extends MediaLike = MediaLike> {
  item: T
  // Callbacks receive the card's own `item` back. That is what lets a rail
  // or grid hand every card the SAME function reference instead of a fresh
  // per-item closure — and same-reference props are what make the
  // React.memo on this component do anything (see the export at the end).
  onSelect: (item: T) => void
  onCardContext?: (e: ReactMouseEvent, item: T) => void
  // Library state. When BOTH provided the lib badge renders.
  libraryIds?: Set<number>
  onToggleLib?: (item: T) => void
  // Optional sizing class — rails pass `w-[206px]` (or `w-[336px]` for
  // landscape), grids leave it empty (the grid column sets the width).
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
  // Above-the-fold cards (the first few of the first Home rail) fetch their
  // art eagerly; everything else stays lazy. Default lazy.
  eager?: boolean
}

/* ─────────────────────── meta row (pure) ───────────────────────── */
// 2026-07-25 (Aurora Stage Phase 3) — the meta row's assembly is pure, so
// it lives here as a function instead of as nested JSX conditionals. Two
// reasons: it's the part with real rules worth testing (see
// MediaCardCinema.test.ts), and building a TOKEN LIST and joining with "·"
// at render removes the hand-written "should I emit a separator?" checks
// that each new token used to add — the mechanism that produces stray
// leading/trailing separators.
export interface CardMetaToken {
  /** 'rating' renders the star glyph before the value; 'text' is plain. */
  kind: 'rating' | 'text'
  value: string
}

export function buildCardMeta(
  item: Pick<MediaLike, 'rating' | 'year' | 'genre' | 'duration'>,
  opts: { subtitle?: string; showLength?: boolean } = {},
): CardMetaToken[] {
  // A caller-supplied subtitle (e.g. "S2E4 · 23m left" for Continue
  // Watching) REPLACES the whole row rather than joining it.
  //
  // Truthiness, deliberately: an EMPTY subtitle means "no override, use the
  // default row", not "render a blank row". Callers type it as
  // `string | undefined` and a resolver that misses returns undefined, but
  // '' is the plausible near-miss — so the behaviour is pinned by a test
  // rather than left to whichever reading a future editor assumes.
  if (opts.subtitle) return [{ kind: 'text', value: opts.subtitle }]

  const tokens: CardMetaToken[] = []
  // Star only for a real rating. Continue-Watching items carry rating=0
  // (the progress endpoint returns no TMDB rating) and "★ 0" is a visible
  // lie, not a missing value.
  if (item.rating !== undefined && item.rating > 0) {
    tokens.push({ kind: 'rating', value: item.rating.toFixed(1) })
  }
  if (item.year !== undefined && item.year > 0) {
    tokens.push({ kind: 'text', value: String(item.year) })
  }
  // Runtime, browse grid only, before genre so the row reads
  // "★ 9.5 · 2008 · 2h 55m · Crime". mapMedia gives '' when a title has no
  // runtime, which must not become an empty token.
  if (opts.showLength && item.duration) {
    tokens.push({ kind: 'text', value: item.duration })
  }
  if (item.genre) tokens.push({ kind: 'text', value: item.genre })
  return tokens
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

function MediaCardCinemaInner<T extends MediaLike>({
  item, onSelect, onCardContext, libraryIds, onToggleLib,
  className = '', subtitle, aspect = 'poster', topRightOverlay, onResume,
  showLength = false, showBadges = false, hoverPreview = false, eager = false,
}: MediaCardCinemaProps<T>) {
  const isInLib = !!libraryIds?.has(item.id)
  const landscapeStyle: CSSProperties | undefined =
    aspect === 'landscape' ? { aspectRatio: '16 / 9' } : undefined
  // Landscape (Continue Watching) cards fill a 16:9 frame, so prefer the
  // backdrop and fall back to the poster; portrait cards always use the
  // poster. Without this a 2:3 poster center-crops into a sliver.
  const wantedSrc = aspect === 'landscape' ? (item.backdrop ?? item.poster) : item.poster
  // A poster that 404s (the server has not mirrored the TMDB file yet)
  // used to render the browser's broken-image glyph on the primary browse
  // surface. Remember the failed URL and fall through to the same
  // placeholder a posterless item gets; a later src change retries.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const artSrc = wantedSrc && wantedSrc !== failedSrc ? wantedSrc : undefined
  // Fade-in on decode. `data-loaded` is set on the DOM node, not React
  // state, so a loaded poster never re-renders the card; the <img> is keyed
  // by src so a swapped URL starts invisible again. The ref callback covers
  // an image that completed before onLoad was attached (cache hits on
  // back-nav); naturalWidth guards a 404 that reports complete=true.
  const markLoaded = (el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) el.setAttribute('data-loaded', '')
  }
  // Poster badges (quality / maturity). Only when the caller opts in
  // AND the item actually carries tags — keeps Continue-Watching and
  // metadata-less rows clean.
  const badges = showBadges && item.tags ? item.tags.filter(Boolean) : []
  // Length token only when opted in and present (movies → "2h 55m",
  // The whole meta row, as tokens (see buildCardMeta above for the rules).
  const metaTokens = buildCardMeta(item, { subtitle, showLength })

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
      onClick={() => onSelect(item)}
      onContextMenu={onCardContext ? (e) => onCardContext(e, item) : undefined}
      // 2026-06-17 (a11y quick-win) — make the whole card keyboard-
      // activatable so the default browse surface isn't mouse-only.
      // role="button" + tabIndex put it in the tab order; onKeyDown
      // activates on Enter/Space. The `e.target !== e.currentTarget`
      // guard is critical: nested controls (lib badge, AI gem, resume
      // pill) are real <button>s, and without it a keydown fired while
      // one of them is focused would bubble up and ALSO open detail — a
      // double-action bug (the card opens detail AND toggles the
      // library). Mirrors the MediaListRow pattern, with the guard that
      // MediaListRow was missing (added there too).
      role="button"
      tabIndex={0}
      // Phase 10 — announce that a context menu exists.
      //
      // Phase 9 established that the menu IS keyboard-reachable (browsers fire a
      // real `contextmenu` for Shift+F10 and the Menu key on a focused element) and
      // concluded "the trigger was never the problem". True for SC 2.1.1 —
      // operability — and beside the point for discoverability: four of that menu's
      // items have NO other route anywhere in the app, and nothing told a
      // screen-reader user they were there. Being reachable by a shortcut you have
      // no way to learn about is not much better than being unreachable.
      //
      // `aria-keyshortcuts`, and NOT `aria-haspopup`. The first version used
      // haspopup alone, and a review showed that is the attribute ARIA's own
      // authoring note argues against in exactly this situation: "If there is no
      // visual indication that an element will trigger a popup, authors are advised
      // to consider whether use of aria-haspopup is necessary, and avoid using it
      // when it's not." This card has no chevron, no ellipsis, no affordance — that
      // absence is the whole premise.
      //
      // It was also misleading in practice. `aria-haspopup` describes what the
      // element's ACTIVATION opens, and activating a card opens the detail view,
      // not the menu; the menu comes from `contextmenu` (Shift+F10 / Menu key /
      // right-click). And NVDA maps the state to the literal string "subMenu", so
      // the announcement read "…, button, subMenu" — "this is inside a menu and
      // opens a submenu", which is not what is true.
      //
      // `aria-keyshortcuts` names the mechanism instead of gesturing at it, is
      // announced by both NVDA and JAWS, and is precisely what closes the gap:
      // four of that menu's items have no other route in the app, and the problem
      // was never operability, it was that nobody could learn the shortcut.
      // Gated on the handler actually being wired. `onCardContext` is optional and
      // four call sites omit it — LibraryView (twice), SearchView and
      // CollectionsView — so advertising the shortcut unconditionally taught it on
      // three surfaces where pressing it does nothing at all. Measured: 7 of 7 cards
      // on My Library carried it, and Shift+F10 produced no menu. MediaRail and
      // BrowseView already thread `onCardContext ? … : undefined`; this matches.
      aria-keyshortcuts={onCardContext ? 'Shift+F10' : undefined}
      // role="button" makes descendants presentational, so EVERYTHING inside
      // the card is pruned from the a11y tree and this label is the only
      // thing a screen reader gets. Title + year alone left rating, runtime,
      // genre and the quality/maturity chips with no accessible equivalent —
      // a gap that predates Phase 3 but that Phase 3 consolidated by moving
      // all of it onto the art. Fold the same tokens the eye sees into the
      // name, comma-separated so it reads as a list rather than a sentence.
      aria-label={[
        `${item.title}${item.year ? ` (${item.year})` : ''}`,
        metaTokens.length > 0
          ? metaTokens.map(t => (t.kind === 'rating' ? `rated ${t.value}` : t.value)).join(', ')
          : '',
        badges.length > 0 ? badges.join(', ') : '',
      ].filter(Boolean).join(' — ')}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(item)
        }
      }}
      // 2026-06-04 — the AI reason is NO LONGER a native title= tooltip on
      // the card. Native tooltips clash with the dark theme, lag ~1s, fire
      // from anywhere on the card (fighting the inner .title tooltip) and
      // are invisible on touch. The reason now surfaces via the
      // reveal-on-intent .reason-scrim over the poster bottom (hover /
      // focus / tap the gem). The inner .title div keeps its own
      // title={item.title} for the truncated-title case.
    >
      <div className="poster-wrap">
        {artSrc ? (
          <img
            key={artSrc}
            src={artSrc}
            alt={item.title}
            className="poster-img"
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            style={landscapeStyle}
            ref={markLoaded}
            onLoad={(e) => e.currentTarget.setAttribute('data-loaded', '')}
            onError={() => setFailedSrc(artSrc)}
          />
        ) : (
          // Placeholder for items with no poster (search hits mid-
          // enrichment, library entries pre-metadata-sync). Same
          // aspect so grid alignment doesn't shift when a real poster
          // lands.
          <div className="poster-img poster-placeholder" style={landscapeStyle}>
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
            onClick={(e) => { e.stopPropagation(); onToggleLib(item) }}
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
            glass. They sit ABOVE the on-art title block (bottom: 62px in
            index.css) — which is why .co-meta must stay one line. */}
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
        {/* 2026-07-25 (Aurora Stage Phase 3) — title + meta ON THE ART.
            This replaces the `.shelf` block that used to sit BELOW the
            poster inside the card chrome. The art is now the card; the
            text rides over a scrim at its foot.

            The scrim is not decoration — it is what keeps this text
            accessible. Its ramp is the one worked out for `.reason-scrim`
            (dense, knee at 60%) precisely because that surface had the
            same problem: near-white text over arbitrary poster art,
            including snowy backdrops and white logos. See index.css.

            NOT ported from the mockup: its faint uppercase title
            watermark at the poster top (`.pt`). The mockup generates its
            artwork from CSS gradients, so that watermark is standing in
            for a poster's own title treatment. Real TMDB posters already
            carry their title in the art — drawing a second one over it
            would double up, and it would sit under the library badge. */}
        <div className="card-overlay">
          {/* title= for the truncated case; the CARD's aria-label already
              carries title + year, so the accessible name never depends on
              this overlay rendering. */}
          <div className="co-title" title={item.title}>{item.title}</div>
          {metaTokens.length > 0 && (
            <div className="co-meta">
              {metaTokens.map((t, i) => (
                // key={i}: the list is purely positional with no per-item
                // state to preserve, and a content-derived key can COLLIDE —
                // year, runtime and genre are all kind:'text', so an item
                // with year 1917 and genre "1917" produced two identical
                // keys. The index buys the same stability without the risk.
                //
                // One wrapper per token, carrying the separator that PRECEDES
                // it: on a card too narrow for the whole row, a token that does
                // not fit wraps (with its dot) onto a clipped second line and
                // disappears whole — see .co-meta in index.css.
                <span key={i} className="co-tok">
                  {i > 0 && <span className="sep" aria-hidden="true">·</span>}
                  {t.kind === 'rating' ? (
                    <span className="star"><StarSvg /> {t.value}</span>
                  ) : (
                    <span className="co-txt">{t.value}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
        {/* Progress bar — only when progress > 0. Sits above the overlay
            so a partially-watched card still shows its state. */}
        {item.progress !== undefined && item.progress > 0 && (
          <div
            className="progress-bar"
            // Not decorative: this is the only indication of how far in the
            // user is, and the "23m left" that used to convey it sits in the
            // pruned subtitle. role+valuenow makes it readable.
            role="progressbar"
            aria-label={`${item.title} watch progress`}
            aria-valuenow={Math.round(item.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="progress-fill" style={{ width: `${item.progress * 100}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized export, shallow prop comparison, NO custom comparator: a
// comparator that ignored function props to "help" would freeze
// CollectionsView's per-item `topRightOverlay` and any caller that
// legitimately passes a new closure. Callers earn the skip by passing
// stable callbacks (the item-passing contract on the props) and a stable
// `item` reference (HomeView memoizes its rails array); a caller that
// builds `item` inline per render simply gets today's behaviour. The cast
// keeps the generic signature, which memo() would otherwise erase.
export const MediaCardCinema = memo(MediaCardCinemaInner) as typeof MediaCardCinemaInner
