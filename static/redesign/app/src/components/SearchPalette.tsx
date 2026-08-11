// Aurora V2 — Cmd+K search palette.
//
// Phase 5.3 final QA — Spotlight-style command palette that opens
// when the user hits ⌘K / Ctrl+K. The previous Cmd+K shortcut just
// focused the top-bar input, which works but doesn't feel like a
// product feature. This palette is its own surface: full-screen
// backdrop blur, a giant centered input, real-time results from
// /api/media/search with the X-Search-Mode badge surfaced when
// semantic search fires, arrow-key + Enter navigation. Aurora-
// themed glow effects + violet accents make it feel like part of
// the system, not a generic dropdown.
//
// Design contract:
//   - open=true mounts the palette as a fixed inset-0 overlay
//   - open=false unmounts (no animation state preserved — the next
//     open starts with an empty query)
//   - debounced 250ms search (cheap on Postgres trigram but still
//     polite — don't fire on every keystroke)
//   - ↑↓ keys move highlight; ⏎ selects; Esc closes; click overlay
//     outside the panel also closes
//   - selection invokes onSelect with the chosen Media; caller
//     decides whether to open detail, play, etc.

import { useEffect, useRef, useState } from 'react'
import { lockBodyScroll } from '@/lib/scrollLock'
import { searchStatusMessage } from '@/lib/searchStatus'
import { searchMedia, type UIMedia } from '@/lib/api'
import { Icon } from '@/components/Icon'

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (m: UIMedia) => void
  // Optional initial query to seed the input when opening from a
  // partial type-ahead (e.g. user typed "fam" in the top bar then
  // hit Cmd+K — we could pre-fill). Defaults to empty.
  initialQuery?: string
}

const LISTBOX_ID = 'palette-results'
const optionId = (mediaId: number | string) => `palette-opt-${mediaId}`

export function SearchPalette({ open, onClose, onSelect, initialQuery = '' }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Phase 9 — the panel needs a ref for the Tab trap below. It declared
  // aria-modal="true" with no trap, no opener capture and no scroll lock.
  const panelRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<UIMedia[]>([])
  const [mode, setMode] = useState<'literal' | 'semantic'>('literal')
  const [loading, setLoading] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  // The query the CURRENT `results` actually belong to. `loading` cannot answer
  // that: it lags the render by one commit, so on the first keystroke of a search
  // the component renders with the new query, `loading` still false and `results`
  // still the previous array — which is how the live region came to announce
  // "No matches" as the opening line of every search. See searchStatus below.
  const [settled, setSettled] = useState('')
  // Ref into the scrollable results list so we can keyboard-scroll
  // the highlighted row into view if the user arrow-keys past the
  // visible window.
  const listRef = useRef<HTMLDivElement | null>(null)

  // Focus the input on every open. autoFocus on the input only
  // works on first mount; this effect handles re-opens too. setTimeout
  // hop ensures the element is in the DOM and laid out before focus
  // (avoids a Safari quirk where focus() fires before render).
  useEffect(() => {
    if (!open) {
      // Reset state on close so a re-open is a clean slate.
      setQuery(initialQuery)
      setResults([])
      setHighlighted(0)
      return
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open, initialQuery])

  // Debounced search. AbortController cancels in-flight requests on
  // each new keystroke so we don't race-condition the result list.
  useEffect(() => {
    if (!open) return
    if (!query.trim()) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const ac = new AbortController()
    const handle = window.setTimeout(async () => {
      try {
        const res = await searchMedia(query, 12, ac.signal)
        setResults(res.items)
        setMode(res.mode)
        setHighlighted(0)
        setSettled(query.trim())
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        setResults([])
        setSettled(query.trim())
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => {
      window.clearTimeout(handle)
      ac.abort()
    }
  }, [query, open])

  // Keyboard nav while palette is open. Bound to window so the
  // user doesn't have to keep focus on the input to navigate.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlighted(h => Math.min(h + 1, Math.max(0, results.length - 1)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlighted(h => Math.max(0, h - 1))
        return
      }
      if (e.key === 'Enter') {
        // Only act when focus is NOT on a result row. This handler is bound at
        // the WINDOW, so it used to fire for a row the user had reached with Tab
        // and open `results[highlighted]` — a DIFFERENT title from the one they
        // were on. The row's own onClick is the correct handler in that case, and
        // letting the event reach it is the fix; `preventDefault` here was what
        // stopped it.
        const onRow = (document.activeElement as HTMLElement | null)?.closest?.('[data-row]')
        if (onRow) return
        if (results[highlighted]) {
          e.preventDefault()
          onSelect(results[highlighted])
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, results, highlighted, onClose, onSelect])

  // Opener capture + scroll lock, keyed on `open` ALONE — and that separation is
  // the entire point of this being its own effect.
  //
  // Phase 9 put both of these inside the keyboard effect above, whose deps are
  // `[open, results, highlighted, onClose, onSelect]`. Every one of those changes
  // constantly: `results` gets a new array identity on each fetch AND on each
  // query-clear, `highlighted` changes on every arrow press, and `onClose`/
  // `onSelect` are inline arrows at App's call site so they change on every App
  // render. The cleanup therefore ran continuously, and it called
  // `o.focus()` — dragging focus to an element OUTSIDE the modal.
  //
  // That made the palette unusable, and it fired before the user could type a
  // single character: opening it calls setResults([]), which re-renders, which
  // re-runs the effect, whose cleanup rips focus back to the opener. Measured in
  // Chromium — opened from the nav's search button, focus ended on that button and
  // the palette input stayed empty. Worse in the flow App deliberately whitelists
  // ("Allow Cmd+K from inside our own top-bar search input"): the user's typing
  // went into the input BEHIND a full-viewport modal. The only path that worked
  // was Cmd+K with nothing focused, and only because body.focus() is a no-op.
  //
  // The correct pattern was already in this repo, twice, with a comment saying
  // exactly why: ProfilesGate keys its identical opener-capture effect on `[open]`
  // alone — "Deliberately keyed on `open` only: re-running when activeProfileId
  // changes would yank focus mid-interaction" — and VideoPlayer does the same with
  // `[target]`. Phase 9 reintroduced the failure Phase 7b had documented.
  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement as HTMLElement | null
    const releaseLock = lockBodyScroll()
    return () => {
      releaseLock()
      const o = openerRef.current
      openerRef.current = null
      // Only if it is still in the document — selecting a result navigates, which
      // can unmount the card the palette was opened from.
      if (o && o.isConnected) o.focus({ preventScroll: true })
    }
  }, [open])

  // Scroll the highlighted row into view after arrow-key nav.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    const row = list.querySelector<HTMLElement>(`[data-row="${highlighted}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, open])

  if (!open) return null

  // The listbox element is rendered iff there are options to put in it, and
  // `aria-expanded` tracks exactly that — see the note at the combobox.
  const expanded = results.length > 0

  // Extracted to lib/searchStatus and unit-tested. A reviewer showed six
  // simultaneous mutations to everything this phase added left the whole gate
  // green; this is the one piece that is pure enough to actually pin, and it is
  // also the piece that already went wrong once.
  const searchStatus = searchStatusMessage({ query, loading, settled, count: results.length, smart: mode === 'semantic' })

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[14vh] px-4 animate-fade-in"
      onClick={(e) => {
        // Click outside the panel closes. The backdrop below is a
        // covering child, so target !== currentTarget for backdrop
        // clicks too — check panel containment instead.
        if (!panelRef.current?.contains(e.target as Node)) onClose()
      }}
    >
      {/* Backdrop — deep blur + violet tint so the page beneath
          feels far away. */}
      <div className="absolute inset-0 bg-[#050505]/85 backdrop-blur-xl" aria-hidden="true" />

      {/* Aurora-violet glow blobs behind the palette so the
          backdrop isn't a flat sheet of blur. Decorative only. */}
      <div className="absolute top-[10vh] left-1/2 -translate-x-1/2 w-[700px] h-[700px] rounded-full bg-purple-600/[0.12] blur-[120px] pointer-events-none" aria-hidden="true" />
      <div className="absolute top-[30vh] left-[20%] w-[400px] h-[400px] rounded-full bg-fuchsia-500/[0.08] blur-[100px] pointer-events-none" aria-hidden="true" />

      {/* Palette panel */}
      <div
        // 760px, up from max-w-2xl (672). The result rows carry a poster, a
        // title, a meta line and a ⏎ hint; at 672 the meta line was the first
        // thing to truncate on ordinary titles.
        ref={panelRef}
        className="relative w-full max-w-[760px] rounded-2xl border border-purple-500/20 bg-[#0a0a0f]/90 backdrop-blur-2xl shadow-[0_20px_80px_-10px_rgba(168,85,247,0.35)] overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Search Aurora"
        // onKeyDownCapture on the panel is not enough on its own if focus has
        // escaped the panel entirely, which is what the mousedown fix above
        // prevents. Kept here rather than moved to the document because with the
        // mousedown fix focus cannot leave the combobox by pointer, and a
        // document-level trap would have to re-derive whether the palette owns the
        // event — more moving parts for the same result.
        onKeyDown={e => {
          // Tab trap. `aria-modal` is a hint to AT's virtual cursor and does
          // nothing whatsoever to the browser's tab ring, so without this Tab
          // walked out of a full-viewport overlay into TopNav and the page behind
          // it, painting a focus ring on content the user cannot see
          // (WCAG 2.4.3, and 2.4.11 Focus Not Obscured). Same first/last wrap
          // TopNav's mobile sheet and the profile gate use.
          if (e.key !== 'Tab') return
          const root = panelRef.current
          if (!root) return
          const f = root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])',
          )
          if (!f.length) return
          const first = f[0], last = f[f.length - 1]
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        }}
      >
        {/* Glow rim accent */}
        <div
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-purple-400/60 to-transparent pointer-events-none"
          aria-hidden="true"
        />

        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-300 flex-shrink-0">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Aurora — titles, vibes, anything…"
            // APG Combobox with a listbox popup (Phase 10). Before this the
            // palette was a combobox wearing no combobox semantics: no
            // `role="combobox"`, no listbox, no `aria-activedescendant`, no
            // `aria-selected`, no live region. A screen-reader user got an input
            // that silently changed a list they could not perceive — typing
            // produced silence, and arrowing produced silence, because the ONLY
            // difference between a highlighted row and its neighbours was a
            // background colour and a `⏎` glyph appended to its label.
            //
            // `aria-activedescendant` is the load-bearing piece. APG: "When a
            // descendant of a listbox … popup is focused, DOM focus remains on the
            // combobox and the combobox has `aria-activedescendant` set to a value
            // that refers to the focused element within the popup." That is exactly
            // this widget's existing behaviour — arrows move `highlighted` while
            // focus stays in the input — so the pattern fits without changing how
            // it works, only what it reports.
            role="combobox"
            // Both of these now track whether the LISTBOX ELEMENT is rendered,
            // which is what APG actually specifies — "When the popup element is
            // visible, aria-expanded is set to true" — not whether options exist.
            // The first version wired `expanded` to `results.length > 0` while the
            // listbox container was rendered unconditionally, so with an empty
            // query the combobox declared itself collapsed while pointing
            // `aria-controls` at a visible, laid-out 171px panel. JAWS suppresses a
            // collapsed combobox's controlled list from list navigation, so it
            // hid a panel the sighted user was looking at.
            // `aria-controls` is dropped rather than left dangling when collapsed.
            aria-expanded={expanded}
            aria-controls={expanded ? LISTBOX_ID : undefined}
            // The placeholder was the only accessible name this had. Placeholder-
            // as-label is the classic anti-pattern and APG's own combobox example
            // wires a real label; Phase 10 promoted this to a combobox and left it
            // unlabelled.
            aria-label="Search Aurora"
            aria-autocomplete="list"
            aria-activedescendant={results[highlighted] ? optionId(results[highlighted].id) : undefined}
            // 22px display type on the query, not 18px body. The query is the
            // subject of this overlay, so it gets the same treatment a page
            // title would. font-display + min-w-0 so the flex child can still
            // shrink — without min-w-0 a long query pushed the Esc key legend
            // off the panel's right edge, because an <input>'s default
            // min-width is `auto`, so it will not contract below its size
            // attribute's intrinsic width.
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-white font-display font-semibold text-[22px] tracking-tight placeholder:font-sans placeholder:font-normal placeholder:text-base placeholder-white/60 focus:ring-0"
            spellCheck={false}
            autoComplete="off"
          />
          {/* Mode badge — only after a real semantic result lands.
              "Smart" was overused on the V2 top bar (always-on
              static badge); here it's earned. */}
          {mode === 'semantic' && results.length > 0 && (
            <span className="stage-smartchip inline-flex flex-shrink-0">
              <Icon name="sparkle" size={12} />
              Smart
            </span>
          )}
          <kbd className="text-[10px] uppercase tracking-wider text-white/40 border border-white/10 rounded px-1.5 py-0.5 font-mono">Esc</kbd>
        </div>

        {/* Results */}
        {/* Result count, announced politely. Nothing told a screen-reader user that
            the list had populated or how big it was — the visible "Searching…"
            spinner being replaced by rows is a purely visual event.

            An earlier version of this comment claimed it was "keyed on the query so
            re-announcing happens per search rather than per keystroke". There is no
            `key` prop and never was. The behaviour is roughly right for a different
            reason — React diffs the identical "Searching" string across intermediate
            keystrokes, so no mutation and no re-announcement — but that is a
            measured accident of the string, not a mechanism I built.

            `aria-atomic` because this repo already documents needing it for the same
            message shape (SearchView: "so the whole sentence is re-read rather than
            just the changed number, which otherwise announces as a bare '12'"). The
            first version made the opposite choice here with no note explaining why,
            which is the kind of inconsistency that reads as a decision when it was
            an omission. */}
        {/* `settled`, not `loading`. `loading` lags the render by one commit —
            onChange re-renders with the new query while loading is still false and
            results is still the PREVIOUS array — so the first keystroke of every
            search announced "No matches for b" before "Searching", and flashed the
            empty state visually for a frame. Comparing the query the results
            actually belong to is the honest test, and it also covers the
            `initialQuery` case, where the region was INSERTED into the DOM already
            containing the false string. */}
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {searchStatus}
        </p>

        {/* The SCROLLER is not the listbox. Keeping `listRef` here (the
            scroll-into-view effect measures against it) and putting the listbox
            inside is what lets the listbox exist only when it has options. */}
        <div
          ref={listRef}
          className="max-h-[55vh] overflow-y-auto"
        >
          {!query.trim() && (
            <div className="px-5 py-10 text-center">
              <p className="text-white/50 text-sm">Start typing to search your library.</p>
              <p className="text-white/30 text-xs mt-2">
                Try <span className="text-purple-300">a title</span>, <span className="text-purple-300">an actor</span>, or <span className="text-purple-300">a vibe</span> like "rainy night noir".
              </p>
              <div className="mt-6 flex items-center justify-center gap-2 text-white/30 text-[11px]">
                <kbd className="border border-white/10 rounded px-1.5 py-0.5 font-mono">↑</kbd>
                <kbd className="border border-white/10 rounded px-1.5 py-0.5 font-mono">↓</kbd>
                <span>navigate</span>
                <span className="text-white/20 mx-1">·</span>
                <kbd className="border border-white/10 rounded px-1.5 py-0.5 font-mono">⏎</kbd>
                <span>select</span>
                <span className="text-white/20 mx-1">·</span>
                <kbd className="border border-white/10 rounded px-1.5 py-0.5 font-mono">Esc</kbd>
                <span>close</span>
              </div>
            </div>
          )}

          {query.trim() && loading && results.length === 0 && (
            <div className="px-5 py-8 flex items-center justify-center gap-3">
              <span className="w-3 h-3 rounded-full border-2 border-purple-300 border-t-transparent animate-spin" />
              <span className="text-white/50 text-sm">Searching…</span>
            </div>
          )}

          {query.trim() && !loading && results.length === 0 && (
            <div className="px-5 py-8 text-center">
              <p className="text-white/50 text-sm">No matches for "{query}"</p>
              <p className="text-white/30 text-xs mt-1">Check spelling or try a broader phrase.</p>
            </div>
          )}

          {/* `role="listbox"` wraps ONLY the options. It previously wrapped the
              hint block, the "Searching…" line and the "No matches" block too —
              ARIA requires a listbox to own `option` or `group` and nothing else,
              and Chromium does not repair it: it hung fourteen orphaned text nodes
              straight off the listbox.
              That was not merely untidy. A combobox with `aria-activedescendant`
              inside an `aria-modal` dialog puts NVDA and JAWS into focus mode,
              where the virtual cursor is off — so everything in that container
              became unreachable, including the app's ONLY documentation of its own
              keyboard model (↑↓ navigate / ⏎ select / Esc close) and the only
              recovery advice on a failed search. Before Phase 10 those sat in a
              plain div a browse-mode user could arrow through. The commit whose
              thesis was discoverability made them undiscoverable. */}
          {expanded && (
          <div id={LISTBOX_ID} role="listbox" aria-label="Search results" aria-busy={loading || undefined}>
          {results.map((m, i) => (
            // `role="option"` on a div, not a <button>. Options are not buttons in
            // ARIA, and the change fixes a real behavioural problem as well as a
            // semantic one: as tabbable buttons these rows created THREE competing
            // cursors — Tab moved DOM focus, the arrows moved `highlighted`, and
            // hover moved it again — so the `⏎` affordance could advertise on a row
            // that Enter would not act on. Phase 9 patched the symptom by making
            // Enter defer to a Tab-focused row; the combobox pattern removes the
            // second cursor entirely, because focus never leaves the input. The
            // `data-row` attribute and that Enter guard stay as belt-and-braces,
            // but the branch is now unreachable.
            <div
              key={m.id}
              id={optionId(m.id)}
              role="option"
              aria-selected={i === highlighted}
              data-row={i}
              // preventDefault on mousedown, and this is a focus fix, not a text fix.
              //
              // `<div>` text is selectable where `<button>` text is not, so once the
              // rows stopped being buttons a mousedown-drag across two of them
              // selected their text AND blurred the input — leaving
              // `document.activeElement === document.body`, which is OUTSIDE the
              // panel. The Tab trap is bound to the panel's onKeyDown, so it stopped
              // firing entirely: the next two Tabs walked into TopNav's logo and Home
              // tab, painting a focus ring on chrome behind a full-viewport
              // aria-modal overlay (WCAG 2.4.3, 2.4.11) — the exact failure Phase 9
              // added the trap to prevent. On the button version this was
              // unreachable, because mousedown focused the row.
              // Suppressing the default mousedown behaviour keeps focus in the
              // combobox, where this pattern requires it to stay, and removes the
              // stray selection as a side effect. Click still fires.
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setHighlighted(i)}
              onClick={() => { onSelect(m); onClose() }}
              // No focus utility: these are `role="option"` and deliberately not
              // focusable — DOM focus stays in the combobox. The
              // `focus-visible:[outline-offset:-2px]` that was here became dead the
              // moment they stopped being buttons.
              className={`w-full flex items-center gap-4 px-5 py-3 text-left transition-colors cursor-pointer ${
                i === highlighted
                  ? 'bg-purple-500/15 border-l-2 border-purple-400'
                  : 'border-l-2 border-transparent hover:bg-white/[0.03]'
              }`}
            >
              {m.poster ? (
                <img
                  src={m.poster}
                  alt=""
                  className="w-10 h-14 rounded object-cover flex-shrink-0 ring-1 ring-white/10"
                  loading="lazy"
                />
              ) : (
                <div className="w-10 h-14 rounded bg-white/[0.05] border border-white/10 flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-white text-sm font-medium truncate">{m.title}</div>
                <div className="text-white/40 text-xs flex items-center gap-2">
                  {m.year > 0 && <span>{m.year}</span>}
                  {m.genre && <span>· {m.genre}</span>}
                  <span className="text-white/30 uppercase">· {m.type === 'show' ? 'Series' : 'Movie'}</span>
                </div>
              </div>
              {i === highlighted && (
                // aria-hidden: this glyph is a visual echo of aria-selected, and
                // without it the option's accessible name gained a trailing "⏎"
                // that a reader announced as "return" on exactly one row.
                <kbd aria-hidden="true" className="text-[10px] uppercase tracking-wider text-purple-200 border border-purple-500/30 rounded px-1.5 py-0.5 font-mono">⏎</kbd>
              )}
            </div>
          ))}
          </div>
          )}
        </div>
      </div>
    </div>
  )
}
