import { createRoot } from 'react-dom/client'
import './index.css'
import { AppRoot } from './AppRoot'
import { installDiagnosticBuffer } from './lib/diagnosticBuffer'
import { installSyncDebug } from './lib/syncDebug'
import { initPWA } from './lib/pwa'
import { currentReduceEffects, reflectReduceEffects } from './lib/appearance'

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

// PWA boot: capture the browser install prompt (the listener must be attached
// before Chrome can fire it, which happens early on repeat visits) and
// register the push-only service worker. Both are contained best-effort —
// see lib/pwa.ts; nothing here can affect app startup.
initPWA()

// Scroll position across history entries is restored by App (per entry,
// after the destination view has committed) rather than by the browser.
// Native restoration runs on popstate while the OUTGOING view is still
// mounted: it clamps to that document's height, then the SPA re-renders
// under it — so Back from a title landed at the top of a Home you had
// scrolled six rails down. See App's scroll-memory layout effect.
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'

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

// Apply Reduce effects BEFORE first paint so the nav bar and panels never
// flash their blur on a machine whose owner turned it off. The read is
// guarded (a corrupt or missing blob reads as off), so nothing here can
// stop startup.
if (currentReduceEffects()) reflectReduceEffects(true)

// The tree itself (the error boundaries, the companion/desktop split and the
// update notice) is AppRoot; see AppRoot.tsx for why it is shaped as it is.
const rootEl = document.getElementById('root')!
createRoot(rootEl).render(<AppRoot basename={BASENAME} />)

// Retire the boot splash (index.html #boot-splash — the Photon wordmark that
// paints before the bundles arrive) once React has committed real DOM into
// #root. Observing the commit rather than "after render()" matters: under
// React 18 createRoot, render() returns before the first commit, so a naive
// removal here would re-expose the blank page the splash exists to cover.
// The ErrorBoundary fallback also commits children, so a first-render crash
// still clears the splash instead of hiding the error behind it.
{
  const splash = document.getElementById('boot-splash')
  if (splash) {
    const retire = () => {
      splash.classList.add('is-done')
      // Matches the 0.24s opacity transition in index.html; the element is
      // pointer-events:none throughout, so the wait can't swallow input.
      window.setTimeout(() => splash.remove(), 300)
    }
    if (rootEl.hasChildNodes()) {
      retire()
    } else {
      const mo = new MutationObserver(() => {
        if (rootEl.hasChildNodes()) {
          mo.disconnect()
          retire()
        }
      })
      mo.observe(rootEl, { childList: true })
    }
  }
}
