import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'

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
