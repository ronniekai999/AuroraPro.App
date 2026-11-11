// The app's navigation chrome: the top bar, and on phones the bottom tab bar.
//
// Top bar (md and up): the logo, the destinations, the search field, a
// live-presence pill, and ONE identity control. The identity control shows
// who is watching and opens the only account menu there is: switch profile,
// notifications, your profile, your requests, settings, admin, sign out.
//
// Phones: the top bar shrinks to the logo mark, the page's name and the
// presence pill; the destinations, search and the account page ("Me") are a
// bottom tab bar (BottomTabBar, rendered by App so it can sit outside the
// sticky stack).
//
// What a session is offered comes from `navScope` (lib/navScope), which App
// derives from the profile the SERVER has bound, and from `adminUI` (App's
// showsAdminUI verdict). Neither falls back to the account's role or to a
// remembered profile here.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AuroraWordmark } from '@/components/AuroraWordmark'
import { Icon } from '@/components/Icon'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import type { Profile, User as ApiUser } from '@/lib/api'
import { destinationForView, navDestinationsFor, profileSummary, type NavDestination, type NavScope } from '@/lib/navScope'
import { useExitTransition } from '@/hooks/useExitTransition'

export function AuroraMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="auroraMarkNav" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#A855F7" />
          <stop offset="0.55" stopColor="#7C3AED" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
      </defs>
      <circle cx="18" cy="18" r="18" fill="url(#auroraMarkNav)" />
      <path d="M14 11L26 18L14 25Z" fill="#FFFFFF" />
    </svg>
  )
}

/** The aurora dot: the one mark for "something is live". Decorative; the
 *  text beside it says what. */
export function AuroraDot({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block h-2 w-2 flex-none rounded-full [background:var(--aurora)] ${className}`} />
}

/** What the presence pill says, or null when nothing is live. */
export interface NavPresence {
  /** "3 watching Night Train" (or "In a watch party"). */
  label: string
  /** The same for a narrow bar: "3 watching". */
  short: string
  /** Set when the pill toggles a panel (the viewer's own party). */
  expanded?: boolean
}

/* ───────────────────────── identity control ───────────────────────── */

interface IdentityMenuProps {
  user: ApiUser
  navScope: NavScope
  adminUI: boolean
  profiles: Profile[]
  activeProfileId: number | null
  notifCount: number
  onSelectProfile: (id: number) => void
  onOpenProfilesGate?: () => void
  onManageProfiles?: () => void
  onOpenNotifications: () => void
  onOpenMyProfile?: () => void
  onOpenRequests?: () => void
  onOpenSettings: () => void
  onOpenAdmin: () => void
  onOpenServer: () => void
  onSignOut: () => void
}

function IdentityMenu({
  user, navScope, adminUI, profiles, activeProfileId, notifCount,
  onSelectProfile, onOpenProfilesGate, onManageProfiles, onOpenNotifications,
  onOpenMyProfile, onOpenRequests, onOpenSettings, onOpenAdmin, onOpenServer, onSignOut,
}: IdentityMenuProps) {
  const [open, setOpen] = useState(false)
  // The popover stays mounted for its exit fade after `open` flips false.
  const exit = useExitTransition(open)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const profileRefs = useRef<(HTMLButtonElement | null)[]>([])

  const active = profiles.find(p => p.id === activeProfileId) ?? null
  // The name on the control is the profile the server has bound. With no
  // profile to show (none exist, or the binding is not known yet) it is the
  // account's own name.
  const shownName = active?.name ?? user.username
  const full = navScope === 'full'

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true) }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // Focus moves into the popover on open: the current profile's row when
  // there is one, else the first control.
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      const current = profileRefs.current.find(el => el?.getAttribute('aria-checked') === 'true')
      const first = panelRef.current?.querySelector<HTMLElement>('button')
      ;(current ?? first)?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open])

  // Tabbing out of the popover closes it; focus is already where the user
  // sent it, so it is not pulled back to the trigger.
  const onBlurCapture = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null
    if (open && next && rootRef.current && !rootRef.current.contains(next)) setOpen(false)
  }

  // The profile list is a real menu of radio items (one is current, choosing
  // one is a command): arrows, Home and End move within it. The rows after it
  // are plain buttons in the tab order, NOT menu items: they are navigation,
  // and a `menu` role over them would take a screen reader out of browse mode
  // for a list of links.
  const onProfilesKeyDown = (e: React.KeyboardEvent) => {
    const items = profileRefs.current.filter(Boolean) as HTMLButtonElement[]
    if (items.length === 0) return
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length
    else if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    if (next < 0) return
    e.preventDefault()
    items[next].focus()
  }

  const run = (fn: (() => void) | undefined) => () => {
    if (!fn) return
    close(true)
    fn()
  }

  const row = 'flex h-11 w-full items-center gap-3 rounded-art px-3 text-left text-[15px] text-ink transition-colors hover:bg-white/[0.08]'
  const rule = <div className="mx-3 my-2 h-px bg-line-strong" aria-hidden="true" />

  return (
    <div ref={rootRef} className="relative" onBlurCapture={onBlurCapture}>
      <button
        ref={triggerRef}
        type="button"
        data-identity-trigger=""
        onClick={() => setOpen(o => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Account menu for ${user.username}`}
        title={`Signed in as ${user.username}${adminUI ? ' (admin)' : ''}`}
        className="flex h-10 items-center gap-2.5 rounded-full bg-white/[0.08] pl-1.5 pr-2.5 text-ink transition-colors hover:bg-white/[0.14]"
      >
        <span className="relative flex-none">
          <ProfileAvatar avatarUrl={active?.avatar_url} name={shownName} size={28} />
          {notifCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-2 -top-1.5 h-4 min-w-4 rounded-full bg-action px-1 text-center text-xs font-bold leading-4 text-action-on"
            >
              {notifCount > 9 ? '9+' : notifCount}
            </span>
          )}
        </span>
        <span data-identity-name="" className="max-w-[120px] truncate text-sm font-semibold">{shownName}</span>
        {navScope === 'restricted' && active?.max_age_rating?.trim() && (
          <span className="rounded-chip bg-ink px-1.5 py-0.5 text-xs font-bold text-action-on">{active.max_age_rating.trim()}</span>
        )}
        <Icon name="chevronDown" size={14} className="flex-none text-ink-2" />
      </button>

      {exit.mounted && (
        <div
          ref={panelRef}
          aria-label="Account and profiles"
          role="group"
          className={`absolute right-0 top-[calc(100%+8px)] z-[55] w-[344px] max-w-[calc(100vw-32px)] rounded-control bg-surface-raised-2 p-2 shadow-[0_24px_64px_rgba(0,0,0,0.6)] animate-pop-in ${exit.closing ? 'is-closing' : ''}`}
        >
          {profiles.length > 0 && (
            <>
              <p className="stage-eyebrow px-3 pb-1.5 pt-2.5" aria-hidden="true">Watching as</p>
              <div role="menu" aria-label="Switch profile" onKeyDown={onProfilesKeyDown}>
                {profiles.map((p, idx) => {
                  const sel = p.id === activeProfileId
                  return (
                    <button
                      key={p.id}
                      ref={el => { profileRefs.current[idx] = el }}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sel}
                      tabIndex={sel || (activeProfileId === null && idx === 0) ? 0 : -1}
                      onClick={() => {
                        close(true)
                        if (!sel) onSelectProfile(p.id)
                      }}
                      className={`flex h-[52px] w-full items-center gap-3 rounded-art px-3 text-left transition-colors hover:bg-white/[0.08] ${sel ? 'bg-white/[0.08]' : ''}`}
                    >
                      <ProfileAvatar avatarUrl={p.avatar_url} name={p.name} size={32} />
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-[15px] font-semibold text-ink">{p.name}</span>
                        <span className="block truncate text-xs text-ink-2">{profileSummary(p)}</span>
                      </span>
                      {sel && <Icon name="check" size={16} className="flex-none text-ink" />}
                    </button>
                  )
                })}
              </div>
              {(onOpenProfilesGate || (full && onManageProfiles)) && (
                <div className="flex gap-1 pt-1">
                  {onOpenProfilesGate && (
                    <button type="button" onClick={run(onOpenProfilesGate)} className="h-10 flex-1 rounded-art text-[13px] font-semibold text-ink transition-colors hover:bg-white/[0.08]">
                      Full picker
                    </button>
                  )}
                  {full && onManageProfiles && (
                    <button type="button" onClick={run(onManageProfiles)} className="h-10 flex-1 rounded-art text-[13px] font-semibold text-ink transition-colors hover:bg-white/[0.08]">
                      Manage profiles
                    </button>
                  )}
                </div>
              )}
              {rule}
            </>
          )}

          <button type="button" onClick={run(onOpenNotifications)} className={row}>
            <Icon name="bell" size={18} className="flex-none text-ink-2" />
            <span className="flex-1">Notifications</span>
            {notifCount > 0 && (
              <span className="h-5 min-w-5 rounded-full bg-action px-1.5 text-center text-xs font-bold leading-5 text-action-on">
                <span className="sr-only">(</span>{notifCount > 99 ? '99+' : notifCount}<span className="sr-only"> unread)</span>
              </span>
            )}
          </button>
          {full && onOpenMyProfile && (
            <button type="button" onClick={run(onOpenMyProfile)} className={row}>
              <Icon name="user" size={18} className="flex-none text-ink-2" />
              Your profile
            </button>
          )}
          {full && onOpenRequests && (
            <button type="button" onClick={run(onOpenRequests)} className={row}>
              <Icon name="download" size={18} className="flex-none text-ink-2" />
              My requests
            </button>
          )}
          <button type="button" onClick={run(onOpenSettings)} className={row}>
            <Icon name="settings" size={18} className="flex-none text-ink-2" />
            Settings
          </button>

          {adminUI && (
            <>
              {rule}
              <button type="button" onClick={run(onOpenAdmin)} className={row}>
                <Icon name="shield" size={18} className="flex-none text-ink-2" />
                Admin
              </button>
              <button type="button" onClick={run(onOpenServer)} className={row}>
                <Icon name="server" size={18} className="flex-none text-ink-2" />
                Server status
              </button>
            </>
          )}

          {rule}
          <button type="button" onClick={run(onSignOut)} className={row}>
            <Icon name="log-out" size={18} className="flex-none text-ink-2" />
            Sign out of this device
          </button>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────── top bar ─────────────────────────────── */

export interface TopNavProps {
  user: ApiUser
  currentView: string
  /** What this session is offered (lib/navScope). */
  navScope: NavScope
  /** App's showsAdminUI verdict. The Admin and Server status rows follow it
   *  and nothing else: the account's role alone never shows them. */
  adminUI: boolean
  /** Takes a destination id ('home', 'library', 'together', 'movies'…). */
  onNavigate: (v: string) => void
  /** Warm a destination's code on hover or focus of its link. */
  onPrefetch?: (v: string) => void
  /** The phone bar's title: the name of the page on screen. */
  pageTitle: string
  searchQuery: string
  onSearchQueryChange: (v: string) => void
  onSearchFocus: () => void
  /** Clear the query and leave search. */
  onSearchClose: () => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  /** Null when nothing is live. */
  presence: NavPresence | null
  onPresenceClick: () => void
  notifCount: number
  onOpenNotificationsPanel: () => void
  onOpenServerPanel: () => void
  profiles: Profile[]
  /** The profile the server has bound to this session, or null. */
  activeProfileId: number | null
  onSelectProfile: (id: number) => void
  /** Opens the full-screen "Who's watching?" picker. */
  onOpenProfilesGate?: () => void
  onManageProfiles?: () => void
  onOpenMyProfile?: () => void
  onOpenRequests?: () => void
  onSignOut: () => void
}

export function TopNav({
  user, currentView, navScope, adminUI, onNavigate, onPrefetch, pageTitle,
  searchQuery, onSearchQueryChange, onSearchFocus, onSearchClose, searchInputRef,
  presence, onPresenceClick, notifCount, onOpenNotificationsPanel, onOpenServerPanel,
  profiles, activeProfileId, onSelectProfile, onOpenProfilesGate, onManageProfiles,
  onOpenMyProfile, onOpenRequests, onSignOut,
}: TopNavProps) {
  const destinations = navDestinationsFor(navScope)
  const current = destinationForView(currentView, navScope)
  const navRef = useRef<HTMLElement | null>(null)

  // `data-scrolled` on the bar once the page has moved past the top, so it
  // firms up over content (.stage-topnav[data-scrolled]). Written straight
  // to the DOM from one rAF per scroll frame: no React state, no re-render
  // of the nav on scroll. Passive listener: never blocks scrolling.
  useEffect(() => {
    let raf = 0
    const apply = () => {
      raf = 0
      navRef.current?.toggleAttribute('data-scrolled', window.scrollY > 8)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(apply) }
    apply()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
  const searchPillRef = useRef<HTMLDivElement | null>(null)

  // Click outside the search field closes it, same as its X button. Only
  // armed while there is a query to close.
  useEffect(() => {
    if (!searchQuery) return
    const onDocMouseDown = (e: MouseEvent) => {
      // Below md the field is `display:none` (no offsetParent) and search
      // lives on its own page, which this ref never covers: without the
      // guard every tap on that page read as "outside" and wiped the query.
      if (!searchPillRef.current?.offsetParent) return
      const target = e.target as Node
      if (searchPillRef.current.contains(target)) return
      // A scrollbar drag targets <html>/<body>, not real page content.
      if (target === document.documentElement || target === document.body) return
      // Bails on the search RESULTS (a page-level sibling, not a descendant
      // of the field): this fires on `mousedown`, before a result's own
      // `click`, so without the exemption every result click would clear the
      // query and swap the view out from under it. Also bails on any dialog
      // or menu overlay opened from a result.
      if ((target as Element).closest?.('[data-search-results], [role="dialog"], [role="menu"]')) return
      onSearchClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [searchQuery, onSearchClose])

  const link = (d: NavDestination) => {
    const active = current === d.id
    return (
      <button
        key={d.id}
        type="button"
        className="stage-tab"
        data-nav={d.id}
        aria-current={active ? 'page' : undefined}
        onClick={() => onNavigate(d.id)}
        onPointerEnter={() => onPrefetch?.(d.id)}
        onFocus={() => onPrefetch?.(d.id)}
      >
        {d.label}
      </button>
    )
  }

  return (
    <header ref={navRef} className="stage-topnav" data-nav-scope={navScope}>
      <button
        type="button"
        onClick={() => onNavigate('home')}
        aria-label="AuroraPro, go to Tonight"
        className="-mx-1 flex flex-none items-center gap-2.5 rounded-art px-1 py-1"
      >
        <AuroraMark />
        {/* Drawn wordmark in plain ink: at this size the gradient has nowhere
            to travel, and the mark beside it carries the brand colour.
            Decorative: the button's aria-label names it. */}
        <AuroraWordmark decorative ink="#F4F4F5" className="hidden h-[15px] w-auto md:block" />
      </button>

      {/* Phones: the bar names the page; the destinations are the tab bar. */}
      <span className="min-w-0 flex-1 truncate font-display text-xl font-semibold tracking-[-0.01em] text-ink md:hidden">
        {pageTitle}
      </span>

      <nav aria-label="Main" className="hidden flex-none items-center gap-1 md:flex">
        {destinations.map(link)}
      </nav>

      <div ref={searchPillRef} className="stage-navsearch hidden md:flex">
        <Icon name="search" size={16} className="flex-none text-ink-2" />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search, or describe a mood"
          aria-label="Search titles"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onFocus={onSearchFocus}
        />
        {searchQuery ? (
          <button type="button" className="stage-navsearch-clear" onClick={onSearchClose} aria-label="Clear search">
            <Icon name="x" size={14} />
          </button>
        ) : (
          <kbd aria-hidden="true">⌘K</kbd>
        )}
      </div>

      <div className="ml-auto flex flex-none items-center gap-3">
        {presence && (
          <button
            type="button"
            data-presence=""
            onClick={onPresenceClick}
            aria-expanded={presence.expanded}
            title={presence.label}
            className="flex h-10 max-w-[280px] items-center gap-2 rounded-full bg-white/[0.08] px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-white/[0.14]"
          >
            <AuroraDot />
            <span className="truncate lg:hidden">{presence.short}</span>
            <span className="hidden truncate lg:inline">{presence.label}</span>
          </button>
        )}

        <div className="hidden md:block">
          <IdentityMenu
            user={user}
            navScope={navScope}
            adminUI={adminUI}
            profiles={profiles}
            activeProfileId={activeProfileId}
            notifCount={notifCount}
            onSelectProfile={onSelectProfile}
            onOpenProfilesGate={onOpenProfilesGate}
            onManageProfiles={onManageProfiles}
            onOpenNotifications={onOpenNotificationsPanel}
            onOpenMyProfile={onOpenMyProfile}
            onOpenRequests={onOpenRequests}
            onOpenSettings={() => onNavigate('settings')}
            onOpenAdmin={() => onNavigate('admin')}
            onOpenServer={onOpenServerPanel}
            onSignOut={onSignOut}
          />
        </div>
      </div>
    </header>
  )
}

/* ───────────────────────────── bottom tab bar ───────────────────────────── */

export interface BottomTabBarProps {
  currentView: string
  navScope: NavScope
  onNavigate: (v: string) => void
  onPrefetch?: (v: string) => void
  /** Something is live: marks the Together tab with the aurora dot. */
  live: boolean
  notifCount: number
  /** For the Me tab's avatar. Null until the session's profile is known. */
  activeProfile: Profile | null
  username: string
}

/** The five tabs a session gets on a phone. Search and Me are always there;
 *  the ones between follow the same rule as the top bar's destinations. */
export function bottomTabsFor(scope: NavScope): NavDestination[] {
  const dest = navDestinationsFor(scope)
  const search: NavDestination = { id: 'search', label: 'Search', icon: 'search' }
  const me: NavDestination = { id: 'me', label: 'Me', icon: 'user' }
  if (scope === 'restricted') return [...dest, search, me]
  // Tonight, Library, Search, (Together), Me.
  return [...dest.slice(0, 2), search, ...dest.slice(2), me]
}

export function BottomTabBar({ currentView, navScope, onNavigate, onPrefetch, live, notifCount, activeProfile, username }: BottomTabBarProps) {
  const tabs = bottomTabsFor(navScope)
  const current = currentView === 'search' || currentView === 'me' ? currentView : destinationForView(currentView, navScope)
  return (
    <nav aria-label="Main" className="stage-tabbar md:hidden">
      {tabs.map(t => {
        const active = current === t.id
        return (
          <button
            key={t.id}
            type="button"
            data-nav={t.id}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(t.id)}
            onPointerEnter={() => onPrefetch?.(t.id)}
            className="stage-tabbar-item"
          >
            {t.id === 'me' ? (
              <span className={`relative rounded-full ${active ? 'shadow-[0_0_0_2px_var(--surface-page),0_0_0_4px_#fff]' : ''}`}>
                <ProfileAvatar avatarUrl={activeProfile?.avatar_url} name={activeProfile?.name ?? username} size={24} />
                {notifCount > 0 && (
                  <span aria-hidden="true" className="absolute -right-1.5 -top-1 h-2.5 w-2.5 rounded-full border-2 border-surface-page bg-action" />
                )}
              </span>
            ) : (
              <span className="relative">
                <Icon name={t.icon} size={22} />
                {t.id === 'together' && live && <AuroraDot className="absolute -right-1 -top-1" />}
              </span>
            )}
            <span>
              {t.label}
              {t.id === 'together' && live && <span className="sr-only"> (live now)</span>}
              {t.id === 'me' && notifCount > 0 && <span className="sr-only"> ({notifCount} unread notifications)</span>}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
