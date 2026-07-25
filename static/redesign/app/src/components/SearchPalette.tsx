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

export function SearchPalette({ open, onClose, onSelect, initialQuery = '' }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<UIMedia[]>([])
  const [mode, setMode] = useState<'literal' | 'semantic'>('literal')
  const [loading, setLoading] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
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
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        setResults([])
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

  // Scroll the highlighted row into view after arrow-key nav.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    const row = list.querySelector<HTMLElement>(`[data-row="${highlighted}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[14vh] px-4 animate-fade-in"
      onClick={(e) => {
        // Click outside the panel closes. Stop propagation on the
        // panel itself in its own handler.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* Backdrop — deep blur + violet tint so the page beneath
          feels far away. Pointer-events on the parent overlay
          captures the close-on-outside click. */}
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
        className="relative w-full max-w-[760px] rounded-2xl border border-purple-500/20 bg-[#0a0a0f]/90 backdrop-blur-2xl shadow-[0_20px_80px_-10px_rgba(168,85,247,0.35)] overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Search Aurora"
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
            // 22px display type on the query, not 18px body. The query is the
            // subject of this overlay, so it gets the same treatment a page
            // title would. font-display + min-w-0 so the flex child can still
            // shrink — without min-w-0 a long query pushed the Esc key legend
            // off the panel's right edge, because an <input>'s default
            // min-width is `auto`, so it will not contract below its size
            // attribute's intrinsic width.
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-white font-display font-semibold text-[22px] tracking-tight placeholder:font-sans placeholder:font-normal placeholder:text-base placeholder-white/30 focus:ring-0"
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

          {results.map((m, i) => (
            <button
              key={m.id}
              data-row={i}
              onMouseEnter={() => setHighlighted(i)}
              onClick={() => { onSelect(m); onClose() }}
              className={`w-full flex items-center gap-4 px-5 py-3 text-left transition-colors ${
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
                <kbd className="text-[10px] uppercase tracking-wider text-purple-200 border border-purple-500/30 rounded px-1.5 py-0.5 font-mono">⏎</kbd>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
