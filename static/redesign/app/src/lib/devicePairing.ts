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
