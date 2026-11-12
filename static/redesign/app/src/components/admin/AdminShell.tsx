// The admin page's frame: a menu of its sections, in groups, and the one
// section that is open. A column beside the section on a wide screen; a strip
// above it, scrolling sideways, on a narrow one.
//
// One section is mounted at a time: each loads its own data when it opens,
// and two of them poll.

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { PageHeader } from '@/components/PageHeader'

export type AdminSection =
  | 'dashboard'
  | 'users' | 'requests' | 'rooms'
  | 'libraries' | 'flagged'
  | 'sessions' | 'health'
  | 'activity' | 'logs' | 'server' | 'llm' | 'oauth' | 'backup'

interface AdminGroup {
  /** The heading the group is listed under; none for the page's first entry. */
  title: string | null
  sections: readonly { id: AdminSection; label: string }[]
}

/** Every admin section, in menu order, under the heading it is listed by. */
export const ADMIN_GROUPS: readonly AdminGroup[] = [
  { title: null, sections: [{ id: 'dashboard', label: 'Overview' }] },
  { title: 'People', sections: [
    { id: 'users', label: 'Users' },
    { id: 'requests', label: 'Requests' },
    { id: 'rooms', label: 'Rooms' },
  ] },
  { title: 'Library', sections: [
    { id: 'libraries', label: 'Libraries' },
    { id: 'flagged', label: 'Flagged items' },
  ] },
  { title: 'Playback', sections: [
    { id: 'sessions', label: 'Active streams' },
    { id: 'health', label: 'Playback health' },
  ] },
  { title: 'System', sections: [
    { id: 'activity', label: 'Activity' },
    { id: 'logs', label: 'Logs' },
    { id: 'server', label: 'Server settings' },
    { id: 'llm', label: 'AI providers' },
    { id: 'oauth', label: 'Sign-in providers' },
    { id: 'backup', label: 'Backup and restore' },
  ] },
]

export const ADMIN_SECTIONS: readonly { id: AdminSection; label: string }[] = ADMIN_GROUPS.flatMap(g => g.sections)

export const adminSectionLabel = (id: AdminSection): string => ADMIN_SECTIONS.find(s => s.id === id)?.label ?? id

const itemClass = (current: boolean) =>
  `flex h-11 flex-none items-center whitespace-nowrap rounded-control px-3.5 text-left text-[15px] transition-colors lg:w-full ${
    current ? 'bg-surface-raised-2 font-semibold text-ink' : 'font-medium text-ink-2 hover:bg-surface-raised hover:text-ink'
  }`

export function AdminShell({ current, onSection, children }: {
  current: AdminSection
  onSection: (section: AdminSection) => void
  children: ReactNode
}) {
  const ids = useId()
  // On a narrow screen the menu is a strip that scrolls sideways: bring the
  // open section's name into view, or the page opens on a strip that does
  // not show where you are.
  const currentRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [current])

  return (
    <div className="animate-fade-in">
      <PageHeader title="Admin" />
      <div className="admin-shell lg:grid lg:grid-cols-[232px_minmax(0,1fr)] lg:items-start lg:gap-10">
        {/* These switch the section shown in place, and the page has one
            address, so they are buttons that say which is current, not
            links. */}
        <nav
          aria-label="Admin sections"
          // `relative`: the groups' names are visually hidden in the strip,
          // which makes them absolutely positioned. Without a positioned
          // scroller they are placed against the page, far to the right in
          // the strip's unscrolled width, and widen the page on a phone.
          //
          // The strip scrolls sideways and the column scrolls down, so each
          // clips on its other axis too: the padding all round (taken back
          // by the margin) is room for a focused entry's ring.
          //
          // The column sticks under the top bar AS MEASURED (--chrome-h): the
          // bar grows by a row for each library being scanned, and under a
          // fixed offset it covered the first entries. The column's height
          // comes off the same figure, so its last entry is reachable.
          className="scrollbar-hide relative -m-1 mb-5 flex gap-1 overflow-x-auto p-1 lg:sticky lg:top-[calc(var(--chrome-h,var(--topnav-h))_+_1.75rem)] lg:mb-0 lg:block lg:max-h-[calc(100vh_-_var(--chrome-h,var(--topnav-h))_-_2.5rem)] lg:overflow-y-auto"
        >
          {ADMIN_GROUPS.map((group, i) => (
            <div
              key={group.title ?? 'top'}
              role={group.title ? 'group' : undefined}
              aria-labelledby={group.title ? `${ids}-g${i}` : undefined}
              className="flex flex-none gap-1 lg:mb-5 lg:block lg:space-y-0.5"
            >
              {/* The groups' names take a line each in the column. In the
                  strip there is no room for them: a rule marks the break. */}
              {i > 0 && <span aria-hidden="true" className="mx-1 my-2 flex-none self-stretch border-l border-line lg:hidden" />}
              {group.title && (
                <p id={`${ids}-g${i}`} className="sr-only px-3.5 pb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-ink-2 lg:not-sr-only lg:block">
                  {group.title}
                </p>
              )}
              {group.sections.map(s => (
                <button
                  key={s.id}
                  type="button"
                  ref={s.id === current ? currentRef : undefined}
                  aria-current={s.id === current ? 'page' : undefined}
                  onClick={() => onSection(s.id)}
                  className={itemClass(s.id === current)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <section aria-labelledby={`${ids}-title`} className="min-w-0">
          <h2 id={`${ids}-title`} className="mb-5 font-display text-[22px] font-semibold leading-tight text-ink">
            {adminSectionLabel(current)}
          </h2>
          {children}
        </section>
      </div>
    </div>
  )
}
