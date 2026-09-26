// DetailView — the title detail page (hero, tabs, episodes, cast, files,
// recap, trailer). Extracted from App.tsx (2026-06-17 app split, Phase 2.5)
// and lazy-loaded so the detail experience leaves the main chunk. App owns
// all data + handlers and passes them as props; the inline `resume` IIFE and
// `onEpisodeUnavailable` closure STAY in App's render block (they close over
// App state) and are threaded in as props — NOT moved here. DetailViewProps
// is module-private. DetailView fetches its own "Previously" recap (getRecap)
// so the recap modal stays presentational.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DetailHero } from '@/components/detail/DetailHero'
import { DetailRail } from '@/components/detail/DetailRail'
import { TrailerModal } from '@/components/detail/TrailerModal'
import { RecapModal } from '@/components/detail/RecapModal'
import { DetailTabs, type DetailTab } from '@/components/detail/DetailTabs'
import { QualityChips } from '@/components/detail/QualityChips'
import { EpisodeList } from '@/components/detail/EpisodeList'
import { TextSkeleton } from '@/components/Skeletons'
import { MediaInfoPanel } from '@/components/detail/MediaInfoPanel'
import { CastGrid } from '@/components/detail/CastGrid'
import { deriveQualityChips, episodeWatchState, episodeProgressPct, episodeVersions, secondaryResolutionLabels, formatReleaseDate } from '@/lib/detail'
import { isResumable, formatResumeTime, formatResumeAriaLabel, formatResumeLabel } from '@/lib/format'
import { getRecap, getRecapStatus, getUserRating, setUserRating, posterURL, backdropURL, type Episode as ApiEpisode, type MediaDetail, type MediaFile, type ContinueWatchingItem, type RecapResponse, type RecapStatusResponse, type AudioTrack, type SubtitleTrack } from '@/lib/api'
import { type Media } from '@/lib/types'

interface DetailViewProps {
  media: Media
  onBack: () => void
  onPlay: (m: Media) => void
  // Fired on hover/focus of the primary Play/Resume button — App resolves the
  // would-be file and pre-warms playback (pre-creates the transcode session /
  // warms the file cache) so the click→play latency is hidden. `resumeItem`
  // mirrors the primary button's resume-vs-fresh choice so the pre-warm seeks
  // to the same position. Best-effort; optional.
  onPlayIntent?: (m: Media, resumeItem?: ContinueWatchingItem) => void
  onToggleLib: (m: Media) => void
  inLibrary: boolean
  // Active profile — scopes the per-profile "Previously" recap boundary.
  profileId?: number | null
  // Fired after a star rating COMMITS server-side (not on the optimistic
  // update). App uses it to keep already-fetched personalized state honest —
  // e.g. dropping a freshly-panned title from the loaded hero pool so it
  // isn't still headlining Home during the server-side re-curation.
  onRated?: (mediaId: number, stars: number) => void
  // Phase 2 extras:
  detail?: MediaDetail
  apiEpisodes?: ApiEpisode[]
  // fileId (optional) — a version chip passes the specific file to play;
  // a plain row click omits it (default quality-preference pick).
  onPlayEpisode?: (ep: ApiEpisode, fileId?: number) => void
  // Phase 5.3 final QA — fires when the user clicks an episode that
  // has no associated file. App surfaces a toast so the click isn't
  // silent (previously the row was greyed out with no explanation).
  onEpisodeUnavailable?: (ep: ApiEpisode) => void
  loading?: boolean
  error?: string | null
  // Phase 4 — kick off a watch party with this media as the seed.
  // episodeId is the currently-relevant episode for TV shows (resume ep or
  // first available), so the party is created with a valid episode_id and
  // guests who join an already-playing party can auto-open the right episode.
  onStartParty?: (m: Media, episodeId?: number) => void
  inParty?: boolean
  // Phase 4.5 — multi-season picker.
  seasons?: { season_number: number; episode_count?: number }[]
  selectedSeason?: number | null
  onSelectSeason?: (n: number) => void
  // Phase 5 — add-to-watchlist. App owns the watchlists state +
  // dialog; DetailView just calls the callback with the media item.
  onAddToWatchlist?: (m: Media) => void
  // Phase 5.2 — admin-only refresh-metadata. Only rendered when
  // the caller is admin (App gates with user.role === 'admin').
  onRefreshMetadata?: (m: Media) => void
  // Admin-only manual identify. Opens ManualMatchModal so the admin
  // can pick a specific TMDB/TVDB id when the auto-matcher landed on
  // the wrong title. Distinct from Refresh (which re-runs the same
  // auto-match and may land on the same wrong answer).
  onIdentify?: (m: Media) => void
  // Admin-only "remove from library" — deletes this title's catalog entry
  // (and its episodes/files/history) from Aurora. Files on disk are untouched.
  // Clears a "no files available" ghost left after the title was deleted on
  // the server. Only passed for admins; the handler confirms first.
  onDeleteMedia?: (m: Media) => void
  // Phase 5.2 — version selector for movies with multiple files.
  // App passes the files list; DetailView surfaces them as chips.
  // Clicking a chip plays that specific file (4K version, alt cut, etc.).
  files?: MediaFile[]
  onPlayFile?: (m: Media, fileId: number) => void
  // 2026-05-27 — Continue Watching resume restore. When this media has
  // a partial-watch progress entry, App threads BOTH the matched record
  // AND its handler in via this single `resume` prop. The bundled shape
  // (vs the previous split `resumeItem?` + `onPlayContinue?` pair) makes
  // partial wiring a type error: you can't pass only the record without
  // a handler to call it back into App, and you can't pass a handler
  // with no record for it to act on. Undefined → Resume CTA hides and
  // the classic Play button takes its place (zero-behavior change for
  // fresh titles).
  resume?: {
    item: ContinueWatchingItem
    onPlay: (c: ContinueWatchingItem) => void
  }
}
export default function DetailView({
  media, onBack, onPlay, onPlayIntent, onToggleLib, inLibrary, profileId, onRated,
  detail, apiEpisodes, onPlayEpisode, onEpisodeUnavailable, loading, error,
  onStartParty, inParty,
  seasons, selectedSeason, onSelectSeason,
  onAddToWatchlist,
  onRefreshMetadata,
  onIdentify,
  onDeleteMedia,
  files, onPlayFile,
  resume,
}: DetailViewProps) {
  // Trailer modal (YouTube embed) — opened from the rail's "Watch Trailer".
  const [trailerOpen, setTrailerOpen] = useState(false)
  // "Previously" recap modal. DetailView owns the fetch so the modal stays
  // presentational; one fetch per open (the server caches across opens).
  const [recapOpen, setRecapOpen] = useState(false)
  const recapIdentity = `${media.id}:${profileId ?? 'default'}`
  const [recapState, setRecapState] = useState<{
    identity: string
    loading: boolean
    data?: RecapResponse
    error?: string
  }>({ identity: recapIdentity, loading: false })
  const [recapStatusState, setRecapStatusState] = useState<{
    identity: string
    status?: RecapStatusResponse
  }>()
  const recapStatus = recapStatusState?.identity === recapIdentity ? recapStatusState.status : undefined
  const recapFetchSequence = useRef(0)
  const recapStatusSequence = useRef(0)
  const recapIdentityRef = useRef(recapIdentity)
  useLayoutEffect(() => {
    recapIdentityRef.current = recapIdentity
  }, [recapIdentity])
  useEffect(() => {
    const controller = new AbortController()
    const sequence = ++recapStatusSequence.current
    getRecapStatus(media.id, profileId ?? undefined, controller.signal)
      .then(status => {
        if (!controller.signal.aborted && sequence === recapStatusSequence.current) {
          setRecapStatusState({ identity: recapIdentity, status })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && sequence === recapStatusSequence.current) {
          setRecapStatusState({ identity: recapIdentity })
        }
      })
    return () => controller.abort()
  }, [media.id, profileId, recapIdentity])
  const refreshRecap = useCallback(async () => {
    const identity = `${media.id}:${profileId ?? 'default'}`
    if (identity !== recapIdentityRef.current) return
    const sequence = ++recapFetchSequence.current
    setRecapState({ identity, loading: true })
    try {
      const data = await getRecap(media.id, profileId ?? undefined)
      if (identity !== recapIdentityRef.current || sequence !== recapFetchSequence.current) return
      setRecapState({ identity, loading: false, data })
      ++recapStatusSequence.current
      setRecapStatusState({
        identity,
        status: { available: data.available, reason: data.reason, has_ask_history: !!data.has_ask_history },
      })
    } catch (caught) {
      if (identity !== recapIdentityRef.current || sequence !== recapFetchSequence.current) return
      setRecapState({
        identity,
        loading: false,
        error: caught instanceof Error ? caught.message : 'Failed to load recap',
      })
    }
  }, [media.id, profileId])
  const handleAskHistoryChanged = useCallback((hasHistory: boolean) => {
    ++recapStatusSequence.current
    setRecapStatusState(previous => {
      const current = previous?.identity === recapIdentity ? previous.status : undefined
      return {
        identity: recapIdentity,
        status: current
          ? { ...current, has_ask_history: hasHistory }
          : { available: false, has_ask_history: hasHistory },
      }
    })
    setRecapState(previous => previous.identity === recapIdentity && previous.data
      ? { ...previous, data: { ...previous.data, has_ask_history: hasHistory } }
      : previous)
  }, [recapIdentity])
  const openRecap = useCallback(() => {
    setRecapOpen(true)
  }, [])
  useEffect(() => {
    if (recapOpen) void refreshRecap()
  }, [recapOpen, refreshRecap])
  // "My Rating" star widget. DetailView owns the fetch + submit (like the
  // recap) so App's involvement is one optional onRated callback. null = not
  // yet loaded — clicks no-op until the server value arrives so they can't
  // clobber an unseen rating (the card still renders, so the rail doesn't
  // layout-shift when the value lands). Optimistic submit with
  // revert-on-error; the server invalidates the profile's rec caches and the
  // hero/rails refetch on the next Home visit (homeReloadNonce), with onRated
  // scrubbing the already-loaded hero pool immediately.
  const [myRating, setMyRating] = useState<number | null>(null)
  // Monotonic submit sequence. Guards the async tails of BOTH the GET and the
  // POSTs: a stale POST's revert (or onRated) must not fire after a newer
  // click or an identity switch already superseded it — review found the
  // unguarded catch could rewind a rapid re-rate, or replay onto the next
  // profile's freshly-fetched value (the component survives profile switches;
  // it's keyed by media.id only).
  const rateSeqRef = useRef(0)
  useEffect(() => {
    const seq = ++rateSeqRef.current
    setMyRating(null)
    getUserRating(media.id, profileId ?? undefined)
      .then((stars) => { if (seq === rateSeqRef.current) setMyRating(stars) })
      // Load failure → show the widget unrated rather than never: rating is
      // still likely to work (POST is a separate call), and if it doesn't,
      // handleRate reverts.
      .catch(() => { if (seq === rateSeqRef.current) setMyRating(0) })
  }, [media.id, profileId])
  const handleRate = useCallback((stars: number) => {
    if (myRating === null) return // still loading the saved value
    const previous = myRating
    const seq = ++rateSeqRef.current
    setMyRating(stars)
    setUserRating(media.id, stars, profileId ?? undefined)
      .then(() => { if (seq === rateSeqRef.current) onRated?.(media.id, stars) })
      .catch(() => { if (seq === rateSeqRef.current) setMyRating(previous) })
  }, [media.id, profileId, myRating, onRated])
  // Prefer real metadata when available — overview, runtime, rating
  // straight from the server. Falls back to whatever the lightweight
  // Media object had so the page still shows something pre-fetch.
  const description = detail?.overview || media.description
  const rating = detail?.rating ?? media.rating
  const realPoster = detail ? posterURL(detail.poster_path) : media.poster
  const realBackdrop = detail ? backdropURL(detail.backdrop_path) : (media.backdrop || media.poster)
  // 2026-05-28 — Removed poster-derived accent tinting of the primary
  // CTA. Deriving the button color from the artwork made the action
  // bar a different color on every title (green on Drake & Josh, red
  // elsewhere) and clashed with Aurora's purple brand. The primary
  // now uses a fixed Aurora purple for a consistent, professional bar
  // on every page — see the action buttons below.
  const realGenre = (detail?.genres && detail.genres[0]) || media.genre
  // QA BUG-013 — TMDB's TV detail returns per-episode runtime, not
  // the series total. Append "/ep" for any episodic type (shows AND
  // anime — anime is the same data model with a different label) so
  // users don't read "0h 24m" as the total length of a multi-season
  // series.
  const realRuntime = detail?.runtime_minutes
    ? `${Math.floor(detail.runtime_minutes / 60)}h ${detail.runtime_minutes % 60}m${media.type !== 'movie' ? ' / ep' : ''}`
    : media.duration
  // Server returns one CastMember[] for cast AND crew, discriminated
  // by role_type. Split here so cast renders as avatars and crew
  // renders as compact text rows under the title.
  const castMembers = (detail?.cast || []).filter(c => c.role_type === 'cast')
  const directors = (detail?.cast || []).filter(c => c.role_type === 'director')
  const writers = (detail?.cast || []).filter(c => c.role_type === 'writer')
  const creators = (detail?.cast || []).filter(c => c.role_type === 'creator')
  // Audio/subtitle tracks. Lookup order:
  //   1. detail.files[0] — movies
  //   2. files[0] — when a separate /api/media/{id}/files call ran
  //   3. For shows, the first episode that has a file. Show-level
  //      files live in media_files which is always empty for shows
  //      (their files are in episode_files), so without (3) Media
  //      Info would never render for a TV show.
  let trackFile: { audio_tracks?: AudioTrack[]; subtitle_tracks?: SubtitleTrack[] } | undefined =
    detail?.files?.[0] || files?.[0]
  if (!trackFile && media.type === 'show' && apiEpisodes) {
    const epWithFile = apiEpisodes.find(e => e.files && e.files.length > 0)
    // EpisodeFile doesn't carry audio_tracks in our current TS shape
    // (we kept that interface sparse). Cast through unknown so we
    // can read the server fields when present. The cost of being
    // sparse on the type is this one boundary cast.
    const f = epWithFile?.files?.[0] as unknown as
      { audio_tracks?: AudioTrack[]; subtitle_tracks?: SubtitleTrack[] } | undefined
    if (f && (f.audio_tracks?.length || f.subtitle_tracks?.length)) {
      trackFile = f
    }
  }
  const audioTracks = trackFile?.audio_tracks || []
  const subtitleTracks = trackFile?.subtitle_tracks || []
  // Resolution pool for the descriptive strip's secondary-res chips
  // ("2160p" + "also 1080p"). Movies: the title's media_files. Shows: the
  // files of one episode (first with files) — a show's "other resolution"
  // is per-episode, same source the Episodes-tab version chips use. Both
  // MediaFile[] and EpisodeFile[] satisfy secondaryResolutionLabels'
  // {id,resolution?,version_tag?}.
  //
  // We pass the SAME pool's first (highest-res, since the server sorts
  // files highest-first) file as the primary so the excluded tier always
  // matches the leading res chip — deriving the primary from a different
  // file (e.g. trackFile, which is chosen for its audio/sub tracks) could
  // exclude the wrong tier and duplicate or drop a chip.
  const resolutionPool: { id: number; resolution?: string; version_tag?: string }[] =
    media.type === 'show'
      ? (apiEpisodes?.find(e => e.files && e.files.length > 0)?.files ?? [])
      // Match trackFile's `detail.files || files` precedence (non-empty
      // detail.files wins, else the separate /files fetch) so the pool and
      // the primary res chip always describe the same source.
      : ((detail?.files?.length ? detail.files : files) ?? [])
  const otherResolutions = secondaryResolutionLabels(resolutionPool, resolutionPool[0])
  // ───────────── view-models for the editorial layout ─────────────
  // 2026-05-31 — DetailView rebuilt into the "editorial split-view":
  // a tall hero banner, a sticky left rail (poster + actions + a credits
  // card), and a tabbed content column. The heavy derivation lives above;
  // here we shape it into plain props for the presentational components in
  // components/detail/*. See docs/proposals/details-page-redesign/.
  const isShow = media.type === 'show'
  const [activeTab, setActiveTab] = useState('overview')
  const [showAllCast, setShowAllCast] = useState(false)
  const heroMetaMiddle = isShow
    ? (detail?.season_count ? `${detail.season_count} Season${detail.season_count === 1 ? '' : 's'}` : undefined)
    : (realRuntime || undefined)

  // Quality chips (descriptive) from the resolved track file, plus any
  // other resolution tiers the title is available in (e.g. a 1080p chip
  // next to the 2160p one).
  const qualityChips = deriveQualityChips(trackFile, subtitleTracks.length, otherResolutions)

  // Rail Resume mapping — reuse the existing resume formatters.
  const resumeShown = !!resume && isResumable(resume.item)
  const ri = resume?.item
  const hasPreviously = !!recapStatus && (recapStatus.available || recapStatus.has_ask_history)
  const currentRecapState = recapState.identity === recapIdentity
    ? recapState
    : { identity: recapIdentity, loading: true }
  const railResumeFraction = resumeShown && ri && ri.duration_ms
    ? Math.min(1, ri.position_ms / ri.duration_ms)
    : undefined
  const railResumeLeft = resumeShown && ri
    ? (ri.type === 'show' && ri.season_number !== undefined
        ? `S${ri.season_number}·E${ri.episode_number} · ${formatResumeTime(ri.position_ms)}`
        : `Resume · ${formatResumeTime(ri.position_ms)}`)
    : undefined
  const railResumeRight = resumeShown && ri && ri.duration_ms ? formatResumeTime(ri.duration_ms) : undefined

  // Credits card — only rows we actually have data for (no fabrication).
  const railDetailRows: { label: string; value: string }[] = []
  if (directors.length) railDetailRows.push({ label: 'Director', value: directors.map(d => d.name).join(', ') })
  if (creators.length) railDetailRows.push({ label: 'Created by', value: creators.map(c => c.name).join(', ') })
  if (writers.length && !isShow) railDetailRows.push({ label: 'Writers', value: writers.map(w => w.name).join(', ') })
  if (!isShow && detail?.studio) railDetailRows.push({ label: 'Studio', value: detail.studio })
  if (isShow && detail?.network) railDetailRows.push({ label: 'Network', value: detail.network })
  const releasedValue = detail?.release_date ? formatReleaseDate(detail.release_date) : (media.year > 0 ? String(media.year) : '')
  if (releasedValue) railDetailRows.push({ label: isShow ? 'Premiered' : 'Released', value: releasedValue })
  if (isShow && detail?.season_count) railDetailRows.push({ label: 'Seasons', value: String(detail.season_count) })
  if (isShow && detail?.episode_count) railDetailRows.push({ label: 'Episodes', value: String(detail.episode_count) })
  if (realRuntime) railDetailRows.push({ label: isShow ? 'Episode' : 'Runtime', value: realRuntime })

  // Cast VMs (first 12; the rest behind "View all").
  const castVMs = (showAllCast ? castMembers : castMembers.slice(0, 12)).map(c => ({
    id: c.id,
    name: c.name,
    character: c.character,
    profileUrl: c.profile_path ? posterURL(c.profile_path, 'w185') : undefined,
  }))

  // Episode VMs — per-episode watch state from the (now-typed) progress.
  const episodeRows = (apiEpisodes || []).map(ep => {
    const p = ep.progress
    const state = episodeWatchState(p)
    const rt = ep.runtime_minutes
    const leftMs = p?.duration_ms ? p.duration_ms - (p.position_ms || 0) : 0
    return {
      id: ep.id,
      number: ep.episode_number,
      title: ep.title || `Episode ${ep.episode_number}`,
      overview: ep.overview,
      still: ep.still_url || realBackdrop,
      hasFile: !!(ep.files && ep.files.length > 0),
      state,
      progressPct: episodeProgressPct(p),
      leftLabel: state === 'in-progress' && p?.duration_ms
        ? `${formatResumeTime(leftMs)} left${rt ? ' of ' + rt + 'm' : ''}`
        : undefined,
      watchedLabel: state === 'watched' ? `Watched${rt ? ' · ' + rt + 'm' : ''}` : undefined,
      plainLabel: state === 'unwatched' && rt ? `${rt}m` : undefined,
      // Multi-version chips. The server returns all of an episode's
      // files 4K-first (queries_phase2 ORDER BY version_tag); before
      // this, the detail page silently played files[0] (the 4K) and
      // never surfaced that a 1080p also existed. We dedupe by visible
      // label so two same-resolution files (rare) don't draw two
      // identical chips, and only attach `versions` when 2+ distinct
      // labels remain — single-version episodes render no chips.
      versions: episodeVersions(ep.files),
    }
  })

  // Media Info VMs (preserve the channels>0 guard from the old code).
  const channelLayout = (ch?: number) =>
    ch === 8 ? '7.1' : ch === 7 ? '6.1' : ch === 6 ? '5.1' : ch === 3 ? '2.1' : ch === 2 ? '2.0' : ch === 1 ? 'Mono' : ''
  const audioVMs = audioTracks.map(t => ({
    language: (t.language || 'und').toUpperCase(),
    codec: t.codec.toUpperCase(),
    detail: [
      t.channels !== undefined && t.channels > 0
        ? [channelLayout(t.channels), `${t.channels}ch`].filter(Boolean).join(' · ')
        : '',
      t.title || '',
    ].filter(Boolean).join(' · ') || undefined,
    isDefault: t.is_default,
  }))
  const subtitleVMs = subtitleTracks.map(t => ({
    language: (t.language || 'und').toUpperCase(),
    forced: t.forced,
    default: t.default,
  }))
  const subtitleFormat = subtitleTracks[0]
    ? `${subtitleTracks[0].codec.toUpperCase()} / ${subtitleTracks[0].bitmap ? 'image-based' : 'text'}`
    : undefined

  // While the detail payload is in flight the storyline holds its shape with
  // text-line placeholders rather than the words "Loading details…" — the
  // hero, poster and tab strip are already real, so a sentence of status text
  // was the one element that then changed size when the copy arrived.
  const overviewLoading = loading && !detail
  const overviewText = description || 'No description available.'

  // Tabs: Overview always; Episodes (shows), Cast, Media only when present.
  // Default tab = Overview, which renders the full stacked column.
  const tabs: DetailTab[] = [{ id: 'overview', label: 'Overview' }]
  if (isShow) tabs.push({ id: 'episodes', label: 'Episodes' })
  if (castVMs.length) tabs.push({ id: 'cast', label: 'Cast & Crew' })
  if (audioVMs.length || subtitleVMs.length) tabs.push({ id: 'media', label: 'Media Info' })

  const storylineNode = (
    <section>
      <h3 className="text-lg font-semibold font-display mb-3">Storyline</h3>
      {overviewLoading
        ? <TextSkeleton lines={4} />
        : <p className="text-white/75 text-[15.5px] leading-[1.75] max-w-3xl">{overviewText}</p>}
    </section>
  )
  const episodesNode = isShow ? (
    <EpisodeList
      count={apiEpisodes?.length || 0}
      seasons={seasons}
      selectedSeason={selectedSeason}
      onSelectSeason={onSelectSeason}
      rows={episodeRows}
      onPlay={(id, fileId) => { const ep = apiEpisodes?.find(e => e.id === id); if (ep) onPlayEpisode?.(ep, fileId) }}
      onUnavailable={(id) => { const ep = apiEpisodes?.find(e => e.id === id); if (ep) onEpisodeUnavailable?.(ep) }}
      loading={loading}
      emptyText="No episodes available yet."
    />
  ) : null
  const castNode = <CastGrid cast={castVMs} totalCount={castMembers.length} onViewAll={() => setShowAllCast(true)} />
  const mediaNode = <MediaInfoPanel audio={audioVMs} subtitles={subtitleVMs} subtitleFormat={subtitleFormat} />

  return (
    // 2026-07-25 (Aurora Stage Phase 2) — the `-mx-8 -mt-8` bleed is gone.
    // App's content wrapper no longer applies a global `p-8`, and the
    // `detail` view opts out of the .stage-page gutter entirely, so there
    // is nothing left to escape. Keeping the negative margins would now
    // push the hero 32px past the viewport edge and cause a horizontal
    // scrollbar.
    <div className="animate-fade-in">
      <DetailHero
        backdrop={realBackdrop}
        title={media.title}
        kindLabel={isShow ? 'Series' : 'Movie'}
        contentRating={detail?.content_rating}
        rating={rating}
        year={media.year}
        metaMiddle={heroMetaMiddle}
        genre={realGenre}
        tagline={detail?.tagline}
        error={error}
        onBack={onBack}
        // The poster, as the hero's art whenever there is no backdrop or the
        // backdrop fails to load. Below lg DetailRail always drops its poster,
        // so the hero is then the page's only artwork and must not go blank.
        fallback={realPoster}
      />

      {/* `.stage-gutter` for the PADDING, `max-w-[1304px]` on the grid inside for
          the MEASURE. Phase 12 fix pass, and the split is the whole point.
          This was `px-[…] max-w-[1400px]` on one element, left-aligned. Once the
          other pages gained an ultra-wide cap that left detail hugging the left
          while they centred: measured 0px apart at 1920, 272px at 2560, 912px at
          3840 — a visible jump on an ordinary Home→title click.
          Centring the 1400 box was considered and is WORSE, not better: at 2560 a
          centred box puts detail's content at 628 against the page's 320, a 308px
          jump. The narrower measure and the shared left edge are independent
          things, and only separating them gets both.
          So the outer element takes the same padding as every other page (so the
          left edge always matches) and the inner grid caps the measure at 1304 =
          the content width `max-w-[1400px]` used to yield at md+ (1400 − 2×48).
          That also makes DetailHero's `lg:max-w-[1048px]` derivable rather than
          magic: 1304 − 216 (poster col) − 40 (gap) = 1048 exactly.
          Gutter reads the page token so detail lines up with every other
          page. It was px-8 (32px) to match the old global p-8; after the
          Phase 2 shell change every other page moved to 48px and detail
          alone stayed behind, shifting content 16px on navigation. */}
      {/* lg:-mt-[238px] pulls this column up so the poster rail overlaps the
          hero's lower third (the mockup's composition). Gated to lg — below
          it the grid is one column and the same negative margin would drag
          the poster onto the hero's title.

          Deliberately NOT `relative`: the overlap needs no positioning here
          (the rail's own lg:sticky + lg:z-20 lifts the poster), and making
          this div positioned put its main column's transparent 252px of
          padding over the hero's title block — killing text selection there.

          px-[18px] md:… matches home and browse, which drop to an 18px gutter
          on phones; detail was keeping 48px, a 30px jump on navigation. */}
      <div className="stage-gutter pt-9 pb-12 lg:-mt-[238px]">
        <div className="grid grid-cols-1 lg:grid-cols-[216px_minmax(0,1fr)] gap-10 max-w-[1304px]">
          <DetailRail
            poster={realPoster}
            title={media.title}
            resumeFraction={railResumeFraction}
            resumeLeftLabel={railResumeLeft}
            resumeRightLabel={railResumeRight}
            primaryLabel={resumeShown && ri ? formatResumeLabel(ri) : 'Play'}
            onPrimary={resumeShown && ri ? () => resume!.onPlay(ri) : () => onPlay(media)}
            onPrimaryIntent={onPlayIntent ? () => onPlayIntent(media, resumeShown && ri ? ri : undefined) : undefined}
            primaryAriaLabel={resumeShown && ri ? formatResumeAriaLabel(ri) : undefined}
            primaryTitle={resumeShown && ri ? `Resume from your last position (${formatResumeTime(ri.position_ms)})` : undefined}
            secondaryLabel={resumeShown ? 'Play from start' : undefined}
            onSecondary={resumeShown ? () => onPlay(media) : undefined}
            onWatchTrailer={detail?.trailer_key ? () => setTrailerOpen(true) : undefined}
            onPrevious={isShow && hasPreviously ? openRecap : undefined}
            inLibrary={inLibrary}
            onToggleLibrary={() => onToggleLib(media)}
            onAddToList={onAddToWatchlist ? () => onAddToWatchlist(media) : undefined}
            onParty={onStartParty ? () => {
              // For shows, pass the resume episode (ri) if available, else the
              // first episode that has files. Without this the party is created
              // with episode_id=null and guests who join an already-playing
              // party can't auto-open the correct episode (they hit an empty
              // /api/media/{id}/files response and bail silently).
              const episodeId = media.type === 'show'
                ? (ri?.type === 'show' && ri.episode_id
                    ? ri.episode_id
                    : apiEpisodes?.find(e => e.files && e.files.length > 0)?.id)
                : undefined
              onStartParty(media, episodeId)
            } : undefined}
            inParty={inParty}
            userRating={myRating ?? 0}
            onRate={handleRate}
            detailRows={railDetailRows}
            onRefresh={onRefreshMetadata ? () => onRefreshMetadata(media) : undefined}
            onIdentify={onIdentify ? () => onIdentify(media) : undefined}
            onDelete={onDeleteMedia ? () => onDeleteMedia(media) : undefined}
          />
          {trailerOpen && detail?.trailer_key && (
            <TrailerModal
              youtubeKey={detail.trailer_key}
              title={media.title}
              onClose={() => setTrailerOpen(false)}
            />
          )}
          {recapOpen && (
            <RecapModal
              mediaId={media.id}
              profileId={profileId ?? undefined}
              title={media.title}
              loading={currentRecapState.loading}
              error={currentRecapState.error}
              recap={currentRecapState.data?.available ? currentRecapState.data.recap : undefined}
              suggestedQuestions={currentRecapState.data?.available ? currentRecapState.data.suggested_questions : undefined}
              upTo={currentRecapState.data?.up_to}
              unavailableReason={currentRecapState.data && !currentRecapState.data.available ? currentRecapState.data.reason : undefined}
              hasAskHistory={currentRecapState.data?.has_ask_history ?? recapStatus?.has_ask_history}
              onClose={() => setRecapOpen(false)}
              onStart={resumeShown && ri ? () => { setRecapOpen(false); resume!.onPlay(ri) } : undefined}
              resumeLabel={ri?.season_number && ri.episode_number ? `Resume S${ri.season_number} · E${ri.episode_number}` : undefined}
              onRefreshRecap={refreshRecap}
              onHistoryChanged={handleAskHistoryChanged}
            />
          )}

          {/* stage-detail-main adds the compensating padding-top from lg, so
              the tabs start below the hero even though the shared parent was
              pulled up. */}
          <div className="min-w-0 pt-1 lg:pt-[252px]">
            <DetailTabs tabs={tabs} active={activeTab} onChange={setActiveTab} className="mb-6" />

            {/* Multi-file version chooser (actionable — plays a specific
                file). Distinct from the descriptive QualityChips below.
                Movies with 2+ files only. */}
            {media.type !== 'show' && files && files.length > 1 && onPlayFile && (
              <div className="mb-6 flex items-center gap-2 flex-wrap">
                <span className="text-white/40 text-xs uppercase tracking-wider mr-1">Play in</span>
                {files.map(f => {
                  const tag = f.version_tag || f.resolution || 'Unknown'
                  const is4K = /4k|2160|uhd/i.test(`${f.version_tag || ''} ${f.resolution || ''}`)
                  const sizeGB = f.size_bytes ? (f.size_bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB' : ''
                  const codec = [f.video_codec, f.audio_codec].filter(Boolean).join('/')
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => onPlayFile(media, f.id)}
                      title={[codec, sizeGB, f.library_name].filter(Boolean).join(' · ')}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border whitespace-nowrap ${
                        is4K
                          ? 'bg-purple-600/25 border-purple-500/50 text-purple-100 hover:bg-purple-600/40 hover:border-purple-400'
                          : 'bg-white/[0.06] border-white/[0.1] text-white/85 hover:bg-white/[0.1] hover:text-white'
                      }`}
                    >
                      {tag}
                      {f.library_name && <span className="text-white/40 ml-1 font-normal">[{f.library_name}]</span>}
                    </button>
                  )
                })}
              </div>
            )}

            <QualityChips chips={qualityChips} className="mb-7" />

            {/* A CONSTANT id, not `detail-panel-${activeTab}`. Only one panel is
                ever rendered, so an id that changed identity on every tab switch
                bought nothing and forced the tabs to either dangle their
                `aria-controls` or drop it. See the note in DetailTabs. */}
            <div role="tabpanel" id="detail-panel" aria-labelledby={`detail-tab-${activeTab}`}>
              {activeTab === 'overview' ? (
                <div className="space-y-10">
                  {storylineNode}
                  {episodesNode}
                  {castNode}
                  {mediaNode}
                </div>
              ) : activeTab === 'episodes' ? (
                episodesNode
              ) : activeTab === 'cast' ? (
                castNode
              ) : activeTab === 'media' ? (
                mediaNode
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
