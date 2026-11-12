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
// The tile and its motion are `.stage-skel` in index.css (Stage refresh, L1):
// a slow lavender sheen instead of Tailwind's opacity pulse, the same sweep a
// card shows while its poster is in flight, so loading reads as one thing.
// Nulled under prefers-reduced-motion, so a reduced-motion user sees still tiles.
// The radius stays a utility here (the primitive sets none, so call sites can
// pass their own `rounded-*` and tailwind-merge resolves it).
//
// aria-hidden throughout: the surrounding view owns the accessible
// loading announcement (PageHeader's role="status" line, HomeView's live
// region), and a grid of decorative rectangles has nothing to add to it.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** One neutral pulsing block. Callers set the size and radius. */
export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('stage-skel rounded-xl', className)}
    />
  )
}

/** A card's caption while it loads: two bars in exactly the space the real
 *  caption takes (10px gap, a 14px/1.4 title line, 2px, a 16px facts line),
 *  so the row does not change height when the cards arrive. */
function CaptionSkeleton() {
  return (
    <div className="mt-2.5 h-[38px]">
      <SkeletonBlock className="mt-[3px] h-3.5 w-3/4 rounded-chip" />
      <SkeletonBlock className="mt-1.5 h-3 w-1/2 rounded-chip" />
    </div>
  )
}

/** The poster-grid skeleton: the same grid every content grid uses
 *  (.poster-grid), each tile a poster with its caption, so the real grid
 *  lands on top of it without a column, gutter or row-height shift. */
export function GridSkeleton({ count = 12, className, compact = false }: { count?: number; className?: string; compact?: boolean }) {
  return (
    <div aria-hidden="true" className={cn('poster-grid', compact && 'is-compact', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <SkeletonBlock className="aspect-[2/3] rounded-art" />
          <CaptionSkeleton />
        </div>
      ))}
    </div>
  )
}

/** The hero's shape (Stage refresh, L2): the real hero's frame — its height
 *  utilities, full bleed, the same gradient floor the placeholder had — with
 *  its content bottom-anchored at the page gutter over the real footer's
 *  `pb-9`, and (full size only) the match ring's disc top-right at the ring's
 *  own insets. So the pick arriving fills the shapes in instead of replacing
 *  a centred mark.
 *
 *  `title` replaces the title bars with real text (the browse pages know
 *  theirs before the list arrives) and `aside` takes the slot "Not tonight"
 *  will occupy. Both are the CALLER's: HeroSection renders this for every
 *  missing pick, which is also the permanent state of an empty library or a
 *  failed hero fetch, so what the frame says is not this component's to
 *  decide. The footer uses its own class string, not the real hero's:
 *  verify-page-alignment needs that one unique in HeroSection.tsx. */
export function HeroSkeleton({ compact = false, title, aside }: { compact?: boolean; title?: ReactNode; aside?: ReactNode }) {
  return (
    <section className={cn(
      'relative w-full overflow-hidden bg-gradient-to-br from-surface-raised via-surface-raised to-surface-page',
      compact ? 'h-[250px]' : 'h-[62vh] min-h-[480px] max-h-[680px]',
    )}>
      {!compact && (
        <SkeletonBlock className="absolute top-6 right-[var(--page-pad-x)] md:top-11 md:right-[calc(var(--page-pad-x)+4px)] h-[84px] w-[84px] rounded-full" />
      )}
      <div className="stage-gutter absolute inset-x-0 bottom-0 z-20 flex flex-col gap-4 pb-9 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1 max-w-2xl">
          {compact ? (
            <>
              <SkeletonBlock className="h-3.5 w-24 rounded-md mb-3" />
              {title ?? <SkeletonBlock className="h-10 w-[min(320px,70%)] rounded-lg mb-2.5" />}
              <SkeletonBlock className="h-4 w-[min(300px,80%)] rounded-md mb-4" />
              <div className="flex flex-wrap gap-3">
                <SkeletonBlock className="h-11 w-[104px] rounded-full" />
                <SkeletonBlock className="h-11 w-[124px] rounded-full" />
              </div>
            </>
          ) : (
            <>
              <SkeletonBlock className="h-7 w-[min(214px,60%)] rounded-full mb-3" />
              <SkeletonBlock className="h-4 w-[min(470px,85%)] rounded-md mb-3" />
              {title ?? (
                <div className="space-y-2.5 mb-4">
                  <SkeletonBlock className="h-11 md:h-16 w-[min(560px,92%)] rounded-xl" />
                  <SkeletonBlock className="h-11 md:h-16 w-[min(380px,64%)] rounded-xl" />
                </div>
              )}
              <SkeletonBlock className="h-4 w-[min(520px,88%)] rounded-md mb-5" />
              <div className="flex flex-wrap gap-3">
                <SkeletonBlock className="h-12 w-[118px] rounded-full" />
                <SkeletonBlock className="h-12 w-[132px] rounded-full" />
                <SkeletonBlock className="h-12 w-[150px] rounded-full" />
              </div>
            </>
          )}
        </div>
        {aside}
      </div>
    </section>
  )
}

/** A rail's shape: its wrapper, a title line, and a row of card-sized tiles
 *  at the rail's real card widths (176px poster, 256px landscape) and 20px
 *  gap, each with its caption. The row mirrors .rail-scroll's padding and the
 *  -4px margin that puts its first card on the gutter. It is clipped rather
 *  than scrolled: there is nothing to scroll to. */
export function RailSkeleton({ aspect = 'poster', count = 8, subtitle = false }: {
  aspect?: 'poster' | 'landscape'
  count?: number
  /** The rail this stands for has a line under its title (a recommender
   *  rail's "Picked by Aurora"): without it the rail lands one line taller
   *  than its skeleton and everything below it jumps. */
  subtitle?: boolean
}) {
  const tile = aspect === 'landscape' ? 'w-[256px]' : 'w-[176px]'
  const art = aspect === 'landscape' ? 'aspect-video' : 'aspect-[2/3]'
  return (
    <section className="rail-container" aria-hidden="true">
      {/* The title line: 22px at 1.2 leading, then the header's 8px margin. */}
      {/* With a subtitle: the header's 6px gap, then its 13px line at 18px
          leading, before the same 8px margin. */}
      <div className={subtitle ? 'mb-2 flex flex-col gap-1.5' : 'mb-2'}>
        <div className="flex h-[26px] items-center">
          <SkeletonBlock className="h-5 w-44 rounded-chip" />
        </div>
        {subtitle && (
          <div className="flex h-[18px] items-center">
            <SkeletonBlock className="h-3 w-64 max-w-full rounded-chip" />
          </div>
        )}
      </div>
      <div className="-mx-1 flex gap-5 overflow-hidden px-1 pb-3 pt-2">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className={cn('shrink-0', tile)}>
            <SkeletonBlock className={cn('rounded-art', art)} />
            <CaptionSkeleton />
          </div>
        ))}
      </div>
    </section>
  )
}

/** The title page's shape while its chunk or data loads: the hero with the
 *  title, the facts line and the action row at its foot, then the synopsis
 *  and a few rows, in one column. The hero and column classes are the ones
 *  DetailHero and DetailView use (`stage-detail-hero`, `stage-detail-herorow`,
 *  `stage-gutter pt-8 pb-16`, the 1304px measure), so the real page replaces
 *  this without moving. (verify-page-alignment counts those literals per
 *  FILE, so reusing them here is fine.) */
export function DetailSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="stage-detail-hero relative flex flex-col bg-surface-raised">
        {/* The hero's Back row, at its height, so the page below does not
            drop when the real hero replaces this. */}
        <div className="stage-gutter pt-3 lg:pt-4"><div className="h-11" /></div>
        <div className="relative mt-auto stage-gutter pb-2">
          <div className="stage-detail-herorow flex items-end gap-8 max-w-[1304px]">
            <SkeletonBlock className="hidden lg:block w-[176px] h-[264px] rounded-art flex-none" />
            <div className="flex-1 min-w-0 flex flex-col gap-3.5">
              <SkeletonBlock className="h-12 lg:h-16 w-[min(560px,80%)] rounded-lg" />
              <SkeletonBlock className="h-4 w-[min(360px,60%)] rounded-md" />
              <div className="flex flex-wrap gap-2">
                <SkeletonBlock className="h-11 w-full sm:w-40 rounded-full" />
                <SkeletonBlock className="h-11 w-28 rounded-control" />
                <SkeletonBlock className="h-11 w-28 rounded-control" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="stage-gutter pt-8 pb-16">
        <div className="flex flex-col gap-12 max-w-[1304px]">
          <div className="space-y-3 max-w-[820px]">
            <SkeletonBlock className="h-4 w-full rounded-md" />
            <SkeletonBlock className="h-4 w-[92%] rounded-md" />
            <SkeletonBlock className="h-4 w-[78%] rounded-md" />
          </div>
          <div className="space-y-3">
            <SkeletonBlock className="h-6 w-32 rounded-md" />
            <SkeletonBlock className="h-[72px] rounded-control" />
            <SkeletonBlock className="h-[72px] rounded-control" />
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
