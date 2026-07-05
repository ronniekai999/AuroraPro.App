// Shared Suspense wrapper for the lazy-loaded view chunks (AdminView,
// SettingsView, …). One wrapper → one consistent fallback across every
// route, and one place to change it. Per-view overrides pass `fallback`
// (e.g. browse passes <BrowseLoadingState> so the chunk-load fallback
// looks identical to the data-load fallback — no two-phase flash).
//
// ViewFallback mirrors BrowseLoadingState's aesthetic (animate-fade-in,
// the same white/60 secondary text + font-display + the purple accent)
// so a chunk fetch reads as the app's own loading state, not a generic
// spinner. It's intentionally minimal: a branded mark + a one-word
// label. The full browse skeleton is BrowseLoadingState's job.

import { Suspense, type ReactNode } from 'react'

export function ViewFallback() {
  return (
    <div className="animate-fade-in flex min-h-[60vh] flex-col items-center justify-center gap-4">
      {/* Aurora mark — ink plate + the same pulse cadence as
          BrowseLoadingState's skeleton cards. aria-hidden because the
          "Loading…" label below is the accessible name; the mark is
          decorative, same rationale as <Icon>. */}
      <div
        className="flex h-12 w-12 items-center justify-center border border-[var(--ink)] bg-[var(--stock)] animate-pulse"
        aria-hidden="true"
      >
        <span className="font-display text-xl font-bold text-[var(--ink)]">A</span>
      </div>
      <p className="text-sm text-[var(--ink-2)]">Loading…</p>
    </div>
  )
}

export function ViewSuspense({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  return <Suspense fallback={fallback ?? <ViewFallback />}>{children}</Suspense>
}