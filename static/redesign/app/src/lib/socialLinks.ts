// Social-link helpers for member profiles (social phase 1).
//
// The server stores BARE handles (per-network shape validated in
// social_handlers.go — no "@", no URL) and the client builds links against
// the fixed domains below, so a profile can never link anywhere except the
// four well-known networks. normalizeHandleInput is the UX side of that
// contract: people paste "@name" or a full profile URL into the settings
// form, and the form quietly reduces either to the bare handle before
// submit; the server then re-validates shape.

export interface SocialNetwork {
  key: 'social_x' | 'social_instagram' | 'social_facebook' | 'social_snapchat'
  label: string
  /** Fixed link base the profile page appends the (URI-encoded) handle to. */
  urlBase: string
  /** Host/path prefixes stripped from pasted profile URLs (lowercase). */
  strip: readonly string[]
  placeholder: string
}

export const SOCIAL_NETWORKS: readonly SocialNetwork[] = [
  // twitter.com is stripped alongside x.com — half the world still pastes
  // the legacy domain; both resolve to the same handle namespace.
  { key: 'social_x', label: 'X', urlBase: 'https://x.com/', strip: ['x.com/', 'twitter.com/'], placeholder: 'yourhandle' },
  { key: 'social_instagram', label: 'Instagram', urlBase: 'https://instagram.com/', strip: ['instagram.com/'], placeholder: 'your.name' },
  { key: 'social_facebook', label: 'Facebook', urlBase: 'https://facebook.com/', strip: ['facebook.com/'], placeholder: 'your.name' },
  { key: 'social_snapchat', label: 'Snapchat', urlBase: 'https://snapchat.com/add/', strip: ['snapchat.com/add/'], placeholder: 'yourhandle' },
]

/**
 * Reduce whatever the user typed/pasted to a bare handle candidate: drop
 * scheme + www., drop the network's own URL prefix, drop one leading "@",
 * and cut any /path, ?query or #fragment tail. Deliberately does NOT
 * validate the result — the server owns the shape rules; this only cleans.
 */
export function normalizeHandleInput(raw: string, network: SocialNetwork): string {
  let v = raw.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  const lower = v.toLowerCase()
  for (const prefix of network.strip) {
    if (lower.startsWith(prefix)) {
      v = v.slice(prefix.length)
      break
    }
  }
  v = v.replace(/^@/, '')
  return v.split(/[/?#]/)[0].trim()
}

export function socialUrl(network: SocialNetwork, handle: string): string {
  return network.urlBase + encodeURIComponent(handle)
}
