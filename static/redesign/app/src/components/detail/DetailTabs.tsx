// Aurora V2 — DetailView underline tab bar (controlled).
//
// A lightweight controlled component, NOT the Radix ui/tabs primitive
// (whose pill skin doesn't match the underline look). Parent owns the
// active id and swaps the content below.
//
// Phase 9 — given the keyboard contract its roles were already promising.
// It declared `role="tablist"` + `role="tab"` with ZERO key handling and no
// roving tabIndex, which is the worse-than-nothing case: the roles tell a screen
// reader "this is a tab set, arrow keys will work" and put NVDA/JAWS into
// forms mode, at which point the arrow keys the user now expects do nothing and
// the reader has stopped offering its own navigation in exchange. Every tab was
// also its own tab stop, so Tab walked through all of them instead of past the set.
//
// `AdminView`'s tab strip already implemented this correctly a phase earlier;
// this is the same contract, ported. MANUAL activation (arrows move focus, Enter
// or Space selects) rather than automatic, per APG's recommendation for panels
// whose content is loaded or expensive — the detail panels swap real content.

import { useRef } from 'react'
import { cn } from '../../lib/utils'
import { nextRadioIndex } from '../../lib/radiogroup'

export interface DetailTab {
  id: string
  label: string
}

interface DetailTabsProps {
  tabs: DetailTab[]
  active: string
  onChange: (id: string) => void
  className?: string
}

export function DetailTabs({ tabs, active, onChange, className }: DetailTabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  // Where the roving tabIndex sits. It follows arrow keys independently of
  // `active`, which is what makes activation MANUAL: you can move across the set
  // and look before committing, and only Enter/Space swaps the panel.
  const focusedRef = useRef<number>(Math.max(0, tabs.findIndex(t => t.id === active)))

  // The single tab stop is the selected tab when focus is outside the set (so Tab
  // lands somewhere meaningful), and follows the arrow keys once inside.
  const selectedIndex = Math.max(0, tabs.findIndex(t => t.id === active))

  return (
    <div
      role="tablist"
      aria-label="Title sections"
      className={cn('flex items-center gap-7 border-b border-white/[0.08]', className)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          // Manual activation. The focused tab, not the selected one.
          const t = tabs[focusedRef.current]
          if (t) { e.preventDefault(); onChange(t.id) }
          return
        }
        // Left/Right/Home/End over a horizontal set. `nextRadioIndex` is the
        // shared APG movement arithmetic the Settings dials and the profile gate
        // already use — same wrap behaviour, one implementation.
        const n = nextRadioIndex(e.key, focusedRef.current, tabs.length)
        if (n === null) return
        e.preventDefault()
        focusedRef.current = n
        refs.current[n]?.focus()
      }}
    >
      {tabs.map((t, i) => {
        const on = t.id === active
        return (
          <button
            key={t.id}
            ref={el => { refs.current[i] = el }}
            type="button"
            role="tab"
            id={`detail-tab-${t.id}`}
            aria-selected={on}
            // Only the SELECTED tab's panel exists — DetailView renders one panel
            // at a time — so pointing every tab at a `detail-panel-*` id was a
            // dangling reference on all the inactive ones, which AT reports as a
            // broken relationship. Only claim it when the panel is really there.
            aria-controls={on ? `detail-panel-${t.id}` : undefined}
            tabIndex={i === selectedIndex ? 0 : -1}
            onFocus={() => { focusedRef.current = i }}
            onClick={() => { focusedRef.current = i; onChange(t.id) }}
            className={cn(
              'relative py-2.5 text-[0.95rem] font-semibold transition-colors',
              on ? 'text-white' : 'text-white/45 hover:text-white/80',
            )}
          >
            {t.label}
            {on && (
              // Purple → cyan, the mockup's active-tab gradient and the same
              // pair .stage-tab uses in the top nav, so the two tab systems
              // read as one language.
              <span className="absolute left-0 right-0 -bottom-px h-[3px] rounded-t-full bg-gradient-to-r from-purple-500 to-cyan-400 shadow-[0_0_12px_rgba(168,85,247,0.7)]" />
            )}
          </button>
        )
      })}
    </div>
  )
}
