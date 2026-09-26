// Aurora V2 — DetailView hero banner.
//
// Tall cinematic backdrop with bottom/left gradients + a subtle purple
// "aurora-floor" glow, badges, title, and a single meta row. No poster in
// the hero (it lives in the rail) — the negative-margin overlap collides,
// which is the bug we already fixed in the mockup.
//
// 2026-07-25 (Aurora Stage Phase 2) — this used to note that DetailView's
// root applied a -mx-8/-mt-8 bleed. It doesn't any more: App's content
// wrapper no longer pads, and the `detail` view opts out of the page
// gutter, so the section is genuinely full-bleed with nothing to escape.

import { Fragment } from 'react'
import { ArrowLeftIcon, StarIcon } from './icons'
import { backdropSrcSet } from '@/lib/api'

interface DetailHeroProps {
  backdrop: string
  title: string
  kindLabel: string // "Movie" | "Series"
  contentRating?: string
  rating?: number
  year?: number
  metaMiddle?: string // runtime for a movie | "2 Seasons" for a show
  genre?: string
  tagline?: string
  error?: string | null
  onBack: () => void
  objectPosition?: string // backdrop object-position, default "center 28%"
  // Called with the failing src when the backdrop does not load, after it is
  // hidden. DetailView uses it to know the hero is showing NO art, so the
  // rail's poster must stay up on single-column layouts.
  onBackdropError?: (src: string) => void
}

export function DetailHero({
  backdrop,
  title,
  kindLabel,
  contentRating,
  rating,
  year,
  metaMiddle,
  genre,
  tagline,
  error,
  onBack,
  objectPosition = 'center 28%',
  onBackdropError,
}: DetailHeroProps) {
  const metaParts: React.ReactNode[] = []
  if (rating !== undefined && rating > 0) {
    metaParts.push(
      <span className="flex items-center gap-1.5 text-yellow-400 font-semibold">
        <StarIcon size={16} />
        {rating.toFixed(1)}
      </span>,
    )
  }
  if (year && year > 0) metaParts.push(<span className="text-white/70">{year}</span>)
  if (metaMiddle) metaParts.push(<span className="text-white/70">{metaMiddle}</span>)
  if (genre) metaParts.push(<span className="text-white/70">{genre}</span>)
  if (tagline) metaParts.push(<span className="italic text-purple-200/70">&ldquo;{tagline}&rdquo;</span>)

  return (
    <section className="relative h-[58vh] min-h-[440px] max-h-[560px] overflow-hidden">
      {/* The detail page's largest paint. It shipped with no loading hints
          and no error path: a backdrop the server has not mirrored yet
          rendered the browser's broken-image glyph across a 58vh banner.
          Hidden on error; the gradient ramp below carries the frame. */}
      <img
        key={backdrop}
        src={backdrop}
        srcSet={backdropSrcSet(backdrop)}
        alt=""
        className="w-full h-full object-cover scale-105"
        style={{ objectPosition }}
        loading="eager"
        fetchPriority="high"
        decoding="async"
        onError={(e) => { e.currentTarget.style.visibility = 'hidden'; onBackdropError?.(backdrop) }}
      />
      {/* Phase 5 — the mockup's two-layer ramp as one element, replacing two
          inline-styled gradient divs.

          The first cut of this made the bottom fade WEAKER than the pair it
          replaced (0.13 alpha where the old pair gave 0.49, at 46% of hero
          height where the poster's top edge lands) while a comment here
          claimed the opposite. The alpha figures were then corrected but the
          gradient was left thin — and it turned out to matter, not just
          aesthetically: the badge row sits in that thin band and its
          content-rating chip fell below WCAG AA. The stops now restore the
          old weight low down; see .stage-detail-scrim for the arithmetic. */}
      <div className="stage-detail-scrim" />
      <div className="aurora-floor" />

      <button
        type="button"
        onClick={onBack}
        // `left-[var(--page-pad-x)]`, not `left-6`. Phase 12 fix pass: this was the
        // one piece of detail chrome that stayed pinned to the viewport while the
        // rest of the page gained an ultra-wide cap, so it sat at x=24 while
        // everything it belongs to moved to 320 at 2560 and 960 at 3840 — 936px
        // adrift, measured in the running app.
        // Pre-existing (24 vs 48 was a 24px offset before), but the cap turns a
        // rounding difference into a page-width one. Same defect class as the top
        // nav, one element over.
        // 24px at md+ vs the page's 48 was never deliberate the way the nav's 30px
        // is; there is no comment claiming it and no measurement behind it, so this
        // adopts the page inset outright rather than preserving an accident.
        className="absolute top-6 left-[var(--page-pad-x)] z-10 flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 backdrop-blur-md rounded-full text-sm transition-ui border border-white/10"
      >
        <ArrowLeftIcon size={16} /> Back
      </button>

      {/* From lg the poster rail rides up into this hero (the body below
          carries lg:-mt-[238px]), so the text column shifts right by the rail's
          width + gap — 216 + 40 + the 48px gutter = 304px. That offset is
          what makes the overlap safe: it is the collision this file's header
          comment warns about, avoided by geometry rather than by dropping the
          overlap. Below lg the grid is single-column, there is no overlap, and
          the text keeps the full width. */}
      {/* z-10 (on the already-absolute box — NOT `relative`, which would have
          fought `absolute` and won) keeps this column above the main column's
          252px of transparent-but-hit-testable padding, so the title, meta and
          error line stay selectable and the title's tooltip can fire. Below
          the rail's lg:z-20, so the poster still overlaps the artwork.

          Insets read --page-pad-x (the page token, capped) rather than hard-coding them: the right edge
          already did, and a left edge baked at 304px would silently desync the
          moment the token changes. 256px = 216 rail + 40 gap.

          lg:max-w-[1048px] = the body's 1304px measure minus the 304px offset and
          the 48px gutter. Without it the title kept measuring 48px from the
          VIEWPORT while the column beneath it stopped at 1352px, so above
          1400px wide the headline cantilevered up to 1160px past the tabs and
          storyline it is supposed to align with. */}
      <div className="absolute bottom-7 z-10 left-[var(--page-pad-x)] right-[var(--page-pad-x)] lg:left-[calc(var(--page-pad-x)+256px)] lg:max-w-[1048px]">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="badge-glass bg-purple-500/15 text-purple-200 border border-purple-500/25 uppercase tracking-wide">
            {kindLabel}
          </span>
          {/* bg-black/60 + text-white/85, NOT the bg-white/5 + text-white/55
              this used to carry. .badge-glass is 11.2px/600 — normal text for
              WCAG 1.4.3, so 4.5:1 — and a 0.05-alpha white fill lets the
              backdrop through, so the chip's contrast was a function of the
              artwork behind it. Worst case (a bright frame) it measured
              3.83:1: a real AA failure introduced in this phase, because the
              chip sits higher up the scrim than the meta row does. Note the
              strengthened scrim alone only got it to 4.41 — still short, so
              the fill had to change too.

              A near-opaque dark fill makes the ratio artwork-INDEPENDENT.
              Even with the scrim removed entirely and pure-white artwork
              beneath, black/60 composites to #666 and white/85 text on it is
              4.69:1; against the real scrim it is 13.27:1. Opacity alone could
              not fix this — no white-alpha fill passes over a white frame. */}
          {contentRating && (
            <span className="badge-glass bg-black/60 text-white/85 border border-white/10">{contentRating}</span>
          )}
        </div>
        {/* .type-detail is --fs-detail (fluid, ≤64px) with per-typeface
            leading — same mechanism Phase 4 introduced for the home hero
            after a fixed size overflowed its frame and clipped content off
            the top. line-clamp-2 bounds the pathological title; this column
            is narrower than home's, so it wraps sooner. */}
        <h1
          // title=: line-clamp-2 truncates real catalogue entries ("Dr.
          // Strangelove or: How I Learned…" is 68 chars, ~57 fit) and the app
          // sets no document.title, so without this the rest is unrecoverable
          // anywhere in the UI. Works only because of the z-10 above.
          title={title}
          // py-[0.14em]: the clamp's overflow:hidden clips at the padding box,
          // and --lh-detail (0.98–1.02 depending on typeface) is far below the
          // ~1.14em ink span of a line containing accented capitals — so those
          // and descenders were being shaved. Padding, not a bigger
          // line-height, so the token keeps meaning what it says for unclamped
          // uses of .type-detail. 0.14em covers the gap at every face.
          className="font-display font-extrabold text-4xl sm:text-5xl lg:type-detail mb-3 line-clamp-2 py-[0.14em] drop-shadow-[0_2px_24px_rgba(0,0,0,0.6)]"
        >
          {title}
        </h1>
        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[15px]">
          {metaParts.map((p, i) => (
            <Fragment key={i}>
              {/* text-white/45, not /30, and aria-hidden.
                  At /30 this separator measured 2.60:1 over .stage-detail-scrim
                  plus .aurora-floor on a dark poster — failing 4.5:1 for 15px
                  text and failing even the 3:1 non-text floor. The card's
                  equivalent `.sep` already records the identical finding and the
                  identical fix (index.css: "0.45, not 0.3: at 0.3 the dots
                  measured 2.71:1 over the scrim on a bright poster — under even
                  the 3:1 non-text floor"); this component was simply never
                  brought along. /45 gives 4.51:1.
                  aria-hidden because it is punctuation between meta values and a
                  screen reader announcing "middle dot" between every pair is
                  noise — the card's `.sep` is aria-hidden for the same reason and
                  this one was not. */}
              {i > 0 && <span className="text-white/45" aria-hidden="true">·</span>}
              {p}
            </Fragment>
          ))}
        </div>
        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
      </div>
    </section>
  )
}
