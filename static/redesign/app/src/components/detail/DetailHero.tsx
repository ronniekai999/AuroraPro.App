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
      <img
        src={backdrop}
        alt=""
        className="w-full h-full object-cover scale-105"
        style={{ objectPosition }}
      />
      {/* Phase 5 — the mockup's two-layer ramp as one element. Replaces two
          inline-styled gradient divs; the bottom fade now reaches higher
          because the poster rail overlaps up into this hero from lg and needs
          a dark floor beneath it. */}
      <div className="stage-detail-scrim" />
      <div className="aurora-floor" />

      <button
        type="button"
        onClick={onBack}
        className="absolute top-6 left-6 z-10 flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 backdrop-blur-md rounded-full text-sm transition-all border border-white/10"
      >
        <ArrowLeftIcon size={16} /> Back
      </button>

      {/* From lg the poster rail rides up into this hero (see
          .stage-detail-body), so the text column shifts right by the rail's
          width + gap — 216 + 40 + the 48px gutter = 304px. That offset is
          what makes the overlap safe: it is the collision this file's header
          comment warns about, avoided by geometry rather than by dropping the
          overlap. Below lg the grid is single-column, there is no overlap, and
          the text keeps the full width. */}
      <div className="absolute bottom-7 left-8 right-8 md:left-10 md:right-10 lg:left-[304px] lg:right-[var(--page-gutter)]">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="badge-glass bg-purple-500/15 text-purple-200 border border-purple-500/25 uppercase tracking-wide">
            {kindLabel}
          </span>
          {contentRating && (
            <span className="badge-glass bg-white/5 text-white/55 border border-white/10">{contentRating}</span>
          )}
        </div>
        {/* .type-detail is --fs-detail (fluid, ≤64px) with per-typeface
            leading — same mechanism Phase 4 introduced for the home hero
            after a fixed size overflowed its frame and clipped content off
            the top. line-clamp-2 bounds the pathological title; this column
            is narrower than home's, so it wraps sooner. */}
        <h1 className="font-display font-extrabold text-4xl sm:text-5xl lg:type-detail mb-3 line-clamp-2 drop-shadow-[0_2px_24px_rgba(0,0,0,0.6)]">
          {title}
        </h1>
        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[15px]">
          {metaParts.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="text-white/30">·</span>}
              {p}
            </Fragment>
          ))}
        </div>
        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
      </div>
    </section>
  )
}
