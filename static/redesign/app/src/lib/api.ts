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
  access_token: string
  refresh_token: string
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
  return localStorage.getItem(ACCESS_KEY)
}
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY)
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
function storeTokens(t: TokenResponse) {
  localStorage.setItem(ACCESS_KEY, t.access_token)
  localStorage.setItem(REFRESH_KEY, t.refresh_token)
  localStorage.setItem(USER_KEY, JSON.stringify(t.user))
}
export function clearTokens() {
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

async function tryRefresh(): Promise<boolean> {
  // Coalesce simultaneous refresh attempts so a wave of parallel 401s
  // triggers exactly one refresh call. Subsequent callers await the
  // same promise and reuse its result.
  if (refreshInFlight) return refreshInFlight
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
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
    const token = getAccessToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    return fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ?? undefined,
      signal: opts.signal,
      credentials: 'same-origin',
    })
  }

  let res = await doRequest()
  if (res.status === 401 && getRefreshToken()) {
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
  signal?: AbortSignal
} = {}): Promise<UIMedia[]> {
  const params = new URLSearchParams()
  if (opts.type) params.set('type', opts.type)
  if (opts.perPage) params.set('per_page', String(opts.perPage))
  if (opts.sortBy) params.set('sort_by', opts.sortBy)
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
export async function listMediaWithTotal(opts: {
  type?: 'movie' | 'show'
  perPage?: number
  page?: number
  sortBy?: 'recent' | 'rating' | 'title' | 'year'
  signal?: AbortSignal
} = {}): Promise<{ items: UIMedia[]; total: number; page: number; perPage: number; totalPages: number }> {
  const params = new URLSearchParams()
  if (opts.type) params.set('type', opts.type)
  if (opts.perPage) params.set('per_page', String(opts.perPage))
  if (opts.page) params.set('page', String(opts.page))
  if (opts.sortBy) params.set('sort_by', opts.sortBy)
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
    picks: { item: ServerMediaItem; reason?: string }[],
    personalization?: { cold_start?: boolean; history_count?: number; threshold?: number },
  }>(
    qs ? `/api/me/hero?${qs}` : '/api/me/hero', { signal },
  )
  return {
    picks: (resp.picks || []).map(p => ({ media: mapMedia(p.item), reason: p.reason })),
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
  items: UIMedia[]
}
export async function getDiscoverRails(
  profileId?: number,
  signal?: AbortSignal,
): Promise<DiscoverRailUI[]> {
  const params = new URLSearchParams()
  if (profileId) params.set('profile_id', String(profileId))
  const qs = params.toString()
  type Raw = { rails?: { title: string; items?: ServerMediaItem[] }[] }
  const resp = await apiFetch<Raw>(
    qs ? `/api/me/discover?${qs}` : '/api/me/discover', { signal },
  )
  return (resp.rails || []).map(r => ({
    title: r.title,
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
  return apiFetch<User>('/api/auth/me', { signal })
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
  resolution?: string
  duration_ms?: number
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
}

export async function getAdminDashboard(signal?: AbortSignal): Promise<ServerStats> {
  return apiFetch<ServerStats>('/api/admin/dashboard', { signal })
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

export interface TranscodeSession {
  id: string
  user_id: number
  file_id: number
  file_type: string
  status: string
  preset: string
  resolution?: string
  started_at: string
  last_active: string
}
export async function listAdminSessions(signal?: AbortSignal): Promise<TranscodeSession[]> {
  const res = await apiFetch<TranscodeSession[]>('/api/admin/sessions', { signal })
  return res || []
}
export async function deleteStreamSession(id: string): Promise<void> {
  await apiFetch(`/api/stream/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
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
}

export async function getGamificationStats(signal?: AbortSignal): Promise<GamificationStats> {
  return apiFetch<GamificationStats>('/api/me/gamification', { signal })
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
// end (M9). Just need the URL; the server streams MP4. Token rides
// via the standard withToken helper since /api/parties/{code}/
// highlight.mp4 is on the streaming token-promotion whitelist.
export function highlightReelURL(code: string): string {
  return withToken(`/api/parties/${encodeURIComponent(code)}/highlight.mp4`)
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
    rating: 0,
    duration: '',
    genre: '',
    type: c.type === 'show' ? 'show' : 'movie',
    poster: posterURL(c.poster_path),
    backdrop: backdropURL(c.backdrop_path),
    description: c.episode_title
      ? `S${c.season_number}E${c.episode_number}${c.episode_title ? ' — ' + c.episode_title : ''}`
      : '',
    progress: c.percent_complete > 0 ? c.percent_complete : undefined,
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
  status: 'pending' | 'processing' | 'available' | 'failed'
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
