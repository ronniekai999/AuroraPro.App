// Aurora Stage Phase 6 — the shared page header, and the filter-pill row
// that sits under it on Requests and My Library.
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
  // Right-aligned action ("Request New", "+ New Collection"). Wrapped in a
  // shrink-0 box here so a long title can never squeeze the button.
  action?: ReactNode
  // Set on pages whose title is the page's H1. Search Results renders inside
  // a page that already has one, so it passes 'h2'.
  as?: 'h1' | 'h2'
  className?: string
}

export function PageHeader({ eyebrow, title, sub, action, as = 'h1', className }: PageHeaderProps) {
  const Title = as
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
        <Title className="font-display text-3xl md:type-page font-extrabold tracking-tight leading-tight text-white">
          {title}
        </Title>
        {sub && <div className="text-white/60 text-sm mt-1.5">{sub}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export interface FilterPillOption<T extends string> {
  value: T
  label: string
  // Rendered in the pill's count chip. Omit for a pill that has no
  // meaningful count (My Library's All/Movies/TV Shows before any filtering
  // is applied, for instance) — the chip is then not rendered at all rather
  // than showing a 0 that looks like an empty result.
  count?: number
}

// The pill row from the mockup. Requests and My Library both had their own
// near-identical copy of this markup; the divergence had already started
// (Requests appended "(3)" as plain text inside the label, Library showed no
// counts at all).
//
// <button aria-pressed> rather than role="tab": these filter the list below
// them in place, they don't switch between panels, and tabs carry keyboard
// expectations (arrow-key navigation, one tab stop for the whole set) that
// this control does not implement. Toggle buttons are the honest role, and
// .stage-fpill styles the selected state off aria-pressed so the visual and
// the accessible state cannot drift apart.
export function FilterPills<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly FilterPillOption<T>[]
  value: T
  onChange: (v: T) => void
  // Names the group for screen readers ("Filter requests by status"). Without
  // it the pills announce as six unrelated toggle buttons.
  label: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex items-center gap-2 flex-wrap', className)}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className="stage-fpill inline-flex"
        >
          {o.label}
          {o.count !== undefined && <span className="c">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}
