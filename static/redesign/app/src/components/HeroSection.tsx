// HeroSection — "Tonight's Pick", shared by HomeView (eager, in App) +
// BrowseView (lazy). Catalogue Edition: the full-bleed cinematic banner
// became an index card — artwork plate left, record details right, a
// stamped match verdict instead of the percent ring. All behavioral
// contracts are unchanged: resume-aware primary CTA with the stale-
// closure guard, the My List toggle pair, pause-on-hover rotation,
// "Not tonight" pool advance, cold-start hint copy.
import { Icon } from '@/components/Icon'
import { isResumable, formatResumeTime, formatResumeAriaLabel, formatResumeLabel } from '@/lib/format'
import { type Media } from '@/lib/types'
import { type ContinueWatchingItem, type HeroPersonalization } from '@/lib/api'

// Stable, deterministic match score — the COLD-START FALLBACK only.
// The recommender returns a real Aurora Score (HeroPick.score, threaded
// as `match`) for every pick; this fires only if that's absent. Maps the
// TMDB rating onto an honest spread (a 6 reads ~58, a 9 reads ~88),
// consistent per title, hashing the id when the rating is missing.
function heroMatchScore(media: { id: number; rating?: number }): number {
  const r = media.rating ?? 0
  if (r > 0) {
    return Math.round(Math.max(5, Math.min(97, r * 9.5 + 2)))
  }
  return 35 + (media.id % 31)
}

// The percent ring became a stamped verdict. The exact number stays
// available (tooltip + aria-label); the band label is the visible mark.
function matchStampLabel(score: number, personal: boolean): string {
  if (!personal) return `Aurora score ${score}`
  if (score >= 80) return 'Strong match'
  if (score >= 60) return 'Good match'
  return 'Fair match'
}

// Solid / outline catalogue buttons, local to the hero.
const BTN_SOLID = 'flex items-center gap-2 px-5 py-3 bg-[var(--ink)] hover:bg-[var(--signal)] text-[var(--paper)] font-mono text-[11px] font-semibold tracking-[0.13em] uppercase transition-colors'
const BTN_OUTLINE = 'flex items-center gap-2 px-5 py-3 border border-[var(--ink)] text-[var(--ink)] hover:bg-[var(--ink)] hover:text-[var(--paper)] font-mono text-[11px] font-semibold tracking-[0.13em] uppercase transition-colors'

// When `hero` is absent we render a NEUTRAL placeholder rather than
// falling back to a mock entry — the mock id collided with a real
// database id and Play would stream the wrong title.
export function HeroSection({ hero: heroProp, onPlay, onInfo, reason, match, score, onNextPick, onPauseChange, personalization, resume, libraryIds, onToggleLib, isCatalogFallback }: {
  hero?: Media
  onPlay: (m: Media) => void
  onInfo: (m: Media) => void
  // Personal "% for you" (0-100) for the current hero. Undefined / 0
  // (cold-start popular pool, no centroid) → fall back to the global
  // Aurora `score`, then to a derived estimate.
  match?: number
  // Global Aurora Score (0-100) — used when there's no personal match.
  // Same for every viewer (title quality, not personal fit).
  score?: number
  // My Library state for the "+ Shelf / On Shelf ✓" toggle. Both must
  // be present for the button to render (same contract as
  // MediaCardCinema's lib badge).
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // Personalization reason ("Because you finished Severance").
  // Rendered as the curator's note. Empty/undefined hides.
  reason?: string
  // True when the hero is the catalog fallback (recent/top-rated)
  // rather than a pick from the personalized pool — the stamp reads
  // "Recently added" instead of "Tonight's pick" so the label is
  // accurate.
  isCatalogFallback?: boolean
  // "Not tonight" — advance to the next pick in the loaded hero pool
  // (instant, no refetch). When absent (e.g. BrowseView's reused hero)
  // the affordance doesn't render.
  onNextPick?: () => void
  // Pause auto-rotation while the user hovers.
  onPauseChange?: (paused: boolean) => void
  // Personalization status — drives the cold-start hint that replaces
  // the empty reason line when below the watch-history threshold.
  personalization?: HeroPersonalization | null
  // Continue Watching resume bundle for the current hero. When set,
  // the primary CTA resumes at the saved position via resume.onPlay.
  // Discriminated bundle so partial wiring is a type error.
  resume?: {
    item: ContinueWatchingItem
    onPlay: (c: ContinueWatchingItem) => void
  }
}) {
  if (!heroProp) {
    return (
      <section className="relative w-full min-h-[300px] mt-1 mb-10 bg-[var(--stock)] border border-[var(--ink)] flex items-center justify-center">
        <div className="text-center px-8 py-14">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-[var(--ink)] mb-4 animate-pulse" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 12 12"><path d="M3 1.5L10.5 6L3 10.5Z" fill="#F0EDE4" /></svg>
          </div>
          <h2 className="text-[var(--ink)] text-xl font-bold uppercase tracking-tight">Tonight's pick</h2>
          <p className="text-[var(--ink-2)] text-sm mt-2">The archivist is choosing…</p>
        </div>
      </section>
    )
  }
  const hero = heroProp
  // Backdrop → poster → flat-plate fallback chain (some TMDB rows have
  // no backdrop image).
  const bgImage = hero.backdrop || hero.poster || ''
  // Verdict value: the personal Match when we have one, else the global
  // Aurora Score, else a derived estimate. `showingPersonal` keeps the
  // stamp honest — "match" language only when it's genuinely personal.
  const showingPersonal = !!(match && match > 0)
  const matchScore = (match && match > 0) ? match : (score && score > 0) ? score : heroMatchScore(hero)
  const stampLabel = matchStampLabel(matchScore, showingPersonal)

  return (
    <section
      className="relative w-full mt-1 mb-10 bg-[var(--stock)] border border-[var(--ink)] grid md:grid-cols-[minmax(280px,2fr)_3fr]"
      // Pause rotation over the entire card. Key the <img>, not the
      // section — a remount-based crossfade breaks pause-on-hover
      // because browsers don't reliably synthesize mouseenter on
      // element replacement.
      onMouseEnter={() => onPauseChange?.(true)}
      onMouseLeave={() => onPauseChange?.(false)}
    >
      {/* Artwork plate. Real TMDB art in a ruled frame; a flat ink
          plate with the title initial when the image is missing or 404s
          (the server may not have mirrored it yet). */}
      <div className="relative min-h-[240px] md:min-h-[380px] bg-[var(--ink)] md:border-r border-b md:border-b-0 border-[var(--rule)] overflow-hidden">
        <span className="absolute inset-0 flex items-center justify-center text-[96px] font-extrabold text-[rgba(240,237,228,0.18)] select-none" aria-hidden="true">
          {hero.title?.[0]?.toUpperCase() || 'A'}
        </span>
        {bgImage ? (
          <img
            key={bgImage}
            src={bgImage}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover animate-fade-in"
            loading="eager"
            decoding="async"
            onError={(e) => {
              // Hide the broken-image icon; the ink plate below takes
              // over.
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : null}
      </div>

      {/* Record details. */}
      <div className="relative flex flex-col gap-4 p-6 md:p-8 min-w-0">
        {/* Stamped verdict — replaces the percent ring; the number
            stays in the tooltip and accessible name. */}
        <div
          className="absolute top-5 right-5 rotate-6 border-2 border-[var(--signal)] text-[var(--signal)] font-mono text-[10px] font-semibold tracking-[0.18em] uppercase px-2.5 py-1.5 pointer-events-none select-none hidden sm:block"
          role="img"
          title={`${matchScore} ${showingPersonal ? 'percent match' : 'Aurora score'}`}
          aria-label={`${stampLabel} — ${matchScore} ${showingPersonal ? 'percent match' : 'Aurora score'}`}
        >
          {stampLabel}
        </div>

        <div className="flex items-center gap-3 flex-wrap pr-28">
          <span className={`stamp ${isCatalogFallback ? '' : 'stamp--red'}`}>
            {reason ? "Tonight's pick" : isCatalogFallback ? 'Recently added' : 'Featured'}
          </span>
          <span className="text-[var(--ink-2)] font-mono text-[11px] tracking-[0.08em] uppercase">
            {hero.genre}{hero.genre && hero.year ? ' · ' : ''}{hero.year || ''}
          </span>
        </div>

        <h2 className="text-[var(--ink)] text-3xl md:text-5xl font-extrabold uppercase tracking-tight leading-[0.95] text-balance">
          {hero.title}
        </h2>

        {/* Curator's note ("Because you watched X"). When the reason is
            empty AND we're in cold-start mode, the same slot explains
            the watch-history threshold instead. */}
        {reason ? (
          <div className="border border-[var(--rule-faint)] bg-[var(--paper)] px-4 py-3 max-w-xl">
            <span className="cat-label !text-[var(--signal)] block mb-1">Curator's note</span>
            <p className="text-[var(--ink)] text-[13px] leading-relaxed">{reason}</p>
          </div>
        ) : personalization?.coldStart ? (
          <div className="border border-[var(--rule-faint)] bg-[var(--paper)] px-4 py-3 max-w-xl">
            <span className="cat-label block mb-1">From the archivist</span>
            <p className="text-[var(--ink-2)] text-[13px] leading-relaxed">
              Watch {Math.max(0, personalization.threshold - personalization.historyCount)} more {personalization.threshold - personalization.historyCount === 1 ? 'title' : 'titles'} to unlock personalized picks &amp; curated shelves ({personalization.historyCount}/{personalization.threshold} so far).
            </p>
          </div>
        ) : null}

        {hero.description && (
          <p className="text-[var(--ink-2)] text-sm md:text-[15px] max-w-xl line-clamp-3">{hero.description}</p>
        )}

        <div className="flex items-center gap-2.5 flex-wrap mt-auto pt-2">
          {/* Resume-aware primary CTA. Stale-closure guard: verify the
              CW record still belongs to the visible hero before
              dispatching — a mid-hover rotation must not resume the NEW
              hero with the OLD record (falls through to fresh play).
              isResumable also hides "Resume at 0:00" for sub-5s opens. */}
          {resume && isResumable(resume.item) ? (
            <button
              onClick={() => {
                if (resume.item.media_item_id !== hero.id) {
                  onPlay(hero) // hero rotated mid-click; play fresh instead
                  return
                }
                resume.onPlay(resume.item)
              }}
              className={`relative overflow-hidden ${BTN_SOLID} pb-4`}
              title={`Resume from your last position (${formatResumeTime(resume.item.position_ms)})`}
              aria-label={formatResumeAriaLabel(resume.item)}
            >
              <Icon name="clock" size={14} /> {formatResumeLabel(resume.item)}
              {/* Embedded progress rule — fraction from the CW record.
                  Only when duration is known and the fraction is in
                  (0,1); otherwise omit rather than guess. */}
              {(() => {
                const d = resume.item.duration_ms
                if (!d || d <= 0) return null
                const frac = Math.max(0, Math.min(1, resume.item.position_ms / d))
                if (frac <= 0) return null
                return (
                  <span className="absolute left-0 right-0 bottom-0 h-[3px] bg-[rgba(240,237,228,0.25)]" aria-hidden="true">
                    <span className="block h-full bg-[var(--signal)]" style={{ width: `${frac * 100}%` }} />
                  </span>
                )
              })()}
            </button>
          ) : (
            <button onClick={() => onPlay(hero)} className={BTN_SOLID}>
              <Icon name="play" size={14} /> Play
            </button>
          )}
          {/* Shelf toggle. Renders only when the caller wired both
              libraryIds + onToggleLib (MediaCardCinema contract). */}
          {libraryIds && onToggleLib && (() => {
            const inLib = libraryIds.has(hero.id)
            return (
              <button
                onClick={() => onToggleLib(hero)}
                aria-label={inLib ? `Remove ${hero.title} from your shelf` : `Add ${hero.title} to your shelf`}
                title={inLib ? 'On your shelf — click to remove' : 'Add to your shelf'}
                className={inLib ? BTN_SOLID : BTN_OUTLINE}
              >
                <Icon name={inLib ? 'check' : 'plus'} size={14} /> {inLib ? 'On shelf' : 'Shelf'}
              </button>
            )
          })()}
          <button onClick={() => onInfo(hero)} className={BTN_OUTLINE}>
            <Icon name="info" size={14} /> Details
          </button>
          {/* "Not tonight" — advance to the NEXT pick in the loaded
              pool (instant, no refetch). Distinct from the greeting's
              Dealer's Choice, which plays a random pick. */}
          {onNextPick && (
            <button
              onClick={onNextPick}
              title="Not tonight — show the next pick"
              aria-label="Not tonight — show the next pick"
              className="ml-auto font-mono text-[10.5px] font-semibold tracking-[0.13em] uppercase text-[var(--ink-2)] hover:text-[var(--signal)] transition-colors whitespace-nowrap px-2 py-2"
            >
              Not tonight →
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
