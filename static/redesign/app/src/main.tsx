import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router'
import './index.css'
import App from './App.tsx'
import { CompanionApp } from './companion/CompanionApp'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installDiagnosticBuffer } from './lib/diagnosticBuffer'
import { installSyncDebug } from './lib/syncDebug'
import { applyStoredAppearance } from './lib/appearance'

// 2026-05-27 — Install the diagnostic buffer as early as possible so
// the bug-report flow can attach "what was happening before the user
// clicked Report" (last 200 console messages + last 100 fetch
// requests + uncaught errors). Must run BEFORE any other module is
// imported that touches window.fetch / console — that's what the
// top-of-file placement guarantees. installDiagnosticBuffer() is
// idempotent + try/catch-wrapped internally; nothing here can break
// app startup even if the patches throw on an exotic browser.
installDiagnosticBuffer()

// Opt-in watch-party sync telemetry. Installs the window.auroraSyncDebug()
// / window.auroraSyncDump() console helpers and hydrates the on/off flag
// from localStorage. Off by default — the guest drift loop pays only a
// boolean read per tick until a user enables it to chase a sync bug.
installSyncDebug()

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

// Apply the user's appearance preferences (glow, typeface, film grain)
// BEFORE first paint so panels, type, and grain render correctly on the
// very first frame — no flash of the defaults. 2026-07-16 (Aurea
// Phase A): the two inline shims that used to live here re-implemented
// appearance.ts's allowlists and had to be kept in sync by hand — adding
// the VELVET typeface would have meant a third copy. Replaced with the
// exported applyStoredAppearance(), the same validated read the rest of
// the app uses. Behavior is identical: only non-default stored values
// set a data-* attribute; parse/storage failures fall through to the
// defaults.
applyStoredAppearance()

// 2026-05-19 audit (FE-H1) — wrap the app in an ErrorBoundary so a
// render-time throw anywhere in the tree shows a fallback instead of
// a blank white page. The boundary is OUTSIDE BrowserRouter so a
// router-internal throw is still caught.
//
// 2026-05-30 — Watch Party Mobile Companion. The tree now branches on
// the route INSIDE the router (paths are relative to the /v2 basename):
//   - /v2/join          → <CompanionApp/> (phone "second screen": the
//   - /v2/join/:code       mobile chat/voice/reactions shell; opens only
//                          the room socket, no video player). :code is a
//                          deep link (QR / server short-link 302s
//                          /join/CODE → /v2/join/CODE) that CompanionApp
//                          reads via useParams + auto-joins.
//   - everything else   → <App/> (the full desktop/SPA experience,
//                          unchanged — App owns its own internal routing
//                          off useLocation/useNavigate, so a single
//                          catch-all path="*" hands the whole rest of the
//                          URL space to it exactly as before).
// Splitting here (rather than inside App) keeps the heavy desktop tree
// — and its watch-party/player hooks — entirely unmounted on the phone.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <BrowserRouter basename={BASENAME}>
      <Routes>
        <Route path="join" element={<CompanionApp />} />
        <Route path="join/:code" element={<CompanionApp />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </ErrorBoundary>,
)
