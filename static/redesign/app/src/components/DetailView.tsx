// DetailView: a title's page. One column: the hero (artwork, title, the
// action row), the synopsis, episodes for a show, the cast, the details, and
// last, closed, the technical media info and the admin tools.
//
// Lazy-loaded, so it stays out of the main chunk. App owns the data and the
// handlers and passes them as props; the `resume` object and the
// `onEpisodeUnavailable` closure are built in App's render (they close over
// App state). DetailView fetches its own "Previously on" recap and the
// profile's star rating, so their modals and controls stay presentational.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { DetailHero } from '@/components/detail/DetailHero'
import { DetailActions } from '@/components/detail/DetailActions'
import { TrailerModal } from '@/components/detail/TrailerModal'
import { RecapModal } from '@/components/detail/RecapModal'
import { QualityChips } from '@/components/detail/QualityChips'
import { EpisodeList } from '@/components/detail/EpisodeList'
import { TextSkeleton } from '@/components/Skeletons'
import { MediaInfoPanel, mediaInfoSummary } from '@/components/detail/MediaInfoPanel'
import { CastRail } from '@/components/detail/CastRail'
import { Disclosure } from '@/components/detail/Disclosure'
import { deriveQualityChips, episodeWatchState, episodeProgressPct, episodeVersions, secondaryResolutionLabels, formatReleaseDate } from '@/lib/detail'
import { isResumable, formatResumeTime, formatResumeAriaLabel, formatResumeLabel } from '@/lib/format'
import { getRecap, getRecapStatus, getUserRating, setUserRating, posterURL, backdropURL, type Episode as ApiEpisode, type MediaDetail, type MediaFile, type ContinueWatchingItem, type RecapResponse, type RecapStatusResponse, type AudioTrack, type SubtitleTrack } from '@/lib/api'
import { partyEpisodeId } from '@/lib/partyEpisode'
import { type Media } from '@/lib/types'
import { failureWords } from '@/lib/failureWords'

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
  // False until the session's profile is known (App's personalProfileReady).
  // The recap and star rating wait for it: without a profile_id the server
  // answers for its own choice of profile, which on a cold deep link showed,
  // and could take a rating for, a profile the app had not confirmed.
  profileReady?: boolean
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
  // the caller is admin (App gates with adminUI).
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
  media, onBack, onPlay, onPlayIntent, onToggleLib, inLibrary, profileId, profileReady = true, onRated,
  detail: detailFromApp, apiEpisodes: episodesFromApp, onPlayEpisode, onEpisodeUnavailable, loading, error,
  onStartParty, inParty,
  seasons, selectedSeason, onSelectSeason,
  onAddToWatchlist,
  onRefreshMetadata,
  onIdentify,
  onDeleteMedia,
  files: filesFromApp, onPlayFile,
  resume,
}: DetailViewProps) {
  // Detail data is this title's or it is not used. Going from one title
  // straight to another (a search from the top bar, a cast link) leaves the host
  // holding the previous title's payload until the new one arrives, and the
  // page drew the old backdrop, synopsis and cast under the new name.
  const detail = detailFromApp && detailFromApp.id === media.id ? detailFromApp : undefined
  // The same for the season's episodes and a film's files, which the host
  // clears only when the title page is left: the previous show's rows were
  // drawn under the new name, and pressing one played the old show's
  // episode; a film's "Play in" chips played the old film's file.
  // Episodes carry their show's id. A file can be another item's on purpose
  // (the same title in a second library is offered as a version), so a list
  // of files is this title's when at least one of them is its own.
  const apiEpisodes = episodesFromApp?.every(e => e.media_item_id === media.id) ? episodesFromApp : undefined
  const files = filesFromApp?.some(f => f.media_item_id === media.id) ? filesFromApp : undefined
  // Trailer modal (YouTube embed), opened from the action row.
  const [trailerOpen, setTrailerOpen] = useState(false)
  // The artwork's ambient colour, with the title AND the picture it came
  // from. A colour is shown only while both still hold: the sample is taken
  // after the picture has loaded, and by then the page may be showing another
  // title, or this title with its real backdrop in place of the card's
  // poster.
  const [ambientState, setAmbient] = useState<{ id: number; src: string; color: string | null } | null>(null)
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
    if (!profileReady) return
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
  }, [media.id, profileId, profileReady, recapIdentity])
  const refreshRecap = useCallback(async () => {
    if (!profileReady) return
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
        error: failureWords(caught, 'load the recap') ?? 'Could not load the recap.',
      })
    }
  }, [media.id, profileId, profileReady])
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
  // clobber an unseen rating (the stars still render, so the action row does
  // not shift when the value lands). Optimistic submit with
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
    // Not yet loaded is null, which also keeps clicks from rating.
    if (!profileReady) return
    getUserRating(media.id, profileId ?? undefined)
      .then((stars) => { if (seq === rateSeqRef.current) setMyRating(stars) })
      // Load failure → show the widget unrated rather than never: rating is
      // still likely to work (POST is a separate call), and if it doesn't,
      // handleRate reverts.
      .catch(() => { if (seq === rateSeqRef.current) setMyRating(0) })
  }, [media.id, profileId, profileReady])
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
  // The wash is this title's, from a picture the hero is still showing.
  const ambient = ambientState && ambientState.id === media.id
    && (ambientState.src === realBackdrop || ambientState.src === realPoster)
    ? ambientState : null
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
  // ───────────── view-models ─────────────
  // The heavy derivation lives above; here it is shaped into plain props for
  // the presentational components in components/detail/*.
  const isShow = media.type === 'show'
  const heroMetaMiddle = isShow
    ? (detail?.season_count ? `${detail.season_count} season${detail.season_count === 1 ? '' : 's'}` : undefined)
    : (realRuntime || undefined)

  // Quality chips (descriptive) from the resolved track file, plus any
  // other resolution tiers the title is available in (e.g. a 1080p chip
  // next to the 2160p one).
  const qualityChips = deriveQualityChips(trackFile, subtitleTracks.length, otherResolutions)

  // Resume mapping, on the existing resume formatters.
  const resumeShown = !!resume && isResumable(resume.item)
  const ri = resume?.item
  const hasPreviously = !!recapStatus && (recapStatus.available || recapStatus.has_ask_history)
  const currentRecapState = recapState.identity === recapIdentity
    ? recapState
    : { identity: recapIdentity, loading: true }
  const resumeFraction = resumeShown && ri && ri.duration_ms
    ? Math.min(1, ri.position_ms / ri.duration_ms)
    : undefined
  const resumeLeftLabel = resumeShown && ri && ri.duration_ms
    ? minutesLeft(ri.duration_ms - ri.position_ms)
    : undefined

  // Details: only rows there is data for (nothing is made up).
  const detailRows: { label: string; value: string }[] = []
  if (directors.length) detailRows.push({ label: 'Director', value: directors.map(d => d.name).join(', ') })
  if (creators.length) detailRows.push({ label: 'Created by', value: creators.map(c => c.name).join(', ') })
  if (writers.length && !isShow) detailRows.push({ label: 'Writers', value: writers.map(w => w.name).join(', ') })
  if (!isShow && detail?.studio) detailRows.push({ label: 'Studio', value: detail.studio })
  if (isShow && detail?.network) detailRows.push({ label: 'Network', value: detail.network })
  const releasedValue = detail?.release_date ? formatReleaseDate(detail.release_date) : (media.year > 0 ? String(media.year) : '')
  if (releasedValue) detailRows.push({ label: isShow ? 'Premiered' : 'Released', value: releasedValue })
  if (isShow && detail?.season_count) detailRows.push({ label: 'Seasons', value: String(detail.season_count) })
  if (isShow && detail?.episode_count) detailRows.push({ label: 'Episodes', value: String(detail.episode_count) })
  if (realRuntime) detailRows.push({ label: isShow ? 'Episode length' : 'Runtime', value: realRuntime })
  if (detail?.genres?.length) detailRows.push({ label: detail.genres.length === 1 ? 'Genre' : 'Genres', value: detail.genres.join(', ') })

  // The whole cast: the rail scrolls sideways, so there is nothing to hide
  // behind a "view all".
  const castVMs = castMembers.map(c => ({
    id: c.id,
    name: c.name,
    character: c.character,
    profileUrl: c.profile_path ? posterURL(c.profile_path, 'w185') : undefined,
  }))

  // Episode VMs, with per-episode watch state from the progress.
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
      leftLabel: state === 'in-progress' && p?.duration_ms ? minutesLeft(leftMs) : undefined,
      plainLabel: rt ? `${rt} min` : undefined,
      // Multi-version chips. The server returns all of an episode's files
      // 4K-first; without these the page silently played files[0] and never
      // showed that a 1080p also existed. Deduped by visible label, and
      // attached only when 2+ distinct labels remain.
      versions: episodeVersions(ep.files),
    }
  })

  // Media info VMs (the channels > 0 guard is deliberate: 0 means unknown).
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
  // A film's files on disk. (A show's are per episode and sit on its rows.)
  const versionVMs = media.type !== 'show'
    ? ((detail?.files?.length ? detail.files : files) ?? []).map(f => ({
        id: f.id,
        name: f.version_tag || f.resolution || 'Unknown',
        detail: [
          [f.video_codec, f.audio_codec].filter(Boolean).join('/'),
          f.size_bytes ? (f.size_bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '',
        ].filter(Boolean).join(' · ') || undefined,
        note: f.library_name,
      }))
    : []
  const hasMediaInfo = versionVMs.length > 0 || audioVMs.length > 0 || subtitleVMs.length > 0
  const canManage = !!(onRefreshMetadata || onIdentify || onDeleteMedia)

  // While the payload is in flight the synopsis holds its shape with
  // text-line placeholders rather than the words "Loading details…": the
  // hero is already real, so a sentence of status text was the one element
  // that then changed size when the copy arrived.
  const overviewLoading = loading && !detail
  const overviewText = description || 'No description available.'

  return (
    // `--ambient` is this title's artwork colour (lib/ambient), set here so
    // the wash under the hero and anything else on the page that reads it
    // share one value. Transparent until the artwork has loaded, and again when the
    // title changes.
    <div
      className="stage-detail relative animate-fade-in"
      style={{ '--ambient': ambient?.color ?? 'transparent' } as CSSProperties}
    >
      <DetailHero
        backdrop={realBackdrop}
        title={media.title}
        facts={[media.year > 0 ? String(media.year) : undefined, detail?.content_rating, heroMetaMiddle, realGenre]}
        rating={rating}
        tagline={detail?.tagline}
        error={error}
        onBack={onBack}
        // The poster, as the hero's art whenever there is no backdrop or the
        // backdrop fails to load. Below lg the poster beside the title is
        // dropped, so the hero's backdrop is then the page's only artwork and
        // must not go blank. The SAME w500 URL the card and the hero's poster
        // use, deliberately: a larger size differs from the card poster the
        // hero already shows pre-payload, so a backdrop-less title's hero
        // remounted and blinked when the payload landed, and fetched the art
        // again.
        fallback={realPoster}
        poster={realPoster}
        // The hero reports from a ref callback, which React re-runs on every
        // render: the state must not change (and so re-render) for a colour it
        // already holds, or a cached image loops the page to death.
        onAmbient={(color, src) => setAmbient(prev => (
          prev && prev.id === media.id && prev.src === src && prev.color === color ? prev : { id: media.id, src, color }
        ))}
      >
        <DetailActions
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
            // For a show, pass the resume episode if there is one, else the
            // first episode that has files. Without it the party is created
            // with no episode, and guests who join one already playing
            // cannot open the right episode. The choice is shared with the
            // card menu's "Watch together" (lib/partyEpisode), so the two
            // cannot drift apart.
            onStartParty(media, partyEpisodeId(media, ri, apiEpisodes))
          } : undefined}
          inParty={inParty}
          userRating={myRating ?? 0}
          onRate={handleRate}
          resumeFraction={resumeFraction}
          resumeLeftLabel={resumeLeftLabel}
        />
      </DetailHero>

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

      {/* The body: one column on the page's own left edge. `.stage-gutter`
          takes the PADDING every page shares, so this page starts where the
          others do at every width; the element inside caps the MEASURE.
          Kept as two elements because the two are independent: on an
          ultra-wide window a single padded-and-capped box either hugs the
          left while the other pages centre or centres and jumps sideways on
          an ordinary poster click. scripts/verify-page-alignment.mjs holds
          this column and the hero's row to one left edge and one width. */}
      <div className="relative stage-gutter pt-8 pb-16">
        {/* The artwork's colour, under the hero. Before the column in the
            DOM and the column positioned, so the column paints over it. */}
        <div className="stage-detail-wash" aria-hidden="true" />
        <div className="stage-detail-col relative flex flex-col gap-12 max-w-[1304px]">
          <section aria-label="Synopsis" className="max-w-[820px] flex flex-col gap-5">
            {/* The synopsis comes first under the hero, at every width; what
                the files are and which one to play follow it. */}
            {overviewLoading
              ? <TextSkeleton lines={4} />
              : <p className="text-ink text-[15px] sm:text-[17px] leading-[1.55] [text-wrap:pretty]">{overviewText}</p>}
            <QualityChips chips={qualityChips} />
            {/* A film with more than one file: each chip plays that file
                (the 4K, the other cut). Distinct from the descriptive chips
                above. */}
            {media.type !== 'show' && files && files.length > 1 && onPlayFile && (
              <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Play a specific version">
                <span className="text-ink-2 text-[13px] mr-1">Play in</span>
                {files.map(f => {
                  const tag = f.version_tag || f.resolution || 'Unknown'
                  const sizeGB = f.size_bytes ? (f.size_bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB' : ''
                  const codec = [f.video_codec, f.audio_codec].filter(Boolean).join('/')
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => onPlayFile(media, f.id)}
                      title={[codec, sizeGB, f.library_name].filter(Boolean).join(' · ')}
                      className="stage-hit44 h-9 px-3.5 rounded-full bg-surface-raised-2 text-ink text-[13px] font-semibold hover:bg-white/[0.16] transition-colors whitespace-nowrap"
                    >
                      {tag}
                      {f.library_name && <span className="text-ink-2 ml-1.5 font-normal">{f.library_name}</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          {isShow && (
            <EpisodeList
              count={apiEpisodes?.length || 0}
              seasons={seasons}
              selectedSeason={selectedSeason}
              onSelectSeason={onSelectSeason}
              rows={episodeRows}
              continueEpisodeId={resumeShown && ri?.type === 'show' ? ri.episode_id : undefined}
              onPlay={(id, fileId) => { const ep = apiEpisodes?.find(e => e.id === id); if (ep) onPlayEpisode?.(ep, fileId) }}
              onUnavailable={(id) => { const ep = apiEpisodes?.find(e => e.id === id); if (ep) onEpisodeUnavailable?.(ep) }}
              loading={loading}
              emptyText="No episodes available yet."
            />
          )}

          <CastRail cast={castVMs} />

          {detailRows.length > 0 && (
            <section aria-labelledby="detail-details-heading">
              <h2 id="detail-details-heading" className="font-display text-[22px] leading-tight font-semibold tracking-[-0.01em]">Details</h2>
              <dl className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-x-8 gap-y-5">
                {detailRows.map(r => (
                  <div key={r.label} className="flex flex-col gap-0.5 pt-3 border-t border-line">
                    <dt className="text-[12px] text-ink-3">{r.label}</dt>
                    <dd className="text-[15px] text-ink">{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {(hasMediaInfo || canManage) && (
            <section aria-label="Media info and management" className="flex flex-col gap-4">
              {hasMediaInfo && (
                <Disclosure title="Media info" summary={mediaInfoSummary(versionVMs.length, audioVMs.length, subtitleVMs.length)}>
                  <MediaInfoPanel versions={versionVMs} audio={audioVMs} subtitles={subtitleVMs} subtitleFormat={subtitleFormat} />
                </Disclosure>
              )}
              {/* Admin tools, last and closed. The handlers are only passed
                  when admin UI may show (App decides), so this renders for
                  nobody else. */}
              {canManage && (
                <Disclosure title="Manage" summary="Admins only">
                  <div className="flex flex-wrap items-center gap-3">
                    {onRefreshMetadata && (
                      <button
                        type="button"
                        onClick={() => onRefreshMetadata(media)}
                        title="Fetch this title's metadata again from TMDB/TVDB"
                        className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost"
                      >
                        Refresh metadata
                      </button>
                    )}
                    {onIdentify && (
                      <button
                        type="button"
                        onClick={() => onIdentify(media)}
                        title="Search TMDB/TVDB and pick the correct match by hand"
                        className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost"
                      >
                        Fix match
                      </button>
                    )}
                    {onDeleteMedia && (
                      <button
                        type="button"
                        onClick={() => onDeleteMedia(media)}
                        title="Remove this title's entry from the library. Files on disk are kept."
                        className="stage-btn stage-btn-sm stage-hit44 stage-btn-danger sm:ml-auto"
                      >
                        Remove from library
                      </button>
                    )}
                  </div>
                </Disclosure>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

// "37 min left"; under a minute still reads as a minute.
function minutesLeft(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60000))} min left`
}
