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
    <section className="relative h-[58vh] min-h-[480px] overflow-hidden">
      <img
        src={backdrop}
        alt=""
        className="w-full h-full object-cover scale-105"
        style={{ objectPosition }}
      />
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(to top,#050505 3%,rgba(5,5,5,.42) 52%,rgba(5,5,5,.05) 100%)' }}
      />
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(to right,rgba(5,5,5,.85),transparent 62%)' }}
      />
      <div className="aurora-floor" />

      <button
        type="button"
        onClick={onBack}
        className="absolute top-6 left-6 z-10 flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 backdrop-blur-md rounded-full text-sm transition-all border border-white/10"
      >
        <ArrowLeftIcon size={16} /> Back
      </button>

      <div className="absolute bottom-7 left-8 right-8 md:left-10 md:right-10">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="badge-glass bg-purple-500/15 text-purple-200 border border-purple-500/25 uppercase tracking-wide">
            {kindLabel}
          </span>
          {contentRating && (
            <span className="badge-glass bg-white/5 text-white/55 border border-white/10">{contentRating}</span>
          )}
        </div>
        <h1 className="font-display font-bold text-4xl md:text-[3.5rem] leading-none mb-3 drop-shadow-[0_2px_24px_rgba(0,0,0,0.6)]">
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
