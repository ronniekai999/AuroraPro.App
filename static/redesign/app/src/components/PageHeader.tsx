// Aurora Stage Phase 6 — the shared page header.
//
// Option B repeats one header block on five screens (Requests, My Library,
// Collections, Calendar, Search Results): an uppercase purple eyebrow, a 38px
// display title, a small subline, and an optional right-aligned action. Before
// this, all five carried their own copy — with four different title sizes
// (text-3xl on two, text-4xl on two, and one bare h1), two different eyebrow
// treatments, and subline colours ranging from white/40 to white/60. This is
// that block, once.
//
// Deliberately NOT generalised further: no `variant` prop, no slot for
// arbitrary children between title and sub. Every real call site wants exactly
// these four parts, and a header component that can render anything stops
// being the thing that keeps five pages consistent.

import { type ReactNode } from 'react'
import { cn } from '../lib/utils'

interface PageHeaderProps {
  // Short uppercase kicker ("Saved by you", "Curated", "Upcoming"). Optional:
  // Search Results has no natural eyebrow and looks wrong with a forced one.
  eyebrow?: ReactNode
  title: ReactNode
  // Count or status line under the title ("38 saved titles", "Next 30 days ·
  // 18 episodes"). ReactNode, not string — Phase 4 shipped `[object Object]`
  // to production by taking a string prop and interpolating a JSX fragment
  // into a template literal at the call site. Typing the prop as ReactNode is
  // what makes that mistake unrepresentable rather than merely discouraged.
  sub?: ReactNode
  // Right-aligned action (a page's one button, such as Together's). Wrapped in a
  // shrink-0 box here so a long title can never squeeze the button.
  action?: ReactNode
  className?: string
}

// No `as` escape hatch. An earlier version had `as?: 'h1' | 'h2'` documented as
// "Search Results renders inside a page that already has one, so it passes
// 'h2'" — no call site ever passed it, and Search Results has no competing h1.
// A prop that exists for a case that doesn't exist is one more thing that can
// drift; every page reached through App's router owns its own h1.
export function PageHeader({ eyebrow, title, sub, action, className }: PageHeaderProps) {
  return (
    // items-end so the action's baseline settles with the title's rather than
    // floating at the top of a two-line header. flex-wrap + gap so a narrow
    // viewport drops the action onto its own row instead of crushing it.
    <div className={cn('flex items-end justify-between gap-4 flex-wrap mb-5', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="stage-eyebrow mb-1.5">{eyebrow}</div>}
        {/* text-3xl below md, --fs-page (38px) from md up. The same two-step
            the home greeting uses, so the two headers agree at every width.
            leading-tight rather than the display tokens' sub-1.0 leading:
            these titles are one line and short, so there is no line-to-line
            ink collision to tune for and no clipping risk to pad against. */}
        <h1 className="font-display text-3xl md:type-page font-extrabold tracking-tight leading-tight text-white">
          {title}
        </h1>
        {sub && <div className="text-white/60 text-sm mt-1.5">{sub}</div>}
      </div>
      {/* max-w-full: never squeezed by the title, but never wider than the
          page either, so an action of several buttons can wrap on a phone
          instead of pushing the page sideways. */}
      {action && <div className="shrink-0 max-w-full">{action}</div>}
    </div>
  )
}
