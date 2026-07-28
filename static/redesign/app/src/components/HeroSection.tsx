// HeroSection — the personalized hero banner, shared by HomeView (eager, in
// App) + BrowseView (lazy). Extracted from App.tsx (2026-06-17 app split,
// Phase 2.4) so the lazy BrowseView chunk can reuse it alongside HomeView.
// heroMatchScore (the cold-start "match %" fallback) is module-private here
// — only HeroSection uses it.
import { useState } from 'react'
import { Icon } from '@/components/Icon'
import { isResumable, formatResumeTime, formatResumeAriaLabel, formatResumeLabel } from '@/lib/format'
import { type Media } from '@/lib/types'
import { type ContinueWatchingItem, type HeroPersonalization } from '@/lib/api'

// Stable, deterministic "match %" for the hero ring — the COLD-START
// FALLBACK only. The recommender now returns a real Aurora Score
// (HeroPick.score, threaded as `match`) for EVERY pick, so this fires only
// if that's somehow absent. Deliberately NOT clamped to the old flattering
// 82–98 band — that band is exactly what made every hero read the same. It
// maps the TMDB rating onto an honest spread (a 6 reads ~58, a 9 reads ~88),
// CONSISTENT-per-title (same title → same %), hashing the id when rating is
// missing so every hero still gets a number.
function heroMatchScore(media: { id: number; rating?: number }): number {
  const r = media.rating ?? 0
  if (r > 0) {
    // TMDB 0–10 → ~10..97, linear with real spread and capped just under 100
    // so we never show a fake perfect match.
    return Math.round(Math.max(5, Math.min(97, r * 9.5 + 2)))
  }
  // No rating — deterministic mid-spread from the id so it's stable across
  // renders but not clustered at the top of the scale.
  return 35 + (media.id % 31)
}
// When `hero` is absent we render a NEUTRAL placeholder rather than
// falling back to a mock entry — the mock id collided with a real
// database id and Play would stream the wrong title.
export function HeroSection({ hero: heroProp, onPlay, onInfo, reason, match, score, onNextPick, onPauseChange, personalization, resume, libraryIds, onToggleLib, isCatalogFallback, compact = false, eyebrow, countLabel, pageTitle, titleAs = 'h2' }: {
  hero?: Media
  onPlay: (m: Media) => void
  onInfo: (m: Media) => void
  // Personal "% for you" (0-100) for the current hero. Undefined / 0
  // (cold-start popular pool, no centroid) → fall back to the global Aurora
  // `score`, then to a derived estimate.
  match?: number
  // Global Aurora Score (0-100) — shown on the ring when there's no personal
  // match. Same for every viewer (title quality, not personal fit).
  score?: number
  // 2026-06-05 (Home redesign B) — My Library state for the hero's
  // "＋ My List / ✓ In My List" toggle. Both must be present for the
  // button to render (same contract as MediaCardCinema's lib badge).
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // Phase 5.3 — personalization reason ("Because you finished
  // Severance"). Rendered above the title. Empty/undefined hides.
  reason?: string
  // True when the hero is the catalog fallback (recent/top-rated) rather
  // than a pick from the personalized pool. Renders "Recently Added"
  // instead of "Featured" so the label is accurate.
  isCatalogFallback?: boolean
  // 2026-07-25 (Aurora Stage Phase 4) — compact variant for the browse
  // pages (Movies / TV). The mockup gives them a 250px title band rather
  // than Home's full 60vh stage: same backdrop / parallax / rotation
  // machinery, shorter frame, page-title type scale, an eyebrow + item
  // count, and no match ring (there is no room, and a browse page's
  // featured pick isn't a personalized recommendation anyway).
  //
  // The Play / Resume / More Info actions are KEPT. The mockup drops them
  // — its browse hero is a pure title band — but that would delete the
  // only one-click play affordance on the browse pages, so the compact
  // hero keeps them at a smaller size. Flagged in the PR as a deliberate
  // deviation rather than silently either way.
  compact?: boolean
  /** Eyebrow + count for the compact variant ("MOVIES" · "847 titles").
   * countLabel is a ReactNode: callers pass JSX so the number can be
   * emphasised. It was typed `string`, which silently accepted a fragment
   * stringified into a template literal. */
  eyebrow?: string
  countLabel?: React.ReactNode
  pageTitle?: string
  /** Heading level for the title. Browse passes 'h1' — it IS the page
   * heading there, and gating BrowseView's own <h1> behind `!heroMedia`
   * otherwise left those pages with no h1 at all and an h2-without-h1 gap.
   * Home stays 'h2' (its greeting owns the h1). */
  titleAs?: 'h1' | 'h2'
  // "Not tonight" — advance to the next pick in the loaded hero pool
  // (instant, no refetch). When absent (e.g. BrowseView's reused hero)
  // the button doesn't render.
  onNextPick?: () => void
  // Pause auto-rotation while user hovers.
  onPauseChange?: (paused: boolean) => void
  // Personalization status — drives the cold-start hint that replaces
  // the empty reason line when we're below the watch-history threshold.
  // null = unknown / not yet loaded.
  personalization?: HeroPersonalization | null
  // 2026-05-27 — Continue Watching resume bundle for the current hero.
  // When set, the primary CTA reads "Resume at MM:SS" (or "Resume S2E5
  // · MM:SS" for shows) and calls `resume.onPlay(resume.item)` instead
  // of the fresh `onPlay(hero)`. Mirrors the DetailView pattern. The
  // discriminated `{ item, onPlay }` bundle makes partial wiring a
  // type error (same rationale as DetailViewProps.resume).
  resume?: {
    item: ContinueWatchingItem
    onPlay: (c: ContinueWatchingItem) => void
  }
}) {
  // useState MUST be called before any conditional return so hook
  // ordering stays stable across renders (Rules of Hooks).
  const [mousePos, setMousePos] = useState({ x: 0.5, y: 0.5 })
  if (!heroProp) {
    return (
      // 2026-07-25 (Aurora Stage Phase 4, review fix) — matches the real
      // hero's frame. It kept `rounded-2xl border mb-8` and a different
      // height from the inset-card era; once `home` went full-bleed those
      // rounded corners landed on the viewport edges on every cold load,
      // and the frame then SNAPPED when the real hero arrived.
      <section className={`relative w-full overflow-hidden bg-gradient-to-br from-purple-950/40 via-[#0a0a0f] to-[#050505] flex items-center justify-center ${
        compact ? 'h-[250px]' : 'h-[62vh] min-h-[480px] max-h-[680px]'
      }`}>
        <div className="text-center px-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-purple-600/20 border border-purple-500/30 mb-4">
            <svg width="28" height="28" viewBox="0 0 36 36" fill="none">
              <defs>
                <linearGradient id="auroraMarkA" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#A855F7" />
                  <stop offset="0.5" stopColor="#7C3AED" />
                  <stop offset="1" stopColor="#22D3EE" />
                </linearGradient>
              </defs>
              <circle cx="18" cy="18" r="16" fill="url(#auroraMarkA)" />
              <path d="M14 11L26 18L14 25Z" fill="#FFFFFF" />
            </svg>
          </div>
          <h2 className="text-white/70 text-2xl font-bold font-display tracking-wide">Welcome to Aurora</h2>
          <p className="text-white/40 text-sm mt-2">Loading your featured content…</p>
        </div>
      </section>
    )
  }
  const hero = heroProp
  // Backdrop → poster → gradient fallback chain (some TMDB rows have
  // no backdrop image).
  const bgImage = hero.backdrop || hero.poster || ''
  // Ring value: the personal Match when we have one (personalized pool), else
  // the global Aurora Score (cold-start), else a derived estimate as a last
  // resort. `showingPersonal` drives the ring's label so "92% Match" only
  // appears when it's genuinely personal — otherwise it reads "92 Score".
  const showingPersonal = !!(match && match > 0)
  const matchScore = (match && match > 0) ? match : (score && score > 0) ? score : heroMatchScore(hero)
  const matchCircumference = 2 * Math.PI * 36
  // Subtle parallax: backdrop drifts ~2% with the mouse so the hero
  // doesn't feel like a static still. The transition smooths cursor
  // jitter into a slow drift instead of jumpy 1:1 tracking.
  const parallaxX = (mousePos.x - 0.5) * 2
  const parallaxY = (mousePos.y - 0.5) * 2

  return (
    <>
    <section
      // 2026-06-05 (Home redesign A/B) — the redesign frames the hero as
      // a rounded, INSET card (matching the mockup + the new greeting
      // band, which is also inset). Dropped the former full-bleed
      // `-mx-8 -mt-8` so the hero aligns with the greeting band and the
      // rails below it inside the page's p-8 padding. rounded-2xl + a
      // soft border give it the "glass card" treatment from the mockup.
      // 2026-07-25 (Aurora Stage Phase 4) — FULL BLEED. The rounded inset
      // card is gone: no radius, no border, no side margins, and the
      // bottom scrim lands on #050505 so the hero dissolves into the
      // rails instead of ending at a visible edge. The `home`/`movies`/
      // `shows` views opt out of .stage-page for exactly this, and their
      // other sections opt back in via .stage-gutter.
      className={
        compact
          ? 'relative w-full h-[250px] overflow-hidden bg-[#050505]'
          : 'relative w-full h-[62vh] min-h-[480px] max-h-[680px] overflow-hidden bg-[#050505]'
      }
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        setMousePos({
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height
        })
      }}
      // Pause rotation over the entire hero. Do NOT put key={hero.id}
      // on this <section>: a remount-based crossfade breaks pause-on-
      // hover because browsers don't reliably synthesize mouseenter
      // on element replacement. Key the <img> instead.
      onMouseEnter={() => onPauseChange?.(true)}
      onMouseLeave={() => onPauseChange?.(false)}
    >
      {/* Brand-gradient fallback base layer. The positioned gradient
          stack above only covers part of the hero; this paints the
          violet→ink gradient under everything so a missing/errored
          backdrop still feels on-brand. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-br from-purple-950/40 via-[#0a0a0f] to-[#050505]"
      />
      {/* Backdrop image. Key on the IMG (not the section) so the
          image element remounts on rotation — drives the fade-in
          animation per-tick — without unmounting the parent that
          owns the hover handlers and mousePos state. */}
      {bgImage ? (
        <img
          key={bgImage}
          src={bgImage}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 ease-out animate-fade-in"
          style={{
            transform: `scale(1.05) translate(${parallaxX}%, ${parallaxY}%)`,
          }}
          loading="eager"
          decoding="async"
          onError={(e) => {
            // 404 happens when the server hasn't mirrored the TMDB
            // image yet. Hide the broken-image icon; the gradient
            // layer below takes over.
            const img = e.currentTarget
            img.style.display = 'none'
          }}
        />
      ) : null}

      {/* Phase 4 — the two-layer sweep from the mockup, as one element:
          a left→right ramp for the text column plus a bottom fade that
          terminates on EXACTLY #050505 (same as the page) so there is no
          seam where the hero meets the rails. Replaces the previous
          three separate gradient divs, whose bottom layer stopped at 2/3
          height and left a faint band once the hero went full-bleed. */}
      <div className="stage-hero-scrim" />
      <div
        className="absolute inset-0 pointer-events-none mix-blend-screen opacity-30"
        style={{
          background: 'radial-gradient(ellipse 60% 70% at 20% 60%, rgba(168, 85, 247, 0.35), transparent 65%)',
        }}
      />
      {/* Top-right corner scrim — the Match ring lives here, but the scrims
          above only cover bottom + left, so on a backdrop that's bright in
          this corner (blown-out art, e.g. Person of Interest) the white score
          number + ring vanished. A soft radial vignette anchored top-right
          guarantees contrast regardless of the image, fading to transparent
          toward the focal point so it doesn't darken the artwork. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 42% 48% at 100% 0%, rgba(5,5,5,0.72), transparent 70%)',
        }}
      />

      {/* 2026-06-05 (Home redesign B) — Match ring, top-right of the
          hero. A circular purple→cyan arc showing a stable, derived
          "{n}% match" (see heroMatchScore). The inner number + label are
          aria-hidden (decorative), so role="img" + aria-label on the wrap
          is what exposes the score to assistive tech. The cold-start path
          keeps it (an honest derived signal); sits above scrims (z-20).
          
          Not on the compact (browse) variant: a 250px band has no room for
          an 84px ring, and a browse page's featured title is a catalog
          pick, not a personalized match — the number would be honest but
          meaningless there. */}
      {!compact && (
      <div
        className="absolute top-6 right-6 md:top-11 md:right-[52px] z-20 flex flex-col items-center gap-1.5"
        role="img"
        aria-label={`${matchScore} percent ${showingPersonal ? 'match' : 'Aurora score'}`}
      >
        {/* The backing that makes this cluster legible over arbitrary artwork —
            see .stage-hero-match-veil.
            Being the first child is NOT sufficient to put it behind everything,
            and the first version of this comment claimed it was. Per CSS 2.1
            Appendix E the veil is `position: absolute`, so it paints in step 6
            (positioned descendants, z-index:auto); the ring wrapper below is
            `relative` and later in tree order, so that one does land above it —
            but the eyebrow was a STATIC flex item, which paints in step 5
            (Flexbox §5.4: flex items paint as inline blocks). Step 6 beats step
            5, so the 0.72 near-black veil composited OVER the one string this
            whole primitive was added to rescue, dropping it from 11.7:1 to
            1.8:1 on a dark frame. The eyebrow now carries `relative` for the
            same reason the ring wrapper does. */}
        <div className="stage-hero-match-veil" aria-hidden="true" />
        <div className="relative w-[84px] h-[84px]">
          <svg className="w-[84px] h-[84px] -rotate-90" viewBox="0 0 84 84" aria-hidden="true">
            <defs>
              <linearGradient id="heroMatchGradient" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#a855f7" />
                <stop offset="1" stopColor="#22d3ee" />
              </linearGradient>
            </defs>
            {/* Track at 0.28, not 0.1. At 0.1 over a bright frame the unfilled
                arc measured 1.09:1 against its backdrop — the ring read as a
                floating fragment rather than a gauge.

                NOTE what this deliberately does NOT achieve. The filled arc's
                purple end (#a855f7) lands at 1.30:1 against this track on a
                bright frame, and no (backing, track) pair fixes that: the track
                has to be light to clear its own backdrop, and a light track
                converges with a mid-luminance purple. I searched the grid — 49
                combinations — and none satisfies eyebrow, numeral,
                track-vs-backdrop AND both gradient ends at once.
                That is acceptable here because the arc is a REDUNDANT encoding:
                the exact value is stated as text in the centre at 12.3:1, and
                the wrapper is role="img" with the value in its aria-label. So
                1.4.11 is met by the text, not by the arc, and the arc is a
                decorative reinforcement. Said plainly rather than chased. */}
            <circle cx="42" cy="42" r="36" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="6" />
            <circle
              cx="42" cy="42" r="36" fill="none" stroke="url(#heroMatchGradient)"
              strokeWidth="6" strokeLinecap="round"
              strokeDasharray={`${(matchScore / 100) * matchCircumference} ${matchCircumference}`}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center font-display font-bold text-xl text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.55)]" aria-hidden="true">
            {matchScore}%
          </span>
        </div>
        {/* `relative` is load-bearing, not cosmetic — it lifts this out of the
            static flex-item paint step and above .stage-hero-match-veil. See the
            note on the veil above. */}
        <span className="relative text-[10px] tracking-[0.14em] uppercase text-purple-300 font-semibold [text-shadow:0_1px_3px_rgba(0,0,0,0.55)]" aria-hidden="true">{showingPersonal ? 'Match' : 'Score'}</span>
      </div>
      )}

      {/* Content column. Left/right padding reads --page-gutter so the
          hero's text lines up with the rails beneath it — the whole point
          of moving the gutter into a token in Phase 0. */}
      {/* `.stage-gutter`, not `px-[var(--page-gutter)] max-md:px-[18px]` (Phase
          11.4). Identical computed padding — `.stage-gutter` is the same token at
          md+ and the same 18px below, via the same negated media query Tailwind
          compiles `max-md:` to — but it is now ONE source instead of two.
          A Phase 10b review found the old form agreed with the rails by
          coincidence: two hard-coded 18px literals in two files, which anyone
          could break by editing either. This makes the alignment structural, and
          it is what lets the ultra-wide cap on `.stage-gutter` apply here too —
          without that, capping the rails while the hero row stayed full-bleed
          would reintroduce the stair-step Phase 10b existed to remove.

          `min-w-0` on the text column is what fixes the 390px case, and it is the
          ONLY thing that had to change on this row.
          The column had no `min-w-0`, so its flex-basis floored at its widest
          unbreakable child (~450px) and it could not shrink into the 354px between
          the gutters; "Not tonight" is `whitespace-nowrap` and could not shrink
          either, so the row overflowed by ~48px. Removing the floor lets the column
          take 202px and the row fits.
          NO `flex-wrap` here — that was tried and reverted. Flexbox breaks lines on
          each item's HYPOTHETICAL main size, before any shrinking, and this column's
          hypothetical is its `max-w-2xl` 672px. So `flex-wrap` engaged below
          672+16+136 = 824px of content box, i.e. a ~920px VIEWPORT — not 390px.
          Through the whole 768-920 band it put "Not tonight" alone on a second line,
          where a `justify-between` line sends a single item to main-START: the
          bottom-LEFT corner, directly under Play / My List / More Info. That is the
          arrangement App.tsx explicitly rejects, in writing, as promoting a
          deliberately quiet tertiary control to Play's peer. It also grew the row
          upward inside an `overflow-hidden` hero, eating ~58px of a ~262px title
          budget and clipping the provenance pill off the top.
          This row is `justify-between` with a text column on the left and "Not
          tonight" on the right, and neither could shrink: the column had no
          `min-w-0`, so its flex-basis floor was its widest unbreakable child, and
          "Not tonight" is `whitespace-nowrap`. At 390px the two together needed
          ~48px more than the 354px between the gutters, and the row overflowed by
          about that much.
          It never looked broken because it could not: the hero is
          `overflow-hidden` and body is `overflow-x: hidden`, so the excess was
          CLIPPED rather than scrollable — which is why a whole breakpoint pass
          walked past it. Clipped overflow is worse than visible overflow, not
          better; it silently removes content instead of announcing itself. */}
      <div className="stage-gutter absolute bottom-0 left-0 right-0 z-20 flex items-end justify-between gap-4 pb-9">
        <div className="min-w-0 max-w-2xl">
          {/* Compact (browse) — eyebrow above the page title. */}
          {compact && eyebrow && <div className="stage-eyebrow mb-2">{eyebrow}</div>}
          {/* Not in compact: this row is the featured title's provenance
              badge + its genre/year, which on a browse page read as the
              PAGE's metadata ("Movies … Drama • 2016"). The compact band
              names the featured title on its own line below instead, and
              dropping this reclaims 33px of a 250px frame. */}
          {!compact && (
          <div className="flex items-center gap-3 mb-3">
            {/* 2026-06-05 (Home redesign B) — when a personalization
                reason exists, lead with an "✨ Aurora picked this for
                you" pill (replaces the plain "Recommended" copy). No
                reason → keep "Featured". The cold-start hint copy below
                is untouched. */}
            {reason ? (
              // Phase 4 — the mockup's provenance pill, not the generic
              // glass badge: this is the one element that says the pick
              // came from the recommender, so it gets its own treatment.
              <span className="stage-pick-pill inline-flex">
                <Icon name="sparkle" size={13} /> Aurora picked this for you
              </span>
            ) : isCatalogFallback ? (
              <span className="badge-glass bg-purple-500/10 text-purple-300 border border-purple-500/20">
                <Icon name="clock" size={12} /> Recently Added
              </span>
            ) : (
              <span className="badge-glass bg-purple-500/10 text-purple-300 border border-purple-500/20">
                <Icon name="star" size={12} /> Featured
              </span>
            )}
            <span className="text-white/60 text-sm">
              {hero.genre}{hero.genre && hero.year ? ' • ' : ''}{hero.year || ''}
            </span>
          </div>
          )}
          {/* Phase 5.3 — personalization reason ("Because you watched X").
              When the reason is empty AND we're in cold-start mode, show
              a hint about the watch-history threshold instead — same
              visual slot, but explanatory copy that tells the user why
              the picks aren't personalized yet. */}
          {reason ? (
            <p className="text-purple-100/85 text-sm italic mb-2 max-w-lg drop-shadow">{reason}</p>
          ) : personalization?.coldStart ? (
            <p className="text-purple-200/70 text-xs italic mb-2 max-w-md">
              Watch {Math.max(0, personalization.threshold - personalization.historyCount)} more {personalization.threshold - personalization.historyCount === 1 ? 'title' : 'titles'} to unlock personalized picks &amp; Discover rails ({personalization.historyCount}/{personalization.threshold} so far).
            </p>
          ) : null}
          {/* The display scale comes from the Phase 0 tokens, not inline
              sizes: .type-hero is --fs-hero (84px) with its line-height
              and tracking baked in, .type-browse is --fs-browse (52px).
              One place to tune, and one list to re-check when a user
              switches typeface system. Both step down below md, where 84px
              would be roughly six characters per line. */}
          {(() => {
            const Heading = titleAs
            return (
              <Heading
                // line-clamp is load-bearing at this size, not tidiness.
                // .type-hero is 84px at line-height .94 ≈ 79px per line, and
                // this column is bottom-anchored inside the root's
                // overflow-hidden — so extra lines are clipped off the TOP,
                // taking the provenance pill and the reason with them. At the
                // min-h-[480px] floor (any viewport under ~774px tall, i.e.
                // most laptops) the title budget is ~262px = 3.3 lines, and
                // ~15 chars/line at this size means a title like "Pirates of
                // the Caribbean: The Curse of the Black Pearl" wants four.
                // Clamping bounds it at every viewport instead of only the
                // ones that happen to fit.
                className={
                  compact
                    // line-clamp-1: pageTitle is "Movies" / "TV Shows", never
                    // long, and the 250px band has no room for a second line.
                    ? 'text-white font-extrabold font-display mb-1.5 drop-shadow-2xl text-3xl md:type-browse line-clamp-1'
                    // md:text-6xl closes a hierarchy inversion: without it the
                    // home hero held 48px from 640px to 1023px while the browse
                    // band went to 52px at 768px, so the browse page's title
                    // was BIGGER than the hero's on every tablet-width screen.
                    : 'text-white font-extrabold font-display mb-3 drop-shadow-2xl text-4xl sm:text-5xl md:text-6xl lg:type-hero line-clamp-3'
                }
              >
                {compact ? (pageTitle ?? hero.title) : hero.title}
              </Heading>
            )
          })()}
          {/* Compact only: NAME the featured title. In compact the heading is
              the PAGE name, the description is suppressed, and the backdrop
              rotates every 9s — so before this line the Play and More Info
              buttons retargeted silently and the user could play a title
              whose name was never on screen. line-clamp-1 keeps the count on
              one line: the compact frame has ~15px of slack, and a wrap
              clips the eyebrow off the top (the column is bottom-anchored
              inside overflow-hidden). */}
          {compact && (
            <p className="text-white/70 text-sm mb-2.5 line-clamp-1">
              <span className="text-white/50">Featured: </span>
              <span className="text-white font-semibold">{hero.title}</span>
              {countLabel ? <span className="text-white/50"> — {countLabel}</span> : null}
            </p>
          )}
          {!compact && hero.description && (
            <p className="text-white/70 text-sm md:text-base max-w-xl mb-4 line-clamp-2 drop-shadow-lg">{hero.description}</p>
          )}
          {/* This row DOES keep `flex-wrap`, and unlike the row above it cannot
              misfire at tablet widths: it lives inside the `max-w-2xl` column, and
              three pills at `px-6 py-3` plus two 12px gaps need ~430px, so it only
              wraps once the column itself is under ~430px — which happens on phones
              and nowhere else. */}
          <div className="flex flex-wrap items-center gap-3">
            {/* 2026-05-27 — Resume-aware primary CTA. When the hero
                has a CW match, click resumes at the saved position via
                resume.onPlay (which threads through to App's
                handlePlayContinue). Otherwise the classic Play button
                starts fresh via onPlay(hero). The DetailView's "From
                start" affordance still works because handlePlay itself
                stays unmodified — only the Hero's call site decides
                between fresh and resume. Same discriminated-bundle
                pattern as DetailViewProps.resume.

                Deep-debug H1 — stale-closure guard: the click handler
                checks `resume.item.media_item_id === hero.id` before
                dispatching so a mid-flight hero rotation between the
                user's hover and click doesn't end up resuming the
                NEW hero with the OLD CW record. If the identities
                no longer match, fall through to the fresh-play path
                for whatever's currently visible.

                Deep-debug M5 — sub-second guard: a 5s threshold on
                position_ms hides "Resume at 0:00" labels for users
                who opened-then-immediately-closed a title. The
                server's `position_ms > 0` filter alone wasn't enough
                because brief opens save ~100-2000ms of progress
                that's effectively "fresh." */}
            {resume && isResumable(resume.item) ? (
              <button
                onClick={() => {
                  if (resume.item.media_item_id !== hero.id) {
                    onPlay(hero) // hero rotated mid-click; play fresh instead
                    return
                  }
                  resume.onPlay(resume.item)
                }}
                // Deep-debug M4 — visual differentiator: indigo tint
                // (vs purple Play) + a clock icon prefix so users
                // scanning the Hero can tell at a glance that this
                // button resumes rather than restarts. Same shape
                // and glow weight to keep it readable as the primary
                // CTA.
                // 2026-06-05 (Home redesign B) — relative + overflow so
                // the thin embedded progress fill (below) clips to the
                // pill. extra bottom padding leaves room for the 3px bar.
                className="relative overflow-hidden flex items-center gap-2 px-6 py-3 pb-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full font-medium transition-all duration-200 hover:scale-105 glow-purple"
                title={`Resume from your last position (${formatResumeTime(resume.item.position_ms)})`}
                aria-label={formatResumeAriaLabel(resume.item)}
              >
                <Icon name="clock" size={16} /> {formatResumeLabel(resume.item)}
                {/* Embedded progress bar — fraction from the CW record's
                    position/duration. Only when duration is known and the
                    fraction is in (0,1); otherwise we omit the fill rather
                    than guess (e.g. a live item with duration_ms=0). */}
                {(() => {
                  const d = resume.item.duration_ms
                  if (!d || d <= 0) return null
                  const frac = Math.max(0, Math.min(1, resume.item.position_ms / d))
                  if (frac <= 0) return null
                  return (
                    <span className="absolute left-0 right-0 bottom-0 h-[3px] bg-white/25" aria-hidden="true">
                      <span className="block h-full bg-white" style={{ width: `${frac * 100}%`, boxShadow: '0 0 8px rgba(255,255,255,0.6)' }} />
                    </span>
                  )
                })()}
              </button>
            ) : (
              <button
                onClick={() => onPlay(hero)}
                // Names the target: in compact the heading is the page name,
                // so "Play" alone had no referent for a screen reader.
                aria-label={`Play ${hero.title}`}
                className={`flex items-center gap-2 rounded-full font-medium transition-all duration-200 hover:scale-105 glow-purple bg-purple-600 hover:bg-purple-500 text-white ${
                  compact ? 'px-4 py-2 text-sm' : 'px-6 py-3'
                }`}
              >
                <Icon name="play" size={compact ? 15 : 18} /> Play
              </button>
            )}
            {/* 2026-06-05 (Home redesign B) — "My List" toggle. Adds /
                removes the hero title from My Library. Only when the
                caller wired both libraryIds + onToggleLib (matches the
                MediaCardCinema lib-badge contract). */}
            {libraryIds && onToggleLib && (() => {
              const inLib = libraryIds.has(hero.id)
              return (
                <button
                  onClick={() => onToggleLib(hero)}
                  aria-label={inLib ? `Remove ${hero.title} from My List` : `Add ${hero.title} to My List`}
                  title={inLib ? 'In My List — click to remove' : 'Add to My List'}
                  className={`flex items-center gap-2 px-6 py-3 backdrop-blur-md rounded-full font-medium transition-all duration-200 border ${
                    inLib
                      ? 'bg-purple-500/20 text-purple-100 border-purple-400/40 hover:bg-purple-500/30'
                      : 'bg-white/10 text-white border-white/10 hover:bg-white/15 hover:border-white/20'
                  }`}
                >
                  <Icon name={inLib ? 'check' : 'plus'} size={18} /> {inLib ? 'In My List' : 'My List'}
                </button>
              )
            })()}
            <button
              onClick={() => onInfo(hero)}
              aria-label={`More info about ${hero.title}`}
              className={`flex items-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-md text-white rounded-full font-medium transition-all duration-200 border border-white/10 hover:border-white/20 ${
                compact ? 'px-4 py-2 text-sm' : 'px-6 py-3'
              }`}
            >
              <Icon name="info" size={compact ? 15 : 18} /> More Info
            </button>
          </div>
        </div>
        {/* "Not tonight" — advance to the NEXT pick in the loaded hero
            pool (instant, no refetch). Distinct from the greeting's
            "Surprise me", which pulls a whole fresh pool. The pool has
            multiple picks even in cold-start (deterministic popular-
            unwatched), so this always moves to a different title.
            2026-06-05 (Home redesign B). */}
        {onNextPick && (
          <button
            onClick={onNextPick}
            title="Not tonight — show the next pick"
            aria-label="Not tonight — show the next pick"
            // text-white/75, not /60: at 14px over this corner of the scrim /60
            // measured 4.42:1 against a bright frame — under the 4.5 floor, and
            // close enough that it read as passing without being measured. /75
            // gives 5.89:1.
            //
            // The 0.06 BORDER measures 1.19:1 and is left alone on purpose. 1.4.11
            // covers visual information required to IDENTIFY a control, and this
            // one is identified by a permanent visible text label plus an icon —
            // the border is decoration. Reaching 3:1 would need white/0.43, which
            // would make a deliberately quiet tertiary control the loudest thing
            // in the hero's bottom-right. Recorded so the next audit doesn't
            // "fix" it.
            className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-white/[0.04] hover:bg-purple-500/10 border border-white/[0.06] hover:border-purple-500/40 text-white/75 hover:text-white text-sm transition-colors whitespace-nowrap"
          >
            Not tonight <Icon name="refresh" size={15} />
          </button>
        )}
      </div>
    </section>
    {/* The seam ramp (Phase 11.4).
        The app root is `bg-[#050505] aurora-bg`, and `.aurora-bg` composites three
        purple radials at alpha 0.05-0.08 OVER that base. The hero paints its own
        opaque #050505 on top of them, so the page immediately below the hero is
        #050505-plus-tint while the hero's last row of pixels is flat #050505 — a
        hard step of roughly 6-10 sRGB levels running the full viewport width, with
        no ramp across it because the hero's fill is opaque.
        It is pre-existing, and Phase 10b made it visible: at `-mt-5` the vibe bar
        straddled the boundary and attenuated it from x=48 to x=V-48, leaving it
        bare only in the two gutters. At `mt-2` it is bare edge to edge.
        This band starts at exactly the hero's own colour and fades to transparent
        over 96px, so the tint arrives gradually instead of at an edge. It is
        decoration and sits BEHIND everything: `-z-10` rather than a positive index,
        because the vibe bar's wrapper is `z-20` and its halo `z-index: -1` inside
        that — a positive value here would paint over the bar.

        STACKING CONTEXT: `isolate` on this wrapper, and it is load-bearing rather
        than tidy. Without it the `-z-10` child escapes to the nearest ancestor
        stacking context, which on both consumers is the view root — a stacking
        context ONLY because `.animate-fade-in` leaves a transform applied. Under
        `prefers-reduced-motion` that animation is nulled with `!important`, the
        root stops being a context, `<main>` and the app root above it are plain
        unpositioned blocks, and the band lands in the root context where negative-z
        paints BEFORE in-flow block backgrounds — i.e. behind the app root's opaque
        #050505. Invisible, for exactly the users least likely to report it.
        That is verbatim the hazard index.css documents for `.convo-search::before`,
        reintroduced eight lines after citing it. `isolate` makes this wrapper its
        own context so the band cannot escape, whatever the ancestors do.
        `h-0` + an absolutely positioned child so it contributes NO layout: the gap
        arithmetic in App.tsx (`gap = margin-top + 36`) assumes the hero's next
        sibling is the bar, and an element with height here would silently add to
        every figure in that comment. */}
    <div className="relative isolate h-0 -z-10" aria-hidden="true">
      <div className="stage-hero-seam absolute inset-x-0 top-0 h-24" />
    </div>
    </>
  )
}
