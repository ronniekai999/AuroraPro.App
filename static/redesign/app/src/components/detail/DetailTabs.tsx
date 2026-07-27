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
        // Left/Right/Home/End ONLY. `nextRadioIndex` also maps ArrowUp/ArrowDown
        // (a radiogroup is orientation-agnostic), and calling it unfiltered here
        // meant this HORIZONTAL tablist swallowed the vertical arrows and
        // preventDefault'ed them — so a keyboard user parked on a tab could no
        // longer scroll a long detail page with Up/Down; the arrows silently moved
        // tab focus sideways instead. `radiogroup.ts`'s own header says it is
        // "deliberately NOT generalised to tabs"; this generalised it anyway and
        // inherited the vertical bindings along with the horizontal ones.
        // APG's Tabs pattern specifies Left/Right for aria-orientation=horizontal,
        // and Up/Down only for a vertical set, which this is not.
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
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
            // Every tab keeps `aria-controls`, pointing at ONE stable id.
            //
            // Phase 9 first dropped it from inactive tabs, arguing a dangling
            // reference was worse. Measured against a real Chromium AX tree that was
            // wrong twice over: Chromium simply omits an unresolvable IDREF, so the
            // before/after tree for an inactive tab was IDENTICAL — the change was
            // neutral, not an improvement — and it left three of four tabs
            // off-pattern, since APG states "Each element with role `tab` has the
            // property `aria-controls` referring to its associated `tabpanel`".
            // JAWS' and NVDA's move-to-controlled-element command needs it.
            //
            // The real fix is the one neither version took: DetailView renders a
            // single panel whose id used to change identity on every tab switch
            // (`detail-panel-${activeTab}`), odd for AT caching on its own. It is
            // now the constant `detail-panel`, so all tabs resolve and nothing
            // dangles, while the panel's reciprocal `aria-labelledby` still names
            // the active tab.
            aria-controls="detail-panel"
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
