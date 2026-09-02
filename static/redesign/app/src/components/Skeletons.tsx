// Skeletons — one loading vocabulary for the content views.
//
// Before this file the app had four: BrowseLoadingState's pulsing poster
// grid (the good one), ViewSuspense's centered "A" mark, two hand-rolled
// spinner <span>s, and plain text ("Loading your library…", "Loading
// details…"). Home, Search, My Library and Detail all fell into the last
// two, so each cold load collapsed to a line of text or a 60vh mark and
// then snapped to a full layout. These primitives keep the destination's
// SHAPE on screen while its data is in flight, so arrival fills in rather
// than replaces.
//
// Neutral tiles on purpose — NOT ui/skeleton.tsx (removed with the unused
// shadcn set), whose `bg-accent` was the saturated brand purple.
// `animate-pulse` is already nulled under prefers-reduced-motion by the
// global block in index.css, so a reduced-motion user sees still tiles.
//
// aria-hidden throughout: the surrounding view owns the accessible
// loading announcement (PageHeader's role="status" line, HomeView's live
// region), and a grid of decorative rectangles has nothing to add to it.

import { cn } from '@/lib/utils'

/** One neutral pulsing block. Callers set the size and radius. */
export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('bg-white/[0.03] border border-white/[0.04] animate-pulse rounded-xl', className)}
    />
  )
}

/** The poster-grid skeleton — the same column ladder every content grid
 *  uses (`grid-cols-2 sm:3 md:4 lg:5 xl:6 gap-5`), so the real grid lands
 *  on top of it without a column or gutter shift. */
export function GridSkeleton({ count = 12, className }: { count?: number; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5', className)}
    >
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonBlock key={i} className="aspect-[2/3]" />
      ))}
    </div>
  )
}

/** A home rail's shape: the glass shelf (.rail-container), a header line
 *  where the icon + title sit, and a row of card-sized tiles at the rail's
 *  real card widths (206px poster / 336px landscape) and 18px gap. The row
 *  is clipped rather than scrolled — nothing to scroll to. */
export function RailSkeleton({ aspect = 'poster', count = 8 }: { aspect?: 'poster' | 'landscape'; count?: number }) {
  const tile = aspect === 'landscape' ? 'w-[336px] aspect-video' : 'w-[206px] aspect-[2/3]'
  return (
    <section className="rail-container" aria-hidden="true">
      <div className="flex items-center gap-3.5 mb-3.5">
        <SkeletonBlock className="h-7 w-7 rounded-lg" />
        <SkeletonBlock className="h-5 w-44 rounded-md" />
      </div>
      <div className="flex gap-[18px] overflow-hidden px-1 py-2">
        {Array.from({ length: count }).map((_, i) => (
          <SkeletonBlock key={i} className={cn('shrink-0 rounded-[var(--r-lg)]', tile)} />
        ))}
      </div>
    </section>
  )
}

/** The detail page's shape while its chunk or data loads: the 58vh hero
 *  band, then the body grid — poster column with the action stack, and the
 *  tab strip plus storyline lines on the right. Class strings mirror
 *  DetailView / DetailRail so the real page replaces this without moving:
 *  `stage-gutter pt-9 pb-12` and the 216px grid template are the same
 *  literals the page uses. (verify-page-alignment counts those literals
 *  per FILE, so reusing them here is fine; duplicating them inside
 *  DetailView.tsx itself would not be.) */
export function DetailSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="relative h-[58vh] min-h-[440px] max-h-[560px] overflow-hidden bg-gradient-to-br from-purple-950/30 via-[#0a0a0f] to-[#050505]">
        <div className="absolute bottom-7 left-[var(--page-pad-x)] right-[var(--page-pad-x)] max-md:left-[18px] max-md:right-[18px] space-y-4">
          <SkeletonBlock className="h-4 w-24 rounded-md" />
          <SkeletonBlock className="h-12 w-[min(560px,80%)] rounded-lg" />
          <SkeletonBlock className="h-4 w-[min(360px,60%)] rounded-md" />
        </div>
      </div>
      <div className="stage-gutter pt-9 pb-12">
        <div className="grid grid-cols-1 lg:grid-cols-[216px_minmax(0,1fr)] gap-10">
          <div className="space-y-5 max-lg:hidden">
            <SkeletonBlock className="aspect-[2/3] rounded-2xl" />
            <div className="space-y-2.5">
              <SkeletonBlock className="h-12 rounded-full" />
              <SkeletonBlock className="h-11 rounded-full" />
              <SkeletonBlock className="h-10 rounded-xl" />
            </div>
          </div>
          <div className="space-y-6">
            <div className="flex gap-2">
              <SkeletonBlock className="h-9 w-24 rounded-full" />
              <SkeletonBlock className="h-9 w-24 rounded-full" />
              <SkeletonBlock className="h-9 w-28 rounded-full" />
            </div>
            <div className="space-y-3 max-w-3xl">
              <SkeletonBlock className="h-5 w-32 rounded-md" />
              <SkeletonBlock className="h-4 w-full rounded-md" />
              <SkeletonBlock className="h-4 w-[92%] rounded-md" />
              <SkeletonBlock className="h-4 w-[78%] rounded-md" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Text-line placeholder for a paragraph that is still loading (the detail
 *  storyline, an episode synopsis). */
export function TextSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  const widths = ['w-full', 'w-[92%]', 'w-[78%]', 'w-[85%]', 'w-[60%]']
  return (
    <div aria-hidden="true" className={cn('space-y-3 max-w-3xl', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBlock key={i} className={cn('h-4 rounded-md', widths[i % widths.length])} />
      ))}
    </div>
  )
}
