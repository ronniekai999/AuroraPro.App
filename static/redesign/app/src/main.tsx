import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installDiagnosticBuffer } from './lib/diagnosticBuffer'

// 2026-05-27 — Install the diagnostic buffer as early as possible so
// the bug-report flow can attach "what was happening before the user
// clicked Report" (last 200 console messages + last 100 fetch
// requests + uncaught errors). Must run BEFORE any other module is
// imported that touches window.fetch / console — that's what the
// top-of-file placement guarantees. installDiagnosticBuffer() is
// idempotent + try/catch-wrapped internally; nothing here can break
// app startup even if the patches throw on an exotic browser.
installDiagnosticBuffer()

// Audit M4 fix (Phase 8) — basename is derived from Vite's
// `import.meta.env.BASE_URL` instead of hardcoded "/v2". This makes
// Vite's `base` config (`vite.config.ts`) the single source of truth
// for the SPA mount path — change it there and both the bundle's
// asset URLs AND React Router's basename move in lockstep. The
// `.replace(/\/$/, '')` strips the trailing slash because BASE_URL
// always ends with `/` (Vite invariant) but basename should not.
//
// Why basename matters: in-app `navigate('/movies')` would otherwise
// write `aurora.example/movies` to the URL bar (dropping `/v2/`), and
// refresh at that URL would 404 because the server only has routes
// under `/v2/*`. With basename set, navigate composes correctly.
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '')

// Apply the user's glow-style preference BEFORE first paint so panels
// and cards render with the correct border/halo on the very first
// frame. Default is "aurora" (white border + purple halo), defined as
// the unprefixed :root tokens in index.css — so we only set the
// attribute when the user has explicitly chosen "subtle" or "heavy".
try {
  const raw = localStorage.getItem('aurora_prefs')
  if (raw) {
    const parsed: unknown = JSON.parse(raw)
    const glow = parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).glow_intensity
      : null
    if (glow === 'subtle' || glow === 'heavy') {
      document.documentElement.setAttribute('data-glow', glow)
    }
  }
} catch { /* ignore — fall through to default */ }

// 2026-05-19 audit (FE-H1) — wrap the app in an ErrorBoundary so a
// render-time throw anywhere in the tree shows a fallback instead of
// a blank white page. The boundary is OUTSIDE BrowserRouter so a
// router-internal throw is still caught.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <BrowserRouter basename={BASENAME}>
      <App />
    </BrowserRouter>
  </ErrorBoundary>,
)
