// The Settings page's frame: the list of sections on the left (a strip above
// the content on a narrow screen) and one section beside it. "Your profile"
// is a page of its own (/profile) that sits in the same list, so it uses this
// frame too and the two read as one place.

import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { SETTINGS_PANES, settingsPath, type SettingsPane } from '@/lib/settingsPanes'

export type SettingsPlace = SettingsPane | 'your-profile'

const itemClass = (current: boolean) =>
  `flex h-11 flex-none items-center whitespace-nowrap rounded-control px-3.5 text-left text-[15px] transition-colors lg:w-full ${
    current ? 'bg-surface-raised-2 font-semibold text-ink' : 'font-medium text-ink-2 hover:bg-surface-raised hover:text-ink'
  }`

export function SettingsShell({ current, onPane, onOpenProfilePage, wide = false, children }: {
  current: SettingsPlace
  onPane: (pane: SettingsPane) => void
  /** Opens "Your profile". Left out for a session that is not offered that
   *  page (one acting as a profile with a content limit). */
  onOpenProfilePage?: () => void
  /** A section whose rows need more room than a column of text. */
  wide?: boolean
  children: ReactNode
}) {
  // On a narrow screen the list is a strip that scrolls sideways: bring the
  // current section's name into view, or the page opens on a strip that does
  // not show where you are.
  const currentRef = useRef<HTMLAnchorElement | null>(null)
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [current])

  // Links, with the address each section has, so one can be opened in a new
  // tab or copied. A plain press moves within the app; a press with a
  // modifier, or with another mouse button, is the browser's.
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  const item = (place: SettingsPlace, label: string, onClick: () => void) => (
    <a
      key={place}
      href={`${base}${place === 'your-profile' ? '/profile' : settingsPath(place)}`}
      ref={place === current ? currentRef : undefined}
      aria-current={place === current ? 'page' : undefined}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        onClick()
      }}
      className={itemClass(place === current)}
    >
      {label}
    </a>
  )
  // The account's own sections, then the ones about people.
  const [playback, app, account, profiles] = SETTINGS_PANES

  return (
    <div className="animate-fade-in">
      <PageHeader title="Settings" />
      <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start lg:gap-12">
        <nav
          aria-label="Settings sections"
          className="scrollbar-hide -mx-1 mb-6 flex gap-1 overflow-x-auto px-1 pb-1 lg:sticky lg:top-24 lg:mx-0 lg:mb-0 lg:flex-col lg:overflow-visible lg:p-0"
        >
          {[playback, app, account].map(p => item(p.id, p.label, () => onPane(p.id)))}
          <span aria-hidden="true" className="mx-1 my-2 w-px flex-none self-stretch bg-line lg:mx-0 lg:h-px lg:w-full" />
          {onOpenProfilePage && item('your-profile', 'Your profile', onOpenProfilePage)}
          {item(profiles.id, profiles.label, () => onPane(profiles.id))}
        </nav>
        <div className={`min-w-0 ${wide ? 'max-w-[880px]' : 'max-w-[760px]'}`}>{children}</div>
      </div>
    </div>
  )
}
