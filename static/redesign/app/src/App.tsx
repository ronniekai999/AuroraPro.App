import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, lazy } from 'react'
import { useNavigate, useLocation } from 'react-router'
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
  getGamificationStats,
  listActiveParties,
  type ActiveParty,
  type GamificationStats,
  listContinueWatching,
  listRequests,
  getBugReportConfig,
  type BugReportConfig,
  mapContinueToMedia,
  searchMedia,
  createQuickParty,
  sendPartyInvites,
  listMyPartyInvites,
  rsvpPartyInvite,
  schedulePartyStart,
  type MyPartyInvite,
  login as apiLogin,
  logout as apiLogout,
  posterURL,
  backdropURL,
  getAdminDashboard,
  listAdminActivity,
  listProfiles,
  activateProfile,
  setProfileMaturity,
  updateProfile,
  listWatchlists,
  addToWatchlist,
  submitMediaFeedback,
  refreshMetadata,
  deleteMedia,
  markWatched,
  clearProgress,
  getSetupStatus,
  register,
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
  type SetupStatus,
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
import { PartyHubModal } from '@/components/PartyHubModal'
import { PartyComposerModal, type PartyComposerLaunch } from '@/components/PartyComposerModal'
import { formatPartyTime, skipReasonCopy, inviteCodeFromLink } from '@/lib/partyInvites'
import {
  isPlaybackResolutionCurrent,
  partyPlayerDismissalKeyOnClose,
  shouldAutoOpenPartyPlayer,
  shouldClosePlayerOnPathChange,
} from '@/lib/partyPlayer'
import { HeroSection } from '@/components/HeroSection'
import { AuroraWordmark } from '@/components/AuroraWordmark'
import { MediaRail } from '@/components/MediaRail'
import { BugReportButton } from '@/components/BugReportButton'
import { ReactionOverlay } from '@/components/ReactionOverlay'
import { anchorFor, ContextMenu, type MediaContextItem } from '@/components/ContextMenu'
import { ScanProgressBar } from '@/components/ScanProgressBar'
import { SearchPalette } from '@/components/SearchPalette'
// Phase 6 — Collections, Calendar, Gamification UI components.
import { CollectionsModal } from '@/components/CollectionsModal'
import { TasteOnboardingGate } from '@/components/TasteOnboarding'
import { ProfilesGate } from '@/components/ProfilesGate'
import { TopNav } from '@/components/TopNav'
// Phase 6 — Dynamic theming: extract a dominant color from a poster
// to tint the detail view's accent buttons.
import { usePanelDismiss } from '@/hooks/usePanelDismiss'
import { useParty } from '@/hooks/useParty'
import { useRealtime } from '@/hooks/useRealtime'
// 2026-06-17 (app split) — leaves extracted to shared modules so the
// lazy view chunks (AdminView etc.) can import them without reaching
// back into App. Icon is a pure SVG leaf; formatRequestDate is a pure
// date formatter (no @/lib/api dep → no cycle).
import { Icon } from '@/components/Icon'
import { ToastContainer, type Toast } from '@/components/Toast'
import { Spinner } from '@/components/ui/spinner'
import { oauthProviderLabel, OAUTH_SIGN_IN_PROVIDERS, type OAuthProvider } from '@/lib/oauth'
import { type Media } from '@/lib/types'
import { isResumable } from '@/lib/format'
import { currentPreferredQuality } from '@/lib/appearance'
import { lockBodyScroll } from '@/lib/scrollLock'
import { prewarm, cancelPrewarm, prewarmEnabled } from '@/lib/prewarm'
import { shouldRefreshHome, shouldResetPersonalizedRails } from '@/lib/homeRefresh'
import { pushSupported, bootResyncPush, unsubscribePushOnLogout } from '@/lib/push'
import { syncAppBadge } from '@/lib/pwa'
import { ViewSuspense, ViewFallback } from '@/components/ViewSuspense'
import ManualMatchModal from '@/components/admin/ManualMatchModal'

// 2026-06-17 (app split) — Admin is the first lazy-loaded view chunk.
// Non-admins never fetch the ~2,330-line admin bundle; it loads on
// first /admin nav by an admin, with <ViewFallback> as the Suspense
// placeholder. ErrorBoundary in main.tsx catches chunk-load failures
// (offline / stale deploy); ViewSuspense complements it.
const AdminView = lazy(() => import('@/components/admin/AdminView'))
// 2.1 — Collections & Calendar are already standalone modules; the
// only change is swapping their static import for a lazy import and
// wrapping the render site in <ViewSuspense>. First slice to exercise
// the lazy + ViewSuspense wiring end-to-end.
const CollectionsView = lazy(() => import('@/components/CollectionsView'))
const CalendarView = lazy(() => import('@/components/CalendarView'))
// 2.2 — Settings (profile, connected accounts, profiles + watchlists,
// appearance / content-tone). ConnectedAccountsCard rides along as a
// module-private helper; the OAuth provider-label helper it shares with
// App's link-mode toast moved to @/lib/oauth. Loads on first /settings nav.
const SettingsView = lazy(() => import('@/components/SettingsView'))
// 2.3 — Requests (submitted-request statuses + inline TMDB search/create).
// humanizeRequestError rides along as a module-private helper. Loads on
// first /requests nav.
const RequestsView = lazy(() => import('@/components/RequestsView'))
// 2.4 — Movies / TV Shows browse grid (hero, sort, genre filter, paginate,
// Continue Watching rail). Shares MediaRail + HeroSection with the eager
// HomeView; Media/Episode moved to @/lib/types and resume helpers to
// @/lib/format so this chunk doesn't reach back into App. Loads on first
// /movies or /shows nav. App keeps the list === null data gate and wraps
// the block in <ViewSuspense fallback={<BrowseLoadingState/>}> so the
// chunk-load + data-load fallbacks are visually identical.
const BrowseView = lazy(() => import('@/components/BrowseView'))
// 2.5 — Detail (hero, tabs, episodes, cast, files, recap, trailer). App owns
// the data + handlers; the inline `resume` IIFE + `onEpisodeUnavailable`
// closure stay in App's render block (they close over App state) and are
// threaded in as props — NOT moved into the child. The lazy <DetailView>
// keeps key={selectedMedia.id} so it remounts per title (resets active tab /
// cast-expand — the one check the build can't catch). Loads on first
// card→detail nav.
const DetailView = lazy(() => import('@/components/DetailView'))
// 2.6 — My Library (saved titles + Continue Watching). Shares isResumable,
// MediaCardCinema, Icon, and the app-side Media type with the other views.
// App owns the saved `library` state + `continueItems` and passes them as
// props; the Resume pill resolves the freshest CW record via a ref. Loads
// on first /library nav.
const LibraryView = lazy(() => import('@/components/LibraryView'))
// 2.7 — Search (debounced 300ms/keystroke results grid). Shares Icon,
// MediaCardCinema, searchMedia, and the app-side Media type. App owns the
// query string + library set and passes them as props; the debounce +
// searchMedia call live in the view. No dependency on UpdatePanel's
// ACTIVE_STATES/updateStateMeta/timeAgo (those stay in the admin chunk).
// Loads on first /search nav.
const SearchView = lazy(() => import('@/components/SearchView'))
// Social phase 1 — member profile page (/user/:username). Self-contained:
// fetches its own data by username, so App only parses the URL (see
// memberUsernameFromPath) and threads onSelect for the recent-watches
// rail. Loads on first profile nav.
const UserProfileView = lazy(() => import('@/components/UserProfileView'))
// Social phase 2 — the member directory (/members): find + follow people.
// Reached from the avatar dropdown, not the tab strip (the strip is curated
// browse surfaces; this is an occasional destination like Settings).
const MembersView = lazy(() => import('@/components/MembersView'))


/* ─────────────────────── MOCK DATA ─────────────────────── */

// Mock rail arrays (CONTINUE_WATCHING, NEW_ARRIVALS, etc.) were
// removed. Their numeric IDs collided with real Aurora media IDs and
// could stream the wrong item if a Play click hit the mock card
// during the home-load window. MOVIES/SHOWS/ANIME arrays remain only
// because Search's deleted-mock-fallback path references them.

/* ─────────────────── HOME REDESIGN HELPERS ───────────────────
 * 2026-06-05 (ui-refresh-2026 Home) — small pure helpers shared by the
 * greeting band, the hero match-ring / resume bar, and the Continue
 * Watching subtitle. Kept module-scoped (not inside a component) so
 * they're trivially testable and don't re-allocate per render. */

// Time-of-day greeting word from the client clock (matches the mockup:
// "Good {morning|afternoon|evening}").
function greetingTimeOfDay(d: Date = new Date()): 'morning' | 'afternoon' | 'evening' {
  const h = d.getHours()
  // Small hours read as "Good evening" so the greeting never pairs
  // "Good morning" with the "night" day-part (e.g. 2am → "morning…night").
  if (h < 5) return 'evening'
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

// Casual "night/evening" descriptor for the greeting subline ("Friday
// night"). Mornings/afternoons keep their literal word so the copy
// stays truthful ("Saturday morning"), evenings read as "night".
function greetingDayPart(d: Date = new Date()): string {
  const h = d.getHours()
  if (h >= 21 || h < 5) return 'night'
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

// First name for the greeting. The User record only carries `username`
// (no display/first name field) — derive a friendly capitalized handle
// from it. Strips a leading email-ish local part if a full email slips
// in, then Title-cases the first token.
function greetingFirstName(username?: string): string {
  if (!username) return 'there'
  const base = username.split('@')[0].split(/[._\s-]/)[0] || username
  return base.charAt(0).toUpperCase() + base.slice(1)
}


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


/* ─────────────────────── AUTH VIEW ─────────────────────── */
// Maps server-side auth-failure messages to a small whitelist of
// user-safe strings. Whitelist (not blacklist) so that an endpoint
// which accidentally leaks stack-trace / schema detail won't surface
// it through this UI.
function filterAuthError(msg: string): string {
  const lower = msg.toLowerCase()
  const knownPatterns: Array<{ match: string; safe: string }> = [
    { match: 'invalid credentials', safe: 'Invalid username or password.' },
    { match: 'rate limit', safe: 'Too many attempts — please wait a moment and try again.' },
    { match: 'rate-limited', safe: 'Too many attempts — please wait a moment and try again.' },
    { match: 'too many requests', safe: 'Too many attempts — please wait a moment and try again.' },
    { match: 'invite', safe: 'Invite code required or invalid.' },
    { match: 'already exists', safe: 'That username or email is already in use.' },
    { match: 'username', safe: 'Username is invalid or unavailable.' },
    { match: 'email', safe: 'Email address is invalid or unavailable.' },
    { match: 'password', safe: 'Password does not meet requirements.' },
    { match: 'unauthorized', safe: 'Authentication required.' },
    { match: 'forbidden', safe: 'You do not have permission to do that.' },
    { match: 'network', safe: 'Network error — check your connection and try again.' },
    { match: 'failed to fetch', safe: 'Network error — check your connection and try again.' },
  ]
  for (const p of knownPatterns) {
    if (lower.includes(p.match)) return p.safe
  }
  return 'Login failed. Please try again.'
}

// AuthView — login + registration. Registration requires an invite
// code in most deployments; the setup-status probe below relaxes that
// for a fresh install.
function AuthView({ onLogin }: { onLogin: (user: ApiUser) => void }) {
  const [isRegister, setIsRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Phase 5 — setup wizard. On a fresh install (no users in DB),
  // the first registrant becomes admin and no invite code is
  // needed. Probe /api/auth/setup-status to detect the state and
  // skip the invite-code field on the register form.
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    void getSetupStatus().then(s => { if (!cancelled) setSetupStatus(s) }).catch(() => { /* non-fatal */ })
    return () => { cancelled = true }
  }, [])
  // Auto-flip to register mode on a fresh install so the first
  // visitor knows what to do.
  useEffect(() => {
    if (setupStatus && !setupStatus.has_users) setIsRegister(true)
  }, [setupStatus])
  const inviteRequired = !!(setupStatus?.has_users)

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setError(null)
    if (isRegister) {
      if (!username || !password) {
        setError('Username and password are required.')
        return
      }
      if (inviteRequired && !inviteCode) {
        setError('Invite code is required.')
        return
      }
      setSubmitting(true)
      try {
        const t = await register({ username, email, password, invite_code: inviteCode })
        onLogin(t.user)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Register failed')
      } finally { setSubmitting(false) }
      return
    }
    if (!username || !password) {
      setError('Username and password are required.')
      return
    }
    setSubmitting(true)
    try {
      const user = await apiLogin(username, password)
      onLogin(user)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed'
      // Bucket unknown error strings into a generic message; see
      // filterAuthError above for the whitelist rationale.
      setError(filterAuthError(msg))
    } finally {
      setSubmitting(false)
    }
  }, [isRegister, username, email, password, inviteCode, inviteRequired, onLogin])

  return (
    // Split layout (Aurora Stage Phase 7a): brand block BESIDE the card from lg
    // up, stacked above it below. Previously the mark + wordmark + tagline sat
    // in a 420px column above the form, which on a 1440x900 screen put a
    // 14px logo and three lines of text in the middle of an otherwise empty
    // page. The starfield and aurora wash are the backdrop the mockup's sign-in
    // leans on, and a wide split is what lets them read.
    <div className="min-h-screen flex items-center justify-center aurora-bg p-4 md:p-8">
      <div className="w-full max-w-[980px] flex flex-col lg:flex-row lg:items-center gap-10 lg:gap-16">
        {/* Brand block. lg:text-left / text-center so it reads as a heading
            above the card on narrow screens and as a facing panel on wide. */}
        <div className="flex-1 min-w-0 text-center lg:text-left">
          <div className="inline-flex items-center justify-center w-[84px] h-[84px] rounded-[26px] bg-purple-600/20 border border-purple-500/30 mb-5">
            <svg width="52" height="52" viewBox="0 0 36 36" fill="none">
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
          {/* Drawn Borealis wordmark (docs/design/aurorapro-typeface). Stays
              an h1 — the sign-in screen's only heading, and the card's own
              "Welcome Back" is an h2 under it. The svg's role="img" +
              aria-label give the h1 its accessible name "Aurora Pro" (the
              old text version needed a whitespace hack for the same result).
              Inline svg follows the parent's text-center/lg:text-left. */}
          <h1 className="leading-none">
            <AuroraWordmark className="inline-block h-8 lg:h-[46px] w-auto" />
          </h1>
          <p className="text-white/60 text-sm lg:text-base mt-3 max-w-[38ch] mx-auto lg:mx-0">
            Your personal media universe — every film and series you own, on any screen.
          </p>
          {/* Invite hint, only when the server actually requires a code. It was
              previously discoverable only by switching to register mode and
              finding a fourth input; saying so up front is the difference
              between "why can't I sign up" and "I need to ask for a code". */}
          {isRegister && inviteRequired && (
            <p className="text-purple-200/80 text-xs mt-4 inline-flex items-start gap-2 max-w-[42ch] mx-auto lg:mx-0">
              <Icon name="key" size={13} className="mt-0.5 shrink-0" />
              {/* "Signing up with a password needs a code", not a flat "this
                  server is invite-only". An admin can set
                  oauth_<provider>_bypass_invite, in which case the tiles forty
                  pixels below this sentence work without one — and a
                  categorical claim would send that user away. The backend
                  exposes those flags on setup-status; reading them to say
                  precisely which route is open is a follow-up, but the wording
                  must not assert more than we check. */}
              <span>Signing up with a password needs an invite code from this server&rsquo;s admin.</span>
            </p>
          )}
        </div>

        {/* Card */}
        <form onSubmit={handleSubmit} className="glass-panel rounded-2xl p-7 sm:p-8 w-full lg:w-[428px] lg:flex-none">
          <h2 className="text-white text-xl font-semibold mb-1">
            {isRegister ? (setupStatus && !setupStatus.has_users ? 'Welcome to Aurora' : 'Create Account') : 'Welcome Back'}
          </h2>
          <p className="text-white/60 text-sm mb-6">
            {isRegister
              ? (setupStatus && !setupStatus.has_users
                ? "You're the first user on this server — your account becomes the admin."
                : 'Sign up to start streaming')
              : 'Sign in to your media server'}
          </p>

          <div className="space-y-4">
            <div>
              <label htmlFor="login-username" className="block text-white/60 text-sm mb-2">Username</label>
              <input
                id="login-username"
                type="text"
                placeholder="Enter username"
                className="w-full"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                disabled={submitting}
              />
            </div>
            {isRegister && (
              <div>
                <label htmlFor="login-email" className="block text-white/60 text-sm mb-2">Email</label>
                <input
                  id="login-email"
                  type="email"
                  placeholder="you@example.com"
                  className="w-full"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  disabled={submitting}
                />
              </div>
            )}
            <div>
              <label htmlFor="login-password" className="block text-white/60 text-sm mb-2">Password</label>
              <input
                id="login-password"
                type="password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                disabled={submitting}
              />
            </div>
            {isRegister && inviteRequired && (
              <div>
                <label htmlFor="login-invite" className="block text-white/60 text-sm mb-2">Invite Code</label>
                <input
                  id="login-invite"
                  type="text"
                  placeholder="From your server admin"
                  className="w-full"
                  value={inviteCode}
                  onChange={e => setInviteCode(e.target.value.toUpperCase())}
                  disabled={submitting}
                />
              </div>
            )}
          </div>

          {error && (
            <div role="alert" className="mt-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full mt-6 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-xl font-medium transition-all duration-200 hover:scale-[1.02] glow-purple disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100 flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <Spinner className="size-4" />
                {isRegister ? 'Creating account…' : 'Signing in…'}
              </>
            ) : isRegister ? 'Create Account' : 'Sign In'}
          </button>

          {/* OAuth sign-in row. The ?invite= query forwards an entered
              invite code through the round-trip so register-mode
              sign-ins claim it atomically server-side. Each button
              renders only when its provider is enabled in setupStatus. */}
          {/* Derived from the same list the tiles map, so the guard and the
              grid can never disagree about whether any provider is enabled.
              This was a five-term `||` that had to be edited in lockstep with
              five separate render blocks. */}
          {OAUTH_SIGN_IN_PROVIDERS.some(p => setupStatus?.[p.flag]) && (
            <>
              <div className="flex items-center gap-3 my-6">
                <div className="flex-1 h-px bg-white/[0.06]" />
                <span className="text-white/30 text-xs uppercase tracking-wider">or</span>
                <div className="flex-1 h-px bg-white/[0.06]" />
              </div>
              {/* 2-up tile grid, from a list rather than five near-identical
                  hand-written blocks. With all five providers enabled the
                  stacked version was five full-width 44px rows plus the form
                  above them — the card ran past the fold on a 900px screen.
                  Two columns halves that.

                  Odd counts: the last tile spans both columns so the grid never
                  ends with a half-width orphan. That is the common case, since
                  most servers enable one or three. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {OAUTH_SIGN_IN_PROVIDERS
                  .filter(p => setupStatus?.[p.flag])
                  .map((p, i, list) => (
                    <OAuthSignInButton
                      key={p.provider}
                      provider={p.provider}
                      label={p.label}
                      // Visible label is short so a 178px tile fits it; the
                      // accessible name keeps the verb. Without this a tile
                      // announced as "X, link" — which everywhere else on the
                      // web is a close button — and the "or" divider that
                      // supplies context does not travel to a links list.
                      ariaLabel={`Continue with ${p.label}`}
                      inviteCode={isRegister ? inviteCode : ''}
                      disabled={submitting}
                      className={list.length % 2 === 1 && i === list.length - 1 ? 'sm:col-span-2' : undefined}
                    />
                  ))}
              </div>
            </>
          )}

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => { setIsRegister(!isRegister); setError(null) }}
              className="text-purple-400 hover:text-purple-300 text-sm transition-colors"
            >
              {isRegister ? 'Already have an account? Sign In' : "Don't have an account? Register"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Phase B — OAuth sign-in button. Per-provider brand icon + colors.
// Renders as an <a> rather than a button + window.location because
// the browser handles the cross-site redirect natively (no JS state
// to preserve at this point; the round-trip's success page sets
// localStorage tokens before re-entering the SPA).
function OAuthSignInButton({ provider, label, ariaLabel, inviteCode, disabled, className }: {
  provider: OAuthProvider
  label: string
  // Full-sentence accessible name; the visible `label` stays short.
  ariaLabel?: string
  inviteCode: string
  disabled: boolean
  // Grid-placement class from the caller (the odd-count tile spans both
  // columns). Placement belongs to the grid, not to the button.
  className?: string
}) {
  // Build the start URL. inviteCode is forwarded as ?invite=CODE so
  // the server can atomically claim it pre-flight (see
  // oauth_handlers.go Start handler).
  const params = new URLSearchParams()
  if (inviteCode.trim()) params.set('invite', inviteCode.trim())
  const qs = params.toString()
  const href = `/api/auth/oauth/${provider}/start${qs ? '?' + qs : ''}`

  // Per-provider visual treatment. Discord blurple, Twitch purple,
  // Google neutral-with-color-mark. Each button keeps the same
  // dimensions so the row reads as a uniform stack.
  const config = {
    google: {
      bg: 'bg-white hover:bg-white/95 text-gray-800',
      icon: (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
          <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
          <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
        </svg>
      ),
    },
    discord: {
      bg: 'bg-[#5865F2] hover:bg-[#4752C4] text-white',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      ),
    },
    twitch: {
      bg: 'bg-[#9146FF] hover:bg-[#7c2fff] text-white',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
        </svg>
      ),
    },
    facebook: {
      bg: 'bg-[#1877F2] hover:bg-[#1665D8] text-white',
      icon: (
        // Official Facebook "f" mark.
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
        </svg>
      ),
    },
    twitter: {
      // X's brand is solid black; we add a subtle lift on hover.
      bg: 'bg-black hover:bg-zinc-800 text-white border border-white/10',
      icon: (
        // The X mark — official post-rebrand glyph.
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      ),
    },
  }[provider]

  return (
    <a
      href={disabled ? undefined : href}
      aria-label={ariaLabel}
      // aria-disabled rather than only dropping href: without it the element
      // loses its `link` role entirely while submitting, so the tiles vanish
      // from the accessibility tree instead of announcing as unavailable.
      aria-disabled={disabled || undefined}
      onClick={(e) => { if (disabled) e.preventDefault() }}
      className={`w-full flex items-center justify-center gap-2.5 py-2.5 px-3 rounded-xl font-medium text-sm transition-all duration-200 hover:scale-[1.01] disabled:opacity-50 ${config.bg} ${disabled ? 'pointer-events-none opacity-50' : ''} ${className ?? ''}`}
    >
      {config.icon}
      {label}
    </a>
  )
}

// Views that render their own edge-to-edge hero and therefore opt out of
// the .stage-page gutter, padding their inner sections with .stage-gutter.
// Anything not listed here gets the standard page pad from App's wrapper.
const FULL_BLEED_VIEWS = new Set(['home', 'movies', 'shows', 'detail'])

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
    kind?: 'continue-watching'
    // QA 2026-05-25 — when present, MediaRail renders a clickable
    // "See All" affordance that routes here. Built-in rails wire it
    // ("Top Rated Movies" → /movies + sort=rating); curated/AI rails
    // (no dedicated browse page) leave it undefined so the button
    // hides — no more misleading clicks that do nothing.
    seeAllTarget?: { view: 'movies' | 'shows'; sortBy?: 'rating' | 'recent' | 'title' | 'year' }
    // 2026-06-05 (Home redesign C/D) — optional presentation hints.
    //  • subtitle    — one-line "why it's here" under the rail title.
    //  • aiPick      — show the "✨ AI PICK" chip (recommender rails).
    //  • showBadges  — render 4K/HDR quality chips on the cards.
    //  • cardSubtitles — per-card subtitle override keyed by media id
    //    (Continue Watching uses it for "S2E4 · 23m left"); derived in
    //    the Home render where the source ContinueWatchingItem is in
    //    scope, since Media alone can't reconstruct the remaining time.
    subtitle?: string
    aiPick?: boolean
    showBadges?: boolean
    cardSubtitles?: Record<number, string>
  }[]
  // App-level navigation callback so HomeView can request a route
  // change for See All clicks. Optional so the type stays backwards
  // compatible with renderers that don't wire it (the See All button
  // simply won't appear in that case).
  onNavigate?: (view: string, opts?: { sortBy?: 'rating' | 'recent' | 'title' | 'year' }) => void
  loading?: boolean
  convoLoading?: boolean
  error?: string | null
  onRetry?: () => void
  // 2028-05-28 (deep-debug Bug C) — `continueItems` and `onPlayContinue`
  // were dead after the cinema-card swap removed the rail's hover Play CTA.
  // They previously fed a `railPlay` interceptor that resumed Continue
  // Watching cards at the saved position_ms / episode_id; with no Play CTA
  // for the interceptor to attach to, the props are unreachable. Resume
  // now happens via card-click → detail view → Play; tracked as a separate
  // follow-up.
  onCardContext?: (e: React.MouseEvent, m: Media) => void
  // Phase 5.3 — hero reason + refresh + pause hooks.
  heroReason?: string
  // True when homeHero is the rails-derived catalog fallback (not a pool pick).
  heroIsCatalogFallback?: boolean
  // 2026-06-05 (Home net-new #2) — real recommender "match %" for the
  // current hero pick. Undefined / 0 (cold-start) → HeroSection falls back
  // to its derived rating-based estimate.
  heroMatch?: number
  heroScore?: number
  heroSlateToken?: string
  heroPosition?: number
  activeProfileId?: number
  onSurprise?: () => void
  onHeroPauseChange?: (paused: boolean) => void
  // Cold-start hint info — passed through from the /api/me/hero response.
  // null = unknown (initial load); set when the response lands.
  heroPersonalization?: HeroPersonalization | null
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
  // 2026-05-27 — Continue Watching one-click resume affordance.
  // When set, the home Continue Watching rail's cards each get a
  // Resume pill on hover; click on the pill calls onPlay with the
  // matched record, bypassing detail. Card click still opens detail
  // (preserves the "click → detail → act" pattern for non-CW
  // interactions like "I want to see the description"). Discriminated
  // bundle so partial wiring is a type error. Wired ONLY on the
  // home CW rail — other rails (Top Rated, Discover, etc.) don't
  // sprout resume pills even if the user has progress on a title
  // they happen to contain.
  cwResume?: {
    items: ContinueWatchingItem[]
    onPlay: (c: ContinueWatchingItem) => void
  }
  // 2026-06-05 (Home redesign A/F) — greeting band + watch-together
  // inputs.
  //  • user        — logged-in account; first name is derived from
  //    `username` (the only name field the User record carries).
  //  • pickCount   — number of personalized/hero picks available (real),
  //    powers the "{N} worth your time" line.
  //  • libraryTotal — real movies+shows total IF reachable in App state
  //    (null when the browse tabs haven't loaded their counts yet); the
  //    "picked from X titles" clause is OMITTED when null rather than
  //    fabricated.
  //  • onOpenParty — opens the existing Watch Party hub (same handler the
  //    top bar uses); wired to the "Start a watch party" CTA.
  user?: ApiUser
  pickCount?: number
  libraryTotal?: number | null
  onOpenParty?: () => void
  // onJoinParty — join a specific active party by code (Watch-together card);
  // same path as PartyHubModal's onJoin (join by code, open the party panel).
  onJoinParty?: (code: string) => Promise<{ ok: boolean; error?: string }>
  // onSurprise — "Surprise me": immediately play a RANDOM recommended pick
  //   (excludes the one on screen). onNextPick — "Not tonight": advance to the
  //   next pick already in the loaded pool (instant, no refetch). Distinct.
  onNextPick?: () => void
  // Phase D — conversational discovery: fired on Enter in the home "vibe" box.
  onConversationalSearch?: (query: string) => void
  // Stage 3 — manual "Refresh picks": force a server rebuild of the LLM
  // Discover rails. recsRefreshing disables the control while in flight.
  onRefreshRecs?: () => void
  recsRefreshing?: boolean
}
function HomeView({ onSelect, onPlay, hero, rails, loading, convoLoading, error, onRetry, onCardContext, heroReason, heroIsCatalogFallback, heroMatch, heroScore, heroSlateToken, heroPosition, activeProfileId, onSurprise, onNextPick, onHeroPauseChange, heroPersonalization, libraryIds, onToggleLib, onNavigate, heroResume, cwResume, user, pickCount, libraryTotal, onOpenParty, onJoinParty, onConversationalSearch, onRefreshRecs, recsRefreshing }: HomeViewProps) {
  // Do NOT fall back to mock rails: their IDs collide with real
  // media IDs and silently route Play to the wrong title. Empty
  // rails during the load window are correct.
  const effectiveRails = rails ?? []
  // Phase D — local text for the conversational "describe a vibe" box.
  const [convoText, setConvoText] = useState('')
  // Deep-debug H3 — keep the latest cwResume bundle in a ref so the
  // Resume pill click handler resolves the freshest ContinueWatchingItem
  // at click-time (not render-time). Without this, a mid-hover
  // continueItems refresh would still dispatch the stale match
  // captured when the rail mapped.
  const cwResumeRef = useRef(cwResume)
  useEffect(() => { cwResumeRef.current = cwResume }, [cwResume])

  // 2026-06-05 (Home redesign A/E) — derived greeting bits + top genre.
  // Time-of-day from the client clock; first name from the username.
  // pickCount drives "{N} worth your time"; libraryTotal (real, or null)
  // gates the "picked from X titles" clause.
  const greetWord = greetingTimeOfDay()
  const dayPart = greetingDayPart()
  const weekday = new Date().toLocaleDateString(undefined, { weekday: 'long' })
  const firstName = greetingFirstName(user?.username)
  const nPicks = pickCount ?? 0
  // Top genre is now derived server-side (stats.top_genre, from the user's
  // completed watch history) and rendered inside YourWeekBand — see
  // Home net-new #4. The former client-side "most common genre across the
  // loaded rails" estimate was removed as dead once the real signal landed.

  return (
    <div className="animate-fade-in">
      {/* 2026-06-05 (Home redesign A) — Greeting band above the hero.
          Time-aware greeting + a derived subline. The "{N} worth your
          time" count is real (personalized/hero picks); the "picked from
          X titles" clause only renders when a real library total is
          reachable (libraryTotal != null) — omitted, never faked,
          otherwise. The "✨ Surprise me" button reuses the hero refresh. */}
      {/* items-center, not items-end. Bottom-aligning the button group put it
          level with the thin subline, which measures 12px below the greeting
          block's optical centre — against a tall, heavy h1 that reads as the
          buttons sagging. Centring lands them within 0.1px of the block's
          middle.
          
          flex-wrap is load-bearing, not tidiness. The button group is shrink-0
          and ~300px wide, so below ~430px it squeezes the greeting column until
          an unbreakable username overflows its box — and centring raised that
          overflow from the dim 14px subline onto the 32px extrabold headline.
          Measured on painted text ink (element rects never show it, because
          flex items don't overlap): collisions at 430/414/390/360/320px with
          nowrap, none with. That state is Home's FIRST PAINT on every visit —
          nPicks is 0 and libraryTotal null until the fetches land — so it is
          the common case, not an edge. Wrapping drops the buttons to their own
          line instead. */}
      <div className="stage-gutter flex flex-wrap items-center justify-between gap-5 pt-10 mb-1">
        <div className="min-w-0">
          <h1 className="font-display text-3xl md:type-page font-extrabold tracking-tight leading-tight">
            Good {greetWord},{' '}
            <span className="bg-gradient-to-r from-purple-300 to-purple-500 bg-clip-text text-transparent">{firstName}</span>
          </h1>
          <div className="text-white/60 text-sm mt-1.5 flex items-center gap-2 flex-wrap">
            <span>{weekday} {dayPart}</span>
            {nPicks > 0 && (
              <>
                <span className="w-[3px] h-[3px] rounded-full bg-white/40" />
                <span>
                  <b className="text-white font-semibold">{nPicks}</b> titles worth your time
                  {libraryTotal != null && libraryTotal > 0 && (
                    <> out of the <b className="text-white font-semibold">{libraryTotal.toLocaleString()}</b> titles in your library</>
                  )}
                </span>
              </>
            )}
            {/* TODO(redesign-net-new): wire a real library-count if a lightweight endpoint exists. */}
            {nPicks === 0 && libraryTotal != null && libraryTotal > 0 && (
              <>
                <span className="w-[3px] h-[3px] rounded-full bg-white/40" />
                <span>picked from <b className="text-white font-semibold">{libraryTotal.toLocaleString()}</b> titles in your library</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onRefreshRecs && (
            <button
              onClick={onRefreshRecs}
              disabled={recsRefreshing}
              title="Refresh picks — rebuild your AI-curated Discover rails"
              aria-label="Refresh picks — rebuild your AI-curated Discover rails"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/15 text-white/70 hover:text-white text-sm font-semibold whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Icon name="refresh" size={15} className={recsRefreshing ? 'animate-spin' : undefined} />
              {recsRefreshing ? 'Refreshing…' : 'Refresh picks'}
            </button>
          )}
          {onSurprise && (
            <button
              onClick={onSurprise}
              title="Surprise me — play a random recommended title"
              aria-label="Surprise me — play a random recommended title"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-purple-500/12 hover:bg-purple-500/20 border border-purple-500/30 text-purple-200 hover:text-white text-sm font-semibold whitespace-nowrap transition-colors"
            >
              <Icon name="sparkle" size={15} /> Surprise me
            </button>
          )}
        </div>
      </div>
      <HeroSection
        hero={hero}
        onPlay={onPlay}
        onInfo={onSelect}
        reason={heroReason}
        isCatalogFallback={heroIsCatalogFallback}
        match={heroMatch}
        score={heroScore}
        slateToken={heroSlateToken}
        slatePosition={heroPosition}
        profileId={activeProfileId}
        onNextPick={onNextPick}
        onPauseChange={onHeroPauseChange}
        personalization={heroPersonalization ?? null}
        resume={heroResume}
        libraryIds={libraryIds}
        onToggleLib={onToggleLib}
      />
      {/* Phase D — conversational discovery: a deliberate "now describe your own
          vibe" moment between the one curated pick and the browsable rails.
          Fires the semantic search on Enter (not per-keystroke) to bound LLM cost.

          Phase 4 pulled it UP into the hero's foot (the mockup's -26px, shipped as
          `-mt-5`) so it read as one composition with the hero rather than a separate
          widget floating above the rails. Phase 10b UNDID that — see the spacing
          note below.

          `relative z-20` is KEPT, and not for the reason this comment gave for three
          phases. The old claim was that it lifts the bar above the hero's scrim.
          That is false and always was: `.stage-hero-scrim` is `position:absolute;
          inset:0` INSIDE the hero <section>, which is `overflow-hidden`, so it is
          clipped to the hero and cannot paint under the bar at all — and it carries
          no z-index, so tree order alone already put the bar in front. Phase 10b
          then made the false reason actively dangerous by adding "the bar no longer
          overlaps the hero" beside it: a reader who checks the stated premise finds
          it irrelevant and deletes the class.

          What `z-20` actually does is make this wrapper a STACKING CONTEXT, which is
          the only thing containing `.convo-search::before` — the breathing halo,
          which is `z-index: -1`. `.convo-search` itself is `position: relative` with
          `z-index: auto` and no transform/filter/opacity/isolation, so it is not a
          stacking context and cannot contain it. Remove `z-20` and the halo
          re-parents to the nearest ancestor that is one, and negative-z descendants
          paint BEFORE in-flow block backgrounds: the halo goes behind the app
          shell's opaque `bg-[#050505]` and disappears. Worse under
          `prefers-reduced-motion`, where `.animate-fade-in { animation: none
          !important }` stops the HomeView root being a stacking context at all, so
          the halo lands behind the root div's `.aurora-bg` — invisible, for exactly
          the users least likely to report a missing animation.

          How far the halo actually reaches, since a draft of this comment asserted
          16px and that number is wrong by ~35: `.convo-search::before` is
          `inset: -3px` with `filter: blur(16px)`, and CSS blur takes the Gaussian
          STANDARD DEVIATION, whose visible extent is ~3σ. So ~3 + 48 = ~51px in
          every direction, not 16px upward. Which means the bar's decoration still
          reaches hero-bottom − 43, i.e. ~7px past the CTA row's content bottom, and
          "at `mt-2` none of it sits on the artwork" is true of the border box and
          false of the halo. Not a regression — under `-mt-5` the halo reached
          hero-bottom − 71, a full 35px past the buttons, so this strictly reduces
          the intrusion — but 51 is the number a future edit has to reason from.

          FULL WIDTH, gutter to gutter — third and final answer on this bar, and the
          first two were wrong for the same reason: I kept measuring it against the
          hero's TEXT COLUMN and never against the thing it actually sits next to.

          Look at what is directly beneath it: the Continue Watching rail panel, and
          every rail after it, run the full gutter width, and the bar's bottom edge
          sits exactly 32px above that panel's top edge (mb-8; 51px to the panel's
          header CONTENT, which is what an earlier version of this comment reported
          as "~50px above the panel" — the right number for the wrong edge).
          Measured: the bar and the first rail panel now share both edges at every
          width from 414 to 1920 — 48..1392 at 1440 — and so does every other
          page-level child below them. On the previous revision the bar at 48..720
          was the only misaligned element on the page. A bar ending mid-viewport
          against a panel ending at the gutter reads as a stair-step, and agreeing
          with a hero column 400px higher up does not fix that: the nearest
          neighbour wins.

          It also settles what this element IS. Capped, it read as the last item in
          the hero's text stack; full width it reads as the first PAGE-level band,
          which is what it behaves like — it replaces the rails below with results.

          The three objections I raised to full width earlier, re-examined against
          the rendered page instead of in the abstract:
            - "it would slice the artwork's focal point" — MOOT as of Phase 10b, and
              now by geometry rather than by argument: at `mt-2` the bar's box does
              not touch the hero at all, so there is no artwork under it to slice.
              (This paragraph was written in the present tense against the `-mt-5`
              revision — "the composited scrim alpha is 0.973 at the bar's top edge
              against 0.761 mid-hero … only the bar's top 20px of 48 overlap the
              hero" — and Phase 10b falsified every verb in it while leaving it
              standing, in the same commit whose other half deletes an eighteen-line
              block for exactly that. Recorded rather than quietly rewritten: this is
              the third time this comment has kept a paragraph the code had moved out
              from under. The 0.761 figure was also never reproducible from the
              gradient stops under any reading of "mid-hero" — it was presented as a
              pixel sample, so it was never statically checkable either.)
            - "it strands the ↵ Search chip from the caret" — a pinned submit
              affordance on a full-width search field is what every search bar does,
              and this field takes short phrases, so the caret never travels.
            - "a 62-character placeholder looks lost" — that was an argument about
              the placeholder, and the placeholder was shortened.

          For the record, since the arithmetic is still worth knowing and was
          independently re-verified in a live build: when a max-width sat on THIS
          element, `.stage-gutter`'s 48px padding came out of it under border-box, so
          `max-w-3xl` (768) resolved to content 48..720 — exactly the hero text
          column — while `max-w-2xl` (672) gave 48..624, the hero DESCRIPTION's edge.
          That asymmetry was the Phase 8 correction. It no longer applies to this
          element, which now has `max-width: none`; the paragraphs above used to
          state it in the present tense alongside the past-tense version, so the same
          fact was asserted twice, once about code that no longer exists. (That
          correction described a deletion it did not actually perform: the
          present-tense copy — an eighteen-line block opening "This wrapper carries
          BOTH `.stage-gutter` … AND the max-width" — was still sitting right here,
          asserting a max-width this element has not had since the previous commit.
          Deleted now.)

          The genuine misalignment on this row was the LOADING SHIMMER below,
          which was `max-w-3xl` inside a `.stage-gutter` PARENT — so no padding
          of its own, 48..816, a real 96px overhang past the bar it stands in
          for. That is fixed there, not here.

          An earlier version of this comment said "Centered under the hero".
          There is no `mx-auto` here and never was — it is gutter-aligned.

          ── Phase 10b: the vertical gap, which is what full width broke ──

          Going full width made the bar look wrong against the hero's CTA row, and
          the instinct was that the BUTTONS were now misaligned. They are not. The
          hero's bottom row is `absolute bottom-0 left-0 right-0 …
          px-[var(--page-gutter)] max-md:px-[18px]` (HeroSection.tsx:322) and this
          wrapper is `.stage-gutter`. At md+ both resolve to `--page-gutter`, 48px,
          and Play's left edge and this bar's left edge are both at 48 while "Not
          tonight"'s right edge and this bar's right edge are both at viewport−48.
          The button row and the bar span EXACTLY the same measure. Nothing overhangs
          anything.

          It IS one source now, as of Phase 11.4 — the hero footer row carries
          `.stage-gutter` itself rather than restating its padding.

          The paragraph this replaces is worth keeping in outline, because it is
          why the change was made. The row used to read
          `px-[var(--page-gutter)] max-md:px-[18px]`, and it agreed with the rails
          below 768px only because TWO separate 18px literals happened to match:
          the hero's `max-md:` utility and `.stage-gutter`'s own
          `@media not all and (min-width: 768px)` block. Editing either would have
          broken the alignment silently. (`--page-gutter` is 48px at every width and
          has no override anywhere, so the token was never doing that work.)

          Recorded because this comment has now had a paragraph invalidated by its
          own commit FOUR times, and this is the fourth: the version above was left
          standing by the commit that made it false, still arguing at length that
          the agreement is "NOT because of a shared token" while that same commit's
          message says "Now structural".

          What was wrong is density plus proximity. The row above is two small
          clusters with the width of the page between them; the bar below is a
          continuously filled surface across that same span, so the bar is what
          makes the void above it legible — the gap was always there, nothing solid
          had ever sat under it. And at `-mt-5` the two were close enough to read as
          ONE row, at which point the eye tries to reconcile a four-pill row in which
          one pill is the width of the viewport.

          The arithmetic, which is plain block layout — no border-box trap this time,
          the parent is a bare `<div className="animate-fade-in">` with no
          `space-y-*`, and the hero <section> carries no bottom margin to collapse
          with:

            button bottoms       = hero bottom − 36px   (the row's `pb-9`)
            bar top              = hero bottom + M      (M = this margin-top)
            gap                  = M + 36

          — which holds only when `hero` is TRUTHY. HeroSection returns early on
          `!heroProp` and that branch renders a vertically-centred "Welcome to
          Aurora" placeholder with no bottom row at all: no `pb-9`, and no scrim
          either. This bar renders unconditionally on `onConversationalSearch`,
          independent of `hero`, so on a cold Home load and permanently whenever
          `homeHero` stays null (empty library, failed hero fetch) the real figures
          are 8px above and 32px below. That is still an improvement on `-mt-5`,
          which had the bar OVERLAPPING the placeholder — and the placeholder's
          content is centred, so there is nothing at its bottom edge to crowd — but
          the formula above is not unconditional and was written as if it were.

          The px figures are also rem-derived: `pb-9`, `mt-2` and `mb-8` are all
          rem, `--page-gutter` is a px literal. At a 24px root the gap is 66 and the
          margin below is 48 while the gutter stays 48. The design argument rests on
          the RATIO, which survives because all three verticals scale together; the
          absolute numbers do not, and this file has been burned by exactly that
          before — see the token comment in index.css about the greeting getting
          SMALLER on gaining room.

          So `-mt-5` gave 16px and `mt-2` gives 44px, against `mb-8`'s 32px below.

          That inequality is the point, but state it precisely, because the obvious
          phrasing ("the bar is now nearer the rails than the hero") does not
          survive: 44px above is measured to rendered CONTENT — the buttons — while
          32px below is measured to a BOX EDGE. Like for like, content to content, it
          is 44px above against 51px below (the rail panel's 1px border plus its 18px
          padding-top), which reverses the claim. This same comment scolds an earlier
          draft for exactly that substitution twelve lines up, and then made it.

          The defensible version is nearest VISIBLE boundary, and it needs the
          hero's bottom edge to be invisible — see the next paragraph, where it is
          nearly but not entirely true. On that reading it is 44px to the buttons
          against 32px to the rail panel's visible top border, and the bar groups
          with the rails: the correct grouping, since it is the control that REPLACES
          the rails with results, and full width already made it read as a page-level
          band rather than the last line of the hero's text stack.

          The cost is the overlap. At `-mt-5` the bar's top 20px of ~49 sat on the
          artwork; at `mt-2` none of its BORDER BOX does. (~49, not the ~48 an
          earlier draft said: the unlayered global `input:not([type="range"])` rule
          at (0,1,1) beats the call site's `border-0` at (0,1,0) and restores a 1px
          border. The CASCADE HAZARD again, in the one element this file has spent
          four phases on. It does not change any conclusion here.)

          That is deliberate rather than collateral — the overlap was the mechanism
          that welded it to the hero. But the reason first given for it being SAFE
          was wrong, and it is the one thing in this block that was: "Phase 4 made
          the hero's bottom scrim land on #050505, so there is no visible edge."
          True of the INSIDE of the hero, and it is not what the bar pulled away
          from. The app root is `bg-[#050505] aurora-bg`, and `.aurora-bg` composites
          three purple radials at α 0.05–0.08 OVER that base; the hero paints its own
          opaque #050505 on top of them. So the hero's bottom edge is a step from
          flat #050505 to #050505-plus-tint — computed at roughly 6–10 sRGB levels,
          full viewport width, with no ramp across it because the hero's fill is
          opaque.

          That step is pre-existing. What the negative margin was doing, beyond
          aesthetics, is straddling it: the bar's own fill attenuated it from x=48 to
          x=V−48, leaving it bare only in the two gutters. At `mt-2` it is bare edge
          to edge. Small — an OLED-in-a-dark-room band, not a contrast defect, and
          computed rather than sampled — but it is a real consequence of this change
          and the original justification asserted the opposite. Left as is rather
          than chased here: the honest fix is in the hero/page background system, not
          in a margin, and this element has been broken three times already by
          fixing it from the wrong reference. Recorded as a follow-up.

          Rejected, and why, so this is not relitigated a fourth time:
            - Moving "Not tonight" into the Play / My List / More Info cluster. It
              would close the void, but that control is deliberately quiet —
              `bg-white/[0.04]`, a 1.19:1 border, documented in HeroSection as
              tertiary — and seating it beside the primary CTA promotes it to Play's
              peer, which is the opposite of what it is for.
            - Re-capping the bar to the hero's text column. That is where this
              started, twice, and it stair-steps against the Continue Watching panel
              32px below. See above. */}
      {onConversationalSearch && (
        <div className="stage-gutter relative z-20 mt-2 mb-8">
          <div className="convo-search flex items-center">
            <Icon name="sparkle" size={17} className="ml-4 mr-2 shrink-0 text-purple-300 pointer-events-none" />
            <input
              value={convoText}
              onChange={e => setConvoText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onConversationalSearch(convoText) } }}
              // "Describe a vibe", not "Describe what you're in the mood for…":
              // two search affordances are visible at once on Home — TopNav's
              // "Search titles…" (lexical, by name) and this one (semantic, by
              // description) — and nothing told a user which was which. Leading
              // with the verb that distinguishes them does. Also shorter — 52
              // characters against the original 75 — because the example is the
              // part that teaches what this field accepts, so it is the part that
              // has to survive truncation.
              // (An earlier version justified the length with "the field is 672px
              // rather than 768px". That stopped being true when the bar went full
              // width, and both figures were wrong anyway — the strings are 52 and
              // 75, not 50 and 62. The reason to keep it short is the 390px case,
              // where it truncates regardless; on desktop there is now room to
              // spare.)
              // /70, not /40. A reviewer measured the placeholder at 3.18–3.53:1
              // against the bar's own fill — under the 4.5:1 floor, and it is the
              // only thing in the field until you type. Pre-existing rather than
              // introduced here, but this is the element three phases have now been
              // spent on, and `audit:contrast` cannot see it: that script only walks
              // HeroSection's surfaces, so nothing in the gate was ever going to
              // catch it.
              placeholder={'Describe a vibe — "a cozy mystery, nothing too dark"'}
              aria-label="Describe a vibe to search by"
              // `bg-transparent border-0 py-3 pl-1 pr-2 text-sm text-white` used to
              // be here and NONE of it applied: they are (0,1,0) utilities and the
              // unlayered global `input:not([type="range"])` is (0,1,1), declared
              // later. The bar was drawing a 10px-radius box with its own fill and
              // border inside its gradient border, text 13px right of intent.
              // Those values now live on `.convo-search input` in index.css at
              // (0,2,1), which actually wins. Do not re-add them here — two sources
              // of truth for this box is why it went unnoticed for four phases.
              className="flex-1 min-w-0 placeholder:text-white/70 outline-none"
            />
            {convoText && (
              <button
                onClick={() => { setConvoText(''); onConversationalSearch('') }}
                aria-label="Clear search"
                className="shrink-0 px-2.5 py-1 rounded-full text-xs font-semibold text-white/55 hover:text-white hover:bg-white/10 transition-colors"
              >Clear</button>
            )}
            {/* Solid Search chip pinned to the right edge — a filled element
                reads as anchored-right even through the bar's glow halo, where
                faint floating text did not. Clickable (Enter still works too). */}
            <button
              onClick={() => onConversationalSearch(convoText)}
              aria-label="Search"
              className="shrink-0 ml-1 mr-2 flex items-center gap-1.5 rounded-lg bg-purple-500/15 hover:bg-purple-500/30 border border-purple-400/25 hover:border-purple-400/45 px-2.5 py-1.5 text-[11px] font-semibold text-purple-100/90 hover:text-white transition-colors"
            >
              <kbd className="grid place-items-center h-4 min-w-[1rem] rounded border border-white/15 bg-white/10 text-[10px] leading-none">↵</kbd>
              <span className="hidden sm:inline">Search</span>
            </button>
          </div>
        </div>
      )}
      {/* Everything below the hero + conversational search opts back into
          the page gutter. HomeView is full-bleed (FULL_BLEED_VIEWS) so the
          hero can reach the viewport edge; the rest lines up with the
          hero's text column because both read --page-gutter.

          The wrapper opens HERE, above every status banner — convoLoading
          included. It was left outside on the first pass, and `max-w-2xl
          mx-auto` hid that above 672px while going flush to both edges
          below it. */}
      <div className="stage-gutter">
      {convoLoading && (
        // No cap, matching the bar it stands in for. Any cap here is a layout jump
        // on every query, which is exactly what this row had when the two disagreed.
        <div className="relative h-16 flex items-center justify-center overflow-hidden mb-8">
          <div className="aurora-pulse-blob w-24 h-24 bg-purple-500/40 -left-10 -top-2" style={{ animationDelay: '0s' }} />
          <div className="aurora-pulse-blob w-32 h-32 bg-fuchsia-500/30 left-1/3 top-0" style={{ animationDelay: '-2s' }} />
          <div className="aurora-pulse-blob w-28 h-28 bg-indigo-500/40 right-10 bottom-0" style={{ animationDelay: '-4s' }} />
          <div className="relative z-10 flex items-center gap-2 text-purple-200 text-sm font-medium animate-pulse">
            <Icon name="sparkle" size={14} />
            Sensing the vibe...
          </div>
        </div>
      )}
      {error && (
        <div className="mb-6 px-5 py-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">Couldn't load your library</p>
            <p className="text-red-300/70 text-xs mt-1">{error}</p>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-4 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-white/90 text-sm transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {loading && !rails && (
        <div className="mb-6 px-5 py-3 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-200 text-sm">
          Loading your library…
        </div>
      )}
      {effectiveRails.map((rail, i) => {
        if (rail.items.length === 0) return null
        const seeAllHandler = rail.seeAllTarget && onNavigate
          ? () => onNavigate(rail.seeAllTarget!.view, { sortBy: rail.seeAllTarget!.sortBy })
          : undefined
        // 2026-05-27 — Resume pill wiring. ONLY the Continue Watching
        // rail (rail.kind === 'continue-watching') gets the per-card
        // resume resolver. Other rails leave it undefined so
        // partial-watch matches on Top Rated / Discover / etc. don't
        // sprout pills (per design — those rails are discovery-focused,
        // not action-focused).
        //
        // Deep-debug H3 — the click handler resolves the match from
        // `cwResumeRef.current` at click-time (NOT render-time) so a
        // mid-hover continueItems refresh (e.g. another device just
        // watched 2 minutes and the server's position_ms jumped)
        // doesn't dispatch a stale ContinueWatchingItem. isResumable
        // also runs at click-time so a record that fell below the
        // threshold between render and click correctly no-ops.
        const resolveResume = rail.kind === 'continue-watching' && cwResume
          ? (m: Media) => {
              // Render-time check: if there's no resumable record
              // RIGHT NOW, don't show a pill (saves rendering it
              // only to have the click no-op).
              if (!cwResume.items.some(c => c.media_item_id === m.id && isResumable(c))) {
                return undefined
              }
              return () => {
                // Click-time re-lookup against the latest data.
                const latest = cwResumeRef.current
                if (!latest) return
                const match = latest.items.find(
                  c => c.media_item_id === m.id && isResumable(c),
                )
                if (match) latest.onPlay(match)
              }
            }
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
            onSelect={onSelect}
            aspect={rail.aspect}
            onCardContext={onCardContext}
            libraryIds={libraryIds}
            onToggleLib={onToggleLib}
            onSeeAll={seeAllHandler}
            resolveResume={resolveResume}
            subtitle={rail.subtitle}
            aiPick={rail.aiPick}
            showBadges={rail.showBadges}
            cardSubtitleFor={cardSubtitleFor}
          />
        )
      })}
      {/* 2026-06-05 (Home redesign E/F) — "Your week" stat band +
          "Watch together" card, rendered below the last rail. Both are
          self-contained components; they only show once the page has
          rails (so they don't flash above an empty/loading home). */}
      {effectiveRails.length > 0 && (
        <>
          <YourWeekBand />
          <WatchTogetherCard onStartParty={onOpenParty} onJoinParty={onJoinParty} currentUserId={user?.id} />
        </>
      )}
      <div className="h-16" />
      </div>{/* /stage-gutter */}
    </div>
  )
}

/* ─────────────────── YOUR WEEK STAT BAND (Home redesign E) ───────────────────
 * 2026-06-05 — A slim glass band below the last rail. Real data from
 * getGamificationStats: Level, per-level XP bar (SAME math as
 * GamificationCard so the two never disagree), day-streak (current +
 * "best {longest}"), and the top genre (stats.top_genre, derived
 * server-side from the user's completed watch history). The weekly
 * watch-hours / titles-finished-this-week stats have no backend yet — they
 * render as honest "—" placeholders and are marked for wiring. Self-fetches
 * like GamificationCard so HomeView doesn't have to own the request. */
function YourWeekBand() {
  const [stats, setStats] = useState<GamificationStats | null>(null)
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    getGamificationStats(ac.signal)
      .then((s) => { if (!cancelled) setStats(s) })
      .catch(() => { /* non-fatal — band just stays in its loading shell */ })
    return () => { cancelled = true; ac.abort() }
  }, [])

  // Per-level progress — identical formula to GamificationCard (Audit H1):
  // progress through THIS level's slice, not absolute XP%.
  const xp = stats?.xp
  // Weekly "finished" stats (real, from watch_progress.completed_at). null
  // when loading or on an older server → "—" placeholder. Hours: 1 decimal
  // under 10h, integer above, for a glanceable number.
  const wkMin = stats?.minutes_this_week
  const wkHrs = wkMin == null ? null : wkMin === 0 ? '0' : wkMin >= 600 ? String(Math.round(wkMin / 60)) : (wkMin / 60).toFixed(1)
  const wkTitles = stats?.titles_this_week
  const prevTotal = xp?.prev_level_total ?? 0
  const nextTotal = xp?.next_level_total ?? 0
  const slice = Math.max(1, nextTotal - prevTotal)
  const pct = xp ? Math.min(100, Math.max(0, ((xp.xp - prevTotal) / slice) * 100)) : 0

  return (
    <>
      <div className="flex items-center gap-3 mt-9 mb-3.5">
        <Icon name="barChart" size={17} className="text-purple-300" />
        <h3 className="text-[16.5px] font-semibold">Your week</h3>
        <span className="flex-1 h-px bg-gradient-to-r from-white/10 to-transparent" />
      </div>
      <div className="relative overflow-hidden rounded-[18px] border border-white/[0.07] bg-gradient-to-br from-purple-500/[0.08] to-white/[0.02] flex flex-col lg:flex-row items-stretch">
        <div className="absolute -top-16 -right-10 w-[280px] h-[280px] rounded-full bg-purple-500/[0.14] blur-[60px] pointer-events-none" aria-hidden="true" />
        {/* Lead: level + XP bar (real) */}
        <div className="relative px-6 py-5 flex flex-col justify-center gap-1.5 lg:min-w-[210px] border-b lg:border-b-0 lg:border-r border-white/[0.08]">
          <span className="inline-flex items-center gap-2 text-[10px] tracking-[0.14em] uppercase text-purple-300 font-semibold">
            <Icon name="zap" size={13} /> Level {xp ? xp.level : '—'}
          </span>
          <span className="font-display text-[26px] font-bold leading-tight">{xp ? `${xp.xp.toLocaleString()} XP` : '— XP'}</span>
          <span className="h-1.5 rounded-md bg-white/[0.08] overflow-hidden mt-1">
            <span className="block h-full bg-gradient-to-r from-purple-500 to-fuchsia-500 transition-all duration-700" style={{ width: `${pct}%` }} />
          </span>
          <span className="text-[11px] text-white/40 mt-1">
            {xp && xp.next_level_total ? `${(xp.xp_to_next_level || 0).toLocaleString()} XP to Level ${xp.level + 1}` : 'Keep watching to level up'}
          </span>
        </div>
        {/* Stats grid */}
        <div className="relative flex-1 grid grid-cols-2 lg:grid-cols-4">
          {/* Hrs + titles finished this week — real, from watch_progress.completed_at. */}
          <div className="px-5 py-5 flex flex-col gap-1.5">
            <span className="font-display text-[28px] font-bold leading-none flex items-baseline gap-1">{wkHrs ?? '—'}<small className="text-sm text-white/60 font-medium font-sans">hrs</small></span>
            <span className="text-[11.5px] text-white/60 flex items-center gap-1.5"><Icon name="clock" size={13} className="text-purple-300" /> Watched this week</span>
          </div>
          <div className="px-5 py-5 flex flex-col gap-1.5 border-l border-white/[0.08]">
            <span className="font-display text-[28px] font-bold leading-none">{wkTitles != null ? wkTitles : '—'}</span>
            <span className="text-[11.5px] text-white/60 flex items-center gap-1.5"><Icon name="check" size={13} className="text-purple-300" /> Titles finished</span>
          </div>
          {/* Day streak — REAL from xp.current_streak / longest_streak */}
          <div className="px-5 py-5 flex flex-col gap-1.5 border-l border-white/[0.08]">
            <span className="font-display text-[28px] font-bold leading-none flex items-baseline gap-1">{xp ? xp.current_streak : '—'}<small className="text-sm text-white/60 font-medium font-sans">days</small></span>
            <span className="text-[11.5px] text-white/60 flex items-center gap-1.5"><Icon name="zap" size={13} className="text-orange-400" /> Day streak{xp ? ` · best ${xp.longest_streak}` : ''}</span>
          </div>
          <div className="px-5 py-5 flex flex-col gap-1.5 border-l border-white/[0.08]">
            <span className="font-display text-[21px] font-bold leading-none">{stats?.top_genre || '—'}</span>
            <span className="text-[11.5px] text-white/60 flex items-center gap-1.5"><Icon name="heart" size={13} className="text-purple-300" /> Your top genre</span>
          </div>
        </div>
      </div>
    </>
  )
}

/* ─────────────── WATCH TOGETHER CARD (Home redesign F) ───────────────
 * 2026-06-05 — A glass card at the bottom of Home. The "Start a watch
 * party" CTA is REAL — it opens the existing Watch Party hub via the
 * onStartParty handler threaded from App (same one the top bar uses).
 * Live friend-presence ("who's watching what") has no backend feed yet,
 * so we render a tasteful empty/placeholder state instead of fabricating
 * a fake friend — the real CTA stays prominent. */
// 2026-06-06 (Home net-new #7) — "Watch together" now shows LIVE active
// watch parties anyone on the server can join, replacing the stubbed
// "friend presence coming soon" copy. Aurora is a single household, so
// active parties (not a friend graph) are the honest "who's watching
// together right now" signal. Polls /api/parties/active; non-fatal.
function WatchTogetherCard({ onStartParty, onJoinParty, currentUserId }: {
  onStartParty?: () => void
  onJoinParty?: (code: string) => Promise<{ ok: boolean; error?: string }>
  currentUserId?: number
}) {
  const [parties, setParties] = useState<ActiveParty[]>([])
  const [joining, setJoining] = useState<string | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    const load = () => {
      listActiveParties(ac.signal)
        .then((list) => { if (!cancelled) setParties(list) })
        .catch(() => { /* non-fatal — fall back to the start CTA */ })
    }
    load()
    const id = window.setInterval(load, 15000)
    return () => { cancelled = true; ac.abort(); window.clearInterval(id) }
  }, [])
  // Don't offer to "join" a party you're already hosting.
  const joinable = parties.filter((p) => p.host_user_id !== currentUserId)
  // Scheduled-not-started parties are in /api/parties/active by design
  // (that's how the Calendar finds them) but they are NOT "live now" —
  // label them by their start time and keep them out of the live badge.
  const isScheduledLobby = (p: ActiveParty) => !!p.scheduled_start_at && !p.started_at
  const liveCount = joinable.filter(p => !isScheduledLobby(p)).length

  const handleJoin = async (code: string) => {
    if (!onJoinParty || joining !== null) return
    setJoining(code)
    setJoinError(null)
    try {
      const r = await onJoinParty(code)
      if (!r.ok) setJoinError(r.error || 'Could not join that party.')
    } catch {
      setJoinError('Could not join that party.')
    } finally {
      setJoining(null)
    }
  }

  return (
    <>
      <div className="flex items-center gap-3 mt-9 mb-3.5">
        <Icon name="users" size={17} className="text-purple-300" />
        <h3 className="text-[16.5px] font-semibold">Watch together</h3>
        {liveCount > 0 && (
          <span className="text-[11px] font-semibold text-indigo-300 bg-indigo-500/15 border border-indigo-400/25 rounded-full px-2 py-0.5">
            {liveCount} live now
          </span>
        )}
        <span className="flex-1 h-px bg-gradient-to-r from-white/10 to-transparent" />
      </div>
      <div className="relative overflow-hidden rounded-[18px] border border-white/[0.07] bg-gradient-to-br from-indigo-500/10 to-white/[0.02] px-6 py-5">
        <div className="absolute -bottom-16 left-1/3 w-[300px] h-[240px] rounded-full bg-indigo-500/[0.16] blur-[64px] pointer-events-none" aria-hidden="true" />

        {joinable.length > 0 ? (
          <div className="relative flex flex-col gap-2.5">
            {joinable.slice(0, 3).map((p) => (
              <div key={p.code} className="flex items-center gap-3.5 flex-wrap">
                <div className="relative flex items-center justify-center w-[46px] h-[46px] rounded-xl bg-indigo-500/15 border border-indigo-400/30 flex-none overflow-hidden">
                  <Icon name="users" size={20} className="text-indigo-300" />
                  {p.media_poster ? (
                    <img
                      src={posterURL(p.media_poster, 'w154')}
                      alt=""
                      loading="lazy"
                      className="absolute inset-0 w-full h-full object-cover"
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                  ) : null}
                </div>
                <div className="flex-1 min-w-[180px]">
                  <div className="text-[15px] font-semibold truncate">{p.party_name?.trim() || 'Watch party'}</div>
                  <div className="text-[12.5px] text-white/55 truncate">
                    {isScheduledLobby(p)
                      ? <>Starts <span className="text-white/75">{formatPartyTime(p.scheduled_start_at!, new Date())}</span>{p.media_title ? <> — <span className="text-white/75">{p.media_title}</span></> : null}</>
                      : <>
                          {p.media_title
                            ? <>{p.is_playing ? 'Watching' : 'Paused on'} <span className="text-white/75">{p.media_title}</span></>
                            : 'In the lobby'}
                          {' · '}{p.participant_count}{p.max_participants > 0 ? `/${p.max_participants}` : ''} watching
                        </>}
                  </div>
                </div>
                <button
                  onClick={() => handleJoin(p.code)}
                  disabled={!onJoinParty || joining !== null}
                  className="px-4 py-2 rounded-xl bg-indigo-500/25 hover:bg-indigo-500/35 disabled:opacity-50 disabled:cursor-default text-indigo-50 border border-indigo-400/40 font-semibold text-[13.5px] transition-colors flex-none"
                >
                  {joining === p.code ? 'Joining…' : isScheduledLobby(p) ? 'Open lobby' : 'Join'}
                </button>
              </div>
            ))}
            {joinError && <div className="text-[12px] text-rose-300/90 mt-0.5">{joinError}</div>}
            {onStartParty && (
              <button onClick={onStartParty} className="self-start text-[12.5px] text-indigo-200/80 hover:text-white mt-1 transition-colors">
                or start your own watch party →
              </button>
            )}
          </div>
        ) : (
          <div className="relative flex items-center gap-5 flex-wrap">
            <div className="relative flex items-center justify-center w-[60px] h-[60px] rounded-2xl bg-indigo-500/15 border border-indigo-400/30 flex-none">
              <Icon name="users" size={26} className="text-indigo-300" />
            </div>
            <div className="relative flex-1 min-w-[200px]">
              <div className="text-[10px] tracking-[0.14em] uppercase text-indigo-300 font-semibold flex items-center gap-2">
                <Icon name="users" size={13} /> Watch parties
              </div>
              <div className="text-[17px] font-semibold mt-1">Start a synced session with friends</div>
              <div className="text-[12.5px] text-white/50 mt-0.5">No one's hosting right now — start one and everyone stays in sync, same scene, same time.</div>
            </div>
            <div className="relative flex items-center gap-3.5 flex-none flex-wrap">
              {onStartParty && (
                <button
                  onClick={onStartParty}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-100 border border-indigo-400/40 font-semibold transition-colors"
                >
                  <Icon name="users" size={16} /> Start a watch party
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
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
  if (!open) return null
  const fmtBytes = (n: number): string => {
    if (n <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
    return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
  }
  type StatTile = { label: string; value: string; icon: string; tone: string; hint?: string }
  const tiles: StatTile[] = stats && isAdmin
    ? [
      { label: 'Active Streams', value: String(stats.active_streams), icon: 'monitor', tone: 'ok' },
      { label: 'Disk Free', value: `${stats.disk_free_gb.toFixed(1)} GB`, icon: 'hardDrive', tone: stats.disk_free_gb < 10 ? 'warn' : 'ok' },
      // QA 2026-05-25 — Memory shows the Go process's RSS, which on
      // a 65 TB media server reads suspiciously small (~10 MB) until
      // you know FFmpeg + PostgreSQL aren't counted. The hint surfaces
      // that context on hover instead of requiring the user to dig
      // into the metric definition.
      { label: 'Memory', value: `${stats.memory_alloc_mb} MB`, icon: 'zap', tone: 'ok',
        hint: "Aurora's Go process RSS after the last GC. FFmpeg transcoders run as separate subprocesses and aren't counted here. PostgreSQL runs in its own container with its own memory budget." },
      { label: 'Library Size', value: fmtBytes(stats.total_file_size_bytes), icon: 'film', tone: 'ok' },
      // QA BUG-002 — label as "Files" not "Titles" so users
      // don't read this as conflicting with the Movies/Shows
      // browse header (deduped library titles). Raw count
      // includes cross-library duplicates (e.g. a film present
      // in BOTH "Movies" and "4K Movies" libraries is counted
      // twice here, once on the browse page).
      { label: 'Files: Movies · Shows', value: `${stats.movie_count.toLocaleString()} · ${stats.show_count.toLocaleString()}`, icon: 'film', tone: 'ok' },
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
      className="fixed left-2 right-2 md:left-auto md:right-6 md:w-[480px] max-h-[70vh] bg-[#0a0a0f]/95 backdrop-blur-xl border border-white/[0.06] rounded-xl shadow-2xl p-5 z-[45] animate-fade-in overflow-y-auto"
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
        {!isAdmin && <p className="text-white/40 text-sm col-span-full">Server status is admin-only.</p>}
        {isAdmin && !stats && <p className="text-white/40 text-sm col-span-full">Loading stats…</p>}
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
                  {stat.hint && <span className="text-white/30 text-[10px]">ⓘ</span>}
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
  if (!open) return null
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
      className="fixed left-2 right-2 md:left-auto md:right-6 md:w-[360px] max-h-[70vh] bg-[#0a0a0f]/95 backdrop-blur-xl border border-white/[0.06] rounded-xl shadow-2xl z-[45] animate-fade-in overflow-y-auto"
      style={{ top: 'calc(var(--chrome-h, var(--topnav-h)) + 10px)' }}
    >
      <div className="p-4 border-b border-white/[0.06] flex items-center justify-between">
        <h3 className="text-white font-semibold">Notifications</h3>
        <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div>
        {notifications.length === 0 && (
          <div className="p-8 text-center">
            <p className="text-white/40 text-sm">No notifications yet</p>
            <p className="text-white/30 text-xs mt-2">You'll be notified when a request is ready to watch.</p>
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
          const dot = n.type === 'request_failed' ? 'bg-red-400' : isPartyType ? 'bg-purple-400' : 'bg-emerald-400'
          const isUnread = unreadSnapshot.has(n.id)
          return (
            <div
              key={n.id}
              className={`p-4 border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors flex items-start gap-3 ${isUnread ? 'bg-purple-500/[0.05]' : ''}`}
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
                      <p className="text-white/45 text-xs mt-1 truncate">
                        {invite.scheduled_start_at ? formatPartyTime(invite.scheduled_start_at, new Date()) : ''}
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
                          className="px-2.5 py-1 rounded-md text-xs font-medium bg-purple-600/25 border border-purple-500/50 text-purple-100 hover:bg-purple-600/40 transition-colors"
                        >
                          {invite.started_at || !invite.scheduled_start_at ? 'Join' : 'Open lobby'}
                        </button>
                      )}
                    </div>
                  </>
                )}
                {inviteGone && (
                  <p className="text-white/35 text-xs mt-1">This party has ended.</p>
                )}
                {isPartyType && n.type !== 'party_invite' && partyCode && (
                  <button
                    type="button"
                    onClick={() => onJoinParty(partyCode)}
                    className="mt-2 px-2.5 py-1 rounded-md text-xs font-medium bg-purple-600/25 border border-purple-500/50 text-purple-100 hover:bg-purple-600/40 transition-colors"
                  >
                    Join
                  </button>
                )}
                <p className="text-white/30 text-xs mt-1">
                  {fmtRel(n.created_at)}
                  {isUnread && <span className="ml-1.5 text-purple-300 font-medium">· New</span>}
                </p>
              </div>
            </div>
          )
        })}

        {/* Admin activity log, kept below the user's own notifications. */}
        {isAdmin && (
          <>
            <div className="px-4 pt-3 pb-2 border-t border-white/[0.06]">
              <h4 className="text-white/40 text-xs font-semibold uppercase tracking-wide">Recent Activity</h4>
            </div>
            {loading && entries.length === 0 && (
              <p className="px-4 pb-4 text-white/40 text-sm">Loading…</p>
            )}
            {!loading && entries.length === 0 && (
              <p className="px-4 pb-4 text-white/40 text-sm">No recent activity.</p>
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
function BrowseLoadingState({ title }: { title: string }) {
  return (
    // stage-gutter: movies/shows are in FULL_BLEED_VIEWS, so this no longer
    // inherits .stage-page's padding. It renders on every sort and genre
    // change (the parent resets the list to null), so without the gutter the
    // skeleton flashed edge-to-edge and then snapped in by 48px.
    <div className="animate-fade-in stage-gutter pt-8">
      <div className="mb-8">
        <h1 className="text-white text-4xl font-bold font-display">{title}</h1>
        <p className="text-white/60 text-sm mt-2">Loading your library…</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="aspect-[2/3] rounded-xl bg-white/[0.02] border border-white/[0.04] animate-pulse" />
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────── MAIN APP ─────────────────────── */

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
    backdrop: backdropURL(w.backdrop_path),
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
  // Whether the open player has minimized itself to the cast/AirPlay widget.
  // While minimized, Escape / back must NOT unmount it — that would tear down
  // the streaming session feeding the receiver and kill the cast.
  const playerMinimizedRef = useRef(false)

  // M10 Phase 4 — watch party state.
  // 2026-05-25 — pass user.id so the hook can scope its last-party
  // localStorage cache (lib/lastParty.ts) per signed-in user. Without
  // this, logging out and back in as a different user would surface
  // the prior user's "Recently in" pill.
  // user is tri-valued (null | false | ApiUser); narrow to id only
  // when actually logged in so the hook's cache key isn't keyed on
  // undefined-but-truthy values.
  const party = useParty(user && typeof user === 'object' ? user.id : undefined)
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
  const [partyJoinPrompt, setPartyJoinPrompt] = useState(false)
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
  const [activeProfileId, setActiveProfileId] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('aurora_active_profile_id')
      return raw ? parseInt(raw, 10) || null : null
    } catch { return null }
  })
  useEffect(() => {
    try {
      if (activeProfileId) localStorage.setItem('aurora_active_profile_id', String(activeProfileId))
      else localStorage.removeItem('aurora_active_profile_id')
    } catch { /* ignore */ }
  }, [activeProfileId])
  // Issue #462 — bind the switch server-side so parental-rating enforcement
  // (which never trusts a client-supplied profile id) knows which profile is
  // acting. Fire-and-forget: local switching above already works instantly
  // regardless of this call's outcome, and a transient failure here just
  // means enforcement uses the account default until the next successful
  // switch or token refresh.
  useEffect(() => {
    if (!activeProfileId) return
    void activateProfile(activeProfileId).catch(() => { /* best-effort */ })
  }, [activeProfileId])

  // Phase 5.2 parity — right-click context menu state.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: MediaContextItem[]; title?: string } | null>(null)
  const openCardContextMenu = useCallback((e: React.MouseEvent, m: Media) => {
    e.preventDefault()
    const items: MediaContextItem[] = [
      { label: 'Mark as Watched', onClick: () => {
        void markWatched(m.id).then((res) => {
          const id = nextToastId()
          setToasts(prev => [...prev, { id, message: `Marked "${m.title}" as watched`, type: 'success' }])
          // Surface achievement unlocks from the server's gamification
          // engine. One toast per unlock so they sequence cleanly.
          if (res?.achievements_unlocked && res.achievements_unlocked.length > 0) {
            for (const def of res.achievements_unlocked) {
              const tid = nextToastId()
              setToasts(prev => [...prev, { id: tid, message: `${def.icon} Achievement unlocked: ${def.title} (+${def.xp_reward} XP)`, type: 'success' }])
            }
          }
          // Refresh continue rail so the now-watched item drops off.
          setRetryNonce(n => n + 1)
        }).catch(err => {
          window.alert('Failed: ' + (err instanceof Error ? err.message : 'unknown'))
        })
      }},
      { label: 'Clear Progress', tone: 'danger', onClick: () => {
        void clearProgress(m.id).then(() => {
          const id = nextToastId()
          setToasts(prev => [...prev, { id, message: `Cleared progress for "${m.title}"`, type: 'info' }])
          setRetryNonce(n => n + 1)
        }).catch(err => {
          window.alert('Failed: ' + (err instanceof Error ? err.message : 'unknown'))
        })
      }},
      // Phase D — steerable thumbs. 👍 feeds the taste vector; 👎 excludes the
      // title from every rec surface. Both invalidate server-side; on 👎 we also
      // optimistically drop the card from the home rails (no costly LLM rebuild).
      { label: '👍 More like this', onClick: () => {
        void submitMediaFeedback(m.id, 'up', activeProfileId ?? undefined).then(() => {
          setToasts(prev => [...prev, { id: nextToastId(), message: `More like "${m.title}" — got it`, type: 'success' }])
        }).catch(err => window.alert('Failed: ' + (err instanceof Error ? err.message : 'unknown')))
      }},
      { label: '👎 Not interested', tone: 'danger', onClick: () => {
        void submitMediaFeedback(m.id, 'down', activeProfileId ?? undefined).then(() => {
          setToasts(prev => [...prev, { id: nextToastId(), message: `We'll show you less like "${m.title}"`, type: 'info' }])
          setHomeRails(rails => rails ? rails.map(rl => ({ ...rl, items: rl.items.filter(it => it.id !== m.id) })) : rails)
          // Also drop it from a pinned conversational rail, if one is showing.
          setConvoResults(prev => prev.filter(it => it.id !== m.id))
        }).catch(err => window.alert('Failed: ' + (err instanceof Error ? err.message : 'unknown')))
      }},
    ]
    if (profiles.length > 0) {
      items.push({ label: 'Add to Watchlist…', onClick: () => setAddToListMedia(m) })
    }
    if (user && user.role === 'admin') {
      items.push({ label: 'Refresh Metadata', onClick: () => { void handleRefreshMetadata(m) } })
    }
    // anchorFor, not raw clientX/clientY. A keyboard-opened context menu
    // (Shift+F10 or the Menu key, both of which fire a real `contextmenu` event
    // on the focused card) reports 0/0, so this used to pin the menu to the
    // viewport's top-left corner — open, but detached from the card it acts on.
    // `title` feeds the menu's accessible name — every item label is a bare verb
    // ("Mark as Watched"), and the menu opens from a grid of dozens of cards.
    setContextMenu({ ...anchorFor(e), items, title: m.title })
  // user is a discriminated union; the casts above narrow it. setToasts etc. are stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, user, activeProfileId])

  const [addToListMedia, setAddToListMedia] = useState<Media | null>(null)
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
  const [searchOpen, setSearchOpen] = useState(false)
  // Ref to the search input so Cmd+K / Ctrl+K can move focus to it.
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  // Shared "leave the nav search" routine — the X/clear button, an
  // outside click, and Escape (below) all need to do the exact same
  // thing: drop the query, fall back to Home if that's what the query
  // was driving, and give the input back its resting (unfocused) look.
  const closeSearch = useCallback(() => {
    setSearchQuery('')
    setSearchOpen(false)
    setView(v => (v === 'search' ? 'home' : v))
    searchInputRef.current?.blur()
  }, [])
  // Cmd+K opens a full-screen Spotlight-style palette (the top-bar
  // input stays for click-to-search flows).
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 2026-07-25 (Aurora Stage Phase 2, debug-review fix) — publish the
  // measured height of the sticky chrome stack as --chrome-h so every
  // overlay below it (both drawers, the mobile menu sheet + its scrim,
  // DetailRail's sticky offset) anchors to reality instead of to the nav's
  // nominal 64px. The stack grows by ~37px per actively-scanning library
  // because ScanProgressBar renders in flow above the nav, and an admin
  // mid-scan was the case where all five hardcoded offsets broke.
  // Aurora Stage Phase 7b (D5/D6) — which surface the player is presenting.
  // 'theater' is the only one that changes anything out here: the app behind the
  // theater box is VISIBLE for the first time, so it gets dimmed and made inert.
  // Fullscreen and minimized cover or hide the viewport, so nothing behind them
  // needs doing.
  const [playerSurface, setPlayerSurface] = useState<'theater' | 'fullscreen' | 'minimized' | null>(null)
  // Set by the switcher's "Who's watching?" item; the gate self-gates otherwise.
  const [profilesGateForced, setProfilesGateForced] = useState(false)
  // Reported UP by the gate, which owns the policy. App needs it only to keep
  // Cmd+K from opening the palette (z-200) on top of the gate (z-85).
  const [profilesGateOpen, setProfilesGateOpen] = useState(false)
  const theaterActive = playerSurface === 'theater'

  // Stamp the surface on <html> so CSS can react to it. This is what gates the
  // watch-party surfaces' theater rules (IMPLEMENTATION_PLAN §D5) — they are
  // rendered outside <main>, so they stay live and visible during playback:
  // the rail and reactions anchor into the box, and the minimized-party chip
  // keys its full-bleed `top` off it (index.css `.stage-party-*`). An
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
  const [library, setLibrary] = useState<Media[]>(() => {
    try {
      const raw = localStorage.getItem('aurora_my_library')
      return raw ? (JSON.parse(raw) as Media[]) : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    try { localStorage.setItem('aurora_my_library', JSON.stringify(library)) }
    catch { /* quota / private mode — non-fatal */ }
  }, [library])
  // In-flight optimistic library toggles, by media id → 'add' | 'remove'.
  // The reconcile below re-applies these on top of the server snapshot so a
  // save/unsave that completes DURING the fetch isn't clobbered by the
  // (older) snapshot. Cleared when each toggle's request settles.
  const pendingLibOpsRef = useRef<Map<number, 'add' | 'remove'>>(new Map())
  // Reconcile the local cache against the server's authoritative library for
  // the active profile (login, profile switch, refresh). Rich cached
  // snapshots win per id so posters/ratings survive; ids the server has that
  // the cache doesn't get a basic card from the server's lightweight item.
  useEffect(() => {
    if (!user || !activeProfileId) return
    let cancelled = false
    const ac = new AbortController()
    getLibrary(activeProfileId, ac.signal)
      .then(items => {
        if (cancelled) return
        setLibrary(prev => {
          const cachedById = new Map(prev.map(m => [m.id, m]))
          const pending = pendingLibOpsRef.current
          // Server set, minus any item an in-flight unsave is removing.
          const merged = items
            .filter(it => pending.get(it.media_item_id) !== 'remove')
            .map(it => cachedById.get(it.media_item_id) ?? libraryItemToMedia(it))
          // Re-add any in-flight save the snapshot predates.
          const have = new Set(merged.map(m => m.id))
          for (const [id, op] of pending) {
            if (op === 'add' && !have.has(id)) {
              const cached = cachedById.get(id)
              if (cached) merged.push(cached)
            }
          }
          return merged
        })
      })
      .catch(() => { /* offline / transient — keep the localStorage cache */ })
    return () => { cancelled = true; ac.abort() }
  }, [user, activeProfileId])
  // Memoized ID set so MediaRail / BrowseView / LibraryView can do
  // O(1) membership checks without re-creating the Set on every
  // render. Rebuilt only when the library array reference changes.
  const libraryIds = useMemo(() => new Set(library.map(m => m.id)), [library])
  const [toasts, setToasts] = useState<Toast[]>([])

  // Monotonic counter for toast IDs. Date.now()-based IDs can collide
  // under fast double-clicks and duplicate React keys corrupt the
  // toast list.
  const toastIdCounter = useRef(0)
  const nextToastId = useCallback(() => {
    toastIdCounter.current += 1
    return `t${toastIdCounter.current}`
  }, [])

  // Invites feature — the caller's open party invites (bell RSVP rows +
  // Calendar chips). null = never loaded. Refreshed when the bell opens
  // and when a live party notification arrives; RSVP flips optimistically.
  // Declared here, before useRealtime, whose onNotification references
  // refreshMyPartyInvites.
  const [myPartyInvites, setMyPartyInvites] = useState<MyPartyInvite[] | null>(null)
  const refreshMyPartyInvites = useCallback(() => {
    listMyPartyInvites()
      .then(setMyPartyInvites)
      .catch(() => { /* non-fatal — bell rows degrade to plain lines */ })
  }, [])
  useEffect(() => {
    if (notifOpen) refreshMyPartyInvites()
  }, [notifOpen, refreshMyPartyInvites])

  const handleInviteRsvp = useCallback((inviteId: number, rsvp: 'going' | 'maybe' | 'declined') => {
    // Optimistic flip; refetch on BOTH outcomes so a feed refresh that was
    // already in flight when the user clicked can't leave a stale pressed
    // state (2026-08 review) — the follow-up fetch converges on the
    // server's answer.
    setMyPartyInvites(prev =>
      prev ? prev.map(i => (i.invite_id === inviteId ? { ...i, rsvp } : i)) : prev)
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
  }, [refreshMyPartyInvites, nextToastId])

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
  const [moviesSort, setMoviesSort] = useState<MediaSort>('title')
  const [showsSort, setShowsSort] = useState<MediaSort>('title')
  // Genre filter — QA BUG-003 fix. Previously this lived inside
  // BrowseView, but changing Sort sets moviesList=null which
  // unmounts BrowseView and resets its local state. Lifting to
  // the parent keeps the user's genre selection across sort
  // changes (and across the loading-skeleton intermediate state).
  const [moviesGenre, setMoviesGenre] = useState('')
  const [showsGenre, setShowsGenre] = useState('')
  // Canonical genre catalogs from /api/media/genres — populated once
  // per browse view, used to render the dropdown so it doesn't shift
  // as the user paginates. Null while in flight; BrowseView falls
  // back to deriving from items so first paint isn't blocked.
  const [moviesGenres, setMoviesGenres] = useState<string[] | null>(null)
  const [showsGenres, setShowsGenres] = useState<string[] | null>(null)
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
  // Ref mirror for effects that need the CURRENT list without re-running
  // when the CW poll refreshes it (e.g. the detail fetch's season seed).
  const continueItemsRef = useRef(continueItems)
  useEffect(() => { continueItemsRef.current = continueItems }, [continueItems])
  // 2026-05-27 — Bug-report config. Holds the full server response so
  // the BugReportButton + modal can both gate on `enabled` AND surface
  // admin-only token-health diagnostics (added 2026-05-27 PAT health
  // check). The BugReportButton renders only when `enabled` is true.
  const [bugReportConfig, setBugReportConfig] = useState<BugReportConfig | null>(null)
  // M10 Phase 4.5 — Requests view real data.
  const [requestsList, setRequestsList] = useState<MediaRequest[] | null>(null)
  // Per-user notification feed (bell + panel). Seeded on login, kept live by the
  // 'notification' WS event; unreadCount drives the sidebar bell badge.
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  // Set the moment a mark-all-read is issued (panel open) and never cleared
  // until logout. Guards the seed fetch below against a race where its GET
  // was already in flight when the user marked everything read: without
  // this, the GET's now-stale `unread` count lands afterward and Math.max
  // slams the badge back up even though the server (and local state) has
  // already zeroed it. See issue #474.
  const markedAllReadRef = useRef(false)

  // Load profiles once the user is logged in.
  useEffect(() => {
    if (!user) { setProfiles([]); setProfilesLoaded(false); return }
    const ac = new AbortController()
    listProfiles(ac.signal).then(ps => {
      setProfiles(ps)
      // Validate the stored active profile against the loaded list.
      // If it no longer exists (deleted from another tab), fall back
      // to the default so we don't keep sending a stale profile_id.
      const validCurrent = activeProfileId && ps.some(p => p.id === activeProfileId)
      if (!validCurrent && ps.length > 0) {
        const def = ps.find(p => p.is_default) || ps[0]
        setActiveProfileId(def.id)
      } else if (ps.length === 0 && activeProfileId !== null) {
        setActiveProfileId(null)
      }
      setProfilesLoaded(true)
    }).catch(() => { /* non-fatal — profile features just stay disabled */ })
    return () => ac.abort()
  // activeProfileId intentionally excluded — we set it inside the
  // effect and don't want to re-run on that change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])
  // `null` rails = not yet fetched. Empty arrays inside rails are
  // filtered out by HomeView so a fresh install with no media
  // doesn't render ghost rails.
  const [homeHero, setHomeHero] = useState<Media | null>(null)
  // True when homeHero was set by the catalog fallback (recent/top-rated)
  // rather than the personalized pool. Drives the "Recently Added" label
  // in HeroSection instead of the misleading "Featured" pill.
  const [homeHeroIsFallback, setHomeHeroIsFallback] = useState(false)
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
  // Personalization status from /api/me/hero. When `coldStart` is true,
  // we're below the watch-history threshold and Hero is serving the
  // popular-unwatched fallback with no LLM blurbs — drives a UI hint
  // explaining why nothing's curated yet.
  const [heroPersonalization, setHeroPersonalization] = useState<HeroPersonalization | null>(null)
  const [heroSlateToken, setHeroSlateToken] = useState<string | undefined>()
  // Ref to read latest heroPool from the home-rails effect without
  // adding it to deps (which would re-fetch rails on every rotate).
  const heroPoolRef = useRef<HeroPick[]>([])
  // Throttle the "no file available" toast (episode_id → last-shown
  // ms). 2s cooldown dedupes accidental double-clicks while still
  // letting a genuine later click re-fire.
  const unavailableToastRef = useRef<Map<number, number>>(new Map())
  const [homeRails, setHomeRails] = useState<HomeViewProps['rails']>(undefined)
  // Phase D — conversational discovery: the active vibe query + its results,
  // pinned as the top home rail. Fires the existing semantic search on submit
  // (Enter), not per-keystroke, to bound LLM cost.
  const [convoQuery, setConvoQuery] = useState('')
  const [convoResults, setConvoResults] = useState<Media[]>([])
  const runConversational = useCallback((q: string) => {
    const query = q.trim()
    if (!query) { setConvoQuery(''); setConvoResults([]); return }
    setConvoQuery(query)
    setConvoLoading(true)
    void searchMedia(query, 12, undefined, 'semantic').then(res => {
      setConvoResults(res.items as Media[])
      setConvoLoading(false)
    }).catch(() => {
      setConvoLoading(false)
      /* keep prior results; the input retains the query */
    })
  }, [])
  const [homeLoading, setHomeLoading] = useState(false)
  const [convoLoading, setConvoLoading] = useState(false)
  const [homeError, setHomeError] = useState<string | null>(null)
  // 2026-06-05 (Home net-new #1) — real total library size for the greeting's
  // "picked from X titles" clause. Fetched count-only on Home mount via a
  // per_page=1 /api/media call (no type filter → counts movies+shows
  // together). null until it lands / on error, so the greeting omits the
  // clause rather than fabricating a number. The browse-tab counts
  // (moviesTotal+showsTotal) remain a fallback (see the libraryTotal prop).
  const [homeLibraryTotal, setHomeLibraryTotal] = useState<number | null>(null)

  const navigate = useNavigate()
  const location = useLocation()
  const previousPathnameRef = useRef(location.pathname)

  // QA BUG-001 — sync URL → view on mount and on every pathname
  // change (browser back/forward, bookmarks, direct loads). Without
  // this, `view = useState('home')` always wins on cold load even
  // if the URL says `/v2/calendar`. The setView call is idempotent;
  // when in-app handleNavigate triggers a pathname change, this
  // effect just confirms the same view we already set.
  useEffect(() => {
    const previousPathname = previousPathnameRef.current
    previousPathnameRef.current = location.pathname
    if (shouldClosePlayerOnPathChange(
      previousPathname,
      location.pathname,
      playerMinimizedRef.current,
    )) {
      // Covers browser Back/Forward and direct router navigation. Passing true
      // also dismisses a party lifecycle whose async resolver has not produced
      // a player target yet.
      closePlayer(true)
    }
    const target = pathToView(location.pathname)
    if (target !== view) {
      setView(target)
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


  // security — bounce a non-admin who lands on /admin (typed URL,
  // bookmark, stale link) back home. Pairs with the role gate on the
  // AdminView mount below; the sidebar link is already admin-only.
  // We wait until `user` is a resolved ApiUser so we don't redirect
  // during the boot/loading window (user === null) — once revalidated,
  // a non-admin gets kicked to home. Uses the same role signal as the link.
  useEffect(() => {
    if (user && user.role !== 'admin' && pathToView(location.pathname) === 'admin') {
      navigate('/')
    }
  }, [user, location.pathname, navigate])

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = nextToastId()
    setToasts(prev => [...prev, { id, message, type }])
  }, [nextToastId])

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  // Hydrate a /title/:id deep link (cold load, refresh, forward-button,
  // shared link). In-app opens set selectedMedia synchronously in
  // handleSelect before pushing the URL, so this no-ops for them — the
  // ids already match. Waits for `user` so the fetch runs authenticated.
  // Placed after addToast so its declaration precedes this reference.
  useEffect(() => {
    const id = titleIdFromPath(location.pathname)
    if (id === null || !user) return
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
  }, [location.pathname, user, selectedMedia, addToast, navigate])

  // App-wide realtime hub: live request-status patches + push notifications.
  // One socket for the whole session, enabled only while logged in.
  const realtimeUserId = user && typeof user === 'object' ? user.id : null

  // Boot-time push re-POST (do/pwa-push/IMPLEMENTATION.md D11): once per
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
    enabled: realtimeUserId != null,
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
  })

  // Seed the notification feed + unread badge on login (once per user id). The
  // WS keeps it live thereafter; resetUserState clears it on logout.
  useEffect(() => {
    if (realtimeUserId == null) return
    let cancelled = false
    const ac = new AbortController()
    listNotifications(ac.signal)
      .then(res => {
        if (cancelled) return
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
      })
      .catch(() => {
        /* non-fatal — the bell just stays empty */
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [realtimeUserId])

  // Mirror unreadCount onto the OS/PWA app icon badge (Dock, taskbar,
  // Android launcher) — see lib/pwa.ts:syncAppBadge for why this is
  // needed on top of the push payload's own badge write in sw.js.
  useEffect(() => {
    syncAppBadge(unreadCount)
  }, [unreadCount])

  const handleNavigate = useCallback((v: string) => {
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
    setSearchOpen(false)
    // Clear the search input on navigate. It's a controlled input on
    // `searchQuery`, so this prevents the text from sticking after
    // leaving the search view.
    setSearchQuery('')
    // Close the player on nav so the URL and rendered state stay in
    // sync (matters for programmatic history.replaceState calls).
    // EXCEPTION: when the player is minimized to the cast/AirPlay widget,
    // keep it mounted — navigating away from the show must NOT tear down an
    // active cast. The widget (rendered as a root-level sibling, outside the
    // swapped <main> view) persists and the receiver keeps playing until the
    // user stops it or the media ends. Mirrors the Escape gate above.
    if (!playerMinimizedRef.current) closePlayer(true)
    navigate(`/${v}`)
  }, [view, navigate, closePlayer])

  const handleSelect = useCallback((m: Media) => {
    setSelectedMedia(m)
    setView('detail')
    // Real URL per title: refresh keeps the page, browser Back returns to
    // the grid this was opened from, and the address bar is shareable.
    // selectedMedia is already set above so the deep-link hydration
    // effect no-ops for in-app opens.
    navigate(`/title/${m.id}`)
    // Issue #261 — clicking into a movie/show must open the detail page
    // at the top; the window otherwise keeps whatever scroll offset the
    // user had on the previous page (e.g. scrolled-down home).
    // Instant (not smooth) because the page content is being replaced —
    // a smooth scroll would animate over swapped-in content and look off.
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [navigate])

  // Play resolution. The UI Media type doesn't carry server file
  // IDs, so we resolve them here:
  //   - Movies: GET /api/media/{id}/files, pick a file.
  //   - Shows: play the first episode of season 1 (TODO: port the
  //     V1 next-episode smart-resume).
  const handlePlay = useCallback(async (m: Media) => {
    // Don't start a new playback while a cast/AirPlay session is active: it
    // would tear down the cast's stream and leave the widget driving a
    // different title than the TV. The cast persists across navigation by
    // design — the user stops it from the widget first.
    if (playerMinimizedRef.current) {
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
        const seasons = [...seasonsRaw].sort((a, b) => a.season_number - b.season_number)
        const firstSeason = seasons[0]
        const episodesRaw = await getEpisodes(m.id, firstSeason.season_number, ac.signal)
        if (!isPlaybackResolutionCurrent(myGen, playbackResolutionGenRef.current, ac.signal.aborted)) return
        if (episodesRaw.length === 0) throw new Error('No episodes available')
        const episodes = [...episodesRaw].sort((a, b) => a.episode_number - b.episode_number)
        const ep = episodes[0]
        // ep.files is already typed `EpisodeFile[] | undefined` in
        // api.ts — the previous redundant `as` cast suggested a type
        // mismatch that doesn't exist. Same cleanup applied to all
        // four remaining sites in this file.
        const file = pickFile(ep.files, preferQuality)
        if (!file) throw new Error('Episode has no files')
        setPlayerTarget({
          mediaItemId: m.id,
          fileId: file.id,
          fileType: 'episode',
          episodeId: ep.id,
          seasonNumber: firstSeason.season_number,
          episodeNumber: ep.episode_number,
          title: m.title,
          subtitle: `S${firstSeason.season_number}E${ep.episode_number}${ep.title ? ' — ' + ep.title : ''}`,
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
  const handlePrimaryIntent = useCallback(async (m: Media, resumeItem?: ContinueWatchingItem) => {
    if (!prewarmEnabled()) return
    // Don't pre-warm while casting — handlePlay refuses to start new local
    // playback in that state, so a warm would never be consumed.
    if (playerMinimizedRef.current) return

    const startSec = resumeItem && resumeItem.position_ms > 0
      ? Math.floor(resumeItem.position_ms / 1000)
      : 0
    // Skip the resolution fetches (getMediaFiles / getEpisodes / getSeasons)
    // when the intent is unchanged — the warm for this target is already in
    // flight or done; re-resolving would just burn redundant API round-trips.
    const intentKey = `${m.type}:${m.id}:${resumeItem?.episode_id ?? ''}:${startSec}`
    if (lastIntentKeyRef.current === intentKey) return
    lastIntentKeyRef.current = intentKey

    try {
      const preferQuality = currentPreferredQuality()

      if (m.type === 'show') {
        if (resumeItem?.episode_id && resumeItem.season_number !== undefined) {
          // Resume → the CW record names the exact episode + position.
          const eps = await getEpisodes(m.id, resumeItem.season_number)
          const ep = eps.find(e => e.id === resumeItem.episode_id)
          const file = pickFile(ep?.files, preferQuality)
          if (file) void prewarm({ fileId: file.id, fileType: 'episode', startSec })
        } else {
          // Fresh → first episode of the first season (mirrors handlePlay's
          // explicit season/episode sort).
          const seasonsRaw = await getSeasons(m.id)
          if (seasonsRaw.length === 0) return
          const seasons = [...seasonsRaw].sort((a, b) => a.season_number - b.season_number)
          const episodesRaw = await getEpisodes(m.id, seasons[0].season_number)
          if (episodesRaw.length === 0) return
          const episodes = [...episodesRaw].sort((a, b) => a.episode_number - b.episode_number)
          const file = pickFile(episodes[0].files, preferQuality)
          if (file) void prewarm({ fileId: file.id, fileType: 'episode', startSec: 0 })
        }
      } else {
        const files = await getMediaFiles(m.id)
        const file = pickFile(files, preferQuality)
        if (file) void prewarm({ fileId: file.id, fileType: 'media', startSec })
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
      cancelPrewarm()
      lastIntentKeyRef.current = null
    }
  }, [view, selectedMedia?.id])

  const handleToggleLib = useCallback((m: Media) => {
    // Optimistic: flip local state now, persist to the server, roll back on
    // failure. Needs a signed-in profile — the library is per-profile.
    if (!activeProfileId) {
      addToast('Pick a profile to save titles', 'info')
      return
    }
    const wasSaved = library.some(i => i.id === m.id)
    // All membership mutations dedupe inside the functional updater so a
    // rapid double-click can't insert the same id twice (duplicate React
    // keys) or drop it — the render-closure read above only decides intent.
    const addLocal = (prev: Media[]) => (prev.some(i => i.id === m.id) ? prev : [...prev, m])
    const removeLocal = (prev: Media[]) => prev.filter(i => i.id !== m.id)
    setLibrary(wasSaved ? removeLocal : addLocal)
    addToast(
      wasSaved ? `Removed "${m.title}" from library` : `Added "${m.title}" to library`,
      wasSaved ? 'info' : 'success',
    )
    // Record the in-flight op so a concurrent reconcile preserves it.
    pendingLibOpsRef.current.set(m.id, wasSaved ? 'remove' : 'add')
    const settle = () => pendingLibOpsRef.current.delete(m.id)
    const req = wasSaved
      ? removeFromLibrary(activeProfileId, m.id)
      : addToLibrary(activeProfileId, m.id)
    req.then(settle).catch(() => {
      settle()
      // Roll back the optimistic change and tell the user it didn't stick.
      setLibrary(wasSaved ? addLocal : removeLocal)
      addToast(`Couldn't ${wasSaved ? 'remove' : 'save'} "${m.title}" — try again`, 'error')
    })
  }, [library, activeProfileId, addToast])

  const handleBack = useCallback(() => {
    // In-app opens pushed /title/:id onto the history stack, so real
    // history-back returns to the exact view (and scroll restoration)
    // the user came from — and the browser's own Back button now does
    // the same thing as this in-app arrow. A cold load (refresh or a
    // shared link) has no in-app entry behind it; going back(-1) would
    // leave the SPA, so route home instead. selectedMedia is cleared by
    // the URL-sync effect once the path stops being /title/:id.
    if (location.key !== 'default') {
      navigate(-1)
    } else {
      navigate('/', { replace: true })
    }
  }, [location.key, navigate])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Palette has its own Escape handler — let it close the
        // palette without ALSO triggering the page-level back/etc.
        // navigation here.
        if (paletteOpen) return
        // While the player is minimized to the cast/AirPlay widget, Escape
        // must NOT unmount it (that kills the cast) — fall through to the
        // normal app navigation below instead.
        if ((playerTarget || playerLoading) && !playerMinimizedRef.current) closePlayer(true)
        else if (searchOpen) closeSearch()
        else if (view === 'detail') handleBack()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // Cmd+K opens the SearchPalette overlay. Guard against:
        //   - unauthenticated (no user)
        //   - typing in another editable element
        //   - any modal already open
        if (!user) return
        const target = e.target as HTMLElement | null
        const inEditable = !!target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        )
        // Allow Cmd+K from inside our own top-bar search input
        // (acts as "upgrade to palette" affordance).
        if (inEditable && target !== searchInputRef.current) return
        if (playerTarget || partyJoinPrompt || contextMenu || addToListMedia) return
        // The profile gate belongs in this list too. SearchPalette is z-200 and
        // the gate is z-85, so Cmd+K opened the palette over it, and picking a
        // result navigated the app behind a gate that stayed up.
        if (profilesGateOpen) return
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // Modal-state deps so the Cmd+K guard re-binds when a modal
    // opens/closes (avoids a stale closure reading "no modal" while
    // one is actually open).
  }, [playerTarget, playerLoading, searchOpen, view, handleBack, partyJoinPrompt, contextMenu, addToListMedia, user, paletteOpen, profilesGateOpen, closePlayer, closeSearch])

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
    setHomeRails(undefined)
    setHomeHero(null)
    setHomeHeroIsFallback(false)
    // Clear hero pool too — without this, user A's personalized
    // blurb is briefly visible to user B after a cross-tab logout.
    setHeroPool([])
    setHeroIndex(0)
    setHeroPaused(false)
    setHeroSlateToken(undefined)
    heroPoolRef.current = []
    // Same leak class for the follow feed (PR-429 review): the ref
    // survives the auth swap, and a warm-cache Discover resolving first
    // would recompose user B's home with user A's feed spliced in.
    followingRailRef.current = []
    setContinueItems([])
    setMoviesList(null)
    setShowsList(null)
    setMoviesTotal(null)
    setShowsTotal(null)
    // Pagination state reset on logout. Sort preference is per-user
    // so default it back; loading flags are per-session.
    setMoviesSort('rating')
    setShowsSort('rating')
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
  }, [navigate, closePlayer])

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
  // because it remounted everything. These two make it re-run: a staleness gate
  // on returning to Home (every user), and a scan-completion signal (whoever is
  // watching a scan). Both bump the same nonce so a scan finishing while you
  // are already on Home doesn't need you to navigate at all.
  const [homeReloadNonce, setHomeReloadNonce] = useState(0)
  const lastHomeLoadRef = useRef(0)
  // Which profile the rails currently on screen belong to. Distinguishes a
  // profile switch (must wipe the personalized rails) from a same-profile
  // refresh (must not). null is a real value here — "the account default" —
  // so it starts undefined to force the first load down the switch path.
  const railsProfileRef = useRef<number | null | undefined>(undefined)
  // Read by the focus listener below, which must not re-bind on every
  // navigation just to know where the user currently is. Written in an effect,
  // not during render — React 19 forbids the latter, and eslint enforces it.
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])
  const refreshHomeData = useCallback(() => setHomeReloadNonce(n => n + 1), [])

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
  // Re-checking on tab focus covers that, and is the only path a NON-admin has
  // to see a scan's results without navigating, since the scan-completion
  // signal is behind the admin-gated poller.
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
    const core = coreRailsRef.current
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
            showBadges: true,
            subtitle: 'Recently watched by members you follow',
            cardSubtitles: followingRailRef.current.reduce<Record<number, string>>(
              (acc, w) => { acc[w.id] = followedWatchSubtitle(w); return acc }, {}),
          }]
        : []),
      ...discoverRailsRef.current
        .filter(r => r.items.length > 0)
        .map(r => ({ title: r.title, items: r.items as Media[], aspect: 'poster' as const,
          aiPick: true, showBadges: true, subtitle: r.description || 'Hand-picked by Aurora for your taste' })),
      ...anchorRailsRef.current
        .filter(r => r.items.length > 0)
        .map(r => ({ title: r.title, items: r.items as Media[], aspect: 'poster' as const,
          aiPick: true, showBadges: true, subtitle: 'More like the titles you finished' })),
      ...engagementRailsRef.current
        .filter(r => r.items.length > 0)
        .map(r => ({ title: r.title, items: r.items as Media[], aspect: 'poster' as const,
          aiPick: true, showBadges: true, subtitle: r.description || 'Built from what Aurora viewers actually finish' })),
    ]
    if (personalized.length === 0) { setHomeRails(core); return }
    // Splice personalized rails between Recently Added (index 0) and the Top
    // Rated rails — same visual order the original effect produced.
    setHomeRails([core[0], ...personalized, ...core.slice(1)])
  }, [])

  // Re-fetch the Discover endpoint and splice the rails in. Shared by the
  // discover_ready WS push and the manual "Refresh picks" action. `refresh`
  // forces a server-side rebuild (?refresh=1).
  const refetchDiscover = useCallback(async (profileId: number | null, refresh = false) => {
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
    setRecsRefreshing(true)
    addToast('Refreshing your picks…', 'info')
    await refetchDiscover(activeProfileId, true)
    setRecsRefreshing(false)
  }, [activeProfileId, refetchDiscover, addToast])

  useEffect(() => {
    if (!user) return
    const ac = new AbortController()
    let cancelled = false
    ;(async () => {
      // Cold = nothing on screen yet. Captured BEFORE the attempt stamp below,
      // because that stamp is what makes a load stop looking cold.
      const cold = lastHomeLoadRef.current === 0
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

        // Only set the rails-derived hero when the personalized pool
        // hasn't supplied one. Read via ref to avoid closure
        // staleness reporting the pool as empty after the hero fetch
        // already populated it.
        if (heroPoolRef.current.length === 0) {
          const hero = (recent[0] || movies[0] || null) as Media | null
          if (hero) { setHomeHero(hero); setHomeHeroIsFallback(true) }
        }

        // Build the core rail set (no personalized yet). Order is the
        // same as the final shape so the personalized splice below
        // can insert between Recently Added and Top Rated Movies
        // without re-ordering.
        // 2026-06-05 (Home redesign D) — every Home rail card now opts
        // into quality badges (showBadges) so 4K/HDR chips show, matching
        // the mockup. Core rails (Recently Added / Top Rated) get neither
        // the "AI PICK" chip nor a "why it's here" subtitle — only the
        // recommender-driven discover/anchor rails do (spliced below).
        const coreRails: NonNullable<HomeViewProps['rails']> = [
          // Recently Added blends movies + shows so the See All
          // can't honestly map to a single browse page — leave the
          // affordance off rather than pick one arbitrarily.
          { title: 'Recently Added', items: recent as Media[], aspect: 'poster' as const, showBadges: true },
          // Top Rated rails map cleanly to /movies and /shows with
          // sortBy=rating, so the See All button takes
          // the user to the full Top Rated catalog.
          { title: 'Top Rated Movies', items: movies as Media[], aspect: 'poster' as const, showBadges: true,
            seeAllTarget: { view: 'movies' as const, sortBy: 'rating' as const } },
          { title: 'Top Rated Shows', items: shows as Media[], aspect: 'poster' as const, showBadges: true,
            seeAllTarget: { view: 'shows' as const, sortBy: 'rating' as const } },
        ]
        // Re-stamp on success so the freshness window runs from when the data
        // actually landed rather than from when we started asking for it.
        lastHomeLoadRef.current = Date.now()
        setHomeRails(coreRails)
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
        // overwrites its own buffer as it re-resolves.
        const profileChanged = shouldResetPersonalizedRails(railsProfileRef.current, activeProfileId)
        railsProfileRef.current = activeProfileId
        coreRailsRef.current = coreRails
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
  }, [user, retryNonce, activeProfileId, homeReloadNonce])

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
    if (!user || view !== 'movies' || moviesList !== null) return
    let cancelled = false
    const ac = new AbortController()
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
  }, [user, view, moviesList, moviesSort, moviesGenre, nextToastId])

  // One-time fetch of the canonical genre catalog per browse view.
  // Doesn't need to re-fire on sort/page changes — genre set doesn't
  // shift with pagination. Only re-fetches when the user navigates
  // back into the view fresh (moviesGenres === null reset).
  useEffect(() => {
    if (!user || view !== 'movies' || moviesGenres !== null) return
    let cancelled = false
    const ac = new AbortController()
    listGenres('movie', ac.signal)
      .then(gs => { if (!cancelled) setMoviesGenres(gs) })
      .catch(() => { /* dropdown falls back to deriving from items */ })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, moviesGenres])

  useEffect(() => {
    if (!user || view !== 'shows' || showsList !== null) return
    let cancelled = false
    const ac = new AbortController()
    listMediaWithTotal({
      type: 'show', perPage: BROWSE_PER_PAGE, sortBy: showsSort,
      genre: showsGenre || undefined, signal: ac.signal,
    })
      .then(({ items, total, page }) => {
        if (cancelled) return
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
  }, [user, view, showsList, showsSort, showsGenre, nextToastId])

  useEffect(() => {
    if (!user || view !== 'shows' || showsGenres !== null) return
    let cancelled = false
    const ac = new AbortController()
    listGenres('show', ac.signal)
      .then(gs => { if (!cancelled) setShowsGenres(gs) })
      .catch(() => { /* fallback path */ })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, showsGenres])

  // Load More handlers — append the next page. Page state lives at
  // App level so the math survives navigating away and back mid-
  // pagination.
  const handleLoadMoreMovies = useCallback(async () => {
    if (!moviesList || moviesTotal == null || moviesLoadingMore) return
    if (moviesList.length >= moviesTotal) return
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
  }, [moviesList, moviesTotal, moviesLoadingMore, moviesSort, moviesGenre, moviesNextPage, nextToastId])

  const handleLoadMoreShows = useCallback(async () => {
    if (!showsList || showsTotal == null || showsLoadingMore) return
    if (showsList.length >= showsTotal) return
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
  }, [showsList, showsTotal, showsLoadingMore, showsSort, showsGenre, showsNextPage, nextToastId])

  // Sort-change handlers. Setting null on the items list triggers
  // the fetch effect above to re-run with the new sort, fetching
  // page 1. The total is also cleared so the "Showing N of TOTAL"
  // banner doesn't show a mismatched stale count during the
  // refetch window. Audit HIGH-2 — also abort any in-flight Load
  // More + reset the nextPage cursor so a fresh sort always starts
  // at page 1.
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
        const detail = await getMedia(selectedMedia.id, ac.signal)
        if (cancelled) return
        setDetailItem(detail)
        if (detail.type === 'show') {
          const seasonsRaw = await getSeasons(selectedMedia.id, ac.signal)
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
            const initialSeason =
              cw?.season_number != null && seasons.some(s => s.season_number === cw.season_number)
                ? cw.season_number
                : seasons[0].season_number
            setDetailSelectedSeason(initialSeason)
            const epsRaw = await getEpisodes(selectedMedia.id, initialSeason, ac.signal)
            if (cancelled) return
            const eps = [...epsRaw].sort((a, b) => a.episode_number - b.episode_number)
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
    if (playerMinimizedRef.current) {
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

  // Deep-debug M2 — memoized bundle for HomeView's CW rail. Stable
  // identity unless continueItems OR handlePlayContinue changes (both
  // already memoized upstream). Without this, the inline object
  // literal at the HomeView render would create a fresh reference
  // every App render, defeating any future React.memo on the
  // HomeView/MediaRail/MediaCardCinema tree.
  const homeCwResumeBundle = useMemo(
    () => ({ items: continueItems, onPlay: handlePlayContinue }),
    [continueItems, handlePlayContinue],
  )

  // Play a specific file from the version picker — bypasses
  // pickFile's quality preference since the user picked explicitly.
  const handlePlayFile = useCallback((m: Media, fileId: number) => {
    if (playerMinimizedRef.current) {
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
  const handleIdentifyClose = useCallback(() => setIdentifyTarget(null), [])
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
    if (playerMinimizedRef.current) {
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
  const reloadHeroPool = useCallback(async (refresh: boolean) => {
    if (!user) return
    try {
      const resp = await getHeroPool(refresh, activeProfileId ?? undefined)
      heroPoolRef.current = resp.picks
      setHeroPool(resp.picks)
      setHeroPersonalization(resp.personalization)
      setHeroSlateToken(resp.slateToken)
      setHeroIndex(0)
      if (resp.picks.length > 0) { setHomeHero(resp.picks[0].media); setHomeHeroIsFallback(false) }
      // Empty pool: leave homeHero/flag as-is. On first load the hero
      // hasn't been set yet, so the home-rails catalog fallback (which
      // checks heroPoolRef.current.length === 0) will set it with
      // isFallback=true. On a runtime refresh that returns empty, the
      // displayed hero is still the previous pool pick — not catalog
      // filler — so the existing label remains correct.
    } catch {
      // Non-fatal — keep whatever hero we had (listRecent fallback
      // from home-rails effect).
      heroPoolRef.current = []
      setHeroPool([])
      setHeroPersonalization(null)
      setHeroSlateToken(undefined)
    }
  }, [user, activeProfileId])
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
    // Re-point the displayed hero only if the panned title was showing.
    // Empty pool: keep the current hero on screen (same rule as
    // reloadHeroPool's empty-response path) — the nonce refetch or the
    // catalog fallback will replace it.
    setHomeHero(prev => (prev && prev.id === mediaId && pool.length > 0 ? pool[0].media : prev))
  }, [])

  // "Not tonight" — advance to the NEXT pick in the loaded hero pool
  // instantly (no refetch), distinct from "Surprise me" (a whole fresh
  // pool via reloadHeroPool). Uses heroIndexRef so rapid skips advance
  // correctly and stay in sync with the 9s auto-rotation. Falls back to a
  // fresh pool when there's nothing to advance to (pool of 0 or 1).
  const advanceHero = useCallback(() => {
    if (heroPool.length < 2) { void reloadHeroPool(true); return }
    const next = (heroIndexRef.current + 1) % heroPool.length
    heroIndexRef.current = next
    setHeroIndex(next)
    setHomeHero(heroPool[next].media); setHomeHeroIsFallback(false)
    // Restart the 9s auto-rotation dwell from this pick (see rotEpoch) so a
    // skip isn't cut short by the next tick when the hero isn't hover-paused.
    setRotEpoch(e => e + 1)
  }, [heroPool, reloadHeroPool])

  // "Surprise me" — immediately START a random recommended pick, EXCLUDING the
  // one currently on screen so it always feels like a fresh surprise. (Was
  // wired to reloadHeroPool, which only refetched the pool and — on a stable
  // recommender — visibly did nothing.) Falls back to the current hero when the
  // pool is too small to offer a different title.
  const onSurprise = useCallback(() => {
    const others = heroPool.filter((_, i) => i !== heroIndex)
    const choices = others.length ? others : heroPool
    const media = choices.length
      ? choices[Math.floor(Math.random() * choices.length)].media
      : homeHero
    if (media) void handlePlay(media)
  }, [heroPool, heroIndex, homeHero, handlePlay])

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
  // we leave homeLibraryTotal null and the greeting simply omits the clause
  // (it already gates on a non-null total). The browse-tab counts remain a
  // fallback. Gated on `user` so we don't fire pre-auth.
  useEffect(() => {
    if (!user) return
    const ac = new AbortController()
    listMediaWithTotal({ perPage: 1, signal: ac.signal })
      .then(({ total }) => setHomeLibraryTotal(total))
      .catch(() => { /* non-fatal — greeting omits the clause when null */ })
    return () => ac.abort()
  }, [user])

  // Keep heroIndexRef in sync with heroIndex across every change path
  // (auto-rotation, manual "Not tonight" skip, pool resets) so the
  // rotation interval below always reads the latest index.
  useEffect(() => { heroIndexRef.current = heroIndex }, [heroIndex])

  // Hero rotation. Cycles every 9s; pauses on hover via heroPaused. CSS in
  // HeroSection handles the crossfade. Reads the current index from
  // heroIndexRef (synced above) instead of a captured closure local, so it
  // always advances from the latest pick. heroIndex stays OUT of the deps
  // (it would re-create the interval every tick and drift the cadence); a
  // manual "Not tonight" skip instead bumps rotEpoch, which re-runs this
  // effect to restart the 9s dwell from the chosen pick without affecting
  // steady-state cadence.
  useEffect(() => {
    if (heroPool.length < 2 || heroPaused) return
    // 2026-06-17 (a11y quick-win) — respect prefers-reduced-motion (see
    // the BrowseView hero for rationale): skip the 9s auto-rotation so
    // the hero doesn't swap art + text out from under a low-vision
    // reader. Manual advance / hover-pause still work.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const id = window.setInterval(() => {
      const next = (heroIndexRef.current + 1) % heroPool.length
      setHeroIndex(next)
      setHomeHero(heroPool[next].media); setHomeHeroIsFallback(false)
    }, 9000)
    return () => window.clearInterval(id)
  }, [heroPool, heroPaused, rotEpoch])

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
    if (!user) return
    let cancelled = false
    const ac = new AbortController()
    listContinueWatching(50, activeProfileId ?? undefined, ac.signal)
      .then(items => { if (!cancelled) setContinueItems(items) })
      .catch(err => {
        // Non-fatal — continue rail just stays empty.
        if (!cancelled && err && (err as Error).name !== 'AbortError') {
          console.warn('[Aurora] continue-watching fetch failed', err)
        }
      })
    return () => { cancelled = true; ac.abort() }
    // 2026-05-27 — Re-runs on retryNonce (Retry button bumps both
    // home + CW) AND on cwReloadNonce (player-close bumps only CW so
    // the Resume label freshens without re-fetching home rails).
  }, [user, retryNonce, cwReloadNonce, activeProfileId, homeReloadNonce])

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
  // Deep-debug M1 — on-demand refresh callable so the launcher can
  // re-fetch when the user opens the modal. The server's PAT
  // health check updates every 6h on its own ticker; without the
  // on-demand refresh an admin who stays logged in past a token
  // expiry never sees the banner until next login. Stable identity
  // via useCallback so the BugReportButton's `onRefreshConfig`
  // prop reference doesn't churn.
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
        // Non-fatal — the launcher just stays hidden.
        console.warn('[Aurora] bug-report config fetch failed', err)
      })
    return () => { ac.abort() }
  }, [userIdForBugReport])

  // Requests list — lazy-fetch on first visit to the tab.
  useEffect(() => {
    if (!user || view !== 'requests' || requestsList !== null) return
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
  }, [user, view, requestsList])

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
    setUser(false)
    resetUserState()
  }, [party, resetUserState])

  if (user === null) {
    // Auth check in flight on a fresh tab with a stored token. Render
    // a minimal splash so we don't flash the login screen for users
    // who are already authenticated. Sub-100ms in the typical case.
    return (
      <div className="min-h-screen flex items-center justify-center aurora-bg">
        <div className="text-white/40 text-sm">Loading Aurora…</div>
      </div>
    )
  }
  if (user === false) {
    return <AuthView onLogin={(u) => setUser(u)} />
  }

  return (
    <div className="min-h-screen bg-[#050505] aurora-bg">
      {/* 2026-07-25 (Aurora Stage Phase 2) — the 240px <Sidebar> and its
          mobile drawer + hamburger (QA BUG-012) are gone; <TopNav> below
          owns navigation at every breakpoint, with its own menu sheet
          below md carrying the drawer's role. */}

      <ServerPanel
        open={serverOpen}
        isAdmin={user.role === 'admin'}
        onClose={() => setServerOpen(false)}
      />

      <NotificationPanel
        open={notifOpen}
        isAdmin={user.role === 'admin'}
        onClose={() => setNotifOpen(false)}
        notifications={notifications}
        partyInvites={myPartyInvites}
        onRsvp={handleInviteRsvp}
        onJoinParty={code => void handleJoinInviteParty(code)}
        onMarkAllRead={() => {
          // No `unreadCount === 0` guard: unreadCount can still read 0 here
          // purely because the initial seed fetch hasn't landed yet (see the
          // seed effect above), which previously caused this to silently
          // skip both the local mark and the server POST — issue #474. The
          // endpoint is idempotent, so firing it with nothing to mark is a
          // harmless no-op.
          markedAllReadRef.current = true
          setUnreadCount(0)
          const now = new Date().toISOString()
          setNotifications(prev => prev.map(n => (n.read_at ? n : { ...n, read_at: now })))
          markAllNotificationsRead().catch(() => {
            /* non-fatal — local state is already cleared */
          })
        }}
      />

      {/* Cmd+K Spotlight palette. Overlays everything at z-200. */}
      <SearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={(m) => {
          setPaletteOpen(false)
          // Reuse handleSelect so the palette pushes the same
          // /title/:id history entry as a card click.
          handleSelect(m as Media)
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
             SearchPalette, the toasts, both gates and the party surfaces all
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
      <main className={`min-h-screen ${theaterActive ? 'stage-dim-app' : ''}`} inert={theaterActive || undefined}>
        {/* Sticky stack: scan bar + nav in one sticky container so the
            scan bar contributes its height to flow and both pin together
            on scroll. The bar stays ABOVE the nav, as in the mockup. */}
        <div ref={chromeRef} className="sticky top-0 z-50">
          {/* Global scan progress bar (admin-only). Returns null when
              no scan is active. NOTE: it renders IN FLOW above the nav, so
              it changes the height of this whole sticky stack — which is
              why chromeRef publishes the measured height as --chrome-h
              (see the effect above) for everything anchored below it. */}
          <ScanProgressBar isAdmin={user.role === 'admin'} onScanComplete={refreshHomeData} />
          <TopNav
            user={user}
            currentView={view}
            onNavigate={handleNavigate}
            searchQuery={searchQuery}
            onSearchQueryChange={(v) => {
              setSearchQuery(v)
              if (v) {
                setView('search')
              } else if (view === 'search') {
                setView('home')
              }
            }}
            onSearchFocus={() => setSearchOpen(true)}
            onSearchClose={closeSearch}
            searchInputRef={searchInputRef}
            onOpenPalette={() => setPaletteOpen(true)}
            // Party — M10 Phase 4. Click opens the panel if already in a
            // party, otherwise prompts for a code to join.
            partyActive={!!party.state.code}
            partyLabel={party.state.code ? `In party ${party.state.code}` : 'Join a watch party'}
            onPartyClick={() => {
              if (party.state.code) {
                setPartyPanelOpen(o => !o)
              } else {
                setPartyJoinPrompt(true)
              }
            }}
            partyPanelOpen={partyPanelOpen}
            serverOpen={serverOpen}
            onToggleServer={() => { setServerOpen(!serverOpen); setNotifOpen(false) }}
            notifOpen={notifOpen}
            onToggleNotifications={() => { setNotifOpen(!notifOpen); setServerOpen(false) }}
            // Force-open variants for the avatar dropdown's rows. A row
            // labelled "Notifications" must never CLOSE the panel because it
            // happened to already be open — below md that dropdown is the
            // only surface for these, with no icon state to explain it.
            onOpenServerPanel={() => { setServerOpen(true); setNotifOpen(false) }}
            onOpenNotificationsPanel={() => { setNotifOpen(true); setServerOpen(false) }}
            // Social phase 1 — "My Profile" dropdown row. Path nav (not a
            // view id): the member page is keyed by username in the URL,
            // same pattern as /title/:id.
            onOpenMyProfile={() => navigate(`/user/${encodeURIComponent(user.username)}`)}
            // Social phase 2 — the member directory. A real view id, so it
            // rides handleNavigate like Settings does from this menu.
            onOpenMembers={() => handleNavigate('members')}
            notifCount={unreadCount}
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSelectProfile={setActiveProfileId}
            // The dashed Add-Profile row routes here rather than duplicating
            // the create form in the menu — SettingsView's
            // ProfilesAndWatchlistsCard already owns creation plus the taste
            // onboarding it kicks off.
            onAddProfile={() => handleNavigate('settings')}
            onOpenProfilesGate={() => setProfilesGateForced(true)}
            avatarUrl={(profiles.find(p => p.id === activeProfileId) ?? profiles.find(p => p.is_default) ?? profiles[0])?.avatar_url}
            onSignOut={() => { void handleLogout() }}
          />
        </div>{/* /sticky stack */}

        {/* Page Content. The global `p-8` is gone (Aurora Stage M2): pages
            are full-bleed and opt IN to the standard gutter via
            .stage-page, so a hero can reach the viewport edge.
            
            FULL_BLEED_VIEWS opt out entirely because they lead with an
            edge-to-edge hero and pad their own sections with .stage-gutter
            instead (Phase 4 added home/movies/shows to what was just
            `detail`). Everything else keeps the standard page pad. */}
        <div className={FULL_BLEED_VIEWS.has(view) ? undefined : 'stage-page'}>
          {view === 'home' && (
            <HomeView
              onSelect={handleSelect}
              onPlay={handlePlay}
              hero={homeHero ?? undefined}
              // Prepend the Continue Watching rail. Dedupe by
              // media_item_id at the rail level so a show with
              // progress on multiple episodes only surfaces one card
              // (most-recently-watched) — avoids duplicate-key
              // warnings and the "click the old card, play the new
              // episode" confusion. LibraryView keeps every row.
              rails={(() => {
                // Phase D — conversational discovery: when a vibe search is
                // active, pin its results as the first rail.
                const convoRail: NonNullable<HomeViewProps['rails']> = convoResults.length > 0
                  ? [{ title: convoQuery, items: convoResults, aspect: 'poster' as const, aiPick: true, showBadges: true, subtitle: 'Your conversational search' }]
                  : []
                if (!homeRails && continueItems.length === 0) return convoRail.length > 0 ? convoRail : undefined
                const base = homeRails ?? []
                if (continueItems.length === 0) return [...convoRail, ...base]
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
                return [
                  ...convoRail,
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
              })()}
              loading={homeLoading}
              convoLoading={convoLoading}
              error={homeError}
              onRetry={requestHomeReload}
              onCardContext={openCardContextMenu}
              heroReason={heroPool[heroIndex]?.reason}
              heroIsCatalogFallback={homeHeroIsFallback}
              heroMatch={heroPool[heroIndex]?.match}
              heroScore={heroPool[heroIndex]?.score}
              heroSlateToken={heroSlateToken}
              heroPosition={heroIndex}
              activeProfileId={activeProfileId ?? undefined}
              // "Surprise me" — play a random recommended pick (not the one shown).
              onSurprise={onSurprise}
              onConversationalSearch={runConversational}
              onRefreshRecs={handleRefreshRecs}
              recsRefreshing={recsRefreshing}
              // "Not tonight" — advance to the next pick in the loaded pool.
              onNextPick={advanceHero}
              onHeroPauseChange={setHeroPaused}
              heroPersonalization={heroPersonalization}
              libraryIds={libraryIds}
              onToggleLib={handleToggleLib}
              // 2026-06-05 (Home redesign A/F) — greeting band + watch-
              // together inputs.
              user={typeof user === 'object' ? user : undefined}
              // Real count of the AI-curated set (hero picks + AI rails,
              // deduped) — varies, vs the old fixed ~5 hero-pool size.
              pickCount={aiCuratedCount}
              // Real library total. Prefer the count-only mount fetch
              // (homeLibraryTotal — movies+shows in one call); fall back to
              // the browse-tab counts (moviesTotal / showsTotal, populated
              // lazily when the user visits those tabs). Pass null when none
              // has loaded so HomeView OMITS the "picked from X titles"
              // clause rather than fabricate it.
              libraryTotal={
                homeLibraryTotal != null
                  ? homeLibraryTotal
                  : moviesTotal == null && showsTotal == null
                    ? null
                    : (moviesTotal ?? 0) + (showsTotal ?? 0)
              }
              // Opens the existing Watch Party hub (same as the top bar).
              onOpenParty={() => setPartyJoinPrompt(true)}
              // Join a specific active party (Watch-together card) — same path
              // as PartyHubModal's onJoin: join by code, then open the panel.
              onJoinParty={(code) => party.join(code).then((r) => {
                if (r.ok) setPartyPanelOpen(true)
                return r
              })}
              // 2026-05-27 — Hero resume bundle. Same lookup as
              // DetailView's `resume`: find the user's CW record for
              // the current hero (movie OR show) with position_ms > 0.
              // When present, HeroSection swaps its primary CTA from
              // "Play" to "Resume at MM:SS" (or "Resume S2E5 · MM:SS"
              // for shows) and dispatches handlePlayContinue with the
              // matched record. Resolved via an IIFE so the lookup
              // sits inline at the call site and re-runs naturally
              // when continueItems or homeHero changes.
              heroResume={(() => {
                if (!homeHero) return undefined
                // isResumable replaces the bare `position_ms > 0` check
                // so the Hero matches every other surface's threshold
                // (deep-debug H2: was an asymmetry — Hero was the only
                // site already using the 5s gate; detail/CW lookups
                // were on > 0).
                const item = continueItems.find(c =>
                  c.media_item_id === homeHero.id && isResumable(c),
                )
                return item ? { item, onPlay: handlePlayContinue } : undefined
              })()}
              // 2026-05-27 — Continue Watching one-click resume on
              // the home CW rail. HomeView scopes the resume pill
              // to rail.kind === 'continue-watching'; this prop
              // just supplies the lookup data + handler.
              // Deep-debug M2 — memoized so HomeView / MediaRail can
              // benefit from React.memo in the future without the
              // bundle re-creating fresh references every render.
              cwResume={homeCwResumeBundle}
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
            <ViewSuspense fallback={<BrowseLoadingState title="Movies" />}>
              {moviesList === null
                ? <BrowseLoadingState title="Movies" />
                : <BrowseView
                    items={moviesList}
                    total={moviesTotal}
                    title="Movies"
                    subtitle="Browse your movie collection"
                    mediaType="movie"
                    sortBy={moviesSort}
                    onSortChange={handleMoviesSortChange}
                    genreFilter={moviesGenre}
                    onGenreChange={handleMoviesGenreChange}
                    availableGenres={moviesGenres}
                    onLoadMore={handleLoadMoreMovies}
                    isLoadingMore={moviesLoadingMore}
                    onSelect={handleSelect}
                    onPlay={handlePlay}
                    onCardContext={openCardContextMenu}
                    libraryIds={libraryIds}
                    onToggleLib={handleToggleLib}
                    continueItems={continueItems}
                    onPlayContinue={handlePlayContinue}
                  />
              }
            </ViewSuspense>
          )}
          {view === 'shows' && (
            <ViewSuspense fallback={<BrowseLoadingState title="TV Shows" />}>
              {showsList === null
                ? <BrowseLoadingState title="TV Shows" />
                : <BrowseView
                    items={showsList}
                    total={showsTotal}
                    title="TV Shows"
                    subtitle="Browse your series collection"
                    mediaType="show"
                    sortBy={showsSort}
                    onSortChange={handleShowsSortChange}
                    genreFilter={showsGenre}
                    onGenreChange={handleShowsGenreChange}
                    availableGenres={showsGenres}
                    onLoadMore={handleLoadMoreShows}
                    isLoadingMore={showsLoadingMore}
                    onSelect={handleSelect}
                    onPlay={handlePlay}
                    onCardContext={openCardContextMenu}
                    libraryIds={libraryIds}
                    onToggleLib={handleToggleLib}
                    continueItems={continueItems}
                    onPlayContinue={handlePlayContinue}
                  />
              }
            </ViewSuspense>
          )}
          {view === 'library' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <LibraryView
                library={library}
                continueItems={continueItems}
                onSelect={handleSelect}
                onToggleLib={handleToggleLib}
                // 2026-05-27 — Continue Watching one-click resume on
                // the LibraryView CW grid (mirrors home CW rail).
                onPlayContinue={handlePlayContinue}
              />
            </ViewSuspense>
          )}
          {/* /title/:id deep link, selection still hydrating from the
              API — hold the layout with a skeleton instead of a blank
              page (or worse, a flash of the home view). */}
          {view === 'detail' && !selectedMedia && <ViewFallback />}
          {view === 'detail' && selectedMedia && (
            <ViewSuspense fallback={<ViewFallback />}>
              <DetailView
                // Reset internal state (active tab, cast-expand) per title so
                // detail→detail navigation (e.g. Cmd+K search) never leaves a
                // stale tab selected (an Episodes tab on a movie = blank column).
                key={selectedMedia.id}
                media={selectedMedia}
                onBack={handleBack}
                onPlay={handlePlay}
                onPlayIntent={handlePrimaryIntent}
                onToggleLib={handleToggleLib}
                onRated={handleRatedMedia}
                inLibrary={library.some(l => l.id === selectedMedia.id)}
                profileId={activeProfileId}
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
                onStartParty={handleStartParty}
                inParty={!!party.state.code}
                seasons={detailSeasons}
                selectedSeason={detailSelectedSeason}
                onSelectSeason={setDetailSelectedSeason}
                onAddToWatchlist={profiles.length > 0 ? (m) => setAddToListMedia(m) : undefined}
                onRefreshMetadata={user.role === 'admin' ? handleRefreshMetadata : undefined}
                onIdentify={user.role === 'admin' ? handleIdentify : undefined}
                onDeleteMedia={user.role === 'admin' ? handleDeleteMedia : undefined}
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
          {view === 'search' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <SearchView query={searchQuery} onSelect={handleSelect} libraryIds={libraryIds} onToggleLib={handleToggleLib} />
            </ViewSuspense>
          )}
          {view === 'settings' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <SettingsView
                user={user}
                onLogout={handleLogout}
                onToast={addToast}
                activeProfile={profiles.find(p => p.id === activeProfileId) ?? null}
                onMaturityChange={(pref) => {
                  if (!activeProfileId) return
                  // Return the promise so SettingsView can roll back its optimistic
                  // selection on failure; re-throw after toasting so that .catch fires.
                  return setProfileMaturity(activeProfileId, pref)
                    .then(() => listProfiles())
                    .then(setProfiles)
                    .then(() => addToast('Content tone updated — your feed will re-curate', 'success'))
                    .catch((e) => { addToast('Failed to update content tone', 'error'); throw e })
                }}
                onAvatarChange={(avatarUrl) => {
                  if (!activeProfileId) return
                  return updateProfile(activeProfileId, { avatar_url: avatarUrl })
                    .then(() => listProfiles())
                    .then(setProfiles)
                    .then(() => addToast('Avatar updated', 'success'))
                    .catch((e) => { addToast('Failed to update avatar', 'error'); throw e })
                }}
                onOpenMyProfile={() => navigate(`/user/${encodeURIComponent(user.username)}`)}
              />
            </ViewSuspense>
          )}
          {view === 'member' && (() => {
            // Social phase 1 — /user/:username. The username lives in the
            // URL (parsed fresh each render, like the detail view's id);
            // the lazy view fetches its own data, so a stale username can't
            // survive a path change. pathToView only maps to 'member' when
            // the regex matches, so uname is never null here in practice —
            // the guard is for the belt-and-braces render race where view
            // lags a popstate by one frame.
            const uname = memberUsernameFromPath(location.pathname)
            return uname ? (
              <ViewSuspense fallback={<ViewFallback />}>
                {/* key: remount per username so profile A's in-flight
                    fetches (connections, follow toggle) can't write into
                    profile B's freshly-seeded state (PR-429 review). */}
                <UserProfileView
                  key={uname}
                  username={uname}
                  onSelect={handleSelect}
                  onOpenMember={(u) => navigate(`/user/${encodeURIComponent(u)}`)}
                />
              </ViewSuspense>
            ) : null
          })()}
          {view === 'members' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <MembersView
                onOpenMember={(u) => navigate(`/user/${encodeURIComponent(u)}`)}
                currentUsername={user.username}
                onToast={addToast}
              />
            </ViewSuspense>
          )}
          {view === 'collections' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <CollectionsView
                isAdmin={user.role === 'admin'}
                rewindNonce={navRewindNonce}
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
                onToggleLib={(m) => handleToggleLib({
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
                })}
              />
            </ViewSuspense>
          )}
          {/* Phase 6 — Calendar view (upcoming TV episodes). */}
          {view === 'calendar' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <CalendarView
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
            </ViewSuspense>
          )}
          {view === 'requests' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <RequestsView
                requests={requestsList}
                onRequestSubmitted={(r) => {
                  setRequestsList(prev => prev ? [r, ...prev] : [r])
                  const id = nextToastId()
                  setToasts(prev => [...prev, {
                    id,
                    message: `Requested "${r.title}"`,
                    type: 'success',
                  }])
                }}
                onRequestDeleted={(id) => {
                  setRequestsList(prev => prev ? prev.filter(r => r.id !== id) : prev)
                  const tId = nextToastId()
                  setToasts(prev => [...prev, { id: tId, message: 'Request deleted', type: 'info' }])
                }}
              />
            </ViewSuspense>
          )}
          {/* security — gate the mount on role, not just the view string.
              The sidebar link is admin-only, but typing /admin would otherwise
              mount AdminView for any signed-in user (server data is 403-backstopped,
              but the UI must not mount). A non-admin who lands here is redirected
              home by the effect below. */}
          {view === 'admin' && user.role === 'admin' && (
            <ViewSuspense fallback={<ViewFallback />}>
              <AdminView currentAdminId={user.id} />
            </ViewSuspense>
          )}
        </div>
      </main>

      {/* Video Player */}
      {/* M10 Phase 2 — real HLS player. The mock VideoPlayer that
          animated a fake currentTime is now unused (still defined
          for reference); future cleanup will remove it. */}
      {playerLoading && !playerTarget && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center">
          <div className="text-white/70 text-sm">Resolving stream…</div>
        </div>
      )}
      <VideoPlayer
        target={playerTarget}
        onEnded={handlePlaybackEnded}
        onPartyAdvance={handlePartyAdvance}
        isAdmin={user.role === 'admin'}
        onMinimizedChange={(m) => { playerMinimizedRef.current = m }}
        onSurfaceChange={setPlayerSurface}
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
          className="fixed inset-0 z-[75] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm motion-safe:animate-fade-in"
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
        onSelect={setActiveProfileId}
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

      {/* Taste onboarding ("Pick What You Love") — self-gating: renders only
          when the active/default profile is eligible and hasn't completed it.
          Existing users get prompted once at next login. */}
      <TasteOnboardingGate
        profileId={activeProfileId}
        profile={profiles.find(p => p.id === activeProfileId) ?? profiles.find(p => p.is_default) ?? profiles[0] ?? null}
        onComplete={() => window.location.reload()}
      />

      {collectionsModalOpen && (
        <CollectionsModal
          isAdmin={user.role === 'admin'}
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
        <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setAddToListMedia(null)}>
          <div role="dialog" aria-label={`Add "${addToListMedia.title}" to a watchlist`} className="w-full max-w-sm bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-5" onClick={e => e.stopPropagation()}>
            <h2 className="text-white text-lg font-semibold mb-2">Add "{addToListMedia.title}" to…</h2>
            <p className="text-white/40 text-xs mb-4">Profile: {profiles.find(p => p.id === activeProfileId)?.name}</p>
            {addToListLists === null && <p className="text-white/40 text-sm">Loading…</p>}
            {addToListLists && addToListLists.length === 0 && (
              <div className="text-white/50 text-sm mb-3">
                No watchlists yet. Create one in Settings → Profiles &amp; Watchlists first.
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
                    setAddToListMedia(null)
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
              onClick={() => setAddToListMedia(null)}
              className="w-full mt-3 py-2 text-white/60 hover:text-white text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Watch Party hub — replaces the old "type a 6-character code"
          modal. Three sections: Recently in (localStorage cache), My
          Rooms (persistent rooms via /api/rooms), Enter a code. See
          PartyHubModal.tsx for the rationale. */}
      {partyJoinPrompt && user && typeof user === 'object' && (
        <PartyHubModal
          currentUserId={user.id}
          onClose={() => setPartyJoinPrompt(false)}
          onJoin={async (joinCode) => {
            const r = await party.join(joinCode)
            if (r.ok) {
              setPartyJoinPrompt(false)
              setPartyPanelOpen(true)
            }
            return r
          }}
        />
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

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          title={contextMenu.title}
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

      {/* 2026-05-27 — Bug-report launcher. Gated on the server-side
          BUG_REPORT_ENABLED env var so a misconfigured deploy doesn't
          dangle a non-functional button.
          - prefillName uses the user's display username, NOT email,
            so a public-repo deploy doesn't leak emails into issue
            bodies that anyone with repo read access can see (deep-
            debug #7).
          - `hidden` props (was: gate on `!playerTarget`) — moved
            INTO the component so the modal stays mounted across
            player open/close events. This keeps an in-flight screen
            recording or capture from being silently aborted if a
            watch-party teleports the user into the host's player
            mid-recording (holistic deep-debug M1).
          - Component itself also hides when admin panels open
            (Server / Notifications at z-[45] cover the launcher
            on mobile — holistic deep-debug H2). */}
      {bugReportConfig?.enabled && (
        <BugReportButton
          prefillName={user.username}
          onToast={addToast}
          // 2026-05-27 (PR #107 follow-up — deep-debug H1/M1):
          // Restored serverOpen / notifOpen and added partyPanelOpen.
          // The previous PR's reasoning "panels anchor LEFT" is only
          // true on desktop — below md both panels span `left-2 right-2`
          // (full viewport width). PartyPanel is a right-edge drawer at
          // z-70 that covers the launcher on every viewport when open.
          // Hiding the launcher in these cases is the cheap, correct fix
          // — the admin can close the panel and reopen the bug-report
          // flow.
          //
          // 2026-07-25 (Aurora Stage Phase 2) — the two drawers moved
          // from bottom-anchored to top-anchored (they follow their
          // trigger, which moved to the TopNav), so on a normal viewport
          // they no longer reach the bottom-right launcher. Keeping them
          // in this list anyway: it still holds on short viewports, where
          // top + max-h-[70vh] can run into the launcher.
          hidden={!!playerTarget || serverOpen || notifOpen || partyPanelOpen}
          // 2026-05-27 — PAT health diagnostics. Server populates
          // these fields only for admin requesters; the modal shows
          // a warning banner when token_healthy === false.
          tokenHealthy={bugReportConfig.token_healthy}
          tokenHealthReason={bugReportConfig.token_health_reason}
          onRefreshConfig={refreshBugReportConfig}
        />
      )}

      {/* Toast */}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  )
}
