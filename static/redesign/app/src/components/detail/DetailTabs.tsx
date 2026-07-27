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
// this is the same contract, ported — though the first port got two things wrong
// and a review measured both.
//
// AUTOMATIC activation, not the manual activation this shipped with. APG's
// criterion is LATENCY, verbatim: "It is recommended that tabs activate
// automatically when they receive focus as long as their associated tab panels are
// displayed without noticeable latency." I quoted that rule to justify manual and
// then applied a different test — "the detail panels swap real content" — which is
// not what it says. DetailView builds episodesNode, castNode and mediaNode
// unconditionally on every render and already renders all of them; switching tabs
// re-parents JSX that is
// ALREADY THERE. Zero fetch, zero latency, so automatic is what APG asks for.
// AdminView is manual for a reason it spells out — its tabs fire listAdminUsers /
// listAdminActivity / listAdminLogs and spin intervals up and down — and that
// justification does not transfer. I copied its conclusion without its premise.

import { useEffect, useRef, useState } from 'react'
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
  const selectedIndex = Math.max(0, tabs.findIndex(t => t.id === active))

  // STATE, not a ref. The previous version kept this in a `useRef` and rendered
  // `tabIndex={i === selectedIndex ? 0 : -1}`, so the tab stop tracked SELECTION
  // and never moved with focus — the roving tabIndex did not rove, while a comment
  // here claimed it "follows the arrow keys once inside". A ref cannot drive
  // `tabIndex`, because writing it does not re-render.
  //
  // APG is explicit about what has to happen: "set tabindex='-1' on the element
  // that has tabindex='0'. Set tabindex='0' on the element that will become
  // focused as a result of the key event." Measured failure without it: arrow to
  // "Media Info", Tab out to the panel, Shift+Tab back — focus lands on
  // "Overview", losing your place. AdminView gets this right because it uses
  // useState; this used a ref.
  const [focused, setFocused] = useState(selectedIndex)

  // Resync when the selection changes from outside the set — a deep link, or a
  // parent swapping tabs. Harmless when they already agree.
  useEffect(() => { setFocused(selectedIndex) }, [selectedIndex])

  return (
    <div
      role="tablist"
      aria-label="Title sections"
      className={cn('flex items-center gap-7 border-b border-white/[0.08]', className)}
      onKeyDown={e => {
        // Enter/Space still activate explicitly — harmless under automatic
        // activation, and it keeps the control usable if a future change makes a
        // panel expensive enough to want manual back.
        if (e.key === 'Enter' || e.key === ' ') {
          const t = tabs[focused]
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
        const n = nextRadioIndex(e.key, focused, tabs.length)
        if (n === null) return
        e.preventDefault()
        setFocused(n)
        refs.current[n]?.focus()
        // Automatic activation — see the note at the top of this file.
        onChange(tabs[n].id)
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
            tabIndex={i === focused ? 0 : -1}
            onFocus={() => setFocused(i)}
            onClick={() => { setFocused(i); onChange(t.id) }}
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
