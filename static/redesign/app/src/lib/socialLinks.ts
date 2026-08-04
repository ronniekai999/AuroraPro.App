// Social-link helpers for member profiles (social phase 1).
//
// The server stores BARE handles (per-network shape validated in
// social_handlers.go — no "@", no URL) and the client builds links against
// the fixed domains below, so a profile can never link anywhere except the
// four well-known networks. normalizeHandleInput is the UX side of that
// contract: people paste "@name" or a full profile URL into the settings
// form, and the form reduces either to the bare handle before submit — or
// REFUSES (null) when the paste can't honestly be reduced. The refusal
// matters: the PR-428 review showed shapes like facebook.com/profile.php?id=…
// and x.com/intent/follow reduce to segments that pass the server's shape
// regexes while linking to the wrong place, so "server re-validates" is not
// a backstop for them. The server checks shape; only this layer can check
// intent.

export interface SocialNetwork {
  key: 'social_x' | 'social_instagram' | 'social_facebook' | 'social_snapchat'
  label: string
  /** Fixed link base the profile page appends the (URI-encoded) handle to. */
  urlBase: string
  /** Host/path prefixes stripped from pasted profile URLs (lowercase; the
   *  scheme and a leading www. are already gone when these match). */
  strip: readonly string[]
  placeholder: string
  /** Server-side handle cap (mirrors the shape regex in social_handlers.go).
   *  Checked post-normalization so the error can say "too long" instead of
   *  the regex path's misleading "not a URL". */
  maxLen: number
}

export const SOCIAL_NETWORKS: readonly SocialNetwork[] = [
  // twitter.com (+ mobile variants) stripped alongside x.com — half the
  // world still pastes the legacy domain; same handle namespace.
  { key: 'social_x', label: 'X', urlBase: 'https://x.com/', strip: ['x.com/', 'm.x.com/', 'twitter.com/', 'm.twitter.com/', 'mobile.twitter.com/'], placeholder: 'yourhandle', maxLen: 15 },
  { key: 'social_instagram', label: 'Instagram', urlBase: 'https://instagram.com/', strip: ['instagram.com/', 'm.instagram.com/'], placeholder: 'your.name', maxLen: 30 },
  { key: 'social_facebook', label: 'Facebook', urlBase: 'https://facebook.com/', strip: ['facebook.com/', 'm.facebook.com/', 'mobile.facebook.com/', 'web.facebook.com/'], placeholder: 'your.name', maxLen: 60 },
  { key: 'social_snapchat', label: 'Snapchat', urlBase: 'https://snapchat.com/add/', strip: ['snapchat.com/add/', 'm.snapchat.com/add/'], placeholder: 'yourhandle', maxLen: 15 },
]

// First path segments that are page ROUTES on these networks, not handles.
// A paste that reduces to one of these came from a URL whose handle lives
// somewhere else (query string, deeper segment) — refuse rather than save a
// link to facebook.com/profile.php.
const RESERVED_SEGMENTS = new Set([
  'profile.php', 'people', 'pages', 'groups', 'intent', 'share', 'sharer',
  'home', 'login', 'hashtag', 'explore', 'add',
])

/**
 * Reduce whatever the user typed/pasted to a bare handle.
 * Returns: the handle; '' when the input was empty (= clear the field); or
 * null when the input looked like a link that can't honestly be reduced —
 * an unrecognized host with a path, a path deeper than one segment, or a
 * reserved page route. Callers surface null as an inline error instead of
 * submitting.
 */
export function normalizeHandleInput(raw: string, network: SocialNetwork): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  let v = trimmed.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  const lower = v.toLowerCase()
  let matchedPrefix = false
  for (const prefix of network.strip) {
    if (lower.startsWith(prefix)) {
      v = v.slice(prefix.length)
      matchedPrefix = true
      break
    }
  }
  v = v.replace(/^@/, '')
  // A "/" that survives to here without a recognized prefix means some
  // other site or an unrecognized subdomain — taking a segment from it
  // would be a guess, so refuse the whole paste.
  if (!matchedPrefix && v.includes('/')) return null
  // Cut query/fragment, then look at the path shape. A lone trailing slash
  // (instagram.com/name/) is noise; any deeper path is a refusal.
  const segments = v.split(/[?#]/)[0].split('/').filter(s => s !== '')
  const handle = (segments[0] ?? '').trim()
  if (handle === '') return null // e.g. "instagram.com/" — a link, no handle
  if (segments.length > 1) return null // x.com/intent/follow and kin
  if (RESERVED_SEGMENTS.has(handle.toLowerCase())) return null
  return handle
}

export function socialUrl(network: SocialNetwork, handle: string): string {
  return network.urlBase + encodeURIComponent(handle)
}
