// The title page's hero: the artwork, and on it everything a viewer needs to
// start watching. The backdrop runs full width behind a scrim that fades into
// the page; the poster (wide screens), the title, one line of facts and the
// action row sit at its foot.
//
// One column from here down: there is no side rail, so nothing below this has
// to line up with anything but the page's own left edge.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, Star } from 'lucide-react'
import { backdropSrcSet } from '@/lib/api'
import { ambientFor } from '@/lib/ambient'

interface DetailHeroProps {
  backdrop: string
  title: string
  // The one line of facts under the title, in order: year, content rating,
  // runtime or season count, genre. Empty entries are dropped here.
  facts?: (string | undefined | null | false)[]
  rating?: number
  tagline?: string
  error?: string | null
  onBack: () => void
  objectPosition?: string // backdrop object-position, default "center 28%"
  // Art to show when there is no backdrop, or when the backdrop fails to load
  // (the image proxy 502s on a TMDB miss): DetailView passes the poster. Below
  // lg the poster beside the title is dropped, so the backdrop is then the
  // page's ONLY artwork and must not go blank while any art exists.
  fallback?: string
  // The poster beside the title, from lg up. Undefined renders no poster box.
  poster?: string
  // The action row and anything under it (the resume progress line).
  children?: ReactNode
  // Reports the artwork's ambient colour once the image has loaded, and null
  // when it fails, so the page's wash never shows a colour with no picture.
  onAmbient?: (color: string | null, src: string) => void
}

export function DetailHero({
  backdrop,
  title,
  facts = [],
  rating,
  tagline,
  error,
  onBack,
  objectPosition = 'center 28%',
  fallback,
  poster,
  children,
  onAmbient,
}: DetailHeroProps) {
  // Sources that have failed to load, by URL. The first candidate (backdrop,
  // then fallback) that is non-empty and has not failed is shown; with none
  // left no <img> renders and the scrim carries the frame. By URL rather than
  // a flag, so a later backdrop for the same mounted hero is tried fresh.
  const [failed, setFailed] = useState<readonly string[]>([])
  const src = [backdrop, fallback].find(s => !!s && !failed.includes(s))
  // The colour is read after the picture has loaded and the browser is idle,
  // so it is reported with the source it was read from: by then the page may
  // be showing another picture, and the host keeps only a colour that still
  // matches. The latest callback is read through a ref for the same reason.
  const onAmbientRef = useRef(onAmbient)
  useEffect(() => { onAmbientRef.current = onAmbient })
  // The picture now showing. A colour is reported only for it: an answer for
  // one the hero has moved on from (the card's poster, once the backdrop has
  // replaced it) is dropped, and a change of picture withdraws the colour at
  // once, so the old picture's wash is never left under the new picture
  // while its own colour is still being read.
  const shownRef = useRef(src)
  useEffect(() => {
    // Only on a CHANGE of picture. On mount there is no colour to withdraw,
    // and saying "none" then arrived after a cached picture's colour had
    // already been reported: the wash flickered off and on at every revisit.
    if (shownRef.current === src) return
    shownRef.current = src
    onAmbientRef.current?.(null, src ?? '')
  }, [src])
  const reportAmbient = (el: HTMLImageElement, from: string) => {
    void ambientFor(el).then(color => { if (shownRef.current === from) onAmbientRef.current?.(color, from) })
  }
  const shownFacts = facts.filter((f): f is string => !!f)
  const hasRating = rating !== undefined && rating > 0

  return (
    <section className="stage-detail-hero relative flex flex-col" aria-label={title}>
      {/* The art. On a phone it is a band at the top that the title overlaps;
          from lg it fills the whole hero. */}
      <div className="stage-detail-art absolute inset-x-0 top-0 overflow-hidden">
        {/* The page's largest paint. A backdrop the server has not mirrored
            yet used to render the browser's broken-image glyph across the
            banner; on error it falls back to `fallback` (the poster). */}
        {src && (
          <img
            // key: each source gets a fresh node, so a failed one's error
            // state cannot carry over to the next candidate.
            key={src}
            src={src}
            // Only the BACKDROP gets the 2x srcset. backdropSrcSet keys on
            // the size in the URL, not on what the image is, so a poster
            // fallback at those sizes would pull the full-size original
            // poster at high priority on every 2x screen.
            srcSet={src === backdrop ? backdropSrcSet(src) : undefined}
            alt=""
            // stage-img-fade: invisible until decoded, then a short opacity
            // fade. data-loaded is a DOM attribute, not state: the ref
            // callback catches a cache hit that completed before onLoad was
            // attached, and naturalWidth guards a 404.
            className="stage-img-fade w-full h-full object-cover"
            style={{ objectPosition }}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            ref={(el) => {
              if (el && el.complete && el.naturalWidth > 0) {
                el.setAttribute('data-loaded', '')
                reportAmbient(el, src)
              }
            }}
            onLoad={(e) => {
              e.currentTarget.setAttribute('data-loaded', '')
              reportAmbient(e.currentTarget, src)
            }}
            onError={() => {
              onAmbient?.(null, src)
              setFailed(f => (f.includes(src) ? f : [...f, src]))
            }}
          />
        )}
        <div className="stage-detail-scrim" aria-hidden="true" />
      </div>

      {/* Back. On the page inset, like everything else on the page, so it
          does not drift from the content on an ultra-wide window. */}
      {/* Above the foot: the text's backing reaches up past the foot's own
          box on a wide window, and Back must stay on top of it. */}
      <div className="relative z-20 stage-gutter pt-3 lg:pt-4">
        <button
          type="button"
          onClick={onBack}
          className="stage-detail-back inline-flex items-center gap-1.5 h-11 pl-2 pr-4 rounded-full text-[14px] font-medium text-ink"
        >
          <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" /> Back
        </button>
      </div>

      {/* The gutter and the measure are separate elements, as they are on
          the page body below, and for the same reason: the outer one takes
          the page's padding so the left edge always matches every other
          page, the inner one caps the measure, and the two cannot be traded
          against each other. scripts/verify-page-alignment.mjs holds this
          row and the body to the same left edge and width at every size. */}
      <div className="stage-detail-foot relative z-10 mt-auto stage-gutter pb-2">
        <div className="stage-detail-herorow max-w-[1304px]">
          {/* The block the text's backing is drawn around: the poster and
              the text, as wide as their content from lg (the row itself
              keeps the page's measure). */}
          <div className="stage-detail-block flex items-end gap-8">
          {/* The poster is a wide-screen element. Unconditionally: keying it
              on "does the hero have a backdrop" flips for the same title
              between the pre-payload render and the payload's. Below lg it
              is display:none, and a lazy image that never lays out is never
              fetched, so a phone does not download a poster it cannot show.
              From lg it is in the first viewport and loads at once. */}
          {poster !== undefined && (
            <div className="stage-detail-poster hidden lg:block flex-none" data-title-poster="">
              <img
                // key: a src swap (the card's poster, then the payload's)
                // remounts the node so an earlier hide-on-error cannot stick.
                key={poster}
                src={poster}
                alt={`${title} poster`}
                className="stage-img-fade w-full h-full object-cover"
                loading="lazy"
                decoding="async"
                ref={(el) => { if (el && el.complete && el.naturalWidth > 0) el.setAttribute('data-loaded', '') }}
                onLoad={(e) => e.currentTarget.setAttribute('data-loaded', '')}
                // posterURL() returns '' for an unmatched title; the box's
                // own fill shows instead of alt text and a broken glyph.
                onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
              />
            </div>
          )}
          {/* flex + gap, never `space-y`: its selector skips only the hidden
              ATTRIBUTE, so a child hidden by a `hidden lg:…` class would
              still earn its neighbour a margin. */}
          <div className="stage-detail-text flex-1 min-w-0 flex flex-col gap-3.5">
            <h1
              // title=: the clamp truncates real catalogue entries and the
              // app sets no document.title, so without this the rest of a
              // long title is unrecoverable anywhere in the UI.
              title={title}
              // The padding keeps accented capitals and descenders inside
              // the clamp's clipping box at this tight leading.
              className="stage-detail-title font-display font-extrabold text-ink line-clamp-2 py-[0.08em]"
            >
              {title}
            </h1>
            {(shownFacts.length > 0 || hasRating || tagline) && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[15px] text-ink tabular-nums">
                {shownFacts.map((f, i) => (
                  <span key={`${i}:${f}`} className="inline-flex items-center gap-3">
                    {/* Punctuation between values; a screen reader saying
                        "middle dot" between every pair is noise. */}
                    {i > 0 && <span className="text-ink-3" aria-hidden="true">·</span>}
                    {f}
                  </span>
                ))}
                {hasRating && (
                  <span className="inline-flex items-center gap-3">
                    {shownFacts.length > 0 && <span className="text-ink-3" aria-hidden="true">·</span>}
                    <span className="inline-flex items-center gap-1" title="Rating out of 10">
                      <Star size={15} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                      <span className="sr-only">Rated </span>{rating!.toFixed(1)}
                    </span>
                  </span>
                )}
                {tagline && <span className="italic text-ink-2">&ldquo;{tagline}&rdquo;</span>}
              </p>
            )}
            {children}
            {error && <p role="alert" className="text-danger-ink text-[14px]">{error}</p>}
          </div>
          </div>
        </div>
      </div>
    </section>
  )
}
