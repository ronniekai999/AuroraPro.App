// Carry only the public TV code through an OAuth redirect. No device secret or session token is stored here.
const KEY = 'aurora_tv_approval_v1'
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/

export function rememberDevicePairing(pathname: string, search: string, now = Date.now()): void {
  if (pathname !== '/v2/device' && pathname !== '/v2/device/') return
  const code = new URLSearchParams(search).get('code')?.toUpperCase() ?? ''
  if (!CODE.test(code)) return
  try { sessionStorage.setItem(KEY, JSON.stringify({ code, expires: now + 10 * 60_000 })) } catch { /* Scan again if storage is unavailable. */ }
}

export function consumeDevicePairing(now = Date.now()): string | null {
  try {
    const saved = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    if (!saved) return null
    const entry: unknown = JSON.parse(saved)
    if (!entry || typeof entry !== 'object' || !('code' in entry) || !('expires' in entry)) return null
    if (typeof entry.code !== 'string' || typeof entry.expires !== 'number' || entry.expires <= now || !CODE.test(entry.code)) return null
    return entry.code
  } catch { return null }
}

// "Connect a TV with a code" followed, with no code in the address yet: the
// viewer is on the pairing page to sign in first. A password sign-in leaves
// them there; a provider's round trip comes back to the app's front page.
// So the intent is kept for this tab, as a time and nothing else: where it
// leads is fixed (the pairing page), and no value from the address is
// stored. It is used once, after the next sign-in, and forgotten on use, on
// sign-out, and after ten minutes.
const INTENT = 'aurora_tv_intent_v1'

export function rememberDeviceIntent(now = Date.now()): void {
  try { sessionStorage.setItem(INTENT, String(now + 10 * 60_000)) } catch { /* The link on the sign-in page is still there. */ }
}

export function consumeDeviceIntent(now = Date.now()): boolean {
  try {
    const saved = sessionStorage.getItem(INTENT)
    sessionStorage.removeItem(INTENT)
    return saved !== null && /^\d+$/.test(saved) && Number(saved) > now
  } catch { return false }
}

export function forgetDeviceIntent(): void {
  try { sessionStorage.removeItem(INTENT) } catch { /* nothing kept */ }
}
