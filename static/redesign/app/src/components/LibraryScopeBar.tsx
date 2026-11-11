// The Library's scope switcher: Movies, TV Shows, Collections, My Library and
// Upcoming are scopes of one destination. Each is still its own view with
// its own URL; this is the row that moves between them.

import { libraryScopesFor, type NavScope } from '@/lib/navScope'

export interface LibraryScopeBarProps {
  /** The view on screen. */
  current: string
  navScope: NavScope
  onNavigate: (view: string) => void
  onPrefetch?: (view: string) => void
}

export function LibraryScopeBar({ current, navScope, onNavigate, onPrefetch }: LibraryScopeBarProps) {
  const scopes = libraryScopesFor(navScope)
  // A scope the session is not offered can still be on screen (opened by
  // URL). With nothing to mark as current the row would mislead, and a
  // restricted session reaches Movies and Shows from the bar itself.
  if (navScope === 'restricted') return null
  return (
    <nav aria-label="Library" className="stage-gutter stage-scopebar flex">
      {scopes.map(s => (
        <button
          key={s.id}
          type="button"
          data-scope={s.id}
          aria-current={current === s.id ? 'page' : undefined}
          className="stage-scope"
          onClick={() => onNavigate(s.id)}
          onPointerEnter={() => onPrefetch?.(s.id)}
          onFocus={() => onPrefetch?.(s.id)}
        >
          {s.label}
        </button>
      ))}
    </nav>
  )
}
