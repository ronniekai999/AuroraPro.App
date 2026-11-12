// HeroSection — Tonight's hero, and only Tonight's.
//
// Resume first: when the viewer left something unfinished, the hero is that
// title, with where they are in it and how long is left. Aurora's picks
// follow in a filmstrip at the hero's lower right, which shows them all,
// says which is up and lets any be chosen. The strip is the picks only: the
// title to resume is the hero's own (and Continue Watching's first card). That strip replaces the hidden
// nine-second rotation and its "Not tonight" button: the rotation still
// runs, but it can be seen, and it can be paused by a button, which touch
// and keyboard users could not do when hovering was the only way.
//
// What is drawn, back to front. scripts/audit-onart-contrast.mjs reads this
// file's classes and index.css's scrim rules, pins this order, and fails
// when either moves:
//   1. the page ink;
//   2. the artwork, settled and incoming (two layers, so a change is a
//      dissolve, not a flash of the base);
//   3. the scrim: one for a wide screen, one for a phone, each hidden on the
//      other's range;
//   4. the content row: the title block, and the picks.
// No glow, no match ring, no pill: nothing violet is painted on the art, and
// nothing follows the pointer.
//
// For that audit's sake, text that sits on the art carries its colour and
// size as utility classes on its own element (or its direct parent), and the
// elements enclosing it carry no fill, no opacity and no inline style.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '@/components/Icon'
import { HeroSkeleton } from '@/components/Skeletons'
import { isResumable, formatResumeAriaLabel } from '@/lib/format'
import { type Media } from '@/lib/types'
import { ambientFor } from '@/lib/ambient'
import { backdropSrcSet, recordRecommendationExposure, type ContinueWatchingItem, type HeroPersonalization } from '@/lib/api'
import { resumeLine, timeLeftLabel, type SlateEntry } from '@/lib/tonightSlate'

/** A title longer than this is set narrower (the display face has a width
 *  axis) and a step smaller, before it is clamped to two lines. */
export const LONG_TITLE_CHARS = 18

export interface HeroSectionProps {
  hero?: Media
  /** Only meaningful while `hero` is absent: true while the caller still
   *  expects one, which draws the hero-shaped skeleton. False, the default,
   *  is the settled state with nothing to show (an empty library, a limit no
   *  title passes, a failed fetch), which gets the static card: a skeleton
   *  there would shimmer for the life of the page. */
  loading?: boolean
  /** What the hero is: the title to resume, one of Aurora's picks, or the
   *  catalog's fallback when the recommender has nothing. */
  kind?: 'resume' | 'pick' | 'catalog'
  /** Why Aurora picked it (picks only). */
  reason?: string
  onPlay: (m: Media) => void
  /** Open the title's page. */
  onInfo: (m: Media) => void
  /** The record to resume the hero from, when the viewer has a position in
   *  it, with its handler: a partial wiring is a type error. */
  resume?: { item: ContinueWatchingItem; onPlay: (c: ContinueWatchingItem) => void }
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  /** Start a party on the hero's title. Absent for a session not offered
   *  Together. */
  onWatchTogether?: (m: Media) => void
  /** What the hero moves through: the lead, then the picks, and which is
   *  showing. The filmstrip draws the picks. */
  slate?: SlateEntry[]
  slateIndex?: number
  onPick?: (index: number) => void
  /** The rotation's pause control. Absent when nothing rotates (one entry,
   *  reduced motion): there is then nothing to pause. */
  rotationPaused?: boolean
  onToggleRotation?: () => void
  /** Rebuild Aurora's picks. */
  onRefreshPicks?: () => void
  picksRefreshing?: boolean
  /** Play one of the picks at random. */
  onSurprise?: () => void
  /** The recommender's slate and the hero's place in it, for the exposure
   *  report. Only a pick is reported: not the title to resume (the viewer
   *  was already watching it, also when Aurora picked it too), and not the
   *  catalog's stand-in. */
  slateToken?: string
  slatePosition?: number
  profileId?: number
  /** Hold the rotation while the pointer or keyboard focus is in the hero. */
  onPauseChange?: (paused: boolean) => void
  /** For the hint in place of a reason while picks are not personal yet. */
  personalization?: HeroPersonalization | null
  /** The calmer presentation for a profile with a content limit: larger
   *  type, two actions, no picks strip. */
  kids?: boolean
  /** The artwork's ambient colour once it has loaded, with the picture it
   *  is of; null when it has none worth showing or the art failed. */
  onAmbient?: (color: string | null, src: string) => void
}

export function HeroSection({
  hero: heroProp, loading = false, kind = 'pick', reason, onPlay, onInfo, resume, libraryIds, onToggleLib, onWatchTogether,
  slate, slateIndex = -1, onPick, rotationPaused = false, onToggleRotation, onRefreshPicks, picksRefreshing = false, onSurprise,
  slateToken, slatePosition, profileId, onPauseChange, personalization, kids = false, onAmbient,
}: HeroSectionProps) {
  // Hooks run before any return, so their order never changes.
  const sectionRef = useRef<HTMLElement>(null)
  // Backdrop, else poster, else the bare base (some rows have no art).
  const bgImage = heroProp ? (heroProp.backdrop || heroProp.poster || '') : ''
  // Two art layers make a change a real dissolve. `shown` is the settled
  // image; `incoming` mounts INVISIBLE, is marked loaded once its bytes have
  // decoded (so a slow fetch never flashes the base), fades in over the old
  // art, and is promoted to `shown` after the fade. Art that 404s (the server
  // has not mirrored it yet) drops both layers, so the base shows for the new
  // title rather than the previous title's art lingering under its name.
  const [layers, setLayers] = useState<{ shown: string | null; incoming: { src: string; loaded: boolean } | null }>({ shown: null, incoming: null })
  const failedSrcRef = useRef<string | null>(null)
  useEffect(() => {
    setLayers(l => {
      if (!bgImage) return l.shown === null && l.incoming === null ? l : { shown: null, incoming: null }
      if (bgImage === l.shown) return l.incoming ? { ...l, incoming: null } : l
      if (l.incoming?.src === bgImage) return l
      // A src that 404'd last time round: drop the PREVIOUS title's art at
      // once and try again, since the server mirrors art lazily and may have
      // it by now. A second 404 clears the layers again via onError.
      if (failedSrcRef.current === bgImage) return { shown: null, incoming: { src: bgImage, loaded: false } }
      return { ...l, incoming: { src: bgImage, loaded: false } }
    })
  }, [bgImage])
  const onAmbientRef = useRef(onAmbient)
  useEffect(() => { onAmbientRef.current = onAmbient }, [onAmbient])
  // The page's wash is the picture's colour, reported with the picture it is
  // of, so a colour can never be laid behind another title. Asked for once
  // per picture: markLoaded runs from a ref callback on every render (an
  // image served from cache is complete before onLoad is attached), and a
  // report per render would be a state change per render in the caller. The
  // colour is sampled off the critical path (lib/ambient) and arrives later,
  // so it is reported only while its picture is still the one asked about.
  const ambientAsked = useRef<string | null>(null)
  const markLoaded = (src: string, img: HTMLImageElement) => {
    // A retry that succeeded is no longer a failed src.
    if (failedSrcRef.current === src) failedSrcRef.current = null
    setLayers(l => (l.incoming && l.incoming.src === src && !l.incoming.loaded
      ? { ...l, incoming: { src, loaded: true } }
      : l))
    if (ambientAsked.current !== src) {
      ambientAsked.current = src
      void ambientFor(img).then(color => {
        if (ambientAsked.current === src) onAmbientRef.current?.(color, src)
      })
    }
  }
  const failBackdrop = (src: string) => {
    failedSrcRef.current = src
    setLayers(l => (l.incoming?.src === src ? { shown: null, incoming: null } : l))
    // A picture that failed may load on a retry: forget it was asked about.
    ambientAsked.current = null
    onAmbientRef.current?.(null, src)
  }
  // Promote the incoming layer once its fade has run. A timer rather than
  // `animationend`: under reduced motion the animation is nulled and the
  // event never fires, and jsdom has no animations at all. 600ms clears the
  // 500ms fade; for the 100ms overlap both layers are at full opacity.
  const incomingLoaded = layers.incoming?.loaded ? layers.incoming.src : null
  useEffect(() => {
    if (!incomingLoaded) return
    const src = incomingLoaded
    const t = window.setTimeout(() => {
      setLayers(l => (l.incoming?.src === src ? { shown: src, incoming: null } : l))
    }, 600)
    return () => window.clearTimeout(t)
  }, [incomingLoaded])

  // The exposure report: the recommender learns that a pick was actually
  // seen as the hero, at its place in the slate, once it has been at least
  // half on screen in a visible tab for a second and a half. One report per
  // showing: choosing a pick from the filmstrip, or the rotation reaching
  // it, is a new showing. Only a pick: the server credits what the viewer
  // watches afterwards to the exposure, and a title shown as "Pick up where
  // you left off" is one they were watching already.
  const heroId = heroProp?.id
  useEffect(() => {
    if (heroId === undefined || !slateToken || slatePosition === undefined || kind !== 'pick') return
    const el = sectionRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    let sent = false
    let intersecting = false
    const send = () => {
      if (sent) return
      sent = true
      const input = { slateToken, mediaItemId: heroId, position: slatePosition, visibleMs: 1500, profileId }
      void recordRecommendationExposure(input).then(recorded => {
        // 202: the server's own record of the slate may still be on its way.
        if (!recorded) setTimeout(() => { void recordRecommendationExposure(input).catch(() => undefined) }, 2000)
      }).catch(() => undefined)
    }
    const syncTimer = () => {
      const visible = intersecting && document.visibilityState === 'visible'
      if (visible && !timer) timer = setTimeout(send, 1500)
      if (!visible && timer) { clearTimeout(timer); timer = undefined }
    }
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = !!entry?.isIntersecting && entry.intersectionRatio >= 0.5
      syncTimer()
    }, { threshold: [0.5] })
    observer.observe(el)
    document.addEventListener('visibilitychange', syncTimer)
    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
      document.removeEventListener('visibilitychange', syncTimer)
    }
  }, [heroId, kind, profileId, slatePosition, slateToken])

  // The filmstrip: the picks, each with its place in the slate (what onPick
  // takes). Drawn when there is somewhere else to go: more than one entry.
  const strip = !kids && slate && slate.length > 1 && onPick && heroProp
    ? slate.map((entry, at) => ({ entry, at })).filter(x => x.entry.kind === 'pick')
    : []
  // A thumb that holds keyboard focus can leave the strip (the picks were
  // refreshed, its title was rated away, it became the title to resume).
  // The browser then drops focus on the body, at the top of the page. It is
  // put on the thumb now in that place, else on the hero's main action.
  const stripRef = useRef<HTMLUListElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const focusedThumb = useRef<{ key: string; at: number } | null>(null)
  const stripKeys = strip.map(x => x.entry.key).join('|')
  useLayoutEffect(() => {
    const held = focusedThumb.current
    if (!held || stripKeys.split('|').includes(held.key)) return
    focusedThumb.current = null
    // Only when focus really was dropped: not taken somewhere by the viewer.
    if (document.activeElement && document.activeElement !== document.body) return
    const thumbs = stripRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
    const next = thumbs[Math.min(held.at, thumbs.length - 1)] ?? primaryRef.current
    next?.focus({ preventScroll: true })
  }, [stripKeys])

  if (!heroProp) {
    return loading ? (
      <HeroSkeleton
        kids={kids}
        aside={(
          <div className="flex-none">
            <h2 className="sr-only">Welcome to Aurora</h2>
            <p className="text-xs text-ink-2">Loading tonight&rsquo;s picks…</p>
          </div>
        )}
      />
    ) : (
      <section className="relative flex min-h-[420px] w-full items-center justify-center overflow-hidden bg-surface-page lg:h-[440px]">
        <div className="px-8 text-center">
          <h2 className="font-display text-2xl font-bold text-ink">Welcome to Aurora</h2>
          <p className="mt-2 text-sm text-ink-2">Nothing to show here yet. Titles appear once a library has been scanned.</p>
        </div>
      </section>
    )
  }
  const hero = heroProp

  // Resume only when the record is the hero's own: a rotation between the
  // viewer's glance and their press must not resume the new hero from the
  // old one's record.
  const record = resume && resume.item.media_item_id === hero.id && isResumable(resume.item) ? resume.item : null
  const playOrResume = () => {
    if (record && resume) resume.onPlay(record)
    else onPlay(hero)
  }
  const left = record ? timeLeftLabel(record.position_ms, record.duration_ms) : ''
  const where = record ? resumeLine(record) : ''
  const watchedPct = record && record.duration_ms > 0
    ? Math.round(Math.max(0, Math.min(1, record.position_ms / record.duration_ms)) * 100)
    : 0
  const inLib = !!libraryIds?.has(hero.id)
  const facts = [hero.year ? String(hero.year) : '', hero.genre, hero.duration].filter(Boolean).join(' · ')
  const coldStart = kind === 'pick' && !reason && personalization?.coldStart
    ? Math.max(0, personalization.threshold - personalization.historyCount)
    : null
  const long = hero.title.length > LONG_TITLE_CHARS

  return (
    <section
      ref={sectionRef}
      className="relative flex min-h-[420px] w-full flex-col justify-end overflow-hidden bg-surface-page lg:h-[440px]"
      data-hero-kind={kind}
      aria-label={kind === 'resume' ? `Pick up where you left off: ${hero.title}` : kind === 'pick' ? `Tonight’s pick: ${hero.title}` : `Featured: ${hero.title}`}
      // The rotation holds while the pointer is over the hero or keyboard
      // focus is inside it: nobody should have a title and its actions
      // swapped out from under them.
      onMouseEnter={() => onPauseChange?.(true)}
      onMouseLeave={() => onPauseChange?.(false)}
      onFocus={() => onPauseChange?.(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onPauseChange?.(false) }}
    >
      {/* The base: what shows where there is no art, and while it loads. */}
      <div aria-hidden="true" className="absolute inset-0 bg-surface-page" />
      {layers.shown && (
        <img
          src={layers.shown}
          srcSet={backdropSrcSet(layers.shown)}
          alt=""
          aria-hidden="true"
          className="stage-hero-img"
          decoding="async"
        />
      )}
      {layers.incoming && (() => {
        const incomingSrc = layers.incoming.src
        return (
          <img
            key={incomingSrc}
            src={incomingSrc}
            srcSet={backdropSrcSet(incomingSrc)}
            alt=""
            aria-hidden="true"
            className={`stage-hero-img is-incoming${layers.incoming.loaded ? ' is-loaded' : ''}`}
            loading="eager"
            fetchPriority={layers.shown ? 'auto' : 'high'}
            decoding="async"
            ref={(el) => { if (el && el.complete && el.naturalWidth > 0) markLoaded(incomingSrc, el) }}
            onLoad={(e) => markLoaded(incomingSrc, e.currentTarget)}
            onError={() => failBackdrop(incomingSrc)}
          />
        )
      })()}
      <div className="stage-hero-scrim" />
      <div className="stage-hero-scrim-phone" />

      <div className="stage-gutter relative z-20 flex w-full flex-col gap-6 pb-6 pt-[176px] lg:flex-row lg:items-end lg:justify-between lg:gap-12 lg:pb-9 lg:pt-0">
        {kids ? (
          <div className="flex min-w-0 max-w-[680px] flex-1 flex-col gap-4">
            <h2 key={`kids-title-${hero.id}`} className="stage-hero-swap font-display text-[48px] font-extrabold leading-[0.95] tracking-[-0.02em] text-white line-clamp-2 lg:text-[80px]">{hero.title}</h2>
            {(where || left || facts) && (
              <p key={`kids-line-${hero.id}`} className="stage-hero-swap text-lg text-ink lg:text-xl">
                {record ? [where, left].filter(Boolean).join(' · ') : facts}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={playOrResume}
                aria-label={record ? `Keep watching ${hero.title}` : `Play ${hero.title}`}
                className="stage-btn stage-btn-xl stage-btn-primary"
              >
                <Icon name="play" size={22} /> {record ? 'Keep watching' : 'Play'}
              </button>
              <button
                type="button"
                onClick={() => onInfo(hero)}
                aria-label={`${hero.type === 'show' ? 'All episodes of' : 'More about'} ${hero.title}`}
                className="inline-flex h-16 items-center rounded-full bg-white/[0.16] px-7 text-xl font-semibold text-ink transition-colors hover:bg-white/[0.24]"
              >
                <span data-hero-kids-secondary>{hero.type === 'show' ? 'All episodes' : 'More about it'}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 max-w-[620px] flex-1 flex-col gap-3.5">
            <p key={`eyebrow-${hero.id}`} className="stage-hero-swap flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-2">
              {kind === 'pick' && <span className="aurora-dot" aria-hidden="true" />}
              {kind === 'resume' ? 'Pick up where you left off' : kind === 'pick' ? 'Picked by Aurora' : 'Recently added'}
            </p>
            {/* An h2: the page's h1 is its own name ("Tonight", in HomeView),
                and this is the title of what is on it. */}
            <h2
              key={`title-${hero.id}`}
              className={long
                ? 'stage-hero-swap stage-hero-title-long font-display text-[40px] font-extrabold leading-[0.95] tracking-[-0.02em] text-white line-clamp-2 lg:text-[60px]'
                : 'stage-hero-swap font-display text-[44px] font-extrabold leading-[0.95] tracking-[-0.02em] text-white line-clamp-2 lg:text-[72px]'}
            >
              {hero.title}
            </h2>
            {/* One line under the title: where the viewer is in it, or why
                Aurora picked it, or what it is. */}
            {where ? (
              <p key={`where-${hero.id}`} className="stage-hero-swap text-[15px] text-ink lg:text-[17px]">{where}</p>
            ) : reason ? (
              <p key={`reason-${hero.id}`} className="stage-hero-swap text-[15px] text-ink line-clamp-2 lg:text-[17px]">{reason}</p>
            ) : coldStart !== null ? (
              <p key={`hint-${hero.id}`} className="stage-hero-swap text-[15px] text-ink lg:text-[17px]">
                Watch {coldStart} more {coldStart === 1 ? 'title' : 'titles'} to unlock personalized picks
              </p>
            ) : hero.description ? (
              <p key={`desc-${hero.id}`} className="stage-hero-swap text-[15px] text-ink line-clamp-2 lg:text-[17px]">{hero.description}</p>
            ) : null}
            {record && watchedPct > 0 ? (
              // How far in, on the page ink beside the time left. It used to
              // be a white bar inside the white Resume button, where neither
              // its track nor its fill could be seen.
              <div className="flex max-w-[420px] items-center gap-3">
                <div
                  className="h-[3px] min-w-0 flex-1 rounded-full bg-white/[0.22]"
                  role="progressbar"
                  aria-label={`${hero.title}: watched`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={watchedPct}
                >
                  <div className="h-[3px] rounded-full bg-white" style={{ width: `${watchedPct}%` }} />
                </div>
                {left && <span key={`left-${hero.id}`} className="flex-none text-[13px] tabular-nums text-ink-2">{left}</span>}
              </div>
            ) : facts ? (
              <p key={`facts-${hero.id}`} className="stage-hero-swap text-[13px] tabular-nums text-ink-2">{facts}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 max-sm:gap-2">
              <button
                type="button"
                ref={primaryRef}
                onClick={playOrResume}
                aria-label={record ? formatResumeAriaLabel(record) : `Play ${hero.title}`}
                className="stage-btn stage-btn-lg stage-btn-primary max-sm:flex-1"
              >
                <Icon name="play" size={18} /> {record ? 'Resume' : 'Play'}
              </button>
              <button
                type="button"
                onClick={() => onInfo(hero)}
                aria-label={`${hero.type === 'show' ? 'Episodes of' : 'Details of'} ${hero.title}`}
                className="inline-flex h-12 items-center rounded-full bg-white/[0.14] px-5 text-[15px] font-semibold text-ink transition-colors hover:bg-white/[0.22]"
              >
                <span data-hero-secondary>{hero.type === 'show' ? 'Episodes' : 'Details'}</span>
              </button>
              {onWatchTogether && (
                <button
                  type="button"
                  onClick={() => onWatchTogether(hero)}
                  aria-label={`Watch ${hero.title} together`}
                  className="inline-flex h-12 items-center gap-2 rounded-full bg-white/[0.14] px-5 text-[15px] font-semibold text-ink transition-colors hover:bg-white/[0.22] max-sm:hidden"
                >
                  <Icon name="users" size={17} /> <span data-hero-together>Watch together</span>
                </button>
              )}
              {libraryIds && onToggleLib && (
                <button
                  type="button"
                  onClick={() => onToggleLib(hero)}
                  aria-label={inLib ? `Remove ${hero.title} from My Library` : `Add ${hero.title} to My Library`}
                  title={inLib ? 'In My Library' : 'Add to My Library'}
                  className="grid h-12 w-12 flex-none place-items-center rounded-full bg-white/[0.14] text-ink transition-colors hover:bg-white/[0.22]"
                >
                  <Icon name={inLib ? 'check' : 'plus'} size={18} />
                </button>
              )}
            </div>
          </div>
        )}

        {strip.length > 0 && (
          <div className="stage-hero-picks" data-hero-picks>
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="aurora-dot" aria-hidden="true" />
              <h3 className="text-[13px] font-semibold text-ink" id="tonight-picks-label">Tonight&rsquo;s picks from Aurora</h3>
              <span className="min-w-2 flex-1" />
              {onToggleRotation && (
                <button
                  type="button"
                  onClick={onToggleRotation}
                  // The label says what a press does, and changes with it;
                  // no pressed state beside it.
                  aria-label={rotationPaused ? 'Play the rotation' : 'Pause the rotation'}
                  title={rotationPaused ? 'Play the rotation' : 'Pause the rotation'}
                  className="grid h-11 w-11 flex-none place-items-center rounded-control bg-black/60 text-ink transition-colors hover:bg-black/80"
                >
                  <Icon name={rotationPaused ? 'play' : 'pause'} size={16} />
                </button>
              )}
              {onRefreshPicks && (
                <button
                  type="button"
                  onClick={onRefreshPicks}
                  disabled={picksRefreshing}
                  aria-label={picksRefreshing ? 'Refreshing picks' : 'Refresh picks'}
                  title="Refresh picks"
                  className="grid h-11 w-11 flex-none place-items-center rounded-control bg-black/60 text-ink transition-colors hover:bg-black/80"
                >
                  {picksRefreshing ? <Icon name="refresh" size={16} className="animate-spin" /> : <Icon name="refresh" size={16} />}
                </button>
              )}
              {onSurprise && (
                <button
                  type="button"
                  onClick={onSurprise}
                  title="Play one of tonight's picks at random"
                  // Not on a phone, where it would wrap to a line of its own:
                  // the picks are one thumb's reach away there.
                  className="inline-flex h-11 flex-none items-center rounded-control bg-black/60 px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-black/80 max-sm:hidden"
                >
                  <span data-hero-surprise>Surprise me</span>
                </button>
              )}
            </div>
            <ul ref={stripRef} className="stage-hero-strip" aria-labelledby="tonight-picks-label">
              {strip.map(({ entry, at }, i) => {
                const current = at === slateIndex
                const thumb = entry.media.backdrop || entry.media.poster
                return (
                  <li key={entry.key} className="stage-hero-strip-item">
                    <button
                      type="button"
                      onClick={() => onPick?.(at)}
                      onFocus={() => { focusedThumb.current = { key: entry.key, at: i } }}
                      onBlur={() => { focusedThumb.current = null }}
                      aria-current={current ? 'true' : undefined}
                      aria-label={`${entry.media.title}${current ? ', showing now' : ''}`}
                      className="stage-hero-thumb"
                    >
                      {thumb ? (
                        <img src={thumb} alt="" loading="lazy" decoding="async" className={current ? 'stage-hero-thumb-art opacity-100' : 'stage-hero-thumb-art opacity-80'} />
                      ) : (
                        <span className={current ? 'stage-hero-thumb-art opacity-100' : 'stage-hero-thumb-art opacity-80'} />
                      )}
                      <span className={current ? 'truncate text-xs font-semibold text-white max-lg:sr-only' : 'truncate text-xs font-medium text-ink max-lg:sr-only'}>{entry.media.title}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
