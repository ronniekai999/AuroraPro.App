import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, lazy } from 'react'
import { useNavigate, useLocation, useNavigationType } from 'react-router'
import { consumeDeviceIntent, consumeDevicePairing, forgetDeviceIntent } from '@/lib/devicePairing'
import { undoMayRestore } from '@/lib/libraryUndo'
import { ESCAPE_LAYERS_ATTR } from '@/lib/escapeLayers'
import {
  fetchMe,
  getStoredUser,
  SESSION_EXPIRED_EVENT,
  getMedia,
  getMediaFiles,
  getSeasons,
  getEpisodes,
  getLibrary,
  addToLibrary,
  removeFromLibrary,
  libraryItemToMedia,
  type LibraryItem,
  listMedia,
  mapMedia,
  listRecent,
  listMediaWithTotal,
  listGenres,
  getHeroPool,
  getDiscoverRails,
  getAnchorRails,
  getEngagementRails,
  getFollowingRecent,
  type DiscoverRailUI,
  type AnchorRailUI,
  type EngagementRailUI,
  type FollowedWatch,
  type ActiveParty,
  listContinueWatching,
  listRequests,
  getBugReportConfig,
  type BugReportConfig,
  mapContinueToMedia,
  createQuickParty,
  sendPartyInvites,
  rsvpPartyInvite,
  schedulePartyStart,
  type MyPartyInvite,
  logout as apiLogout,
  posterURL,
  backdropURL,
  getAdminDashboard,
  listAdminActivity,
  listProfiles,
  activateProfile,
  getActiveProfile,
  listWatchlists,
  addToWatchlist,
  submitMediaFeedback,
  refreshMetadata,
  deleteMedia,
  markWatched,
  clearProgress,
  type ActivityEntry,
  type ContinueWatchingItem,
  type HeroPick,
  type HeroPersonalization,
  type MediaDetail,
  type MediaFile,
  type MediaRequest,
  type Profile,
  type ServerMediaItem,
  type ServerStats,
  type Watchlist,
  type Episode as ApiEpisode,
  type User as ApiUser,
  listNotifications,
  markAllNotificationsRead,
  type AppNotification,
} from '@/lib/api'
import { VideoPlayer, pickFile, type PlayTarget } from '@/components/VideoPlayer'
import { PartyPanel } from '@/components/PartyPanel'
import { PartyInvite } from '@/components/PartyInvite'
import { PartyComposerModal, type PartyComposerLaunch } from '@/components/PartyComposerModal'
import { formatPartyTime, plannedStartLabel, skipReasonCopy, inviteCodeFromLink } from '@/lib/partyInvites'
import { firstEpisodeToPlay, regularSeasonsFirst, resolvePartyEpisodeId, startsLaterNotice } from '@/lib/partyEpisode'
import { buildSlate, resumeLead, shownSlateIndex, whereYouAre, type SlateEntry } from '@/lib/tonightSlate'
import { TonightLive } from '@/components/TonightLive'
import {
  isPlaybackResolutionCurrent,
  partyPlayerDismissalKeyOnClose,
  shouldAutoOpenPartyPlayer,
  shouldClosePlayerOnPathChange,
} from '@/lib/partyPlayer'
import { HeroSection } from '@/components/HeroSection'
import { MediaRail } from '@/components/MediaRail'
import { BugReportHost } from '@/components/BugReportHost'
import { useBugReportEntry } from '@/hooks/useBugReportEntry'
import { focusPageStart } from '@/lib/returnFocus'
import { ReactionOverlay } from '@/components/ReactionOverlay'
import { anchorFor, ContextMenu, type MediaContextItem } from '@/components/ContextMenu'
import { ScanProgressBar } from '@/components/ScanProgressBar'
import { searchField } from '@/lib/searchKeys'
import AuthView from '@/components/AuthView'
import { hasInAppEntryBehind } from '@/lib/historyBack'
import { dropWaitingOpen, travelToTitle, watchCardPresses } from '@/lib/posterTravel'
// Phase 6 — Collections, Calendar, Gamification UI components.
import { CollectionsModal } from '@/components/CollectionsModal'
import { TasteOnboardingGate } from '@/components/TasteOnboarding'
import { ProfilesGate } from '@/components/ProfilesGate'
import { ProfilePinDialog } from '@/components/ProfilePinDialog'
import { isRestrictedProfile, isSoleUnrestrictedProfile, loadStartupProfiles, readRememberedProfileId, rememberProfileId, showsAdminUI, useSessionProfileOnVisible } from '@/lib/profileSession'
import { useProfileSwitch } from '@/lib/useProfileSwitch'
import { useOnProfileChange } from '@/lib/useOnProfileChange'
import { useProfileSwitchPending } from '@/lib/useProfileSwitchPending'
import { BottomTabBar, TopNav, type NavPresence } from '@/components/TopNav'
import { forgetDescribedAnswer } from '@/lib/describedSearch'
import { forgetAccountRecentSearches, forgetRecentSearches, readRecentSearches, rememberSearch } from '@/lib/recentSearches'
import { LibraryHeader, LibraryToolsProvider } from '@/components/LibraryHeader'
import { BrowseTools, GenreChips, LetterStrip } from '@/components/BrowseControls'
import { DEFAULT_BROWSE_SORT, fallbackGenres, readBrowseLayout, useGridLayout, writeBrowseLayout, type BrowseLayout } from '@/lib/browseLayout'
import { LIBRARY_DESTINATION, hiddenFromRestricted, isLibraryView, libraryScopesFor, mayRenderHidden, navScopeFor } from '@/lib/navScope'
import { settingsPaneFromPath, settingsPath, type SettingsPane } from '@/lib/settingsPanes'
import { partyPresence, useActiveParties } from '@/hooks/useActiveParties'
import { usePartyInvites } from '@/hooks/usePartyInvites'
// Phase 6 — Dynamic theming: extract a dominant color from a poster
// to tint the detail view's accent buttons.
import { usePanelDismiss } from '@/hooks/usePanelDismiss'
import { useParty } from '@/hooks/useParty'
import { useRealtime } from '@/hooks/useRealtime'
import { useCatalogVersion } from '@/hooks/useCatalogVersion'
import { useLetterJump } from '@/hooks/useLetterJump'
import { fitsInPages } from '@/lib/letterJump'
import { abortAfter, CATALOG_REFRESH_MAX_PAGES, loadedPageCount, refetchLoadedPages, withoutRemoved } from '@/lib/catalogUpdates'
import { useNotificationSeed } from '@/hooks/useNotificationSeed'
// 2026-06-17 (app split) — leaves extracted to shared modules so the
// lazy view chunks (AdminView etc.) can import them without reaching
// back into App. Icon is a pure SVG leaf; formatRequestDate is a pure
// date formatter (no @/lib/api dep → no cycle).
import { Icon } from '@/components/Icon'
import { ToastContainer, type Toast } from '@/components/Toast'
import { announceStaleBundle, isStaleBundleError } from '@/lib/buildUpdate'
import { oauthProviderLabel } from '@/lib/oauth'
import { type Media } from '@/lib/types'
import { isResumable } from '@/lib/format'
import { currentPreferredQuality, readPrefsSnapshot, writePrefKey } from '@/lib/appearance'
import { lockBodyScroll } from '@/lib/scrollLock'
import { prewarm, cancelPrewarm, prewarmEnabled } from '@/lib/prewarm'
import { shouldRefreshHome, shouldResetPersonalizedRails } from '@/lib/homeRefresh'
import { pushSupported, bootResyncPush, unsubscribePushOnLogout } from '@/lib/push'
import { syncAppBadge } from '@/lib/pwa'
import { ViewSuspense, ViewFallback } from '@/components/ViewSuspense'
import { DetailSkeleton, GridSkeleton, RailSkeleton } from '@/components/Skeletons'
import { useExitTransition } from '@/hooks/useExitTransition'
import ManualMatchModal from '@/components/admin/ManualMatchModal'

// Chunk loaders, named so the nav can PREFETCH a view's code on hover /
// focus of its tab (prefetchView, below) ahead of the click that needs it.
// `lazy()` wraps the same thunk, and a dynamic import() resolves once per
// module, so a prefetched chunk is simply already there when the view
// mounts — the Suspense fallback never paints for it. This is the honest
// version of what `startTransition` cannot do here: each view mounts its
// own <ViewSuspense>, and React shows a NEWLY mounted boundary's fallback
// immediately, transition or not.
// The title page's module, once its chunk has arrived (see DetailView, below).
let detailModule: typeof import('@/components/DetailView') | null = null
const VIEW_LOADERS = {
  admin: () => import('@/components/admin/AdminView'),
  collections: () => import('@/components/CollectionsView'),
  calendar: () => import('@/components/CalendarView'),
  settings: () => import('@/components/SettingsView'),
  requests: () => import('@/components/RequestsView'),
  browse: () => import('@/components/BrowseView'),
  detail: () => import('@/components/DetailView').then(m => { detailModule = m; return m }),
  library: () => import('@/components/LibraryView'),
  search: () => import('@/components/SearchView'),
  member: () => import('@/components/UserProfileView'),
  members: () => import('@/components/MembersView'),
  device: () => import('@/components/DeviceApprovalView'),
  together: () => import('@/components/TogetherView'),
  profile: () => import('@/components/MyProfileView'),
  me: () => import('@/components/MeView'),
} as const
// Destination or view id → chunk. Home is eager (no entry); movies and shows
// share the browse chunk; member is never reached from the nav. The
// Library destination ('catalog') warms the browse chunk, where it lands by
// default; 'library' is the My Library scope's own view. 'detail' is not a
// nav destination either: it is warmed when the pointer or the focus first
// reaches a card (App, below), since a card is what opens it.
const PREFETCH_BY_VIEW: Record<string, keyof typeof VIEW_LOADERS> = {
  admin: 'admin', collections: 'collections', calendar: 'calendar',
  settings: 'settings', requests: 'requests', movies: 'browse', shows: 'browse',
  [LIBRARY_DESTINATION]: 'browse',
  library: 'library', search: 'search', members: 'members',
  together: 'together', profile: 'profile', me: 'me', detail: 'detail',
}
const prefetched = new Set<keyof typeof VIEW_LOADERS>()
function prefetchView(view: string): void {
  const key = PREFETCH_BY_VIEW[view]
  if (!key || prefetched.has(key)) return
  prefetched.add(key)
  // A failed prefetch (offline, stale deploy) is not an error to surface:
  // the real navigation retries the import and ErrorBoundary owns THAT
  // failure. Forget the attempt so a later hover can try again. A stale
  // deploy does get the update notice checked now, before the click fails.
  void VIEW_LOADERS[key]().catch((error: unknown) => {
    prefetched.delete(key)
    if (isStaleBundleError(error)) announceStaleBundle()
  })
}

// 2026-06-17 (app split) — Admin is the first lazy-loaded view chunk.
// Non-admins never fetch the ~2,330-line admin bundle; it loads on
// first /admin nav by an admin, with <ViewFallback> as the Suspense
// placeholder. ErrorBoundary in main.tsx catches chunk-load failures
// (offline / stale deploy); ViewSuspense complements it.
const AdminView = lazy(VIEW_LOADERS.admin)
// 2.1 — Collections & Calendar are already standalone modules; the
// only change is swapping their static import for a lazy import and
// wrapping the render site in <ViewSuspense>. First slice to exercise
// the lazy + ViewSuspense wiring end-to-end.
const CollectionsView = lazy(VIEW_LOADERS.collections)
const CalendarView = lazy(VIEW_LOADERS.calendar)
// 2.2 — Settings (profile, connected accounts, profiles + watchlists,
// appearance / content-tone). ConnectedAccountsCard rides along as a
// module-private helper; the OAuth provider-label helper it shares with
// App's link-mode toast moved to @/lib/oauth. Loads on first /settings nav.
const SettingsView = lazy(VIEW_LOADERS.settings)
// 2.3 — Requests (submitted-request statuses + inline TMDB search/create).
// humanizeRequestError rides along as a module-private helper. Loads on
// first /requests nav.
const RequestsView = lazy(VIEW_LOADERS.requests)
// 2.4 — Movies / TV Shows browse grid (hero, sort, genre filter, paginate,
// Continue Watching rail). Shares MediaRail + HeroSection with the eager
// HomeView; Media/Episode moved to @/lib/types and resume helpers to
// @/lib/format so this chunk doesn't reach back into App. Loads on first
// /movies or /shows nav. App keeps the list === null data gate and wraps
// the block in <ViewSuspense fallback={<BrowseLoadingState/>}> so the
// chunk-load + data-load fallbacks are visually identical.
const BrowseView = lazy(VIEW_LOADERS.browse)
// 2.5 — Detail, the title page (hero, episodes, cast, files, recap,
// trailer). App owns the data + handlers; the inline `resume` IIFE +
// `onEpisodeUnavailable` closure stay in App's render block (they close over
// App state) and are threaded in as props — NOT moved into the child. The
// lazy <DetailView> keeps key={selectedMedia.id} so it remounts per title
// and nothing the page keeps for one title is carried to the next (the one
// check the build can't catch). Loads on first card→detail nav.
// The title page, lazy like the other views, with one difference: when its
// chunk is already here (warmed when a card was first reached), the first
// render gets it AT ONCE. A lazy component otherwise suspends on its first
// render even for a module that has loaded, because a promise answers a
// turn later: the page a card opens was a skeleton for that turn, and the
// poster a press sends travelling (lib/posterTravel) had nothing to arrive
// at. A thenable that answers synchronously is read by React.lazy without
// suspending.
const DetailView = lazy(() => {
  const loaded = detailModule
  if (!loaded) return VIEW_LOADERS.detail()
  return { then: (resolve: (m: typeof loaded) => void) => { resolve(loaded) } } as unknown as Promise<typeof loaded>
})
// 2.6 — My Library (saved titles + Continue Watching). Shares isResumable,
// MediaCardCinema, Icon, and the app-side Media type with the other views.
// App owns the saved `library` state + `continueItems` and passes them as
// props; the Resume pill resolves the freshest CW record via a ref. Loads
// on first /library nav.
const LibraryView = lazy(VIEW_LOADERS.library)
// 2.7 — Search: titles matched as you type, and a search by description
// when asked for (Enter). App owns the query string, the ask and the library
// set and passes them as props; the debounce and the searchMedia calls live
// in the view. Loads on first /search nav.
const SearchView = lazy(VIEW_LOADERS.search)
// Social phase 1 — member profile page (/user/:username). Self-contained:
// fetches its own data by username, so App only parses the URL (see
// memberUsernameFromPath) and threads onSelect for the recent-watches
// rail. Loads on first profile nav.
const UserProfileView = lazy(VIEW_LOADERS.member)
// Social phase 2 — the member directory (/members): find + follow people.
// Reached from the avatar dropdown, not the tab strip (the strip is curated
// browse surfaces; this is an occasional destination like Settings).
const MembersView = lazy(VIEW_LOADERS.members)
const DeviceApprovalView = lazy(VIEW_LOADERS.device)
// The Together hub, the viewer's own profile page, and the phone's account
// page ("Me"), each loaded on first visit.
const TogetherView = lazy(VIEW_LOADERS.together)
const MyProfileView = lazy(VIEW_LOADERS.profile)
const MeView = lazy(VIEW_LOADERS.me)


/* ─────────────────────── MOCK DATA ─────────────────────── */

// Mock rail arrays (CONTINUE_WATCHING, NEW_ARRIVALS, etc.) were
// removed. Their numeric IDs collided with real Aurora media IDs and
// could stream the wrong item if a Play click hit the mock card
// during the home-load window. MOVIES/SHOWS/ANIME arrays remain only
// because Search's deleted-mock-fallback path references them.

/* ─────────────────── HOME REDESIGN HELPERS ───────────────────
 * Small pure helpers for Tonight's Continue Watching captions and the card
 * menu. Kept module-scoped (not inside a component) so they're trivially
 * testable and don't re-allocate per render. */

// "{Xh Ym left}" / "{Ym left}" remaining-time label for a Continue
// Watching record. Returns '' when we can't compute it honestly (no
// duration, or already past the end) so callers omit the token rather
// than show a guess.
function formatRemaining(positionMs: number, durationMs: number): string {
  if (!durationMs || durationMs <= 0) return ''
  const remMs = durationMs - positionMs
  if (remMs <= 0) return ''
  const totalMin = Math.max(1, Math.round(remMs / 60000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m left` : `${h}h left`
  return `${m}m left`
}

// Continue Watching card subtitle: "{S#E# | 'Movie'} · {Xh Ym left}".
// Either half is omitted (with its separator) when unavailable so we
// never render a stray "·" or a fabricated time.
function cwSubtitle(c: ContinueWatchingItem): string {
  // Branch on type FIRST so a show with a missing/zero season (specials,
  // or a data gap) reads "Episode" instead of being mislabeled "Movie".
  // `!= null` honors season 0.
  let epLabel: string
  if (c.type === 'show') {
    epLabel = c.season_number != null && c.episode_number != null
      ? `S${c.season_number}E${c.episode_number}`
      : 'Episode'
  } else {
    epLabel = 'Movie'
  }
  const left = formatRemaining(c.position_ms, c.duration_ms)
  return left ? `${epLabel} · ${left}` : epLabel
}


// Views that render their own edge-to-edge hero and therefore opt out of
// the .stage-page gutter, padding their inner sections with .stage-gutter.
// Anything not listed here gets the standard page pad from App's wrapper.
const FULL_BLEED_VIEWS = new Set(['home', 'movies', 'shows', 'detail'])

// What My Library is passed during a profile switch's first render
// (profileSwitchPending), module-level so it is the same array every time.
const NO_MEDIA: Media[] = []
const NO_CONTINUE: ContinueWatchingItem[] = []
const NO_RECENT: string[] = []
const NO_TOASTS: Toast[] = []

/* ─────────────────────── HOME VIEW ─────────────────────── */
// HomeView. Rails are cached at App level so navigating away-and-back
// reuses the previously-fetched data.
interface HomeViewProps {
  onSelect: (m: Media) => void
  onPlay: (m: Media) => void
  hero?: Media
  // `kind` is a stable discriminator. Don't use the user-visible
  // `title` for behavior: renaming or localizing it would silently
  // break the Continue Watching code path.
  rails?: {
    title: string
    items: Media[]
    aspect: 'poster' | 'landscape'
    // Which of Home's own rails this is, when it is one: Continue Watching,
    // or one of the three built from the catalog. The recommender's rails
    // have none.
    kind?: 'continue-watching' | 'recent' | 'top-movies' | 'top-shows'
    // Larger cards (the calmer Tonight of a profile with a content limit).
    size?: 'default' | 'large'
    // QA 2026-05-25 — when present, MediaRail renders a clickable
    // "See All" affordance that routes here. Built-in rails wire it
    // ("Top Rated Movies" → /movies + sort=rating); curated/AI rails
    // (no dedicated browse page) leave it undefined so the button
    // hides — no more misleading clicks that do nothing.
    seeAllTarget?: { view: 'movies' | 'shows'; sortBy?: 'rating' | 'recent' | 'title' | 'year' }
    // 2026-06-05 (Home redesign C/D) — optional presentation hints.
    //  • subtitle    — one-line "why it's here" under the rail title.
    //  • aiPick      — the recommender built this rail: its header carries
    //    the "Picked by Aurora" attribution, once, with the subtitle after it.
    //  • cardSubtitles — per-card subtitle override keyed by media id
    //    (Continue Watching uses it for "S2E4 · 23m left"); derived in
    //    the Home render where the source ContinueWatchingItem is in
    //    scope, since Media alone can't reconstruct the remaining time.
    subtitle?: string
    aiPick?: boolean
    cardSubtitles?: Record<number, string>
  }[]
  // App-level navigation callback so HomeView can request a route
  // change for See All clicks. Optional so the type stays backwards
  // compatible with renderers that don't wire it (the See All button
  // simply won't appear in that case).
  onNavigate?: (view: string, opts?: { sortBy?: 'rating' | 'recent' | 'title' | 'year' }) => void
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  // 2028-05-28 (deep-debug Bug C) — `continueItems` and `onPlayContinue`
  // were dead after the cinema-card swap removed the rail's hover Play CTA.
  // They previously fed a `railPlay` interceptor that resumed Continue
  // Watching cards at the saved position_ms / episode_id; with no Play CTA
  // for the interceptor to attach to, the props are unreachable. Resume
  // now happens via card-click → detail view → Play; tracked as a separate
  // follow-up.
  onCardContext: (e: React.MouseEvent, m: Media) => void
  // The hero (HeroSection). What it is: the title to resume, one of
  // Aurora's picks, or the catalog's fallback; why Aurora picked it; the
  // slate its filmstrip shows and which entry is up; and its place in the
  // recommender's slate for the exposure report (none for a title Aurora
  // did not pick).
  heroKind?: 'resume' | 'pick' | 'catalog'
  heroReason?: string
  heroSlate?: SlateEntry[]
  heroSlateIndex?: number
  onHeroPick?: (index: number) => void
  heroSlateToken?: string
  heroPosition?: number
  activeProfileId?: number
  // Play one of the picks at random.
  onSurprise?: () => void
  // The rotation: held while the pointer or focus is in the hero
  // (onHeroPauseChange), and paused by the viewer (heroRotationPaused, with
  // its toggle, which is absent when nothing rotates).
  onHeroPauseChange?: (paused: boolean) => void
  heroRotationPaused?: boolean
  onToggleHeroRotation?: () => void
  // Start a party on the hero's title; absent for a session not offered
  // Together.
  onHeroWatchTogether?: (m: Media) => void
  // The calmer presentation for a profile with a content limit.
  kids?: boolean
  // Cold-start hint info — passed through from the /api/me/hero response.
  // null = unknown (initial load); set when the response lands.
  heroPersonalization?: HeroPersonalization | null
  // True while Home still expects a pick (Stage refresh, L2): the core
  // rails, whose arrival sets the catalog fallback when the pool has none,
  // have not landed and have not failed. Draws the hero skeleton; false with
  // no hero is the settled no-pick state, drawn static.
  heroLoading?: boolean
  // My Library + button on cards. Set of saved IDs for fast O(1) lookup
  // per render; callback toggles membership when the user clicks +.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // 2026-05-27 — Hero resume awareness. When the hero media has a CW
  // record (position_ms > 0), App passes the matched ContinueWatchingItem
  // here so HeroSection can label its primary CTA "Resume at MM:SS"
  // instead of "Play" — matching the DetailView Resume CTA shipped in
  // PR #97. Bundled with its handler in a discriminated `heroResume`
  // shape (same pattern as DetailView's `resume`) so partial wiring is
  // a type error. Undefined = no CW match for the current hero, render
  // the classic Play button.
  heroResume?: {
    item: ContinueWatchingItem
    onPlay: (c: ContinueWatchingItem) => void
  }
  // Play from a card's on-poster button, on every rail. The handler resumes
  // when the viewer has a position in the title, as the card's menu does
  // (its first row is Resume then), so the two controls on one card agree;
  // resumableIds says which cards that is, so their button reads "Resume".
  onCardPlay?: (m: Media) => void
  resumableIds?: Set<number>
  // The page's closing line, and who is signed in.
  //  • user        — the signed-in account (the live strip leaves out the
  //    viewer's own party).
  //  • pickCount   — how many titles Aurora picked (hero picks and its
  //    rails, deduped): "{N} titles worth your time".
  //  • libraryTotal — how many titles this profile may see, or null when
  //    no count has loaded; the clause naming it is OMITTED when null rather
  //    than made up.
  user?: ApiUser
  pickCount?: number
  libraryTotal?: number | null
  // The live strip above the first rail ("Happening now"): a running party
  // and an unanswered invitation.
  //  • parties — the account's active watch parties from App's one poll, or
  //    undefined for a session that is not offered Together; the strip and
  //    anything else about parties is then left out.
  //  • invites — the caller's open invitations, null before they have loaded
  //    and on the commit that switches profile.
  //  • inPartyCode — the party this session is in; its row opens it.
  //  • onJoinParty — join a party by code, or open the one already joined.
  parties?: ActiveParty[]
  invites?: MyPartyInvite[] | null
  inPartyCode?: string | null
  onJoinParty?: (code: string) => void
  onInviteRsvp?: (inviteId: number, rsvp: 'going' | 'maybe') => void
  // Stage 3 — manual "Refresh picks": force a server rebuild of the LLM
  // Discover rails. recsRefreshing disables the control while in flight.
  onRefreshRecs?: () => void
  recsRefreshing?: boolean
  // The children's closing line: the profile's limit as a label ("PG"), and
  // the way to change who is watching.
  limitLabel?: string
  onSwitchProfile?: () => void
}
// Home's catalog rails: Recently Added, Top Rated Movies, Top Rated Shows.
// Built in one place for the full Home load and the live catalog refresh.
// Core rails get neither the AI attribution nor a "why it's here" subtitle:
// only the recommender-driven rails do (spliced in by recomposeHomeRails).
function coreHomeRails(recent: Media[], movies: Media[], shows: Media[]): NonNullable<HomeViewProps['rails']> {
  return [
    // Recently Added blends movies + shows so the See All can't honestly map
    // to a single browse page — leave the affordance off rather than pick one
    // arbitrarily.
    { title: 'Recently Added', items: recent, aspect: 'poster' as const, kind: 'recent' as const },
    // Top Rated rails map cleanly to /movies and /shows with sortBy=rating,
    // so the See All button takes the user to the full Top Rated catalog.
    { title: 'Top Rated Movies', items: movies, aspect: 'poster' as const, kind: 'top-movies' as const,
      seeAllTarget: { view: 'movies' as const, sortBy: 'rating' as const } },
    { title: 'Top Rated Shows', items: shows, aspect: 'poster' as const, kind: 'top-shows' as const,
      seeAllTarget: { view: 'shows' as const, sortBy: 'rating' as const } },
  ]
}

function HomeView({
  onSelect, onPlay, hero, heroLoading, rails, loading, error, onRetry, onCardContext,
  heroKind, heroReason, heroSlate, heroSlateIndex, onHeroPick, heroSlateToken, heroPosition, activeProfileId,
  onSurprise, onHeroPauseChange, heroRotationPaused, onToggleHeroRotation, onHeroWatchTogether, kids = false,
  heroPersonalization, libraryIds, onToggleLib, onNavigate, heroResume, onCardPlay, resumableIds, user,
  pickCount, libraryTotal, parties, invites, inPartyCode, onJoinParty, onInviteRsvp,
  onRefreshRecs, recsRefreshing, onSwitchProfile, limitLabel,
}: HomeViewProps) {
  // Do NOT fall back to mock rails: their IDs collide with real
  // media IDs and silently route Play to the wrong title. Empty
  // rails during the load window are correct.
  const effectiveRails = rails ?? []
  const nPicks = pickCount ?? 0
  // The page's wash: the hero artwork's ambient colour (lib/ambient), kept
  // with the picture it was sampled from and laid down only while that
  // picture is the hero's, so one title's colour is never behind another.
  const [ambient, setAmbient] = useState<{ src: string; color: string | null } | null>(null)
  const handleAmbient = useCallback((color: string | null, src: string) => {
    setAmbient(prev => (prev && prev.src === src && prev.color === color ? prev : { src, color }))
  }, [])
  const heroArt = hero ? (hero.backdrop || hero.poster || '') : ''
  const wash = ambient && ambient.src === heroArt ? ambient.color : null

  return (
    <div className="animate-fade-in relative" style={{ '--ambient': wash ?? 'transparent' } as React.CSSProperties}>
      {/* Behind everything: the artwork's colour, washing down from where
          the art sits. The hero is opaque, so what shows of it is the fall
          below the hero, behind the first rails. */}
      <div className="tonight-wash" aria-hidden="true" />
      {/* The page's heading. The hero's title is a title, not the page's
          name, and with no hero there would be no heading at all. */}
      <h1 className="sr-only">Tonight</h1>
      <HeroSection
        hero={hero}
        loading={heroLoading}
        kind={heroKind}
        onPlay={onPlay}
        onInfo={onSelect}
        reason={heroReason}
        slate={heroSlate}
        slateIndex={heroSlateIndex}
        onPick={onHeroPick}
        slateToken={heroSlateToken}
        slatePosition={heroPosition}
        profileId={activeProfileId}
        onPauseChange={onHeroPauseChange}
        rotationPaused={heroRotationPaused}
        onToggleRotation={onToggleHeroRotation}
        onRefreshPicks={onRefreshRecs}
        picksRefreshing={recsRefreshing}
        onSurprise={onSurprise}
        onWatchTogether={onHeroWatchTogether}
        personalization={heroPersonalization ?? null}
        resume={heroResume}
        libraryIds={libraryIds}
        onToggleLib={onToggleLib}
        kids={kids}
        onAmbient={handleAmbient}
      />
      {/* Describing what you are in the mood for is search's job now: the
          field in the top bar (and the Search page's own, on a phone) takes
          a description as well as a title, and Enter runs it. The bar that
          sat here asked the same question a second time. */}
      {/* Everything below the hero opts back into the page gutter. HomeView
          is full-bleed (FULL_BLEED_VIEWS) so the hero can reach the viewport
          edge; the rest lines up with the hero's text column because both
          read --page-gutter. The wrapper opens HERE, above every status
          banner, a step below the hero's edge. */}
      <div className="stage-gutter pt-5">
      {error && (
        <div className="mb-6 px-5 py-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">Couldn't load your library</p>
            <p className="text-red-300/70 text-xs mt-1">{error}</p>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="stage-btn stage-btn-sm stage-btn-ghost"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {/* Happening now: above the first rail, and above its skeleton, so a
          party that is running is on the first screen. Nothing for a session
          that is not offered Together (parties is undefined then). */}
      {parties && onJoinParty && onInviteRsvp && (
        <TonightLive
          parties={parties}
          invites={invites ?? null}
          currentUserId={user?.id}
          inPartyCode={inPartyCode}
          onJoin={onJoinParty}
          onRsvp={onInviteRsvp}
        />
      )}
      {loading && !rails && (
        // Rail-shaped skeletons where the rails will land, in the shapes
        // the first three usually take (Continue Watching is landscape).
        // The banner this replaces was one line of purple text; the whole
        // page then popped in around it. The announcement stays, sr-only.
        // Plain wrapper: this already sits inside HomeView's .stage-gutter,
        // and a second gutter made the skeletons 2× the page padding
        // narrower than the rails that replace them.
        <div>
          <p className="sr-only" role="status">Loading your library…</p>
          <RailSkeleton aspect="landscape" count={5} />
          <RailSkeleton />
          {/* The third rail is usually the recommender's, which has a line
              under its title. */}
          <RailSkeleton subtitle />
        </div>
      )}
      {effectiveRails.map((rail, i) => {
        if (rail.items.length === 0) return null
        const seeAllHandler = rail.seeAllTarget && onNavigate
          ? () => onNavigate(rail.seeAllTarget!.view, { sortBy: rail.seeAllTarget!.sortBy })
          : undefined
        // 2026-06-05 (Home redesign C) — per-card subtitle resolver
        // from the rail's precomputed map (only the CW rail supplies
        // one). Undefined for cards not in the map → default meta row.
        const cardSubtitleFor = rail.cardSubtitles
          ? (m: Media) => rail.cardSubtitles![m.id]
          : undefined
        return (
          <MediaRail
            key={`${rail.title}-${i}`}
            title={rail.title}
            items={rail.items}
            // First rail's first row sits at the hero fold: fetch it eagerly.
            eagerCount={i === 0 ? 6 : 0}
            onSelect={onSelect}
            onPlay={onCardPlay ?? onPlay}
            resumableIds={resumableIds}
            aspect={rail.aspect}
            size={rail.size}
            onCardContext={onCardContext}
            libraryIds={libraryIds}
            onToggleLib={onToggleLib}
            onSeeAll={seeAllHandler}
            subtitle={rail.subtitle}
            aiPick={rail.aiPick}
            cardSubtitleFor={cardSubtitleFor}
          />
        )
      })}
      {/* The page's last line: how much there is, and where the rest of it
          lives. The counts used to open the page, in a greeting; they are
          the same two numbers, held to the profile the app acts as. A
          profile with a content limit is told what it is being shown
          instead, and how to change who is watching. */}
      {effectiveRails.length > 0 && (
        <div className="tonight-foot" data-tonight-foot>
          {kids ? (
            <>
              <p>
                {libraryTotal != null && libraryTotal > 0
                  ? <>Showing the <b>{libraryTotal.toLocaleString()}</b> titles in your library{limitLabel ? <> rated {limitLabel} and under</> : null}.</>
                  : <>Showing titles{limitLabel ? <> rated {limitLabel} and under</> : null}.</>}
              </p>
              {onSwitchProfile && (
                <button type="button" className="stage-btn stage-btn-ghost" onClick={onSwitchProfile}>Switch profile</button>
              )}
            </>
          ) : (
            <>
              <p>
                {nPicks > 0 ? (
                  <>
                    <b>{nPicks}</b> titles worth your time
                    {libraryTotal != null && libraryTotal > 0 && (
                      <> out of the <b>{libraryTotal.toLocaleString()}</b> titles in your library</>
                    )}
                    .
                  </>
                ) : libraryTotal != null && libraryTotal > 0 ? (
                  <><b>{libraryTotal.toLocaleString()}</b> titles in your library.</>
                ) : null}
              </p>
              {onNavigate && (
                <button type="button" className="stage-btn stage-btn-ghost" onClick={() => onNavigate('movies')}>Browse the library</button>
              )}
            </>
          )}
        </div>
      )}
      <div className="h-16" />
      </div>{/* /stage-gutter */}
    </div>
  )
}

/* ─────────────────────── SERVER PANEL ─────────────────────── */
// ServerPanel fetches /api/admin/dashboard and polls every 5s while
// open. Non-admins see a "admin-only" message.
function ServerPanel({ open, isAdmin, onClose }: { open: boolean; isAdmin: boolean; onClose: () => void }) {
  // Phase 11.4 — this rendered role="dialog" with no focus management at all.
  const panelRef = useRef<HTMLDivElement | null>(null)
  usePanelDismiss(open, onClose, panelRef)
  const [stats, setStats] = useState<ServerStats | null>(null)
  useEffect(() => {
    if (!open || !isAdmin) return
    let cancelled = false
    const tick = async () => {
      try {
        const s = await getAdminDashboard()
        if (!cancelled) setStats(s)
      } catch { /* non-fatal — panel just stays blank */ }
    }
    void tick()
    const id = window.setInterval(tick, 5000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [open, isAdmin])
  // Stays mounted for the exit fade (is-closing) after `open` flips false.
  const exit = useExitTransition(open)
  if (!exit.mounted) return null
  const fmtBytes = (n: number): string => {
    if (n <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
    return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
  }
  type StatTile = { label: string; value: string; icon: string; tone: string; hint?: string }
  const tiles: StatTile[] = stats && isAdmin
    ? [
      // Same number and same explanation as the Admin dashboard's tile — it
      // reads from the same field, so it needs the same hint or the two
      // surfaces disagree about what they are counting.
      { label: 'Active Streams', value: String(stats.active_streams), icon: 'monitor', tone: 'ok',
        hint: 'Streams being watched — transcode plus direct play. A Chromecast holds two server sessions for one viewer (the paused browser session and the cast-safe clone the TV pulls); they count once here.' },
      { label: 'Disk Free', value: `${stats.disk_free_gb.toFixed(1)} GB`, icon: 'hardDrive', tone: stats.disk_free_gb < 10 ? 'warn' : 'ok' },
      // QA 2026-05-25 — Memory shows the Go process's RSS, which on
      // a 65 TB media server reads suspiciously small (~10 MB) until
      // you know FFmpeg + PostgreSQL aren't counted. The hint surfaces
      // that context on hover instead of requiring the user to dig
      // into the metric definition.
      { label: 'Memory', value: `${stats.memory_alloc_mb} MB`, icon: 'zap', tone: 'ok',
        hint: "Aurora's Go process RSS after the last GC. FFmpeg transcoders run as separate subprocesses and aren't counted here. PostgreSQL runs in its own container with its own memory budget." },
      { label: 'Library Size', value: fmtBytes(stats.total_file_size_bytes), icon: 'film', tone: 'ok' },
      // QA BUG-002 labelled this "Files" rather than "Titles" so it would
      // not read as conflicting with the deduped Movies/Shows browse
      // header. But movie_count/show_count are COUNT(*) over media_items
      // (queries_phase4.go GetMediaCounts) — title rows, zero files, no
      // episodes. "Files" was the one noun it could not be, and it
      // contradicted the admin dashboard tile fed by these same two
      // fields. Says "rows" now, which is the honest distinction from the
      // browse header: raw count, so a film in both "Movies" and "4K
      // Movies" is counted twice here and once there.
      { label: 'Rows: Movies · Shows', value: `${stats.movie_count.toLocaleString()} · ${stats.show_count.toLocaleString()}`, icon: 'film', tone: 'ok',
        hint: 'Title rows in the catalog, not files and not episodes — a show counts once here however many episodes it has. Raw count, so a title present in two libraries is counted twice.' },
      { label: 'Users', value: String(stats.user_count), icon: 'users', tone: 'ok' },
      { label: 'Active Parties', value: String(stats.active_parties), icon: 'users', tone: 'ok' },
      { label: 'Uptime', value: stats.uptime, icon: 'activity', tone: 'ok' },
    ]
    : []
  // QA BUG-005 kept the panel next to whatever opens it, rather than
  // spanning the content area and burying the header controls. That
  // trigger moved: 2026-07-25 (Aurora Stage Phase 2) it went from the
  // sidebar footer (bottom-left) to the TopNav's right cluster + the
  // avatar dropdown, so the panel now hangs from the TOP-RIGHT, directly
  // under its button, instead of bottom-anchored beside the old sidebar.
  // (Deliberately not naming the old Tailwind classes here: Tailwind's
  // extractor scans comments too, so a class named in prose gets emitted as
  // dead CSS — this line was shipping a left-252px rule nothing used.)
  //
  // z-[45] deliberately sits BELOW the sticky nav stack (50) so the nav's
  // own triggers stay clickable while the panel is open — that was the
  // whole point of BUG-005 — and below ContextMenu (100) / modals (60s).
  return (
    <div
      id="stage-server-panel"
      ref={panelRef}
      role="dialog"
      aria-label="Server status"
      // tabIndex={-1} so the CONTAINER can take focus. Focusing the first control
      // instead would announce "Close" as the panel's opening word; the element
      // carrying the accessible name is what a reader should meet first.
      // No `aria-modal`: this panel is non-modal by design (z-45, below the nav,
      // so the nav's own triggers stay clickable — BUG-005), and declaring modal
      // would tell AT the rest of the page is inert when it is not.
      tabIndex={-1}
      className={`fixed left-2 right-2 md:left-auto md:right-6 md:w-[480px] max-h-[70vh] bg-surface-raised-2 border border-white/[0.06] rounded-xl shadow-[shadow:var(--shadow-pop)] p-5 z-[45] animate-pop-in origin-top md:origin-top-right overflow-y-auto overscroll-contain${exit.closing ? ' is-closing' : ''}`}
      style={{ top: 'calc(var(--chrome-h, var(--topnav-h)) + 10px)' }}
    >
      {/* No "Server Status" heading — the nav trigger already shows that
          label and the panel opens directly under it. Matching the
          NotificationPanel pattern, we DO offer a close affordance. */}
      <button
        onClick={onClose}
        className="absolute top-3 right-3 text-white/40 hover:text-white transition-colors"
        aria-label="Close server status"
      >
        <Icon name="x" size={16} />
      </button>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pr-6">
        {!isAdmin && <p className="text-white/50 text-sm col-span-full">Server status is admin-only.</p>}
        {isAdmin && !stats && <p className="text-white/50 text-sm col-span-full">Loading stats…</p>}
        {tiles.map(stat => (
          <div
            key={stat.label}
            title={stat.hint}
            className={`glass-panel rounded-xl p-3 ${stat.hint ? 'cursor-help' : ''}`}
          >
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
                stat.tone === 'warn' ? 'bg-amber-500/10 text-amber-400' :
                stat.tone === 'idle' ? 'bg-white/[0.04] text-white/40' :
                'bg-emerald-500/10 text-emerald-400'
              }`}>
                <Icon name={stat.icon} size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-white/50 text-xs flex items-center gap-1">
                  {stat.label}
                  {stat.hint && <span className="text-white/35 text-xs">ⓘ</span>}
                </p>
                <p className="text-white text-base font-bold truncate">{stat.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────── NOTIFICATION PANEL ─────────────────────── */
// Shared by the NotificationPanel rows and the live WS toast so the
// notification type→copy mapping can't drift between the two surfaces.
// Every server-side type (internal/push/payload.go bodyFor) needs a case
// here — the review caught both Phase 2 admin types falling through to
// "is now available", which is false for a request awaiting review and
// word salad for a scan summary. The foreground policy suppresses the OS
// banner while a window is focused, so THIS line is the primary surface.
const notifLine = (n: AppNotification): string =>
  n.type === 'request_failed' ? `Request failed: ${n.title}`
  : n.type === 'party_reel_ready' ? `Highlight reel ready: ${n.title}`
  : n.type === 'admin_new_request' ? `New request awaiting review: ${n.title}`
  : n.type === 'scan_complete' ? `Library scan — ${n.title}`
  // Invite titles are server-composed sentences ("Ronnie invited you —
  // Halloweentown", "Mel is in — …"); pass them through untouched.
  : n.type === 'party_invite' ? n.title
  : n.type === 'party_rsvp' ? n.title
  : n.type === 'party_reminder' ? `Starting soon — ${n.title}`
  : `${n.title} is now available`

// Render a notification's link only when it is a same-origin path. The
// server column is free text, so refuse absolute and protocol-relative
// URLs (off-origin redirect) and anything non-path (javascript: would be
// stored XSS) in case a future producer writes less-controlled values.
const safeNotifLink = (link?: string): string | undefined =>
  link && link.startsWith('/') && !link.startsWith('//') ? link : undefined

// NotificationPanel surfaces recent admin activity log entries.
// Real-time WS-driven notifications are TODO; non-admins see an
// empty state.
function NotificationPanel({ open, isAdmin, onClose, notifications, onMarkAllRead, partyInvites, onRsvp, onJoinParty }: {
  open: boolean
  isAdmin: boolean
  onClose: () => void
  notifications: AppNotification[]
  onMarkAllRead: () => void
  // Invites feature — the caller's open invites (null while loading).
  // Party-invite notification rows cross-reference this by party code to
  // render inline RSVP; an invite missing from the feed means the party
  // ended, so the row degrades to a dim "ended" line.
  partyInvites: MyPartyInvite[] | null
  onRsvp: (inviteId: number, rsvp: 'going' | 'maybe' | 'declined') => void
  onJoinParty: (code: string) => void
}) {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(false)
  // Phase 11.4 — same gap as ServerPanel: role="dialog" with no focus management.
  const panelRef = useRef<HTMLDivElement | null>(null)
  usePanelDismiss(open, onClose, panelRef)
  // Which ids were unread the moment the panel opened, so rows can show that
  // distinction (issue #474 — previously nothing rendered read_at at all, so
  // a badge count and an undifferentiated list of familiar-looking items
  // were indistinguishable from "the badge was wrong"). Snapshotted before
  // marking read below, and held for the rest of this open session so the
  // dots don't vanish out from under the user as read_at flips locally.
  const [unreadSnapshot, setUnreadSnapshot] = useState<Set<number>>(() => new Set())
  // Mark the user's notifications read when the panel opens (clears the badge).
  // Via a ref so this open→true effect doesn't depend on the parent's inline
  // callback identity, which changes every render.
  const onMarkAllReadRef = useRef(onMarkAllRead)
  onMarkAllReadRef.current = onMarkAllRead
  useEffect(() => {
    if (!open) return
    setUnreadSnapshot(new Set(notifications.filter(n => !n.read_at).map(n => n.id)))
    onMarkAllReadRef.current()
    // Deliberately keyed on `open` alone — `notifications` is read for its
    // value at the moment the panel opens, not tracked as a trigger (the
    // mark-all-read this fires would otherwise cause it to re-run on every
    // resulting re-render, re-marking already-read ids as "was unread").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open || !isAdmin) return
    let cancelled = false
    setLoading(true)
    listAdminActivity(20).then(a => { if (!cancelled) setEntries(a) })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, isAdmin])
  const fmtRel = (iso: string): string => {
    const t = new Date(iso).getTime()
    if (!t) return ''
    const diff = Date.now() - t
    if (diff < 60_000) return 'just now'
    // Mirror the AdminView.fmtRelative shape above so future edits
    // touch both consistently. "min" / "hr" / "d" are abbreviations
    // that already read OK at n === 1 (no grammar issue like the
    // "1 days ago" QA bug in the unabbreviated form), but the
    // singular branch on "hr" keeps the two formatters aligned.
    const mins = Math.floor(diff / 60_000)
    if (diff < 3_600_000) return `${mins} min ago`
    const hrs = Math.floor(diff / 3_600_000)
    if (diff < 86_400_000) return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'} ago`
    return `${Math.floor(diff / 86_400_000)} d ago`
  }
  // Stays mounted for the exit fade (is-closing) after `open` flips false.
  const exit = useExitTransition(open)
  if (!exit.mounted) return null
  // QA BUG-006 — anchor near the Notifications trigger rather than the
  // top-left of the content area, where it covered the page heading and
  // looked unrelated to the button that opened it. As with ServerPanel,
  // that trigger moved to the TopNav right cluster + avatar dropdown in
  // Aurora Stage Phase 2, so the panel hangs from the top-right. The
  // bounded max-height keeps it reachable on short viewports (content
  // scrolls inside).
  //
  // z-[45] — same layering rationale as ServerPanel above.
  return (
    <div
      id="stage-notification-panel"
      ref={panelRef}
      role="dialog"
      aria-label="Notifications"
      tabIndex={-1}
      className={`fixed left-2 right-2 md:left-auto md:right-6 md:w-[360px] max-h-[70vh] bg-surface-raised-2 border border-white/[0.06] rounded-xl shadow-[shadow:var(--shadow-pop)] z-[45] animate-pop-in origin-top md:origin-top-right overflow-y-auto overscroll-contain${exit.closing ? ' is-closing' : ''}`}
      style={{ top: 'calc(var(--chrome-h, var(--topnav-h)) + 10px)' }}
    >
      <div className="p-4 border-b border-white/[0.06] flex items-center justify-between">
        <h3 className="text-white font-semibold">Notifications</h3>
        <button onClick={onClose} className="text-white/40 hover:text-white transition-colors" aria-label="Close notifications">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div>
        {notifications.length === 0 && (
          <div className="p-8 text-center">
            <p className="text-white/60 text-sm">No notifications yet</p>
            <p className="text-white/50 text-xs mt-2">You'll be notified when a request is ready to watch.</p>
          </div>
        )}
        {notifications.map(n => {
          const isPartyType = n.type === 'party_invite' || n.type === 'party_reminder' || n.type === 'party_rsvp'
          const partyCode = isPartyType ? inviteCodeFromLink(n.link) : null
          // The invite row (RSVP + note + time) only renders for
          // party_invite; reminders/rsvp-pings just get a Join button.
          const invite = n.type === 'party_invite' && partyCode && partyInvites
            ? partyInvites.find(i => i.party_code === partyCode)
            : undefined
          const inviteGone = n.type === 'party_invite' && partyCode && partyInvites && !invite
          const dot = n.type === 'request_failed' ? 'bg-red-400' : isPartyType ? 'bg-action' : 'bg-emerald-400'
          const isUnread = unreadSnapshot.has(n.id)
          return (
            <div
              key={n.id}
              className={`p-4 border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors flex items-start gap-3 ${isUnread ? 'bg-white/5' : ''}`}
            >
              <span
                className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dot}`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                {/* Same-origin <a href> so the httpOnly auth cookie rides along
                    (the highlight-reel MP4 is an authenticated endpoint).
                    Party rows join in-app instead — a new tab would spawn a
                    second SPA session just to run party.join. */}
                {safeNotifLink(n.link) && !isPartyType ? (
                  <a
                    href={safeNotifLink(n.link)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white/90 hover:text-white text-sm font-medium truncate block underline decoration-white/20 underline-offset-2"
                  >
                    {notifLine(n)}
                  </a>
                ) : (
                  <h4 className="text-white/90 text-sm font-medium truncate">{notifLine(n)}</h4>
                )}

                {invite && (
                  <>
                    {(invite.scheduled_start_at || invite.note) && (
                      <p className="text-white/50 text-xs mt-1 truncate">
                        {/* A party that has started keeps its planned
                            time as it is; one that has not, and whose time
                            has passed, does not read as still to come. */}
                        {invite.scheduled_start_at ? (invite.started_at ? formatPartyTime(invite.scheduled_start_at, new Date()) : plannedStartLabel(invite.scheduled_start_at, new Date())) : ''}
                        {invite.scheduled_start_at && invite.note ? ' · ' : ''}
                        {invite.note ? `“${invite.note}”` : ''}
                      </p>
                    )}
                    <div className="flex gap-1.5 mt-2 flex-wrap">
                      {([['going', "I'm in"], ['maybe', 'Maybe'], ['declined', "Can't make it"]] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => onRsvp(invite.invite_id, value)}
                          aria-pressed={invite.rsvp === value}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                            invite.rsvp === value
                              ? value === 'going'
                                ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-200'
                                : value === 'maybe'
                                  ? 'bg-amber-500/15 border-amber-400/45 text-amber-200'
                                  : 'bg-white/[0.08] border-white/[0.2] text-white/80'
                              : 'bg-white/[0.03] border-white/[0.09] text-white/55 hover:text-white/85 hover:border-white/[0.2]'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                      {partyCode && invite.rsvp !== 'declined' && (
                        <button
                          type="button"
                          onClick={() => onJoinParty(partyCode)}
                          className="px-2.5 py-1 rounded-md text-xs font-medium bg-action-soft border border-line-strong text-ink hover:bg-white/20 transition-colors"
                        >
                          {invite.started_at || !invite.scheduled_start_at ? 'Join' : 'Open lobby'}
                        </button>
                      )}
                    </div>
                  </>
                )}
                {inviteGone && (
                  <p className="text-white/50 text-xs mt-1">This party has ended.</p>
                )}
                {isPartyType && n.type !== 'party_invite' && partyCode && (
                  <button
                    type="button"
                    onClick={() => onJoinParty(partyCode)}
                    className="mt-2 px-2.5 py-1 rounded-md text-xs font-medium bg-action-soft border border-line-strong text-ink hover:bg-white/20 transition-colors"
                  >
                    Join
                  </button>
                )}
                <p className="text-white/50 text-xs mt-1">
                  {fmtRel(n.created_at)}
                  {isUnread && <span className="ml-1.5 text-ink font-medium">· New</span>}
                </p>
              </div>
            </div>
          )
        })}

        {/* Admin activity log, kept below the user's own notifications. */}
        {isAdmin && (
          <>
            <div className="px-4 pt-3 pb-2 border-t border-white/[0.06]">
              <h4 className="text-white/50 text-xs font-semibold uppercase tracking-wide">Recent Activity</h4>
            </div>
            {loading && entries.length === 0 && (
              <p className="px-4 pb-4 text-white/50 text-sm">Loading…</p>
            )}
            {!loading && entries.length === 0 && (
              <p className="px-4 pb-4 text-white/50 text-sm">No recent activity.</p>
            )}
            {entries.map(e => (
              <div key={e.id} className="p-4 border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                <h4 className="text-white/90 text-sm font-medium">{e.event_type.replace(/_/g, ' ')}</h4>
                {e.username && <p className="text-white/50 text-xs mt-0.5">{e.username}</p>}
                <p className="text-white/60 text-xs mt-1">{fmtRel(e.created_at)}</p>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// Quiet placeholder while a browse list is in flight.
function BrowseLoadingState({ compact = false }: { compact?: boolean }) {
  return (
    // The grid's own frame, as shapes, so BrowseView lands on exactly this.
    // The page's header (its name, count and controls) is LibraryHeader's
    // and stays up above it. The gutter is here because movies/shows are in
    // FULL_BLEED_VIEWS and do not inherit .stage-page's padding: this renders
    // on every sort and genre change (the parent resets the list to null),
    // and without it the skeleton flashed edge to edge and snapped in.
    <div className="animate-fade-in relative">
      <div className="stage-gutter pt-6">
        <p className="sr-only" role="status">Loading your library…</p>
        <GridSkeleton compact={compact} />
      </div>
    </div>
  )
}

/** How long Tonight's hero waits for Continue Watching before it goes ahead
 *  without a title to resume. */
const HERO_LEAD_WAIT_MS = 4000

/* ─────────────────────── MAIN APP ─────────────────────── */

/** Marks a page a restricted session is not shown (lib/navScope
 *  hiddenFromRestricted). It adds no box of its own (`contents`); it exists
 *  so a test can hold EVERY commit to "no such page is on screen", whatever
 *  the page itself renders. */
function HiddenPage({ name, children }: { name: string; children: React.ReactNode }) {
  return <div data-hidden-page={name} className="contents">{children}</div>
}

// QA BUG-001 — URL → view mapping for direct loads / browser
// back-forward / bookmarks. The BrowserRouter basename is "/v2"
// (set in main.tsx), so useLocation().pathname returns the path
// WITHOUT that prefix — "/movies" rather than "/v2/movies".
//
// 'detail' resolves from /title/:id (see titleIdFromPath below) rather
// than this static map: opening a card pushes /title/<id>, so refresh,
// browser Back, bookmarks, and shared links all land on the same title.
// A cold load hydrates selectedMedia from GET /api/media/:id.
const VIEW_BY_PATH: Record<string, string> = {
  '': 'home',
  '/': 'home',
  '/home': 'home',
  '/movies': 'movies',
  '/shows': 'shows',
  '/library': 'library',
  '/calendar': 'calendar',
  '/collections': 'collections',
  '/requests': 'requests',
  '/admin': 'admin',
  '/settings': 'settings',
  '/search': 'search',
  '/members': 'members',
  '/device': 'device',
  // Upcoming is the calendar's name as a scope of Library; both URLs render it.
  '/upcoming': 'calendar',
  '/together': 'together',
  '/profile': 'profile',
  '/me': 'me',
}

// What the phone's top bar calls each page.
const PAGE_TITLES: Record<string, string> = {
  home: 'Tonight', movies: 'Movies', shows: 'TV Shows', collections: 'Collections',
  library: 'My Library', calendar: 'Upcoming', together: 'Together', members: 'Members',
  member: 'Member', requests: 'My requests', settings: 'Settings', admin: 'Admin',
  search: 'Search', profile: 'Your profile', me: 'Me', detail: '', device: 'Pair a device',
}

// titleIdFromPath extracts the media id from a /title/:id pathname, or
// null when the path is anything else. Kept strict (digits only) so a
// malformed deep link falls through to the home view instead of a
// dangling detail page.
const TITLE_PATH_RE = /^\/title\/(\d+)$/
function titleIdFromPath(pathname: string): number | null {
  const m = TITLE_PATH_RE.exec(pathname)
  return m ? Number(m[1]) : null
}

// memberUsernameFromPath extracts the username from a /user/:username
// pathname (the member profile page, social phase 1), or null otherwise.
// Charset covers what registration + OAuth's sanitizeUsername can mint
// (alnum/underscore, plus dot/dash headroom), capped at the DB column's 50.
// Kept strict for the same reason TITLE_PATH_RE is: a malformed deep link
// falls through to home instead of a dangling profile page; a well-formed
// but unknown name 404s at the API and the view says so.
const MEMBER_PATH_RE = /^\/user\/([A-Za-z0-9._-]{1,50})$/
function memberUsernameFromPath(pathname: string): string | null {
  const m = MEMBER_PATH_RE.exec(pathname)
  return m ? m[1] : null
}

// Card mapping + subtitle for the "From People You Follow" rail (social
// phase 2). Module-level like the route helpers: pure functions of the feed
// row, no App state.
function mapFollowedToMedia(w: FollowedWatch): Media {
  return {
    id: w.id,
    title: w.title,
    year: w.year || 0,
    rating: w.rating || 0,
    duration: '',
    genre: '',
    type: w.type === 'show' ? 'show' : 'movie',
    poster: posterURL(w.poster_path),
    backdrop: backdropURL(w.backdrop_path, 'w780'),
    description: '',
  }
}

// "alice · 2d ago" — mirrors UserProfileView's watchedAgo buckets, but
// leads with WHO because attribution is this rail's whole point.
function followedWatchSubtitle(w: FollowedWatch): string {
  const t = Date.parse(w.watched_at)
  let ago = ''
  if (!Number.isNaN(t)) {
    const days = Math.floor((Date.now() - t) / 86_400_000)
    if (days <= 0) ago = 'today'
    else if (days === 1) ago = 'yesterday'
    else if (days < 7) ago = `${days}d ago`
    else if (days < 30) ago = `${Math.floor(days / 7)}w ago`
    else ago = new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  }
  return ago ? `${w.watched_by} · ${ago}` : w.watched_by
}

// A collection's item as the UI's Media, with its real poster, year, rating
// and genre: a title saved to My Library from a collection is stored with
// them (a stub would show as a posterless, year-0 card until the next
// refresh), and the card menu acts on the same record.
function collectionItemToMedia(m: ServerMediaItem): Media {
  return {
    id: m.id,
    title: m.title,
    year: m.year ?? 0,
    rating: m.rating ?? 0,
    duration: '',
    genre: (m.genres && m.genres[0]) || '',
    type: m.type,
    poster: posterURL(m.poster_path),
    backdrop: backdropURL(m.backdrop_path),
    description: m.overview ?? '',
  }
}

// No parties: the list given to anything that must not show one.
const NO_PARTIES: ActiveParty[] = []

function pathToView(pathname: string): string {
  // Exact match first.
  if (VIEW_BY_PATH[pathname] !== undefined) return VIEW_BY_PATH[pathname]
  if (titleIdFromPath(pathname) !== null) return 'detail'
  if (memberUsernameFromPath(pathname) !== null) return 'member'
  // First-segment fallback so future subroutes (e.g. /movies/genre/action)
  // still resolve to the top-level view that contains them.
  const first = pathname.split('/').filter(Boolean)[0]
  return VIEW_BY_PATH['/' + (first ?? '')] ?? 'home'
}

// Scroll memory — one offset per history entry, keyed by react-router's
// location.key. `history.scrollRestoration` is 'manual' (main.tsx) because
// native restoration fires on popstate while the OUTGOING view is still
// mounted: it clamps to that document's height and the SPA then re-renders
// under it, which is how Back from a title landed at the top of a Home you
// had scrolled six rails down. App records the offset when it leaves an
// entry in-app (handleSelect / handleNavigate) and the layout effect next
// to the URL-sync effect restores it once the destination VIEW has
// committed. A Map, not sessionStorage: after a reload every view's data is
// gone as well, so there is nothing to restore onto until it refetches.
const scrollMemory = new Map<string, number>()
function rememberScroll(key: string): void {
  scrollMemory.set(key, window.scrollY)
}

export default function App() {
  const [view, setView] = useState('home')
  // Bumped every time the user clicks the current view's nav item.
  // Views with internal drill-down state (CollectionsView's selected
  // collection, future views) can subscribe via useEffect deps and
  // reset back to their index. See handleNavigate's same-view branch.
  const [navRewindNonce, setNavRewindNonce] = useState(0)
  // Tri-valued auth state: `null` = checking via /api/auth/me,
  // `false` = no session, ApiUser = logged in. The intermediate
  // null prevents flashing the login screen on reload.
  const [user, setUser] = useState<ApiUser | null | false>(null)
  const [selectedMedia, setSelectedMedia] = useState<Media | null>(null)
  // The player needs server-side identifiers (fileId, fileType,
  // episodeId) that aren't on the UI Media type. Play resolves these
  // via /api/media/{id}/files (movie) or seasons/episodes (show)
  // before constructing the target; playerLoading covers the
  // resolution window so the UI shows "Resolving…" instead of a
  // blank player.
  const [playerTarget, setPlayerTarget] = useState<PlayTarget | null>(null)
  const [playerLoading, setPlayerLoading] = useState(false)
  // Issue #177 — latest-target mirror. The auto-advance lookup (which
  // runs async between two API calls) reads this to confirm the player
  // is still parked on the episode that ended before it swaps in the
  // next one — so closing the player or picking a different episode
  // mid-lookup can't get stomped by a stale resolve.
  const playerTargetRef = useRef<PlayTarget | null>(null)
  playerTargetRef.current = playerTarget
  // Remote playback ownership, independent of whether its controls are expanded.
  // Escape / navigation must keep its source session and Stop control mounted.
  const playerRemoteActiveRef = useRef(false)

  // M10 Phase 4 — watch party state.
  // 2026-05-25 — pass user.id so the hook can scope its last-party
  // localStorage cache (lib/lastParty.ts) per signed-in user. Without
  // this, logging out and back in as a different user would surface
  // the prior user's "Recently in" pill.
  // user is tri-valued (null | false | ApiUser); narrow to id only
  // when actually logged in so the hook's cache key isn't keyed on
  // undefined-but-truthy values.
  // The hook also files that record under the profile the session acts as
  // (two profiles of one account are two people), so that state is declared
  // here, ahead of it. What it means and when it changes is said below,
  // where the rest of the profile state is.
  const [activeProfileId, setActiveProfileId] = useState<number | null>(null)
  const party = useParty(user && typeof user === 'object' ? user.id : undefined, activeProfileId)
  // Freshest party state for callbacks that close over an early render (e.g.
  // handlePlayContinue is a stable useCallback). Reading party.state directly
  // inside such a callback would capture a stale snapshot.
  const partyStateRef = useRef(party.state)
  partyStateRef.current = party.state
  // Issue #460 — set when THIS client sent the change-media that is about
  // to come back as a media-change broadcast. Two things key off it in the
  // resolver: the host's own player boots playing (so "Play for all"
  // actually plays instead of parking the room at Paused@0), and the
  // "host moved everyone" notice is suppressed for the person who did it.
  // Consumed on the first media-change that arrives, so a rejected swap
  // can't leave it armed for someone else's later change.
  const partySelfAdvanceRef = useRef(false)
  // Manual player dismissal is scoped to one party/media/role lifecycle. It
  // prevents the auto-open recovery effect from immediately recreating a
  // player the user just closed, while a new episode or promotion to host can
  // still re-arm recovery. The generation counters also cancel in-flight
  // recovery and media-change resolvers before either can resurrect it.
  const partyPlayerDismissedKeyRef = useRef<string | null>(null)
  const partyAutoOpenGenRef = useRef(0)
  const partyAutoOpenPendingGenRef = useRef<number | null>(null)
  const mediaChangeGenRef = useRef(0)
  const mediaChangePendingGenRef = useRef<number | null>(null)
  const partyPauseOnBootTokenRef = useRef(0)
  // Every ordinary (non-party) async playback resolver shares one ownership
  // token and abort controller. Close/navigation invalidates both so a late
  // files/episodes response cannot resurrect the player on another route.
  const playbackResolutionGenRef = useRef(0)
  const playbackResolutionRequestRef = useRef<AbortController | null>(null)
  const closePlayer = useCallback((dismissPendingResolution = false) => {
    const liveUserId = user && typeof user === 'object' ? user.id : null
    const liveParty = partyStateRef.current
    const liveTarget = playerTargetRef.current
    const hasPendingResolution = dismissPendingResolution && (
      partyAutoOpenPendingGenRef.current !== null ||
      mediaChangePendingGenRef.current !== null ||
      playbackResolutionRequestRef.current !== null
    )
    if (liveUserId != null) {
      const dismissedKey = partyPlayerDismissalKeyOnClose(
        liveParty,
        liveUserId,
        !!liveTarget,
        hasPendingResolution,
      )
      if (dismissedKey) partyPlayerDismissedKeyRef.current = dismissedKey
    }
    partyAutoOpenGenRef.current++
    partyAutoOpenPendingGenRef.current = null
    mediaChangeGenRef.current++
    mediaChangePendingGenRef.current = null
    playbackResolutionGenRef.current++
    playbackResolutionRequestRef.current?.abort()
    playbackResolutionRequestRef.current = null
    setPlayerLoading(false)
    setPlayerTarget(null)
  }, [user])
  const [partyPanelOpen, setPartyPanelOpen] = useState(false)
  // Whether something is over the page that a title's open must not animate
  // under: a player (minimized too: the open closes it) or a party's panel.
  // A ref, so handleSelect keeps its identity (every card holds it).
  const travelBlockedRef = useRef(false)
  useLayoutEffect(() => { travelBlockedRef.current = playerTarget !== null || playerLoading || partyPanelOpen }, [playerTarget, playerLoading, partyPanelOpen])
  // 2026-05-30 — Cinematic Overlay (Feature 2). Which face the on-screen
  // party surface shows: 'rail' (the full floating glass panel) or
  // 'minimal' (lower-third chat ticker + corner voice pill + mini dock).
  // The header dock button flips this WITHOUT closing the panel; the ×
  // still fully closes (setPartyPanelOpen(false)). Reset to 'rail' on
  // close so re-opening always starts from the readable rail.
  const [partyVariant, setPartyVariant] = useState<'rail' | 'minimal'>('rail')
  // 2026-05-30 — host "invite to party" affordance (code + QR deep link
  // for phones). Toggled from the rail header; host-only.
  const [partyInviteOpen, setPartyInviteOpen] = useState(false)
  // 2026-05-30 — reset overlay view-state when a party ends server-side
  // (host left, kicked, party-ended). The hook clears party.state.code but
  // our local 'minimal'/invite flags persist; without this the NEXT party
  // would open in stale minimal mode. Mirrors PartyPanel onClose/onLeave.
  useEffect(() => {
    if (!party.state.code) {
      partyPlayerDismissedKeyRef.current = null
      partyAutoOpenGenRef.current++
      partyAutoOpenPendingGenRef.current = null
      mediaChangeGenRef.current++
      mediaChangePendingGenRef.current = null
      setPartyVariant('rail')
      setPartyInviteOpen(false)
    }
  }, [party.state.code])
  // Phase 5 — add-to-watchlist dialog. Opened from DetailView. The
  // dialog fetches the active profile's watchlists on open + lets
  // the user pick one or create a new list inline.
  // Phase 5 — active profile (moved up so all effects below can use it).
  const [profiles, setProfiles] = useState<Profile[]>([])
  // Distinguishes "not fetched yet" from "fetched, and there are none" — the
  // empty array can't. ProfilesGate's `ready` needs the difference; passing
  // `profiles.length > 0` made `ready` a tautology, since the policy's own
  // `profileCount < 2` check already subsumes it.
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  // The profile this session acts as. The server's binding is the truth
  // (issue #462: every ceiling is enforced from it), so activeProfileId only
  // changes after the server confirms: at startup from getActiveProfile, and
  // on a switch once activateProfile resolves (switchProfile below). It used
  // to change first, with activation fire-and-forget, so a failed call left a
  // kid's UI showing the kid profile while the server enforced the parent's.
  // It starts null, and nothing personalized loads until it is known
  // (personalProfileReady below). localStorage remembers the last choice, only
  // so a new login (which binds the account default) can re-select it; it
  // used to seed activeProfileId, which fetched for the remembered profile
  // before the binding was read, and kept it for the tab's life when the
  // profile list failed to load. (`activeProfileId` itself is declared
  // above, beside the party hook that takes it.)
  // Personalized content (the hero, the personalized Home rails, Continue
  // Watching, taste onboarding) loads only once the session's profile is
  // known, or the account has no profile to know. A request sent before then
  // carries no profile_id, which the discovery routes used to answer for the
  // account default: a kid's Home showed the parent's hero pick on every
  // load. They now answer for the acting profile, and the wait still keeps
  // the app from showing content for a profile it has not confirmed. While
  // the binding is unknown, or the profile list failed to load, nothing
  // personalized loads at all.
  const personalProfileReady = activeProfileId !== null || (profilesLoaded && profiles.length === 0)
  // The startup profile load has finished, whatever it found (a binding, no
  // binding to read, or no list at all).
  const [profilesSettled, setProfilesSettled] = useState(false)
  // The catalog (Home's core rails, the browse grids) waits for the binding
  // to be read, unless it cannot be: the server filters it by the session's
  // profile, and startup can re-select a remembered profile, so a catalog
  // fetched before then is cleared by the switch reset and fetched again.
  // When the profile list fails, or the binding is unreadable and the picker
  // is up, it loads anyway, as it did before.
  const catalogProfileSettled = activeProfileId !== null || profilesSettled
  // The render that switches profile, until its resets have run: everything
  // App kept for the previous profile is still in state, and the top bar
  // already names the new one. Home, the grids, My Library and an open title
  // render their cold state meanwhile (see lib/useProfileSwitchPending).
  const profileSwitchPending = useProfileSwitchPending(activeProfileId, profilesSettled)
  // The admin pages and controls. The server refuses the admin role's powers
  // to a session acting as a restricted profile, so a kid's session on an
  // admin account sees none of them; they wait for the binding like
  // personalized content does.
  const adminUI = showsAdminUI(user ? user.role : undefined, profiles, profilesLoaded, activeProfileId)
  const actingRestricted = activeProfileId !== null && isRestrictedProfile(profiles.find(p => p.id === activeProfileId))
  // What the navigation offers this session (lib/navScope). Like adminUI it
  // follows the profile the server has bound, never a remembered one: until
  // the binding is read it is 'unknown', which offers nothing a restricted
  // profile lacks (no Together, no requests) and restyles nothing.
  const navScope = navScopeFor(profiles, profilesLoaded, activeProfileId)
  // For effects that must not re-run when it changes. Set in a layout
  // effect, so a passive effect of the same commit already reads this
  // render's value.
  const navScopeRef = useRef(navScope)
  useLayoutEffect(() => { navScopeRef.current = navScope }, [navScope])
  const rememberedProfileIdRef = useRef(readRememberedProfileId())
  useEffect(() => {
    if (!activeProfileId) return
    rememberProfileId(activeProfileId)
    rememberedProfileIdRef.current = activeProfileId
  }, [activeProfileId])

  // Phase 5.2 parity — right-click context menu state.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: MediaContextItem[]; title?: string; reason?: string; opener?: HTMLElement | null } | null>(null)

  const [addToListMedia, setAddToListMedia] = useState<Media | null>(null)
  // What had the focus as the add-to-list sheet opened: the control it is
  // handed back to when the sheet is closed from the keyboard or by one of
  // its own buttons. Read after the commit that opens the sheet, by which
  // time a card's menu has closed and returned the focus to its More button
  // (unmount effects run before this one).
  const addToListOpenerRef = useRef<{ el: HTMLElement | null; mediaId: number } | null>(null)
  useEffect(() => {
    addToListOpenerRef.current = addToListMedia
      ? { el: document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null, mediaId: addToListMedia.id }
      : null
  }, [addToListMedia])
  // Closes the sheet and puts the focus back where it came from: the
  // opener, or, when that is no longer on the page, the title's own card.
  // (The sheet's controls go with it, and the focus would fall to the page
  // body.) Not for a press on the scrim: a pointer has just said where the
  // viewer is.
  const closeAddToList = useCallback(() => {
    const from = addToListOpenerRef.current
    setAddToListMedia(null)
    if (!from) return
    const back = from.el?.isConnected
      ? from.el
      : document.querySelector<HTMLElement>(`[data-media-id="${from.mediaId}"] :is(.card-open, .mlr-main, .search-best-open)`)
    back?.focus({ preventScroll: true })
  }, [])
  // Phase 6 — Collections modal open state. Triggered by the
  // "+ New Collection" button in CollectionsView OR by future
  // global-action shortcuts (Ctrl+Shift+N).
  const [collectionsModalOpen, setCollectionsModalOpen] = useState(false)
  const [addToListLists, setAddToListLists] = useState<Watchlist[] | null>(null)
  const [addToListBusy, setAddToListBusy] = useState(false)
  useEffect(() => {
    if (!addToListMedia || !activeProfileId) { setAddToListLists(null); return }
    let cancelled = false
    listWatchlists(activeProfileId).then(ls => { if (!cancelled) setAddToListLists(ls) }).catch(() => { if (!cancelled) setAddToListLists([]) })
    return () => { cancelled = true }
  }, [addToListMedia, activeProfileId])
  const [searchQuery, setSearchQuery] = useState('')
  // A described search: the words the viewer asked to have searched by what
  // they describe (Enter in a search field, or the search page's button),
  // rather than matched against titles. The search page runs the
  // model-backed search for exactly those words; typing anything else goes
  // back to title matching, which costs no model time. It carries who asked
  // (`owner`) and is handed to the page only while that is still who the app
  // acts as, so a switch never runs one profile's description for another,
  // and `n` counts asks so the same words can be asked again.
  const [searchDescribe, setSearchDescribe] = useState<{ query: string; n: number; owner: string } | null>(null)
  // Ref to the search input so Cmd+K / Ctrl+K can move focus to it.
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchOwner = `${user ? user.id : 'none'}:${activeProfileId ?? 'none'}`
  // Typing is a new query: whatever was described before is not asked again
  // until the viewer asks.
  const changeSearchQuery = useCallback((q: string) => {
    setSearchQuery(q)
    setSearchDescribe(null)
  }, [])
  // Every ask has its own number, for the life of the page: the search page
  // keeps an ask's answer under it (lib/describedSearch), and a number used
  // twice would show an old answer for a new ask.
  const describeAsksRef = useRef(0)
  // The profile's recent searches (lib/recentSearches), read for whoever
  // the page is for now and held with that owner's stamp, so one profile's
  // list is never drawn for another on the commit a switch lands in.
  // Kept only for a known owner: a profile, or an account known to have
  // none. While the app knows no profile on an account that has profiles
  // (startup, an unreadable binding), the owner would be `<user>:none`, one
  // bucket every profile of the account would read and write in that state:
  // nothing is read from it or remembered then.
  const recentKnown = !!user && (activeProfileId != null || (profilesLoaded && profiles.length === 0))
  const recentOwner = recentKnown ? searchOwner : null
  const readRecent = (owner: string | null) => ({ owner: searchOwner, list: owner ? readRecentSearches(owner) : NO_RECENT, known: owner !== null })
  const [recentSearches, setRecentSearches] = useState<{ owner: string; list: string[]; known: boolean }>(() => readRecent(recentOwner))
  if (recentSearches.owner !== searchOwner || recentSearches.known !== recentKnown) setRecentSearches(readRecent(recentOwner))
  const noteSearch = useCallback((words: string) => {
    if (!recentOwner) return
    setRecentSearches({ owner: recentOwner, list: rememberSearch(recentOwner, words), known: true })
  }, [recentOwner])
  const clearRecentSearches = useCallback(() => {
    if (!recentOwner) return
    forgetRecentSearches(recentOwner)
    setRecentSearches({ owner: recentOwner, list: [], known: true })
  }, [recentOwner])
  // 2026-07-25 (Aurora Stage Phase 2, debug-review fix) — publish the
  // measured height of the sticky chrome stack as --chrome-h so every
  // thing placed under it (the drawers, the sticky browse and admin
  // toolbars, the identity menu, the page's scroll padding) anchors to
  // reality instead of to the nav's nominal 64px. The stack grows by one
  // row (40px, 44 on a touch screen) per library being scanned, because
  // ScanProgressBar renders in flow under the nav, and an admin mid-scan
  // was the case where all five hardcoded offsets broke.
  // Which surface the player is presenting. 'theater' is the player in the
  // window: the picture edge to edge, or, in the boxed layout on a wide
  // window, set in beside the party panel. It is the only one that changes
  // anything out here: the app behind it is dimmed and made inert.
  // Fullscreen covers the viewport and minimized gives the page back, so
  // nothing behind them needs doing.
  const [playerSurface, setPlayerSurface] = useState<'theater' | 'fullscreen' | 'minimized' | null>(null)
  // Set by the switcher's "Who's watching?" item; the gate self-gates otherwise.
  const [profilesGateForced, setProfilesGateForced] = useState(false)
  // Reported UP by the gate, which owns the policy. App needs it only to keep
  // Cmd+K from putting the focus in the search field behind the gate.
  const [profilesGateOpen, setProfilesGateOpen] = useState(false)
  // The onboarding flow covers the whole page: while it is up the page
  // behind it (<main>, the top bar included) is out of reach of the keys.
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const theaterActive = playerSurface === 'theater'
  // Whether a page a restricted session is not shown may render on THIS
  // commit (lib/navScope.mayRenderHidden): never for a restricted session,
  // not while startup has yet to say who the session is, and not while the
  // picker is up asking. The redirect runs in an effect, after the commit,
  // so each such page is guarded where it mounts as well.
  const hiddenOk = mayRenderHidden(navScope, { settled: profilesSettled, askingForProfile: profilesGateForced && activeProfileId === null })
  // The account's active watch parties, polled once for the whole app and
  // read by the nav's presence pill and the Together hub. For any session
  // that may be shown Together (hiddenOk): that is a session known to be
  // offered it, and also one whose profile could not be learned at all, which
  // is let onto the page and used to find it saying "Looking for parties…"
  // for ever, with no request out. The pill is only for the first kind (see
  // livePresence). Keyed by user and acting profile: the hook returns nothing
  // on the render that switches profile.
  const activeParties = useActiveParties({
    enabled: !!user && hiddenOk,
    ownerKey: `${user ? user.id : 'none'}:${activeProfileId ?? 'none'}`,
    // Not while the player is open (minimized counts as closed: the page is
    // back on screen then).
    paused: playerSurface === 'theater' || playerSurface === 'fullscreen',
  })

  // Stamp the surface on <html> so CSS can react to it. This is what gates the
  // watch-party surfaces' theater rules — they are rendered outside <main>,
  // so they stay live and visible during playback: the panel and the
  // reactions place themselves against the player's shell (over the picture
  // when it runs edge to edge, beside it when boxed), and the party's mini
  // dock and chat ticker take their lanes above the timeline (index.css
  // `.stage-party-*`). An
  // attribute rather than a class because three different overlays key off it
  // and `html[data-player-surface="theater"]` reads as the state it is.
  useEffect(() => {
    const el = document.documentElement
    if (!playerSurface) { el.removeAttribute('data-player-surface'); return }
    el.dataset.playerSurface = playerSurface
    return () => { el.removeAttribute('data-player-surface') }
  }, [playerSurface])

  // Scroll lock while the theater is up. The app behind is inert (D6), so a
  // wheel or a swipe must not scroll it — otherwise the backdrop drifts under a
  // stationary player, which reads as the page having come unglued.
  //
  // Via the shared ref-counted lock, not a local save/restore of
  // body.style.overflow: two other surfaces lock the same property and
  // save-prev only composes under LIFO release. See lib/scrollLock.
  useEffect(() => {
    if (!theaterActive) return
    return lockBodyScroll()
  }, [theaterActive])

  const chromeRef = useRef<HTMLDivElement | null>(null)
  // useLayoutEffect, not useEffect: this runs BEFORE paint. With useEffect an
  // admin whose scan was already running at mount painted one frame against
  // the 64px :root fallback while the real stack was ~101px, putting the
  // toolbar's chips under the scan bar before snapping into place.
  useLayoutEffect(() => {
    const el = chromeRef.current
    if (!el) return
    // Only write when the ROUNDED value actually changes. ScanProgressBar
    // polls every 4s and its live counts ("1,234 / 12,345 · 89 new") can
    // reflow the row by a pixel, which would otherwise republish --chrome-h
    // and visibly step the pinned toolbar while an admin reads the grid.
    let last = -1
    const publish = () => {
      const h = Math.round(el.getBoundingClientRect().height)
      if (h > 0 && h !== last) {
        last = h
        document.documentElement.style.setProperty('--chrome-h', `${h}px`)
      }
    }
    publish()
    // ResizeObserver rather than a resize listener: the height changes when
    // a scan STARTS or STOPS, which is not a viewport event.
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--chrome-h')
    }
    // Re-attach when the login state flips — the chrome only exists once
    // the shell renders, so the ref is null on the auth screen.
  }, [user])
  const [serverOpen, setServerOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  // QA 2026-05-25 — popovers were sticking around after route
  // changes. The Notifications + Server Status drawers are anchored
  // to the sidebar trigger, but their state lived independent of
  // `view`, so navigating away from Home left the popover floating
  // over the new page until the user manually closed it. Auto-close
  // both when `view` changes. Same effect mounts once and runs on
  // every view transition — cheap, no extra deps needed.
  // (QA BUG-012's mobile drawer state lived here; the drawer moved into
  // TopNav's menu sheet with the Aurora Stage Phase 2 nav swap, so the
  // open/close state is local to that component now.)
  // My Library — user-saved titles. The authoritative set lives server-side
  // (a per-profile default watchlist) so saves sync across every device;
  // localStorage is only an instant-paint + offline SNAPSHOT cache (full
  // Media objects keep posters/titles renderable before the server responds
  // or when it's unreachable). The reconcile effect below replaces this seed
  // with the server's set once the active profile is known. Stale entries
  // (media deleted on the server) degrade gracefully: the card still renders;
  // opening detail fetches fresh data and may 404 — handled there.
  //
  // The snapshot is kept per account and profile, and shown only once the
  // session's profile is known. One snapshot for the whole browser showed
  // whichever profile saved it last, before the binding was read, and for
  // the session when the profile list failed to load.
  const [library, setLibrary] = useState<Media[]>([])
  const libraryCacheKey = user && activeProfileId !== null ? `aurora_my_library:${user.id}:${activeProfileId}` : null
  // The key the list in `library` belongs to. The write below runs before
  // the load that follows it, so on a switch it saves the outgoing list
  // under its own key and never under the incoming one.
  const libraryOwnerRef = useRef<string | null>(null)
  // The same key for the My Library writes' owner checks, mirrored in a
  // layout effect like the session's profile and account
  // (actingProfileRef, libraryUserRef), so all three move in one phase. The
  // ref above trails to the passive load below, which it has to: the
  // snapshot save keys on it.
  const libraryWriteOwnerRef = useRef<string | null>(libraryCacheKey)
  useLayoutEffect(() => { libraryWriteOwnerRef.current = libraryCacheKey }, [libraryCacheKey])
  useEffect(() => {
    const key = libraryOwnerRef.current
    if (!key) return
    try { localStorage.setItem(key, JSON.stringify(library)) }
    catch { /* quota / private mode — non-fatal */ }
  }, [library])
  useEffect(() => {
    libraryOwnerRef.current = libraryCacheKey
    let cached: Media[] = []
    if (libraryCacheKey) {
      try {
        const raw = localStorage.getItem(libraryCacheKey)
        cached = raw ? (JSON.parse(raw) as Media[]) : []
      } catch { cached = [] }
    }
    setLibrary(cached)
    // A snapshot again: nobody has answered for this list yet.
    setLibraryServerFor(null)
  }, [libraryCacheKey])
  // The browser-wide snapshot this replaced.
  useEffect(() => {
    try { localStorage.removeItem('aurora_my_library') } catch { /* ignore */ }
  }, [])
  // False until the reconcile below has answered once for the active
  // profile (success OR failure — an offline device keeps its cache and
  // must not sit on a skeleton). LibraryView uses it to hold a grid
  // skeleton instead of the empty state on a device whose cache is empty.
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  // Whose list the server has answered with: the key of the profile whose
  // list in `library` is the server's own, filtered by that profile's limit.
  // Until then (and when the request fails) `library` is this browser's
  // snapshot, which can hold titles saved before a limit was set. Cleared
  // whenever `library` is loaded from a snapshot again (a change of key,
  // below) and on sign-out: it used to outlive both, so a profile come back
  // to, or the same user signing in again, was taken as answered for while
  // `library` held the snapshot.
  const [libraryServerFor, setLibraryServerFor] = useState<string | null>(null)
  // In-flight optimistic library toggles, by profile and media id
  // (`${profileId}:${mediaId}`) → the latest write's mark ('add' |
  // 'remove'). The reconcile below re-applies these on top of the server
  // snapshot so a save/unsave that completes DURING the fetch isn't
  // clobbered by the (older) snapshot. Each write has a mark object of its
  // own and clears only that one when it settles: by value, a removal
  // answered while a later removal of the same title waited cleared the
  // later one's mark. By profile: keyed by title alone, a Parent's removal
  // still out after a switch took the same title off the Kid's list.
  const pendingLibOpsRef = useRef<Map<string, { op: 'add' | 'remove' }>>(new Map())
  // The signed-in account, read when a queued library write's turn comes.
  const libraryUserRef = useRef<number | null>(user ? user.id : null)
  useLayoutEffect(() => { libraryUserRef.current = user ? user.id : null }, [user])
  // The server's list of a profile's library on top of what is on screen:
  // cached cards kept, that profile's in-flight writes re-applied.
  const mergeServerLibrary = useCallback((prev: Media[], items: LibraryItem[], profileId: number) => {
    const cachedById = new Map(prev.map(m => [m.id, m]))
    const pending = new Map<number, { op: 'add' | 'remove' }>()
    for (const [key, mark] of pendingLibOpsRef.current) {
      const [pid, id] = key.split(':').map(Number)
      if (pid === profileId) pending.set(id, mark)
    }
    // Server set, minus any item an in-flight unsave is removing.
    const merged = items
      .filter(it => pending.get(it.media_item_id)?.op !== 'remove')
      .map(it => cachedById.get(it.media_item_id) ?? libraryItemToMedia(it))
    // Re-add any in-flight save the snapshot predates.
    const have = new Set(merged.map(m => m.id))
    for (const [id, mark] of pending) {
      if (mark.op === 'add' && !have.has(id)) {
        const cached = cachedById.get(id)
        if (cached) merged.push(cached)
      }
    }
    return merged
  }, [])
  // Reconcile the local cache against the server's authoritative library for
  // the active profile (login, profile switch, refresh). Rich cached
  // snapshots win per id so posters/ratings survive; ids the server has that
  // the cache doesn't get a basic card from the server's lightweight item.
  useEffect(() => {
    if (!user || !activeProfileId) return
    let cancelled = false
    const ac = new AbortController()
    setLibraryLoaded(false)
    getLibrary(activeProfileId, ac.signal)
      .then(items => {
        if (cancelled) return
        setLibraryLoaded(true)
        setLibraryServerFor(`aurora_my_library:${user.id}:${activeProfileId}`)
        setLibrary(prev => mergeServerLibrary(prev, items, activeProfileId))
      })
      .catch(() => {
        // offline / transient — keep the localStorage cache, and stop
        // showing the skeleton: what is cached is what there is.
        if (!cancelled) setLibraryLoaded(true)
      })
    return () => { cancelled = true; ac.abort() }
  }, [user, activeProfileId, mergeServerLibrary])
  // Memoized ID set so MediaRail / BrowseView / LibraryView can do
  // O(1) membership checks without re-creating the Set on every
  // render. Rebuilt only when the library array reference changes.
  const libraryIds = useMemo(() => new Set(library.map(m => m.id)), [library])
  const [toasts, setToasts] = useState<Toast[]>([])

  // Monotonic counter for toast IDs. Date.now()-based IDs can collide
  // under fast double-clicks and duplicate React keys corrupt the
  // toast list.
  const toastIdCounter = useRef(0)
  // The profile each toast was said to, by its id (every toast takes one
  // here). A switch drops the toasts said to the previous profile and keeps
  // those said to the new one: a toast the switch itself causes (the bug
  // report's "closed because this tab is now on another profile") is raised
  // by an effect of the commit that names the new profile, which runs
  // before the switch's reset does. The profile is mirrored in a layout
  // effect, so it is the new one by then.
  const actingProfileRef = useRef<number | null>(activeProfileId)
  useLayoutEffect(() => { actingProfileRef.current = activeProfileId }, [activeProfileId])
  const toastOwnersRef = useRef(new Map<string, number | null>())
  const nextToastId = useCallback(() => {
    toastIdCounter.current += 1
    const id = `t${toastIdCounter.current}`
    toastOwnersRef.current.set(id, actingProfileRef.current)
    return id
  }, [])

  // Join a party from a bell row / calendar chip — in-app, not a new tab.
  const handleJoinInviteParty = useCallback(async (code: string) => {
    if (party.state.code === code) {
      setNotifOpen(false)
      setPartyPanelOpen(true)
      return
    }
    if (party.state.code && !window.confirm(`Leave your current party and join ${code}?`)) return
    if (party.state.code) party.leave()
    const r = await party.join(code)
    if (r.ok) {
      setNotifOpen(false)
      setPartyPanelOpen(true)
    } else {
      setToasts(prev => [...prev, {
        id: nextToastId(),
        message: r.error || 'Failed to join the party',
        type: 'error',
      }])
    }
  }, [party, nextToastId])

  // M10 Phase 2 — Browse views. Lists fetch lazily on first visit
  // to the tab and stay cached for the session. The null sentinel
  // doubles as the loading indicator (rendered as a skeleton grid
  // via BrowseLoadingState).
  const [moviesList, setMoviesList] = useState<Media[] | null>(null)
  const [showsList, setShowsList] = useState<Media[] | null>(null)
  // Real server-side catalog total for the "Showing N of M" header.
  // /api/media caps per_page at 100, so without this the header
  // would read "100 titles" on a multi-thousand-item library.
  const [moviesTotal, setMoviesTotal] = useState<number | null>(null)
  const [showsTotal, setShowsTotal] = useState<number | null>(null)
  // Sort lives here (not in BrowseView) because changing sort
  // triggers a re-fetch from page 1, and the parent owns the cache.
  type MediaSort = 'rating' | 'title' | 'year' | 'recent'
  const [moviesSort, setMoviesSort] = useState<MediaSort>(DEFAULT_BROWSE_SORT)
  const [showsSort, setShowsSort] = useState<MediaSort>(DEFAULT_BROWSE_SORT)
  // Genre filter — QA BUG-003 fix. Previously this lived inside
  // BrowseView, but changing Sort sets moviesList=null which
  // unmounts BrowseView and resets its local state. Lifting to
  // the parent keeps the user's genre selection across sort
  // changes (and across the loading-skeleton intermediate state).
  const [moviesGenre, setMoviesGenre] = useState('')
  const [showsGenre, setShowsGenre] = useState('')
  // The library's genres, from /api/media/genres: asked for once per grid,
  // so the list does not shift as pages load. Null while in flight (no
  // genre control is drawn yet). When that request FAILS the control is
  // drawn from the genres of the titles the grid holds (lib/browseLayout
  // fallbackGenres), as the old toolbar did: fewer genres than the library
  // has, which is better than no way to filter at all.
  const [moviesGenres, setMoviesGenres] = useState<string[] | null>(null)
  const [showsGenres, setShowsGenres] = useState<string[] | null>(null)
  const [genresFailed, setGenresFailed] = useState<{ movie: boolean; show: boolean }>({ movie: false, show: false })
  // How the Library's grids are laid out: the viewer's choice, or null for
  // "by library size" (lib/browseLayout). One choice for both grids.
  const [browseLayout, setBrowseLayout] = useState<BrowseLayout | null>(readBrowseLayout)
  // The element in the Library header's row that a scope's own controls are
  // drawn into (My Library's kind, Upcoming's List or Month).
  const [libraryToolsEl, setLibraryToolsEl] = useState<HTMLElement | null>(null)
  const changeBrowseLayout = useCallback((layout: BrowseLayout) => {
    setBrowseLayout(layout)
    writeBrowseLayout(layout)
  }, [])
  const moviesLayout = useGridLayout(browseLayout, moviesTotal, moviesGenre)
  const showsLayout = useGridLayout(browseLayout, showsTotal, showsGenre)
  const [moviesLoadingMore, setMoviesLoadingMore] = useState(false)
  const [showsLoadingMore, setShowsLoadingMore] = useState(false)
  // Track next-page-to-fetch in state rather than deriving from
  // list.length: if catalog items are deleted between fetches the
  // server returns a short page, the length math misaligns, and the
  // next click re-fetches the same page (duplicate items + key
  // warnings). Trust the server's returned page number instead.
  const [moviesNextPage, setMoviesNextPage] = useState(1)
  const [showsNextPage, setShowsNextPage] = useState(1)
  // AbortController refs let handleSortChange + handleLoadMore
  // coordinate cancellation across renders so a sort change can
  // cancel an in-flight Load More (which would otherwise append a
  // stale-sort response onto the new list).
  const moviesLoadMoreAcRef = useRef<AbortController | null>(null)
  const showsLoadMoreAcRef = useRef<AbortController | null>(null)
  // The catalog version (useCatalogVersion) each grid's list was loaded or
  // last refreshed at. Behind the current version means a scan has added
  // titles since; the grid refetches in place when it is next on screen.
  const moviesCatalogVersionRef = useRef(0)
  const showsCatalogVersionRef = useRef(0)
  // Per-page size constant. Server caps at 100; we ride at the cap
  // to minimize round-trips. Centralized so Load More can compute
  // `nextPage` consistently with the initial fetch.
  const BROWSE_PER_PAGE = 100

  // On card click we set selectedMedia (lightweight, immediate) and
  // also fetch the full detail + episodes in the background.
  const [detailItem, setDetailItem] = useState<MediaDetail | null>(null)
  const [detailEpisodes, setDetailEpisodes] = useState<ApiEpisode[]>([])
  const [detailFiles, setDetailFiles] = useState<MediaFile[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  // M10 Phase 4.5 — multi-season support.
  const [detailSeasons, setDetailSeasons] = useState<{ season_number: number; episode_count?: number }[]>([])
  const [detailSelectedSeason, setDetailSelectedSeason] = useState<number | null>(null)
  // Continue Watching rail data. Kept as ContinueWatchingItem (not
  // mapped to UIMedia) because handlePlay needs position_ms to
  // seed resume.
  const [continueItems, setContinueItems] = useState<ContinueWatchingItem[]>([])
  // Whose Continue Watching has been answered (or has failed): the user and
  // profile it was asked for. Tonight's hero waits for it, because the title
  // to resume leads the hero: shown before the answer, the hero put up one
  // of Aurora's picks and then swapped it for that title a moment later.
  const [continueFor, setContinueFor] = useState<string | null>(null)
  // That wait has a limit (HERO_LEAD_WAIT_MS): for whom it ran out. A
  // request that never answers (a stalled proxy, a slow query on that one
  // route) must not leave the hero a skeleton while the picks and rails are
  // up. The ref is the same fact, for the request's own callback.
  const [leadWaitOverFor, setLeadWaitOverFor] = useState<string | null>(null)
  const leadWaitOverForRef = useRef<string | null>(null)
  // The viewer has done something in the hero (put the pointer or focus in
  // it, chosen a pick, paused the rotation), and for whom. A title to resume
  // that turns up after the wait ran out does not take the hero from under
  // them: it is the first card of Continue Watching.
  const heroTouchedForRef = useRef<string | null>(null)
  // Whose hero it is now (the user and profile), for handlers.
  const heroOwnerRef = useRef<string | null>(null)
  // Both facts are one visit's, forgotten wherever Continue Watching's own
  // answer is (a sign-out, a profile switch). Kept, a return to the same
  // user and profile found the wait already over: the hero put up a pick
  // with Continue Watching still out, and the title to resume then took the
  // hero over, also from under a viewer already in it. And a mark left from
  // the earlier visit kept that title out of an untouched hero.
  const forgetHeroLeadWait = useCallback(() => {
    leadWaitOverForRef.current = null
    heroTouchedForRef.current = null
    setLeadWaitOverFor(null)
  }, [])
  // Ref mirror for effects that need the CURRENT list without re-running
  // when the CW poll refreshes it (e.g. the detail fetch's season seed).
  //
  // Mirrored in a LAYOUT effect, in the same commit that draws from the list.
  // A card's Play reads the record through this ref at click time
  // (playOrResume) while its label ("Resume …") is drawn from the state. In
  // a passive effect the ref lagged the commit, so a press that landed in
  // between found a button saying Resume and no record: the title played
  // from the start, and playing from the start overwrites the saved
  // position. Too short a gap for a hand, but a test pressing the button
  // the moment it appeared hit it under load.
  const continueItemsRef = useRef(continueItems)
  useLayoutEffect(() => { continueItemsRef.current = continueItems }, [continueItems])
  // 2026-05-27 — Bug-report config. Holds the full server response so
  // the "Report a bug" entries and the dialog can both gate on `enabled`
  // AND surface admin-only token-health diagnostics (added 2026-05-27 PAT
  // health check). The entries are offered only when `enabled` is true.
  const [bugReportConfig, setBugReportConfig] = useState<BugReportConfig | null>(null)
  // M10 Phase 4.5 — Requests view real data.
  const [requestsList, setRequestsList] = useState<MediaRequest[] | null>(null)
  // Per-user notification feed (bell + panel). Seeded on login, kept live by the
  // 'notification' WS event; unreadCount drives the sidebar bell badge.
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  // Set the moment a mark-all-read is issued (panel open); reset at the top
  // of the seed effect below on every seed (login, session-expiry relogin,
  // an admin's profile or admin powers changing). Guards the seed fetch against a race where its
  // GET was already in flight when the user marked everything read: without
  // this, the GET's now-stale `unread` count lands afterward and Math.max
  // slams the badge back up even though the server (and local state) has
  // already zeroed it. See issue #474.
  const markedAllReadRef = useRef(false)
  // True once the seed GET below has resolved at least once for the current
  // session — lets onMarkAllRead skip the mark-all-read POST when it KNOWS
  // unreadCount is trustworthy and already zero, without reintroducing the
  // stale-unreadCount race the guard above exists to prevent (unreadCount
  // reads 0 before the seed resolves too, for the unrelated reason that
  // nothing has loaded yet).
  const seedResolvedRef = useRef(false)

  // Load profiles once the user is logged in, and take the active profile
  // from the server's session binding rather than the remembered one.
  useEffect(() => {
    if (!user) { setProfiles([]); setProfilesLoaded(false); setProfilesSettled(false); setActiveProfileId(null); return }
    const ac = new AbortController()
    void loadStartupProfiles({
      list: () => listProfiles(ac.signal),
      read: () => getActiveProfile(ac.signal),
      activate: id => activateProfile(id),
      remembered: rememberedProfileIdRef.current,
      signal: ac.signal,
    }).then(result => {
      if (ac.signal.aborted) return
      setProfilesSettled(true)
      // No list: profile features just stay disabled.
      if (!result) return
      setProfiles(result.profiles)
      setActiveProfileId(result.activeId)
      setProfilesLoaded(true)
      // The binding could not be read: ask rather than guess. The pick binds
      // the session.
      if (result.askForProfile) setProfilesGateForced(true)
    }).catch(() => { if (!ac.signal.aborted) setProfilesSettled(true) })
    return () => ac.abort()
  }, [user])
  // `null` rails = not yet fetched. Empty arrays inside rails are
  // filtered out by HomeView so a fresh install with no media
  // doesn't render ghost rails.
  // The catalog's stand-in hero (its newest title): what the hero is when
  // Tonight's slate (below) has no entry to show. Never one of the picks: it
  // used to hold the pick last put up as well, and when the pool then emptied
  // that pick stayed up under the stand-in's "Recently added".
  const [homeHero, setHomeHero] = useState<Media | null>(null)
  // Phase 5.3 — personalized hero pool. Server returns 4-8 picks
  // with reason blurbs; client rotates every 9s with crossfade.
  // Falls back to listRecent[0] when /api/me/hero 503s (no LLM).
  const [heroPool, setHeroPool] = useState<HeroPick[]>([])
  const [heroIndex, setHeroIndex] = useState(0)
  // Mirror heroIndex into a ref so the 9s auto-rotation and the manual
  // "Not tonight" skip share one source of truth (the interval can't list
  // heroIndex as a dep without re-creating every tick). Synced on every
  // heroIndex change below.
  const heroIndexRef = useRef(0)
  // Bumped on a manual "Not tonight" skip so the rotation effect re-runs
  // and restarts the 9s dwell from the newly-chosen pick. Without hover-
  // pause (i.e. touch / keyboard) the next auto-tick would otherwise cut
  // the chosen pick short.
  const [rotEpoch, setRotEpoch] = useState(0)
  const [heroPaused, setHeroPaused] = useState(false)
  // Tonight's slate (lib/tonightSlate): the title to resume leads, Aurora's
  // picks follow. `heroOnLead` says the hero is showing that lead; once the
  // viewer (or the rotation) moves off it, heroIndex says which pick. It
  // starts true and goes back to true for each new session and profile, so
  // each opens on its own unfinished title.
  const [heroOnLead, setHeroOnLead] = useState(true)
  // The viewer's own pause of the rotation, kept across visits: someone who
  // stops it does not want it running again tomorrow. (heroPaused, above, is
  // the momentary hold while the pointer or focus is in the hero.)
  const [heroHold, setHeroHold] = useState(() => readPrefsSnapshot().tonight_rotation === 'paused')
  const toggleHeroHold = useCallback(() => {
    heroTouchedForRef.current = heroOwnerRef.current
    const paused = !heroHold
    setHeroHold(paused)
    writePrefKey('tonight_rotation', paused ? 'paused' : 'running')
  }, [heroHold])
  // "Recently" is judged against when this tab opened: a title does not stop
  // leading because the page was left open past its window.
  const [heroNow] = useState(() => Date.now())
  // Personalization status from /api/me/hero. When `coldStart` is true,
  // we're below the watch-history threshold and Hero is serving the
  // popular-unwatched fallback with no LLM blurbs — drives a UI hint
  // explaining why nothing's curated yet.
  const [heroPersonalization, setHeroPersonalization] = useState<HeroPersonalization | null>(null)
  const [heroSlateToken, setHeroSlateToken] = useState<string | undefined>()
  // Ref to read latest heroPool from the home-rails effect without
  // adding it to deps (which would re-fetch rails on every rotate).
  const heroPoolRef = useRef<HeroPick[]>([])
  // Counts hero pool requests; only the latest one's answer lands.
  const heroLoadRef = useRef(0)
  // Throttle the "no file available" toast (episode_id → last-shown
  // ms). 2s cooldown dedupes accidental double-clicks while still
  // letting a genuine later click re-fire.
  const unavailableToastRef = useRef<Map<number, number>>(new Map())
  const [homeRails, setHomeRails] = useState<HomeViewProps['rails']>(undefined)
  // Titles taken off Home this session for the profile on screen (a 👎, an
  // admin delete). Home recomposes its rails from buffers on every refresh,
  // so these are filtered there too, or a refresh would put the card back.
  // Replaced (not cleared) when the rails' owner (user or profile) changes,
  // so a 👎 answered after a switch, which adds to the set it was clicked
  // under, cannot hide the title from the next profile's Home.
  const removedFromHomeRef = useRef<Set<number>>(new Set())
  // The hero on screen, for the live catalog refresh, which sets a catalog
  // fallback hero only when there is none.
  const homeHeroRef = useRef<Media | null>(null)
  useEffect(() => { homeHeroRef.current = homeHero }, [homeHero])
  const [homeLoading, setHomeLoading] = useState(false)
  const [homeError, setHomeError] = useState<string | null>(null)
  // 2026-06-05 (Home net-new #1) — real total library size for the greeting's
  // "picked from X titles" clause. Fetched count-only (see its effect) via a
  // per_page=1 /api/media call (no type filter → counts movies+shows
  // together). null until it lands / on error, so the greeting omits the
  // clause rather than fabricating a number. The browse-tab counts
  // (moviesTotal+showsTotal) remain a fallback (see the libraryTotal prop).
  // The server counts what the session's profile may see, so the count is
  // kept with the user and profile it was asked for (homeLibraryKey) and
  // shown only while the app acts as that profile.
  const [homeLibraryCount, setHomeLibraryCount] = useState<{ key: string; total: number } | null>(null)

  const navigate = useNavigate()
  // Someone signed in: a TV's code carried through a provider's round trip
  // goes back into the address, and a viewer who had followed "Connect a TV
  // with a code" is taken to that page (lib/devicePairing). Both are read
  // once and forgotten.
  useEffect(() => {
    if (!user) return
    const code = consumeDevicePairing()
    const wanted = consumeDeviceIntent()
    if (code) navigate(`/device?code=${encodeURIComponent(code)}`, { replace: true })
    else if (wanted) navigate('/device', { replace: true })
  }, [user, navigate])
  const location = useLocation()
  const previousPathnameRef = useRef(location.pathname)
  // The address the effect below last acted on (null before its first run).
  const syncedPathnameRef = useRef<string | null>(null)

  // QA BUG-001 — sync URL → view on mount and on every pathname
  // change (browser back/forward, bookmarks, direct loads). Without
  // this, `view = useState('home')` always wins on cold load even
  // if the URL says `/v2/calendar`. The setView call is idempotent;
  // when in-app handleNavigate triggers a pathname change, this
  // effect just confirms the same view we already set.
  useEffect(() => {
    // Only a new address is acted on. The effect also runs when closePlayer
    // changes, which it does during startup; a run then, between a press
    // that had set the view ahead of its address (the first key typed into
    // the bar sets 'search' and then navigates) and that address's commit,
    // read the old address as a Back out of the search page: the view went
    // back and the words just typed were cleared.
    if (syncedPathnameRef.current === location.pathname) return
    syncedPathnameRef.current = location.pathname
    const previousPathname = previousPathnameRef.current
    previousPathnameRef.current = location.pathname
    const target = pathToView(location.pathname)
    // The one change of address that is not a navigation away from what is
    // playing: the search page taking its address as its viewer types
    // (showSearchPage).
    const typedIntoSearch = enteringSearchRef.current && target === 'search'
    enteringSearchRef.current = false
    if (!typedIntoSearch && shouldClosePlayerOnPathChange(
      previousPathname,
      location.pathname,
      playerRemoteActiveRef.current,
    )) {
      // Covers browser Back/Forward and direct router navigation. Passing true
      // also dismisses a party lifecycle whose async resolver has not produced
      // a player target yet.
      closePlayer(true)
    }
    if (target !== view) {
      setView(target)
      // Back (or Forward) out of the search page to anything but a title:
      // the words in the bar were for the results, and go with them. A
      // title keeps them, so Back from it is the results again. (In-app
      // navigation has set `view` already and does its own clearing.)
      if (view === 'search' && target !== 'detail') {
        setSearchQuery('')
        setSearchDescribe(null)
      }
    }
    // Leaving a /title/:id URL (browser Back, sidebar nav, history
    // traversal) is the moment the detail selection stops being current.
    // Clearing here — after the URL actually changed — instead of inside
    // handleBack avoids a blank-detail flash between the click and the
    // popstate landing. Idempotent for every non-detail navigation.
    if (target !== 'detail') {
      setSelectedMedia(null)
    }
    // Intentionally NOT including `view` in deps — we only want
    // this to fire on URL changes. Including view would cause it
    // to reconcile back to the URL after any setView('detail')
    // call (which IS desired sometimes, but we have explicit
    // navigation back from detail via handleBack).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, closePlayer])

  // Restore (or reset) the scroll offset once the URL's view is the one on
  // screen. Keyed on `view` as well as the history key on purpose: on
  // popstate the location changes one render BEFORE the URL-sync effect
  // above flips `view`, and restoring while the outgoing view is still
  // mounted is exactly the clamp-to-the-wrong-document failure native
  // restoration has. useLayoutEffect so the jump happens before paint.
  const restoredKeyRef = useRef<string | null>(null)
  const prevViewRef = useRef(view)
  useLayoutEffect(() => {
    const viewChanged = prevViewRef.current !== view
    prevViewRef.current = view
    if (view !== pathToView(location.pathname)) return
    if (restoredKeyRef.current === location.key) return
    restoredKeyRef.current = location.key
    const saved = scrollMemory.get(location.key)
    if (saved === undefined) {
      // A page entered fresh starts at the top. A key change that kept the
      // same view (a replace navigation, query-string sync) leaves the
      // viewport where it is.
      if (viewChanged) window.scrollTo(0, 0)
      return
    }
    // The destination's data lives in App state, so its full height is
    // normally in this very commit — but a lazy view's chunk or a refetch
    // can leave the document short for a frame or two. Retry briefly
    // rather than clamp.
    let raf = 0
    let attempts = 0
    const tryRestore = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      if (max >= saved || attempts >= 8) { window.scrollTo(0, saved); return }
      attempts++
      raf = requestAnimationFrame(tryRestore)
    }
    tryRestore()
    return () => cancelAnimationFrame(raf)
  }, [location.key, location.pathname, view])


  // security — bounce a non-admin who lands on /admin (typed URL,
  // bookmark, stale link) back home. Pairs with the role gate on the
  // AdminView mount below; the sidebar link is already admin-only.
  // We wait until `user` is a resolved ApiUser so we don't redirect
  // during the boot/loading window (user === null) — once revalidated,
  // a non-admin gets kicked to home. Uses the same role signal as the link.
  // A session known to act as a restricted profile leaves too (a switch to
  // the kid's profile while on /admin); one whose binding is still unknown
  // waits, or every reload of /admin would land on Home.
  useEffect(() => {
    if (user && (user.role !== 'admin' || (actingRestricted && !adminUI)) && pathToView(location.pathname) === 'admin') {
      navigate('/')
    }
  }, [user, actingRestricted, adminUI, location.pathname, navigate])
  // A session KNOWN to act as a restricted profile sees Tonight, Movies and
  // Shows: opening Together, requests, a member page, the profile page,
  // Collections, My Library or Upcoming by URL lands on Tonight, and so does
  // switching into such a profile while on one. Presentation only (the
  // server enforces the limit), and only once the profile is known:
  // 'unknown' redirects nothing, or a parent's deep link would bounce home
  // during startup. The pages themselves are also kept from rendering
  // (hiddenOk, below): this effect runs after the commit.
  useEffect(() => {
    if (user && navScope === 'restricted' && hiddenFromRestricted(pathToView(location.pathname))) {
      navigate('/', { replace: true })
    }
  }, [user, navScope, location.pathname, navigate])

  // Returns the toast's id, for a caller that may have to take it back.
  const addToast = useCallback((message: string, type: Toast['type'] = 'info', action?: Toast['action']) => {
    const id = nextToastId()
    setToasts(prev => [...prev, { id, message, type, action }])
    return id
  }, [nextToastId])

  const removeToast = useCallback((id: string) => {
    toastOwnersRef.current.delete(id)
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  // Profile switching goes through the server, and a locked profile asks for
  // its PIN first; see lib/useProfileSwitch.
  const onSwitchRefused = useCallback((p: Profile) => addToast(`Couldn't switch to ${p.name}`, 'error'), [addToast])
  // What this tab shows is what the server enforces, including after a
  // switch in another tab (they share one session) or a switch whose answer
  // was lost.
  const readSessionBinding = useCallback(() => getActiveProfile(), [])
  // The server's record of a profile replaces the list's copy of it.
  const storeBoundProfile = useCallback((p: Profile) => {
    setProfiles(ps => (ps.some(x => x.id === p.id) ? ps.map(x => (x.id === p.id ? { ...x, ...p } : x)) : [...ps, p]))
  }, [])
  const profileSwitch = useProfileSwitch({
    profiles, activeProfileId, setActiveProfileId, onError: onSwitchRefused, readBinding: readSessionBinding,
    onBound: storeBoundProfile,
  })
  const { pinTarget, switchProfile, unlock: unlockProfile, cancelPin } = profileSwitch
  // Stable (they read refs): whether a switch is out, and how many have
  // started. Live catalog refreshes drop an answer when a switch has started
  // since it was asked: the server may have answered it for a profile other
  // than the one still named.
  const { isSwitching: isProfileSwitching, switchGeneration: profileSwitchGeneration } = profileSwitch

  // A switch through the UI, counted when it ends, however it ends (done,
  // refused, its PIN prompt cancelled): the promise switchProfile returns
  // settles then. What was held back for the switch (an invitations request)
  // is asked for when the count changes, which is the only signal there is
  // when the switch ends on the profile already shown.
  const [switchesEnded, setSwitchesEnded] = useState(0)
  const switchProfileWatched = useCallback(async (id: number) => {
    try {
      return await switchProfile(id)
    } finally {
      setSwitchesEnded(n => n + 1)
    }
  }, [switchProfile])
  const switchWatch = useMemo(
    () => ({ isSwitching: isProfileSwitching, generation: profileSwitchGeneration, ended: switchesEnded }),
    [isProfileSwitching, profileSwitchGeneration, switchesEnded],
  )

  // Invites feature — the caller's open party invites (bell RSVP rows +
  // Calendar chips). null = never loaded. Refreshed when the bell opens
  // and when a live party notification arrives; RSVP flips optimistically.
  // Declared before useRealtime, whose onNotification references
  // refreshMyPartyInvites, and after the profile switch, which it watches.
  // The list belongs to the user and acting profile it was asked for
  // (usePartyInvites): it is null for anyone else, so a sign-out, an expired
  // session or a profile switch never shows one session's invitations to the
  // next, and a late answer for the previous one is dropped.
  const {
    invites: myPartyInvites, refresh: refreshMyPartyInvites, patch: patchMyPartyInvites,
  } = usePartyInvites(user ? `${user.id}:${activeProfileId ?? 'none'}` : null, switchWatch)
  useEffect(() => {
    if (notifOpen) refreshMyPartyInvites()
  }, [notifOpen, refreshMyPartyInvites])
  // Tonight's live strip shows the invitations nobody has answered, so they
  // are also read when Home shows (they used to be read only when the bell
  // opened): for a session offered Together, once its profile is known.
  const invitesWanted = !!user && view === 'home' && navScope === 'full'
  useEffect(() => {
    if (invitesWanted) refreshMyPartyInvites()
  }, [invitesWanted, refreshMyPartyInvites])

  const handleInviteRsvp = useCallback((inviteId: number, rsvp: 'going' | 'maybe' | 'declined') => {
    // Optimistic flip; refetch on BOTH outcomes so a feed refresh that was
    // already in flight when the user clicked can't leave a stale pressed
    // state (2026-08 review) — the follow-up fetch converges on the
    // server's answer.
    patchMyPartyInvites(list => list.map(i => (i.invite_id === inviteId ? { ...i, rsvp } : i)))
    rsvpPartyInvite(inviteId, rsvp)
      .then(() => refreshMyPartyInvites())
      .catch(err => {
        refreshMyPartyInvites()
        setToasts(prev => [...prev, {
          id: nextToastId(),
          message: err instanceof Error ? err.message : 'Failed to save RSVP',
          type: 'error',
        }])
      })
  }, [refreshMyPartyInvites, patchMyPartyInvites, nextToastId])


  const reloadProfiles = useCallback(() => listProfiles(), [])
  useSessionProfileOnVisible({
    // Not until the startup load settles: its re-selection is not a switch
    // the re-read's guards can see, so an answer read before it could land
    // after it.
    enabled: !!user && profilesSettled, profiles, read: readSessionBinding, setActiveProfileId, switching: profileSwitch,
    reloadProfiles, setProfiles,
  })

  // Hydrate a /title/:id deep link (cold load, refresh, forward-button,
  // shared link). In-app opens set selectedMedia synchronously in
  // handleSelect before pushing the URL, so this no-ops for them — the
  // ids already match. Waits for `user` so the fetch runs authenticated.
  // Placed after addToast so its declaration precedes this reference.
  useEffect(() => {
    const id = titleIdFromPath(location.pathname)
    // Waits for the session's binding too, like the catalog: the server gates
    // a title by the session's profile, so one fetched before startup
    // re-selected a profile was fetched under the wrong one.
    if (id === null || !user || !catalogProfileSettled) return
    if (selectedMedia && selectedMedia.id === id) return
    let cancelled = false
    ;(async () => {
      try {
        const detail = await getMedia(id)
        if (!cancelled) setSelectedMedia(mapMedia(detail))
      } catch {
        if (cancelled) return
        addToast('Title not found', 'error')
        navigate('/', { replace: true })
      }
    })()
    return () => { cancelled = true }
  }, [location.pathname, user, selectedMedia, addToast, navigate, catalogProfileSettled])

  // Live catalog updates (lib/catalogUpdates.ts): library_update events from
  // the socket below become one version number. Home's catalog rails and
  // library count, the Movies and Shows grids and the admin dashboard each
  // refetch when on screen and behind it, and catch up when next shown
  // otherwise. Held while the player is open (not minimized): the page behind
  // a film has no reader.
  const { catalogVersion, catalogVersionRef, notifyCatalogChanged } = useCatalogVersion({
    held: playerTarget !== null && playerSurface !== 'minimized',
  })

  // App-wide realtime hub: live request-status patches + push notifications.
  // One socket for the whole session, enabled only while logged in.
  const realtimeUserId = user && typeof user === 'object' ? user.id : null
  // The server shows a session the admin alerts (a member's new request, scan
  // results) in the notification feed and sends it them, and the admin-only
  // events, over the socket only while it has the admin powers, which a
  // session acting as a restricted profile does not. So an admin's socket and
  // feed wait until the startup profile load settles (catalogProfileSettled)
  // and are reopened and re-read whenever the profile or its admin powers
  // change: a new sign-in binds the default before the startup re-selection
  // moves it, so a socket opened or a feed read then gave a kid's session the
  // parent's. A ceiling given to, or lifted from, the session's own profile
  // changes them too. Anyone else's cannot change, so neither waits nor
  // reopens.
  const realtimeReady = realtimeUserId != null && ((!!user && user.role !== 'admin') || catalogProfileSettled)
  const realtimeKey = user && user.role === 'admin' ? `${activeProfileId}:${adminUI}` : 'user'

  // Boot-time push re-POST (see docs/push.md): once per
  // signed-in session, re-report this device's live subscription so
  // last_seen_at stays fresh and a push-service key rotation heals. Reads
  // state only — never prompts, never subscribes.
  useEffect(() => {
    if (realtimeUserId == null) return
    void bootResyncPush({
      supported: pushSupported(window),
      permission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
      ready: () => navigator.serviceWorker.ready,
    })
  }, [realtimeUserId])
  useRealtime({
    // The server fixes the socket's role when it connects (see realtimeKey).
    enabled: realtimeReady,
    connectionKey: realtimeKey,
    onRequestStatus: (ev) => {
      // Patch the matching row's status in place — NEVER insert. The create
      // flow already optimistically prepends the new row, and the failure
      // path may carry an error_message; dedupe strictly by request id.
      setRequestsList(prev =>
        prev
          ? prev.map(r =>
              r.id === ev.request_id
                ? { ...r, status: ev.status, ...(ev.error_message ? { error_message: ev.error_message } : {}) }
                : r,
            )
          : prev,
      )
    },
    onNotification: (n) => {
      // Prepend (dedupe by id in case a reconnect replays), bump the badge, and
      // surface a transient toast.
      setNotifications(prev => (prev.some(x => x.id === n.id) ? prev : [n, ...prev]))
      setUnreadCount(c => c + 1)
      addToast(
        notifLine(n) + (n.type === 'party_reel_ready' ? ' — see Notifications' : ''),
        n.type === 'request_failed' ? 'error' : 'success',
      )
      // Party notifications reference the invites feed (RSVP state, times)
      // — refresh it so the bell row is actionable the moment it opens.
      if (n.type === 'party_invite' || n.type === 'party_reminder' || n.type === 'party_rsvp') {
        refreshMyPartyInvites()
      }
    },
    onDiscoverReady: (ev) => {
      // The LLM finished building this profile's Discover rails. Re-fetch the
      // now-warm endpoint and splice them in live — no page refresh. Ignore
      // events for a non-active profile (stale tab, profile switched away).
      if (ev.profile_id === activeProfileId) void refetchDiscover(activeProfileId)
    },
    // A scan added titles (mid-scan or at its end). Every socket gets these,
    // so this is how a non-admin sees new titles without a reload.
    onLibraryUpdate: () => notifyCatalogChanged(),
    // Events sent while the socket was down (a deploy restarting the server)
    // are not replayed; one refresh catches up on whatever they said.
    onReconnect: () => notifyCatalogChanged(),
  })

  // Seed the notification feed + unread badge on login, and for an admin again
  // whenever the socket reopens for a new profile or admin powers
  // (realtimeKey), dropping what was read for the previous one: the server
  // leaves the admin alerts out for a session without the admin powers. The
  // WS keeps it live thereafter; resetUserState clears it on explicit logout.
  //
  // markedAllReadRef is reset HERE, not only in resetUserState, because
  // session expiry (SESSION_EXPIRED_EVENT below) drops to the auth screen
  // via a bare setUser(false) — it does not call resetUserState, and the
  // subsequent re-login calls setUser(u) directly too. Without this reset,
  // a mark-all-read from the PRIOR session would permanently pin the badge
  // to its last value across that relogin, discarding every real unread
  // count the new session's seed fetch reports.
  useNotificationSeed({
    enabled: realtimeReady,
    sessionKey: `${realtimeUserId}:${realtimeKey}`,
    load: listNotifications,
    onReset: () => {
      markedAllReadRef.current = false
      seedResolvedRef.current = false
      // When realtimeKey changed, the socket reopened in this same commit and
      // has delivered nothing yet, so this drops only the previous profile's
      // feed.
      setNotifications([])
      setUnreadCount(0)
    },
    onLoaded: res => {
      seedResolvedRef.current = true
      // Merge, don't overwrite. The WS opens on the same render, so a live
      // 'notification' may have already been prepended by onNotification
      // before this GET resolves. Union by id (newest-first) so that live
      // arrival isn't clobbered, and never let the snapshot's unread count
      // drop below what live events already bumped it to.
      setNotifications(prev => {
        if (prev.length === 0) return res.notifications
        const seen = new Set<number>()
        const merged: AppNotification[] = []
        for (const n of [...prev, ...res.notifications]) {
          if (seen.has(n.id)) continue
          seen.add(n.id)
          merged.push(n)
        }
        merged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        return merged
      })
      // Once a mark-all-read has fired, this GET (issued before that POST
      // landed) reflects a stale unread count — trust local state instead
      // of resurrecting a badge the user already cleared.
      setUnreadCount(prev => (markedAllReadRef.current ? prev : Math.max(res.unread, prev)))
    },
  })

  // Mirror unreadCount onto the OS/PWA app icon badge (Dock, taskbar,
  // Android launcher) — see lib/pwa.ts:syncAppBadge for why this is
  // needed on top of the push payload's own badge write in sw.js.
  //
  // Forced to 0 whenever realtimeUserId is null (logged out, including
  // session expiry — which unmounts the authed subtree via a bare
  // setUser(false) rather than resetUserState, leaving unreadCount's last
  // value sitting around): without this, an OS-level badge would keep
  // showing a signed-out user's stale unread count at the login screen.
  useEffect(() => {
    syncAppBadge(realtimeUserId == null ? 0 : unreadCount)
  }, [unreadCount, realtimeUserId])

  // The Library destination opens the scope last looked at in this tab
  // (Movies the first time). Only a scope the session is offered is used.
  const lastLibraryScopeRef = useRef('movies')
  useEffect(() => {
    if (isLibraryView(view)) lastLibraryScopeRef.current = view
  }, [view])
  // The search page's own field (phones) takes focus only when the Search
  // tab was just pressed. Not on every mount: coming Back to the page from
  // a title would reopen the keyboard over the results.
  const searchFieldFocusRef = useRef(false)
  const [searchFocusNonce, setSearchFocusNonce] = useState(0)
  const takeSearchFieldFocus = useCallback(() => {
    const wanted = searchFieldFocusRef.current
    searchFieldFocusRef.current = false
    return wanted
  }, [])
  // A press that never reached the field (the page did not mount: the bar's
  // own field took the query, or the session left) must not be answered by
  // a later mount, such as coming Back from a title.
  useEffect(() => {
    if (view !== 'search') searchFieldFocusRef.current = false
  }, [view])
  // `keepSearch`: the search page itself is sending the viewer on (to a
  // collection it listed, to My requests), so the words stay, and Back
  // returns to the results they were for. Any other navigation drops them.
  const handleNavigate = useCallback((dest: string, { keepSearch = false }: { keepSearch?: boolean } = {}) => {
    // A title's open still waiting for the browser's next frame is not made
    // over the place the viewer has gone to since (lib/posterTravel).
    dropWaitingOpen()
    if (dest === 'search') {
      searchFieldFocusRef.current = true
      setSearchFocusNonce(n => n + 1)
    }
    let v = dest
    // The Library DESTINATION, whose id is no view's: 'library' itself is
    // the My Library scope and navigates there like any other view.
    if (dest === LIBRARY_DESTINATION) {
      const offered = libraryScopesFor(navScope).map(sc => sc.id as string)
      // Already somewhere in Library: the destination is "reset this page".
      v = isLibraryView(view) ? view : offered.includes(lastLibraryScopeRef.current) ? lastLibraryScopeRef.current : 'movies'
    }
    // QA 2026-05-25 — clicking the *current* view's nav item should
    // act as "reset to list" for views with internal drill-down
    // state. Bump a per-view nonce so child components can listen
    // and clear their selection (e.g. CollectionsView popping back
    // from a collection detail to the index). Other views ignore
    // the nonce and the click is a no-op as before.
    //
    // The nonce only fires from in-app nav clicks. Browser back/
    // forward and URL-driven navigation use the popstate-synced
    // view effect (~L5279) which compares against the current view
    // and short-circuits if equal — so a browser-back from
    // /collections detail back to /collections won't bump the
    // nonce. The pathname doesn't actually encode drill-down state
    // (it's internal to CollectionsView), so this is consistent;
    // calling out so future maintainers don't get surprised.
    if (v === view) {
      setNavRewindNonce(n => n + 1)
      // Also close popovers — without this, the popover-close
      // effect (keyed on `view`) wouldn't fire because `view`
      // didn't change. Inconsistent UX otherwise: re-clicking
      // Home with Notifications open would scroll-to-top but
      // leave the popover floating.
      setNotifOpen(false)
      setServerOpen(false)
      // Still scroll-to-top so a long Movies grid resets to the
      // header — same UX as desktop apps re-clicking a tab.
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setView(v)
    setSelectedMedia(null)
    // Clear the search input on navigate. It's a controlled input on
    // `searchQuery`, so this prevents the text from sticking after
    // leaving the search view.
    if (!keepSearch) setSearchQuery('')
    // Close the player on nav so the URL and rendered state stay in
    // sync (matters for programmatic history.replaceState calls).
    // While a cast/AirPlay receiver is active,
    // keep it mounted — navigating away from the show must NOT tear down an
    // active cast. The widget (rendered as a root-level sibling, outside the
    // swapped <main> view) persists and the receiver keeps playing until the
    // user stops it or the media ends. Mirrors the Escape gate above.
    if (!playerRemoteActiveRef.current) closePlayer(true)
    rememberScroll(location.key)
    navigate(`/${v}`)
  }, [view, navigate, closePlayer, location.key, navScope])
  // The search page is a place: shown, it has its address (/search). It used
  // to be drawn over whatever address the viewer was typing at, so Back from
  // a result skipped the results and left the words in the bar over another
  // page, and a reload showed that other page. Now Back from a result is the
  // results, Back from the results is where the viewer was, and the words
  // stay in the bar exactly while the results they are for are one Back
  // away. The words themselves are never in the address (a description of a
  // mood is not something to leave in a browser's history), so a reload of
  // /search is the page with nothing typed.
  //
  // Entered by typing, by Enter, and by a request's "Find it": one history
  // entry however many keys follow (`view` is already 'search' for those).
  const enteringSearchRef = useRef(false)
  const showSearchPage = useCallback(() => {
    if (view === 'search') return
    setView('search')
    // A player minimized over the page keeps playing while its viewer types,
    // as it always has (any other change of address closes it).
    enteringSearchRef.current = true
    rememberScroll(location.key)
    navigate('/search')
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [view, navigate, location.key])
  const describeSearch = useCallback((q: string) => {
    const query = q.trim()
    if (!query) return
    noteSearch(query)
    const n = ++describeAsksRef.current
    setSearchQuery(q)
    setSearchDescribe({ query, n, owner: searchOwner })
    showSearchPage()
  }, [searchOwner, noteSearch, showSearchPage])
  // The scan bar's "Open Libraries": the admin page, on its Libraries
  // section. Counted, so pressing it again while the page is on another
  // section opens Libraries again; leaving the admin page forgets it, so the
  // page opens on its overview the next time it is reached any other way.
  const [adminAsk, setAdminAsk] = useState(0)
  const openAdminLibraries = useCallback(() => {
    setAdminAsk(n => n + 1)
    if (view !== 'admin') handleNavigate('admin')
  }, [view, handleNavigate])
  useEffect(() => { if (view !== 'admin') setAdminAsk(0) }, [view])
  // The field's clear button, and the first Escape: the words go, the page
  // stays (it lists the recent searches), and the cursor is in the field.
  const clearSearch = useCallback(() => {
    const field = searchField()
    changeSearchQuery('')
    field?.focus({ preventScroll: field === searchInputRef.current })
  }, [changeSearchQuery])
  // A request was made (on the search page, or the requests page's own
  // composer): the list this tab holds learns of it, and a toast says so.
  const handleRequestSubmitted = useCallback((r: MediaRequest) => {
    // Not loaded yet (or dropped on a switch): leave it to the fetch, which
    // will include this one, rather than show it alone and cancel the fetch.
    // Not twice: a list fetched while this answer was out already has it.
    setRequestsList(prev => prev ? (prev.some(x => x.id === r.id) ? prev : [r, ...prev]) : prev)
    const id = nextToastId()
    setToasts(prev => [...prev, { id, message: `Requested "${r.title}"`, type: 'success' }])
  }, [nextToastId])
  // What the search page needs to take requests where a search ends. A
  // request's answer can arrive after the tab has moved on (a sign-out and
  // another sign-in, a profile switch): it is stamped with whose press it
  // was, and told to the app only while the tab still acts as them. It used
  // to be added to whatever requests list the tab then held, and announced.
  const searchUserId = user ? user.id : 0
  const searchOwnerRef = useRef(searchOwner)
  useLayoutEffect(() => { searchOwnerRef.current = searchOwner }, [searchOwner])
  const searchRequesting = useMemo(() => ({
    userId: searchUserId,
    onRequested: (r: MediaRequest) => { if (searchOwnerRef.current === searchOwner) handleRequestSubmitted(r) },
    onOpenRequests: () => handleNavigate('requests', { keepSearch: true }),
  }), [searchUserId, searchOwner, handleRequestSubmitted, handleNavigate])
  // The requests page's own late answers, stamped the same way: a request
  // asked for again, a delete, a row found to have moved on.
  const requestsPage = useMemo(() => {
    const still = () => searchOwnerRef.current === searchOwner
    return {
      submitted: (r: MediaRequest) => { if (still()) handleRequestSubmitted(r) },
      deleted: (id: number, replaced?: boolean) => {
        if (!still()) return
        setRequestsList(prev => prev ? prev.filter(r => r.id !== id) : prev)
        // A failed request that was asked for again goes quietly: the new
        // request has just been announced.
        if (replaced) return
        const tId = nextToastId()
        setToasts(prev => [...prev, { id: tId, message: 'Request deleted', type: 'info' }])
      },
      moved: (id: number, status: MediaRequest['status']) => {
        if (still()) setRequestsList(prev => prev ? prev.map(r => (r.id === id ? { ...r, status } : r)) : prev)
      },
    }
  }, [searchOwner, handleRequestSubmitted, nextToastId])
  // A request that is in the library now is found by its title (a request
  // holds no id of the title it became): the words, and the search page,
  // at its address, so Back returns to the request.
  // Not through handleNavigate, which ends by clearing the words.
  const findInLibrary = useCallback((title: string) => {
    changeSearchQuery(title)
    showSearchPage()
  }, [changeSearchQuery, showSearchPage])
  // A collection picked from the search page's results: the Collections
  // scope is opened on it. Owner-stamped, like the ask above, so it is not
  // carried to another profile's Collections.
  const [collectionAsk, setCollectionAsk] = useState<{ id: number; n: number; owner: string } | null>(null)
  const collectionAsksRef = useRef(0)
  const openCollectionFromSearch = useCallback((id: number) => {
    setCollectionAsk({ id, n: ++collectionAsksRef.current, owner: searchOwner })
    handleNavigate('collections', { keepSearch: true })
  }, [handleNavigate, searchOwner])
  const forgetCollectionAsk = useCallback(() => setCollectionAsk(null), [])

  const handleSelect = useCallback((m: Media) => {
    // The open itself: what this function has always done, in the order it
    // did it.
    const open = () => {
      setSelectedMedia(m)
      setView('detail')
      // Real URL per title: refresh keeps the page, browser Back returns to
      // the grid this was opened from, and the address bar is shareable.
      // selectedMedia is already set above so the deep-link hydration
      // effect no-ops for in-app opens. Record where the grid was first, so
      // Back lands on the card that was clicked (see scrollMemory).
      rememberScroll(location.key)
      navigate(`/title/${m.id}`)
      // Issue #261 — clicking into a movie/show must open the detail page
      // at the top; the window otherwise keeps whatever scroll offset the
      // user had on the previous page (e.g. scrolled-down home).
      // Instant (not smooth) because the page content is being replaced —
      // a smooth scroll would animate over swapped-in content and look off.
      window.scrollTo({ top: 0, behavior: 'auto' })
    }
    // Made by lib/posterTravel, which runs it exactly once: at once, as it
    // always was, unless a plain press on this title's card is behind it and
    // the browser can draw that card's poster travelling to the title
    // page's. Then it runs one frame later, inside the browser's
    // transition. Never while a player or a party's panel is over the page,
    // and only when the title page can draw its poster at once (its code is
    // here and the title has one).
    travelToTitle(m.id, open, { blocked: travelBlockedRef.current, arrives: detailModule !== null && !!m.poster })
  }, [navigate, location.key])
  // Which card a press landed on, for the travel above.
  useEffect(() => watchCardPresses(), [])
  // The title page's code is fetched when the pointer or the focus first
  // reaches a card, ahead of the press that needs it: the page a card opens
  // is then drawn at once, not as a skeleton first, and its poster is there
  // for the pressed one to travel to. From something the viewer did, until
  // the code has arrived (a failed fetch is tried again at the next card
  // reached); nothing is fetched on a timer or in a tab nobody is looking at.
  useEffect(() => {
    if (!user) return
    const warm = (e: Event) => {
      if (detailModule) { stop(); return }
      if (!(e.target as Element | null)?.closest?.('[data-media-id]')) return
      prefetchView('detail')
    }
    const stop = () => {
      document.removeEventListener('pointerover', warm, true)
      document.removeEventListener('focusin', warm, true)
    }
    document.addEventListener('pointerover', warm, true)
    document.addEventListener('focusin', warm, true)
    return stop
  }, [user])

  // Play resolution. The UI Media type doesn't carry server file
  // IDs, so we resolve them here:
  //   - Movies: GET /api/media/{id}/files, pick a file.
  //   - Shows: play the first episode of season 1 (TODO: port the
  //     V1 next-episode smart-resume).
  const handlePlay = useCallback(async (m: Media) => {
    dropWaitingOpen()
    // Don't start a new playback while a cast/AirPlay session is active: it
    // would tear down the cast's stream and leave the widget driving a
    // different title than the TV. The cast persists across navigation by
    // design — the user stops it from the widget first.
    if (playerRemoteActiveRef.current) {
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Stop casting to play something else', type: 'info' }])
      return
    }
    const myGen = ++playbackResolutionGenRef.current
    playbackResolutionRequestRef.current?.abort()
    const ac = new AbortController()
    playbackResolutionRequestRef.current = ac
    setPlayerLoading(true)
    try {
      // Phase 5 — quality preference. Read from the same aurora_prefs
      // bucket Settings writes to. Default 'auto' = 1080p preferred.
      let preferQuality: 'auto' | '1080p' | '4k' = 'auto'
      try {
        // Guard against null / non-object shapes that JSON.parse can
        // return when localStorage was tampered with.
        const raw: unknown = JSON.parse(localStorage.getItem('aurora_prefs') || '{}')
        if (raw && typeof raw === 'object') {
          const prefs = raw as Record<string, unknown>
          if (prefs.preferred_quality === '4k') preferQuality = '4k'
          else if (prefs.preferred_quality === '1080p') preferQuality = '1080p'
        }
      } catch { /* ignore */ }
      if (m.type === 'show') {
        // Show → first episode of first season. Audit H3 (2026-05-16):
        // sort by season_number explicitly. The API doesn't guarantee
        // ordering; insertion-order (which equals season-creation
        // order on disk) is NOT necessarily season_number-order for
        // shows that had a later season added before an earlier one,
        // or for shows starting at season 0 (specials). Same sort
        // applied to episodes for the same reason.
        const seasonsRaw = await getSeasons(m.id, ac.signal)
        if (!isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted)) return
        if (seasonsRaw.length === 0) throw new Error('No seasons available')
        // Where the show starts (lib/partyEpisode): the earliest episode
        // with a file, the regular seasons in order and Specials last.
        // Season 0 has the lowest number and is not where a show starts; it
        // is still played when the show has nothing else. A season or an
        // episode with no file is passed over rather than failing the play:
        // a show whose first season's files were pruned still has something
        // to start on.
        const first = await firstEpisodeToPlay(m.id, ac.signal, seasonsRaw)
        if (!isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted)) return
        if (!first) throw new Error('Episode has no files')
        const ep = first.episode
        const file = pickFile(ep.files, preferQuality)
        if (!file) throw new Error('Episode has no files')
        // Not the first episode: say so, or the viewer is dropped into the
        // middle of a show with no word of why.
        const later = startsLaterNotice(m.title, first)
        if (later) setToasts(prev => [...prev, { id: nextToastId(), message: later, type: 'info' }])
        setPlayerTarget({
          mediaItemId: m.id,
          fileId: file.id,
          fileType: 'episode',
          episodeId: ep.id,
          seasonNumber: first.seasonNumber,
          episodeNumber: ep.episode_number,
          title: m.title,
          subtitle: `S${first.seasonNumber}E${ep.episode_number}${ep.title ? ' — ' + ep.title : ''}`,
        })
      } else {
        // Movie → quality-preferred file.
        const files = await getMediaFiles(m.id, ac.signal)
        if (!isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted)) return
        const file = pickFile(files, preferQuality)
        if (!file) throw new Error('No file available to play')
        setPlayerTarget({
          mediaItemId: m.id,
          fileId: file.id,
          fileType: 'media',
          title: m.title,
          subtitle: m.year ? String(m.year) : undefined,
        })
      }
    } catch (err) {
      if (!isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted) ||
          (err && (err as Error).name === 'AbortError')) return
      const msg = err instanceof Error ? err.message : 'Failed to start playback'
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: msg, type: 'error' }])
    } finally {
      if (playbackResolutionRequestRef.current === ac &&
          isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted)) {
        setPlayerLoading(false)
        playbackResolutionRequestRef.current = null
      }
    }
  }, [nextToastId])

  // Pre-warm playback on Play/Resume hover/focus from the detail page. Mirrors
  // handlePlay's file resolution (READ-ONLY — touches no playback state) and
  // hands the resolved file to the pre-warm module, which pre-creates the
  // transcode session (or warms the direct-play file cache) so the click→play
  // latency is hidden. Deliberately PARALLEL to handlePlay rather than sharing
  // its code, so the battle-tested play path stays untouched; any divergence
  // only costs a missed pre-warm — the player adopts a warmed session solely on
  // an exact request-key match, never the wrong stream.
  // Dedup repeated Play-button intents (onMouseEnter + onFocus fire as a pair,
  // and a button can be re-hovered): collapses to one resolution+warm per
  // distinct target. Reset when the detail page is left (see cleanup effect).
  const lastIntentKeyRef = useRef<string | null>(null)
  // The lookups a warm makes before it can start (a show's seasons and
  // episodes, a film's files). Abandoned when the intent changes and when
  // the page is left: for a show whose first seasons have no files that is
  // a read per season, and they used to run on after the viewer had gone.
  const intentLookupRef = useRef<AbortController | null>(null)
  const handlePrimaryIntent = useCallback(async (m: Media, resumeItem?: ContinueWatchingItem) => {
    if (!prewarmEnabled()) return
    // Don't pre-warm while casting — handlePlay refuses to start new local
    // playback in that state, so a warm would never be consumed.
    if (playerRemoteActiveRef.current) return

    const startSec = resumeItem && resumeItem.position_ms > 0
      ? Math.floor(resumeItem.position_ms / 1000)
      : 0
    // Skip the resolution fetches (getMediaFiles / getEpisodes / getSeasons)
    // when the intent is unchanged — the warm for this target is already in
    // flight or done; re-resolving would just burn redundant API round-trips.
    const intentKey = `${m.type}:${m.id}:${resumeItem?.episode_id ?? ''}:${startSec}`
    if (lastIntentKeyRef.current === intentKey) return
    lastIntentKeyRef.current = intentKey
    intentLookupRef.current?.abort()
    const lookup = new AbortController()
    intentLookupRef.current = lookup
    const { signal } = lookup

    try {
      const preferQuality = currentPreferredQuality()

      if (m.type === 'show') {
        if (resumeItem?.episode_id && resumeItem.season_number !== undefined) {
          // Resume → the CW record names the exact episode + position.
          const eps = await getEpisodes(m.id, resumeItem.season_number, signal)
          const ep = eps.find(e => e.id === resumeItem.episode_id)
          const file = pickFile(ep?.files, preferQuality)
          if (file && !signal.aborted) void prewarm({ fileId: file.id, fileType: 'episode', startSec })
        } else {
          // Fresh → the episode handlePlay will start (the same lookup, so
          // the stream that is warmed is the one that is played).
          const first = await firstEpisodeToPlay(m.id, signal)
          const file = pickFile(first?.episode.files, preferQuality)
          if (file && !signal.aborted) void prewarm({ fileId: file.id, fileType: 'episode', startSec: 0 })
        }
      } else {
        const files = await getMediaFiles(m.id, signal)
        const file = pickFile(files, preferQuality)
        if (file && !signal.aborted) void prewarm({ fileId: file.id, fileType: 'media', startSec })
      }
    } catch {
      // Best-effort — a failed resolution / pre-warm must never disrupt the page.
    }
  }, [])

  // Discard a hover-warmed session when the user leaves the detail page without
  // playing. On play the player consumes the warm (takeWarmedSession), so this
  // cleanup is a no-op then; otherwise it deletes the stranded ffmpeg session.
  // Also reset the intent dedup so re-opening the page can warm afresh.
  useEffect(() => {
    return () => {
      intentLookupRef.current?.abort()
      intentLookupRef.current = null
      cancelPrewarm()
      lastIntentKeyRef.current = null
    }
  }, [view, selectedMedia?.id])

  // A title's library writes go to the server one at a time, in the order
  // they were made. An Undo pressed while its removal was still out sent a
  // POST that nothing ordered after the DELETE, and a save and a removal
  // made in quick succession by hand could pass each other the same way.
  // Both routes are idempotent, so every write is sent, whatever became of
  // the one before it, and the last one sent is the last one made. A write
  // whose turn comes after a profile switch is still sent: it names its
  // profile in the address, which an unrestricted session may name (a
  // restricted one is refused, and the owner checks below keep that off the
  // new profile's screen).
  const libraryWritesRef = useRef<Map<string, { tail: Promise<unknown>; made: number; failed: boolean }>>(new Map())
  // One change to a profile's My Library: made on screen at once, then sent.
  // `refused(last)`: the server did not take it; `last` says whether it was
  // still the latest change asked for that title.
  const changeLibrary = useCallback((m: Media, op: 'add' | 'remove', profileId: number, refused: (last: boolean) => void) => {
    // All membership mutations dedupe inside the functional updater so a
    // rapid double-click can't insert the same id twice (duplicate React
    // keys) or drop it.
    const addLocal = (prev: Media[]) => (prev.some(i => i.id === m.id) ? prev : [...prev, m])
    const removeLocal = (prev: Media[]) => prev.filter(i => i.id !== m.id)
    setLibrary(op === 'add' ? addLocal : removeLocal)
    const key = `${profileId}:${m.id}`
    const mark = { op }
    pendingLibOpsRef.current.set(key, mark)
    const settle = () => { if (pendingLibOpsRef.current.get(key) === mark) pendingLibOpsRef.current.delete(key) }
    // The list this change was made on. A switch before the answer swaps in
    // another profile's, which nothing here may edit.
    const owner = libraryWriteOwnerRef.current
    // The account it was made for: a write whose turn comes after a sign-out
    // (or once another account has signed in) is not sent. Its 401 would end
    // whatever session the tab has by then.
    const madeFor = libraryUserRef.current
    const queue = libraryWritesRef.current.get(key) ?? { tail: Promise.resolve(), made: 0, failed: false }
    libraryWritesRef.current.set(key, queue)
    const n = ++queue.made
    const send = () => (libraryUserRef.current !== madeFor
      ? Promise.reject(new Error('signed out since'))
      : op === 'add' ? addToLibrary(profileId, m.id) : removeFromLibrary(profileId, m.id))
    const sent = queue.tail.then(send, send)
    queue.tail = sent
    const last = () => queue.made === n
    sent.then(settle, () => {
      settle()
      queue.failed = true
      // Another list is on screen (a switch, or a sign-out, since): it is
      // not this change's to edit, and what became of the change is not
      // said to whoever is acting now, by a title's name.
      if (libraryWriteOwnerRef.current !== owner) return
      // The latest change is taken back on screen; an earlier one is left
      // to the read below, since what came after it is on screen too.
      if (last()) setLibrary(op === 'add' ? removeLocal : addLocal)
      refused(last())
    }).finally(() => {
      if (!last()) return
      libraryWritesRef.current.delete(key)
      // A queue in which anything failed ends with the server's own list:
      // working out the title's state from the answers in order is what
      // left the screen saying saved for a title the server did not have.
      if (!queue.failed || libraryWriteOwnerRef.current !== owner) return
      getLibrary(profileId).then(items => {
        if (libraryWriteOwnerRef.current === owner) setLibrary(prev => mergeServerLibrary(prev, items, profileId))
      }, () => {})
    })
  }, [mergeServerLibrary])
  // The toast's Undo puts a removed title back, and does only that. It was
  // the toggle called again, which flips whatever the list says by then: a
  // removal that had failed was sent a second time, and a title its viewer
  // had saved again by hand was removed, silently. Here a title that is in
  // the list is left alone; one that is not goes back, for the profile it
  // was removed for and only while that profile's list is still the one on
  // screen (`owner`; lib/libraryUndo), with its write behind the removal's
  // (changeLibrary's queue).
  const restoreToLib = useCallback((m: Media, profileId: number, owner: string | null) => {
    if (!undoMayRestore(libraryWriteOwnerRef.current, owner, library, m.id)) return
    changeLibrary(m, 'add', profileId, (last) => {
      if (last) addToast(`Couldn't put "${m.title}" back — try again`, 'error')
    })
  }, [library, changeLibrary, addToast])
  // Undo is pressed later, when `library` has moved on: it calls the
  // function of that render, not the one that made the toast.
  const restoreToLibRef = useRef(restoreToLib)
  // A layout effect, for the reason buildCardMenuRef's is one.
  useLayoutEffect(() => { restoreToLibRef.current = restoreToLib }, [restoreToLib])
  const handleToggleLib = useCallback((m: Media) => {
    // Optimistic: flip local state now, persist to the server, roll back on
    // failure. Needs a signed-in profile — the library is per-profile.
    if (!activeProfileId) {
      addToast('Pick a profile to save titles', 'info')
      return
    }
    // The render-closure read only decides intent (changeLibrary dedupes).
    const wasSaved = library.some(i => i.id === m.id)
    const profileId = activeProfileId
    const owner = libraryWriteOwnerRef.current
    // A removal can be taken back from its toast (once: a toast takes its
    // action once), for whoever removed the wrong one.
    let undone = false
    const said = addToast(
      wasSaved ? `Removed ${m.title} from My Library.` : `Saved ${m.title} to My Library.`,
      wasSaved ? 'info' : 'success',
      wasSaved ? { label: 'Undo', run: () => { undone = true; restoreToLibRef.current(m, profileId, owner) } } : undefined,
    )
    changeLibrary(m, wasSaved ? 'remove' : 'add', profileId, (last) => {
      // It was not done: the toast that said it was goes, and with it the
      // Undo of a removal that did not happen.
      removeToast(said)
      // Said only of the last thing its viewer asked for that title: after
      // an Undo or a later change by hand, a "couldn't remove, try again"
      // would ask them to undo what they asked for since.
      if (last && !undone) addToast(`Couldn't ${wasSaved ? 'remove' : 'save'} "${m.title}" — try again`, 'error')
    })
  }, [library, activeProfileId, addToast, removeToast, changeLibrary])

  const handleBack = useCallback(() => {
    dropWaitingOpen()
    // In-app opens pushed /title/:id onto the history stack, so real
    // history-back returns to the exact view (and scroll restoration)
    // the user came from — and the browser's own Back button now does
    // the same thing as this in-app arrow. A cold load (refresh or a
    // shared link) has no in-app entry behind it; going back(-1) would
    // leave the SPA, so route home instead. selectedMedia is cleared by
    // the URL-sync effect once the path stops being /title/:id.
    // (lib/historyBack says when an entry of the app is behind this one.
    // Where the step lands is then an address of the app like any other:
    // the URL-sync effect and the redirects for pages a session is not
    // shown apply to it exactly as they do to the browser's own Back.)
    if (hasInAppEntryBehind(location.key, window.history.state)) {
      navigate(-1)
    } else {
      navigate('/', { replace: true })
    }
  }, [location.key, navigate])

  // Handle keyboard shortcuts
  useEffect(() => {
    // Whether something is over the page, so that a key meant for the page
    // must leave it alone: a card's menu, the add-to-list sheet, the profile
    // picker, a PIN prompt, or any modal dialog (one that says it is, or one
    // that has made the page inert or hidden it from assistive tech, as the
    // Radix dialogs do). One answer for the search page's Escape and for
    // Ctrl or Cmd K. The player is not in it: Escape closes a player, and
    // while one casts the page under it is still the viewer's to use; the
    // shortcut has its own rule for a player below.
    const pageCovered = () =>
      !!(contextMenu || addToListMedia || profilesGateOpen || pinTarget)
      || document.querySelector('[aria-modal="true"]') !== null
      || !!searchField()?.closest('[inert], [aria-hidden="true"]')
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The PIN prompt's Escape cancels it (Radix); it must not also navigate
        // the page behind it.
        if (pinTarget) return
        // While a cast/AirPlay receiver is active, Escape
        // must NOT unmount it (that kills the cast) — fall through to the
        // normal app navigation below instead.
        // The add-to-list sheet had no Escape of its own, so the key went
        // to the page behind it: on the search page it cleared the words,
        // or went Back, with the sheet still up. Escape closes the sheet,
        // and before any player: the sheet is painted above the player
        // (z-[70]; the player in the window is z-[60], a sibling, and a
        // minimized one is out of the paint order), so it is what is on top
        // also when a player has opened under it (a party's, by itself).
        // A dialog above the player owns its Escape (lib/escapeLayers).
        // Native full screen is the browser's own Escape.
        if (addToListMedia) closeAddToList()
        else if ((playerTarget || playerLoading) && !playerRemoteActiveRef.current) closePlayer(true)
        else if (view === 'search') {
          // Not behind anything else that is over the page either.
          if (pageCovered()) return
          // On the search page Escape clears the field, then leaves: the
          // first press takes the words (the focus goes to the field; it may
          // have been on a result, which is about to go), and with none left
          // the next goes back to where the viewer was.
          if (searchQuery) clearSearch()
          else {
            (document.activeElement as HTMLElement | null)?.blur?.()
            handleBack()
          }
        }
        // Anywhere else, Escape in the bar's field only leaves the field.
        // What is typed there stays: on a title opened from a search, those
        // are the words Back returns to.
        else if (searchInputRef.current && document.activeElement === searchInputRef.current) searchInputRef.current.blur()
        // A title page goes Back, but not from behind something over it: the
        // onboarding flow, a card's menu, a recap or any other dialog. Their
        // Escape is theirs (or, for the flow, nothing), and went on to send
        // the page they cover Back. The trailer, the player's menus and the
        // party's leave question take the key before this handler sees it
        // (lib/escapeLayers). A player still up here is casting (any other
        // was closed above). In the window or full screen its surface is a
        // modal dialog that makes the page inert, which pageCovered reads
        // as covered; under it Escape stays the page's, as before, unless
        // something else is over the page too (nothing in the page can be
        // opened then: it is inert). Minimised, the cast covers nothing, and
        // the page is asked like any other: a Radix dialog (a recap) sets no
        // aria-modal and is seen only by the page being hidden.
        else if (view === 'detail') {
          const castOver = !!playerTarget && (playerSurface === 'theater' || playerSurface === 'fullscreen')
          const covered = castOver
            ? !!(contextMenu || profilesGateOpen || onboardingOpen)
              || document.querySelector(`[aria-modal="true"]:not([${ESCAPE_LAYERS_ATTR}])`) !== null
            : pageCovered()
          if (!covered) handleBack()
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // Ctrl or Cmd K puts the focus in the search field (it used to
        // open a palette with a field of its own). It does nothing:
        //   - signed out;
        //   - from another text field (it is that field's key);
        //   - while something is over the page: the player, a card's
        //     menu, the add-to-list sheet, the profile picker or a PIN
        //     prompt. Typing in the bar behind any of those would move
        //     the page under it.
        if (!user) return
        const target = e.target as HTMLElement | null
        const inEditable = !!target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        )
        if (inEditable && target !== searchInputRef.current) return
        // Not while a player is up, minimized included (playerTarget).
        if (playerTarget) return
        // Nor under anything else that is over the page (pageCovered). The
        // palette opened over a dialog, with a field of its own; this field
        // is in the page behind it, and a dialog that holds the focus would
        // hand the key on to the fallback below, which moves the page.
        if (pageCovered()) return
        const field = searchField()
        e.preventDefault()
        // The bar is always on screen (it is sticky), and a plain focus()
        // on something sticky scrolls the page to where the bar sits in the
        // document: the top. The page stays where its viewer has it.
        if (field) { field.focus({ preventScroll: field === searchInputRef.current }); field.select() }
        // Below md the bar has no field (focusing one that is not drawn
        // does nothing): the Search tab's page has its own, and takes the
        // focus when it is opened this way.
        if (!field || document.activeElement !== field) handleNavigate('search')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // Modal-state deps so the Cmd+K guard re-binds when a modal
    // opens/closes (avoids a stale closure reading "no modal" while
    // one is actually open).
  }, [playerTarget, playerLoading, playerSurface, searchQuery, view, handleBack, contextMenu, addToListMedia, closeAddToList, user, profilesGateOpen, pinTarget, onboardingOpen, closePlayer, clearSearch, handleNavigate])

  // Session expiry. /api/auth/me is validated once at mount (below), so a
  // long-lived tab whose session expired mid-session never re-checked: it kept
  // rendering as logged-in and kept polling with dead credentials — 8,562
  // requests at user_id=0 in the production logs, one storm running for hours
  // on 2026-07-24. api.ts now fires this event when the server definitively
  // rejects a refresh; dropping to the auth screen unmounts the authed
  // subtree, and with it every poller, socket and interval.
  useEffect(() => {
    const onExpired = () => setUser(false)
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [])

  // Auth boot. deep-debug H10 — tokens are httpOnly cookies (invisible to JS),
  // so a cached user is our auth signal: optimistically render with it while
  // validating via /api/auth/me (the cookie authenticates the call). The
  // cancelled flag + the re-check of getStoredUser() guard against a late /me
  // settling onto stale state if the user logged out (or as a different user)
  // mid-flight.
  useEffect(() => {
    const cached = getStoredUser()
    // deep-debug H10 — auth state is signalled by a cached user; the tokens are
    // httpOnly cookies, invisible to JS. No cached user → show the auth screen
    // (a lone cookie we can't read still 401s at /me below).
    if (!cached) {
      setUser(false)
      return
    }
    // Show the app immediately, then validate via /me (the httpOnly cookie
    // authenticates it); a revoked/expired session 401s and kicks us out.
    setUser(cached)
    const ac = new AbortController()
    let cancelled = false
    fetchMe(ac.signal)
      .then(u => {
        if (cancelled) return
        // If a logout happened between when we fired and when we landed,
        // the cached user is now cleared and we must NOT call setUser(u) —
        // that would silently re-authenticate as the stale response's user.
        // deep-debug H10 — gate on cached-user presence, not a JS token.
        if (!getStoredUser()) return
        setUser(u)
      })
      .catch(err => {
        if (cancelled) return
        if (err && (err as Error).name === 'AbortError') return
        setUser(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  // Resolve the new media's first file when the host changes the
  // party's media. The generation counter prevents a slow earlier
  // resolve (e.g. ep5 in season 12 → many sequential getEpisodes
  // calls) from overwriting a fast later resolve.
  useEffect(() => {
    return party.onMediaChange((p) => {
      const myGen = ++mediaChangeGenRef.current
      mediaChangePendingGenRef.current = myGen
      // Consume synchronously: whoever sent the swap is decided now, not
      // after an async resolve that a second broadcast could interleave with.
      const selfAdvanced = partySelfAdvanceRef.current
      partySelfAdvanceRef.current = false
      void (async () => {
        try {
          if (p.episode_id) {
            // We don't know which season; lift from getMedia +
            // search. handlePlayEpisode needs the Episode object;
            // we don't have it here. Cheapest path: fetch seasons
            // for this media, scan episodes for episode_id, pick
            // its file.
            const seasonsRaw = await getSeasons(p.media_item_id)
            const seasons = [...seasonsRaw].sort((a, b) => a.season_number - b.season_number)
            let foundEp: ApiEpisode | null = null
            let foundSeasonNum = 0
            for (const s of seasons) {
              const eps = await getEpisodes(p.media_item_id, s.season_number)
              const ep = eps.find(e => e.id === p.episode_id)
              if (ep) { foundEp = ep; foundSeasonNum = s.season_number; break }
            }
            if (!foundEp) return
            if (myGen !== mediaChangeGenRef.current) return // stale
            const file = pickFile(foundEp.files)
            if (!file) return
            const titleDetail = await getMedia(p.media_item_id).catch(() => null)
            if (myGen !== mediaChangeGenRef.current) return // stale
            setPlayerTarget({
              mediaItemId: p.media_item_id,
              fileId: file.id,
              fileType: 'episode',
              episodeId: foundEp.id,
              seasonNumber: foundSeasonNum,
              episodeNumber: foundEp.episode_number,
              title: titleDetail?.title ?? party.state.mediaTitle ?? 'Untitled',
              subtitle: `S${foundSeasonNum}E${foundEp.episode_number}${foundEp.title ? ' — ' + foundEp.title : ''}`,
              partyRecoveryBoot: true,
              // Issue #460 — the host who asked for this advance boots
              // PLAYING. ChangeMedia always parks the room at Paused@0, so
              // the usual isPlaying check would pause the very person who
              // just clicked "Play for all". Booting unpaused lets the
              // player's existing host-broadcast recovery fire request-play,
              // which resumes the whole room. Guests still boot paused and
              // follow that broadcast, exactly as they do for any host play.
              partyPlayOnBootRevision: selfAdvanced ? p.rev : undefined,
              pauseOnBootToken: (selfAdvanced || partyStateRef.current.isPlaying)
                ? undefined
                : ++partyPauseOnBootTokenRef.current,
            })
            // Guests get no other signal that the room moved — the episode
            // simply changes under them after a resolve that can take
            // seconds on a long series. Host succession already toasts for
            // a smaller disruption than this.
            if (!selfAdvanced) {
              addToast(`Host started S${foundSeasonNum}E${foundEp.episode_number}`, 'info')
            }
          } else {
            // Movie — fetch files + play first.
            const files = await getMediaFiles(p.media_item_id)
            if (myGen !== mediaChangeGenRef.current) return // stale
            const file = pickFile(files)
            if (!file) return
            const titleDetail = await getMedia(p.media_item_id).catch(() => null)
            if (myGen !== mediaChangeGenRef.current) return // stale
            setPlayerTarget({
              mediaItemId: p.media_item_id,
              fileId: file.id,
              fileType: 'media',
              title: titleDetail?.title ?? 'Untitled',
              partyRecoveryBoot: true,
              // Same self-advance rule as the episode branch above.
              partyPlayOnBootRevision: selfAdvanced ? p.rev : undefined,
              pauseOnBootToken: (selfAdvanced || partyStateRef.current.isPlaying)
                ? undefined
                : ++partyPauseOnBootTokenRef.current,
            })
          }
        } catch (err) {
          console.warn('[Aurora] media-change auto-resolve failed', err)
        } finally {
          if (mediaChangePendingGenRef.current === myGen) {
            mediaChangePendingGenRef.current = null
          }
        }
      })()
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party.onMediaChange])

  // 2026-08 — host succession. The server promotes silently at the
  // protocol level; a crown moving with no explanation reads as a
  // glitch, so name the handoff for everyone still in the room. State
  // (hostUserId, is_host flags) is already patched by useParty before
  // this fires — the toast is the only App-level job.
  useEffect(() => {
    return party.onHostChange(p => {
      if (user && p.new_host_user_id === user.id) {
        addToast(
          `${p.previous_host_username || 'The host'} ${p.reason === 'disconnected' ? 'disconnected' : 'left'} — you're hosting now`,
          'info',
        )
      } else {
        addToast(`${p.new_host_username} is now the host`, 'info')
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party.onHostChange, user, addToast])

  // 2026-05-25 — Party auto-open-player. Symptom: in the EEJ7DB live test,
  // the host clicked Play but nothing opened on the guest's end. Root
  // cause: onMediaChange above only fires when the host SWITCHES media
  // mid-party (server emits a `media-change` event), but the initial
  // play case (guest already joined, host hits Play in their already-
  // open player) only flows tick/play events on the sync socket —
  // there's no media-change to subscribe to, so nothing in App.tsx ever
  // opens the player for the guest, and the sync events go nowhere.
  //
  // Fix: watch (state.code, state.mediaItemId, state.isPlaying, user.id,
  // state.hostUserId, playerTarget) and auto-open the player when all
  // of: in a party, media is set, party is playing, and we don't
  // already have a player open. This also covers the "guest joined a
  // party that was ALREADY playing" case — party-state arrives with
  // isPlaying=true and the effect fires immediately.
  //
  // Guests still wait for actual playback; a promoted host also opens on a
  // paused mid-movie party so the room has transport controls. A deliberate
  // Close is different from an absent player: closePlayer records a scoped
  // dismissal, preventing the recovery loop reported in issue #449. New media
  // or a guest→host promotion changes the key and safely re-arms auto-open.
  useEffect(() => {
    // Invalidate any older async resolver on every policy-input change, even
    // when this render decides not to open (manual close / another target).
    const myGen = ++partyAutoOpenGenRef.current
    partyAutoOpenPendingGenRef.current = null
    if (!user) return
    if (!shouldAutoOpenPartyPlayer(
      {
        code: party.state.code,
        mediaItemId: party.state.mediaItemId,
        episodeId: party.state.episodeId,
        hostUserId: party.state.hostUserId,
        isPlaying: party.state.isPlaying,
        currentTimeMs: partyStateRef.current.currentTimeMs,
      },
      user.id,
      !!playerTarget,
      partyPlayerDismissedKeyRef.current,
    )) return
    if (party.state.mediaItemId == null) return // narrowed by policy; TS guard
    const mediaItemId = party.state.mediaItemId
    const episodeId = party.state.episodeId
    partyAutoOpenPendingGenRef.current = myGen
    void (async () => {
      try {
        if (episodeId) {
          const seasonsRaw = await getSeasons(mediaItemId)
          const seasons = [...seasonsRaw].sort((a, b) => a.season_number - b.season_number)
          let foundEp: ApiEpisode | null = null
          let foundSeasonNum = 0
          for (const s of seasons) {
            const eps = await getEpisodes(mediaItemId, s.season_number)
            const ep = eps.find(e => e.id === episodeId)
            if (ep) { foundEp = ep; foundSeasonNum = s.season_number; break }
          }
          if (!foundEp) return
          if (myGen !== partyAutoOpenGenRef.current) return // stale
          const file = pickFile(foundEp.files)
          if (!file) return
          const titleDetail = await getMedia(mediaItemId).catch(() => null)
          if (myGen !== partyAutoOpenGenRef.current) return // stale
          setPlayerTarget({
            mediaItemId,
            fileId: file.id,
            fileType: 'episode',
            episodeId: foundEp.id,
            seasonNumber: foundSeasonNum,
            episodeNumber: foundEp.episode_number,
            title: titleDetail?.title ?? party.state.mediaTitle ?? 'Untitled',
            subtitle: `S${foundSeasonNum}E${foundEp.episode_number}${foundEp.title ? ' — ' + foundEp.title : ''}`,
            partyRecoveryBoot: true,
            // Watch-party rejoin sync: open AT the party's current position
            // so a returning guest doesn't start at 0:00 and rely on the drift
            // loop to catch up. partyStateRef holds the freshest position.
            resumePositionMs: partyStateRef.current.currentTimeMs > 0
              ? partyStateRef.current.currentTimeMs
              : undefined,
            pauseOnBootToken: party.state.isPlaying
              ? undefined
              : ++partyPauseOnBootTokenRef.current,
          })
        } else {
          const files = await getMediaFiles(mediaItemId)
          if (myGen !== partyAutoOpenGenRef.current) return // stale
          const file = pickFile(files)
          if (!file) {
            // Empty file list for a show means episode_id was missing from
            // the party state (party created before the fix). Log so this is
            // diagnosable without a silent no-op.
            // eslint-disable-next-line no-console
            console.warn('[Aurora] guest auto-open: no files found for media', mediaItemId,
              '— party episode_id is null; host may have created the party for a TV show without episode context')
            return
          }
          const titleDetail = await getMedia(mediaItemId).catch(() => null)
          if (myGen !== partyAutoOpenGenRef.current) return // stale
          setPlayerTarget({
            mediaItemId,
            fileId: file.id,
            fileType: 'media',
            title: titleDetail?.title ?? party.state.mediaTitle ?? 'Untitled',
            partyRecoveryBoot: true,
            // Watch-party rejoin sync: open AT the party's current position.
            resumePositionMs: partyStateRef.current.currentTimeMs > 0
              ? partyStateRef.current.currentTimeMs
              : undefined,
            pauseOnBootToken: party.state.isPlaying
              ? undefined
              : ++partyPauseOnBootTokenRef.current,
          })
        }
      } catch (err) {
        console.warn('[Aurora] guest auto-open resolve failed', err)
      } finally {
        if (partyAutoOpenPendingGenRef.current === myGen) {
          partyAutoOpenPendingGenRef.current = null
        }
      }
    })()
  }, [
    user,
    party.state.code,
    party.state.mediaItemId,
    party.state.episodeId,
    party.state.isPlaying,
    party.state.hostUserId,
    party.state.mediaTitle,
    playerTarget,
  ])

  // Magic-link auto-join. The server redirects /p/{code} and
  // /r/{code} to {BASE}p/{code}; we extract the code and trigger
  // party.join. We strip the dynamic Vite base before regex-matching
  // so the lookup survives a future change to Vite's `base`.
  useEffect(() => {
    if (!user) return
    const base = import.meta.env.BASE_URL.replace(/\/$/, '') // '' or '/v2'
    const pathAfterBase = window.location.pathname.startsWith(base)
      ? window.location.pathname.slice(base.length)
      : window.location.pathname
    const m = pathAfterBase.match(/^\/(p|r)\/([A-Za-z0-9]{6})$/)
    if (!m) return
    const code = m[2].toUpperCase()
    const linkKind = m[1] // 'p' or 'r' — preflight clarifies anyway
    // Strip the code from the URL so a refresh doesn't re-trigger
    // the join (which would error "already in party" if still
    // active, or no-op if not).
    window.history.replaceState({}, '', import.meta.env.BASE_URL)
    void (async () => {
      // If already in a party, confirm before clobbering — otherwise
      // an accidental magic-link click silently disconnects the user
      // and notifies everyone else with participant-left.
      if (party.state.code && party.state.code !== code) {
        const ok = window.confirm(
          `You're in party ${party.state.code}. Leave it and join ${code}?`
        )
        if (!ok) return
      }
      const result = await party.join(code)
      if (result.ok) {
        setPartyPanelOpen(true)
      } else {
        // Persistent rooms surface a friendly "offline" toast (vs
        // a generic error) so the user understands what they clicked.
        const id = nextToastId()
        const isOfflineRoom = linkKind === 'r' || (result.error || '').toLowerCase().includes('persistent room')
        setToasts(prev => [...prev, {
          id,
          message: isOfflineRoom
            ? `Room ${code} is offline — no live session right now. Ask the host to start a watch party.`
            : (result.error || `Couldn't join party ${code}.`),
          type: isOfflineRoom ? 'info' : 'error',
        }])
      }
    })()
  // We intentionally run once when user becomes available, not on
  // every party state change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // OAuth link-mode return (audit carve-out D). The link-mode callback
  // redirects to /?linked=<provider>, which the `/` → `/v2/` redirect
  // preserves as ?linked=<provider> on the SPA. The user initiated the
  // connect from Settings, so jump back there, surface a success toast, and
  // strip the param so a refresh doesn't re-toast. ConnectedAccountsCard
  // fetches the refreshed link list on its own mount, so it shows the newly
  // connected provider without extra plumbing.
  useEffect(() => {
    if (!user) return
    const params = new URLSearchParams(window.location.search)
    const linked = params.get('linked')
    if (!linked) return
    addToast(`Connected your ${oauthProviderLabel(linked)} account.`, 'success')
    setView('settings')
    // Strip only the linked param, preserving any others + the path/hash.
    params.delete('linked')
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
  // Run once when the user becomes available; the marker is single-use.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Full state reset on logout. Must clear every per-user cache
  // (rails, library, detail, player, …) — on a shared browser, a
  // missed field briefly leaks the previous user's data to the next
  // login. Hoisted above the storage useEffect so both the explicit
  // logout and the cross-tab path can share it.
  const resetUserState = useCallback(() => {
    // What was typed in the search field goes with whoever typed it. It
    // stayed in the bar across a sign-out: the next person to sign in on
    // the tab found the last one's words there, a search ran for them under
    // the new account, and opening a result filed them in the new
    // account's recent searches. (A session that expires does not come
    // through here: the signed-out effect below clears them for both.)
    setSearchQuery('')
    setSearchDescribe(null)
    forgetDescribedAnswer()
    // "Connect a TV with a code" is the intent of whoever followed it.
    forgetDeviceIntent()
    setLibraryServerFor(null)
    setHomeRails(undefined)
    setHomeHero(null)
    // Clear hero pool too — without this, user A's personalized
    // blurb is briefly visible to user B after a cross-tab logout.
    setHeroPool([])
    setHeroIndex(0)
    setHeroOnLead(true)
    setHeroPaused(false)
    setHeroSlateToken(undefined)
    heroPoolRef.current = []
    // Same leak class for the follow feed (PR-429 review): the ref
    // survives the auth swap, and a warm-cache Discover resolving first
    // would recompose user B's home with user A's feed spliced in.
    followingRailRef.current = []
    // And for every other rail buffer, and what says whose they are: a
    // background refresh recomposes from them, so the next account's first
    // load must be cold (railsUserRef also catches a session that expired,
    // which does not come through here).
    coreRailsRef.current = []
    discoverRailsRef.current = []
    anchorRailsRef.current = []
    engagementRailsRef.current = []
    removedFromHomeRef.current = new Set()
    railsProfileRef.current = undefined
    railsUserRef.current = null
    lastHomeLoadRef.current = 0
    homeRefreshAcRef.current?.abort()
    homeRefreshAcRef.current = null
    moviesRefreshAcRef.current?.abort()
    moviesRefreshAcRef.current = null
    showsRefreshAcRef.current?.abort()
    showsRefreshAcRef.current = null
    setContinueItems([])
    setContinueFor(null)
    forgetHeroLeadWait()
    // The ref too, now: it is what a card's Play reads at click time, and it
    // would otherwise hold the previous profile's records until the next
    // commit's effects.
    continueItemsRef.current = []
    setMoviesList(null)
    setShowsList(null)
    setMoviesTotal(null)
    setShowsTotal(null)
    // Pagination state reset on logout. Sort preference is per-user
    // so default it back; loading flags are per-session.
    // What a grid opens with, not a sort of its own: after signing out and
    // in again the grid opened on "Top rated" with Filters saying something
    // was applied.
    setMoviesSort(DEFAULT_BROWSE_SORT)
    setShowsSort(DEFAULT_BROWSE_SORT)
    setMoviesLoadingMore(false)
    setShowsLoadingMore(false)
    setMoviesNextPage(1)
    setShowsNextPage(1)
    // Abort any in-flight Load More so a stale response doesn't
    // leak into the next user's session.
    moviesLoadMoreAcRef.current?.abort()
    moviesLoadMoreAcRef.current = null
    showsLoadMoreAcRef.current?.abort()
    showsLoadMoreAcRef.current = null
    setRequestsList(null)
    setNotifications([])
    setUnreadCount(0)
    markedAllReadRef.current = false
    seedResolvedRef.current = false
    setLibrary([])
    setSelectedMedia(null)
    setDetailItem(null)
    setDetailEpisodes([])
    setDetailSeasons([])
    setDetailSelectedSeason(null)
    currentEpisodesSeasonRef.current = null
    closePlayer()
    setPartyPanelOpen(false)
    setView('home')
    // QA BUG-001 follow-up — also drop the URL back to root.
    // Without this, the URL stayed at /v2/admin (or wherever)
    // through logout. Combined with the new URL→view sync effect,
    // the next user to log in on this device would land directly
    // on the previous user's last view (and admin tab if they
    // were admin) before our auth checks fired. Server-side guards
    // prevent data leakage, but the UX reads as a permissions bug.
    navigate('/')
  }, [navigate, closePlayer, forgetHeroLeadWait])

  // Cross-tab logout. A logout in another tab clears aurora_token
  // and fires a `storage` event here; we tear down the watch party
  // (its sockets now hold a revoked token), drop auth state, and
  // clear cached state so a re-login as a different user doesn't
  // briefly see the previous user's content.
  useEffect(() => {
    // A newer storage event aborts an older in-flight /me revalidation
    // so we always land on the most recent authoritative response.
    let meAc: AbortController | null = null
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'aurora_user' && !e.newValue) { // deep-debug H10 — tokens are cookies; aurora_user is the cross-tab logout signal
        meAc?.abort()
        // leave() sends a best-effort leave-party then closes both
        // sockets. Sending on a revoked token may silently fail
        // server-side, but the socket-close handler will GC the
        // participant entry anyway.
        party.leave()
        setUser(false)
        // Full state reset to match handleLogout — cross-tab logout
        // must clear rails/continueItems/etc. too.
        resetUserState()
        return
      }
      // Propagate aurora_user changes (profile edits, avatar updates)
      // from another tab so we don't show stale user data.
      if (e.key === 'aurora_user' && e.newValue) {
        // security — never trust the role (or anything) from the
        // localStorage blob: a tampered/stale value could flip this tab
        // into admin-UI mode. Re-fetch /api/auth/me and set the user from
        // the AUTHORITATIVE server response. Server-side authz remains the
        // real control; this just keeps the UI from widening privileges off
        // a cross-tab write. We still require a stored user (it's the
        // cross-tab auth signal) before applying the result, mirroring boot.
        meAc?.abort()
        const ac = new AbortController()
        meAc = ac
        fetchMe(ac.signal)
          .then(u => {
            if (ac.signal.aborted) return
            // A logout may have landed while /me was in flight — don't
            // re-authenticate off a stale response (mirrors the boot path).
            if (!getStoredUser()) return
            setUser(u)
          })
          .catch(err => {
            if (ac.signal.aborted || (err as Error)?.name === 'AbortError') return
            // /me failed (revoked/expired session) — drop to the auth
            // screen rather than keeping unverified state.
            setUser(false)
          })
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      meAc?.abort()
      window.removeEventListener('storage', onStorage)
    }
  }, [party, resetUserState])

  // Home rails fetch — pulls Recent / Top Rated Movies / Top Rated
  // Shows in parallel, with Discover + Anchor rails wrapped in
  // catch() so the base rails always render if the recommender is
  // down. retryNonce lets the Retry button re-run the effect with a
  // fresh AbortController.
  const [retryNonce, setRetryNonce] = useState(0)
  const requestHomeReload = useCallback(() => setRetryNonce(n => n + 1), [])
  // 2026-05-27 (PR #97 H2) — scoped nonce for refreshing ONLY the
  // Continue Watching list. Bumped on player close so the Resume CTA
  // on detail picks up the updated position_ms without triggering a
  // wasteful full home-rails refetch.
  const [cwReloadNonce, setCwReloadNonce] = useState(0)
  // Home is loaded once and then kept in state: the effect below is keyed on
  // [user, retryNonce, activeProfileId], none of which change when you navigate
  // away and back, and this component never unmounts. So a library scan that
  // adds titles was invisible until a hard refresh — the refresh worked only
  // because it remounted everything. This nonce re-runs the whole load on the
  // staleness gate (returning to Home or refocusing it after 30 s). A scan's
  // new titles take the lighter live catalog refresh below instead
  // (catalogVersion), which reloads only the catalog rails and the count.
  const [homeReloadNonce, setHomeReloadNonce] = useState(0)
  const lastHomeLoadRef = useRef(0)
  // Which profile the rails currently on screen belong to. Distinguishes a
  // profile switch (must wipe the personalized rails) from a same-profile
  // refresh (must not). null is a real value here — "the session's acting
  // profile" — so it starts undefined to force the first load down the
  // switch path.
  const railsProfileRef = useRef<number | null | undefined>(undefined)
  // Which user they belong to, for the same reason: a sign-in as another
  // account on this tab (after a logout, or a session that expired) is a
  // switch even when neither account has a profile and both read as null.
  const railsUserRef = useRef<number | null>(null)
  // Read by the focus listener below, which must not re-bind on every
  // navigation just to know where the user currently is. Written in an effect,
  // not during render — React 19 forbids the latter, and eslint enforces it.
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])
  const refreshHomeData = useCallback(() => setHomeReloadNonce(n => n + 1), [])
  // The catalog version (useCatalogVersion) Home's catalog rails reflect:
  // recorded by the full load (the version when it started) and by the live
  // catalog refresh below, which runs while Home shows and the rails are
  // behind.
  const homeRailsVersionRef = useRef(0)
  // Every catalog-rails fetch (the full load's and the live refresh's) takes
  // a number when it starts, and its rails land only if no later-started
  // fetch's have: the later one asked the server later, so its answer is at
  // least as fresh. Comparing versions alone let a refresh started before a
  // full load, at the same version, land after it and put back rails that
  // missed titles written in between.
  const homeRailsSeqRef = useRef(0)
  const homeRailsLandedSeqRef = useRef(0)

  // Returning to Home refetches only if the data has had time to go stale. A
  // quick tab bounce costs nothing; coming back later picks up anything a scan
  // (or another device) added. Deliberately not keyed on `view` alone, which
  // would re-run every core/CW/anchor/engagement fetch on every visit.
  useEffect(() => {
    if (!user || view !== 'home') return
    if (shouldRefreshHome({ view, signedIn: true, lastAttemptAt: lastHomeLoadRef.current, now: Date.now() })) {
      refreshHomeData()
    }
  }, [view, user, refreshHomeData])

  // The gate above needs a navigation to fire, so someone who leaves the tab
  // open on Home — or closes the lid and comes back — never picks anything up.
  // Re-checking on tab focus covers that. A scan's new titles reach everyone
  // through the live catalog refresh above; this also covers what that does
  // not refetch (Continue Watching, the personalized rails).
  useEffect(() => {
    if (!user) return
    const check = () => {
      if (document.visibilityState !== 'visible') return
      if (viewRef.current !== 'home') return
      if (shouldRefreshHome({
        view: viewRef.current, signedIn: true,
        lastAttemptAt: lastHomeLoadRef.current, now: Date.now(),
      })) refreshHomeData()
    }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [user, refreshHomeData])

  // ── Discover rails: progressive load + live "ready" handling ──────────
  // Personalized home rails arrive from several sources at different speeds:
  // anchor/engagement are fast (vector + first-party signals, no LLM); the
  // LLM-curated Discover rail can take 60s+ on a cold cache. We hold each
  // source in a ref and recompose the home layout whenever any lands, so a
  // slow Discover result splices in LIVE — fixing the bug where it only
  // appeared after a page refresh (the old code raced the fetch against a 12s
  // deadline and discarded anything slower).
  const coreRailsRef = useRef<NonNullable<HomeViewProps['rails']>>([])
  const discoverRailsRef = useRef<DiscoverRailUI[]>([])
  const anchorRailsRef = useRef<AnchorRailUI[]>([])
  const engagementRailsRef = useRef<EngagementRailUI[]>([])
  // Social phase 2 — "From People You Follow". The follow GRAPH is
  // account-level, but the feed is fetched per viewing profile because the
  // server applies the profile's parental ceiling (max_age_rating) to it
  // like every other home rail — so this ref IS wiped on profile switch
  // (an adult profile's R-rated feed cards must not splice into the kids
  // profile's home between recompose and refetch) and on user reset.
  const followingRailRef = useRef<FollowedWatch[]>([])
  // True while the server is still building the LLM Discover rail; arms the
  // discover_ready WS handler and the poll fallback effect below.
  const [discoverBuilding, setDiscoverBuilding] = useState(false)
  // True while a manual "Refresh picks" request is in flight (brief — the
  // endpoint is non-blocking; the rebuild itself shows via discoverBuilding).
  const [recsRefreshing, setRecsRefreshing] = useState(false)

  // Recompose homeRails from the core set + whatever personalized rails have
  // landed so far. Reads refs so it's a stable callback usable from the fetch
  // effect, the WS handler, the poll, and the manual refresh.
  const recomposeHomeRails = useCallback(() => {
    const core = withoutRemoved(coreRailsRef.current, removedFromHomeRef.current)
    if (!core || core.length === 0) return // core not loaded yet
    const personalized: NonNullable<HomeViewProps['rails']> = [
      // Friends first, algorithms after: the social rail leads the
      // personalized block because "alice watched this" beats "the model
      // thinks you'd like this" as a reason to care. Zero items (follows
      // nobody / nobody shares) → filtered out here, rail never renders.
      ...(followingRailRef.current.length > 0
        ? [{
            title: 'From People You Follow',
            items: followingRailRef.current.map(mapFollowedToMedia),
            aspect: 'poster' as const,
            subtitle: 'Recently watched by members you follow',
            cardSubtitles: followingRailRef.current.reduce<Record<number, string>>(
              (acc, w) => { acc[w.id] = followedWatchSubtitle(w); return acc }, {}),
          }]
        : []),
      ...discoverRailsRef.current
        .filter(r => r.items.length > 0)
        .map(r => ({ title: r.title, items: r.items as Media[], aspect: 'poster' as const,
          aiPick: true, subtitle: r.description || undefined })),
      ...anchorRailsRef.current
        .filter(r => r.items.length > 0)
        .map(r => ({ title: r.title, items: r.items as Media[], aspect: 'poster' as const,
          aiPick: true, subtitle: 'more like the titles you finished' })),
      ...engagementRailsRef.current
        .filter(r => r.items.length > 0)
        .map(r => ({ title: r.title, items: r.items as Media[], aspect: 'poster' as const,
          aiPick: true, subtitle: r.description || 'what viewers here actually finish' })),
    ]
    if (personalized.length === 0) { setHomeRails(core); return }
    // Splice personalized rails between Recently Added (index 0) and the Top
    // Rated rails — same visual order the original effect produced.
    setHomeRails([core[0], ...withoutRemoved(personalized, removedFromHomeRef.current), ...core.slice(1)])
  }, [])

  // Re-fetch the Discover endpoint and splice the rails in. Shared by the
  // discover_ready WS push and the manual "Refresh picks" action. `refresh`
  // forces a server-side rebuild (?refresh=1).
  const refetchDiscover = useCallback(async (profileId: number | null, refresh = false) => {
    // Never for a profile with a content limit, which is shown none of them.
    if (navScopeRef.current === 'restricted') return
    try {
      const { rails, building } = await getDiscoverRails(profileId ?? undefined, undefined, refresh)
      if (rails.length > 0) {
        discoverRailsRef.current = rails
        recomposeHomeRails()
        setDiscoverBuilding(false)
      } else {
        // Empty result: keep waiting if the server is still building, otherwise
        // it's terminal (cold-start / LLM off) — stop the poll + spinner.
        setDiscoverBuilding(building)
      }
    } catch { /* best-effort; the poll fallback / next event covers us */ }
  }, [recomposeHomeRails])

  // Stage 3 — manual "Refresh picks": force a server rebuild, then let the
  // discover_ready push / poll deliver the fresh rails.
  const handleRefreshRecs = useCallback(async () => {
    if (!personalProfileReady) return
    setRecsRefreshing(true)
    addToast('Refreshing your picks…', 'info')
    await refetchDiscover(activeProfileId, true)
    setRecsRefreshing(false)
  }, [activeProfileId, personalProfileReady, refetchDiscover, addToast])

  useEffect(() => {
    if (!user || !catalogProfileSettled) return
    const ac = new AbortController()
    let cancelled = false
    ;(async () => {
      // The rails on screen belong to another profile (or none yet).
      // The catalog version this load's catalog rails reflect at most: an
      // update arriving while it is out leaves them behind, and the live
      // refresh catches up once they land.
      const loadVersion = catalogVersionRef.current
      const railsSeq = ++homeRailsSeqRef.current
      const profileChanged = shouldResetPersonalizedRails(railsProfileRef.current, activeProfileId) ||
        railsUserRef.current !== user.id
      // Cold = nothing on screen yet. Captured BEFORE the attempt stamp below,
      // because that stamp is what makes a load stop looking cold. A profile
      // switch is cold too: the previous profile's rails come down now, not
      // when the new ones land, so a slow or failed load shows the skeleton or
      // the error rather than titles fetched under the old profile's ceiling.
      const cold = lastHomeLoadRef.current === 0 || profileChanged
      if (profileChanged) {
        setHomeRails(undefined)
        removedFromHomeRef.current = new Set()
        // No owner's rails are on screen until this load's land, so a live
        // refresh for the previous owner that lands meanwhile fails its owner
        // check rather than relying on its abort alone.
        railsProfileRef.current = undefined
        railsUserRef.current = null
        coreRailsRef.current = []
        discoverRailsRef.current = []
        anchorRailsRef.current = []
        engagementRailsRef.current = []
        followingRailRef.current = []
        setDiscoverBuilding(false)
      }
      // Stamp on ATTEMPT, not on success. Stamping only after the fetch
      // resolved left the staleness gate armed for the whole load, so every return
      // to Home during a slow one aborted and restarted it — six bounces during
      // an 8s load completed zero times and left Home silently rail-less, which
      // is worse than the staleness this fixes.
      lastHomeLoadRef.current = Date.now()
      // Only show the skeleton on a COLD load. A stale-gated or scan-triggered
      // refetch happens under rails the user is already looking at, and
      // blanking them to a loading state would be a worse flicker than the
      // staleness it fixes.
      if (cold) setHomeLoading(true)
      // Likewise only clear a visible error on a cold load: wiping it here on a
      // background refresh would flash the banner off and back on.
      if (cold) setHomeError(null)
      try {
        // QA 2026-05-25 — the original effect awaited all five fetches
        // (core + discover + anchor) in one Promise.all. discover/
        // anchor were wrapped in `.catch(() => [])` so individual
        // failures were tolerated, BUT a HANGING discover (production
        // observed: /api/me/discover stuck pending after a cold-load
        // 503 retry) kept Promise.all from settling — even though
        // .catch only catches REJECTIONS, not stalls. Result: rails
        // array never set, Home page showed only Continue Watching
        // until the user navigated away and back.
        //
        // New shape:
        //   1. Await ONLY the three core rails. These must succeed for
        //      the home to be useful.
        //   2. Render rails immediately with the core trio.
        //   3. Fire discover + anchor with their own timeouts, race
        //      against a deadline, and splice into rails when they
        //      land. If they never land, the user keeps the core
        //      experience instead of staring at Continue Watching.
        const [recent, movies, shows] = await Promise.all([
          listRecent(12, ac.signal),
          listMedia({ type: 'movie', perPage: 20, sortBy: 'rating', signal: ac.signal }),
          listMedia({ type: 'show', perPage: 20, sortBy: 'rating', signal: ac.signal }),
        ])
        if (cancelled) return

        // The catalog's stand-in hero, recorded whether or not the pool
        // has picks (it shows only when the slate has no entry).
        // Not from a background load whose rails a later-started fetch has
        // already beaten (it would put an older title back as the hero).
        if (cold || railsSeq > homeRailsLandedSeqRef.current) {
          const hero = (recent[0] || movies[0] || null) as Media | null
          if (hero) setHomeHero(hero)
        }

        // Build the core rail set (no personalized yet). Order is the
        // same as the final shape so the personalized splice below
        // can insert between Recently Added and Top Rated Movies
        // without re-ordering.
        const coreRails = coreHomeRails(recent as Media[], movies as Media[], shows as Media[])
        // Re-stamp on success so the freshness window runs from when the data
        // actually landed rather than from when we started asking for it.
        lastHomeLoadRef.current = Date.now()
        railsProfileRef.current = activeProfileId
        railsUserRef.current = user.id
        // A live refresh that landed while this load was out has newer
        // catalog rails; a background load keeps them rather than putting the
        // older ones back (the new titles would vanish for a round trip).
        if (cold || railsSeq > homeRailsLandedSeqRef.current) {
          coreRailsRef.current = coreRails
          homeRailsVersionRef.current = loadVersion
          homeRailsLandedSeqRef.current = railsSeq
        }
        // A cold load (a profile switch included) shows the core rails alone;
        // the personalized ones splice in as they land. A background refresh
        // of the same profile instead puts the fresh core rails under the
        // personalized ones already on screen: setting the core set alone took
        // every AI rail off the page until its fetch below came back, which a
        // scan in progress now does every ten seconds.
        if (!cold && personalProfileReady) recomposeHomeRails()
        else setHomeRails(withoutRemoved(coreRailsRef.current, removedFromHomeRef.current))
        // Core rails are visible. Clear the loading state now so the
        // spinner doesn't linger waiting on the personalized rails.
        setHomeLoading(false)

        // Phase 2: personalized rails — loaded PROGRESSIVELY. We never discard
        // a slow result (the old 12s race did, which is exactly why the
        // LLM-curated Discover rail only appeared after a page refresh). Core
        // rails already render above; each personalized source splices in via
        // recomposeHomeRails() when it lands.
        //
        // Stash the core set. The personalized buffers are wiped ONLY when the
        // rails on screen belong to a different profile — that is what the
        // wipe was for: stopping a profile switch from splicing the previous
        // profile's picks. On a same-profile refresh (staleness gate, scan
        // completion) wiping would yank every AI PICK / Discover / anchor rail
        // off the page for a round-trip and collapse the layout — a bigger
        // flicker than the one the skeleton suppression above avoids, on the
        // most-visited screen in the app. Keeping them lets recomposeHomeRails
        // splice the fresh core in underneath, and each personalized source
        // overwrites its own buffer as it re-resolves. (The core set is
        // stashed above, before the rails are set.)
        if (profileChanged) {
          discoverRailsRef.current = []
          anchorRailsRef.current = []
          engagementRailsRef.current = []
          followingRailRef.current = []
          // Cancel any in-flight build poll — it belongs to the old profile.
          // NOT reset on a same-profile refresh: doing so tore down the poll
          // fallback while the replacement getDiscoverRails could still fail
          // into a swallowed catch, losing an already-rendered Discover rail
          // until a full page reload.
          setDiscoverBuilding(false)
        }
        if (!personalProfileReady) return
        // A profile with a content limit is shown none of the recommender's
        // rails (its Tonight is what it started, its list and two shelves),
        // so they are not asked for: the Discover rails are a model build on
        // the server, for nothing. Read from a ref: the rails are not loaded
        // again because a limit changed.
        if (navScopeRef.current === 'restricted') return

        // Fast rails (pure vector + first-party engagement signals, no LLM).
        // Fire-and-forget: splice in as soon as they resolve, AbortController
        // still cancels them on navigate/profile-switch.
        void Promise.all([
          getAnchorRails(activeProfileId ?? undefined, ac.signal).catch(() => []),
          getEngagementRails(activeProfileId ?? undefined, ac.signal).catch(() => []),
          // Social rail (phase 2): one indexed query server-side, so it
          // rides the fast batch. Profile id threads through so the
          // server applies this profile's parental ceiling. Empty for
          // members who follow nobody — recompose filters zero-item rails.
          getFollowingRecent(activeProfileId ?? undefined, ac.signal).catch(() => []),
        ]).then(([a, e, f]) => {
          if (cancelled) return
          anchorRailsRef.current = a
          engagementRailsRef.current = e
          followingRailRef.current = f
          recomposeHomeRails()
        })

        // Slow rail (LLM-curated Discover). The endpoint is non-blocking: a
        // warm cache returns rails immediately; a cold cache returns
        // {building:true} with no rails and kicks a server-side build that
        // notifies us via the discover_ready WS push (poll fallback below).
        // Either way the result splices in without a refresh.
        void getDiscoverRails(activeProfileId ?? undefined, ac.signal)
          .then(({ rails, building }) => {
            if (cancelled) return
            if (rails.length > 0) {
              discoverRailsRef.current = rails
              recomposeHomeRails()
            } else if (building) {
              setDiscoverBuilding(true) // arms the WS handler + poll fallback
            }
          })
          .catch(() => { /* best-effort; core rails already render */ })
      } catch (err) {
        if (cancelled) return
        if (err && (err as Error).name === 'AbortError') return
        // Only surface an error when there is nothing on screen. A background
        // refresh that blips would otherwise paint "Couldn't load your library"
        // above a perfectly good Home.
        if (cold) setHomeError(err instanceof Error ? err.message : 'Unknown error')
        else console.warn('[Aurora] background home refresh failed', err)
      } finally {
        // Note: setHomeLoading(false) for the success path now runs
        // earlier, right after the core rails land. This finally
        // block still covers the error path (catch above sets
        // homeError; we want the spinner off).
        if (!cancelled) setHomeLoading(false)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [user, retryNonce, activeProfileId, personalProfileReady, homeReloadNonce, catalogProfileSettled, catalogVersionRef])

  // The live catalog refresh (lib/catalogUpdates.ts): while Home shows and
  // its catalog rails are behind catalogVersion, the three catalog rails and
  // Home's library count are fetched again, and the rails recomposed under
  // the personalized rails already on screen. Never the hero, Continue
  // Watching or the personalized rails: running the whole Home load per
  // update reset the hero carousel to its first pick every ten seconds of an
  // import and sent about ten requests per open Home, some of them uncached
  // vector and LLM work. The hero is set only when there is none, as on a
  // first import into an empty library.
  //
  // Only under rails this user and profile already have up: a cold, failed or
  // switching Home is the full load's to fill, and when its rails land
  // (homeRails) this runs again if they are behind. One refresh at a time: an
  // update arriving mid-refresh does not abort it (that starved refreshes on
  // a busy server); once it lands the rails are still behind, and this runs
  // again. A change of user, profile or startup settle, or a switch's first
  // commit, aborts it (the effect below), and each answer is checked against
  // the rails' owner before it lands. No refresh starts while a switch or a
  // PIN prompt is out (isSwitching), and an answer that comes back while one
  // is out, or once one has started since it was asked (switchGeneration), is
  // dropped: the server may have answered it for a profile other than the one
  // still named, either one a switch has bound that this tab does not show
  // yet, or one bound in between by a switch that then ended on the profile
  // already shown (another tab binding that back before this tab read the
  // binding). In that second case, landing after the switch has ended, nothing
  // else catches it: nothing is switching, no commit names a new profile, and
  // the owner still matches. The isSwitching half of the drop adds nothing
  // today (a refresh out during a switch began before it, so the generation
  // has moved too) and is kept in case the flag is ever set without a bump. An
  // answer that lands, and is dropped, after a switch that ended on the
  // profile already shown is re-checked at once (homeRefreshRetry). For one
  // dropped while the switch was out, the retry's re-run normally returns at
  // the start guard, and what re-checks it is closing the prompt (pinTarget)
  // or the new profile's load, or, after a switch with no prompt that fails
  // and stays on the profile shown, or whose binding read returns that
  // profile, nothing until something else re-runs this, such as the next
  // update or showing, a full Home load, a recompose that changes the rails,
  // or a 👎 or an admin delete (a known gap in CLAUDE.md). A re-check starts a
  // refresh only while the rails or the count is behind (and then asks for
  // both). The count is recorded as asked when a refresh starts
  // (homeCountVersionRef), so a switch drop puts it back to the version it was
  // asked at before, unless a later request has asked for it since: left as
  // asked, once the rails had caught up to that version (a full load from it
  // landed meanwhile, or only the count was behind), no re-check asked for the
  // count again, and a stale count stayed until the next update. Where a
  // switch changes the profile shown, the new profile's load fills Home.
  // Closing the prompt also re-runs this, so a refresh the start guard refused
  // while it was open starts if Home is still behind. Off Home it waits: the
  // next showing (view) catches up. A failed refresh leaves the rails behind
  // until the next update, showing or recompose.
  // The library count is tracked apart (homeCountVersionRef): its own effect
  // asks once per user and profile, and only this refresh keeps it current,
  // so a refresh also runs when the count alone is behind (a full load does
  // not ask for it).
  const homeRefreshAcRef = useRef<AbortController | null>(null)
  // Home's library count is asked for by its own effect (per user and
  // profile) and by this refresh; every request takes a number, and an answer
  // lands only if no later-asked one has, so an older answer arriving last
  // cannot put an older count back.
  const homeCountSeqRef = useRef(0)
  const homeCountAppliedRef = useRef(0)
  // The catalog version the count was last ASKED at, recorded when the request
  // starts (by this refresh or the count effect), not when an answer lands:
  // recorded on landing, a count request that kept failing left it behind, and
  // every recompose ran another full refresh, in a tight loop. A failed count
  // waits for the next update. A switch drop puts back the version its refresh
  // replaced here (see the refresh's comment above).
  const homeCountVersionRef = useRef(0)
  // Bumped when a refresh's answer is dropped: its rails because a
  // later-started fetch (a full load) landed first, or all of it because a
  // profile switch has started since it was asked. Neither sets anything the
  // effect depends on (a recompose can set the very array already on screen),
  // so without this Home's rails could stay a version behind, and after a
  // switch drop its count too (see the refresh's comment above).
  const [homeRefreshRetry, setHomeRefreshRetry] = useState(0)
  useEffect(() => () => {
    homeRefreshAcRef.current?.abort()
    homeRefreshAcRef.current = null
  }, [realtimeUserId, catalogProfileSettled, activeProfileId, profileSwitchPending])
  useEffect(() => {
    if (view !== 'home' || realtimeUserId === null || !catalogProfileSettled || profileSwitchPending) return
    if (homeRefreshAcRef.current) return
    if (homeRailsVersionRef.current === catalogVersion && homeCountVersionRef.current === catalogVersion) return
    if (coreRailsRef.current.length === 0 || railsProfileRef.current !== activeProfileId ||
      railsUserRef.current !== realtimeUserId) return
    if (isProfileSwitching()) return
    const version = catalogVersion
    const countKey = `${realtimeUserId}:${activeProfileId}`
    const countSeq = ++homeCountSeqRef.current
    const countAskedBefore = homeCountVersionRef.current
    homeCountVersionRef.current = version
    const railsSeq = ++homeRailsSeqRef.current
    const switchGen = profileSwitchGeneration()
    const ac = new AbortController()
    homeRefreshAcRef.current = ac
    const stopTimeout = abortAfter(ac)
    Promise.all([
      listRecent(12, ac.signal),
      listMedia({ type: 'movie', perPage: 20, sortBy: 'rating', signal: ac.signal }),
      listMedia({ type: 'show', perPage: 20, sortBy: 'rating', signal: ac.signal }),
      // Home's library count, the greeting's "titles in your library". Its
      // own effect asks once per user and profile; this keeps it current.
      listMediaWithTotal({ perPage: 1, signal: ac.signal }).catch(() => null),
    ])
      .then(([recent, movies, shows, count]) => {
        stopTimeout()
        if (homeRefreshAcRef.current !== ac) return
        homeRefreshAcRef.current = null
        if (railsProfileRef.current !== activeProfileId || railsUserRef.current !== realtimeUserId) return
        // A switch has started since this was asked, so it may be another
        // profile's answer (see above). The retry re-runs this effect, which
        // returns at the start guard while a switch or prompt is out; a
        // refresh it does start records the current generation, so this cannot
        // loop. The count goes with the rest, so it is put back to the version
        // it was asked at before this, and the re-check asks for it again if
        // that is behind. The check for a later count request is defensive:
        // the count's own effect re-runs only on a change of user, profile or
        // settle, which aborts this refresh first.
        if (isProfileSwitching() || profileSwitchGeneration() !== switchGen) {
          if (homeCountSeqRef.current === countSeq) homeCountVersionRef.current = countAskedBefore
          setHomeRefreshRetry(n => n + 1)
          return
        }
        if (count && countSeq > homeCountAppliedRef.current) {
          homeCountAppliedRef.current = countSeq
          setHomeLibraryCount({ key: countKey, total: count.total })
        }
        // A full load that started later landed first: its rails are newer.
        // Check again, since they can still be behind the latest version.
        if (railsSeq < homeRailsLandedSeqRef.current) { setHomeRefreshRetry(n => n + 1); return }
        homeRailsVersionRef.current = version
        homeRailsLandedSeqRef.current = railsSeq
        coreRailsRef.current = coreHomeRails(recent as Media[], movies as Media[], shows as Media[])
        recomposeHomeRails()
        if (!homeHeroRef.current) {
          const hero = (recent[0] || movies[0] || null) as Media | null
          if (hero) setHomeHero(hero)
        }
      })
      .catch(() => {
        // Background refresh (or one past LIVE_REFRESH_TIMEOUT_MS): the rails
        // on screen stay.
        stopTimeout()
        if (homeRefreshAcRef.current === ac) homeRefreshAcRef.current = null
        ac.abort()
      })
  }, [view, realtimeUserId, catalogProfileSettled, profileSwitchPending, activeProfileId, catalogVersion, homeRails, homeRefreshRetry, recomposeHomeRails, isProfileSwitching, profileSwitchGeneration, pinTarget])

  // Stage 2 fallback — if the Discover build is in progress and the
  // discover_ready WS push never arrives (socket down, missed event), poll the
  // non-blocking endpoint until the rails land or we hit the cap. The WS
  // handler clears discoverBuilding the moment a push is handled, tearing this
  // down early; a profile switch (activeProfileId) re-runs it cleanly.
  useEffect(() => {
    if (!user || !discoverBuilding) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const ac = new AbortController()
    let attempts = 0
    const MAX_ATTEMPTS = 20 // ~20 × 5s = 100s, comfortably past the 60s LLM budget
    const POLL_MS = 5000
    const tick = async () => {
      if (cancelled) return
      attempts += 1
      try {
        const { rails, building } = await getDiscoverRails(activeProfileId ?? undefined, ac.signal)
        if (cancelled) return
        if (rails.length > 0) {
          discoverRailsRef.current = rails
          recomposeHomeRails()
          setDiscoverBuilding(false)
          return
        }
        if (!building) { setDiscoverBuilding(false); return } // terminal (empty)
      } catch {
        if (cancelled) return // network blip — fall through and retry
      }
      if (attempts >= MAX_ATTEMPTS) { setDiscoverBuilding(false); return }
      timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      cancelled = true
      ac.abort()
      if (timer) clearTimeout(timer)
    }
  }, [user, discoverBuilding, activeProfileId, recomposeHomeRails])

  // Movies list — fetch on first visit, cache for the session.
  // Shows uses the same pattern below.
  // QA Batch B 2026-05-25 — popovers auto-close on route change.
  // Both Notifications + Server Status drawers anchor to the sidebar
  // trigger but their open state was independent of `view`, so they
  // floated over new pages until the user manually clicked them shut.
  useEffect(() => {
    setNotifOpen(false)
    setServerOpen(false)
  }, [view])

  useEffect(() => {
    if (!user || view !== 'movies' || moviesList !== null || !catalogProfileSettled) return
    let cancelled = false
    const ac = new AbortController()
    // The catalog version this page reflects (see the live refresh below).
    const version = catalogVersionRef.current
    // Server-side sort + genre — single source of truth. Client-side
    // sort can't cope with pagination (items 101+ arrive in server
    // order and concat after a re-sorted page 1). Genre is now also
    // server-side so the (genre, sort) combo paginates correctly and
    // total counts reflect the real catalog, not the loaded page.
    listMediaWithTotal({
      type: 'movie', perPage: BROWSE_PER_PAGE, sortBy: moviesSort,
      genre: moviesGenre || undefined, signal: ac.signal,
    })
      .then(({ items, total, page }) => {
        if (cancelled) return
        moviesCatalogVersionRef.current = version
        setMoviesList(items as Media[])
        setMoviesTotal(total)
        // Trust the server's returned page number, then advance.
        setMoviesNextPage(page + 1)
      })
      .catch(err => {
        if (cancelled || (err && err.name === 'AbortError')) return
        const id = nextToastId()
        setToasts(prev => [...prev, { id, message: 'Failed to load movies', type: 'error' }])
      })
    return () => { cancelled = true; ac.abort() }
    // moviesSort + moviesGenre included in deps so changes (which
    // clear moviesList to null via the handlers below) re-run this
    // effect with the new filter set.
    // activeProfileId too: a first page still in flight when the profile
    // changes is aborted and fetched again (the reset leaves a null list
    // null, which alone would not re-run this).
  }, [user, view, moviesList, moviesSort, moviesGenre, nextToastId, activeProfileId, catalogProfileSettled, catalogVersionRef])

  // One-time fetch of the canonical genre catalog per browse view.
  // Doesn't need to re-fire on sort/page changes — genre set doesn't
  // shift with pagination. Only re-fetches when the user navigates
  // back into the view fresh (moviesGenres === null reset).
  useEffect(() => {
    if (!user || view !== 'movies' || moviesGenres !== null) return
    let cancelled = false
    const ac = new AbortController()
    listGenres('movie', ac.signal)
      .then(gs => { if (!cancelled) { setMoviesGenres(gs); setGenresFailed(f => (f.movie ? { ...f, movie: false } : f)) } })
      // The control is then drawn from the loaded titles' own genres.
      .catch(() => { if (!cancelled) setGenresFailed(f => (f.movie ? f : { ...f, movie: true })) })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, moviesGenres])

  useEffect(() => {
    if (!user || view !== 'shows' || showsList !== null || !catalogProfileSettled) return
    let cancelled = false
    const ac = new AbortController()
    const version = catalogVersionRef.current
    listMediaWithTotal({
      type: 'show', perPage: BROWSE_PER_PAGE, sortBy: showsSort,
      genre: showsGenre || undefined, signal: ac.signal,
    })
      .then(({ items, total, page }) => {
        if (cancelled) return
        showsCatalogVersionRef.current = version
        setShowsList(items as Media[])
        setShowsTotal(total)
        setShowsNextPage(page + 1)
      })
      .catch(err => {
        if (cancelled || (err && err.name === 'AbortError')) return
        const id = nextToastId()
        setToasts(prev => [...prev, { id, message: 'Failed to load shows', type: 'error' }])
      })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, showsList, showsSort, showsGenre, nextToastId, activeProfileId, catalogProfileSettled, catalogVersionRef])

  useEffect(() => {
    if (!user || view !== 'shows' || showsGenres !== null) return
    let cancelled = false
    const ac = new AbortController()
    listGenres('show', ac.signal)
      .then(gs => { if (!cancelled) { setShowsGenres(gs); setGenresFailed(f => (f.show ? { ...f, show: false } : f)) } })
      .catch(() => { if (!cancelled) setGenresFailed(f => (f.show ? f : { ...f, show: true })) })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, showsGenres])

  // Live refresh: a scan added titles since this grid's list was loaded
  // (lib/catalogUpdates.ts). On screen, every loaded page is refetched (a few
  // at a time) and swapped in, so new titles take their place in the current
  // sort and the Load More cursor still matches the server; nothing blanks and
  // the scroll position holds. Off screen it waits for the next visit, which
  // shows the cached list and then refreshes it.
  //
  // One refresh at a time per grid: an update arriving mid-refresh does not
  // abort it (on a busy server that starved every refresh until the scan
  // ended); once it lands the list is still behind, and this runs again. It
  // waits for a Load More in flight, and a Load More started meanwhile aborts
  // it (a refresh landing after would drop the appended page); so does a
  // change of user, profile, sort or genre (the abort effect below), which
  // also makes the list null or refetches it. A switch's first commit
  // (profileSwitchPending, before the reset has run) aborts it and starts
  // nothing, so a refresh cannot land the previous profile's titles after the
  // reset, as with the first page above. A list deeper than
  // CATALOG_REFRESH_MAX_PAGES is left as it is: stale until a sort or genre
  // change or a reload, rather than dropped, which lost the reader's place. A
  // failed refresh keeps the list; the next update or visit tries again.
  // No refresh starts while a profile switch or a PIN prompt is out, and an
  // answer that comes back while one is out, or once one has started since it
  // was asked, is dropped, as on Home (see the Home refresh's comment for why,
  // and why its isSwitching half is kept). One that lands, and is dropped,
  // after a switch that ended on the profile already shown is re-checked at
  // once (gridRefreshRetry). One dropped while it was out, or a refresh the
  // start guard kept from starting, waits for the prompt to close (pinTarget
  // runs this again) or, on a profile change, the grid's reset; after a switch
  // with no prompt that fails and stays on the profile shown, or whose binding
  // read returns that profile, nothing re-checks it until something else
  // re-runs this, such as the next update or visit, a Load More, a sort or
  // genre change or an admin delete (a known gap in CLAUDE.md). Off screen it
  // waits for the next visit. A grid records its version only when an answer
  // lands, so a dropped one leaves it behind for the re-check.
  const moviesRefreshAcRef = useRef<AbortController | null>(null)
  const showsRefreshAcRef = useRef<AbortController | null>(null)
  // Bumped when a grid refresh's answer is dropped for a profile switch, so
  // the grid is re-checked (see above for when that runs).
  const [gridRefreshRetry, setGridRefreshRetry] = useState(0)
  useEffect(() => () => {
    moviesRefreshAcRef.current?.abort()
    moviesRefreshAcRef.current = null
  }, [realtimeUserId, catalogProfileSettled, activeProfileId, profileSwitchPending, moviesSort, moviesGenre])
  useEffect(() => () => {
    showsRefreshAcRef.current?.abort()
    showsRefreshAcRef.current = null
  }, [realtimeUserId, catalogProfileSettled, activeProfileId, profileSwitchPending, showsSort, showsGenre])

  useEffect(() => {
    if (!user || !catalogProfileSettled || moviesList === null || profileSwitchPending) return
    if (moviesCatalogVersionRef.current === catalogVersion || moviesLoadingMore || moviesRefreshAcRef.current) return
    const pages = loadedPageCount(moviesList.length, BROWSE_PER_PAGE)
    if (view !== 'movies' || pages > CATALOG_REFRESH_MAX_PAGES || isProfileSwitching()) return
    const version = catalogVersion
    const ac = new AbortController()
    moviesRefreshAcRef.current = ac
    const stopTimeout = abortAfter(ac)
    const switchGen = profileSwitchGeneration()
    refetchLoadedPages(page => listMediaWithTotal({
      type: 'movie', perPage: BROWSE_PER_PAGE, page, sortBy: moviesSort,
      genre: moviesGenre || undefined, signal: ac.signal,
    }), pages)
      .then(({ items, total, nextPage }) => {
        stopTimeout()
        if (moviesRefreshAcRef.current !== ac) return
        moviesRefreshAcRef.current = null
        // A switch has started since this was asked, so it may be another
        // profile's answer (see Home's refresh). The retry re-checks at once
        // only if the switch has ended (see above).
        if (isProfileSwitching() || profileSwitchGeneration() !== switchGen) { setGridRefreshRetry(n => n + 1); return }
        moviesCatalogVersionRef.current = version
        setMoviesList(items as Media[])
        setMoviesTotal(total)
        setMoviesNextPage(nextPage)
      })
      .catch(() => {
        // Background refresh: keep the list on screen. Pages still out are
        // abandoned with it.
        stopTimeout()
        if (moviesRefreshAcRef.current === ac) moviesRefreshAcRef.current = null
        ac.abort()
      })
  }, [user, catalogProfileSettled, moviesList, catalogVersion, view, moviesLoadingMore, moviesSort, moviesGenre, BROWSE_PER_PAGE, profileSwitchPending, isProfileSwitching, profileSwitchGeneration, pinTarget, gridRefreshRetry])

  useEffect(() => {
    if (!user || !catalogProfileSettled || showsList === null || profileSwitchPending) return
    if (showsCatalogVersionRef.current === catalogVersion || showsLoadingMore || showsRefreshAcRef.current) return
    const pages = loadedPageCount(showsList.length, BROWSE_PER_PAGE)
    if (view !== 'shows' || pages > CATALOG_REFRESH_MAX_PAGES || isProfileSwitching()) return
    const version = catalogVersion
    const ac = new AbortController()
    showsRefreshAcRef.current = ac
    const stopTimeout = abortAfter(ac)
    const switchGen = profileSwitchGeneration()
    refetchLoadedPages(page => listMediaWithTotal({
      type: 'show', perPage: BROWSE_PER_PAGE, page, sortBy: showsSort,
      genre: showsGenre || undefined, signal: ac.signal,
    }), pages)
      .then(({ items, total, nextPage }) => {
        stopTimeout()
        if (showsRefreshAcRef.current !== ac) return
        showsRefreshAcRef.current = null
        // A switch has started since this was asked, so it may be another
        // profile's answer (see Home's refresh). The retry re-checks at once
        // only if the switch has ended (see above).
        if (isProfileSwitching() || profileSwitchGeneration() !== switchGen) { setGridRefreshRetry(n => n + 1); return }
        showsCatalogVersionRef.current = version
        setShowsList(items as Media[])
        setShowsTotal(total)
        setShowsNextPage(nextPage)
      })
      .catch(() => {
        stopTimeout()
        if (showsRefreshAcRef.current === ac) showsRefreshAcRef.current = null
        ac.abort()
      })
  }, [user, catalogProfileSettled, showsList, catalogVersion, view, showsLoadingMore, showsSort, showsGenre, BROWSE_PER_PAGE, profileSwitchPending, isProfileSwitching, profileSwitchGeneration, pinTarget, gridRefreshRetry])

  // Load More handlers — append the next page. Page state lives at
  // App level so the math survives navigating away and back mid-
  // pagination.
  const handleLoadMoreMovies = useCallback(async () => {
    if (!moviesList || moviesTotal == null || moviesLoadingMore) return
    if (moviesList.length >= moviesTotal) return
    // Not while a profile switch or its PIN prompt is out, and an answer is
    // dropped if one has started since it was asked: the server may have
    // answered it for a profile other than the one this tab still names. The
    // live refresh has had this guard; Load More had a narrow window for a
    // press, and a jump to a letter (which asks by itself) made it wide.
    if (isProfileSwitching()) return
    const switchGen = profileSwitchGeneration()
    // A live refresh landing after this would replace the list without the
    // page appended here; it runs again once this page has landed.
    moviesRefreshAcRef.current?.abort()
    moviesRefreshAcRef.current = null
    // Defensive: abort any prior in-flight Load More.
    moviesLoadMoreAcRef.current?.abort()
    const ac = new AbortController()
    moviesLoadMoreAcRef.current = ac
    // Capture the sort at request time. If sort changes mid-flight,
    // this generation will be aborted before the response can write.
    const sortAtFetch = moviesSort
    const genreAtFetch = moviesGenre
    const pageToFetch = moviesNextPage
    setMoviesLoadingMore(true)
    try {
      const { items, page } = await listMediaWithTotal({
        type: 'movie', perPage: BROWSE_PER_PAGE, page: pageToFetch, sortBy: sortAtFetch,
        genre: genreAtFetch || undefined, signal: ac.signal,
      })
      // Audit HIGH-2 — second guard: if the controller has been
      // swapped (sort change replaced the ref), discard the result
      // even though the request itself wasn't aborted in time.
      if (moviesLoadMoreAcRef.current !== ac) return
      if (isProfileSwitching() || profileSwitchGeneration() !== switchGen) return
      setMoviesList(prev => [...(prev ?? []), ...(items as Media[])])
      // Audit HIGH-1 — advance the cursor from server's page field,
      // not derived from list length. Survives variable page sizes.
      setMoviesNextPage(page + 1)
    } catch (err) {
      // Don't surface a toast for aborted requests — the user
      // changed sort or navigated away, the error is expected.
      if ((err as Error)?.name === 'AbortError') return
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Failed to load more movies', type: 'error' }])
    } finally {
      // Only clear the loading flag if THIS callback still owns
      // the controller. Otherwise a later sort change has already
      // resumed and we'd flip its flag prematurely.
      if (moviesLoadMoreAcRef.current === ac) {
        setMoviesLoadingMore(false)
        moviesLoadMoreAcRef.current = null
      }
    }
  }, [moviesList, moviesTotal, moviesLoadingMore, moviesSort, moviesGenre, moviesNextPage, nextToastId, isProfileSwitching, profileSwitchGeneration])

  const handleLoadMoreShows = useCallback(async () => {
    if (!showsList || showsTotal == null || showsLoadingMore) return
    if (showsList.length >= showsTotal) return
    // As for the Movies grid, above.
    if (isProfileSwitching()) return
    const switchGen = profileSwitchGeneration()
    showsRefreshAcRef.current?.abort()
    showsRefreshAcRef.current = null
    showsLoadMoreAcRef.current?.abort()
    const ac = new AbortController()
    showsLoadMoreAcRef.current = ac
    const sortAtFetch = showsSort
    const genreAtFetch = showsGenre
    const pageToFetch = showsNextPage
    setShowsLoadingMore(true)
    try {
      const { items, page } = await listMediaWithTotal({
        type: 'show', perPage: BROWSE_PER_PAGE, page: pageToFetch, sortBy: sortAtFetch,
        genre: genreAtFetch || undefined, signal: ac.signal,
      })
      if (showsLoadMoreAcRef.current !== ac) return
      if (isProfileSwitching() || profileSwitchGeneration() !== switchGen) return
      setShowsList(prev => [...(prev ?? []), ...(items as Media[])])
      setShowsNextPage(page + 1)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Failed to load more shows', type: 'error' }])
    } finally {
      if (showsLoadMoreAcRef.current === ac) {
        setShowsLoadingMore(false)
        showsLoadMoreAcRef.current = null
      }
    }
  }, [showsList, showsTotal, showsLoadingMore, showsSort, showsGenre, showsNextPage, nextToastId, isProfileSwitching, profileSwitchGeneration])

  // Sort-change handlers. Setting null on the items list triggers
  // the fetch effect above to re-run with the new sort, fetching
  // page 1. The total is also cleared so the "Showing N of TOTAL"
  // banner doesn't show a mismatched stale count during the
  // refetch window. Audit HIGH-2 — also abort any in-flight Load
  // More + reset the nextPage cursor so a fresh sort always starts
  // at page 1.

  // A grid sorted by title has an A to Z strip (LetterStrip). A letter that
  // is further on than the loaded pages is reached by asking for the next
  // ones, through the handlers above: the requests "Load more" makes. Each
  // grid's jump reads its list only while its page is on screen and settled,
  // so leaving the page, another sort or genre, or a profile switch drops a
  // jump that is still loading.
  const revealInGrid = useCallback((m: Media) => {
    const card = document.querySelector<HTMLElement>(`[data-browse-layout] [data-media-id="${m.id}"]`)
    if (!card) return
    // To the top, under the chrome and the strip (the page's scroll padding).
    card.scrollIntoView?.({ block: 'start' })
    // And the keyboard's place with it: Tab goes on from this title.
    const control = card.matches('[tabindex]') ? card : card.querySelector<HTMLElement>('button')
    control?.focus({ preventScroll: true })
  }, [])
  const loadMoreMovies = useCallback(() => { void handleLoadMoreMovies() }, [handleLoadMoreMovies])
  const loadMoreShows = useCallback(() => { void handleLoadMoreShows() }, [handleLoadMoreShows])
  // Each grid's genres for its controls: the server's list, or, when that
  // could not be read, the genres of the titles the grid holds.
  const moviesGenreList = useMemo(
    () => moviesGenres ?? (genresFailed.movie ? fallbackGenres(moviesList, moviesGenre) : null),
    [moviesGenres, genresFailed.movie, moviesList, moviesGenre],
  )
  const showsGenreList = useMemo(
    () => showsGenres ?? (genresFailed.show ? fallbackGenres(showsList, showsGenre) : null),
    [showsGenres, genresFailed.show, showsList, showsGenre],
  )
  // Whether each grid has the strip: sorted by title, settled, and short
  // enough (see where the strip is drawn).
  const moviesStrip = moviesSort === 'title' && !profileSwitchPending && fitsInPages(moviesTotal, BROWSE_PER_PAGE, CATALOG_REFRESH_MAX_PAGES)
  const showsStrip = showsSort === 'title' && !profileSwitchPending && fitsInPages(showsTotal, BROWSE_PER_PAGE, CATALOG_REFRESH_MAX_PAGES)
  const moviesJump = useLetterJump({
    items: view === 'movies' && !profileSwitchPending ? moviesList : null, total: moviesTotal,
    enabled: moviesStrip, loadingMore: moviesLoadingMore, loadMore: loadMoreMovies, reveal: revealInGrid,
  })
  const showsJump = useLetterJump({
    items: view === 'shows' && !profileSwitchPending ? showsList : null, total: showsTotal,
    enabled: showsStrip, loadingMore: showsLoadingMore, loadMore: loadMoreShows, reveal: revealInGrid,
  })

  const handleMoviesSortChange = useCallback((s: MediaSort) => {
    if (s === moviesSort) return
    moviesLoadMoreAcRef.current?.abort()
    moviesLoadMoreAcRef.current = null
    setMoviesSort(s)
    setMoviesList(null)
    setMoviesTotal(null)
    setMoviesNextPage(1)
    setMoviesLoadingMore(false)
  }, [moviesSort])

  const handleShowsSortChange = useCallback((s: MediaSort) => {
    if (s === showsSort) return
    showsLoadMoreAcRef.current?.abort()
    showsLoadMoreAcRef.current = null
    setShowsSort(s)
    setShowsList(null)
    setShowsTotal(null)
    setShowsNextPage(1)
    setShowsLoadingMore(false)
  }, [showsSort])

  // Genre-change handlers — mirror sort handlers because genre is
  // now also a server-side filter. Setting moviesList=null triggers
  // the fetch effect to re-run with the new (sort, genre) tuple,
  // starting at page 1, and the in-flight Load More is aborted so
  // its response can't append a stale-genre page onto the new list.
  const handleMoviesGenreChange = useCallback((g: string) => {
    if (g === moviesGenre) return
    moviesLoadMoreAcRef.current?.abort()
    moviesLoadMoreAcRef.current = null
    setMoviesGenre(g)
    setMoviesList(null)
    setMoviesTotal(null)
    setMoviesNextPage(1)
    setMoviesLoadingMore(false)
  }, [moviesGenre])

  const handleShowsGenreChange = useCallback((g: string) => {
    if (g === showsGenre) return
    showsLoadMoreAcRef.current?.abort()
    showsLoadMoreAcRef.current = null
    setShowsGenre(g)
    setShowsList(null)
    setShowsTotal(null)
    setShowsNextPage(1)
    setShowsLoadingMore(false)
  }, [showsGenre])

  // Detail fetch. Triggered when handleSelect flips view to 'detail'.
  //   - Movies: /api/media/{id}/files
  //   - Shows: /api/media/{id}/seasons + episodes of the first season
  // Episodes of other seasons load on demand via the season picker.
  useEffect(() => {
    if (!user || view !== 'detail' || !selectedMedia) {
      setDetailItem(null)
      setDetailEpisodes([])
      setDetailFiles([])
      setDetailSeasons([])
      setDetailSelectedSeason(null)
      setDetailError(null)
      // Clear the ref so navigate-away-and-back doesn't see a stale
      // (mediaId, season) and skip the re-fetch.
      currentEpisodesSeasonRef.current = null
      return
    }
    let cancelled = false
    const ac = new AbortController()
    setDetailLoading(true)
    setDetailError(null)
    // Reset on each new media so the previous show's seasons don't
    // leak into the new render frame.
    setDetailSeasons([])
    setDetailSelectedSeason(null)
    ;(async () => {
      try {
        // The seasons list depends only on the id, and `selectedMedia.type`
        // already says whether this is a show — so start both requests
        // together. They were strictly serialized before (detail → seasons
        // → episodes), which made a show's episode list wait a whole extra
        // round trip for nothing. The no-op catch marks the parallel
        // promise handled so an abort while getMedia is in flight cannot
        // surface as an unhandled rejection; awaiting it below still
        // rethrows into the same error path as before.
        const seasonsPromise = selectedMedia.type === 'show' ? getSeasons(selectedMedia.id, ac.signal) : null
        void seasonsPromise?.catch(() => undefined)
        const detail = await getMedia(selectedMedia.id, ac.signal)
        if (cancelled) return
        setDetailItem(detail)
        if (detail.type === 'show') {
          const seasonsRaw = await (seasonsPromise ?? getSeasons(selectedMedia.id, ac.signal))
          if (cancelled) return
          // Sort by season_number so Detail doesn't show the wrong
          // season at the top.
          const seasons = [...seasonsRaw].sort((a, b) => a.season_number - b.season_number)
          setDetailSeasons(seasons)
          if (seasons.length > 0) {
            // Land on the season the viewer is actually watching (their
            // Continue Watching record), not blindly Season 1 — "open
            // show → find current episode" is the most common TV
            // navigation, and mid-series viewers previously always paid
            // a picker-click + refetch detour. Falls back to the first
            // season for unwatched shows or a CW season missing from the
            // list. Read via the ref so CW poll refreshes don't re-run
            // this whole fetch.
            const cw = continueItemsRef.current.find(
              c => c.media_item_id === selectedMedia.id && c.season_number != null,
            )
            // With nothing in progress: the season the show STARTS in
            // (lib/partyEpisode), which is the first with something to play,
            // looking through the regular seasons in order and the Specials
            // last. Not the lowest number, which is Specials when a show has
            // them; and not a first season whose files are gone, which left
            // the page listing episodes none of which could be played while
            // its Play started a Special and its party had no episode at
            // all. The page then lists the season its Play starts and its
            // party opens on, as a card's do. The picker still lists the
            // seasons in number order.
            //
            // The same walk firstEpisodeToPlay makes, keeping what it reads:
            // one request when the first regular season can be played, as
            // before, and one more per season passed over. When nothing can
            // be played anywhere the page opens on the first regular season.
            const sortEps = (raw: ApiEpisode[]) => [...raw].sort((a, b) => a.episode_number - b.episode_number)
            let initialSeason: number
            let eps: ApiEpisode[]
            if (cw?.season_number != null && seasons.some(s => s.season_number === cw.season_number)) {
              initialSeason = cw.season_number
              setDetailSelectedSeason(initialSeason)
              eps = sortEps(await getEpisodes(selectedMedia.id, initialSeason, ac.signal))
              if (cancelled) return
            } else {
              const order = regularSeasonsFirst(seasons)
              initialSeason = order[0].season_number
              // Shown at once: the chips should not wait on a second read.
              setDetailSelectedSeason(initialSeason)
              eps = sortEps(await getEpisodes(selectedMedia.id, initialSeason, ac.signal))
              if (cancelled) return
              if (!eps.some(e => e.files && e.files.length > 0)) {
                for (const later of order.slice(1)) {
                  let found: ApiEpisode[]
                  try {
                    found = sortEps(await getEpisodes(selectedMedia.id, later.season_number, ac.signal))
                  } catch (err) {
                    if (cancelled || (err && (err as Error).name === 'AbortError')) return
                    // A later season that cannot be read: stay on the first.
                    break
                  }
                  if (cancelled) return
                  if (found.some(e => e.files && e.files.length > 0)) {
                    initialSeason = later.season_number
                    eps = found
                    setDetailSelectedSeason(initialSeason)
                    break
                  }
                }
              }
            }
            setDetailEpisodes(eps)
            // Stamp the ref so the season-switch effect knows
            // what's currently loaded.
            currentEpisodesSeasonRef.current = { mediaId: selectedMedia.id, season: initialSeason }
          }
        } else {
          // Capture the files list so DetailView can render the
          // version picker for multi-file movies. handlePlay still
          // re-fetches in its own flow for resilience.
          try {
            const files = await getMediaFiles(selectedMedia.id, ac.signal)
            if (!cancelled) setDetailFiles(files)
          } catch { /* non-fatal — picker just doesn't appear */ }
        }
      } catch (err) {
        if (cancelled || (err && (err as Error).name === 'AbortError')) return
        setDetailError(err instanceof Error ? err.message : 'Failed to load details')
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()
    return () => { cancelled = true; ac.abort() }
  }, [user, view, selectedMedia])

  // 2026-05-27 — Continue Watching resume handler. Restored after the
  // PR #95 cleanup pass deleted it (see git blame on PR #95 for the
  // tombstone that lived here). PR #97 deep-debug hardening added
  // abort support, defensive null-episode-id guard, stale-entry
  // recovery, and a friendlier error-message map.
  //
  // The wiring is detail-view-driven: when the user opens detail for a
  // partially-watched title, App-level `continueItems` is scanned for
  // a match and the result is threaded into DetailView as `resume`.
  // DetailView renders a "Resume at MM:SS" CTA that calls this handler
  // with the matched record, so the server-side position_ms /
  // episode_id flow into setPlayerTarget the same way handlePlay does
  // for a fresh start. Movies and shows share the same code path; the
  // episode_id branch fetches the episode's file (the CW response
  // doesn't carry it inline).
  //
  // The shared playback resolver token/controller makes a second Play/Resume
  // click or any close/route change cancel ownership before a late response can
  // call setPlayerTarget on the destination page.
  const handlePlayContinue = useCallback(async (c: ContinueWatchingItem) => {
    // Don't start a new playback while a cast/AirPlay session is active (see
    // handlePlay) — make the user stop the cast from the widget first.
    if (playerRemoteActiveRef.current) {
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Stop casting to play something else', type: 'info' }])
      return
    }
    // Cancel any previous in-flight resume request (rapid double-click
    // or route change mid-load).
    const myGen = ++playbackResolutionGenRef.current
    playbackResolutionRequestRef.current?.abort()
    const ac = new AbortController()
    playbackResolutionRequestRef.current = ac
    setPlayerLoading(true)
    try {
      let preferQuality: 'auto' | '1080p' | '4k' = 'auto'
      try {
        // Guard against null / non-object shapes that JSON.parse can
        // return when localStorage was tampered with.
        const raw: unknown = JSON.parse(localStorage.getItem('aurora_prefs') || '{}')
        if (raw && typeof raw === 'object') {
          const prefs = raw as Record<string, unknown>
          if (prefs.preferred_quality === '4k') preferQuality = '4k'
          else if (prefs.preferred_quality === '1080p') preferQuality = '1080p'
        }
      } catch { /* ignore */ }
      // "Always sync to the party" — when a watch party is live for THIS exact
      // title/episode, resume into the party's CURRENT position instead of the
      // personal continue-watching bookmark. This stops a host's Resume from
      // dragging the party to a personal offset (the rejoin/resync bug) and lets
      // a rejoiner catch up to where the group is. partyStateRef holds the
      // freshest state (this callback closes over an early render).
      const ps = partyStateRef.current
      const inPartyForThis =
        !!ps.code &&
        ps.mediaItemId === c.media_item_id &&
        (c.type === 'show' ? ps.episodeId === c.episode_id : true)
      // Use the party position when the party is actively playing (even at ~0,
      // a fresh start) or paused mid-movie (currentTimeMs > 0). A not-started
      // party (lobby, paused at 0) falls back to the personal bookmark.
      const resumeMs =
        inPartyForThis && (ps.isPlaying || ps.currentTimeMs > 0) ? ps.currentTimeMs : c.position_ms
      if (c.type === 'show') {
        // Defensive: server invariant says show CW rows always have
        // episode_id + season_number (enforced by SQL WHERE clause in
        // GetContinueWatching). Don't trust it silently — a missing
        // episode_id would otherwise fall through to the movie branch
        // below and corrupt progress against the show's media_item_id
        // with fileType='media'.
        if (!c.episode_id || c.season_number === undefined) {
          throw new Error('SHOW_MISSING_EPISODE_INFO')
        }
        const eps = await getEpisodes(c.media_item_id, c.season_number, ac.signal)
        if (!isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted)) return
        const ep = eps.find(e => e.id === c.episode_id)
        if (!ep) {
          // Episode was deleted between the CW snapshot and now. Clear
          // the stale entry so the Resume CTA disappears on the next
          // render, then surface a friendly toast pointing the user
          // back to the from-start path.
          setContinueItems(prev => prev.filter(x => !(
            x.media_item_id === c.media_item_id && x.episode_id === c.episode_id
          )))
          throw new Error('EPISODE_NOT_FOUND')
        }
        const file = pickFile(ep.files, preferQuality)
        if (!file) throw new Error('EPISODE_NO_FILES')
        setPlayerTarget({
          mediaItemId: c.media_item_id,
          fileId: file.id,
          fileType: 'episode',
          episodeId: ep.id,
          seasonNumber: c.season_number,
          episodeNumber: c.episode_number ?? ep.episode_number,
          title: c.title,
          subtitle: `S${c.season_number}E${c.episode_number ?? ep.episode_number}${ep.title ? ' — ' + ep.title : ''}`,
          resumePositionMs: resumeMs,
        })
      } else {
        // Movie — same path as handlePlay but with resume position.
        const files = await getMediaFiles(c.media_item_id, ac.signal)
        if (!isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted)) return
        const file = pickFile(files, preferQuality)
        if (!file) throw new Error('NO_FILE_AVAILABLE')
        setPlayerTarget({
          mediaItemId: c.media_item_id,
          fileId: file.id,
          fileType: 'media',
          title: c.title,
          subtitle: c.year ? String(c.year) : undefined,
          resumePositionMs: resumeMs,
        })
      }
    } catch (err) {
      // Aborts are expected when a second click supersedes the first;
      // don't toast them.
      if (!isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted) ||
          (err && (err as Error).name === 'AbortError')) return
      // Map known error codes to friendly user-facing strings. Raw
      // err.message could leak server response bodies otherwise.
      const code = err instanceof Error ? err.message : ''
      const msg =
        code === 'SHOW_MISSING_EPISODE_INFO' ? 'Resume info is missing. Try playing from the beginning.' :
        code === 'EPISODE_NOT_FOUND'         ? 'This episode is no longer in your library. Try playing from the beginning.' :
        code === 'EPISODE_NO_FILES'          ? 'This episode has no playable file.' :
        code === 'NO_FILE_AVAILABLE'         ? 'No playable file found for this title.' :
        'Failed to resume. Please try again.'
      if (code && !['SHOW_MISSING_EPISODE_INFO', 'EPISODE_NOT_FOUND', 'EPISODE_NO_FILES', 'NO_FILE_AVAILABLE'].includes(code)) {
        // Unknown error — log the raw value for admin debugging while
        // still showing the user the generic friendly message.
        console.warn('[Aurora] handlePlayContinue unknown error', err)
      }
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: msg, type: 'error' }])
    } finally {
      // Only clear loading if this is still the active request — a
      // newer click may have superseded us, in which case the newer
      // call owns the loading state.
      if (playbackResolutionRequestRef.current === ac &&
          isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted)) {
        setPlayerLoading(false)
        playbackResolutionRequestRef.current = null
      }
    }
  }, [nextToastId])

  // Issue #177 / #460 — "what comes after this episode?", shared by the
  // solo auto-advance below and the party advance beneath it.
  //
  // Order: the next playable episode in the current season, else the
  // first playable episode of the earliest later season. Fileless
  // episodes are skipped (a gap in the library shouldn't dead-end the
  // series). Returns null at the series end.
  //
  // Pure resolution — no state, no staleness guards. Callers own those,
  // because "is this result still wanted?" differs between the two
  // (solo re-checks the local player target; the party path re-checks
  // that AND that the host is still the host).
  const resolveNextEpisode = useCallback(async (
    mediaItemId: number,
    curSeason: number,
    curEp: number,
    preferQuality: 'auto' | '1080p' | '4k',
  ): Promise<{ ep: ApiEpisode; file: NonNullable<ReturnType<typeof pickFile>>; season: number } | null> => {
    const sameSeason = [...await getEpisodes(mediaItemId, curSeason)]
      .sort((a, b) => a.episode_number - b.episode_number)
    for (const e of sameSeason) {
      if (e.episode_number <= curEp) continue
      const f = pickFile(e.files, preferQuality)
      if (f) return { ep: e, file: f, season: curSeason }
    }
    const laterSeasons = [...await getSeasons(mediaItemId)]
      .sort((a, b) => a.season_number - b.season_number)
      .filter(s => s.season_number > curSeason)
    for (const s of laterSeasons) {
      const eps = [...await getEpisodes(mediaItemId, s.season_number)]
        .sort((a, b) => a.episode_number - b.episode_number)
      for (const e of eps) {
        const f = pickFile(e.files, preferQuality)
        if (f) return { ep: e, file: f, season: s.season_number }
      }
    }
    return null
  }, [])

  // Issue #177 — auto-play the next episode when one finishes.
  //
  // The "Auto-play next episode" toggle in Settings has shipped since
  // the V2 redesign but was never wired to anything — the V1 logic was
  // left as a documented TODO in handlePlay. This is that wiring,
  // driven by the <video> 'ended' event the player now forwards.
  //
  //   - Episode targets only; movies and number-less targets no-op.
  //   - Honors the autoplay preference, read straight from the
  //     aurora_prefs bucket. SettingsView owns the React state, but the
  //     raw localStorage object is the cross-component source of truth
  //     (same pattern handlePlay uses for preferred_quality). Default
  //     ON, matching the toggle's own default.
  //   - NOT inside a watch party: host/guest media sync flows through
  //     the party media-change broadcast (onMediaChange above). A
  //     unilateral advance here would desync guests, so party
  //     auto-advance is left as a separate follow-up.
  //   - Resolution: the next playable episode in the current season,
  //     else the first playable episode of the earliest later season.
  //     Fileless episodes are skipped. At the series end (or when
  //     nothing playable remains) we leave the player parked on the
  //     final frame rather than closing it.
  //
  // The playerTargetRef re-check before applying guards the async
  // window: if the player advanced, closed, or switched episodes while
  // getEpisodes/getSeasons were in flight, the stale resolve bails.
  //
  // Returns true iff it actually advanced to a next episode. Local
  // playback (the <video> 'ended' listener) ignores the result, but the
  // cast path awaits it: a Chromecast receiver signals end-of-media via
  // playerState→IDLE (the local <video> is paused, so its 'ended' never
  // fires), and the player needs to know whether to re-point the receiver
  // at the new episode's session (true) or stop the cast (false).
  // Smart Skip — `opts.force` comes from the credits card's explicit
  // "Play now" click, which outranks the passive autoplay preference
  // (the toggle governs what happens when the user does NOTHING).
  const handlePlaybackEnded = useCallback(async (opts?: { force?: boolean }): Promise<boolean> => {
    const ended = playerTargetRef.current
    if (!ended || ended.fileType !== 'episode') return false
    if (ended.seasonNumber == null || ended.episodeNumber == null) return false
    if (party.state.code) return false // no unilateral advance in a watch party

    // Read prefs once. Default autoplay ON; quality mirrors handlePlay.
    let autoplay = true
    let preferQuality: 'auto' | '1080p' | '4k' = 'auto'
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('aurora_prefs') || '{}')
      if (raw && typeof raw === 'object') {
        const prefs = raw as Record<string, unknown>
        if (prefs.autoplay === false) autoplay = false
        if (prefs.preferred_quality === '4k') preferQuality = '4k'
        else if (prefs.preferred_quality === '1080p') preferQuality = '1080p'
      }
    } catch { /* malformed prefs — keep defaults (autoplay ON) */ }
    if (!autoplay && !opts?.force) return false
    const resolutionGen = playbackResolutionGenRef.current

    const mediaItemId = ended.mediaItemId
    const curSeason = ended.seasonNumber
    const curEp = ended.episodeNumber
    const showTitle = ended.title
    const endedEpisodeId = ended.episodeId

    try {
      const resolved = await resolveNextEpisode(mediaItemId, curSeason, curEp, preferQuality)

      // Bail if the player moved on while we were resolving.
      if (!isPlaybackResolutionCurrent(resolutionGen, playbackResolutionGenRef.current, false) ||
          playerTargetRef.current?.episodeId !== endedEpisodeId) return false
      if (!resolved) return false // series end / nothing playable — park on final frame
      const { ep: nextEp, file: nextFile, season: nextSeason } = resolved

      const label = `S${nextSeason}E${nextEp.episode_number}${nextEp.title ? ' — ' + nextEp.title : ''}`
      setPlayerTarget({
        mediaItemId,
        fileId: nextFile.id,
        fileType: 'episode',
        episodeId: nextEp.id,
        seasonNumber: nextSeason,
        episodeNumber: nextEp.episode_number,
        title: showTitle,
        subtitle: label,
      })
      addToast(`Up next: ${label}`, 'info')
      // The finished episode now has completed progress — refresh
      // Continue Watching (same nonce the player-close path bumps).
      setCwReloadNonce(n => n + 1)
      return true
    } catch (err) {
      if (!isPlaybackResolutionCurrent(resolutionGen, playbackResolutionGenRef.current, false)) return false
      console.warn('[Aurora] auto-advance to next episode failed', err)
      return false
    }
  }, [party.state.code, addToast, resolveNextEpisode])

  // Issue #460 — advance the WHOLE PARTY to the next episode.
  //
  // The counterpart to handlePlaybackEnded's `party.state.code` bail:
  // that path refuses to advance unilaterally because it would desync
  // guests. This one is the sanctioned route — the host resolves the
  // next episode locally, then hands it to the server via `change-media`.
  // The server resets the anchor to Paused@0 and echoes `media-change`
  // to every room conn (the host's included), so nobody — host or guest
  // — re-points off anything but the server's broadcast. That's why this
  // function never calls setPlayerTarget: doing so would race the
  // onMediaChange resolver and give the host a second, conflicting boot.
  //
  // Host-only and explicit-click-only. The autoplay preference is
  // deliberately NOT consulted: it governs what happens when a lone
  // viewer does nothing, and silently yanking a room full of people to
  // the next episode is a different act than doing it to yourself.
  //
  // Three outcomes, because the card renders each differently and
  // collapsing them lies to the user: 'advanced' (intent is on the wire
  // — the swap itself arrives via the broadcast), 'end' (no next episode
  // exists, show the finale notice), 'failed' (couldn't send or the
  // resolve went stale — re-offer the button rather than claim the
  // series ended).
  // Pulled out of `party` so the callback below can depend on the sender
  // itself (stable — useCallback with no deps) instead of on the whole
  // hook object, which is a fresh reference on every App render.
  const partyChangeMedia = party.changeMedia
  const handlePartyAdvance = useCallback(async (): Promise<'advanced' | 'end' | 'failed'> => {
    const cur = playerTargetRef.current
    if (!cur || cur.fileType !== 'episode') return 'failed'
    if (cur.seasonNumber == null || cur.episodeNumber == null) return 'failed'
    const code = party.state.code
    if (!code) return 'failed'
    // Host-only. The manager rejects a guest's change-media anyway, but
    // bailing here keeps a demoted host from firing a doomed swap and
    // reporting success to the card.
    if (!user || party.state.hostUserId !== user.id) return 'failed'
    // The player must be showing the party's OWN media. A host can hold a
    // party while watching something else — a scheduled lobby that hasn't
    // started, or a party player they closed — and advancing from that
    // target would push the room into an unrelated series carrying the
    // party's old title. The player-side gate already refuses to arm the
    // card there; this is the authority check behind it, since the server
    // validates only that the sender is the host.
    if (party.state.mediaItemId !== cur.mediaItemId) return 'failed'

    let preferQuality: 'auto' | '1080p' | '4k' = 'auto'
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('aurora_prefs') || '{}')
      if (raw && typeof raw === 'object') {
        const q = (raw as Record<string, unknown>).preferred_quality
        if (q === '4k') preferQuality = '4k'
        else if (q === '1080p') preferQuality = '1080p'
      }
    } catch { /* malformed prefs — keep 'auto' */ }

    const resolutionGen = playbackResolutionGenRef.current
    const fromEpisodeId = cur.episodeId

    try {
      const next = await resolveNextEpisode(cur.mediaItemId, cur.seasonNumber, cur.episodeNumber, preferQuality)
      // Re-check everything the resolve could have outlived: the player
      // moving on, the episode changing under us, the party ending, and
      // host succession (a disconnect mid-resolve promotes someone else,
      // and the server would reject the swap anyway).
      if (!isPlaybackResolutionCurrent(resolutionGen, playbackResolutionGenRef.current, false) ||
          playerTargetRef.current?.episodeId !== fromEpisodeId) return 'failed'
      if (partyStateRef.current.code !== code) return 'failed'
      if (!user || partyStateRef.current.hostUserId !== user.id) return 'failed'
      if (partyStateRef.current.mediaItemId !== cur.mediaItemId) return 'failed'
      if (!next) return 'end' // series end — the card shows its finale notice

      const sent = partyChangeMedia({
        mediaItemId: cur.mediaItemId,
        episodeId: next.ep.id,
        // Same show, so the party's own title/poster carry over. Passing
        // the target's title as a fallback keeps a party that somehow
        // never received them from being blanked by this swap.
        mediaTitle: partyStateRef.current.mediaTitle || cur.title,
        mediaPoster: partyStateRef.current.mediaPoster || '',
      })
      if (!sent) {
        addToast("Couldn't advance the party — reconnecting. Try again in a moment.", 'error')
        return 'failed'
      }
      // Tell the host's own player to resume once the swap lands, so the
      // one click that says "Play for all" actually plays. ChangeMedia
      // parks the room at Paused@0 by design; without this the card
      // vanishes, the next episode boots frozen, and someone has to hunt
      // for play. Consumed by the onMediaChange resolver.
      partySelfAdvanceRef.current = true

      // Mark the outgoing episode watched. It is NOT complete on its own:
      // completion is 95%, and the 2-minute rule fires at ~91% of a 22
      // minute episode, so without this the episode the party just
      // finished lingers in Continue Watching, resumes near the end, and —
      // because history surfaces require completed_at — never reaches
      // recent watches or the follow feed. Deliberate: choosing "next
      // episode" IS finishing this one. Fire-and-forget; a failure costs
      // a stale rail, not the advance.
      if (fromEpisodeId != null) {
        void markWatched(cur.mediaItemId, {
          episode_id: fromEpisodeId,
          profile_id: activeProfileId ?? undefined,
        }).catch(() => { /* non-fatal — the swap already went out */ })
      }
      // Same nonce the solo path and player-close bump.
      setCwReloadNonce(n => n + 1)
      return 'advanced'
    } catch (err) {
      console.warn('[Aurora] party advance to next episode failed', err)
      return 'failed'
    }
  }, [party.state.code, party.state.hostUserId, party.state.mediaItemId, partyChangeMedia, user, addToast, resolveNextEpisode, activeProfileId])

  // A card's on-poster Play, on every rail and grid: resume when the viewer
  // has a position in the title, else play it. The card's menu says "Resume"
  // in that case, and a Play that started from zero beside it then overwrote
  // the saved position. The record is looked up at click time (through the
  // ref), so a Continue Watching refresh between render and click does not
  // dispatch a stale one, and the handler keeps its identity across those
  // refreshes, which the memoised cards rely on.
  const playOrResume = useCallback((m: Media) => {
    const record = continueItemsRef.current.find(c => c.media_item_id === m.id && isResumable(c))
    if (record) void handlePlayContinue(record)
    else void handlePlay(m)
  }, [handlePlay, handlePlayContinue])
  // The titles that Play resumes, for the button's label.
  const resumableIds = useMemo(
    () => new Set(continueItems.filter(isResumable).map(c => c.media_item_id)),
    [continueItems],
  )
  // A Library list's "Where you are" column: for each title with a position
  // worth resuming, the record a card's Resume would use (the first found).
  const listProgressById = useMemo(() => {
    const byId = new Map<number, { label: string; fraction: number }>()
    for (const c of continueItems) {
      if (isResumable(c) && !byId.has(c.media_item_id)) byId.set(c.media_item_id, whereYouAre(c))
    }
    return byId
  }, [continueItems])

  // Play a specific file from the version picker — bypasses
  // pickFile's quality preference since the user picked explicitly.
  const handlePlayFile = useCallback((m: Media, fileId: number) => {
    if (playerRemoteActiveRef.current) {
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Stop casting to play something else', type: 'info' }])
      return
    }
    playbackResolutionGenRef.current++
    playbackResolutionRequestRef.current?.abort()
    playbackResolutionRequestRef.current = null
    setPlayerLoading(false)
    setPlayerTarget({
      mediaItemId: m.id,
      fileId,
      fileType: 'media',
      title: m.title,
      subtitle: m.year ? String(m.year) : undefined,
    })
  }, [nextToastId])

  // Admin refresh-metadata — re-fetches detail after the server
  // starts the refresh so the UI shows updated fields.
  const handleRefreshMetadata = useCallback(async (m: Media) => {
    try {
      await refreshMetadata(m.id)
      const id = nextToastId()
      setToasts(prev => [...prev, {
        id,
        message: 'Metadata refresh triggered — may take a moment.',
        type: 'info',
      }])
      try {
        const detail = await getMedia(m.id)
        setDetailItem(detail)
      } catch { /* non-fatal */ }
    } catch (err) {
      const id = nextToastId()
      const msg = err instanceof Error ? err.message : 'Failed to refresh'
      setToasts(prev => [...prev, { id, message: msg, type: 'error' }])
    }
  }, [nextToastId])

  // Admin "Identify" flow — opens ManualMatchModal from the detail
  // screen. The modal expects a ServerMediaItem but only reads
  // id/title/type/file_path; we synthesize one from the UI Media to
  // skip a round-trip.
  const [identifyTarget, setIdentifyTarget] = useState<ServerMediaItem | null>(null)
  const handleIdentify = useCallback((m: Media) => {
    setIdentifyTarget({
      id: m.id,
      library_id: 0, // not used by the modal
      type: m.type === 'show' || m.type === 'anime' ? 'show' : 'movie',
      title: m.title,
      year: m.year,
      added_at: '',
      updated_at: '',
    } as ServerMediaItem)
  }, [])
  const handleIdentifyClose = useCallback((matchInFlight?: boolean) => {
    const id = identifyTarget?.id
    setIdentifyTarget(null)
    if (!matchInFlight || !id) return
    // Closed while a match was still being sent: the server may have saved
    // it or not, and may still be at it. Nothing is claimed either way.
    // The title is read now, and again after a wait, since a read that
    // comes before the server has finished shows the old details.
    // The two reads are numbered: the first can take longer than the wait
    // before the second, and must not land over it with the older details.
    let landed = 0
    const read = (n: number) => void getMedia(id)
      .then(detail => {
        if (n < landed) return
        landed = n
        // Only onto the title it was read for: the person may have moved on.
        setDetailItem(shown => (shown && shown.id === id ? detail : shown))
      })
      .catch(() => { /* the page keeps what it has */ })
    read(1)
    window.setTimeout(() => read(2), 4000)
    const tid = nextToastId()
    setToasts(prev => [...prev, {
      id: tid,
      message: 'The dialog was closed while the match was still being sent, so it may or may not have been saved. This page is read again now and once more in a few seconds.',
      type: 'info',
    }])
  }, [identifyTarget, nextToastId])
  const handleIdentifyMatched = useCallback(async () => {
    const id = identifyTarget?.id
    setIdentifyTarget(null)
    if (!id) return
    // Re-fetch detail so the new metadata (poster, overview, etc.)
    // shows up immediately in the open detail view. Non-fatal: a
    // failed re-fetch just leaves the old data on screen until the
    // user navigates away and back.
    try {
      const detail = await getMedia(id)
      setDetailItem(detail)
    } catch { /* non-fatal */ }
    const tid = nextToastId()
    setToasts(prev => [...prev, {
      id: tid,
      message: 'Match saved — metadata is re-enriching in the background.',
      type: 'info',
    }])
  }, [identifyTarget, nextToastId])

  // Drop a just-deleted media id from every in-memory browse cache so the
  // ghost can't reappear (or be re-opened into a 404) after we navigate back.
  // Home rails are filtered in place; the movies/shows grids reset to null so
  // their effects refetch fresh; Continue Watching re-fetches via its nonce;
  // the saved-library list is filtered directly.
  const purgeMediaFromCaches = useCallback((id: number) => {
    removedFromHomeRef.current.add(id)
    // A live grid refresh still out would land the deleted title back.
    moviesRefreshAcRef.current?.abort()
    moviesRefreshAcRef.current = null
    showsRefreshAcRef.current?.abort()
    showsRefreshAcRef.current = null
    setHomeRails(prev => prev?.map(r => ({ ...r, items: r.items.filter(i => i.id !== id) })))
    setMoviesList(null)
    setShowsList(null)
    setLibrary(prev => prev.filter(i => i.id !== id))
    setCwReloadNonce(n => n + 1)
  }, [])

  // Admin "Remove from Library" — deletes the catalog entry (and its
  // episodes/files/history) for a title. Files on the server's disk are NOT
  // touched; this just clears Aurora's record, e.g. a "no files available"
  // ghost left behind after the title was deleted on the server. Confirms
  // first (destructive + irreversible), then navigates back off the now-gone
  // detail page and purges the local caches.
  const handleDeleteMedia = useCallback(async (m: Media) => {
    const ok = window.confirm(
      `Remove "${m.title}" from Aurora?\n\n` +
      `This deletes the library entry and all of its episodes, watch history, ` +
      `and metadata. Files on your server's disk are NOT deleted. ` +
      `If the files are still there, the next scan will re-add the title.`,
    )
    if (!ok) return
    try {
      await deleteMedia(m.id)
      purgeMediaFromCaches(m.id)
      handleBack()
      addToast(`Removed "${m.title}" from the library`, 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to remove from library'
      addToast(msg, 'error')
    }
  }, [purgeMediaFromCaches, handleBack, addToast])

  // Start a watch party with this media. Creates a quick-party
  // server-side, joins it, and opens the panel.
  //
  // QA 2026-05-25 — production observed: detail-page Watch Party
  // click → POST /api/parties → 201 → silent failure (no panel, no
  // toast, no error, no WebSocket attempt). Root cause: party.join's
  // preflight (GET /api/code/{code}/info) silently failed for a
  // just-created party — possibly a race where the manager's
  // in-memory state hadn't propagated to the GetCodeInfo path yet,
  // or apiFetch's error swallow. The fix is two-pronged:
  //   1. Pass skipPreflight=true here. We just created the party,
  //      we don't need to verify it exists via a separate GET.
  //   2. Log + toast on EVERY exit path (success, join-fail, throw)
  //      so the user always sees something — no more silent state.
  // Invites feature — the detail page's Party action now opens the
  // composer ("Right now" preselected, so the classic instant start is
  // one more click) instead of creating a party immediately.
  const [partyComposer, setPartyComposer] = useState<{ media: Media; episodeId?: number } | null>(null)


  const handleStartParty = useCallback((m: Media, episodeId?: number) => {
    if (party.state.code) {
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Leave the current party first.', type: 'info' }])
      return
    }
    setPartyComposer({ media: m, episodeId })
  }, [party.state.code, nextToastId])

  // "Watch together" from a card's menu. A show's party needs an episode
  // (see lib/partyEpisode): the viewer's resume episode, else the show's
  // first playable one, which is read here because a card has no episode
  // list. The same choice the title page's Party action makes. Dropped when
  // the profile changed while the episodes were being read.
  // The party handler as it is now, not as it was when a menu opened: the
  // episodes can take a moment, and "already in a party" is judged then.
  const handleStartPartyRef = useRef(handleStartParty)
  useEffect(() => { handleStartPartyRef.current = handleStartParty }, [handleStartParty])
  // One lookup at a time. It is abandoned when the viewer moves on (another
  // page, another profile, another lookup), so the composer never opens over
  // a page they have left or for a profile the session no longer is.
  const partyLookupRef = useRef<AbortController | null>(null)
  useEffect(() => () => { partyLookupRef.current?.abort(); partyLookupRef.current = null }, [location.pathname, activeProfileId])
  const startPartyFromCard = useCallback(async (m: Media, resume: ContinueWatchingItem | undefined) => {
    partyLookupRef.current?.abort()
    const lookup = new AbortController()
    partyLookupRef.current = lookup
    // A show with nothing to resume needs its episodes read first; say so,
    // since nothing else on screen changes until the composer opens.
    const reads = m.type === 'show' && !(resume?.type === 'show' && resume.episode_id)
    if (reads) setToasts(prev => [...prev, { id: nextToastId(), message: `Getting "${m.title}" ready to watch together…`, type: 'info' }])
    try {
      const episodeId = await resolvePartyEpisodeId(m, resume, lookup.signal)
      if (lookup.signal.aborted) return
      handleStartPartyRef.current(m, episodeId)
    } catch {
      if (lookup.signal.aborted) return
      setToasts(prev => [...prev, { id: nextToastId(), message: `Could not read the episodes of "${m.title}". Open its page to start a party.`, type: 'error' }])
    } finally {
      if (partyLookupRef.current === lookup) partyLookupRef.current = null
    }
  }, [nextToastId])

  // What the search page does with a result. Each remembers the search (a
  // search is remembered when something is done with it) and is the same
  // function from one render to the next, so the page's cards are not
  // drawn again each time App renders: the words are read when it is called.
  const searchQueryRef = useRef(searchQuery)
  useLayoutEffect(() => { searchQueryRef.current = searchQuery }, [searchQuery])
  const selectFromSearch = useCallback((m: Media) => { noteSearch(searchQueryRef.current); handleSelect(m) }, [noteSearch, handleSelect])
  const playFromSearch = useCallback((m: Media) => { noteSearch(searchQueryRef.current); playOrResume(m) }, [noteSearch, playOrResume])
  const partyFromSearch = useCallback((m: Media) => {
    noteSearch(searchQueryRef.current)
    void startPartyFromCard(m, continueItemsRef.current.find(c => c.media_item_id === m.id && isResumable(c)))
  }, [noteSearch, startPartyFromCard])
  const collectionFromSearch = useCallback((id: number) => { noteSearch(searchQueryRef.current); openCollectionFromSearch(id) }, [noteSearch, openCollectionFromSearch])

  // The card menu: what a right click, a card's More button, the context-menu
  // key and a long press all open (ContextMenu). Everything a card can do is
  // here, so nothing is reachable only by one of those gestures.
  //
  // Built by a plain function that reads this render's values, and reached
  // through a ref, so the callback the cards hold (openCardContextMenu,
  // below) never changes identity: it used to depend on continueItems,
  // libraryIds and half a dozen handlers, so every Continue Watching refresh
  // or party change re-rendered every memoised card on Home and the grids.
  //
  // `own` is the card's own Continue Watching record, when the card stands
  // for one (My Library's Continue Watching grid has a card per episode of a
  // show): the menu's Resume must be that record, as the card's Play is, not
  // the first one found for the title.
  const buildCardMenu = (e: React.MouseEvent, m: Media, own?: ContinueWatchingItem) => {
    e.preventDefault()
    const failed = (err: unknown) => window.alert('Failed: ' + (err instanceof Error ? err.message : 'unknown'))
    const resume = own && own.media_item_id === m.id && isResumable(own)
      ? own
      : continueItems.find(c => c.media_item_id === m.id && isResumable(c))
    const saved = libraryIds.has(m.id)
    const items: MediaContextItem[] = []
    if (resume) {
      const left = formatRemaining(resume.position_ms, resume.duration_ms)
      items.push({ label: left ? `Resume · ${left}` : 'Resume', primary: true, onClick: () => { void handlePlayContinue(resume) } })
      // A movie restarts from zero. A show's "start" is not this episode's,
      // so the title page, which lists the episodes, is where to choose.
      if (m.type === 'movie') items.push({ label: 'Play from the start', onClick: () => { void handlePlay(m) } })
    } else {
      items.push({ label: 'Play', primary: true, onClick: () => { void handlePlay(m) } })
    }
    // Watching together is not offered to a restricted profile.
    if (navScope === 'full') items.push({ label: 'Watch together', onClick: () => { void startPartyFromCard(m, resume) } })
    items.push(
      { label: saved ? 'Remove from My Library' : 'Add to My Library', group: true, onClick: () => handleToggleLib(m) },
    )
    if (profiles.length > 0) {
      items.push({ label: 'Add to a list…', onClick: () => setAddToListMedia(m) })
    }
    items.push(
      { label: 'Mark as watched', onClick: () => {
        void markWatched(m.id, { profile_id: activeProfileId ?? undefined }).then((res) => {
          const id = nextToastId()
          setToasts(prev => [...prev, { id, message: `Marked "${m.title}" as watched`, type: 'success' }])
          // Phase 5.7 — XP / achievement toast (stacked, not replacing).
          if (res?.achievements_unlocked && res.achievements_unlocked.length > 0) {
            for (const def of res.achievements_unlocked) {
              const tid = nextToastId()
              setToasts(prev => [...prev, { id: tid, message: `${def.icon} Achievement unlocked: ${def.title} (+${def.xp_reward} XP)`, type: 'success' }])
            }
          }
          setRetryNonce(n => n + 1)
        }).catch(failed)
      }},
      { label: 'Clear my progress', tone: 'danger', onClick: () => {
        void clearProgress(m.id, activeProfileId ?? undefined).then(() => {
          const id = nextToastId()
          setToasts(prev => [...prev, { id, message: `Cleared progress for "${m.title}"`, type: 'info' }])
          setRetryNonce(n => n + 1)
        }).catch(failed)
      }},
      // Feedback to the recommender (the thumbs).
      { label: 'More like this', group: true, ai: true, onClick: () => {
        // The removal set of the owner the menu was opened under (see
        // removedFromHomeRef): a switch before the answer replaces it.
        const removed = removedFromHomeRef.current
        void submitMediaFeedback(m.id, 'up', activeProfileId ?? undefined).then(() => {
          // A thumbs-up undoes an earlier thumbs-down (one row per title).
          removed.delete(m.id)
          setToasts(prev => [...prev, { id: nextToastId(), message: `More like "${m.title}" — got it`, type: 'success' }])
        }).catch(failed)
      }},
      { label: 'Not interested', ai: true, onClick: () => {
        const removed = removedFromHomeRef.current
        void submitMediaFeedback(m.id, 'down', activeProfileId ?? undefined).then(() => {
          setToasts(prev => [...prev, { id: nextToastId(), message: `We'll show you less like "${m.title}"`, type: 'info' }])
          // Drop it from Home at once (it would vanish on the next rec
          // refresh anyway) and keep it out of later rail recomposes.
          removed.add(m.id)
          setHomeRails(rails => rails ? rails.map(rl => ({ ...rl, items: rl.items.filter(it => it.id !== m.id) })) : rails)
        }).catch(failed)
      }},
    )
    if (adminUI) {
      items.push({ label: 'Refresh metadata', group: true, note: 'Admin', onClick: () => { void handleRefreshMetadata(m) } })
    }
    // The control that opened it, when one did (a card's More button): focus
    // returns there, and it says the menu is open. A right click's or a long
    // press's target is the card, which is not a control.
    const opener = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
    setContextMenu({ ...anchorFor(e), items, title: m.title, reason: m.reason, opener })
  }
  const buildCardMenuRef = useRef(buildCardMenu)
  // Mirrored in a layout effect: in a passive one, a press in the frame a
  // card was first drawn in built the menu of the render before, whose list
  // did not have the title yet (My Library's card offered "Add to My
  // Library").
  useLayoutEffect(() => { buildCardMenuRef.current = buildCardMenu })
  const openCardContextMenu = useCallback((e: React.MouseEvent, m: Media, own?: ContinueWatchingItem) => buildCardMenuRef.current(e, m, own), [])
  // A profile switch closes the menu: it holds the previous profile's Resume
  // record and closures over its id (Add, the thumbs, Mark as watched), so a
  // pick made after a switch, one made in another tab included, would act
  // for the profile the session no longer is. Its render is also withheld
  // on the commit that names the new profile (see where it is drawn).
  useEffect(() => { setContextMenu(null) }, [activeProfileId])


  // The composer's launch sequence: create (live or scheduled) → send
  // invites → join as host → open the panel. Returns {ok,error} so the
  // modal can stay open with an inline error on failure. Toast copy
  // reports what actually happened, including per-invitee skips (rating
  // ceiling, unknown name) the server reported.
  const launchComposerParty = useCallback(async (
    m: Media, episodeId: number | undefined, launch: PartyComposerLaunch,
    // `code` rides back on success so the composer's scheduled-success
    // state can hand straight off to the share card.
  ): Promise<{ ok: boolean; error?: string; code?: string }> => {
    let createdCode: string | null = null
    try {
      const resp = await createQuickParty({
        media_item_id: m.id,
        episode_id: episodeId,
        media_title: m.title,
        // Strip ANY image-proxy size variant prefix to avoid
        // double-proxying (e.g. `/api/images/w500//api/images/...`).
        media_poster: String(m.poster || '').replace(/^\/api\/images\/[^/]+\//, ''),
        scheduled_start_at: launch.scheduledStartAt ?? undefined,
      })
      createdCode = resp.code

      let sentCount = 0
      let skippedMsg = ''
      if (launch.usernames.length > 0) {
        // Invite failures don't abort the launch — the party exists and
        // the host is about to land in it; report and carry on.
        try {
          const result = await sendPartyInvites(resp.code, launch.usernames, launch.note || undefined)
          sentCount = result.sent.length
          if (result.skipped.length > 0) {
            skippedMsg = result.skipped
              .map(s => `${s.username} (${skipReasonCopy(s.reason)})`)
              .join(', ')
          }
        } catch (err) {
          skippedMsg = err instanceof Error ? err.message : 'invites failed to send'
        }
      }

      const joinResult = await party.join(resp.code, { skipPreflight: true })
      if (joinResult.ok) {
        setPartyPanelOpen(true)
        const when = launch.scheduledStartAt
          ? `scheduled — ${formatPartyTime(launch.scheduledStartAt, new Date())}`
          : 'started'
        const invited = sentCount > 0 ? ` · ${sentCount} invite${sentCount === 1 ? '' : 's'} sent` : ''
        setToasts(prev => [...prev, {
          id: nextToastId(),
          message: `Party ${when} — code ${resp.code}${invited}`,
          type: 'success',
        }])
        if (skippedMsg) {
          setToasts(prev => [...prev, {
            id: nextToastId(),
            message: `Not invited: ${skippedMsg}`,
            type: 'info',
          }])
        }
        return { ok: true, code: resp.code }
      }
      // Server created the party but we couldn't join it. Surface
      // the error so the admin knows the party exists. Used to be
      // possible to silently end up here with `joinResult.error`
      // empty string — guard with a non-empty fallback.
      // eslint-disable-next-line no-console
      console.error('[Aurora WatchParty] join failed after create', { code: resp.code, joinResult })
      return {
        ok: false,
        error: `Party ${resp.code} created but join failed: ${joinResult.error || 'no error message returned (check console)'}`,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start party'
      // eslint-disable-next-line no-console
      console.error('[Aurora WatchParty] launchComposerParty threw', { createdCode, err })
      // One-active-party-per-host guard (2026-08 review): the raw server
      // message dead-ends the host with no pointer to the party they
      // already have — which, for a scheduled booking they're not
      // connected to, is invisible from this modal. Name the recovery.
      if (!createdCode && /already have an active party/i.test(msg)) {
        return {
          ok: false,
          error: 'You already have a party (it may be a scheduled one). Open it from the home "Watch together" card, your Calendar, or the bell — end it there first to book a new one.',
        }
      }
      return {
        ok: false,
        error: createdCode ? `Party ${createdCode} created but couldn't join: ${msg}` : msg,
      }
    }
  }, [party, nextToastId])

  // M10 Phase 2 — play a specific episode (vs handlePlay which
  // plays a parent show's "first available" episode). Used by the
  // detail-view episode list. mediaItemId is the parent show's id
  // for progress tracking; episodeId is on the episode itself.
  // fileId (optional) — when the user clicks a specific version chip on
  // an episode row, play THAT file directly and skip the quality-
  // preference pick. Omitted for a normal row click, which falls back to
  // pickFile + the user's preferred_quality like before.
  const handlePlayEpisode = useCallback((ep: ApiEpisode, fileId?: number) => {
    if (!selectedMedia) return
    // Don't start a new playback while a cast/AirPlay session is active (see
    // handlePlay) — make the user stop the cast from the widget first.
    if (playerRemoteActiveRef.current) {
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Stop casting to play something else', type: 'info' }])
      return
    }
    // Deep-debug #177 — honor the quality preference, matching handlePlay
    // / handlePlayContinue / handlePlaybackEnded. Without it a manually-
    // started episode used 'auto' (1080p-preferred) while an auto-advanced
    // one used the 4k preference, so a binge could switch resolution
    // mid-stream for a 4k-preference user.
    let preferQuality: 'auto' | '1080p' | '4k' = 'auto'
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('aurora_prefs') || '{}')
      if (raw && typeof raw === 'object') {
        const prefs = raw as Record<string, unknown>
        if (prefs.preferred_quality === '4k') preferQuality = '4k'
        else if (prefs.preferred_quality === '1080p') preferQuality = '1080p'
      }
    } catch { /* malformed prefs — keep 'auto' */ }
    // Explicit version chip → that exact file; otherwise resolve by
    // quality preference. The `?? pickFile` fallback covers a stale
    // fileId (file pruned between render and click) by degrading to the
    // default pick rather than failing the play.
    const file = (fileId !== undefined ? ep.files?.find(f => f.id === fileId) : undefined)
      ?? pickFile(ep.files, preferQuality)
    if (!file) {
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'This episode has no playable file.', type: 'error' }])
      return
    }
    playbackResolutionGenRef.current++
    playbackResolutionRequestRef.current?.abort()
    playbackResolutionRequestRef.current = null
    setPlayerLoading(false)
    setPlayerTarget({
      mediaItemId: selectedMedia.id,
      fileId: file.id,
      fileType: 'episode',
      episodeId: ep.id,
      // Issue #177 — stamp the season the RENDERED episode rows were
      // actually fetched for, NOT the picker's current value.
      // Deep-debug #177: on a season switch, setDetailSelectedSeason is
      // synchronous but the episode list repopulates via an async
      // getEpisodes effect; during that window the old rows stay
      // clickable while detailSelectedSeason already holds the new
      // number. currentEpisodesSeasonRef lags it (updated only after the
      // new list loads), so it matches the still-visible rows and keeps
      // auto-advance resolving "next" against the right season. Falls
      // back to detailSelectedSeason (initial-load) then undefined.
      seasonNumber: currentEpisodesSeasonRef.current?.season ?? detailSelectedSeason ?? undefined,
      episodeNumber: ep.episode_number,
      title: selectedMedia.title,
      subtitle: `E${ep.episode_number}${ep.title ? ' — ' + ep.title : ''}`,
    })
  }, [selectedMedia, detailSelectedSeason, nextToastId])

  // M10 Phase 4.5 — episode list refetches when the user switches
  // season via the picker. The initial-load case is handled inside
  // the main detail effect above.
  //
  // We track which (mediaId, season) the current `detailEpisodes`
  // came from via a ref — comparing by episode count instead would
  // false-skip the refetch on equal-sized seasons.
  const currentEpisodesSeasonRef = useRef<{ mediaId: number; season: number } | null>(null)
  useEffect(() => {
    if (!selectedMedia || !detailSelectedSeason) return
    if (view !== 'detail') return
    if (detailItem?.type !== 'show') return
    // Skip only when the episodes in state are KNOWN to be from
    // this exact (media, season). The ref is set on every successful
    // fetch — both in the main detail effect's initial load and in
    // this effect — so we never skip incorrectly.
    const cur = currentEpisodesSeasonRef.current
    if (cur && cur.mediaId === selectedMedia.id && cur.season === detailSelectedSeason) return

    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      try {
        const epsRaw = await getEpisodes(selectedMedia.id, detailSelectedSeason, ac.signal)
        if (cancelled) return
        const eps = [...epsRaw].sort((a, b) => a.episode_number - b.episode_number)
        setDetailEpisodes(eps)
        currentEpisodesSeasonRef.current = { mediaId: selectedMedia.id, season: detailSelectedSeason }
      } catch (err) {
        if (cancelled || (err && (err as Error).name === 'AbortError')) return
        // Non-fatal — keep showing previous episodes. The picker
        // visibly stays on the failed season so the user can retry.
      }
    })()
    return () => { cancelled = true; ac.abort() }
  }, [selectedMedia, detailSelectedSeason, view, detailItem?.type])

  // Personalized hero from /api/me/hero. 503 = no recommender; we
  // fall back to listRecent[0] (set in the home-rails effect).
  //
  // Only the latest request lands (heroLoadRef): a slower answer for the
  // previous profile used to overwrite the new one's.
  const reloadHeroPool = useCallback(async (refresh: boolean) => {
    if (!user || !personalProfileReady) return
    const load = ++heroLoadRef.current
    try {
      const resp = await getHeroPool(refresh, activeProfileId ?? undefined)
      if (load !== heroLoadRef.current) return
      heroPoolRef.current = resp.picks
      setHeroPool(resp.picks)
      setHeroPersonalization(resp.personalization)
      setHeroSlateToken(resp.slateToken)
      setHeroIndex(0)
      // An empty pool leaves the slate with no pick: the hero is then the
      // title to resume, else the catalog's stand-in (homeHero), which the
      // home-rails load records whether or not there are picks.
    } catch {
      if (load !== heroLoadRef.current) return
      // A refresh that failed keeps the picks there are.
      if (refresh) return
      // Non-fatal: the hero is the title to resume, else the catalog's
      // stand-in from the home-rails load.
      heroPoolRef.current = []
      setHeroPool([])
      setHeroPersonalization(null)
      setHeroSlateToken(undefined)
    }
  }, [user, activeProfileId, personalProfileReady])
  // A switch clears the previous profile's hero: an empty or failed pool for
  // the new profile leaves homeHero as it is, which kept the old profile's
  // pick on screen. The home-rails effect then puts the catalog fallback up
  // until the new pool lands. The startup binding arriving is not a switch;
  // a pick from the picker opened for an unreadable binding is (from null,
  // after the startup load settled), and the hero on screen then is the
  // catalog fallback fetched under the binding the server does have.
  const heroProfileRef = useRef<number | null>(null)
  useEffect(() => {
    const prev = heroProfileRef.current
    heroProfileRef.current = activeProfileId
    if (prev === activeProfileId || (prev === null && !profilesSettledBeforeRef.current)) return
    heroLoadRef.current++
    heroPoolRef.current = []
    setHeroPool([])
    setHeroPersonalization(null)
    setHeroSlateToken(undefined)
    setHeroIndex(0)
    setHeroOnLead(true)
    setHomeHero(null)
  }, [activeProfileId])
  // Nobody is signed in: the hero, Continue Watching and the hero's wait for
  // it are nobody's. Sign out clears them in resetUserState, and on an
  // account with profiles the profile going to null does (the effect above
  // and the switch's reset). A session that EXPIRES while the app knows no
  // profile for the account comes through neither: expiry is a bare
  // setUser(false), and the profile is null before and after. Whoever
  // signed in next on the tab was then handed all of it: the hero led at
  // once with the title the last Continue Watching answer named (or, for
  // another account, once its own slow answer outran the wait), over picks
  // the rotation had kept turning while nobody was signed in.
  useEffect(() => {
    if (user !== false) return
    // The search field's words too (see resetUserState): nobody is signed
    // in, so they are nobody's. The address is left where it was, as on any
    // page a session expires on: on /search the next sign-in finds the page
    // with nothing typed. (A described ask needs no clearing here: it is
    // stamped with who made it and handed to the page only for them.)
    setSearchQuery('')
    heroLoadRef.current++
    heroPoolRef.current = []
    setHeroPool(pool => (pool.length ? [] : pool))
    setHeroPersonalization(null)
    setHeroSlateToken(undefined)
    setHeroIndex(0)
    setHeroOnLead(true)
    setHomeHero(null)
    setContinueItems(items => (items.length ? [] : items))
    setContinueFor(null)
    continueItemsRef.current = []
    forgetHeroLeadWait()
  }, [user, forgetHeroLeadWait])
  // A switch also drops everything else App keeps that the server filtered
  // by the previous profile: the browse grids, Continue Watching and the
  // conversational rail (each refetches for the new profile; a failed fetch
  // leaves it empty rather than the old profile's), My Library (its keyed
  // snapshot swaps to the new profile's, see above), and an
  // open title, which goes back through the /title/:id hydration, asks the
  // server again and leaves for Home if the new profile may not see it. The
  // grids used to keep the old profile's titles for the session, with Load
  // More appending the new profile's pages to them. Home's rails come down
  // in the home-rails effect, which loads cold on a switch. Search,
  // collections, the calendar and member pages remount (their keys below).
  const resetForProfileChange = useCallback(() => {
    // The startup binding arriving is not a switch: the catalog, a deep-linked
    // title and My Library wait for it, so nothing here was fetched before
    // it. Only a change after the startup load settled (a switch, another
    // tab's, or a pick from the picker opened for an unreadable binding)
    // resets.
    if (!profilesSettledBeforeRef.current) return
    forgetDescribedAnswer()
    moviesLoadMoreAcRef.current?.abort()
    moviesLoadMoreAcRef.current = null
    showsLoadMoreAcRef.current?.abort()
    showsLoadMoreAcRef.current = null
    setMoviesList(null)
    setShowsList(null)
    setMoviesTotal(null)
    setShowsTotal(null)
    setMoviesNextPage(1)
    setShowsNextPage(1)
    setMoviesLoadingMore(false)
    setShowsLoadingMore(false)
    setContinueItems([])
    setContinueFor(null)
    forgetHeroLeadWait()
    // The ref too, now: it is what a card's Play reads at click time, and it
    // would otherwise hold the previous profile's records until the next
    // commit's effects.
    continueItemsRef.current = []
    if (viewRef.current === 'detail') setSelectedMedia(null)
    // What was being said to the previous profile (see the toasts' effect),
    // and nothing said to the new one since (toastOwnersRef).
    setToasts(t => {
      const kept = t.filter(x => toastOwnersRef.current.get(x.id) === actingProfileRef.current)
      for (const x of t) if (!kept.includes(x)) toastOwnersRef.current.delete(x.id)
      return kept.length === t.length ? t : kept
    })
  }, [forgetHeroLeadWait])
  // A toast is said to whoever is acting when it is raised, and goes when
  // they do: when nobody is signed in, when the account changes, and on a
  // profile switch (above). Toasts were kept through all three, and a
  // toast's timer starts again when the stack is drawn again, so the next
  // person to sign in on the tab was shown "Removed <title> from My
  // Library. Undo" for seven seconds, and after a switch it stayed up under
  // the new profile's name. (Its Undo did nothing for them; the title's
  // name was shown.) The startup binding arriving is not a switch, and
  // drops nothing.
  const toastsUserRef = useRef<number | false | null>(null)
  useEffect(() => {
    const now = user ? user.id : user
    const before = toastsUserRef.current
    toastsUserRef.current = now
    if (now === false || (typeof before === 'number' && before !== now)) setToasts(t => (t.length ? [] : t))
  }, [user])
  useOnProfileChange(activeProfileId, resetForProfileChange)
  // Whether the startup load had settled before this render; written after
  // the effect above has read it, so on the render that settles it and sets
  // the binding together, the reset sees false.
  const profilesSettledBeforeRef = useRef(false)
  useEffect(() => { profilesSettledBeforeRef.current = profilesSettled }, [profilesSettled])
  // homeReloadNonce is deliberately a dependency (trigger-only, like the
  // home-rails and continue-watching effects): the hero was the ONE home
  // surface that never refetched after first load, so a star rating or 👎
  // given from a detail page invalidated the server's hero cache and then
  // nothing ever re-pulled it — the panned title kept headlining Home for
  // the whole session (star-ratings adversarial review, H1). Riding the
  // same staleness nonce means at most one refetch per stale Home return,
  // which is a cheap server-side cache hit whenever taste didn't change.
  useEffect(() => {
    void reloadHeroPool(false)
  }, [reloadHeroPool, homeReloadNonce])

  // A committed 1-2★ rating scrubs the title from the ALREADY-LOADED hero
  // pool immediately — the nonce refetch above re-curates on the next Home
  // return, but until that lands the panned title could still be the
  // on-screen featured hero (it's often the very title the user just came
  // from). Mirrors the thumbs-👎 optimistic removal from homeRails.
  const handleRatedMedia = useCallback((mediaId: number, stars: number) => {
    if (stars === 0 || stars > 2) return
    const pool = heroPoolRef.current.filter(p => p.media.id !== mediaId)
    if (pool.length === heroPoolRef.current.length) return
    heroPoolRef.current = pool
    setHeroPool(pool)
    heroIndexRef.current = 0
    setHeroIndex(0)
    // The hero is derived from the pool (the slate), so it follows. With the
    // pool emptied it is the catalog's stand-in, labelled as that.
  }, [])

  // Tonight's slate: the title to resume, then the picks (lib/tonightSlate).
  // Derived on every render from Continue Watching and the pool as they are,
  // never stored, so it cannot outlive either: a profile switch empties both
  // and the slate with them, and on the commit that makes the switch there
  // is no lead at all.
  const kidsTonight = navScope === 'restricted'
  const heroLead = useMemo(
    () => (profileSwitchPending ? null : resumeLead(continueItems, heroNow)),
    [profileSwitchPending, continueItems, heroNow],
  )
  // Whether the lead is known: Continue Watching has answered for this user
  // and profile, or never will (no profile to ask for: an unreadable binding
  // or a failed profile list, once the startup load has settled).
  // Or the wait for it has run out (leadWaitOverFor).
  const heroOwner = user && personalProfileReady ? `${user.id}:${activeProfileId ?? 'none'}` : null
  const heroLeadSettled = !!user && (heroOwner !== null
    ? continueFor === heroOwner || leadWaitOverFor === heroOwner
    : catalogProfileSettled)
  useEffect(() => {
    heroOwnerRef.current = heroOwner
    if (heroOwner === null || continueFor === heroOwner) return
    const timer = window.setTimeout(() => {
      leadWaitOverForRef.current = heroOwner
      setLeadWaitOverFor(heroOwner)
    }, HERO_LEAD_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [heroOwner, continueFor])
  const heroSlate = useMemo(() => buildSlate(heroLead, heroPool), [heroLead, heroPool])
  const heroSlateIndex = shownSlateIndex(heroSlate, heroOnLead, heroIndex)
  const heroEntry = heroSlateIndex >= 0 ? heroSlate[heroSlateIndex] : null
  // The hero: the slate's entry, else the catalog's fallback (no lead and no
  // picks), else nothing.
  const tonightHero = heroEntry ? heroEntry.media : homeHero
  const heroSlateRef = useRef(heroSlate)
  const heroSlateIndexRef = useRef(heroSlateIndex)
  // useLayoutEffect, not useEffect: the filmstrip hands back a place in the
  // slate it was drawn from, and a press reads the slate here. Mirrored in a
  // passive effect, a press in the frame the strip was drawn in read the
  // slate of the commit before: another pick went up, or none.
  useLayoutEffect(() => { heroSlateRef.current = heroSlate; heroSlateIndexRef.current = heroSlateIndex }, [heroSlate, heroSlateIndex])
  // Put one of the slate's entries up. The lead is a flag; a pick is its
  // place in the recommender's pool, which is also what its exposure is
  // reported under.
  const applySlateEntry = useCallback((entry: SlateEntry | undefined) => {
    if (!entry) return
    if (entry.kind === 'resume') { setHeroOnLead(true); return }
    setHeroOnLead(false)
    if (entry.poolIndex === null) return
    heroIndexRef.current = entry.poolIndex
    setHeroIndex(entry.poolIndex)
  }, [])
  // A choice from the filmstrip. It also restarts the rotation's dwell (see
  // rotEpoch), so the chosen title is not swapped out by a tick that was
  // already due.
  const pickSlateEntry = useCallback((i: number) => {
    heroTouchedForRef.current = heroOwnerRef.current
    applySlateEntry(heroSlateRef.current[i])
    setRotEpoch(e => e + 1)
  }, [applySlateEntry])
  const holdHeroWhileIn = useCallback((inside: boolean) => {
    if (inside) heroTouchedForRef.current = heroOwnerRef.current
    setHeroPaused(inside)
  }, [])
  // Nothing rotates for a reader who asked for less motion, and the pause
  // control is not offered for a rotation that does not run.
  const [reducedMotion] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  const heroRotates = !kidsTonight && !reducedMotion && heroSlate.length > 1

  // "Surprise me" — immediately START a random recommended pick, EXCLUDING the
  // one currently on screen so it always feels like a fresh surprise. (Was
  // wired to reloadHeroPool, which only refetched the pool and — on a stable
  // recommender — visibly did nothing.) Falls back to the current hero when the
  // pool is too small to offer a different title.
  const tonightHeroId = tonightHero?.id
  const onSurprise = useCallback(() => {
    const others = heroPool.filter(p => p.media.id !== tonightHeroId)
    const choices = others.length ? others : heroPool
    const media = choices.length
      ? choices[Math.floor(Math.random() * choices.length)].media
      : homeHero
    if (media) void handlePlay(media)
  }, [heroPool, tonightHeroId, homeHero, handlePlay])

  // "{N} worth your time" counts the real AI-curated set — the
  // personalized hero picks plus the items on the "✨ AI PICK" rails
  // (Discover + "Because you watched"), deduped by id. Varies with the
  // recommender output instead of the fixed ~5 hero-pool size.
  const aiCuratedCount = useMemo(() => {
    const ids = new Set<number>()
    for (const p of heroPool) ids.add(p.media.id)
    for (const r of homeRails ?? []) {
      if (r.aiPick) for (const it of r.items) ids.add(it.id)
    }
    return ids.size
  }, [heroPool, homeRails])

  // 2026-06-05 (Home net-new #1) — fetch the real library total for the
  // greeting's "picked from X titles" clause. One count-only call
  // (per_page=1, no type filter → movies+shows counted together) using the
  // server's total_items. Non-blocking, abortable, and non-fatal: on error
  // we leave homeLibraryCount null and the greeting simply omits the clause
  // (it already gates on a non-null total). The browse-tab counts remain a
  // fallback. Gated on the user's id so we don't fire pre-auth.
  //
  // The server counts the catalog the session's profile may see, so this
  // waits for the startup binding like the catalog does
  // (catalogProfileSettled) and asks again for each profile the session acts
  // as: one request once the startup load settles, and one per switch. It
  // used to run once per sign-in, before the binding was read, so a fresh
  // sign-in that bound the default and then re-selected the profile this
  // browser last showed counted the default's catalog, and a switch kept the
  // previous profile's count. Keyed on the user's id rather than the user
  // object, which is replaced (the cached user, then /me; another tab's auth
  // signal) without the session changing. Only the latest request lands, and
  // an answer is shown only for the user and profile it was asked for, so
  // the commit that switches profile shows no count rather than the previous
  // profile's. The stored answer is dropped whenever the user's id, the
  // profile or the startup settle changes, so it is only ever the current
  // request's: a key alone came back after a sign-out and sign-in in the same
  // tab (the same user and, once the startup load settles, the same
  // profile), and after a switch away and back before the other profile's
  // count landed, showing an answer from before.
  //
  // A scan adding titles updates it through Home's live catalog refresh,
  // which asks for it beside the catalog rails while Home shows and sets it
  // under the same key, so the answer on screen stays until the new one lands.
  const homeLibraryUserId = user ? user.id : null
  const homeLibraryKey = `${homeLibraryUserId}:${activeProfileId}`
  useEffect(() => {
    setHomeLibraryCount(null)
    if (homeLibraryUserId === null || !catalogProfileSettled) return
    const key = `${homeLibraryUserId}:${activeProfileId}`
    const seq = ++homeCountSeqRef.current
    // Asked at this version (see homeCountVersionRef), so the live refresh
    // does not ask again for the same version, a switch's included.
    homeCountVersionRef.current = catalogVersionRef.current
    const ac = new AbortController()
    let cancelled = false
    listMediaWithTotal({ perPage: 1, signal: ac.signal })
      .then(({ total }) => {
        if (cancelled || seq <= homeCountAppliedRef.current) return
        homeCountAppliedRef.current = seq
        setHomeLibraryCount({ key, total })
      })
      .catch(() => { /* non-fatal — greeting omits the clause when null */ })
    return () => { cancelled = true; ac.abort() }
  }, [homeLibraryUserId, catalogProfileSettled, activeProfileId, catalogVersionRef])
  const homeLibraryTotal = homeLibraryCount && homeLibraryCount.key === homeLibraryKey ? homeLibraryCount.total : null

  // Keep heroIndexRef in sync with heroIndex across every change path (the
  // rotation, a choice from the filmstrip, pool resets).
  useEffect(() => { heroIndexRef.current = heroIndex }, [heroIndex])

  // The rotation: every nine seconds the hero moves to the slate's next
  // entry, and back to the first after the last. It is the filmstrip's, so
  // it can be seen (which entry is up) and stopped: by the viewer's pause
  // (heroHold), and for the moment the pointer or focus is in the hero
  // (heroPaused). Not for a reader who asked for less motion, not for the
  // children's presentation, and only while Tonight is on screen: without
  // that gate the interval kept re-rendering App on every other page.
  // heroSlateIndex stays OUT of the deps (it would re-create the interval
  // every tick and drift the cadence); the tick reads it from a ref, and a
  // choice from the filmstrip bumps rotEpoch to restart the dwell.
  useEffect(() => {
    if (view !== 'home' || !heroRotates || heroPaused || heroHold) return
    const id = window.setInterval(() => {
      const slate = heroSlateRef.current
      if (slate.length < 2) return
      applySlateEntry(slate[(Math.max(0, heroSlateIndexRef.current) + 1) % slate.length])
    }, 9000)
    return () => window.clearInterval(id)
  }, [view, heroRotates, heroPaused, heroHold, rotEpoch, applySlateEntry])

  // Home rails, memoized. This was an inline IIFE in the JSX, so every App
  // render — each hero tick, toast, poll, keystroke — built new arrays and
  // every one of the 100–160 cards on Home re-rendered with them. Same
  // logic and inputs; one array identity until an input changes, which is
  // what lets React.memo on MediaCardCinema skip the untouched cards.
  // The profile's own list, for the calmer Tonight's "Your list" rail: only
  // the server's answer for this profile, never this browser's snapshot,
  // which can hold titles saved before the profile's limit was set. Empty
  // (and the same array) for everyone else, so saving a title does not
  // rebuild Home's rails for a session that has no such rail.
  const kidsList = useMemo(
    () => (kidsTonight && libraryServerFor !== null && libraryServerFor === libraryCacheKey ? library : NO_MEDIA),
    [kidsTonight, libraryServerFor, libraryCacheKey, library],
  )
  const homeRailsProp = useMemo<HomeViewProps['rails']>(() => {
    if (!kidsTonight) {
      if (!homeRails && continueItems.length === 0) return undefined
      if (continueItems.length === 0) return homeRails ?? []
    }
    const base = homeRails ?? []
    // Prepend the Continue Watching rail. Dedupe by media_item_id at the
    // rail level so a show with progress on multiple episodes only
    // surfaces one card (most-recently-watched) — avoids duplicate-key
    // warnings and the "click the old card, play the new episode"
    // confusion. LibraryView keeps every row.
    const seen = new Set<number>()
    const deduped = continueItems.filter(c => {
      if (seen.has(c.media_item_id)) return false
      seen.add(c.media_item_id)
      return true
    })
    // 2026-06-05 (Home redesign C) — per-card subtitle map
    // ("S2E4 · 23m left" / "Movie · 1h 12m left") computed
    // here where the source ContinueWatchingItem is in scope
    // (Media alone can't reconstruct remaining time). Keyed by
    // media_item_id to match MediaCardCinema's item.id.
    const cwSubtitles: Record<number, string> = {}
    for (const c of deduped) cwSubtitles[c.media_item_id] = cwSubtitle(c)
    if (kidsTonight) {
      // The calmer Tonight of a profile with a content limit: what it has
      // started, its own list, and the two shelves, on larger cards. None
      // of the recommender's rails, and no "Recently Added".
      const out: NonNullable<HomeViewProps['rails']> = []
      // The hero already holds the title to resume; a rail of one would
      // only repeat it.
      if (deduped.length >= 2) {
        out.push({
          title: 'Keep watching', items: deduped.map(c => mapContinueToMedia(c)) as Media[],
          aspect: 'landscape', kind: 'continue-watching', cardSubtitles: cwSubtitles,
        })
      }
      if (kidsList.length > 0) out.push({ title: 'Your list', items: kidsList, aspect: 'poster', size: 'large' })
      for (const [kind, title] of [['top-movies', 'Movies'], ['top-shows', 'Shows']] as const) {
        const shelf = base.find(r => r.kind === kind)
        if (shelf && shelf.items.length > 0) out.push({ ...shelf, title, size: 'large' })
      }
      // Nothing yet, and the catalog still on its way: the skeleton stands.
      return out.length > 0 || homeRails ? out : undefined
    }
    return [
      {
        title: 'Continue Watching',
        items: deduped.map(c => mapContinueToMedia(c)) as Media[],
        // 2026-06-05 (Home redesign C) — switched to 'landscape'
        // (16:9 backdrop) per the redesign. The cards now lead
        // with the backdrop + a "min left" subtitle rather than
        // poster art; MediaCardCinema renders the landscape
        // aspect, progress bar, resume pill, and subtitle.
        aspect: 'landscape' as const,
        // Stable identifier for HomeView's resume-play
        // interceptor (title is for display only).
        kind: 'continue-watching' as const,
        cardSubtitles: cwSubtitles,
      },
      ...base,
    ]
  }, [homeRails, continueItems, kidsTonight, kidsList])

  // Continue Watching rail. Its own fetch (independent of home
  // rails) so retry/failure paths don't couple. Re-fetches on
  // activeProfileId change.
  //
  // 2026-05-27 (PR #97 H3) — limit bumped from 12 to 50 (server cap)
  // so heavy users with many in-progress titles still get the Resume
  // CTA on the detail view. The rail itself only shows the top ~12
  // by recency, but the detail-view resume lookup needs the FULL
  // list to find a match for any title the user might open. Without
  // this, opening detail for the 13th+ most-recent in-progress title
  // silently lost the Resume affordance and Play restarted at 0:00.
  useEffect(() => {
    if (!user || !personalProfileReady) return
    let cancelled = false
    const ac = new AbortController()
    const owner = `${user.id}:${activeProfileId ?? 'none'}`
    listContinueWatching(50, activeProfileId ?? undefined, ac.signal)
      .then(items => {
        if (cancelled) return
        // The first answer for this session, after the hero stopped waiting
        // for it, with the viewer already doing something in the hero: the
        // title to resume does not take the hero over. (Untouched, it does:
        // the hero is on the lead by default.)
        if (leadWaitOverForRef.current === owner && heroTouchedForRef.current === owner) setHeroOnLead(false)
        // That is decided once: a later refresh of the list is not late.
        leadWaitOverForRef.current = null
        setContinueItems(items)
        setContinueFor(owner)
      })
      .catch(err => {
        // Non-fatal — continue rail just stays empty.
        if (!cancelled && err && (err as Error).name !== 'AbortError') {
          // An answer all the same: the hero stops waiting for a lead.
          setContinueFor(owner)
          console.warn('[Aurora] continue-watching fetch failed', err)
        }
      })
    return () => { cancelled = true; ac.abort() }
    // 2026-05-27 — Re-runs on retryNonce (Retry button bumps both
    // home + CW) AND on cwReloadNonce (player-close bumps only CW so
    // the Resume label freshens without re-fetching home rails).
  }, [user, retryNonce, cwReloadNonce, activeProfileId, personalProfileReady, homeReloadNonce])

  // 2026-05-27 — Bug-report feature-flag probe. Single fetch on user
  // login; the flag is server-config-driven (env var only) so it
  // doesn't change while the SPA is mounted. Failures leave the flag
  // off so a broken /api/feedback/config doesn't dangle a non-
  // functional UI element.
  //
  // Dep keys off the logged-in user's numeric id (deep-debug #9) so
  // cross-tab token-refresh events that recreate the user object
  // identity for the same logged-in account don't trigger a redundant
  // refetch. The user state union is `User | null | false`, so we
  // can't safely use `user?.id` (TS rightly rejects it because
  // `false.id` is nonsense). Pulling the id out via a guard keeps
  // the dep clean.
  //
  // Single cancellation mechanism: AbortController only (deep-debug
  // #20 — dropped the manual `cancelled` flag that was redundant
  // with `signal.aborted` checks).
  // TS already narrows `user && ...` to the User branch (the union
  // is User | null | false; null and false are both falsy), so the
  // truthy check alone gives us `user.id` safely.
  const userIdForBugReport = user ? user.id : undefined
  // Deep-debug M1 — on-demand refresh, asked for each time the dialog
  // is. The server's PAT health check updates every 6h on its own
  // ticker; without the on-demand refresh an admin who stays logged in
  // past a token expiry never sees the banner until next login.
  const refreshBugReportConfig = useCallback(() => {
    if (!userIdForBugReport) return
    getBugReportConfig()
      .then(cfg => setBugReportConfig(cfg))
      .catch(err => {
        if (err && (err as Error).name === 'AbortError') return
        console.warn('[Aurora] bug-report config refresh failed', err)
      })
  }, [userIdForBugReport])
  useEffect(() => {
    if (!userIdForBugReport) return
    const ac = new AbortController()
    getBugReportConfig(ac.signal)
      .then(cfg => {
        if (ac.signal.aborted) return
        setBugReportConfig(cfg)
      })
      .catch(err => {
        if (err && (err as Error).name === 'AbortError') return
        // Non-fatal — the entries just stay hidden.
        console.warn('[Aurora] bug-report config fetch failed', err)
      })
    return () => { ac.abort() }
    // adminUI: the server sends the token's health only with admin powers.
  }, [userIdForBugReport, adminUI])

  // "Report a bug" is in the identity panel and on the Me page. The dialog
  // describes the page it is over (its capture, and the address a report
  // carries), so from Me the app first goes back to the page the person
  // came from: hooks/useBugReportEntry. Only to a page this session's
  // routes would show it now, by the gates the routes themselves use.
  const navigationType = useNavigationType()
  const mayReturnTo = (pathname: string) => {
    const v = pathToView(pathname)
    if (hiddenFromRestricted(v) && !hiddenOk) return false
    // The admin page only for a session shown the admin UI: an admin whose
    // profile is not yet confirmed would be sent back to a page that shows
    // its "checking" notice and nothing else.
    if (v === 'admin' && !adminUI) return false
    return true
  }
  const reportsOn = !!bugReportConfig?.enabled
  const bugReport = useBugReportEntry({
    enabled: reportsOn,
    userId: userIdForBugReport ?? null,
    profileId: activeProfileId,
    location,
    arrivedBy: navigationType,
    viewOf: pathToView,
    shownView: view,
    mayShow: mayReturnTo,
    goTo: path => { navigate(path) },
    goBack: () => { navigate(-1) },
    onAsk: refreshBugReportConfig,
  })

  // An admin's list holds every member's requests (with their usernames) and
  // a restricted session's only the account's own, so it is dropped when the
  // session's profile or its admin powers change: a switch to the kid's
  // profile kept the parent's list on screen, and so did a pick of the kid's
  // when the startup binding could not be read (the app shows no admin UI
  // then, but the list was fetched under whatever the server had bound).
  // Dropped during the render that sees the change, not in an effect after
  // it, so that render never commits the old list.
  const requestsKey = `${activeProfileId}:${adminUI}`
  const [requestsFor, setRequestsFor] = useState(requestsKey)
  if (requestsFor !== requestsKey) {
    setRequestsFor(requestsKey)
    setRequestsList(null)
  }
  // Requests list — lazy-fetch on first visit to the tab, once the startup
  // profile load settles (catalogProfileSettled), so a list fetched for the
  // default before the startup re-selection moves the session is not shown.
  // A fetch in flight across a change of profile is dropped with it.
  useEffect(() => {
    // Not for a session the page is not rendered for (hiddenOk): a restricted
    // session that opens /requests is sent to Tonight by an effect, and must
    // not have asked for the list first.
    if (!user || view !== 'requests' || requestsList !== null || !catalogProfileSettled || !hiddenOk) return
    let cancelled = false
    const ac = new AbortController()
    listRequests(ac.signal)
      .then(items => { if (!cancelled) setRequestsList(items) })
      .catch(err => {
        if (cancelled || (err && (err as Error).name === 'AbortError')) return
        // 404 means requests disabled server-side; show empty list.
        setRequestsList([])
      })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, requestsList, catalogProfileSettled, requestsKey, hiddenOk])

  // Logout — shares resetUserState with the cross-tab logout path.
  const handleLogout = useCallback(async () => {
    party.leave()
    // Best-effort, bounded (1.5s): this device should stop receiving the
    // outgoing account's push notifications, and the DELETE needs the
    // session that apiLogout is about to end. A hung service worker can't
    // hold the logout hostage — the race inside resolves either way.
    await unsubscribePushOnLogout({
      supported: pushSupported(window),
      ready: () => navigator.serviceWorker.ready,
    })
    await apiLogout()
    // Signing out forgets what this account's profiles searched for in this
    // browser (description text included). A session that expires does not
    // come through here and leaves them, as it leaves the My Library
    // snapshot: the same person signs in again.
    if (user) forgetAccountRecentSearches(user.id)
    setUser(false)
    resetUserState()
  }, [party, resetUserState, user])

  if (user === null) {
    // Auth check in flight on a fresh tab with a stored token. Render
    // a minimal splash so we don't flash the login screen for users
    // who are already authenticated. Sub-100ms in the typical case.
    return (
      <div className="min-h-screen flex items-center justify-center aurora-bg">
        <div className="text-white/50 text-sm">Loading Aurora…</div>
      </div>
    )
  }
  if (user === false) {
    return <AuthView onLogin={(u) => setUser(u)} />
  }

  // The nav's presence pill. In a party, it is that party; otherwise the
  // most watched party someone else is running, if any. The list is empty
  // for a session not offered Together and on a profile switch's first
  // commit (useActiveParties), so the pill cannot name another profile's.
  // The bar says who is watching only to a session known to be offered
  // Together; the list is also polled for one that merely may open the page.
  const livePresence = partyPresence(navScope === 'full' ? activeParties.parties : NO_PARTIES, user.id)
  const navPresence: NavPresence | null = party.state.code
    ? { label: 'In a watch party', short: 'In a party', expanded: partyPanelOpen }
    : livePresence.label && livePresence.short
      ? { label: livePresence.label, short: livePresence.short }
      : null
  const settingsPane: SettingsPane | null = settingsPaneFromPath(location.pathname)
  // Something neutral in the page's place until it may render. Nothing for
  // a restricted session: it is about to be sent to Tonight.
  const hiddenPending = hiddenFromRestricted(view) && !hiddenOk && navScope !== 'restricted'
  // A session with the admin powers is listed every member's requests, so
  // its page and menu entry are "Requests"; everyone else's are their own.
  const requestsLabel = adminUI ? 'Requests' : 'My requests'
  // What the phone's top bar calls the page. A restricted session's bar
  // says "Shows", so its page does too.
  const pageTitle = view === 'requests' ? requestsLabel
    : view === 'shows' && navScope === 'restricted' ? 'Shows'
      : PAGE_TITLES[view] ?? ''

  return (
    <div className="min-h-screen bg-surface-page aurora-bg">
      {/* Navigation is <TopNav> at every width, plus <BottomTabBar> below md,
          where the bar's destinations, search and the account page live. */}

      <ServerPanel
        open={serverOpen}
        isAdmin={adminUI}
        onClose={() => setServerOpen(false)}
      />

      <NotificationPanel
        open={notifOpen}
        isAdmin={adminUI}
        onClose={() => setNotifOpen(false)}
        notifications={notifications}
        partyInvites={myPartyInvites}
        onRsvp={handleInviteRsvp}
        onJoinParty={code => void handleJoinInviteParty(code)}
        onMarkAllRead={() => {
          // Before the feed may be read (an admin's waits for the startup
          // profile load) nothing is shown to mark, and the POST would run as
          // whatever profile the session is bound to before the startup
          // re-selection moves it, clearing the parent's admin alerts; the
          // feed read that follows would also reset markedAllReadRef under it.
          if (!realtimeReady) return
          // Only skip once seedResolvedRef confirms unreadCount is trustworthy
          // — before that, 0 can mean "genuinely nothing unread" OR "the seed
          // fetch hasn't landed yet", and treating those the same previously
          // caused this to silently skip both the local mark and the server
          // POST — issue #474. Past that point the endpoint is idempotent, so
          // this is purely avoiding a pointless write on every panel open.
          if (seedResolvedRef.current && unreadCount === 0) return
          markedAllReadRef.current = true
          setUnreadCount(0)
          const now = new Date().toISOString()
          setNotifications(prev => prev.map(n => (n.read_at ? n : { ...n, read_at: now })))
          markAllNotificationsRead().catch(() => {
            // The optimistic local clear stands (matches this endpoint's
            // existing fire-and-forget contract), but un-poison the seed
            // guard: the POST never actually reached the server, so a still
            // in-flight (or not-yet-started) seed fetch's real unread count
            // must NOT be discarded as "stale" — that would strand the badge
            // at 0 for notifications that were never actually marked read.
            markedAllReadRef.current = false
          })
        }}
      />

      {/* Main Content. No left offset any more — the sidebar is gone, so
          pages run the full width of the viewport (Aurora Stage M2).

          Aurora Stage Phase 7b — dimmed and inert behind the theater (D6).
          `inert` is doing the load-bearing work: it blocks pointer events,
          removes every descendant from the tab order, AND hides the subtree from
          assistive tech, which is all three halves of "inert" in one attribute.
          React 19 supports it as a real prop (PlayerControls already relies on
          that). `.stage-dim-app` carries the opacity/saturate and repeats
          pointer-events: none — redundant where inert is supported, and a
          PARTIAL fallback where it isn't (Safari < 15.5): it stops the mouse and
          nothing else. On those browsers the app behind stays tabbable and
          screen-reader reachable. An earlier version of this comment called it
          "the only protection where it isn't", which overstated what
          pointer-events does.

          TWO KNOWN GAPS, both deliberate, both worth knowing about:

          1. `<main>` is not the whole app. ServerPanel, NotificationPanel,
             the toasts, both gates and the party surfaces all
             render as siblings AFTER it, so none of them goes inert — they stay
             tabbable behind the veil. That is right for the party surfaces
             (a watch-party host has to keep using them mid-playback) and it is
             why D6's "focus stays in the theater" is true only modulo an open
             party panel. Cmd+K is now guarded separately; the panels are opened
             from TopNav, which IS inside <main>, so they cannot be opened while
             the theater is up — only left open across the transition.
          2. In browser fullscreen `theaterActive` is false, so <main> un-inerts.
             The app is invisible (the fullscreen element covers it) but Tab still
             walks it. The fullscreen element's own top-layer rendering is what
             hides it, and inerting the page behind a fullscreen element is the
             UA's job, not ours — but a user who tabs while fullscreen does move
             focus into things they cannot see. Issue #436 — iPhone's native
             video-element fullscreen is the same story by a different
             mechanism: there is no document.fullscreenElement at all, so
             `theaterActive` is false there too, but the OS presentation layer
             occludes the page just the same.

          `inert={x || undefined}` rather than `inert={x}` so the attribute is
          absent, not `inert="false"` — the HTML attribute is presence-based. */}
      <main className={`min-h-screen stage-shell ${theaterActive ? 'stage-dim-app' : ''}`} inert={theaterActive || onboardingOpen || undefined}>
        {/* Sticky stack: nav + scan bar in one sticky container so the
            scan bar contributes its height to flow and both pin together
            on scroll. The bar is UNDER the nav, as in the mockup (it was
            above it). */}
        <div ref={chromeRef} className="sticky top-0 z-50">
          <TopNav
            user={user}
            adminUI={adminUI}
            navScope={navScope}
            currentView={view}
            pageTitle={pageTitle}
            onNavigate={handleNavigate}
            onPrefetch={prefetchView}
            searchQuery={searchQuery}
            onSearchQueryChange={(v) => {
              // The first key shows the search page (at its address). With
              // the words deleted the page stays, listing recent searches:
              // it used to drop to Tonight between two tries at a title.
              changeSearchQuery(v)
              if (v) showSearchPage()
            }}
            onSearchSubmit={() => describeSearch(searchQuery)}
            onSearchClear={clearSearch}
            searchInputRef={searchInputRef}
            presence={navPresence}
            onPresenceClick={() => {
              // In a party: the pill is that party, and toggles its panel.
              // Otherwise it is other people's, and leads to Together.
              if (party.state.code) setPartyPanelOpen(o => !o)
              else handleNavigate('together')
            }}
            // The identity menu's rows force-open their panel: a row
            // labelled "Notifications" must never CLOSE it because it
            // happened to be open already.
            onOpenServerPanel={() => { setServerOpen(true); setNotifOpen(false) }}
            onOpenNotificationsPanel={() => { setNotifOpen(true); setServerOpen(false) }}
            notifCount={unreadCount}
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSelectProfile={id => { void switchProfileWatched(id) }}
            onOpenProfilesGate={() => setProfilesGateForced(true)}
            // Profile creation and limits live in Settings' profiles pane.
            onManageProfiles={() => navigate(settingsPath('profiles'))}
            onOpenMyProfile={() => handleNavigate('profile')}
            onOpenRequests={() => handleNavigate('requests')}
            requestsLabel={requestsLabel}
            onReportBug={reportsOn ? bugReport.openHere : undefined}
            onSignOut={() => { void handleLogout() }}
          />
          {/* The scan bar (admin-only). Returns null when no scan is
              active. NOTE: it renders IN FLOW under the nav, so it changes
              the height of this whole sticky stack — which is why chromeRef
              publishes the measured height as --chrome-h (see the effect
              above) for everything anchored below it. */}
          <ScanProgressBar isAdmin={adminUI} onScanComplete={notifyCatalogChanged} onOpenLibraries={openAdminLibraries} />
        </div>{/* /sticky stack */}

        {/* Page Content. The global `p-8` is gone (Aurora Stage M2): pages
            are full-bleed and opt IN to the standard gutter via
            .stage-page, so a hero can reach the viewport edge.
            
            FULL_BLEED_VIEWS opt out entirely because they lead with an
            edge-to-edge hero and pad their own sections with .stage-gutter
            instead (Phase 4 added home/movies/shows to what was just
            `detail`). Everything else keeps the standard page pad. */}
        {isLibraryView(view) && (!hiddenFromRestricted(view) || hiddenOk) && (
          <LibraryHeader
            current={view}
            navScope={navScope}
            onNavigate={handleNavigate}
            onPrefetch={prefetchView}
            // A grid has no heading or toolbar of its own: its name, count,
            // sort, layout and genres are this row's, which stays mounted
            // while the grid reloads for a new sort or genre.
            title={view === 'movies' ? 'Movies' : view === 'shows' ? 'TV Shows' : undefined}
            tools={view === 'movies' ? (
              <BrowseTools
                noun="movie" total={profileSwitchPending ? null : moviesTotal}
                sortBy={moviesSort} onSortChange={handleMoviesSortChange}
                layout={moviesLayout} onLayoutChange={changeBrowseLayout}
                genre={moviesGenre} onGenreChange={handleMoviesGenreChange} genres={moviesGenreList}
              />
            ) : view === 'shows' ? (
              <BrowseTools
                noun="show" total={profileSwitchPending ? null : showsTotal}
                sortBy={showsSort} onSortChange={handleShowsSortChange}
                layout={showsLayout} onLayoutChange={changeBrowseLayout}
                genre={showsGenre} onGenreChange={handleShowsGenreChange} genres={showsGenreList}
              />
            ) : undefined}
            toolsRef={setLibraryToolsEl}
          >
            {view === 'movies' && <GenreChips genre={moviesGenre} onGenreChange={handleMoviesGenreChange} genres={moviesGenreList} />}
            {view === 'shows' && <GenreChips genre={showsGenre} onGenreChange={handleShowsGenreChange} genres={showsGenreList} />}
          </LibraryHeader>
        )}
        {/* A grid sorted by title: its A to Z strip, between the header and
            the grid and a sibling of both, so it can stay under the top bar
            while the grid scrolls. Not while the grid loads, and not for an
            empty one.

            Only for a list that can be loaded whole in the pages a grid
            keeps live (CATALOG_REFRESH_MAX_PAGES): a jump then asks for the
            few pages that are left at most, and the grid is still refreshed
            afterwards. A longer list gets no strip at all: a jump there
            would be a long chain of requests that are each a pass over the
            whole library, and needs a "titles from a letter" request the
            server does not have. */}
        {view === 'movies' && moviesStrip && !!moviesList?.length && (
          <LetterStrip states={moviesJump.states} pending={moviesJump.pending} progress={moviesJump.progress} missing={moviesJump.missing} onJump={moviesJump.jump} />
        )}
        {view === 'shows' && showsStrip && !!showsList?.length && (
          <LetterStrip states={showsJump.states} pending={showsJump.pending} progress={showsJump.progress} missing={showsJump.missing} onJump={showsJump.jump} />
        )}
        {/* A Library scope that keeps its own state hands its controls to the
            header through this (LibraryTools). */}
        <LibraryToolsProvider value={isLibraryView(view) ? libraryToolsEl : null}>
        <div className={FULL_BLEED_VIEWS.has(view) ? undefined : 'stage-page'}>
          {view === 'home' && (
            <HomeView
              onSelect={handleSelect}
              onPlay={handlePlay}
              // During a switch's first render (profileSwitchPending) Home
              // gets what its cold load shows, a loading hero and rail
              // skeletons: the hero, rails, Continue Watching and
              // conversational results in state are the previous profile's
              // until that render's effects clear them.
              // Nor is there a hero before the title to resume is known
              // (heroLeadSettled): it leads, and a pick shown first would be
              // swapped out for it.
              hero={profileSwitchPending || !heroLeadSettled ? undefined : tonightHero ?? undefined}
              // The core rails set the catalog-fallback hero when they land,
              // so until they land (or fail) a pick is still on its way.
              heroLoading={profileSwitchPending || !heroLeadSettled || (homeRails === undefined && !homeError)}
              // Memoized above (homeRailsProp): Continue Watching prepended
              // and deduped.
              rails={profileSwitchPending ? undefined : homeRailsProp}
              loading={profileSwitchPending || homeLoading}
              error={homeError}
              onRetry={requestHomeReload}
              onCardContext={openCardContextMenu}
              // What the hero is, its filmstrip, and its place in the
              // recommender's slate: the entry's own, so a pick chosen from
              // the strip is reported at its position and a title Aurora did
              // not pick (a resume lead outside the pool, the catalog's
              // fallback) is not reported at all.
              heroKind={heroEntry ? heroEntry.kind : 'catalog'}
              heroReason={heroEntry?.reason}
              heroSlate={profileSwitchPending || !heroLeadSettled ? undefined : heroSlate}
              heroSlateIndex={heroSlateIndex}
              onHeroPick={pickSlateEntry}
              heroSlateToken={heroSlateToken}
              heroPosition={heroEntry?.position ?? undefined}
              activeProfileId={activeProfileId ?? undefined}
              // "Surprise me" — play a random recommended pick (not the one shown).
              onSurprise={heroPool.length > 0 ? onSurprise : undefined}
              // "Refresh picks" sits beside the hero's picks, so it asks for
              // new ones there as well as in the recommender's rails (it
              // used to rebuild the rails only, from the greeting band).
              onRefreshRecs={() => { void reloadHeroPool(true); void handleRefreshRecs() }}
              recsRefreshing={recsRefreshing}
              onHeroPauseChange={holdHeroWhileIn}
              heroRotationPaused={heroHold}
              onToggleHeroRotation={heroRotates ? toggleHeroHold : undefined}
              // A party on the hero's title, with the same episode choice a
              // card's menu makes. Not for a profile with a content limit.
              onHeroWatchTogether={navScope === 'full'
                ? (m) => { void startPartyFromCard(m, heroEntry?.record ?? continueItems.find(c => c.media_item_id === m.id && isResumable(c))) }
                : undefined}
              kids={kidsTonight}
              limitLabel={kidsTonight ? profiles.find(p => p.id === activeProfileId)?.max_age_rating?.trim() || undefined : undefined}
              onSwitchProfile={() => setProfilesGateForced(true)}
              heroPersonalization={heroPersonalization}
              libraryIds={libraryIds}
              onToggleLib={handleToggleLib}
              // 2026-06-05 (Home redesign A/F) — greeting band + watch-
              // together inputs.
              user={typeof user === 'object' ? user : undefined}
              // Real count of the AI-curated set (hero picks + AI rails,
              // deduped) — varies, vs the old fixed ~5 hero-pool size.
              pickCount={profileSwitchPending ? 0 : aiCuratedCount}
              // Real library total. Prefer the count-only fetch for the
              // acting profile (homeLibraryTotal — movies+shows in one
              // call; null until it lands for that profile); fall back to
              // the browse-tab counts (moviesTotal / showsTotal, populated
              // lazily when the user visits those tabs). Pass null when none
              // has loaded so HomeView OMITS the "picked from X titles"
              // clause rather than fabricate it. The browse-tab counts are
              // the previous profile's until a switch's reset clears them.
              libraryTotal={
                homeLibraryTotal != null
                  ? homeLibraryTotal
                  : profileSwitchPending || (moviesTotal == null && showsTotal == null)
                    ? null
                    : (moviesTotal ?? 0) + (showsTotal ?? 0)
              }
              // The live strip, for a session offered Together and no other
              // (parties is what turns it on). The party list is the one App
              // polls for the whole app, already empty on the commit that
              // switches profile. The invitations are the account's, the
              // same under any of its profiles.
              parties={navScope === 'full' ? activeParties.parties : undefined}
              invites={myPartyInvites}
              inPartyCode={party.state.code}
              onJoinParty={code => void handleJoinInviteParty(code)}
              onInviteRsvp={handleInviteRsvp}
              // The record the hero resumes from: the lead's own, else the
              // viewer's position in the pick that is up, if they have one
              // (the same threshold every other Resume uses).
              heroResume={(() => {
                if (!tonightHero || profileSwitchPending) return undefined
                const item = heroEntry?.record
                  ?? continueItems.find(c => c.media_item_id === tonightHero.id && isResumable(c))
                return item && isResumable(item) ? { item, onPlay: handlePlayContinue } : undefined
              })()}
              onCardPlay={playOrResume}
              resumableIds={profileSwitchPending ? undefined : resumableIds}
              onNavigate={(v, opts) => {
                // QA 2026-05-25 — "See All" deep-link to a browse
                // page with an explicit sort. If the destination's
                // current sort doesn't match, route through the
                // sort-change handler so the page resets list/total
                // /cursor and refetches with the rail's sort. If it
                // already matches, the cached list is correct and
                // we skip the refetch.
                if (opts?.sortBy && v === 'movies' && opts.sortBy !== moviesSort) {
                  handleMoviesSortChange(opts.sortBy as MediaSort)
                }
                if (opts?.sortBy && v === 'shows' && opts.sortBy !== showsSort) {
                  handleShowsSortChange(opts.sortBy as MediaSort)
                }
                handleNavigate(v)
              }}
            />
          )}
          {/* M10 Phase 2 — Browse views use real API data when loaded.
              While loading, show a brief loading state instead of
              flashing the prototype's mock library to the user. */}
          {view === 'movies' && (
            <ViewSuspense fallback={<BrowseLoadingState compact={moviesLayout === 'compact'} />}>
              {moviesList === null || profileSwitchPending
                ? <BrowseLoadingState compact={moviesLayout === 'compact'} />
                : <BrowseView
                    items={moviesList}
                    total={moviesTotal}
                    layout={moviesLayout}
                    onLoadMore={handleLoadMoreMovies}
                    isLoadingMore={moviesLoadingMore}
                    onSelect={handleSelect}
                    onCardContext={openCardContextMenu}
                    onCardPlay={playOrResume}
                    resumableIds={profileSwitchPending ? undefined : resumableIds}
                    progressById={profileSwitchPending ? undefined : listProgressById}
                    libraryIds={libraryIds}
                    onToggleLib={handleToggleLib}
                  />
              }
            </ViewSuspense>
          )}
          {view === 'shows' && (
            <ViewSuspense fallback={<BrowseLoadingState compact={showsLayout === 'compact'} />}>
              {showsList === null || profileSwitchPending
                ? <BrowseLoadingState compact={showsLayout === 'compact'} />
                : <BrowseView
                    items={showsList}
                    total={showsTotal}
                    layout={showsLayout}
                    onLoadMore={handleLoadMoreShows}
                    isLoadingMore={showsLoadingMore}
                    onSelect={handleSelect}
                    onCardContext={openCardContextMenu}
                    onCardPlay={playOrResume}
                    resumableIds={profileSwitchPending ? undefined : resumableIds}
                    progressById={profileSwitchPending ? undefined : listProgressById}
                    libraryIds={libraryIds}
                    onToggleLib={handleToggleLib}
                  />
              }
            </ViewSuspense>
          )}
          {hiddenPending && <ViewFallback />}
          {view === 'library' && hiddenOk && (
            <HiddenPage name="library"><ViewSuspense fallback={<ViewFallback />}>
              <LibraryView
                library={profileSwitchPending ? NO_MEDIA : library}
                loading={profileSwitchPending || !libraryLoaded}
                continueItems={profileSwitchPending ? NO_CONTINUE : continueItems}
                onSelect={handleSelect}
                onToggleLib={handleToggleLib}
                onCardContext={openCardContextMenu}
                onCardPlay={playOrResume}
                resumableIds={profileSwitchPending ? undefined : resumableIds}
                // The Continue Watching grid's Play resumes its own record.
                onPlayContinue={handlePlayContinue}
                profileName={profileSwitchPending ? undefined : profiles.find(p => p.id === activeProfileId)?.name}
                // An empty list offers what to do next, in place.
                onFind={findInLibrary}
                onBrowse={handleNavigate}
              />
            </ViewSuspense></HiddenPage>
          )}
          {/* /title/:id deep link, selection still hydrating from the
              API — hold the layout with a skeleton instead of a blank
              page (or worse, a flash of the home view). */}
          {view === 'detail' && (!selectedMedia || profileSwitchPending) && <DetailSkeleton />}
          {view === 'detail' && selectedMedia && !profileSwitchPending && (
            <ViewSuspense fallback={<DetailSkeleton />}>
              <DetailView
                // Remount per title, so going from one title straight to
                // another (Cmd+K search, a "more like this" card) carries
                // nothing of the first page's own state into the second.
                key={selectedMedia.id}
                media={selectedMedia}
                onBack={handleBack}
                onPlay={handlePlay}
                onPlayIntent={handlePrimaryIntent}
                onToggleLib={handleToggleLib}
                onRated={handleRatedMedia}
                inLibrary={library.some(l => l.id === selectedMedia.id)}
                profileId={activeProfileId}
                profileReady={personalProfileReady}
                detail={detailItem ?? undefined}
                apiEpisodes={detailEpisodes}
                onPlayEpisode={handlePlayEpisode}
                onEpisodeUnavailable={(ep) => {
                  // Dedupe identical toasts per episode within a 2s
                  // window — mash-protected without losing later
                  // legitimate re-clicks.
                  const now = Date.now()
                  const last = unavailableToastRef.current.get(ep.id) || 0
                  if (now - last < 2000) return
                  unavailableToastRef.current.set(ep.id, now)
                  addToast(`No file available for episode E${ep.episode_number}${ep.title ? ' — ' + ep.title : ''}`, 'info')
                }}
                loading={detailLoading}
                error={detailError}
                // The page passes the episode it would start from the season
                // it is showing. When that season has nothing to play (the
                // viewer moved to it), the party still needs an episode if
                // the show has one anywhere: the card's lookup finds it.
                // A viewer with a place in the show never gets here: the page
                // passes that episode whatever season it is showing (its
                // resume record is the one found for `resume` below), so
                // there is no record to hand the lookup.
                onStartParty={(m, episodeId) => {
                  if (m.type === 'show' && episodeId === undefined) void startPartyFromCard(m, undefined)
                  else handleStartParty(m, episodeId)
                }}
                inParty={!!party.state.code}
                seasons={detailSeasons}
                selectedSeason={detailSelectedSeason}
                onSelectSeason={setDetailSelectedSeason}
                onAddToWatchlist={profiles.length > 0 ? (m) => setAddToListMedia(m) : undefined}
                onRefreshMetadata={adminUI ? handleRefreshMetadata : undefined}
                onIdentify={adminUI ? handleIdentify : undefined}
                onDeleteMedia={adminUI ? handleDeleteMedia : undefined}
                files={detailFiles}
                onPlayFile={handlePlayFile}
                // 2026-05-27 — Continue Watching resume. If the user has
                // partial progress on this media (movie OR a specific
                // episode of a show), find the matching CW record and
                // thread it into DetailView so the Resume CTA renders.
                //
                // Correctness note: `continueItems` is already deduped
                // server-side via `DISTINCT ON (wp.media_item_id) ...
                // ORDER BY wp.media_item_id, wp.updated_at DESC` (see
                // GetContinueWatching in internal/db/queries_phase2.go),
                // so for a show with progress on multiple episodes the
                // returned row is always the most-recently-watched
                // episode — which is exactly the right "Resume" target.
                // `find` therefore returns either the single matching
                // row or undefined; no merge/sort/dedup needed here.
                //
                // isResumable replaces the bare `position_ms > 0` check
                // for parity with Hero / home CW rail / Library CW grid
                // (deep-debug H2 — was the only call site still on > 0,
                // which surfaced "Resume" on detail for sub-5s progress
                // even though no other surface offered the affordance).
                resume={(() => {
                  const item = continueItems.find(c =>
                    c.media_item_id === selectedMedia.id && isResumable(c),
                  )
                  return item ? { item, onPlay: handlePlayContinue } : undefined
                })()}
              />
            </ViewSuspense>
          )}
          {view === 'device' && (
            <DeviceApprovalView
              key={location.key}
              username={user.username}
              initialCode={new URLSearchParams(location.search).get('code') ?? ''}
              // For the sentence that says locked profiles still ask for
              // their PIN on the TV: unknown until the profiles are loaded.
              someProfileUnlocked={profilesLoaded ? profiles.some(p => !p.has_pin) : null}
            />
          )}
          {view === 'search' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <SearchView
                key={`profile-${activeProfileId}`}
                query={searchQuery}
                // The page's own field, shown below md, where the top bar
                // has none. It only sets the query: unlike the bar's field,
                // clearing it does not leave the page it is on.
                onQueryChange={changeSearchQuery}
                // Asked for by Enter in either field, or the page's own
                // button; handed over only while it is still this session's.
                describe={searchDescribe && searchDescribe.owner === searchOwner ? searchDescribe : null}
                onDescribe={describeSearch}
                // A search that finds nothing ends in the titles that can
                // be requested, on the page itself. For a session known to
                // be offered requests: not a profile with a content limit,
                // and not one whose profile is not known yet (the identity
                // menu offers Requests to the same).
                requesting={navScope === 'full' ? searchRequesting : undefined}
                // What this profile searched for lately in this browser. A
                // search is remembered when something is done with it: a
                // result opened or played, or a search by description asked
                // for (describeSearch).
                recent={recentSearches.owner === searchOwner ? recentSearches.list : NO_RECENT}
                onPickRecent={changeSearchQuery}
                onClearRecent={clearRecentSearches}
                focusNonce={searchFocusNonce}
                takeFocus={takeSearchFieldFocus}
                onSelect={selectFromSearch}
                onCardContext={openCardContextMenu}
                onCardPlay={playFromSearch}
                resumableIds={profileSwitchPending ? undefined : resumableIds}
                progressById={profileSwitchPending ? undefined : listProgressById}
                // A party with the best match, and the collections that hold
                // the words: for a session offered Together and the
                // Library's Collections, which a profile with a content
                // limit is not.
                onWatchTogether={navScope === 'full' ? partyFromSearch : undefined}
                onOpenCollection={navScope === 'full' ? collectionFromSearch : undefined}
                libraryIds={libraryIds}
                onToggleLib={handleToggleLib}
              />
            </ViewSuspense>
          )}
          {view === 'settings' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <SettingsView
                pane={settingsPane}
                onPaneChange={(pane) => navigate(settingsPath(pane))}
                user={user}
                onLogout={handleLogout}
                onToast={addToast}
                activeProfile={profiles.find(p => p.id === activeProfileId) ?? null}
                // Known only when the bound profile is in the list (a profile
                // deleted on another device leaves an id the list lacks), or
                // the account has none.
                profileKnown={activeProfileId !== null
                  ? profiles.some(p => p.id === activeProfileId)
                  : profilesLoaded && profiles.length === 0}
                profileSettled={catalogProfileSettled}
                onOpenProfilePage={() => handleNavigate('profile')}
                onProfilesChanged={() => { void listProfiles().then(setProfiles).catch(() => { /* next load refreshes it */ }) }}
              />
            </ViewSuspense>
          )}
          {view === 'member' && hiddenOk && (() => {
            // Social phase 1 — /user/:username. The username lives in the
            // URL (parsed fresh each render, like the detail view's id);
            // the lazy view fetches its own data, so a stale username can't
            // survive a path change. pathToView only maps to 'member' when
            // the regex matches, so uname is never null here in practice —
            // the guard is for the belt-and-braces render race where view
            // lags a popstate by one frame.
            const uname = memberUsernameFromPath(location.pathname)
            return uname ? (
              <HiddenPage name="member"><ViewSuspense fallback={<ViewFallback />}>
                {/* key: remount per username so profile A's in-flight
                    fetches (connections, follow toggle) can't write into
                    profile B's freshly-seeded state (PR-429 review). */}
                <UserProfileView
                  key={`${uname}:${activeProfileId}`}
                  username={uname}
                  onSelect={handleSelect}
                  onCardContext={openCardContextMenu}
                  onOpenMember={(u) => navigate(`/user/${encodeURIComponent(u)}`)}
                />
              </ViewSuspense></HiddenPage>
            ) : null
          })()}
          {view === 'together' && hiddenOk && (
            <HiddenPage name="together"><ViewSuspense fallback={<ViewFallback />}>
              <TogetherView
                // Remount per account and profile: the view holds its own
                // state (a join in flight, a refusal), and nothing of one
                // session's may show under another's name. The account is
                // part of the key because two accounts with no profiles would
                // otherwise share it across a sign-out and sign-in.
                key={`together:${user.id}:${activeProfileId}`}
                currentUserId={user.id}
                profileId={activeProfileId}
                activeParties={activeParties.parties}
                partiesLoaded={activeParties.loaded}
                partiesFailed={activeParties.failed}
                invites={profileSwitchPending ? null : myPartyInvites}
                inPartyCode={party.state.code ?? null}
                onOpenPartyPanel={() => setPartyPanelOpen(true)}
                onJoinParty={async (code) => {
                  const r = await party.join(code)
                  if (r.ok) { setPartyPanelOpen(true); activeParties.reload() }
                  return r
                }}
                onOpenTitle={(id) => navigate(`/title/${id}`)}
                onRsvp={handleInviteRsvp}
                onRefreshInvites={refreshMyPartyInvites}
                onOpenMembers={() => handleNavigate('members')}
                onOpenMember={(u) => navigate(`/user/${encodeURIComponent(u)}`)}
                // To the catalog, by name. The Library destination opens the
                // library scope last used, which can be My Library: a saved
                // list, possibly empty, is not where to pick something from.
                onBrowse={() => handleNavigate('movies')}
              />
            </ViewSuspense></HiddenPage>
          )}
          {view === 'profile' && hiddenOk && (
            <HiddenPage name="profile"><ViewSuspense fallback={<ViewFallback />}>
              <MyProfileView
                key={`profile:${activeProfileId}`}
                user={user}
                activeProfile={profileSwitchPending ? null : profiles.find(p => p.id === activeProfileId) ?? null}
                profileKnown={personalProfileReady && !profileSwitchPending}
                onOpenMember={(u) => navigate(`/user/${encodeURIComponent(u)}`)}
                onOpenSettings={(pane) => (pane ? navigate(settingsPath(pane)) : handleNavigate('settings'))}
                onToast={addToast}
                onProfilesChanged={() => { void listProfiles().then(setProfiles).catch(() => { /* next load refreshes it */ }) }}
              />
            </ViewSuspense></HiddenPage>
          )}
          {view === 'me' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <MeView
                user={user}
                navScope={navScope}
                adminUI={adminUI}
                profiles={profiles}
                activeProfileId={activeProfileId}
                notifCount={unreadCount}
                onSelectProfile={id => { void switchProfileWatched(id) }}
                onManageProfiles={() => navigate(settingsPath('profiles'))}
                onOpenNotifications={() => { setNotifOpen(true); setServerOpen(false) }}
                onOpenMyProfile={() => handleNavigate('profile')}
                onOpenRequests={() => handleNavigate('requests')}
                requestsLabel={requestsLabel}
                onOpenSettings={() => handleNavigate('settings')}
                onReportBug={reportsOn ? bugReport.openFromMe : undefined}
                onOpenAdmin={() => handleNavigate('admin')}
                onOpenServer={() => { setServerOpen(true); setNotifOpen(false) }}
                onSignOut={() => { void handleLogout() }}
              />
            </ViewSuspense>
          )}
          {view === 'members' && hiddenOk && (
            <HiddenPage name="members"><ViewSuspense fallback={<ViewFallback />}>
              <MembersView
                onOpenMember={(u) => navigate(`/user/${encodeURIComponent(u)}`)}
                currentUsername={user.username}
                onToast={addToast}
              />
            </ViewSuspense></HiddenPage>
          )}
          {/* Not before the startup profile load settles
              (catalogProfileSettled): it fetches on mount, and a fresh
              sign-in is bound to the default (an admin's powers) until the
              startup re-selection moves it, so it showed other members'
              private collections to the kid's tab. The load settles too when
              the binding cannot be read or the profile list fails, and the
              view then mounts under whatever the server has bound, as the
              catalog does. */}
          {view === 'collections' && hiddenOk && !catalogProfileSettled && <ViewFallback />}
          {view === 'collections' && hiddenOk && catalogProfileSettled && (
            <HiddenPage name="collections"><ViewSuspense fallback={<ViewFallback />}>
              <CollectionsView
                key={`profile-${activeProfileId}-${adminUI}`}
                isAdmin={adminUI}
                rewindNonce={navRewindNonce}
                open={collectionAsk && collectionAsk.owner === searchOwner ? collectionAsk : null}
                onOpenTaken={forgetCollectionAsk}
                onOpenCreate={() => setCollectionsModalOpen(true)}
                onOpenMedia={(id) => {
                  // Synthesize a minimal Media shape for handleSelect;
                  // the detail fetch hydrates full data.
                  handleSelect({
                    id,
                    title: '',
                    year: 0,
                    rating: 0,
                    duration: '',
                    genre: '',
                    type: 'movie',
                    poster: '',
                    description: '',
                  })
                }}
                // QA BUG-007 — pass the same library affordance other
                // surfaces (Movies/Shows/Search) already have. Map the
                // ServerMediaItem to UIMedia carrying real poster/year/
                // rating/genre so toggling into My Library persists the
                // full record to localStorage (otherwise the stored
                // entry shows up as a posterless year-0 placeholder
                // until the next /api/media refresh re-hydrates it).
                libraryIds={libraryIds}
                onToggleLib={(m) => handleToggleLib(collectionItemToMedia(m))}
                onCardContext={(e, m) => openCardContextMenu(e, collectionItemToMedia(m))}
              />
            </ViewSuspense></HiddenPage>
          )}
          {/* Phase 6 — Calendar view (upcoming TV episodes). */}
          {view === 'calendar' && hiddenOk && (
            <HiddenPage name="calendar"><ViewSuspense fallback={<ViewFallback />}>
              <CalendarView
                key={`profile-${activeProfileId}`}
                onOpenMedia={(id) => {
                  handleSelect({
                    id,
                    title: '',
                    year: 0,
                    rating: 0,
                    duration: '',
                    genre: '',
                    type: 'show',
                    poster: '',
                    description: '',
                  })
                }}
                currentUserId={user.id}
                onJoinParty={code => void handleJoinInviteParty(code)}
              />
            </ViewSuspense></HiddenPage>
          )}
          {view === 'requests' && hiddenOk && (
            <HiddenPage name="requests"><ViewSuspense fallback={<ViewFallback />}>
              <RequestsView
                everyone={adminUI}
                requests={requestsList}
                userId={user.id}
                onRequestSubmitted={requestsPage.submitted}
                onRequestDeleted={requestsPage.deleted}
                onRequestMoved={requestsPage.moved}
                // Asking for a title is the end of a search that finds
                // nothing: the page's row opens the search page with its
                // field ready (the bar's, or on a phone the page's own).
                onAsk={() => { handleNavigate('search'); searchInputRef.current?.focus() }}
                onFind={findInLibrary}
              />
            </ViewSuspense></HiddenPage>
          )}
          {/* security — gate the mount on role, not just the view string.
              The sidebar link is admin-only, but typing /admin would otherwise
              mount AdminView for any signed-in user (server data is 403-backstopped,
              but the UI must not mount). A non-admin who lands here is redirected
              home by the effect below. adminUI also needs the session to act
              as an unrestricted profile, as the server's admin routes do. */}
          {view === 'admin' && adminUI && (
            <ViewSuspense fallback={<ViewFallback />}>
              {/* sectionAsk: the scan bar's "Open Libraries" opens the page
                  on that section, also when the page is already up on
                  another, and without mounting it again. */}
              <AdminView currentAdminId={user.id} catalogVersion={catalogVersion} initialSection={adminAsk > 0 ? 'libraries' : undefined} sectionAsk={adminAsk} />
            </ViewSuspense>
          )}
          {/* An admin whose session's profile is not known yet (startup), or
              could not be read (the profile list failed): say so, rather than
              a blank page. A known restricted profile is sent home instead. */}
          {view === 'admin' && user.role === 'admin' && !adminUI && !actingRestricted && (
            <p role="status" className="text-white/50 text-sm text-center py-16">
              {!profilesSettled
                ? 'Checking your profile…'
                : profilesGateForced
                  ? 'Pick a profile to continue.'
                  : "Couldn't confirm which profile this session uses, so the admin pages are hidden. Reload to try again."}
            </p>
          )}
        </div>
        </LibraryToolsProvider>
        <BottomTabBar
          currentView={view}
          navScope={navScope}
          onNavigate={handleNavigate}
          onPrefetch={prefetchView}
          live={navPresence !== null}
          notifCount={unreadCount}
          activeProfile={profiles.find(p => p.id === activeProfileId) ?? null}
          username={user.username}
        />
      </main>

      {/* The player. Mounted for the life of the app and shown while it has
          a target; it reports the surface it presents (onSurfaceChange). */}
      {playerLoading && !playerTarget && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center">
          <div className="text-white/70 text-sm">Resolving stream…</div>
        </div>
      )}
      <VideoPlayer
        target={playerTarget}
        profileId={activeProfileId}
        onEnded={handlePlaybackEnded}
        onPartyAdvance={handlePartyAdvance}
        isAdmin={adminUI}
        onRemoteActiveChange={(active) => { playerRemoteActiveRef.current = active }}
        onSurfaceChange={setPlayerSurface}
        onToast={addToast}
        onClose={() => {
          closePlayer()
          // 2026-05-27 (PR #97 H2) — refetch Continue Watching after
          // the player closes so the Resume CTA on detail picks up the
          // new position_ms. Without this, after the user watches for
          // 10 minutes and re-opens detail in the same session, the
          // Resume label still shows the OLD position and clicking it
          // jumps back. Dedicated cwReloadNonce (not the broader
          // retryNonce) keeps this scoped to the CW fetch — no wasted
          // home-rails refetch on every player close.
          setCwReloadNonce(n => n + 1)
        }}
        onChangeAudioTrack={(index, resumeMs) => {
          // Re-emit target with the new audio index. The player
          // tears down + recreates the HLS session; thread the live
          // position through resumePositionMs so playback resumes
          // where the user actually was.
          setPlayerTarget(prev => prev ? {
            ...prev,
            audioTrackIndex: index,
            resumePositionMs: resumeMs,
          } : prev)
        }}
        onSendReaction={party.state.code && party.state.roomConnected ? party.sendReaction : undefined}
        onFallbackToTranscode={(resumeAtMs) => {
          // Re-emit current target with forceTranscode=true. The
          // player's mediaErrorFallbackTriedRef prevents an infinite
          // loop if transcode also fails. resumeAtMs (2026-07 review)
          // carries the CURRENT playback position into the retry — a
          // mid-movie fallback used to restart at the target's original
          // resume point, losing up to hours of position.
          setPlayerTarget(prev => prev ? {
            ...prev,
            forceTranscode: true,
            resumePositionMs: resumeAtMs !== undefined && resumeAtMs > 0
              ? Math.floor(resumeAtMs)
              : prev.resumePositionMs,
          } : prev)
        }}
        onSeekRebuild={(newStartSec) => {
          // 2026-05-27 — Forward-seek past buffer. Same teardown +
          // re-init pattern as onChangeAudioTrack: mutate the target
          // with a fresh resumePositionMs, which retriggers the play
          // effect inside VideoPlayer and creates a new HLS session
          // anchored at the new position.
          //
          // This remains a pure target-mutator. VideoPlayer owns policy:
          // ordinary playback rebases locally; a party host broadcasts the
          // absolute seek first, and each guest rebases independently after
          // receiving the explicit server seek frame.
          setPlayerTarget(prev => prev ? {
            ...prev,
            resumePositionMs: Math.max(0, Math.floor(newStartSec * 1000)),
          } : prev)
        }}
        party={party.state.code ? {
          isHost: party.state.hostUserId === user.id,
          currentUserId: user.id,
          tickRef: party.tickRef,
          seekRef: party.seekRef,
          helloAbsMsRef: party.helloAbsMsRef,
          hlsStartSec: party.state.hlsStartSec,
          isPlaying: party.state.isPlaying,
          rev: party.state.rev,
          // Thread the party's mediaItemId so the player can refuse
          // to mirror when local content doesn't match.
          partyMediaItemId: party.state.mediaItemId,
          // Issue #488 review — episode-level companion to partyMediaItemId
          // (which is series-level and unchanged across an episode
          // advance) so the guest drift-rebuild check can tell a stale
          // `target` from a genuine cross-session anchor mismatch.
          partyEpisodeId: party.state.episodeId,
          requestPlay: party.requestPlay,
          requestPause: party.requestPause,
          requestSeek: party.requestSeek,
          // 2026-05-25 — NTP-style clock offset for drift extrapolation.
          // Filled by repeated time-syncs on the sync socket.
          clockOffsetRef: party.clockOffsetRef,
          // 2026-06-15 — smoothed RTT from the same time-sync, surfaced
          // for the opt-in sync-debug telemetry only.
          rttRef: party.rttRef,
        } : undefined}
      />

      {/* Floating reaction overlay — renders independently of the
          player so panel-only users still see reactions. */}
      {party.state.code && <ReactionOverlay events={party.state.recentReactions} />}

      {partyPanelOpen && party.state.code && (
        <PartyPanel
          state={party.state}
          currentUserId={user.id}
          onSendChat={party.sendChat}
          onSendReaction={party.sendReaction}
          onLeave={() => { party.leave(); setPartyPanelOpen(false); setPartyVariant('rail'); setPartyInviteOpen(false) }}
          onClose={() => { setPartyPanelOpen(false); setPartyVariant('rail'); setPartyInviteOpen(false) }}
          // 2026-08 — host succession. Leaving hands the party off, so
          // ending it for everyone is its own deliberate action. end()
          // is async and only tears down on success — mirror the leave
          // path's UI resets only when it reports ok, so a failed end
          // (party stays live) keeps the panel open.
          onEndParty={() => {
            void party.end().then(ok => {
              if (ok) { setPartyPanelOpen(false); setPartyVariant('rail'); setPartyInviteOpen(false) }
            })
          }}
          // Feature 2 — Cinematic Overlay. variant + toggle flip the panel
          // between the floating glass rail and the minimal ticker/pill/
          // dock face (composed inside PartyPanel). The dock button in the
          // header calls onToggleVariant; the × still closes via onClose.
          variant={partyVariant}
          onToggleVariant={() => setPartyVariant(v => (v === 'rail' ? 'minimal' : 'rail'))}
          // Host-only "invite to party" affordance (rail header). Opens the
          // PartyInvite card (code + QR deep link) so guests can join from a
          // phone. Only wired for the host so guests don't see it.
          onInvite={
            party.state.hostUserId === user.id
              ? () => setPartyInviteOpen(o => !o)
              : undefined
          }
          voice={party.voice}
          onJoinVoice={() => {
            party.joinVoice().catch(err => {
              const id = nextToastId()
              // 2026-05-26 — copy now distinguishes real-world failure modes
              // using the `reason` tag the voice controller attaches via the
              // Permissions API. The original "Microphone blocked — allow
              // access in your browser" was misleading for users who HAD
              // granted browser permission but were blocked at the OS level
              // (macOS Privacy & Security → Microphone → Browser unchecked):
              // they kept toggling the browser prompt while the real fix
              // was in System Settings.
              const reason = (err as { reason?: string })?.reason
              let message = 'Microphone unavailable. Check that no other app is using it.'
              if (err instanceof Error && err.name === 'NotAllowedError') {
                if (reason === 'denied') {
                  // Browser-API state is "denied" — could be browser-level
                  // (site-blocked) OR OS-level (browser-not-in-allowlist).
                  // The OS one is the surprise; spell it out so the user
                  // doesn't bounce off the browser prompt.
                  message = 'Microphone blocked. Allow it in your browser AND in System Settings → Privacy → Microphone (your browser must be checked).'
                } else if (reason === 'prompt') {
                  message = 'Microphone permission needed — click Allow in the browser prompt to join voice.'
                } else if (reason === 'device') {
                  // 2026-05-27 (deep-debug Bug 12) — the browser reports
                  // "granted" but getUserMedia still threw NotAllowedError.
                  // Most likely (a) macOS/Windows mic privacy blocking the
                  // browser at the OS level (Permissions API can't see
                  // this), or (b) another app holds the mic exclusively.
                  // Mention BOTH so the user can troubleshoot either path
                  // — the original "device unavailable" copy missed the OS
                  // case entirely.
                  message = 'Microphone permission OK in the browser, but the audio stream was blocked. Check your operating system privacy settings, or close any other app that may have the microphone open.'
                } else {
                  // Permissions API not supported (older Safari) or query
                  // failed — fall back to the original wording.
                  message = 'Microphone blocked — allow access in your browser to join voice.'
                }
              }
              setToasts(prev => [...prev, { id, message, type: 'error' }])
              // Also surface to console for users / support to inspect.
              // The err here is a DOMException from getUserMedia, which
              // carries only {name, message, code} — no tokens, no
              // internal URLs. Safe to log. If anyone wraps this err with
              // extra context in the future (e.g. iceServers URL, session
              // token), audit that the new fields are safe to log here
              // before merging.
              // eslint-disable-next-line no-console
              console.warn('[Aurora Voice] join failed', { name: (err as Error)?.name, reason, err })
            })
          }}
          onLeaveVoice={party.leaveVoice}
          onToggleVoiceMute={party.toggleVoiceMute}
          onSendReady={party.sendReady}
          onStartNow={party.requestPlay}
          onReschedule={iso => {
            const code = party.state.code
            if (!code) return
            schedulePartyStart(code, iso)
              .then(() => {
                setToasts(prev => [...prev, {
                  id: nextToastId(),
                  message: `Party moved to ${formatPartyTime(iso, new Date())} — everyone in the lobby sees the new countdown`,
                  type: 'success',
                }])
              })
              .catch(err => {
                setToasts(prev => [...prev, {
                  id: nextToastId(),
                  message: err instanceof Error ? err.message : 'Failed to reschedule',
                  type: 'error',
                }])
              })
          }}
        />
      )}

      {/* Feature 1 host affordance — invite card (join code + scannable QR
          deep link to the mobile companion). Host-only, opened from the
          rail header "invite" button. Floats centered over the player as a
          lightweight modal; the rail stays mounted behind it. Suppressed in
          minimal mode (the rail header — and thus the invite button — isn't
          visible there). */}
      {partyInviteOpen && partyPanelOpen && party.state.code &&
        party.state.hostUserId === user.id && partyVariant === 'rail' && (
        <div
          className="fixed inset-0 z-[75] flex items-center justify-center p-4 bg-[var(--scrim)] motion-safe:animate-fade-in"
          onClick={() => setPartyInviteOpen(false)}
        >
          <div onClick={e => e.stopPropagation()} className="w-full max-w-sm">
            <PartyInvite
              code={party.state.code}
              partyName={party.state.partyName || party.state.mediaTitle}
              onClose={() => setPartyInviteOpen(false)}
            />
          </div>
        </div>
      )}

      {/* "Who's watching?" (D7) — self-gating on the per-device flag and on
          there being more than one profile to choose between. It composites
          ABOVE the taste gate (z-85 over OnboardingFlow's z-80): pick who you
          are, then onboard that profile, never the other way round. Render order
          alone did NOT achieve that — both gates self-gate independently, and
          when both were up the opaque z-80 taste flow covered the picker. */}
      <ProfilesGate
        profiles={profiles}
        activeProfileId={activeProfileId}
        onSelect={switchProfileWatched}
        onAddProfile={() => handleNavigate('settings')}
        // `ready` = the list has actually been fetched. It must NOT be
        // `profiles.length > 0`: the policy's own `profileCount < 2` check
        // already covers that, so as wired it was a tautology and the test
        // asserting the gate is suppressed pre-load was proving nothing.
        ready={profilesLoaded}
        forced={profilesGateForced}
        onDismiss={() => setProfilesGateForced(false)}
        onOpenChange={setProfilesGateOpen}
      />

      {pinTarget && (
        <ProfilePinDialog profile={pinTarget} onSubmit={unlockProfile} onCancel={cancelPin} />
      )}

      {/* Taste onboarding ("Pick What You Love") — self-gating: renders only
          when the active profile is eligible and hasn't completed it, and
          mounts only once that profile is known (personalProfileReady).
          Existing users get prompted once at next login. */}
      {personalProfileReady && (
        <TasteOnboardingGate
          profileId={activeProfileId}
          profile={profiles.find(p => p.id === activeProfileId) ?? null}
          soleUnrestricted={isSoleUnrestrictedProfile(profiles, activeProfileId)}
          // The picker and the PIN prompt are drawn over the flow: while
          // either is up the flow is out of reach.
          covered={profilesGateOpen || !!pinTarget}
          onOpenChange={setOnboardingOpen}
          onComplete={() => window.location.reload()}
        />
      )}

      {collectionsModalOpen && (
        <CollectionsModal
          isAdmin={adminUI}
          onClose={() => setCollectionsModalOpen(false)}
          onCreated={(c) => {
            const id = nextToastId()
            setToasts(prev => [...prev, {
              id,
              message: `Created "${c.name}"${c.kind === 'ai' && c.item_count ? ` with ${c.item_count} AI picks` : ''}`,
              type: 'success',
            }])
          }}
        />
      )}

      {addToListMedia && activeProfileId && (
        <div className="fixed inset-0 z-[70] bg-[var(--scrim)] flex items-center justify-center p-4 stage-scrim-in" onClick={() => setAddToListMedia(null)}>
          <div role="dialog" aria-label={`Add "${addToListMedia.title}" to a watchlist`} className="w-full max-w-sm bg-[color:var(--surface-1)] border border-white/[0.06] rounded-2xl p-5 stage-dialog-in" onClick={e => e.stopPropagation()}>
            <h2 className="text-white text-lg font-semibold mb-2">Add "{addToListMedia.title}" to…</h2>
            <p className="text-white/50 text-xs mb-4">Profile: {profiles.find(p => p.id === activeProfileId)?.name}</p>
            {addToListLists === null && <p className="text-white/50 text-sm">Loading…</p>}
            {addToListLists && addToListLists.length === 0 && (
              <div className="text-white/50 text-sm mb-3">
                No lists yet. Make one in Settings, under Profiles and parental controls: open a profile and add a list.
              </div>
            )}
            {addToListLists && addToListLists.map(l => (
              <button
                key={l.id}
                disabled={addToListBusy}
                onClick={async () => {
                  setAddToListBusy(true)
                  try {
                    await addToWatchlist(activeProfileId, l.id, addToListMedia.id)
                    const tId = nextToastId()
                    setToasts(prev => [...prev, { id: tId, message: `Added to "${l.name}"`, type: 'success' }])
                    closeAddToList()
                  } catch (err) {
                    window.alert('Failed: ' + (err instanceof Error ? err.message : 'unknown'))
                  } finally {
                    setAddToListBusy(false)
                  }
                }}
                className="w-full text-left px-4 py-2.5 mb-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/85 text-sm transition-colors disabled:opacity-50"
              >
                {l.name}
              </button>
            ))}
            <button
              onClick={closeAddToList}
              className="w-full mt-3 py-2 text-white/60 hover:text-white text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Watch-party invite composer — "Plan a Watch Party" (now or
          scheduled + people picker). Opened by the detail page's Party
          action; the launch sequence lives in launchComposerParty. */}
      {partyComposer && user && typeof user === 'object' && (
        <PartyComposerModal
          mediaTitle={partyComposer.media.title}
          mediaType={partyComposer.media.type}
          currentUsername={user.username}
          onClose={() => setPartyComposer(null)}
          onLaunch={launch => launchComposerParty(partyComposer.media, partyComposer.episodeId, launch)}
        />
      )}

      {/* Not on the commit that switches profile: the menu is the previous
          profile's (see the effect that closes it). */}
      {contextMenu && !profileSwitchPending && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          title={contextMenu.title}
          reason={contextMenu.reason}
          opener={contextMenu.opener}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Manual identify modal (admin-only). Rendered at App level so
          it overlays any screen. Same modal as Admin → Flagged. */}
      {identifyTarget && (
        <ManualMatchModal
          target={identifyTarget}
          onClose={handleIdentifyClose}
          onMatched={handleIdentifyMatched}
        />
      )}

      {/* The bug report dialog. Mounted while the server takes reports
          (BUG_REPORT_ENABLED), so a misconfigured deploy offers nothing
          that cannot work, and for nothing else: not the player, not a
          panel. A recording or a capture in progress must outlive a player
          that a watch party opens over the page.
          - prefillName is the display username, NOT the email, so a
            public-repository deploy does not put emails into issue bodies.
          - The token's health is an admin's; a switch to a restricted
            profile hides it at once, ahead of the refetch above. */}
      {reportsOn && (
        <BugReportHost
          open={bugReport.open}
          dismissed={bugReport.dismissed}
          onClose={bugReport.close}
          prefillName={user.username}
          onToast={addToast}
          tokenHealthy={adminUI ? bugReportConfig?.token_healthy : undefined}
          tokenHealthReason={adminUI ? bugReportConfig?.token_health_reason : undefined}
          focusFallback={focusPageStart}
        />
      )}

      {/* Toast */}
      {/* None on a switch's first commit: they were said to the previous
          profile, and are dropped by the reset that follows that commit. */}
      <ToastContainer toasts={profileSwitchPending ? NO_TOASTS : toasts} onRemove={removeToast} />
    </div>
  )
}
