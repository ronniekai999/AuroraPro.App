// Aurora Stage (Option B) — TopNav.
//
// Phase 2 of do/ui-mockups/option-b/IMPLEMENTATION_PLAN.md: replaces the
// 240px fixed <aside> Sidebar + the separate content header with one 64px
// bar. Same eight destinations, same admin gate, same triggers — only the
// chrome moves. The vertical space the sidebar ate is handed back to
// artwork, which is the whole point of Option B.
//
// Lives in its own file rather than in App.tsx on purpose: App is already
// ~5,300 lines and owns the shell plus Home/Auth/Search plus the drawers.
// UserMenu moved in here with it — it's nav chrome, and the avatar
// dropdown is now where Server Status / Notifications / Settings / Sign
// Out live (they were the sidebar's footer).
//
// Where the sidebar's parts went:
//   nav items (8)      → the centered tab strip
//   Server Status      → avatar dropdown (opens the same ServerPanel)
//   Notifications      → avatar dropdown (opens the same NotificationPanel)
//   Settings           → avatar dropdown (already there pre-Stage)
//   user chip (footer) → the avatar + the dropdown's header
//   mobile drawer      → the menu sheet below md (see MobileSheet)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuroraWordmark } from '@/components/AuroraWordmark'
import { Icon } from '@/components/Icon'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import { ProfileSwitcher } from '@/components/ProfileSwitcher'
import type { Profile, User as ApiUser } from '@/lib/api'
import { lockBodyScroll } from '@/lib/scrollLock'
import { useExitTransition } from '@/hooks/useExitTransition'

export interface NavTab {
  id: string
  label: string
  icon: string
  admin?: boolean
}

// Same ids/labels/order the Sidebar used, so handleNavigate, the popstate
// view sync, and every deep link keep working untouched.
const BASE_TABS: readonly NavTab[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'movies', label: 'Movies', icon: 'movie' },
  { id: 'shows', label: 'TV Shows', icon: 'tv' },
  { id: 'collections', label: 'Collections', icon: 'star' },
  { id: 'calendar', label: 'Calendar', icon: 'clock' },
  { id: 'library', label: 'My Library', icon: 'library' },
  { id: 'requests', label: 'Requests', icon: 'download' },
]
const ADMIN_TAB: NavTab = { id: 'admin', label: 'Admin', icon: 'settings', admin: true }

/** The tabs a given role sees. Exported for tests. */
export function navTabsFor(role?: string): NavTab[] {
  return role === 'admin' ? [...BASE_TABS, ADMIN_TAB] : [...BASE_TABS]
}

function AuroraMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="auroraMarkNav" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#A855F7" />
          <stop offset="0.55" stopColor="#7C3AED" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
      </defs>
      <circle cx="18" cy="18" r="16" fill="url(#auroraMarkNav)" />
      <path d="M14 11L26 18L14 25Z" fill="#FFFFFF" />
    </svg>
  )
}

/* ───────────────────────── avatar dropdown ───────────────────────── */
// Pre-Stage this was UserMenu in App.tsx with Settings / Admin / Sign out.
// It gains the two triggers that used to sit in the sidebar footer, so
// Server Status and Notifications remain reachable from one click.
function AvatarMenu({
  user,
  avatarUrl,
  onNavigate,
  onSignOut,
  onOpenServer,
  onOpenNotifications,
  notifCount,
  onOpenMyProfile,
  onOpenMembers,
}: {
  user: ApiUser
  avatarUrl?: string
  onNavigate: (v: string) => void
  onSignOut: () => void
  /** Undefined for non-admins — the panel is admin-only, so no dead row. */
  onOpenServer?: () => void
  onOpenNotifications: () => void
  notifCount: number
  /** Opens /user/:username (social phase 1). Optional so test renders
   *  without routing wired keep working; no row when absent. */
  onOpenMyProfile?: () => void
  /** Opens the member directory (social phase 2). Same optionality. */
  onOpenMembers?: () => void
}) {
  const [open, setOpen] = useState(false)
  // The dropdown stays mounted for its exit fade after `open` flips false.
  const exit = useExitTransition(open)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // NOT a `role="menu"`. Phase 9 first implemented the full APG Menu contract
  // here, and a review established that the correct fix was to delete the role
  // instead — the argument "a role without its keyboard contract is worse than no
  // role" cuts both ways, and I had only run it in one direction.
  //
  // These rows are predominantly NAVIGATION (Settings, Admin) plus two panel
  // openers plus Sign out. MDN is explicit: "When including a 'menu' for site
  // navigation, do not use the `menu` role. Rather … simply a list of links. The
  // `menu` role should be reserved for composite widgets requiring focus
  // management" — and APG's Disclosure Navigation example says the same. The role
  // buys nothing here and costs the user their virtual cursor, H/K/B quick-nav and
  // the ability to read non-interactive text, because `menu` forces NVDA/JAWS out
  // of browse mode into forms mode.
  //
  // Implementing it also caused a measured REGRESSION. `menu` may own only
  // menuitem/group/separator, so the username + "Admin" badge header was an
  // invalid owned element. Chromium exposes it anyway — but as a `paragraph`
  // inside a `menu`, which the menu's own arrow navigation cannot reach. Before,
  // focus never entered the menu, the reader stayed in browse mode, and the
  // virtual cursor could read it. Forcing focus in made that text present in the
  // tree and reachable by nothing.
  //
  // What was worth keeping from that pass is orthogonal to the role and is still
  // here: focus into the panel on open, Escape, and `closeTo` returning focus to
  // the trigger on every activation path instead of dropping it to <body>.
  // ContextMenu keeps `role="menu"` — its items are all genuine commands, which is
  // exactly the case the role exists for.
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      // Focus back to the trigger here too. This was the one dismissal path that
      // still dropped focus to <body> while a comment claimed "every dismissal
      // returns focus to the trigger" — measured as a focusout with no focusin
      // after it. Low impact, since outside-click is a pointer gesture, but the
      // claim was false.
      setOpen(false)
      triggerRef.current?.focus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    // Focus the first RENDERED row on open. `.filter(Boolean)` rather than
    // `itemRefs.current[0]`, because the row set is conditional — My Profile
    // (slot 0) and Members (slot 1) render only when routing is wired, and
    // Server Status (slot 2) is admin-only, so leading slots can be empty.
    // The earlier
    // version of this pass pinned `tabIndex={0}` to that same slot, which meant a
    // non-admin's open panel had ZERO tab stops; the rows are ordinary tab stops
    // now, so that particular hazard is gone, but the focus call still has to
    // skip the holes.
    const raf = requestAnimationFrame(() => {
      itemRefs.current.filter(Boolean)[0]?.focus()
    })
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /** Every row is an ordinary tab stop now (no roving index, no arrow keys — this
   *  is a disclosure, not a menu widget). The only key this needs to own is Tab
   *  off the LAST row: without that, Tab walks out of an open dropdown and puts
   *  focus on page content behind it. Shift+Tab off the first row does the same
   *  in reverse. */
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const live = itemRefs.current.filter(Boolean) as HTMLButtonElement[]
    if (!live.length) return
    const at = live.indexOf(document.activeElement as HTMLButtonElement)
    const leaving = e.shiftKey ? at === 0 : at === live.length - 1
    if (!leaving) return   // let Tab move between rows normally
    e.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  /** Every dismissal returns focus to the trigger. Without this the row that was
   *  activated unmounts under the user's focus and it falls to <body>. */
  const closeTo = (fn?: () => void) => {
    setOpen(false)
    triggerRef.current?.focus()
    fn?.()
  }

  const go = (view: string) => {
    closeTo(() => onNavigate(view))
  }
  // The drawers render as fixed-position panels of their own; close the
  // menu first so it isn't left floating over the thing it opened.
  //
  // These rows are OPENERS, not toggles. App passes explicit open handlers
  // (not the nav icons' toggles): a row labelled "Notifications" that
  // silently closes the panel when it happens to be open already is a
  // trap, and below md this dropdown is the only surface for it — with no
  // icon state to hint at what happened.
  const openPanel = (fn: () => void) => {
    // An earlier comment here said "the panels this opens (ServerPanel /
    // NotificationPanel) manage their own focus". They do not — a reviewer grepped
    // both: each renders `role="dialog"` with ZERO focus() calls, no autoFocus, no
    // aria-modal, no Escape handler and no focus trap. So the ordering below fights
    // nothing, but the reasoning it rested on was invented.
    //
    // Returning focus to the trigger is still right: it lands on a real control
    // rather than on <body>. The remaining defect is the panels', not this menu's —
    // activating a row opens a role="dialog" while focus sits on a trigger whose
    // aria-expanded just went false, so a screen-reader user gets no announcement
    // and no route in. Pre-existing, out of scope here, recorded rather than
    // papered over.
    closeTo(fn)
  }

  // The negative outline-offset is not cosmetic. The global :focus-visible floor
  // paints its 2px ring at `outline-offset: 2px` — i.e. OUTSIDE the border box —
  // and these rows are `w-full` inside a panel with `overflow-hidden` and no
  // padding, so the entire left and right runs of the ring fell outside the clip
  // rect and never painted. Measured: 3px clipped per side, and the destructive
  // Sign out row (last child) lost its bottom edge too. Pulling the offset inward
  // puts the whole ring inside the clip. This only started mattering when Phase 9
  // made these rows focusable.
  const itemCls = 'w-full text-left px-4 py-2.5 text-sm text-white/85 hover:bg-white/[0.06] flex items-center gap-2.5 focus-visible:[outline-offset:-2px]'

  return (
    <div ref={rootRef} className="relative flex-none">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        title={`Signed in as ${user.username}${user.role === 'admin' ? ' (admin)' : ''}`}
        // "true", not "menu" — see the note above `itemRefs`: this opens a
        // disclosure panel of links and buttons, not a menu widget.
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          // Below md the labelled bell is hidden and the badge is
          // aria-hidden, so without the count here a screen-reader user
          // could never learn there are unread notifications on a phone.
          notifCount > 0
            ? `Account menu for ${user.username}, ${notifCount} unread notification${notifCount === 1 ? '' : 's'}`
            : `Account menu for ${user.username}`
        }
        className="relative block rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
      >
        <ProfileAvatar avatarUrl={avatarUrl} name={user.username} size={38} />
        {/* Unread count doubles as the bell badge below md, where the
            standalone bell is hidden. */}
        {notifCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-purple-600 border-2 border-[#050505] text-[10px] font-bold text-white grid place-items-center md:hidden"
            aria-hidden="true"
          >
            {notifCount > 9 ? '9+' : notifCount}
          </span>
        )}
      </button>
      {exit.mounted && (
        <div
          // No role. `aria-labelledby` points at the username header below, which
          // is now ordinary readable content rather than an invalid owned element
          // of a `menu`.
          aria-labelledby="avatar-menu-heading"
          onKeyDown={onPanelKeyDown}
          className={`absolute right-0 mt-2 w-60 rounded-xl bg-[#0a0a0f]/95 backdrop-blur-xl border border-white/[0.06] shadow-2xl z-[55] overflow-hidden animate-fade-in${exit.closing ? ' is-closing' : ''}`}
        >
          <div id="avatar-menu-heading" className="px-4 py-3 border-b border-white/[0.06]">
            <p className="text-white text-sm font-medium truncate">{user.username}</p>
            <p className="text-white/40 text-xs mt-0.5 flex items-center gap-1.5">
              {user.role === 'admin' ? (
                <>
                  <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[10px] font-semibold uppercase tracking-wide">Admin</span>
                  Account
                </>
              ) : 'Account'}
            </p>
          </div>
          {onOpenMyProfile && (
            <button
              ref={el => { itemRefs.current[0] = el }}
              type="button"
              // closeTo (not openPanel): this row NAVIGATES — same dismissal
              // contract as the Settings/Admin rows' go().
              onClick={() => closeTo(onOpenMyProfile)}
              className={itemCls}
            >
              <Icon name="user" size={14} className="text-white/50" />
              My Profile
            </button>
          )}
          {onOpenMembers && (
            <button
              ref={el => { itemRefs.current[1] = el }}
              type="button"
              onClick={() => closeTo(onOpenMembers)}
              className={itemCls}
            >
              <Icon name="users" size={14} className="text-white/50" />
              Members
            </button>
          )}
          {onOpenServer && (
            <button
              ref={el => { itemRefs.current[2] = el }}
              type="button"
              onClick={() => openPanel(onOpenServer)}
              className={itemCls}
            >
              <Icon name="server" size={14} className="text-white/50" />
              Server Status
            </button>
          )}
          <button
              ref={el => { itemRefs.current[3] = el }}
              type="button"
              onClick={() => openPanel(onOpenNotifications)}
              className={itemCls}
            >
            <Icon name="bell" size={14} className="text-white/50" />
            Notifications
            {notifCount > 0 && (
              <span className="ml-auto min-w-[19px] h-[19px] px-1.5 rounded-full bg-purple-600 text-[10.5px] font-bold text-white grid place-items-center">
                {notifCount}
              </span>
            )}
          </button>
          <div className="border-t border-white/[0.06] my-1" />
          <button
              ref={el => { itemRefs.current[4] = el }}
              type="button"
              onClick={() => go('settings')}
              className={itemCls}
            >
            <Icon name="settings" size={14} className="text-white/50" />
            Settings
          </button>
          {user.role === 'admin' && (
            <button
              ref={el => { itemRefs.current[5] = el }}
              type="button"
              onClick={() => go('admin')}
              className={itemCls}
            >
              <Icon name="shield" size={14} className="text-white/50" />
              Admin
            </button>
          )}
          <div className="border-t border-white/[0.06] my-1" />
          <button
            ref={el => { itemRefs.current[6] = el }}
            type="button"
            // closeTo focuses the trigger before calling onSignOut, which is the
            // best that can be done from here — but it does NOT save this path, and
            // the Phase 9 claim that "all of them now return it to the trigger" was
            // wrong about this row specifically. App renders
            // `if (user === false) return <AuthView/>`, so signing out unmounts
            // TopNav and the trigger with it; measured end state is <body>. Fixing
            // it properly means AuthView taking focus on mount, which is AuthView's
            // job, not this menu's.
            onClick={() => closeTo(onSignOut)}
            className="w-full text-left px-4 py-2.5 text-sm text-red-300/85 hover:bg-red-500/10 flex items-center gap-2.5 focus-visible:[outline-offset:-2px]"
          >
            <Icon name="log-out" size={14} className="text-red-400/60" />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/* ───────────────────────── mobile menu sheet ─────────────────────── */
// Below md the tab strip is hidden and this replaces it. It is the
// successor to the sidebar's mobile drawer (QA BUG-012): removing the
// sidebar without shipping this would leave phones with no navigation at
// all. Same Escape / backdrop-dismiss behavior as the drawer had.
function MobileSheet({
  tabs,
  currentView,
  onNavigate,
  closing = false,
  onClose,
  profiles,
  activeProfileId,
  onSelectProfile,
  onAddProfile,
  onOpenProfilesGate,
  searchQuery,
  onSearchQueryChange,
  onSearchClose,
}: {
  tabs: NavTab[]
  currentView: string
  onNavigate: (v: string) => void
  onClose: () => void
  /** True while the sheet plays its exit; TopNav owns the timing. */
  closing?: boolean
  profiles: Profile[]
  activeProfileId: number | null
  onSelectProfile: (id: number) => void
  // Routes to Settings, where profile creation lives. Threaded through to
  // ProfileSwitcher's dashed Add-Profile row.
  onAddProfile?: () => void
  // Opens the full-page "Who's watching?" gate on demand (D7). The gate is
  // otherwise first-visit-only, so this is the way back to it.
  onOpenProfilesGate?: () => void
  searchQuery: string
  onSearchQueryChange: (v: string) => void
  /** Clears the query and drops back to Home if it was driving the
   *  search view — the X button next to the field. */
  onSearchClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const firstItemRef = useRef<HTMLButtonElement | null>(null)

  // Focus in on open, and trap Tab inside the panel. This is the only
  // navigation below md, so the drawer it replaced getting away with
  // mouse-only dismissal is not a precedent worth keeping: without this a
  // keyboard or switch user tabs straight past the menu into the page
  // underneath, which the scrim only blocks for the mouse.
  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Stop App's window-level Escape handler from ALSO firing: on a
        // detail page it calls handleBack(), so dismissing the menu used to
        // navigate the user off the page they were on.
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    }
    // Capture phase so the stopPropagation above beats App's listener even
    // though App's is on `window` (which is upstream of `document` on the
    // bubble path but downstream on capture).
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Lock the page behind the sheet — without this a drag over the scrim
  // scrolls the content underneath on iOS. Shared ref-counted lock, so the
  // theater and the profile gate can hold it at the same time in any order.
  useEffect(() => lockBodyScroll(), [])

  return (
    <>
      {/* The scrim starts BELOW the bar so the nav's own controls — the
          menu button that closes this, the avatar, search — stay lit and
          tappable, the way the old drawer kept its hamburger reachable. */}
      <div
        className={`fixed left-0 right-0 bottom-0 bg-black/60 backdrop-blur-sm z-[48] md:hidden animate-fade-in${closing ? ' is-closing' : ''}`}
        style={{ top: 'var(--chrome-h, var(--topnav-h))' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        id="stage-mobile-nav"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className={`fixed left-2 right-2 z-[49] md:hidden rounded-2xl bg-[#0a0a0f]/97 backdrop-blur-xl border border-white/[0.08] shadow-2xl p-2 animate-fade-in max-h-[70vh] overflow-y-auto overscroll-contain${closing ? ' is-closing' : ''}`}
        style={{ top: 'calc(var(--chrome-h, var(--topnav-h)) + 6px)' }}
      >
        {/* Real search field, not a shortcut to the palette. The palette
            only ever jumps to a title's detail page — it has no "see all
            results" route — so with the nav's desktop input hidden below md
            this is the ONLY way a phone user reaches the search RESULTS
            page (SearchView, with its grid and library toggles). Pre-Stage
            the header input rendered at every width; dropping it here would
            have quietly deleted a whole destination on mobile. */}
        <div className="stage-navsearch flex mx-1 mb-2">
          <Icon name="search" size={16} className="text-white/35 flex-none" />
          <input
            type="text"
            placeholder="Search titles…"
            aria-label="Search titles"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="stage-navsearch-clear"
              onClick={onSearchClose}
              aria-label="Clear search"
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
        {profiles.length > 0 && (
          <div className="px-2 pt-1 pb-2.5 mb-1 border-b border-white/[0.06]">
            {/* Profile switching lives here on phones — the nav's right
                cluster has no room for the chip below md. */}
            <ProfileSwitcher
              profiles={profiles}
              activeProfileId={activeProfileId}
              onSelect={onSelectProfile}
              // Closes the sheet FIRST. Every other navigation out of this
              // sheet goes through go(), which does the same — without it,
              // Add-Profile rendered Settings underneath while the sheet stayed
              // mounted with role="dialog" aria-modal="true", body scroll locked
              // and its Tab trap live. Combined with the switcher unmounting the
              // focused row, the trap's first/last checks matched neither branch,
              // so Tab escaped into a page that aria-modal had hidden from AT.
              onAddProfile={onAddProfile && (() => { onClose(); onAddProfile() })}
              onOpenProfilesGate={onOpenProfilesGate && (() => { onClose(); onOpenProfilesGate() })}
            />
          </div>
        )}
        <nav aria-label="Main">
          {tabs.map((tab, i) => {
            const active = currentView === tab.id
            return (
              <button
                key={tab.id}
                ref={i === 0 ? firstItemRef : undefined}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => { onNavigate(tab.id); onClose() }}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-[15px] transition-colors ${
                  active
                    ? 'bg-purple-500/15 text-white font-semibold'
                    : 'text-white/70 hover:bg-white/[0.05] hover:text-white'
                }`}
              >
                <Icon name={tab.icon} size={18} />
                {tab.label}
                {tab.admin && <span className="stage-tab-adm">admin</span>}
              </button>
            )
          })}
        </nav>
      </div>
    </>
  )
}

/* ───────────────────────────── TopNav ────────────────────────────── */
export interface TopNavProps {
  user: ApiUser
  currentView: string
  onNavigate: (v: string) => void
  /** Warms a lazy view's chunk on hover/focus of its tab, so the click that
   *  follows mounts real content instead of the Suspense fallback. */
  onPrefetch?: (v: string) => void
  /** Inline search — the same controlled input the old header owned. */
  searchQuery: string
  onSearchQueryChange: (v: string) => void
  onSearchFocus: () => void
  /** Clears the query and drops back to Home if it was driving the
   *  search view — the X button, an outside click, and Escape all
   *  route through this. */
  onSearchClose: () => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  /** Opens the ⌘K palette. Below md this is the whole search affordance. */
  onOpenPalette: () => void
  /** True when the user is in a watch party (drives the live dot). */
  partyActive: boolean
  partyLabel: string
  onPartyClick: () => void
  /** Whether the party panel the button toggles is currently open. */
  partyPanelOpen: boolean
  serverOpen: boolean
  /** Toggles the panel — for the nav icon, which shows its own state. */
  onToggleServer: () => void
  /** Force-opens it — for the avatar dropdown row (see AvatarMenu). */
  onOpenServerPanel: () => void
  notifOpen: boolean
  onToggleNotifications: () => void
  onOpenNotificationsPanel: () => void
  notifCount: number
  profiles: Profile[]
  activeProfileId: number | null
  onSelectProfile: (id: number) => void
  // Routes to Settings, where profile creation lives. Threaded through to
  // ProfileSwitcher's dashed Add-Profile row.
  onAddProfile?: () => void
  // Opens the full-page "Who's watching?" gate on demand (D7). The gate is
  // otherwise first-visit-only, so this is the way back to it.
  onOpenProfilesGate?: () => void
  avatarUrl?: string
  onSignOut: () => void
  /** Opens the signed-in user's own profile page (social phase 1). */
  onOpenMyProfile?: () => void
  /** Opens the member directory (social phase 2). */
  onOpenMembers?: () => void
}

export function TopNav({
  user,
  currentView,
  onNavigate,
  onPrefetch,
  searchQuery,
  onSearchQueryChange,
  onSearchFocus,
  onSearchClose,
  searchInputRef,
  onOpenPalette,
  partyActive,
  partyLabel,
  onPartyClick,
  partyPanelOpen,
  serverOpen,
  onToggleServer,
  onOpenServerPanel,
  notifOpen,
  onToggleNotifications,
  onOpenNotificationsPanel,
  notifCount,
  profiles,
  activeProfileId,
  onSelectProfile,
  onAddProfile,
  onOpenProfilesGate,
  avatarUrl,
  onSignOut,
  onOpenMyProfile,
  onOpenMembers,
}: TopNavProps) {
  const isAdmin = user.role === 'admin'
  const tabs = useMemo(() => navTabsFor(user.role), [user.role])
  const [sheetOpen, setSheetOpen] = useState(false)
  // The sheet stays mounted for its exit fade after sheetOpen flips false.
  const sheetExit = useExitTransition(sheetOpen)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const menuBtnRef = useRef<HTMLButtonElement | null>(null)
  const searchPillRef = useRef<HTMLDivElement | null>(null)

  // Stable identity: MobileSheet keys its document listeners on onClose, and
  // TopNav re-renders on every notification poll / party tick / keystroke.
  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    menuBtnRef.current?.focus()
  }, [])

  // Click outside the desktop search pill closes it, same as the X button.
  // Only armed while there's a query to close — an empty, unfocused pill has
  // nothing to dismiss.
  useEffect(() => {
    if (!searchQuery) return
    const onDocMouseDown = (e: MouseEvent) => {
      // Only the desktop pill needs this: below `md` it's `display:none`
      // (no offsetParent), and the mobile drawer's search field — the
      // ONLY route to search results on a phone — is a completely
      // different DOM node the ref never covers. Without this guard every
      // tap on the drawer (its scrim, its own search field, a nav row)
      // read as "outside" and wiped the query mid-search.
      if (!searchPillRef.current?.offsetParent) return
      const target = e.target as Node
      if (searchPillRef.current.contains(target)) return
      // A scrollbar drag targets <html>/<body>, not real page content.
      if (target === document.documentElement || target === document.body) return
      // Bails on the search RESULTS grid (SearchView, a page-level
      // sibling — not a DOM descendant of the pill): this listener fires
      // on `mousedown`, which lands before a result card's own `click`,
      // so without the exemption every result click would clear the
      // query and swap the view back to Home out from under it. Also
      // bails on any dialog/menu overlay (ContextMenu, the add-to-list
      // picker, ServerPanel, …) — those render as later App-level
      // siblings too, so e.g. right-clicking a result and choosing "Add
      // to Watchlist" would otherwise close search out from under the
      // still-open menu.
      if ((target as Element).closest?.('[data-search-results], [role="dialog"], [role="menu"]')) return
      onSearchClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [searchQuery, onSearchClose])

  // Navigating from anywhere in the nav dismisses the sheet. The brand and
  // the avatar dropdown's rows are reachable while the sheet is open (its
  // scrim starts below the bar on purpose), and without this they navigated
  // out from under an open menu that stayed up over the new page.
  const go = useCallback((v: string) => {
    setSheetOpen(false)
    onNavigate(v)
  }, [onNavigate])

  // Between md and xl the strip scrolls; keep the active tab visible so
  // navigating (including via browser back/forward, which changes
  // currentView without a click) never leaves the current page's tab
  // parked off-screen.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const el = strip.querySelector<HTMLElement>('[aria-current="page"]')
    if (!el) return
    if (strip.scrollWidth <= strip.clientWidth) return
    el.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [currentView, tabs.length])

  // Close the sheet when the viewport grows past md — otherwise a rotate
  // or resize leaves an orphaned panel over the desktop layout.
  useEffect(() => {
    if (!sheetOpen) return
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = () => { if (mq.matches) setSheetOpen(false) }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [sheetOpen])

  return (
    // MobileSheet is a SIBLING of <nav>, not a child, and that is
    // load-bearing: .stage-topnav sets `backdrop-filter`, which makes the
    // bar a containing block for fixed-position descendants. Nested, the
    // sheet's `fixed` panel would resolve against the 64px bar instead of
    // the viewport — and worse, only when glow != "subtle" (that mode drops
    // the blur), so it would work on one appearance setting and break on
    // another.
    <>
    <nav className="stage-topnav">
      {/* Brand → home. Matches the pre-Stage sidebar behavior (clicking the
          logo always returns home) and every media-app convention. */}
      <button
        type="button"
        onClick={() => go('home')}
        aria-label="Aurora Pro — go to home"
        className="flex items-center gap-2.5 flex-none rounded-lg px-1 py-1 -mx-1 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
      >
        <span className="flex-none drop-shadow-[0_0_10px_rgba(168,85,247,0.45)]">
          <AuroraMark />
        </span>
        {/* Drawn Borealis wordmark (docs/design/aurorapro-typeface), flat
            ink per the study's small-size guidance — the gradient has
            nowhere to travel at 15px. Decorative: the button's aria-label
            already names it. */}
        <AuroraWordmark decorative ink="#DDD6FE" className="hidden sm:block h-[15px] w-auto" />
      </button>

      {/* Tabs. Hidden below md (the sheet takes over); a scrolling strip
          up to xl; fully inline from xl. */}
      <div ref={stripRef} className="stage-tabstrip hidden md:flex flex-1 justify-start 2xl:justify-center min-w-0">
        {tabs.map(tab => {
          const active = currentView === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              className="stage-tab"
              aria-current={active ? 'page' : undefined}
              onClick={() => go(tab.id)}
              // Intent, not commitment: hovering or tabbing onto a tab is
              // enough signal to fetch its code. import() dedupes, so a tab
              // hovered ten times costs one request.
              onPointerEnter={() => onPrefetch?.(tab.id)}
              onFocus={() => onPrefetch?.(tab.id)}
            >
              {tab.label}
              {tab.admin && <span className="stage-tab-adm">admin</span>}
            </button>
          )
        })}
      </div>

      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-2 md:gap-3 flex-none">
        {/* Search. The real input on md+ (preserves type-to-open-results);
            an icon button below md that opens the palette, which is a far
            better search surface on a phone than a 120px pill. */}
        <div ref={searchPillRef} className="stage-navsearch hidden md:flex w-[176px] lg:w-[196px]">
          <Icon name="search" size={15} className="text-white/35 flex-none" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search titles…"
            aria-label="Search titles"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            onFocus={onSearchFocus}
          />
          {/* Swap the ⌘K hint for a clear button once there's a query to
              clear — the pill is too narrow at 176px to show both. */}
          {searchQuery ? (
            <button
              type="button"
              className="stage-navsearch-clear"
              onClick={onSearchClose}
              aria-label="Clear search"
            >
              <Icon name="x" size={13} />
            </button>
          ) : (
            <kbd aria-hidden="true">⌘K</kbd>
          )}
        </div>
        <button
          type="button"
          className="stage-iconbtn md:hidden"
          onClick={onOpenPalette}
          aria-label="Search"
          aria-haspopup="dialog"
        >
          <Icon name="search" size={17} />
        </button>

        {/* Watch party */}
        <button
          type="button"
          className="stage-iconbtn"
          onClick={onPartyClick}
          title={partyLabel}
          // partyLabel alone is a STATE ("In party AB12"); a screen reader
          // would announce it with no hint that activating opens a panel.
          aria-label={partyActive ? `${partyLabel} — open watch party panel` : partyLabel}
          aria-expanded={partyActive ? partyPanelOpen : undefined}
        >
          <Icon name="users" size={17} />
          {partyActive && (
            <span
              className="absolute -top-px -right-px w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-[#050505] shadow-[0_0_8px_rgba(16,185,129,0.8)]"
              aria-hidden="true"
            />
          )}
        </button>

        {/* Server status + notifications. Both also live in the avatar
            dropdown; these are the at-a-glance shortcuts and are hidden
            below md to keep the bar breathable.

            The mockup draws this as a green "OK" health pill. There is no
            health signal to drive that today — ServerPanel fetches
            /api/admin/dashboard itself and only while open, and there is
            no /api/health helper — so this stays a neutral trigger rather
            than a fabricated all-clear. Wiring a real signal is a
            backend-touching follow-up, tracked in the plan.

            Admin-only, because the panel it opens is: pre-Stage the
            sidebar showed this to everyone and non-admins got a
            "Server status is admin-only" message — a dead affordance. */}
        <div className="hidden md:flex items-center gap-2">
          {isAdmin && (
            <button
              type="button"
              className="stage-iconbtn"
              onClick={onToggleServer}
              aria-expanded={serverOpen}
              aria-controls={serverOpen ? 'stage-server-panel' : undefined}
              aria-label="Server status"
              title="Server status"
            >
              <Icon name="server" size={17} />
            </button>
          )}
          <button
            type="button"
            className="stage-iconbtn"
            onClick={onToggleNotifications}
            aria-expanded={notifOpen}
            aria-controls={notifOpen ? 'stage-notification-panel' : undefined}
            aria-label={notifCount > 0 ? `Notifications (${notifCount} unread)` : 'Notifications'}
            title="Notifications"
          >
            <Icon name="bell" size={17} />
            {notifCount > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-purple-600 border-2 border-[#050505] text-[10px] font-bold text-white grid place-items-center"
                aria-hidden="true"
              >
                {notifCount > 9 ? '9+' : notifCount}
              </span>
            )}
          </button>
        </div>

        {/* md, not lg: the sheet that carries the switcher on phones is
            `md:hidden`, so gating this at lg left the 768–1023px band (iPad
            portrait, small laptops, a 320px page reflowed at 400% zoom)
            with no way to switch profile at all — which gates Continue
            Watching, recommendations and maturity filtering. */}
        {profiles.length > 0 && (
          <div className="hidden md:block">
            <ProfileSwitcher
              profiles={profiles}
              activeProfileId={activeProfileId}
              onSelect={onSelectProfile}
              onAddProfile={onAddProfile}
              onOpenProfilesGate={onOpenProfilesGate}
            />
          </div>
        )}

        <AvatarMenu
          user={user}
          avatarUrl={avatarUrl}
          // go(), not onNavigate: Settings/Admin from this dropdown must
          // also dismiss the mobile sheet if it's open behind it.
          onNavigate={go}
          onSignOut={onSignOut}
          onOpenServer={isAdmin ? onOpenServerPanel : undefined}
          onOpenNotifications={onOpenNotificationsPanel}
          notifCount={notifCount}
          // Wrapped like go(): navigating from the dropdown must also
          // dismiss the mobile sheet if it's open behind it.
          onOpenMyProfile={onOpenMyProfile && (() => { setSheetOpen(false); onOpenMyProfile() })}
          onOpenMembers={onOpenMembers && (() => { setSheetOpen(false); onOpenMembers() })}
        />

        {/* Menu button — below md only. */}
        <button
          ref={menuBtnRef}
          type="button"
          className="stage-iconbtn md:hidden"
          onClick={() => setSheetOpen(o => !o)}
          aria-label={sheetOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={sheetOpen}
          aria-haspopup="dialog"
          // Only reference the panel while it exists — a dangling IDREF is
          // an axe violation and AT drops the relationship silently.
          aria-controls={sheetOpen ? 'stage-mobile-nav' : undefined}
        >
          <Icon name={sheetOpen ? 'x' : 'menu'} size={18} />
        </button>
      </div>
    </nav>
    {sheetExit.mounted && (
      <MobileSheet
        closing={sheetExit.closing}
        tabs={tabs}
        currentView={currentView}
        onNavigate={onNavigate}
        onClose={closeSheet}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onSelectProfile={onSelectProfile}
        onAddProfile={onAddProfile}
        onOpenProfilesGate={onOpenProfilesGate}
        searchQuery={searchQuery}
        onSearchQueryChange={onSearchQueryChange}
        onSearchClose={onSearchClose}
      />
    )}
    </>
  )
}
