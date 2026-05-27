// diagnosticBuffer.ts
//
// Captures the last N console messages + the last N network requests
// into in-memory ring buffers so the bug-report submission can attach
// "what was happening before the user clicked Report" without the user
// having to know about DevTools. Same pattern as Sentry / LogRocket /
// Highlight breadcrumbs.
//
// Design constraints:
//   - Install ONCE, as early as possible (App.tsx mount, before any
//     other JS runs). Libraries imported before install that captured
//     window.fetch will bypass us — that's an acceptable trade-off; we
//     install before React mounts to catch as much as possible.
//   - Patch console + fetch passthrough. Original methods always run
//     — we only OBSERVE, never block.
//   - Buffers are bounded; oldest entries are dropped silently as new
//     ones come in.
//   - Privacy: network URLs have known-sensitive query params
//     redacted. Bodies and headers are never captured.
//   - Errors in our interceptors must never crash the page — every
//     observation is wrapped in try/catch.
//
// Wire from App.tsx:
//   import { installDiagnosticBuffer, getDiagnosticBuffer } from '...'
//   installDiagnosticBuffer()  // at module top, before React mount
//
// The buffer is then read by submitBugReport before each submission.

export interface ConsoleEntry {
  ts: string           // ISO 8601
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  // Serialized message. Multi-arg console.log calls are joined with " ".
  // Capped at 1 KB to bound buffer memory.
  message: string
}

export interface NetworkEntry {
  ts: string           // ISO 8601 (request start)
  method: string       // GET / POST / etc.
  url: string          // sensitive query params redacted
  status: number       // 0 if the request errored before response
  durationMs: number   // total wall-clock time
  // Response body size hint from Content-Length when present, else 0.
  // We never read the body itself.
  responseSize: number
}

interface DiagnosticSnapshot {
  console: ConsoleEntry[]
  network: NetworkEntry[]
}

// Ring buffer caps. Console gets more entries because each is tiny;
// network capped lower because each entry includes a URL (potentially
// 100s of bytes) and we want to bound the payload size at ~50 KB.
const CONSOLE_MAX = 200
const NETWORK_MAX = 100

// Per-entry caps so a single huge log line can't dominate the buffer.
const CONSOLE_MESSAGE_MAX = 1024  // chars
const NETWORK_URL_MAX = 500       // chars

// Query parameters that almost certainly carry sensitive data.
// Redacted in captured URLs before storing in the network buffer.
// Conservative list — false positives are harmless (the param key is
// preserved; only the value becomes `[REDACTED]`).
const SENSITIVE_PARAMS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token',
  'password', 'pass', 'pwd', 'secret',
  'api_key', 'apikey', 'key',
  'authorization', 'auth',
  'code', 'state',                  // OAuth callback codes
  'sig', 'signature',
])

// Module-level state. Lazy-initialized on first install.
let installed = false
const consoleBuffer: ConsoleEntry[] = []
const networkBuffer: NetworkEntry[] = []

// Originals saved for passthrough. Kept module-private so test code
// can't accidentally call them directly; uninstall is intentionally
// not exposed (the buffer should run for the lifetime of the SPA).
const originalConsole: Partial<Record<ConsoleEntry['level'], (...args: unknown[]) => void>> = {}
let originalFetch: typeof window.fetch | null = null

// pushBounded drops the oldest entry when the buffer is full. Mutates
// in place — cheap and produces stable behavior under heavy logging.
function pushBounded<T>(arr: T[], item: T, max: number): void {
  arr.push(item)
  if (arr.length > max) {
    arr.shift()
  }
}

// safeStringify handles circular references, Error objects, undefined,
// and BigInt. console.log({ a: a }) where a holds a ref to itself
// should not throw. Returns a string capped at CONSOLE_MESSAGE_MAX.
function safeStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (value instanceof Error) {
    // Errors get name + message + a short stack tail.
    const stackTail = value.stack ? value.stack.split('\n').slice(0, 5).join('\n') : ''
    return `${value.name}: ${value.message}${stackTail ? '\n' + stackTail : ''}`
  }
  try {
    const seen = new WeakSet<object>()
    // Deep-debug M — bound total visited-object count so a deeply
    // nested but non-cyclic structure (AST, Promise chain, etc.) can't
    // exhaust the engine stack or produce a 10 MB console.log entry.
    // WeakSet alone only catches cycles, not depth. 500 nodes is plenty
    // for a debug log message; past that we degrade gracefully.
    let visited = 0
    const MAX_VISITED = 500
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]'
        visited++
        if (visited > MAX_VISITED) return '[Truncated]'
        seen.add(v)
      }
      if (typeof v === 'bigint') return `${v}n`
      if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`
      return v as unknown
    })
  } catch {
    // Some weird Proxy / native object refused to serialize. Fall back
    // to a tag string rather than crash the interceptor.
    return `[unserializable ${typeof value}]`
  }
}

// formatConsoleArgs joins multi-arg calls the way the browser would
// roughly display them (space-separated). Each arg is individually
// stringified; the result is capped to CONSOLE_MESSAGE_MAX.
function formatConsoleArgs(args: unknown[]): string {
  const out = args.map(safeStringify).join(' ')
  // Deep-debug M — Array.from splits by codepoint, not UTF-16 code unit,
  // so a 4-byte emoji at the boundary stays intact. `slice` on a string
  // would split the surrogate pair and leak through to backend.
  const chars = Array.from(out)
  if (chars.length > CONSOLE_MESSAGE_MAX) {
    return chars.slice(0, CONSOLE_MESSAGE_MAX).join('') +
      ` …(+${chars.length - CONSOLE_MESSAGE_MAX} chars)`
  }
  return out
}

// redactURL strips sensitive query parameters from a URL string.
// Returns the result capped at NETWORK_URL_MAX.
//
// Falls back to the input on parse failure (e.g. relative URLs with
// no base) — better to have an un-redacted relative path than nothing.
function redactURL(input: string): string {
  let result = input
  try {
    // Use document.baseURI so relative URLs parse. If we're in a
    // non-browser context (SSR / test) baseURI is undefined and the
    // URL constructor throws on a relative input — caught below.
    const base = typeof document !== 'undefined' ? document.baseURI : undefined
    const u = base ? new URL(input, base) : new URL(input)
    let mutated = false
    // Deep-debug H — basic-auth userinfo (user:secret@host) is treated
    // as sensitive by default. Wipe both fields unconditionally; the
    // resulting URL still tells the triager what host + path was hit.
    if (u.username || u.password) {
      u.username = ''
      u.password = ''
      mutated = true
    }
    u.searchParams.forEach((_, k) => {
      if (SENSITIVE_PARAMS.has(k.toLowerCase())) {
        u.searchParams.set(k, '[REDACTED]')
        mutated = true
      }
    })
    // Deep-debug H — OAuth implicit flows and SPA hash routes can put
    // access_token / id_token in the URL fragment (the `#...` part).
    // u.hash includes the leading `#`; parse what follows as a query
    // string so we can apply the same redaction list.
    if (u.hash.length > 1) {
      const hashBody = u.hash.slice(1)
      // Heuristic: only treat as params when `=` or `&` is present.
      // Pure hash routes like `#/movies/123` have neither and are kept.
      if (hashBody.includes('=') || hashBody.includes('&')) {
        const hashParams = new URLSearchParams(hashBody)
        let hashMutated = false
        hashParams.forEach((_, k) => {
          if (SENSITIVE_PARAMS.has(k.toLowerCase())) {
            hashParams.set(k, '[REDACTED]')
            hashMutated = true
          }
        })
        if (hashMutated) {
          u.hash = '#' + hashParams.toString()
          mutated = true
        }
      }
    }
    if (mutated) {
      // Preserve the original form when nothing was redacted, so we
      // don't lose URL.parse normalization differences.
      result = u.toString()
    }
  } catch {
    // Unparseable URL — return as-is. Worst case: an exotic URL with
    // a query string we don't redact. The tradeoff vs. dropping the
    // entire entry favors visibility for debugging.
  }
  // Deep-debug M — use Array.from(string) for the cap so a 4-byte
  // codepoint at the boundary doesn't leave an orphan surrogate. The
  // backend strips control chars but not lone surrogates, and Go's
  // json then re-encodes them as U+FFFD.
  const chars = Array.from(result)
  if (chars.length > NETWORK_URL_MAX) {
    return chars.slice(0, NETWORK_URL_MAX).join('') + '…'
  }
  return result
}

// installConsoleInterceptor patches each console method to record-
// then-passthrough. Already-installed → no-op.
function installConsoleInterceptor(): void {
  if (typeof console === 'undefined') return
  const levels: ConsoleEntry['level'][] = ['log', 'info', 'warn', 'error', 'debug']
  for (const level of levels) {
    const original = console[level]
    if (typeof original !== 'function') continue
    originalConsole[level] = original.bind(console)
    console[level] = (...args: unknown[]) => {
      try {
        pushBounded(consoleBuffer, {
          ts: new Date().toISOString(),
          level,
          message: formatConsoleArgs(args),
        }, CONSOLE_MAX)
      } catch {
        // Never let the interceptor itself break the page.
      }
      // Always passthrough so DevTools still shows the message.
      try {
        original.apply(console, args)
      } catch {
        // Some console methods can throw on certain args (rare).
      }
    }
  }
}

// installFetchInterceptor wraps window.fetch. Captures request +
// response metadata without touching the body. Errors during the
// fetch are recorded with status=0.
function installFetchInterceptor(): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
  originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!originalFetch) {
      // Should never happen — defensive against double-uninstall.
      throw new Error('fetch interceptor invoked with no original')
    }
    const startMs = performance.now()
    const ts = new Date().toISOString()
    // Resolve the URL string from the various input shapes.
    let urlStr = ''
    try {
      if (typeof input === 'string') urlStr = input
      else if (input instanceof URL) urlStr = input.toString()
      else if (input instanceof Request) urlStr = input.url
    } catch {
      urlStr = '[unknown]'
    }
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    try {
      const res = await originalFetch(input, init)
      try {
        const lenHeader = res.headers.get('content-length')
        const size = lenHeader ? parseInt(lenHeader, 10) || 0 : 0
        pushBounded(networkBuffer, {
          ts,
          method,
          url: redactURL(urlStr),
          status: res.status,
          durationMs: Math.round(performance.now() - startMs),
          responseSize: size,
        }, NETWORK_MAX)
      } catch {
        // Recording failed; the actual fetch succeeded so we still
        // return the response below.
      }
      return res
    } catch (err) {
      try {
        pushBounded(networkBuffer, {
          ts,
          method,
          url: redactURL(urlStr),
          status: 0,
          durationMs: Math.round(performance.now() - startMs),
          responseSize: 0,
        }, NETWORK_MAX)
      } catch { /* defensive */ }
      throw err
    }
  }
}

// installErrorHandlers captures uncaught errors + unhandled promise
// rejections as console-buffer entries at level "error" so they show
// up in the same place as regular logs. Doesn't replace any existing
// listeners; addEventListener is additive.
function installErrorHandlers(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (e) => {
    try {
      // Deep-debug L — route through formatConsoleArgs so the per-entry
      // CONSOLE_MESSAGE_MAX cap and surrogate-safe slicing apply. A
      // pathological stack trace would otherwise inflate the in-memory
      // buffer past the cap.
      const raw = `[uncaught] ${e.message || 'unknown'}` +
        (e.filename ? ` at ${e.filename}:${e.lineno}:${e.colno}` : '') +
        (e.error?.stack ? '\n' + e.error.stack.split('\n').slice(0, 5).join('\n') : '')
      pushBounded(consoleBuffer, {
        ts: new Date().toISOString(),
        level: 'error',
        message: formatConsoleArgs([raw]),
      }, CONSOLE_MAX)
    } catch { /* defensive */ }
  })
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const reason = e.reason
      const raw = reason instanceof Error
        ? `${reason.name}: ${reason.message}${reason.stack ? '\n' + reason.stack.split('\n').slice(0, 5).join('\n') : ''}`
        : safeStringify(reason)
      pushBounded(consoleBuffer, {
        ts: new Date().toISOString(),
        level: 'error',
        message: formatConsoleArgs([`[unhandled-rejection] ${raw}`]),
      }, CONSOLE_MAX)
    } catch { /* defensive */ }
  })
}

// installDiagnosticBuffer wires up all interceptors. Safe to call
// multiple times (subsequent calls are no-ops). Should be called as
// early as possible — ideally at the top of main.tsx before any
// other imports.
export function installDiagnosticBuffer(): void {
  if (installed) return
  installed = true
  try { installConsoleInterceptor() } catch { /* defensive */ }
  try { installFetchInterceptor() } catch { /* defensive */ }
  try { installErrorHandlers() } catch { /* defensive */ }
}

// getDiagnosticBuffer returns a SNAPSHOT of the current buffers.
// Callers receive copies; the underlying buffers continue to mutate
// in the background. Returns empty arrays when never installed.
export function getDiagnosticBuffer(): DiagnosticSnapshot {
  return {
    console: consoleBuffer.slice(),
    network: networkBuffer.slice(),
  }
}

// Test/debug helpers — exported because the test file lives next to
// this one and we want zero leak surface in regular consumers.
// Marked with leading underscore as the convention for "internal but
// reachable from tests."
export const _testing = {
  resetBuffers(): void {
    consoleBuffer.length = 0
    networkBuffer.length = 0
  },
  pushConsole(entry: ConsoleEntry): void {
    pushBounded(consoleBuffer, entry, CONSOLE_MAX)
  },
  pushNetwork(entry: NetworkEntry): void {
    pushBounded(networkBuffer, entry, NETWORK_MAX)
  },
  redactURL,
  safeStringify,
  consoleMax: CONSOLE_MAX,
  networkMax: NETWORK_MAX,
  consoleMessageMax: CONSOLE_MESSAGE_MAX,
}
