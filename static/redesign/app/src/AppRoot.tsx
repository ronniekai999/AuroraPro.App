// The tree main.tsx renders, in its own module so its wiring can be tested
// (AppRoot.test.tsx) without main.tsx's boot side effects.
//
// 2026-05-19 audit (FE-H1) — the app sits in an ErrorBoundary so a render-time
// throw anywhere in the tree shows a fallback instead of a blank white page.
// The boundary is OUTSIDE BrowserRouter so a router-internal throw is still
// caught.
//
// 2026-05-30 — Watch Party Mobile Companion. The tree branches on the route
// INSIDE the router (paths are relative to the /v2 basename):
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
//
// <UpdateAvailableNotice/> sits above both branches, and OUTSIDE the app's
// boundary, behind one of its own that renders nothing if the notice itself
// fails. A tab left open across a deploy is running a build the server no
// longer has, wherever it is; and when a chunk of that build fails to load,
// the app's boundary replaces the app and asks for an update check, which only
// a notice still mounted can answer. Inside the boundary it unmounted with the
// rest of the app.

import { BrowserRouter, Routes, Route } from 'react-router'
import App from './App.tsx'
import { CompanionApp } from './companion/CompanionApp'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UpdateAvailableNotice } from './components/UpdateAvailableNotice'

export function AppRoot({ basename }: { basename: string }) {
  return (
    <>
      <ErrorBoundary fallback={() => null}>
        <UpdateAvailableNotice />
      </ErrorBoundary>
      <ErrorBoundary>
        <BrowserRouter basename={basename}>
          <Routes>
            <Route path="join" element={<CompanionApp />} />
            <Route path="join/:code" element={<CompanionApp />} />
            <Route path="*" element={<App />} />
          </Routes>
        </BrowserRouter>
      </ErrorBoundary>
    </>
  )
}
