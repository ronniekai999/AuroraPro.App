import { getDiagnosticBuffer, redactURL } from './diagnosticBuffer'
import type { CodeInfo } from './party'

// Aurora V2 — API client.
//
// Talks to the same Go backend that powers V1 (aurora_pro.html). Reuses
// the access-token + refresh-token JWT model: token in localStorage,
// Authorization: Bearer header on every authed call, 401 triggers a
// silent refresh via /api/auth/refresh and a single retry. After two
// failures in a row we surface the auth failure to the caller.
//
// Why localStorage instead of an httpOnly cookie? V1 made that choice
// to support multi-tab + native-HLS playback (Safari can promote a
// ?token= query param from the URL but cannot read cookies cross-
// origin in the player). V2 inherits the model unchanged so it can
// share tokens with V1 during the cutover — a user who logs in via V1
// and then visits /v2/ won't have to re-auth, and vice versa.
//
// Token storage keys are intentionally identical to V1's so the same
// user is authenticated regardless of which UI they came in through.
// V1 uses `aurora_token` / `aurora_refresh` / `aurora_user` (verified
// in aurora_pro.html lines 1370-1488) AND the OAuth callback writes
// the same names (oauth_handlers.go renderSuccess). V2 reads them
// verbatim so an OAuth-signed-in user transparently has a V2 session.
const ACCESS_KEY = 'aurora_token'
const REFRESH_KEY = 'aurora_refresh'
const USER_KEY = 'aurora_user'
// Bonus alignment: V1 also writes aurora_expires_at via the OAuth
// callback. We don't currently consume it (apiFetch refreshes on 401
// rather than pre-emptively), but tracking the constant here keeps a
// future Phase 2+ work for pre-emptive refresh discoverable.
const EXPIRES_AT_KEY = 'aurora_expires_at'

export interface User {
  id: number
  username: string
  email: string
  role: 'admin' | 'user'
  avatar_url?: string
}

export interface TokenResponse {
  // deep-debug H10 — tokens now arrive as httpOnly cookies, not in the body;
  // these are optional/absent for browser auth responses.
  access_token?: string
  refresh_token?: string
  expires_in: number
  user: User
}

// Aurora's server media item — exactly what /api/media returns. Names
// match the Go json tags (snake_case) so we don't transform at decode.
export interface ServerMediaItem {
  id: number
  library_id: number
  type: 'movie' | 'show'
  title: string
  sort_title?: string
  year?: number
  overview?: string
  rating?: number
  runtime_minutes?: number
  content_rating?: string
  poster_path?: string
  backdrop_path?: string
  genres?: string[]
  has_4k?: boolean
  has_hdr?: boolean
  added_at: string
  updated_at: string
  // Populated on admin flagged-items responses; absent on /api/media
  // list responses.
  match_status?: string
  file_path?: string
  // LLM-generated per-pick reason. Populated by the recommender for
  // hero rerank picks and discover-rail items; the field is omitempty
  // on the Go side so it's absent on non-personalized responses.
  reason?: string

  // AI re-matcher fields (migration 026, internal/matching). Populated
  // on the admin /flagged endpoint when the matcher has evaluated the
  // item. All fields are omitempty on the Go side — their presence
  // signals "AI has touched this row." Distinct from a confirmed
  // match (which lives in match_status); these fields are the
  // matcher's audit trail + pending suggestion.
  //
  // - ai_suggested_tmdb_id present + ai_match_confidence ≥
  //   AI_MATCH_AUTO_THRESHOLD (default 90, configured server-side):
  //   matcher already auto-promoted via EnrichByTMDBID; the suggestion
  //   here is the audit trail.
  // - ai_suggested_tmdb_id present + confidence below threshold:
  //   sub-threshold pick awaiting human approval (one-click via the
  //   existing /api/media/{id}/match endpoint).
  // - All fields absent except ai_match_ran_at: matcher evaluated and
  //   either found no TMDB candidates or the LLM explicitly rejected
  //   (tmdb_id=0).
  ai_suggested_tmdb_id?: number
  ai_suggested_title?: string
  ai_suggested_year?: number
  ai_match_confidence?: number
  ai_match_reasoning?: string
  ai_match_ran_at?: string // ISO timestamp
}

export interface PaginatedResponse<T> {
  data: T[]
  page: number
  per_page: number
  total_items: number
  total_pages: number
}

// V2's existing UI Media type (mirrors the App.tsx interface). We keep
// this duplicated here so the API layer doesn't reach into the SPA's
// internals — the SPA imports it from this module. The shape was
// designed for the mock-data prototype; the mapper adapts Aurora's
// server response to it. Phase 1 retains the prototype shape; future
// phases may replace it with ServerMediaItem directly if there's no
// remaining mock-data path to support.
export interface UIMedia {
  id: number
  title: string
  year: number
  rating: number
  duration: string
  genre: string
  type: 'movie' | 'show' | 'anime'
  poster: string
  backdrop?: string
  description: string
  progress?: number
  cast?: string[]
  tags?: string[]
  // LLM-generated per-pick reason — populated for Discover-rail items
  // and Hero picks (recommender/discover.go:406 + hero rerank). Lets the
  // card surface "why this was picked for you" as a hover tooltip
  // without an extra fetch. Empty / undefined when the item came from
  // a non-personalized source (regular rails, search results, etc.).
  reason?: string
}

// ──────────────────────────────────────────────────────────────────
// Token storage

export function getAccessToken(): string | null {
  // deep-debug H10 — tokens now live in httpOnly cookies, unreadable from JS.
  // Returns null so legacy callers (withToken, hls xhrSetup) degrade to cookie
  // auth; auth-state checks use getStoredUser() instead of token presence.
  return null
}
export function getRefreshToken(): string | null {
  return null // deep-debug H10 — refresh token is an httpOnly cookie now
}
export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as User
  } catch {
    return null
  }
}
// ── Proactive (pre-emptive) token refresh ──────────────────────────
// The access token is a short-lived (15-minute) httpOnly cookie. With
// ONLY the reactive 401→refresh→retry path, every ~15 minutes a wave of
// in-flight requests (keepalive, progress, scan-status polls, …) all 401
// at once — the browser logs each as a red "Failed to load resource: 401"
// — before the single coalesced refresh rotates the cookie. The requests
// still succeed on retry, so it's functionally harmless, but it's noisy
// and wasteful (N failed requests + N retries per cycle). Refreshing
// shortly BEFORE expiry keeps the cookie alive so requests never lapse.
// The reactive path stays as the safety net (laptop sleep, a missed
// timer, or a failed proactive refresh all fall back to it).
let proactiveTimer: ReturnType<typeof setTimeout> | null = null
// How long before actual expiry to refresh. Comfortably larger than a
// normal request's round-trip so nothing in flight straddles expiry.
const PROACTIVE_REFRESH_SKEW_MS = 60_000
// Floor on the scheduled delay — guards against a tiny/zero expires_in
// (clock skew, misconfig) scheduling a near-instant refresh hot-loop.
const MIN_PROACTIVE_DELAY_MS = 10_000
// Per-tab stagger, chosen once at load. Multiple tabs of the same origin
// share ONE rotating refresh cookie; if their pre-emptive refreshes fired
// in lockstep they could race the cookie rotation (the loser gets a 401 +
// a spurious server "possible replay/theft" warning). A fixed per-tab
// offset keeps each tab's refreshes consistently spread apart. It only
// SUBTRACTS lead time, so the refresh still lands ≥ SKEW before expiry.
const PROACTIVE_JITTER_MS = 15_000
const tabJitterMs = Math.floor(Math.random() * PROACTIVE_JITTER_MS)

// scheduleProactiveRefresh (re)arms the single pre-emptive refresh timer
// from the access token's lifetime (seconds). Idempotent: replaces any
// pending timer. On fire it calls tryRefresh(), whose success re-stores
// the tokens and re-arms this timer for the next cycle; on failure it
// does NOT re-arm (the next request's 401 reactively refreshes and
// re-seeds), so a flaky network can't spin a refresh loop.
function scheduleProactiveRefresh(expiresInSec: number): void {
  cancelProactiveRefresh()
  if (!Number.isFinite(expiresInSec) || expiresInSec <= 0) return
  const delay = Math.max(MIN_PROACTIVE_DELAY_MS, expiresInSec * 1000 - PROACTIVE_REFRESH_SKEW_MS - tabJitterMs)
  proactiveTimer = setTimeout(() => {
    proactiveTimer = null
    void tryRefresh()
  }, delay)
}

// cancelProactiveRefresh clears any pending pre-emptive refresh (logout).
function cancelProactiveRefresh(): void {
  if (proactiveTimer !== null) {
    clearTimeout(proactiveTimer)
    proactiveTimer = null
  }
}

// Cross-tab logout: when ANOTHER tab logs out, its clearTokens() removes
// USER_KEY from localStorage, which fires a `storage` event here (storage
// events only fire in OTHER tabs, never the one that made the change).
// Cancel this tab's pending pre-emptive refresh so a backgrounded,
// now-logged-out tab doesn't later fire a stale refresh against the
// revoked/rotated cookie — harmless (a 401) but it trips the server's
// "possible replay/theft" warning log. The logging-out tab itself already
// cancels via clearTokens() → cancelProactiveRefresh().
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === USER_KEY && e.newValue === null) cancelProactiveRefresh()
  })
}

function storeTokens(t: TokenResponse) {
  // deep-debug H10 — access/refresh tokens are set as httpOnly cookies by the
  // server and are NOT in the response body; persist only the cached user for
  // an optimistic render on the next load.
  if (t.user) localStorage.setItem(USER_KEY, JSON.stringify(t.user))
  // Capture the access token's lifetime (the token itself is an httpOnly
  // cookie we can't read) so we can refresh pre-emptively. See
  // scheduleProactiveRefresh.
  if (typeof t.expires_in === 'number' && t.expires_in > 0) {
    scheduleProactiveRefresh(t.expires_in)
  }
}
export function clearTokens() {
  cancelProactiveRefresh()
  localStorage.removeItem(ACCESS_KEY)
  localStorage.removeItem(REFRESH_KEY)
  localStorage.removeItem(USER_KEY)
  // OAuth callback writes this too — clear it so V1 (which reads
  // aurora_expires_at to decide whether to pre-emptively refresh)
  // doesn't see a stale expiry after V2 logs out.
  localStorage.removeItem(EXPIRES_AT_KEY)
}

// ──────────────────────────────────────────────────────────────────
// Image URL helpers (mirrors V1's imgPath + /api/images/w500/...)

function imgPath(p?: string): string {
  if (!p) return ''
  // V1 strips leading slashes so we don't end up with /api/images/w500//foo.jpg
  return p.replace(/^\/+/, '')
}
// Phase 5.3 final QA — size union widened to match the actual
// server proxy whitelist (internal/metadata/imageproxy.go:77).
// The previous 'w200' was an invented value that 404'd on the
// server, silently breaking the cast row avatars. Real TMDB sizes:
// w92, w154, w185 (TMDB profile standard), w342, w500 (default),
// w780, original.
export function posterURL(
  p?: string,
  size: 'w92' | 'w154' | 'w185' | 'w342' | 'w500' | 'w780' | 'original' = 'w500',
): string {
  const cleaned = imgPath(p)
  if (!cleaned) return ''
  return `/api/images/${size}/${cleaned}`
}
export function backdropURL(p?: string): string {
  const cleaned = imgPath(p)
  if (!cleaned) return ''
  return `/api/images/original/${cleaned}`
}

// ──────────────────────────────────────────────────────────────────
// Core fetch with auto-refresh on 401

class APIError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

// Exported for components that need to proactively refresh the
// access token (e.g. the HLS player, which has long-running XHRs
// outside of apiFetch's 401-retry path). Audit H2 fix.
export async function forceTokenRefresh(): Promise<boolean> {
  return tryRefresh()
}

let refreshInFlight: Promise<boolean> | null = null

// Audit H4 — bound the refresh request so a slow/hung server doesn't
// stall every queued API call indefinitely. 15s is generous (Aurora's
// /api/auth/refresh is normally <50ms); anything longer means the
// server is unreachable and the user should see auth failure rather
// than a spinner that never resolves.
const REFRESH_TIMEOUT_MS = 15000

// Public refresh wrapper for callers that don't go through apiFetch — e.g.
// the watch-party WS reconnect loop in useParty.tsx, which can't rely on
// apiFetch's 401-retry path because the JWT is in the URL (?token=...)
// and a stale token gets rejected at the WS upgrade. Returns true on
// successful refresh + token store, false otherwise. Safe to call
// concurrently; coalesces with in-flight apiFetch refreshes via the
// same `refreshInFlight` promise.
export async function refreshAccessToken(): Promise<boolean> {
  return tryRefresh()
}

async function tryRefresh(): Promise<boolean> {
  // Coalesce simultaneous refresh attempts so a wave of parallel 401s
  // triggers exactly one refresh call. Subsequent callers await the
  // same promise and reuse its result.
  if (refreshInFlight) return refreshInFlight

  // Build the promise first, install it into refreshInFlight, then
  // chain a `.finally` that clears the flag AFTER all awaiters have
  // consumed the resolved value (microtask order). The old code used
  // setTimeout(0) which is a macrotask, scheduled AFTER awaiter
  // microtasks — meaning awaiters could fire their retries before
  // the flag cleared, which was the intent — but it also meant a
  // hung refresh would leave the flag set forever, blocking all
  // future refreshes for this tab.
  const ac = new AbortController()
  const timeoutId = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS)
  const p = (async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        // deep-debug H10 — the refresh token rides the httpOnly cookie; send
        // credentials and no body. The server rotates the cookies in its reply.
        credentials: 'same-origin',
        signal: ac.signal,
      })
      if (!res.ok) return false
      const tokens = (await res.json()) as TokenResponse
      storeTokens(tokens)
      return true
    } catch {
      // AbortError (timeout) or network error both count as failure.
      // Callers will surface the original 401 to the user.
      return false
    } finally {
      clearTimeout(timeoutId)
    }
  })()
  refreshInFlight = p
  // Clear the in-flight slot ONCE this refresh settles. `.finally`
  // returns a new promise that won't be awaited (we never use the
  // return value), but Node/browsers schedule it as a microtask.
  // This runs AFTER any `await tryRefresh()` chains have already
  // received the boolean and started their retries — which is
  // exactly what we want: retries reuse the same refresh, but a
  // truly-NEW request after this all settles can trigger a fresh
  // refresh attempt.
  void p.finally(() => { refreshInFlight = null })
  return p
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface FetchOpts {
  method?: HttpMethod
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

interface FetchResponseOpts {
  method?: HttpMethod
  body?: BodyInit | null
  headers?: Record<string, string>
  signal?: AbortSignal
}

export async function apiFetchResponse(path: string, opts: FetchResponseOpts = {}): Promise<Response> {
  const doRequest = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...opts.headers,
    }
    // deep-debug H10 — auth rides the httpOnly access cookie (same-origin
    // credentials below); no Authorization header is set from JS.
    return fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ?? undefined,
      signal: opts.signal,
      credentials: 'same-origin',
    })
  }

  let res = await doRequest()
  if (res.status === 401) {
    const refreshed = await tryRefresh()
    if (refreshed) {
      res = await doRequest()
    }
  }
  return res
}

export async function apiFetch<T = unknown>(path: string, opts: FetchOpts = {}): Promise<T> {
  const hasBody = opts.body !== undefined && opts.body !== null
  const res = await apiFetchResponse(path, {
    method: opts.method,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    signal: opts.signal,
  })

  const ct = res.headers.get('content-type') || ''
  const parseBody = async (): Promise<unknown> => {
    if (ct.includes('application/json')) {
      try { return await res.json() } catch { return null }
    }
    return await res.text()
  }

  if (!res.ok) {
    const body = await parseBody()
    // Aurora's server WriteError emits a NESTED shape:
    //   { error: { code: 400, message: "path does not exist: ..." } }
    // Earlier handlers used the FLAT shape:
    //   { error: "path does not exist: ..." }
    // Support both — without this, the nested shape falls through
    // to a generic "HTTP 400" alert and the user never sees the
    // actual diagnostic (which is what just happened on the
    // library-create form during a 2026-05-18 install).
    let message = `HTTP ${res.status}`
    if (body && typeof body === 'object' && 'error' in body) {
      const errField = (body as Record<string, unknown>).error
      if (typeof errField === 'string') {
        message = errField
      } else if (errField && typeof errField === 'object' && 'message' in errField) {
        const nested = (errField as Record<string, unknown>).message
        if (typeof nested === 'string') message = nested
      }
    }
    throw new APIError(res.status, message, body)
  }
  return (await parseBody()) as T
}

// ──────────────────────────────────────────────────────────────────
// Mapper: ServerMediaItem → V2 UIMedia

function formatDuration(min?: number): string {
  if (!min || min <= 0) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

export function mapMedia(item: ServerMediaItem): UIMedia {
  return {
    id: item.id,
    title: item.title,
    year: item.year || 0,
    rating: item.rating || 0,
    duration: formatDuration(item.runtime_minutes),
    genre: (item.genres && item.genres[0]) || '',
    type: item.type === 'show' ? 'show' : 'movie',
    poster: posterURL(item.poster_path),
    backdrop: backdropURL(item.backdrop_path),
    description: item.overview || '',
    tags: [
      ...(item.has_4k ? ['4K'] : []),
      ...(item.has_hdr ? ['HDR'] : []),
      ...(item.content_rating ? [item.content_rating] : []),
    ],
    // Carry the LLM-generated reason through to the UI layer. For
    // non-personalized endpoints (listMedia, search, etc.) the field
    // is absent on the server response and the spread leaves it
    // undefined here — MediaCard hides the hover hint accordingly.
    reason: item.reason,
  }
}

// ──────────────────────────────────────────────────────────────────
// Endpoints

export async function login(username: string, password: string): Promise<User> {
  const tokens = await apiFetch<TokenResponse>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  storeTokens(tokens)
  return tokens.user
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' })
  } catch {
    // Logout best-effort — even if the server rejects (already-expired
    // token, network blip), clear local tokens so the user lands on
    // the auth screen on next refresh.
  } finally {
    clearTokens()
  }
}

// Fetch + map. Caller controls type filter (movie/show) and limit.
export async function listMedia(opts: {
  type?: 'movie' | 'show'
  perPage?: number
  sortBy?: 'recent' | 'rating' | 'title' | 'year'
  genre?: string
  signal?: AbortSignal
} = {}): Promise<UIMedia[]> {
  const params = new URLSearchParams()
  if (opts.type) params.set('type', opts.type)
  if (opts.perPage) params.set('per_page', String(opts.perPage))
  if (opts.sortBy) params.set('sort_by', opts.sortBy)
  if (opts.genre) params.set('genre', opts.genre)
  const qs = params.toString()
  const path = qs ? `/api/media?${qs}` : '/api/media'
  const resp = await apiFetch<PaginatedResponse<ServerMediaItem>>(path, { signal: opts.signal })
  return (resp.data || []).map(mapMedia)
}

// Phase 5.3 final QA — variant of listMedia that surfaces the
// server's total_items count alongside the page of items. Used by
// BrowseView so the header can show the real catalog size ("Showing
// 100 of 2,394") instead of misleadingly claiming the page-size is
// the whole library. The simple `listMedia` is kept for callers
// (home rails, etc.) that only need items.
//
// `genre` is server-side. Threaded to the API as `?genre=...` so the
// total reflects the *filtered* catalog count, not "filtered subset of
// the loaded page" — which was the original BrowseView bug where
// Horror+Top-Rated and Horror+A-Z returned different counts depending
// on what subset of the catalog had been paginated in.
export async function listMediaWithTotal(opts: {
  type?: 'movie' | 'show'
  perPage?: number
  page?: number
  sortBy?: 'recent' | 'rating' | 'title' | 'year'
  genre?: string
  signal?: AbortSignal
} = {}): Promise<{ items: UIMedia[]; total: number; page: number; perPage: number; totalPages: number }> {
  const params = new URLSearchParams()
  if (opts.type) params.set('type', opts.type)
  if (opts.perPage) params.set('per_page', String(opts.perPage))
  if (opts.page) params.set('page', String(opts.page))
  if (opts.sortBy) params.set('sort_by', opts.sortBy)
  if (opts.genre) params.set('genre', opts.genre)
  const qs = params.toString()
  const path = qs ? `/api/media?${qs}` : '/api/media'
  const resp = await apiFetch<PaginatedResponse<ServerMediaItem>>(path, { signal: opts.signal })
  return {
    items: (resp.data || []).map(mapMedia),
    total: resp.total_items || 0,
    page: resp.page || 1,
    perPage: resp.per_page || 0,
    totalPages: resp.total_pages || 1,
  }
}

// listGenres returns the canonical list of genre names present in the
// library, optionally narrowed to a single media type. Used by the
// BrowseView dropdown so the genre set is stable across pagination
// and sort changes — building the dropdown from `items.map(i => i.genre)`
// only reflects the subset visible on the current page, which is the
// root cause of the inconsistent genre-filter bug.
export async function listGenres(type?: 'movie' | 'show', signal?: AbortSignal): Promise<string[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : ''
  const resp = await apiFetch<{ genres: string[] }>(`/api/media/genres${qs}`, { signal })
  return resp.genres || []
}

// Search the media library. Aurora has both a literal/trigram path
// (fast, exact title matching) and a semantic/LLM path (vibe queries
// like "movies with that one-night-only feel"). The server auto-
// routes based on heuristics. The response header X-Search-Mode is
// `literal` or `semantic` — surfaced to the caller so the UI can
// render a "✨ Smart search" badge only when LLM was actually used
// (V2's static "Smart" badge on every search was a lie).
export interface SearchResult {
  items: UIMedia[]
  mode: 'literal' | 'semantic'
}
export async function searchMedia(
  query: string,
  limit = 30,
  signal?: AbortSignal,
): Promise<SearchResult> {
  if (!query.trim()) return { items: [], mode: 'literal' }
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  const res = await apiFetchResponse(`/api/media/search?${params.toString()}`, {
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const items = (await res.json()) as ServerMediaItem[]
  const modeHeader = res.headers.get('X-Search-Mode') || 'literal'
  return {
    items: (items || []).map(mapMedia),
    mode: modeHeader === 'semantic' ? 'semantic' : 'literal',
  }
}

// Phase 5.3 — personalized hero. Returns 4-8 picks from the
// recommender; client rotates through them with crossfade like V1.
// Each pick has `reason` explaining WHY ("Because you finished
// Severance"). 503 when LLM/recommender isn't configured —
// callers should fall back to listRecent's first item.
export interface HeroPick {
  media: UIMedia
  reason?: string
  // Global Aurora Score (0-100): how feature-worthy the title is, the same for
  // everyone. The hero ring shows this when there's no personal match.
  score?: number
  // Personal "% for you" (0-100) from the recommender's taste-vector
  // similarity. Undefined / 0 for the cold-start popular pool (no centroid),
  // in which case the ring shows `score` (or a derived estimate as a last resort).
  match?: number
}
export interface HeroPersonalization {
  coldStart: boolean
  historyCount: number
  threshold: number
}
export interface HeroPoolResponse {
  picks: HeroPick[]
  personalization: HeroPersonalization
}
export async function getHeroPool(
  refresh = false,
  profileId?: number,
  signal?: AbortSignal,
): Promise<HeroPoolResponse> {
  const params = new URLSearchParams()
  if (refresh) params.set('refresh', '1')
  if (profileId) params.set('profile_id', String(profileId))
  const qs = params.toString()
  const resp = await apiFetch<{
    picks: { item: ServerMediaItem; reason?: string; score?: number; match?: number }[],
    personalization?: { cold_start?: boolean; history_count?: number; threshold?: number },
  }>(
    qs ? `/api/me/hero?${qs}` : '/api/me/hero', { signal },
  )
  return {
    picks: (resp.picks || []).map(p => ({ media: mapMedia(p.item), reason: p.reason, score: p.score, match: p.match })),
    // Defaults preserve the pre-personalization-field behavior for any
    // server older than this change (cold_start=false hides the hint).
    personalization: {
      coldStart:    resp.personalization?.cold_start ?? false,
      historyCount: resp.personalization?.history_count ?? 0,
      threshold:    resp.personalization?.threshold ?? 3,
    },
  }
}

// Phase 5.3 — LLM-curated Discover rails. Returns up to ~6 themed
// shelves like "Slow-burn neo-noir" or "Animated coming-of-age" with
// 5-10 items each. Server caches 24h per profile; the 503 fallback
// to recent/top-rated lives client-side (we just return an empty
// list so the home view skips rendering this section).
//
// Response shape: `{rails: [{title, items: [ServerMediaItem...]}, ...]}`
// (mirrors internal/api/hero_handlers.go DiscoverRail).
export interface DiscoverRailUI {
  title: string
  // LLM's one-sentence theme line (≤100 chars). Optional — empty when the
  // model omitted it; the home renderer falls back to a generic subtitle.
  description?: string
  items: UIMedia[]
}
export async function getDiscoverRails(
  profileId?: number,
  signal?: AbortSignal,
): Promise<DiscoverRailUI[]> {
  const params = new URLSearchParams()
  if (profileId) params.set('profile_id', String(profileId))
  const qs = params.toString()
  type Raw = { rails?: { title: string; description?: string; items?: ServerMediaItem[] }[] }
  const resp = await apiFetch<Raw>(
    qs ? `/api/me/discover?${qs}` : '/api/me/discover', { signal },
  )
  return (resp.rails || []).map(r => ({
    title: r.title,
    description: r.description,
    items: (r.items || []).map(mapMedia),
  }))
}

// Phase 5.3 — "Because You Watched X" anchor rails. Fast vector
// retrieval, no LLM — sub-300ms. Returns up to 3 rails pinned to
// the user's most-watched recent anchors. Cold-start (no embedded
// watched items) returns an empty list.
//
// Response shape: `{rails: [{anchor: {title,year,type}, items: [...]}, ...]}`
export interface AnchorRailUI {
  // Pre-formatted "Because you watched <title>" label so the
  // home renderer doesn't need to know about the AnchorRef shape.
  title: string
  items: UIMedia[]
}
export async function getAnchorRails(
  profileId?: number,
  signal?: AbortSignal,
): Promise<AnchorRailUI[]> {
  const params = new URLSearchParams()
  if (profileId) params.set('profile_id', String(profileId))
  const qs = params.toString()
  type AnchorRefShape = { title: string; year?: number; type: string }
  type Raw = { rails?: { anchor?: AnchorRefShape; items?: ServerMediaItem[] }[] }
  const resp = await apiFetch<Raw>(
    qs ? `/api/me/anchor-rails?${qs}` : '/api/me/anchor-rails', { signal },
  )
  // Audit M3 (Phase 5.3 final QA) — also require a non-blank
  // anchor.title. Server `AnchorRef.Title` has no omitempty so an
  // empty string is emitted on data-quality glitches; without the
  // trim() check the home would render a rail titled "Because you
  // watched " with a trailing space.
  return (resp.rails || [])
    .filter(r => r.anchor && r.anchor.title && r.anchor.title.trim().length > 0
                 && r.items && r.items.length > 0)
    .map(r => ({
      title: `Because you watched ${r.anchor!.title.trim()}`,
      items: (r.items || []).map(mapMedia),
    }))
}

// Phase C — proprietary engagement-driven rails (Trending Now / Hidden Gems /
// Finish It Tonight / Comfort Rewatch). No LLM — pure first-party engagement
// signals, so fast and resilient when the Cloud LLM is down. Each rail has a
// fixed title + a one-line description rendered as the rail subtitle.
//
// Response shape: `{rails: [{title, description, items: [...]}, ...]}`
export interface EngagementRailUI {
  title: string
  description?: string
  items: UIMedia[]
}
export async function getEngagementRails(
  profileId?: number,
  signal?: AbortSignal,
): Promise<EngagementRailUI[]> {
  const params = new URLSearchParams()
  if (profileId) params.set('profile_id', String(profileId))
  const qs = params.toString()
  type Raw = { rails?: { title: string; description?: string; items?: ServerMediaItem[] }[] }
  const resp = await apiFetch<Raw>(
    qs ? `/api/me/engagement-rails?${qs}` : '/api/me/engagement-rails', { signal },
  )
  return (resp.rails || []).map(r => ({
    title: r.title,
    description: r.description,
    items: (r.items || []).map(mapMedia),
  }))
}

// Manual-match search: TMDB + optionally TVDB.
//
// Audit H1 (Phase 5.3 audit-8) — full rewrite. Server contract:
//   - For movies: returns *TMDBSearchResult shape:
//     `{page, total_results, total_pages, results: [TMDBMovieTV]}`
//   - For shows + TVDB enabled: returns `{tmdb: TMDBSearchResult, tvdb: [TVDBSearchResult]}`
//   - For shows + TVDB disabled: returns *TMDBSearchResult
//   - Server reads `?type=` (NOT `?media_type=`).
// TMDBMovieTV uses `title` for movies, `name` for TV; date is
// `release_date` (movies) / `first_air_date` (TV). TVDBSearchResult
// has `tvdb_id` (string!), `name`, `year` (string), `image_url`
// (full URL). Client normalizes to MatchSearchResult.
export interface MatchSearchResult {
  source: 'tmdb' | 'tvdb'
  id: number
  title: string
  year?: number
  // Poster URL — for TMDB this is a relative path (use
  // tmdbPosterURL helper); for TVDB it's a full URL (use directly).
  // Renderer must check `source` to decide.
  poster_path?: string
  overview?: string
}
interface TmdbMovieTV {
  id: number
  title?: string
  name?: string
  overview?: string
  release_date?: string
  first_air_date?: string
  poster_path?: string | null
}
interface TmdbSearchResponse {
  page: number
  total_results?: number
  total_pages?: number
  results: TmdbMovieTV[]
}
interface TvdbSearchRaw {
  tvdb_id: string
  name: string
  overview?: string
  year?: string
  image_url?: string
}
function normalizeTmdb(items: TmdbMovieTV[]): MatchSearchResult[] {
  return (items || []).map(it => {
    const date = it.release_date || it.first_air_date || ''
    const year = date ? parseInt(date.slice(0, 4), 10) : undefined
    return {
      source: 'tmdb' as const,
      id: it.id,
      title: it.title || it.name || '(no title)',
      year: year && !isNaN(year) ? year : undefined,
      poster_path: it.poster_path || undefined,
      overview: it.overview,
    }
  })
}
function normalizeTvdb(items: TvdbSearchRaw[]): MatchSearchResult[] {
  return (items || []).map(it => {
    const id = parseInt(it.tvdb_id, 10)
    const year = it.year ? parseInt(it.year.slice(0, 4), 10) : undefined
    return {
      source: 'tvdb' as const,
      id: isNaN(id) ? 0 : id,
      title: it.name || '(no title)',
      year: year && !isNaN(year) ? year : undefined,
      poster_path: it.image_url || undefined, // full URL, render directly
      overview: it.overview,
    }
  }).filter(r => r.id > 0)
}
export async function searchForMatch(
  query: string,
  mediaType: 'movie' | 'show',
  signal?: AbortSignal,
): Promise<MatchSearchResult[]> {
  if (!query.trim()) return []
  // Server reads `?type=show|movie|multi` (NOT media_type).
  const params = new URLSearchParams({ q: query, type: mediaType === 'show' ? 'show' : 'movie' })
  type Raw = TmdbSearchResponse | { tmdb: TmdbSearchResponse; tvdb: TvdbSearchRaw[] }
  const r = await apiFetch<Raw>(`/api/tmdb/search?${params.toString()}`, { signal })
  if ('tmdb' in r) {
    return [...normalizeTmdb(r.tmdb.results), ...normalizeTvdb(r.tvdb)]
  }
  return normalizeTmdb(r.results)
}
export async function manualMatch(
  mediaItemId: number,
  body: { tmdb_id?: number; tvdb_id?: number; type: 'movie' | 'show' },
): Promise<void> {
  await apiFetch(`/api/media/${mediaItemId}/match`, { method: 'POST', body })
}

// Phase 5.3 — scan status. Mirrors `models.ScanProgress` exactly.
// Audit H2 (Phase 5.3 audit-8): the original interface invented
// `state`, `progress`, `processed`, `total` — none of which the
// server emits. Real field names are `status`, `total_files`,
// `scanned_files`. Without this fix the scan bar was dead code
// (filter never matched).
export type ScanStatusName = 'idle' | 'running' | 'complete' | 'failed'
export interface ScanStatus {
  library_id: number
  status: ScanStatusName
  total_files: number
  scanned_files: number
  new_files: number
  current_file?: string
  started_at?: string
  error?: string
}
export async function getScanStatus(libraryId: number, signal?: AbortSignal): Promise<ScanStatus> {
  return apiFetch<ScanStatus>(`/api/libraries/${libraryId}/scan/status`, { signal })
}

export async function listRecent(perPage = 12, signal?: AbortSignal): Promise<UIMedia[]> {
  const resp = await apiFetch<PaginatedResponse<ServerMediaItem> | ServerMediaItem[]>(
    `/api/media/recent?per_page=${perPage}`, { signal }
  )
  // /api/media/recent shape: some routes return a paginated envelope,
  // some return a bare array. Handle both so we don't break if the
  // server-side shape gets harmonized later.
  const items = Array.isArray(resp) ? resp : (resp.data || [])
  return items.map(mapMedia)
}

// Check whether we have a valid session right now. Used on app boot.
// /api/auth/me returns the current user if the access token is valid
// (or a refresh succeeds inside apiFetch's 401 handler); otherwise it
// throws.
export async function fetchMe(signal?: AbortSignal): Promise<User> {
  const user = await apiFetch<User>('/api/auth/me', { signal })
  // Cold page-load seed. /api/auth/me validates the existing access
  // cookie but doesn't reveal when it expires, so storeTokens never ran
  // and no pre-emptive refresh is armed — leaving the FIRST ~15-minute
  // expiry after a page load to fail reactively (one 401 burst). If
  // nothing is scheduled yet, kick off ONE refresh to learn expires_in
  // and arm the timer; thereafter it self-perpetuates. tryRefresh()
  // single-flights, so concurrent fetchMe calls coalesce to one refresh;
  // the guard skips re-seeding once a timer exists (e.g. when /api/auth/me
  // itself already triggered a reactive refresh because the access cookie
  // had lapsed). Fire-and-forget so it adds no latency to the auth check;
  // an unauthenticated /api/auth/me throws above and never reaches here.
  if (proactiveTimer === null) {
    void tryRefresh()
  }
  return user
}

// ──────────────────────────────────────────────────────────────────
// Media detail / episodes / files (Phase 2)

// Sparse representation of an Aurora media file — just the fields V2
// currently consumes. The full model has codec/track metadata that
// the V2 player surfaces only after /api/stream/info resolves; that
// avoids duplicating the codec-decision logic on the client.
//
// Phase 5.3 final QA — added audio_tracks/subtitle_tracks so the
// Media Info section on detail view can render them (V1 parity).
export interface AudioTrack {
  index?: number
  codec: string
  channels?: number
  language?: string
  title?: string
  is_default?: boolean
}
export interface SubtitleTrack {
  index?: number
  codec: string
  language?: string
  title?: string
  forced?: boolean
  default?: boolean
  bitmap?: boolean
}
export interface MediaFile {
  id: number
  media_item_id: number
  container?: string
  video_codec?: string
  audio_codec?: string
  resolution?: string
  version_tag?: string
  // ffprobe color metadata — drives the HDR quality chip.
  // color_transfer: 'smpte2084' (PQ/HDR10) | 'arib-std-b67' (HLG) | 'bt709' (SDR)
  color_transfer?: string
  color_primaries?: string
  bitrate?: number
  duration_ms?: number
  size_bytes?: number
  library_name?: string
  audio_tracks?: AudioTrack[]
  subtitle_tracks?: SubtitleTrack[]
}

export interface EpisodeFile {
  id: number
  episode_id: number
  container?: string
  video_codec?: string
  audio_codec?: string
  resolution?: string
  version_tag?: string
  color_transfer?: string
  color_primaries?: string
  duration_ms?: number
  library_name?: string
  audio_tracks?: AudioTrack[]
  subtitle_tracks?: SubtitleTrack[]
}

// Per-episode watch progress (mirrors models.WatchProgress). episode_id
// is set for episodes; absent for movie-level progress.
export interface WatchProgress {
  position_ms: number
  duration_ms: number
  completed?: boolean
  episode_id?: number
}

// /api/media/{id}/seasons/{n}/episodes returns models.EpisodeDetail
// which embeds Episode + still_path/still_url/files/progress. The
// `still_url` field is server-pre-rendered (TMDB image-proxy URL).
export interface Episode {
  id: number
  season_id: number
  media_item_id: number
  episode_number: number
  title?: string
  overview?: string
  runtime_minutes?: number
  air_date?: string
  still_path?: string
  still_url?: string
  files?: EpisodeFile[]
  // Populated by GetEpisodes (phase2_handlers.go) when authed — drives
  // the episode list's watched / in-progress states.
  progress?: WatchProgress
}

export interface Season {
  id: number
  media_item_id: number
  season_number: number
  title?: string
  overview?: string
  episode_count?: number
}

// /api/media/{id} returns models.MediaItemEnriched — same shape as
// ServerMediaItem plus the rich-detail fields below. We expose only
// the ones V2 actually renders.
export interface CastMember {
  id: number
  name: string
  profile_path?: string
  role_type: string // 'cast', 'director', 'writer', 'producer', 'creator'
  character?: string
  display_order?: number
}
export interface MediaDetail extends ServerMediaItem {
  tmdb_id?: number
  imdb_id?: string
  tagline?: string
  poster_url?: string
  backdrop_url?: string
  cast?: CastMember[]
  season_count?: number
  episode_count?: number
  files?: MediaFile[]
  // Populated by the enricher (migration 032) — shown on the Details card.
  studio?: string // first production company (movies)
  network?: string // first network (TV)
  release_date?: string // ISO "YYYY-MM-DD" (movie release / TV first-air)
  // YouTube video id for the "Watch Trailer" button (migration 034). Absent or
  // empty = no trailer (button hidden). Populated by the enricher, or lazily on
  // first detail view for items enriched before trailer support.
  trailer_key?: string
}

export async function getMedia(id: number, signal?: AbortSignal): Promise<MediaDetail> {
  return apiFetch<MediaDetail>(`/api/media/${id}`, { signal })
}

export async function getMediaFiles(id: number, signal?: AbortSignal): Promise<MediaFile[]> {
  // V1's getMediaFiles wraps the throw in a try/catch and returns
  // an empty array. We don't — the caller can decide. The endpoint
  // returns 404 only if the media doesn't exist; for an empty-files
  // case it returns []. So a throw IS a real error worth surfacing.
  return apiFetch<MediaFile[]>(`/api/media/${id}/files`, { signal })
}

export async function getSeasons(id: number, signal?: AbortSignal): Promise<Season[]> {
  return apiFetch<Season[]>(`/api/media/${id}/seasons`, { signal })
}

export async function getEpisodes(
  mediaId: number,
  seasonNumber: number,
  signal?: AbortSignal,
): Promise<Episode[]> {
  return apiFetch<Episode[]>(
    `/api/media/${mediaId}/seasons/${seasonNumber}/episodes`,
    { signal },
  )
}

// ──────────────────────────────────────────────────────────────────
// Progress reporting (Phase 2)

export interface ProgressUpdate {
  position_ms: number
  duration_ms: number
  episode_id?: number
}

// Phase 5.2 parity — context-menu actions on media cards.
// Phase 6 — returns the full achievement defs (not just keys) so
// the caller can render a toast with icon + title without a second
// roundtrip. Audit M5 fix.
export interface MarkWatchedResult {
  message?: string
  achievements_unlocked?: AchievementDef[]
}
export async function markWatched(mediaItemId: number): Promise<MarkWatchedResult> {
  return apiFetch<MarkWatchedResult>(`/api/progress/${mediaItemId}/watched`, {
    method: 'POST',
    body: {},
  })
}
export async function clearProgress(mediaItemId: number): Promise<void> {
  await apiFetch(`/api/progress/${mediaItemId}`, { method: 'DELETE' })
}
export async function deleteRequest(id: number): Promise<void> {
  await apiFetch(`/api/requests/${id}`, { method: 'DELETE' })
}
export async function deleteUser(id: number): Promise<void> {
  await apiFetch(`/api/users/${id}`, { method: 'DELETE' })
}

export async function reportProgress(
  mediaItemId: number,
  body: ProgressUpdate,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch(`/api/progress/${mediaItemId}`, {
    method: 'PUT',
    body,
    signal,
  })
}

// ──────────────────────────────────────────────────────────────────
// Admin endpoints (Phase 3)

export interface ServerStats {
  version: string
  uptime: string
  memory_alloc_mb: number
  goroutines: number
  cpu_cores: number
  disk_free_gb: number
  active_streams: number
  websocket_clients: number
  library_count: number
  movie_count: number
  show_count: number
  episode_count: number
  user_count: number
  total_file_size_bytes: number
  pending_requests: number
  active_parties: number
}

export interface ActivityEntry {
  id: number
  user_id?: number
  profile_id?: number
  event_type: string
  details?: Record<string, unknown>
  ip_address?: string
  created_at: string
  username?: string
}

export interface LogEntry {
  time: string
  level: string
  message: string
  attrs?: Record<string, unknown>
}

export interface AdminUser {
  id: number
  username: string
  email: string
  role: 'admin' | 'user'
  avatar_url?: string
  created_at: string
  updated_at: string
  oauth_provider?: string
  // Absent (omitempty server-side) for users who haven't signed in since the
  // column was added — rendered as "Never". Bumped on login/OAuth/register.
  last_login_at?: string
}

export async function getAdminDashboard(signal?: AbortSignal): Promise<ServerStats> {
  return apiFetch<ServerStats>('/api/admin/dashboard', { signal })
}

// Embedding coverage for the admin dashboard. embedded/total count media_items
// (movies + shows; episodes aren't embedded). `enabled` is false when the
// LLM/Ollama embedder isn't configured.
export interface EmbeddingStatus {
  enabled: boolean
  version: number
  total: number
  embedded: number
  pending: number
}

export async function getEmbeddingStatus(signal?: AbortSignal): Promise<EmbeddingStatus> {
  return apiFetch<EmbeddingStatus>('/api/admin/embedding-status', { signal })
}

export async function listAdminActivity(
  perPage = 50,
  signal?: AbortSignal,
): Promise<ActivityEntry[]> {
  const resp = await apiFetch<PaginatedResponse<ActivityEntry> | ActivityEntry[]>(
    `/api/admin/activity?per_page=${perPage}`,
    { signal },
  )
  // /api/admin/activity returns a paginated envelope. Defensive
  // unwrap because the endpoint's response shape has drifted across
  // versions in Aurora's history (the M9 audit logged it).
  return Array.isArray(resp) ? resp : (resp.data || [])
}

export async function listAdminLogs(signal?: AbortSignal): Promise<LogEntry[]> {
  const resp = await apiFetch<LogEntry[]>('/api/admin/logs', { signal })
  return resp || []
}

// Phase 4.6 — admin: libraries CRUD + scan + stream sessions +
// flagged items + LLM/OAuth config. All read-mostly; the CUD
// endpoints are admin-gated server-side already.

export interface Library {
  id: number
  name: string
  type: 'movie' | 'show'
  paths: string[]
  scan_interval_minutes: number
  owner_id: number
  created_at: string
  updated_at: string
}
export async function listLibraries(signal?: AbortSignal): Promise<Library[]> {
  const res = await apiFetch<Library[]>('/api/libraries', { signal })
  return res || []
}
export async function createLibrary(
  body: { name: string; type: 'movie' | 'show'; paths: string[] },
): Promise<Library> {
  return apiFetch<Library>('/api/libraries', { method: 'POST', body })
}
export async function deleteLibrary(id: number): Promise<void> {
  await apiFetch(`/api/libraries/${id}`, { method: 'DELETE' })
}
export async function scanLibrary(id: number): Promise<void> {
  await apiFetch(`/api/libraries/${id}/scan`, { method: 'POST' })
}

// Unified Active Streams row. Transcode-backed and direct-play-backed
// streams arrive on the same array tagged with `kind` so the admin
// Sessions tab can render them together. Fields that don't apply to
// a row's kind are omitted by the server.
export interface ActiveStreamRow {
  id: string
  kind: 'transcode' | 'direct'
  user_id: number
  username?: string
  file_name: string
  started_at: string
  // Transcode-only
  resolution?: string
  active_variants?: string[]
  resources?: {
    cpu_ticks?: number
    memory_bytes?: number
    num_processes?: number
    bandwidth_bps?: number
  }
  remux?: boolean
  // Direct-play only
  file_type?: 'media' | 'episode'
  file_id?: number
  decision?: 'direct_play' | 'direct_stream'
}

// Back-compat alias — old callers expecting a TranscodeSession-shaped
// row keep working against the union type. New code should use
// ActiveStreamRow directly.
export type TranscodeSession = ActiveStreamRow

export async function listAdminSessions(signal?: AbortSignal): Promise<ActiveStreamRow[]> {
  const res = await apiFetch<ActiveStreamRow[]>('/api/admin/sessions', { signal })
  return res || []
}
export async function deleteStreamSession(id: string): Promise<void> {
  await apiFetch(`/api/stream/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// Admin-only — returns FFmpeg-side state for a transcode session
// including the stderr tail. Use to debug "variant start failed"
// 500s without needing server log access.
export interface VariantDiagnostic {
  profile: string
  started: boolean
  exited: boolean
  output_dir?: string
  error?: string
  stderr_tail?: string
  restart_attempts?: number
}
export interface SessionDiagnostic {
  session_id: string
  file_path: string
  source_video_codec?: string
  hw_accel: string
  remux: boolean
  variants: VariantDiagnostic[]
}
export async function diagnoseSession(id: string, signal?: AbortSignal): Promise<SessionDiagnostic> {
  return apiFetch<SessionDiagnostic>(`/api/admin/sessions/${encodeURIComponent(id)}/diagnose`, { signal })
}

// AI re-matcher backfill controls (migration 026, internal/matching).
// Status returns the current/last job's progress; start kicks off a
// new sweep over items where ai_match_ran_at IS NULL. Both endpoints
// require admin auth (gated server-side via the /api/admin route group).
export interface AIRematchJobStatus {
  job_id?: string
  started_at: string
  finished_at?: string  // zero-time "0001-01-01..." while still running
  total: number
  processed: number
  matched: number       // count auto-promoted
  suggested: number     // count with sub-threshold suggestion stored
  failed: number
  // Retry-pass counters (server-side: backfill scans rows where AI
  // confidence ≥ threshold but match_status is still 'needs_review' and
  // re-attempts EnrichByTMDBID). retried = items touched in retry pass;
  // retry_matched = items that promoted on retry. Difference = items
  // where TMDB is still failing (likely permanent — operator handles).
  // omitempty on the Go side, so both fields can be absent on a job
  // that ran before the retry-pass feature shipped.
  retried?: number
  retry_matched?: number
  cancelled?: boolean
}
export interface AIRematchStatusResponse {
  enabled: boolean
  job?: AIRematchJobStatus
}
export async function getAIRematchStatus(signal?: AbortSignal): Promise<AIRematchStatusResponse> {
  return apiFetch<AIRematchStatusResponse>('/api/admin/flagged/ai-rematch/status', { signal })
}
export async function startAIRematch(): Promise<{ job_id: string }> {
  return apiFetch<{ job_id: string }>('/api/admin/flagged/ai-rematch', { method: 'POST' })
}

// /api/admin/flagged returns ServerMediaItem records flagged via
// match_status. Reuses ServerMediaItem from above.
export async function listFlaggedItems(signal?: AbortSignal): Promise<ServerMediaItem[]> {
  const res = await apiFetch<ServerMediaItem[]>('/api/admin/flagged', { signal })
  return res || []
}

export interface LLMSettings {
  provider: string
  ollama_url: string
  embed_url: string
  api_key_masked: string
  has_api_key: boolean
  chat_model: string
  embed_model: string
  chat_model_fast?: string
  chat_model_smart?: string
  structured_outputs?: boolean
  reasoning_effort?: string
  rerank_model?: string
  rerank_url?: string
  repeat_window_hours?: number
  debug_log: boolean
  live_debug_log: boolean
  client_loaded: boolean
}
export async function getAdminLLM(signal?: AbortSignal): Promise<LLMSettings> {
  return apiFetch<LLMSettings>('/api/admin/llm', { signal })
}
export async function updateAdminLLM(body: Partial<{
  provider: string
  ollama_url: string
  embed_url: string
  api_key: string
  chat_model: string
  embed_model: string
  chat_model_fast: string
  chat_model_smart: string
  structured_outputs: boolean
  reasoning_effort: string
  rerank_model: string
  rerank_url: string
  repeat_window_hours: number
  debug_log: boolean
}>): Promise<LLMSettings> {
  return apiFetch<LLMSettings>('/api/admin/llm', { method: 'PUT', body })
}

// Phase B — added Discord + Twitch fields alongside Google's. Each
// provider has the same 6-field shape (enabled, client_id,
// client_secret_masked, has_secret, redirect_url, bypass_invite).
// Flat structure preserves backward compatibility with the original
// google-only response shape.
export interface OAuthSettings {
  // Google (Phase 3)
  google_enabled: boolean
  google_client_id: string
  google_client_secret_masked: string
  google_has_secret: boolean
  google_redirect_url: string
  google_bypass_invite: boolean
  // Discord (Phase B)
  discord_enabled: boolean
  discord_client_id: string
  discord_client_secret_masked: string
  discord_has_secret: boolean
  discord_redirect_url: string
  discord_bypass_invite: boolean
  // Twitch (Phase B)
  twitch_enabled: boolean
  twitch_client_id: string
  twitch_client_secret_masked: string
  twitch_has_secret: boolean
  twitch_redirect_url: string
  twitch_bypass_invite: boolean
  // Facebook (Phase C)
  facebook_enabled: boolean
  facebook_client_id: string
  facebook_client_secret_masked: string
  facebook_has_secret: boolean
  facebook_redirect_url: string
  facebook_bypass_invite: boolean
  // X / Twitter (Phase D)
  twitter_enabled: boolean
  twitter_client_id: string
  twitter_client_secret_masked: string
  twitter_has_secret: boolean
  twitter_redirect_url: string
  twitter_bypass_invite: boolean
}
export async function getAdminOAuth(signal?: AbortSignal): Promise<OAuthSettings> {
  return apiFetch<OAuthSettings>('/api/admin/oauth', { signal })
}
// Update body — same Partial<> pattern, all-optional. Omitted fields
// are left alone server-side. Submitting a masked-secret value is
// silently treated as "no change" by the server.
export async function updateAdminOAuth(body: Partial<{
  google_enabled: boolean
  google_client_id: string
  google_client_secret: string
  google_redirect_url: string
  google_bypass_invite: boolean
  discord_enabled: boolean
  discord_client_id: string
  discord_client_secret: string
  discord_redirect_url: string
  discord_bypass_invite: boolean
  twitch_enabled: boolean
  twitch_client_id: string
  twitch_client_secret: string
  twitch_redirect_url: string
  twitch_bypass_invite: boolean
  facebook_enabled: boolean
  facebook_client_id: string
  facebook_client_secret: string
  facebook_redirect_url: string
  facebook_bypass_invite: boolean
  twitter_enabled: boolean
  twitter_client_id: string
  twitter_client_secret: string
  twitter_redirect_url: string
  twitter_bypass_invite: boolean
}>): Promise<OAuthSettings> {
  return apiFetch<OAuthSettings>('/api/admin/oauth', { method: 'PUT', body })
}

// Phase 4.6 — profiles. Aurora supports per-account "profiles" (think
// Netflix profiles) so a single login can have separate watch
// history / watchlists per family member. Pure read+CRUD; the
// active-profile concept is client-stored only (no server endpoint).
export interface Profile {
  id: number
  user_id: number
  name: string
  avatar_url?: string
  is_default: boolean
  created_at: string
  updated_at: string
}
export async function listProfiles(signal?: AbortSignal): Promise<Profile[]> {
  const res = await apiFetch<Profile[]>('/api/profiles', { signal })
  return res || []
}
export async function createProfile(name: string): Promise<Profile> {
  return apiFetch<Profile>('/api/profiles', { method: 'POST', body: { name } })
}
export async function deleteProfile(id: number): Promise<void> {
  await apiFetch(`/api/profiles/${id}`, { method: 'DELETE' })
}
export async function setDefaultProfile(id: number): Promise<void> {
  await apiFetch(`/api/profiles/${id}/default`, { method: 'POST' })
}

export interface Watchlist {
  id: number
  profile_id: number
  name: string
  created_at: string
  item_count?: number
}
export async function listWatchlists(profileId: number, signal?: AbortSignal): Promise<Watchlist[]> {
  const res = await apiFetch<Watchlist[]>(`/api/profiles/${profileId}/watchlists`, { signal })
  return res || []
}
export async function createWatchlist(profileId: number, name: string): Promise<Watchlist> {
  return apiFetch<Watchlist>(`/api/profiles/${profileId}/watchlists`, { method: 'POST', body: { name } })
}
export async function deleteWatchlist(profileId: number, listId: number): Promise<void> {
  await apiFetch(`/api/profiles/${profileId}/watchlists/${listId}`, { method: 'DELETE' })
}
export async function listWatchlistItems(
  profileId: number, listId: number, signal?: AbortSignal,
): Promise<ServerMediaItem[]> {
  const res = await apiFetch<ServerMediaItem[]>(
    `/api/profiles/${profileId}/watchlists/${listId}/items`, { signal }
  )
  return res || []
}
// Phase 5.2 — admin refresh-metadata. Re-pulls TMDB/TVDB metadata
// for this media item. Useful when a scan picked the wrong match
// or external metadata has been updated.
export async function refreshMetadata(mediaItemId: number): Promise<void> {
  await apiFetch(`/api/media/${mediaItemId}/refresh-metadata`, { method: 'POST' })
}

export async function addToWatchlist(
  profileId: number, listId: number, mediaItemId: number,
): Promise<void> {
  await apiFetch(`/api/profiles/${profileId}/watchlists/${listId}/items`, {
    method: 'POST',
    body: { media_item_id: mediaItemId },
  })
}

// ──────────────────────────────────────────────────────────────────
// Phase 6 — Collections
//
// Collections are admin/user-curated groupings of media items. Two
// flavors: manual (admin adds items one at a time) and AI (LLM picks
// from a natural-language prompt). Public collections (is_public=true,
// admin-only) appear in every user's home view.

export interface Collection {
  id: number
  owner_user_id: number
  name: string
  description?: string
  kind: 'manual' | 'ai'
  prompt?: string
  is_public: boolean
  cover_path?: string
  item_count?: number
  created_at: string
  updated_at: string
}

export interface CollectionWithItems {
  collection: Collection
  items: ServerMediaItem[]
}

export interface CreateCollectionPayload {
  name: string
  description?: string
  kind?: 'manual' | 'ai'
  prompt?: string
  is_public?: boolean
}

export async function listCollections(signal?: AbortSignal): Promise<Collection[]> {
  return apiFetch<Collection[]>('/api/collections', { signal })
}

export async function getCollection(id: number, signal?: AbortSignal): Promise<CollectionWithItems> {
  return apiFetch<CollectionWithItems>(`/api/collections/${id}`, { signal })
}

export async function createCollection(body: CreateCollectionPayload): Promise<Collection> {
  return apiFetch<Collection>('/api/collections', { method: 'POST', body })
}

export async function deleteCollection(id: number): Promise<void> {
  await apiFetch(`/api/collections/${id}`, { method: 'DELETE' })
}

export async function addToCollection(id: number, mediaItemID: number): Promise<void> {
  await apiFetch(`/api/collections/${id}/items`, {
    method: 'POST',
    body: { media_item_id: mediaItemID },
  })
}

export async function removeFromCollection(id: number, mediaItemID: number): Promise<void> {
  await apiFetch(`/api/collections/${id}/items/${mediaItemID}`, { method: 'DELETE' })
}

// ──────────────────────────────────────────────────────────────────
// Phase 6 — Calendar (upcoming episodes)

export interface UpcomingEpisode {
  media_item_id: number
  show_title: string
  poster_path?: string
  backdrop_path?: string
  episode_id: number
  season_number: number
  episode_number: number
  episode_title?: string
  overview?: string
  air_date: string // ISO timestamp
}

export async function getCalendar(
  fromISO: string,
  toISO: string,
  signal?: AbortSignal,
): Promise<UpcomingEpisode[]> {
  const params = new URLSearchParams({ from: fromISO, to: toISO })
  return apiFetch<UpcomingEpisode[]>(`/api/calendar?${params.toString()}`, { signal })
}

// ──────────────────────────────────────────────────────────────────
// Phase 6 — Gamification (XP, level, streak, achievements)

export interface UserXPStats {
  user_id: number
  xp: number
  level: number
  current_streak: number
  longest_streak: number
  last_watch_date?: string
  total_watches: number
  xp_to_next_level?: number
  next_level_total?: number
  // Audit H1 fix — total XP at the start of the current level.
  // Lets the client render `(xp - prev) / (next - prev)` for
  // accurate per-level progress instead of misleading absolute %.
  prev_level_total?: number
}

export interface UserAchievementUnlock {
  id: number
  user_id: number
  achievement_key: string
  unlocked_at: string
}

export interface AchievementDef {
  key: string
  title: string
  description: string
  icon: string
  xp_reward: number
  hidden?: boolean
}

export interface GamificationStats {
  xp: UserXPStats
  unlocked: UserAchievementUnlock[]
  achievement_catalog: AchievementDef[]
  // Most-finished genre across the user's completed watch history. Empty
  // string ("") when there's no completed-watch data yet; the "Your week"
  // band renders a placeholder in that case. Older servers omit the field
  // entirely (undefined), which the band also treats as the placeholder.
  top_genre?: string
  // Titles finished + minutes of content finished in the last 7 days
  // (watch_progress.completed_at, populated going forward — 0 until the user
  // finishes something post-deploy). Older servers omit these (undefined),
  // which the "Your week" band renders as a "—" placeholder.
  titles_this_week?: number
  minutes_this_week?: number
}

export async function getGamificationStats(signal?: AbortSignal): Promise<GamificationStats> {
  return apiFetch<GamificationStats>('/api/me/gamification', { signal })
}

// 2026-06-06 — Active watch parties for the Home "Watch together" card.
// GET /api/parties/active returns the manager's live in-memory snapshot
// (more up-to-date than the DB). Regular-user accessible; every entry is a
// party anyone on the server can join via its 6-char code. Aurora is a
// single household, so "active parties" — not a friend graph — is the honest
// "who's watching together right now" signal.
export interface ActiveParty {
  code: string
  host_user_id: number
  party_name: string
  media_title: string
  media_poster: string
  participant_count: number
  max_participants: number
  is_playing: boolean
}

export async function listActiveParties(signal?: AbortSignal): Promise<ActiveParty[]> {
  type Raw = { parties?: ActiveParty[]; total?: number }
  const resp = await apiFetch<Raw>('/api/parties/active', { signal })
  return resp.parties ?? []
}

// Phase 4.6 — persistent rooms. Quick-parties die when the host
// leaves; rooms have a stable code that survives across sessions.
// V2 ships a small list+create UI in admin; full "open + stage"
// flow is Phase 5.
export interface Room {
  id: number
  code: string
  name: string
  description?: string
  owner_user_id: number
  created_at: string
  // active_party_code is non-empty when a party is currently running
  // in this room (the code matches the room code for stable links).
  active_party_code?: string
}
export async function listRooms(signal?: AbortSignal): Promise<Room[]> {
  const res = await apiFetch<Room[]>('/api/rooms', { signal })
  return res || []
}
export async function createRoom(body: { name: string; description?: string }): Promise<Room> {
  return apiFetch<Room>('/api/rooms', { method: 'POST', body })
}
export async function deleteRoom(id: number): Promise<void> {
  await apiFetch(`/api/rooms/${id}`, { method: 'DELETE' })
}

// Phase 4.6 — highlight reel. Auto-generated server-side at party-
// end (M9). The server streams the MP4. The access token rides via
// withToken's ?token= because an <a href> download can't carry an
// Authorization header; the router's token-promotion middleware
// (shouldPromoteToken) explicitly promotes
// /api/parties/{code}/highlight.mp4 so the request authenticates.
// (Audit H11: this path was previously NOT on the promotion list, so
// the link always 401'd — the reel never downloaded.)
export function highlightReelURL(code: string): string {
  return withToken(`/api/parties/${encodeURIComponent(code)}/highlight.mp4`)
}

// ──────────────────────────────────────────────────────────────────
// Watch Party — Mobile Companion (additive helpers)
//
// The companion is a phone "second screen" that opens ONLY the room
// socket (chat / voice / reactions) — it never decodes video or drives
// playback. These helpers are pure additions; nothing here changes the
// existing party/auth flows.

// CompanionPartyPreview — the unauthenticated "now playing" preview the
// JoinScreen shows under the code boxes. Backed by the EXISTING
// GET /api/code/{code}/info preflight (party_handlers.go GetCodeInfo),
// which is deliberately UNAUTHENTICATED and returns only public party
// metadata (party name, media title/poster, host id, headcount) — never
// the participant list or chat. We normalize the `type: 'active'` shape
// into a flat preview; an 'offline_room' (or any non-active) result
// means "no live session" and yields null so the UI can say so.
export interface CompanionPartyPreview {
  code: string
  partyName?: string
  mediaTitle?: string
  mediaPoster?: string
  participantCount?: number
}

export async function getCompanionPartyPreview(
  code: string,
  signal?: AbortSignal,
): Promise<CompanionPartyPreview | null> {
  const c = code.trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(c)) return null
  const info = await apiFetch<CodeInfo>(`/api/code/${encodeURIComponent(c)}/info`, { signal })
  if (info.type !== 'active') return null
  const p = info.party
  return {
    code: p?.code ?? c,
    partyName: p?.party_name,
    mediaTitle: p?.media_title,
    mediaPoster: p?.media_poster,
    participantCount: p?.participant_count,
  }
}

// companionQrURL — the QR PNG the DESKTOP host UI (PartyInvite) renders
// in an <img>. The server (party_qr.go) renders it and encodes the
// absolute /join/<CODE> short link so a scan lands the phone pre-filled.
// No withToken(): the <img> is a same-origin GET that carries the
// httpOnly auth cookie automatically (post-H10), so a ?token= query would
// be dead today AND a latent token-in-URL leak if H10 ever regressed.
export function companionQrURL(code: string): string {
  return `/api/parties/${encodeURIComponent(code)}/qr.png`
}

// companionJoinPath — the canonical absolute companion-join link for the
// "copy link" affordance. Uses the server SHORT-LINK form
// `<origin>/join/<CODE>` (NOT /v2/join/...): the backend route
// GET /join/{code} (router.go → joinShortLinkRedirect) 302-redirects to
// /v2/join/{CODE}, where the SPA companion route takes over. This is the
// SAME URL the server-rendered QR encodes (party_qr.go), so the scanned
// QR and a pasted link land identically. Returns an absolute same-origin
// URL (e.g. https://host/join/B9K4T2).
export function companionJoinPath(code: string): string {
  const path = `/join/${encodeURIComponent(code.trim().toUpperCase())}`
  if (typeof location !== 'undefined') return `${location.origin}${path}`
  return path
}

// companionOAuthStartUrl — builds the existing OAuth-start URL for the
// companion sign-in (Option A: account required, one-tap via the 5
// existing providers). We forward the party code as ?join=CODE, which
// the server already understands (oauth_handlers.go Start → join cookie
// → success-page redirect), so the user lands back signed-in with the
// code preserved. Mirrors App.tsx's OAuthSignInButton href construction.
export function companionOAuthStartUrl(
  provider: 'google' | 'discord' | 'twitch' | 'facebook' | 'twitter',
  joinCode?: string,
): string {
  const params = new URLSearchParams()
  const c = (joinCode ?? '').trim().toUpperCase()
  if (/^[A-Z0-9]{6}$/.test(c)) params.set('join', c)
  // companion=1 tells the OAuth success bridge (oauth_handlers.go
  // renderSuccess) to redirect the phone back to the /v2/join/<CODE>
  // companion shell instead of the desktop app. Without it, a friend who
  // signs in via one-tap OAuth lands in the full desktop SPA on their phone.
  params.set('companion', '1')
  const qs = params.toString()
  return `/api/auth/oauth/${provider}/start${qs ? '?' + qs : ''}`
}

// Phase 5 — admin ops + invites + server settings.
export interface InviteCodeResponse {
  code: string
  expires_at: string
}
export async function createInvite(): Promise<InviteCodeResponse> {
  return apiFetch<InviteCodeResponse>('/api/users/invite', { method: 'POST' })
}
// Audit M1 (Phase 5.1 audit-7) — server returns `files_purged`, not
// `removed`. The old typing caused the alert to always say "Purged ?
// files" (bytes were correct, file count was always undefined).
export async function purgeImageCache(): Promise<{ files_purged?: number; bytes_freed?: number; message?: string }> {
  return apiFetch('/api/admin/cache/images/purge', { method: 'POST' })
}
// Audit H1 (Phase 5.1 audit-7) — server returns `{connected, error?}`,
// NOT `{ok, version, error}`. The old shape was wrong on both fields,
// causing every successful Test to display "Failed".
export async function testARRConnection(
  service: 'radarr' | 'radarr_4k' | 'sonarr' | 'sonarr_4k',
  url: string, apiKey: string,
): Promise<{ connected: boolean; error?: string }> {
  return apiFetch('/api/admin/arr/test', {
    method: 'POST',
    body: { service, url, api_key: apiKey },
  })
}
// Generic server-settings panel reads everything via getAllSettings
// then PUTs only the changed keys.
export interface ServerSettingsMap { [key: string]: string }
export async function getAllSettings(signal?: AbortSignal): Promise<ServerSettingsMap> {
  const list = await apiFetch<{ key: string; value: string }[]>('/api/admin/settings', { signal })
  const out: ServerSettingsMap = {}
  for (const row of list || []) out[row.key] = row.value
  return out
}
export async function updateSettings(patch: ServerSettingsMap): Promise<void> {
  await apiFetch('/api/admin/settings', { method: 'PUT', body: { settings: patch } })
}

// ── Auto-updater (admin) ──────────────────────────────────────────
// The shape mirrors what scripts/aurora-update.sh writes to
// /var/lib/aurora/update-status.json and the Go SystemHandler
// forwards verbatim. Keep the union of `state` values in sync with
// the script's write_status calls — drift here means the UI
// renders an empty "" badge for new states.
export type UpdateState =
  | 'idle'           // last check found no upstream commits
  | 'checking'       // git-fetching origin
  | 'updating'       // pulling commits
  | 'building'       // running go build
  | 'installing'     // copying binary + assets
  | 'restarting'     // systemctl restart aurora
  | 'success'        // last run completed cleanly
  | 'failed'         // last run errored AFTER attempting an update — message has detail
  | 'misconfigured'  // preflight rejected (no source, wrong origin, etc) — operator action needed
  | 'unknown'        // no status file yet (first install, timer hasn't fired)
export interface UpdateStatus {
  state: UpdateState
  at: string              // RFC3339 timestamp of the last write
  message: string         // human-readable detail (commit subject on success, error text on failure)
  old_sha?: string | null // commit SHA before the update started
  new_sha?: string | null // target / installed commit SHA
}

export async function getUpdateStatus(signal?: AbortSignal): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>('/api/admin/system/update/status', { signal })
}

// Kicks off the updater service. Returns 202 with {started: true}
// when the systemctl trigger succeeds; the actual update runs
// asynchronously. Callers should poll getUpdateStatus to render
// progress and the final result.
export async function triggerUpdate(): Promise<{ started: boolean; message: string }> {
  return apiFetch('/api/admin/system/update', { method: 'POST' })
}
// Setup-status: tells the auth screen whether ANY users exist. When
// the database is empty (fresh install), the first registrant
// becomes admin with no invite required.
export interface SetupStatus {
  setup_complete: boolean
  has_users: boolean
  oauth_google_enabled: boolean
  oauth_google_bypass_invite: boolean
  // Phase B — per-provider enable flags + bypass-invite flags.
  // AuthView reads these to render the right sign-in buttons +
  // adjust invite-code messaging on the register form.
  oauth_discord_enabled: boolean
  oauth_discord_bypass_invite: boolean
  oauth_twitch_enabled: boolean
  oauth_twitch_bypass_invite: boolean
  // Phase C — Facebook
  oauth_facebook_enabled: boolean
  oauth_facebook_bypass_invite: boolean
  // Phase D — X (Twitter)
  oauth_twitter_enabled: boolean
  oauth_twitter_bypass_invite: boolean
}
export async function getSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
  return apiFetch<SetupStatus>('/api/auth/setup-status', { signal })
}

// ──────────────────────────────────────────────────────────────────
// Multi-provider OAuth account linking (audit carve-out D). Backed by
// the authoritative oauth_identities table (migration 031). The
// Connected Accounts card in Settings uses these to list, connect, and
// disconnect providers for the signed-in user.

export interface OAuthLinkedProvider {
  provider: string
  linkedAt: string
}

export interface OAuthLinksResponse {
  // Providers already connected to this account.
  linked: OAuthLinkedProvider[]
  // Configured-and-enabled providers not yet linked — render a "Connect"
  // button for each.
  available: string[]
  // True when the user also has a password (a non-OAuth sign-in method).
  hasPassword: boolean
  // True when at least one provider can currently be disconnected without
  // locking the user out (mirrors the server's unlink lockout guard).
  canUnlinkAny: boolean
}

export async function listOAuthLinks(signal?: AbortSignal): Promise<OAuthLinksResponse> {
  return apiFetch<OAuthLinksResponse>('/api/auth/oauth/links', { signal })
}

// startOAuthLink begins LINK mode for a provider: the server sets a
// server-side link-uid cookie and returns the provider auth URL, which we
// navigate to. On return the callback attaches the identity and bounces back
// to /?linked=<provider>. Unlike sign-in (which uses an <a href> on a public
// route), linking is a POST on an authed route, so we fetch then navigate.
export async function startOAuthLink(provider: string): Promise<void> {
  const { auth_url } = await apiFetch<{ auth_url: string }>(
    `/api/auth/oauth/${provider}/link`,
    { method: 'POST' },
  )
  window.location.href = auth_url
}

export async function unlinkOAuth(provider: string): Promise<void> {
  await apiFetch(`/api/auth/oauth/${provider}/link`, { method: 'DELETE' })
}

export interface RegisterRequest {
  username: string
  email: string
  password: string
  invite_code: string
}
export async function register(body: RegisterRequest): Promise<TokenResponse> {
  const t = await apiFetch<TokenResponse>('/api/auth/register', { method: 'POST', body })
  storeTokens(t)
  return t
}

// NB: list-users is at /api/users (admin-gated), NOT /api/admin/users.
// History: the route lives under /api/users because user-management
// pre-dates the admin namespace consolidation; renaming it would be
// a breaking API change. V1 calls it directly too.
export async function listAdminUsers(signal?: AbortSignal): Promise<AdminUser[]> {
  const resp = await apiFetch<AdminUser[]>('/api/users', { signal })
  return resp || []
}

// ──────────────────────────────────────────────────────────────────
// Continue Watching (Phase 4.5)
//
// /api/progress/continue returns the user's in-progress items across
// movies + TV episodes, sorted by recency. Used by the HomeView's
// Continue Watching rail and by the LibraryView's "In Progress"
// section. Each item carries enough context to render the card
// AND to resume playback (media_item_id + episode_id + position_ms).

export interface ContinueWatchingItem {
  media_item_id: number
  episode_id?: number
  title: string
  poster_path?: string
  backdrop_path?: string
  type: 'movie' | 'show'
  year?: number
  // QA BUG-007 — backend now selects mi.rating and attaches the
  // first genre via GetMediaGenresBatch so CW cards have the same
  // metadata as other rails.
  rating?: number
  genre?: string
  episode_title?: string
  season_number?: number
  episode_number?: number
  position_ms: number
  duration_ms: number
  percent_complete: number
  completed?: boolean
  updated_at?: string
}

export async function listContinueWatching(
  limit = 20, profileId?: number, signal?: AbortSignal,
): Promise<ContinueWatchingItem[]> {
  // Phase 5 — profile-aware. When profileId is set, server scopes
  // progress entries to that profile. Without it, the response is
  // user-global (V1's default behavior pre-profiles).
  const params = new URLSearchParams({ limit: String(limit) })
  if (profileId) params.set('profile_id', String(profileId))
  const items = await apiFetch<ContinueWatchingItem[]>(
    `/api/progress/continue?${params.toString()}`, { signal },
  )
  return items || []
}

// Map a ContinueWatchingItem to a UI Media so it slots into rails and
// cards alongside listMedia results. We lose the resume position in
// this mapping, but the caller keeps the original record so it can
// pull position_ms when the user clicks Play.
export function mapContinueToMedia(c: ContinueWatchingItem): UIMedia {
  return {
    id: c.media_item_id,
    title: c.title,
    year: c.year || 0,
    rating: c.rating ?? 0,
    duration: '',
    genre: c.genre ?? '',
    type: c.type === 'show' ? 'show' : 'movie',
    poster: posterURL(c.poster_path),
    backdrop: backdropURL(c.backdrop_path),
    description: c.episode_title
      ? `S${c.season_number}E${c.episode_number}${c.episode_title ? ' — ' + c.episode_title : ''}`
      : '',
    // 2028-05-28 (deep-debug Bug B) — server emits percent_complete in
    // the 0-100 range (internal/db/queries_phase4.go:641 multiplies the
    // position/duration ratio by 100). The UI Media.progress contract
    // (and MediaCardCinema's `progress * 100%` width math) expects 0-1.
    // Pre-PR the inline render did `progress * 100` on the rail and
    // `Math.min(100, c.percent_complete * 100)` in LibraryView — both
    // wrong in subtle directions. Normalize here at the source: divide
    // by 100, clamp to [0, 1], and the downstream `progress * 100%`
    // math produces a correct bar width. Every reader becomes simpler.
    progress: c.percent_complete > 0 ? Math.min(1, c.percent_complete / 100) : undefined,
  }
}

// ──────────────────────────────────────────────────────────────────
// Requests (Phase 4.5)

export interface MediaRequest {
  id: number
  user_id: number
  media_type: 'movie' | 'tv'
  tmdb_id: number
  title: string
  poster_path: string
  overview: string
  year: number
  status: 'pending' | 'pending_approval' | 'processing' | 'available' | 'failed'
  quality_1080p: boolean
  quality_4k: boolean
  error_message?: string
  requested_at: string
  processed_at?: string
  completed_at?: string
  updated_at: string
  username?: string
}

export interface RequestsConfig {
  enabled: boolean
  has_radarr: boolean
  has_sonarr: boolean
}

export async function listRequests(signal?: AbortSignal): Promise<MediaRequest[]> {
  const items = await apiFetch<MediaRequest[]>('/api/requests', { signal })
  return items || []
}

export async function getRequestsConfig(signal?: AbortSignal): Promise<RequestsConfig> {
  return apiFetch<RequestsConfig>('/api/requests/config', { signal })
}

// ──────────────────────────────────────────────────────────────────
// Notifications (per-user bell + panel). Named AppNotification to avoid
// shadowing the DOM `Notification` global.

export interface AppNotification {
  id: number
  user_id: number
  type: string // 'request_available' | 'request_failed'
  title: string
  media_type?: string
  request_id?: number
  read_at?: string | null // null/absent ⇒ unread
  created_at: string
}

export interface NotificationsResponse {
  notifications: AppNotification[]
  unread: number
}

// listNotifications returns the caller's recent notifications + unread count.
// The persisted feed is the source of truth seeded on login/reconnect; the
// 'notification' WebSocket event is best-effort live delivery on top.
export async function listNotifications(signal?: AbortSignal): Promise<NotificationsResponse> {
  const res = await apiFetch<NotificationsResponse>('/api/me/notifications', { signal })
  return res || { notifications: [], unread: 0 }
}

export async function markNotificationRead(id: number): Promise<void> {
  await apiFetch(`/api/me/notifications/${id}/read`, { method: 'POST' })
}

export async function markAllNotificationsRead(): Promise<void> {
  await apiFetch('/api/me/notifications/read-all', { method: 'POST' })
}

// TMDB-via-Aurora search for the request-create form. Aurora proxies
// TMDB so users don't need their own API keys. Returns a small shape
// — we only display poster + title + year + tmdb_id (used in the
// create payload).
export interface TmdbSearchResult {
  tmdb_id: number
  media_type: 'movie' | 'tv'
  title: string
  poster_path?: string
  overview?: string
  year?: number
}

interface TmdbSearchEnvelope {
  results?: TmdbSearchItem[]
}

interface TmdbSearchItem {
  id: number
  media_type?: 'movie' | 'tv' | 'person'
  title?: string
  name?: string
  poster_path?: string | null
  overview?: string
  release_date?: string
  first_air_date?: string
}

export async function searchTmdb(
  q: string,
  signal?: AbortSignal,
): Promise<TmdbSearchResult[]> {
  if (!q.trim()) return []
  const envelope = await apiFetch<TmdbSearchEnvelope>(
    `/api/requests/search?q=${encodeURIComponent(q)}&type=multi`,
    { signal },
  )
  return (envelope.results || [])
    .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
    .map(item => {
      const mediaType: TmdbSearchResult['media_type'] = item.media_type === 'tv' ? 'tv' : 'movie'
      const date = mediaType === 'tv' ? item.first_air_date : item.release_date
      const year = date && date.length >= 4 ? Number.parseInt(date.slice(0, 4), 10) : 0
      return {
        tmdb_id: item.id,
        media_type: mediaType,
        title: item.title || item.name || '',
        poster_path: item.poster_path || '',
        overview: item.overview || '',
        year: Number.isFinite(year) ? year : 0,
      }
    })
    .filter(item => item.tmdb_id > 0 && item.title)
}

export interface CreateRequestPayload {
  media_type: 'movie' | 'tv'
  tmdb_id: number
  title: string
  poster_path: string
  overview: string
  year: number
  quality_1080p: boolean
  quality_4k: boolean
}
export async function createRequest(payload: CreateRequestPayload): Promise<MediaRequest> {
  return apiFetch<MediaRequest>('/api/requests', { method: 'POST', body: payload })
}

// Admin approval queue (carve-out C). Requests held by the per-user quota
// gate land in 'pending_approval'; these helpers back the admin Pending
// Approvals section. All three are admin-gated server-side via the
// /api/admin route group.
export async function listPendingApprovals(signal?: AbortSignal): Promise<MediaRequest[]> {
  const items = await apiFetch<MediaRequest[]>('/api/admin/requests/pending', { signal })
  return items || []
}
export async function approveRequest(id: number): Promise<void> {
  await apiFetch(`/api/admin/requests/${id}/approve`, { method: 'POST' })
}
export async function denyRequest(id: number): Promise<void> {
  await apiFetch(`/api/admin/requests/${id}/deny`, { method: 'POST' })
}

// Build the TMDB poster URL. Aurora's request UI displays posters
// directly from TMDB CDN (the items aren't in the library yet, so
// the image proxy doesn't have them). This is the same pattern V1
// uses (aurora_pro.html does `https://image.tmdb.org/t/p/w500${path}`).
export function tmdbPosterURL(path?: string): string {
  if (!path) return ''
  return `https://image.tmdb.org/t/p/w500${path.startsWith('/') ? path : '/' + path}`
}

// ──────────────────────────────────────────────────────────────────
// Watch party (Phase 4)

export interface CreatePartyRequest {
  media_item_id: number
  media_title: string
  media_poster?: string
  initial_position_ms?: number
}

export interface CreatePartyResponse {
  code: string
}

// V1 also handles persistent-room creation via /api/rooms/{id}/parties;
// V2's Phase 4 ships the quick-party flow only. Phase 4.5 can port the
// pendingRoomTarget UX (My Rooms → Open → Watch).
export async function createQuickParty(
  body: CreatePartyRequest,
  signal?: AbortSignal,
): Promise<CreatePartyResponse> {
  return apiFetch<CreatePartyResponse>('/api/parties', {
    method: 'POST',
    body,
    signal,
  })
}

// Token in query-string form for native-element URLs that can't set
// an Authorization header (`<video src="...">`, anchor downloads, HLS
// playlist URLs consumed by hls.js's bundled XHR before our xhrSetup
// runs). The server's token-promotion middleware (router.go ~line
// 122) accepts ?token= on whitelisted paths (/ws, /api/stream/,
// /api/images/, /api/admin/backup) and redacts the value from access
// logs after promotion. Always prefer Authorization Bearer when
// possible — this helper is the fallback.
export function withToken(url: string): string {
  const t = getAccessToken()
  if (!t) return url
  const sep = url.includes('?') ? '&' : '?'
  return url + sep + 'token=' + encodeURIComponent(t)
}

// ──────────────────────────────────────────────────────────────────
// Bug-report (Phase 1 MVP)
//
// Backed by /api/feedback. Off by default on the server; the frontend
// gates the launcher button on `enabled` from getBugReportConfig().
//
// 2026-05-27 — Diagnostic buffer (console + network ring buffers)
// is read via getDiagnosticBuffer() on submit. Imported at the top
// so the bundler resolves it; the buffer itself is installed at app
// boot from main.tsx.
// When enabled, submitBugReport posts a multipart form with the
// user's title + description (+ optional file attachment) and the
// server creates a GitHub issue. Returns the public issue URL the
// toast deep-links to.

export interface BugReportConfig {
  enabled: boolean
  // 2026-05-27 — PAT health diagnostics. Server populates these
  // ONLY when the requester is an admin (claims.Role == "admin");
  // regular users get them omitted. Used by the BugReportModal
  // to show an amber banner to admins when the configured GitHub
  // PAT is expired / revoked / missing scope.
  //
  // token_healthy is a tri-state: undefined = not yet checked OR
  // not an admin; true = recent Validate succeeded; false = recent
  // Validate failed (reason populated).
  token_healthy?: boolean
  token_health_reason?: string
  token_health_checked_at?: string // RFC3339
}

export async function getBugReportConfig(signal?: AbortSignal): Promise<BugReportConfig> {
  return apiFetch<BugReportConfig>('/api/feedback/config', { signal })
}

export interface BugReportSubmitResult {
  issue_url: string
  issue_number: number
}

export interface BugReportInput {
  title: string
  description: string
  name?: string // free-form display name, prefilled from user.email
  attachment?: File
  // 2026-05-27 — Auto-collected browser-side context. submitBugReport
  // captures these from window/navigator if the caller doesn't supply
  // them, so callers can either explicitly override (e.g. for tests)
  // or pass undefined and let the helper handle it. Server appends
  // them as a collapsed <details> block in the issue body.
  context?: BugReportClientContext
}

export interface BugReportClientContext {
  url?: string
  viewport?: string
  devicePixelRatio?: string
  userAgent?: string
  language?: string
  clientTime?: string
}

// collectClientContext gathers browser-side facts useful for triage
// without any network calls. Defensive against running in non-browser
// environments (SSR / tests) — each field is optional and falls back
// to undefined when window/navigator are missing.
//
// Deep-debug M1 — every field is guarded to avoid producing literal
// "undefined" or "0x0" strings. Optional chaining alone returns
// `undefined` which then string-concatenates as the literal text
// "undefined"; downstream the server can't distinguish that from a
// real value. Each return field is either a sensible string or
// truly omitted.
export function collectClientContext(): BugReportClientContext {
  if (typeof window === 'undefined') return {}
  const w = window
  const n = w.navigator as Navigator | undefined
  const ctx: BugReportClientContext = {}
  if (w.location?.pathname) {
    // Run through redactURL (shared with the network-buffer scrubber) so
    // sensitive query params — token / code / invite / etc. — don't ride
    // along into the bug report's client_url. The network buffer already
    // redacts its URLs; this closes the matching gap on client_url.
    ctx.url = redactURL(w.location.pathname + (w.location.search || ''))
  }
  if (typeof w.innerWidth === 'number' && typeof w.innerHeight === 'number'
    && w.innerWidth > 0 && w.innerHeight > 0) {
    ctx.viewport = `${w.innerWidth}x${w.innerHeight}`
  }
  if (typeof w.devicePixelRatio === 'number' && w.devicePixelRatio > 0) {
    ctx.devicePixelRatio = String(w.devicePixelRatio)
  }
  if (n?.userAgent) ctx.userAgent = n.userAgent
  if (n?.language) ctx.language = n.language
  ctx.clientTime = new Date().toISOString()
  return ctx
}

export async function submitBugReport(
  input: BugReportInput,
  signal?: AbortSignal,
): Promise<BugReportSubmitResult> {
  const fd = new FormData()
  fd.append('title', input.title)
  fd.append('description', input.description)
  if (input.name) fd.append('name', input.name)
  if (input.attachment) fd.append('attachment', input.attachment, input.attachment.name)
  // 2026-05-27 — Context fields. Default to collectClientContext() so
  // every report gets the browser-side env block without each caller
  // having to remember; explicit `input.context` overrides per call.
  // Each field is optional on the server too — empty strings get
  // omitted from the rendered <details> block.
  const ctx = input.context ?? collectClientContext()
  if (ctx.url) fd.append('client_url', ctx.url)
  if (ctx.viewport) fd.append('client_viewport', ctx.viewport)
  if (ctx.devicePixelRatio) fd.append('client_dpr', ctx.devicePixelRatio)
  if (ctx.userAgent) fd.append('client_user_agent', ctx.userAgent)
  if (ctx.language) fd.append('client_language', ctx.language)
  if (ctx.clientTime) fd.append('client_time', ctx.clientTime)
  // 2026-05-27 — Diagnostic buffer payload. Reads the in-memory
  // ring buffers from lib/diagnosticBuffer (installed at app boot in
  // main.tsx). Each is JSON-encoded as a separate multipart field;
  // server-side renders them into the GH issue body's <details>
  // block. Wrapped in try/catch so a buffer-read failure can never
  // block the submission itself.
  try {
    const diag = getDiagnosticBuffer()
    if (diag.console.length > 0) {
      fd.append('client_console', JSON.stringify(diag.console))
    }
    if (diag.network.length > 0) {
      fd.append('client_network', JSON.stringify(diag.network))
    }
  } catch {
    // Best-effort — submission still goes through without the
    // diagnostic block.
  }
  // Use apiFetchResponse directly so we control the body type (don't
  // let apiFetch JSON-encode the FormData). Browser sets the proper
  // multipart/form-data; boundary header automatically when body is
  // a FormData instance.
  const res = await apiFetchResponse('/api/feedback', {
    method: 'POST',
    body: fd,
    signal,
  })
  const ct = res.headers.get('content-type') || ''
  const parseBody = async (): Promise<unknown> => {
    if (ct.includes('application/json')) {
      try { return await res.json() } catch { return null }
    }
    return await res.text()
  }
  if (!res.ok) {
    const body = await parseBody()
    let message = `HTTP ${res.status}`
    if (body && typeof body === 'object' && 'error' in body) {
      const errField = (body as Record<string, unknown>).error
      if (typeof errField === 'string') {
        message = errField
      } else if (errField && typeof errField === 'object' && 'message' in errField) {
        const nested = (errField as Record<string, unknown>).message
        if (typeof nested === 'string') message = nested
      }
    }
    // Phase 3 (deep-debug L4) — on 429, prefer the Retry-After
    // header for a human-readable wait time. The server's text
    // already includes the seconds, but a human "wait 30 minutes"
    // is more readable than "wait 1800 seconds." Format only when
    // the header parses cleanly; otherwise fall through.
    if (res.status === 429) {
      const ra = res.headers.get('Retry-After')
      const secs = ra ? parseInt(ra, 10) : NaN
      if (Number.isFinite(secs) && secs > 0) {
        const minutes = Math.ceil(secs / 60)
        message = `Too many bug reports — please wait ${
          minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${secs} seconds`
        } before submitting again.`
      }
    }
    throw new APIError(res.status, message, body)
  }
  return (await parseBody()) as BugReportSubmitResult
}

// ──────────────────────────────────────────────────────────────────
// Taste onboarding ("Pick What You Love")
//
// Seeds the recommender for a brand-new profile so hero / recommendations /
// discover / anchor-rails personalize on first load. All endpoints are
// per-profile: pass the active profile id, or omit it to use the account's
// default profile (the server resolves it).

export interface OnboardingStatus {
  profile_id: number
  completed: boolean
  eligible: boolean
  library_embedded: boolean
  min_picks: number
  threshold: number
  seed_count: number
}

function onboardingQS(profileId?: number, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra)
  if (profileId) params.set('profile_id', String(profileId))
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export async function getOnboardingStatus(
  profileId?: number,
  signal?: AbortSignal,
): Promise<OnboardingStatus> {
  return apiFetch<OnboardingStatus>(`/api/onboarding/status${onboardingQS(profileId)}`, { signal })
}

export async function getOnboardingGrid(
  opts: {
    profileId?: number
    limit?: number
    offset?: number
    /** When >= the personalization threshold, the grid re-ranks toward these picks. */
    selected?: number[]
    signal?: AbortSignal
  } = {},
): Promise<UIMedia[]> {
  const extra: Record<string, string> = {}
  if (opts.limit) extra.limit = String(opts.limit)
  if (opts.offset) extra.offset = String(opts.offset)
  if (opts.selected && opts.selected.length > 0) extra.selected = opts.selected.join(',')
  const resp = await apiFetch<{ items?: ServerMediaItem[] }>(
    `/api/onboarding/grid${onboardingQS(opts.profileId, extra)}`,
    { signal: opts.signal },
  )
  return (resp.items || []).map(mapMedia)
}

export async function getOnboardingPreview(
  selected: number[],
  profileId?: number,
  signal?: AbortSignal,
): Promise<UIMedia[]> {
  if (selected.length === 0) return []
  const resp = await apiFetch<{ items?: ServerMediaItem[] }>(
    `/api/onboarding/preview${onboardingQS(profileId, { selected: selected.join(',') })}`,
    { signal },
  )
  return (resp.items || []).map(mapMedia)
}

export async function saveOnboardingSeeds(
  mediaIds: number[],
  profileId?: number,
): Promise<{ completed: boolean; seed_count: number }> {
  return apiFetch<{ completed: boolean; seed_count: number }>(
    `/api/onboarding/seeds${onboardingQS(profileId)}`,
    { method: 'POST', body: { media_ids: mediaIds } },
  )
}

export async function skipOnboarding(profileId?: number): Promise<{ skipped: boolean }> {
  return apiFetch<{ skipped: boolean }>(
    `/api/onboarding/skip${onboardingQS(profileId)}`,
    { method: 'POST' },
  )
}
