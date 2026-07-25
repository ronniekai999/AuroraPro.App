import { useEffect, useRef, useState } from 'react'
import type { Profile } from '@/lib/api'
import { ProfileAvatar } from './ProfileAvatar'
import { maturityLeanLabel } from '@/lib/maturity'

interface ProfileSwitcherProps {
  profiles: Profile[]
  activeProfileId: number | null
  onSelect: (id: number) => void
  // Navigates to where profiles are created (Settings). Optional so the
  // component renders without it; the Add-Profile row is simply absent.
  onAddProfile?: () => void
  // Opens the full-page "Who's watching?" gate (D7). The gate shows itself once
  // per device; this is the deliberate way back to it.
  onOpenProfilesGate?: () => void
}

/**
 * ProfileSwitcher is the top-bar profile control, showing each profile's chosen
 * nebula avatar (replacing the old plain <select>). With one profile it's a
 * static chip; with several it opens a menu of avatar + name rows. Mirrors the
 * UserMenu dropdown behavior (outside-click + Escape to close).
 */
export function ProfileSwitcher({ profiles, activeProfileId, onSelect, onAddProfile, onOpenProfilesGate }: ProfileSwitcherProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // Every focusable row in the menu, in DOM order, for the arrow-key walk.
  // Includes the Add-Profile row, so Down from the last profile reaches it.
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const active =
    profiles.find((p) => p.id === activeProfileId) ?? profiles.find((p) => p.is_default) ?? profiles[0]
  const canSwitch = profiles.length > 1

  // Closing always returns focus to the trigger.
  //
  // Without this, EVERY exit path dropped focus to <body>: selecting a profile,
  // Add-Profile, and Escape all unmount the menu along with the button the user
  // was on, and React does not relocate focus. A keyboard user switched profile
  // and found themselves at the top of the document (WCAG 2.4.3). TopNav's
  // mobile sheet already does this correctly — this matches it.
  const close = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      // A click outside is a pointer interaction, so don't yank focus back to
      // the trigger — that would fight whatever the user actually clicked.
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Focus the first row when the menu opens. A `role="menu"` that opens with
  // focus still on the trigger leaves arrow keys with nothing to move from.
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => itemRefs.current[0]?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  // ARIA menu keyboard contract. Implementing this is not optional politeness:
  // NVDA and JAWS switch into focus/forms mode the moment focus enters a
  // `menuitem`, which hands the arrow keys to the application. A menu that
  // ignores them is a dead widget — Down does literally nothing, and the user
  // has to guess that Tab happens to work.
  //
  // Phase 6 made this exact argument to justify NOT using role="tab" on the
  // filter pills, and the admin tablist in this phase implements the tabs
  // contract for the same reason. The menu shipped alongside it without one.
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[]
    if (items.length === 0) return
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length
    else if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'Tab') { close(); return }  // menus close on Tab-out
    if (next < 0) return
    e.preventDefault()
    items[next].focus()
  }

  if (!active) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => canSwitch && (open ? close(false) : setOpen(true))}
        title={canSwitch ? 'Switch profile — filters Continue Watching + recommendations' : active.name}
        aria-haspopup={canSwitch ? 'menu' : undefined}
        aria-expanded={canSwitch ? open : undefined}
        className={`flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.05] py-1.5 pl-1.5 pr-2.5 text-xs text-white/80 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 ${
          canSwitch ? 'cursor-pointer hover:bg-white/[0.08]' : 'cursor-default'
        }`}
      >
        <ProfileAvatar avatarUrl={active.avatar_url} name={active.name} size={24} />
        <span className="max-w-[120px] truncate font-medium">{active.name}</span>
        {canSwitch && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-white/40" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </button>
      {open && canSwitch && (
        <div
          role="menu"
          // aria-label, not the visible heading below: `role="menu"` owns only
          // menuitem/group/separator children, so a bare <div> of text inside it
          // is not announced as the menu's name (and enumerating AT skip it).
          // The div stays for sighted users; this is what AT reads.
          aria-label="Who's watching?"
          onKeyDown={onMenuKeyDown}
          className="animate-fade-in absolute right-0 z-[50] mt-2 w-[268px] overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0a0a0f]/95 shadow-2xl backdrop-blur-xl"
        >
          {/* "Who's watching?" rather than "Switch profile" — the mockup's
              framing, and the one that says what a profile IS. aria-hidden
              because the menu's aria-label already carries it; leaving it
              exposed would announce the same words twice. */}
          <div aria-hidden="true" className="stage-eyebrow px-3.5 pt-3 pb-2 !text-[10px]">Who&rsquo;s watching?</div>
          {/* role="group" bounds the radio set so the Add-Profile menuitem below
              is not counted inside it ("3 of 4" when there are three profiles). */}
          <div role="group" aria-label="Profiles">
          {profiles.map((p, idx) => {
            const sel = p.id === active.id
            return (
              <button
                key={p.id}
                ref={el => { itemRefs.current[idx] = el }}
                role="menuitemradio"
                aria-checked={sel}
                onClick={() => {
                  onSelect(p.id)
                  close()
                }}
                className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.06] ${
                  sel ? 'bg-purple-500/[0.09] text-white' : 'text-white/75'
                }`}
              >
                {/* 44px, up from 32 — these are the mockup's nebula orbs, and at
                    32px the radial gradient that distinguishes one profile from
                    another was too small to read as anything but a coloured
                    dot. Ringed when selected so the state survives without
                    relying on the check glyph alone. */}
                <ProfileAvatar
                  avatarUrl={p.avatar_url}
                  name={p.name}
                  size={44}
                  className={sel ? 'ring-2 ring-purple-300/80 ring-offset-2 ring-offset-[#0a0a0f]' : undefined}
                />
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-sm font-semibold">{p.name}</span>
                  {/* Only real facts: the default flag and the content-tone
                      lean. No invented "Sci-fi & docs" taste blurb — nothing on
                      Profile holds one.
                      maturityLeanLabel lives in lib/maturity so this row and the
                      Settings dial that WRITES the field cannot disagree about
                      what its four values mean. A first version re-derived the
                      mapping here and read the value as an AGE, which rendered
                      every real setting — Family, Teen, Mature — as "Kids-safe".
                      'Default' spelled out rather than a ★ glyph: NVDA reads
                      U+2605 as "black star", right before the word it decorates. */}
                  <span className="block truncate text-[11px] text-white/50">
                    {[p.is_default ? 'Default' : null, maturityLeanLabel(p.maturity_pref)]
                      .filter(Boolean)
                      .join(' · ') || 'Profile'}
                  </span>
                </span>
                {sel && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
                    <path d="M5 12.5l4.2 4.2L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
          </div>
          {/* Dashed Add-Profile row — the mockup's `.orb.add` tile, adapted to
              this menu. It navigates to Settings, where profile creation and
              the taste-onboarding flow already live, rather than duplicating
              the form here. Rendered only when the host wires onAddProfile, so
              the component stays usable without it. */}
          {onOpenProfilesGate && (
            <button
              ref={el => { itemRefs.current[profiles.length] = el }}
              role="menuitem"
              onClick={() => { close(false); onOpenProfilesGate() }}
              className="flex w-full items-center gap-3 border-t border-white/[0.06] px-3.5 py-2.5 text-left text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <span className="grid h-11 w-11 flex-none place-items-center rounded-full bg-white/[0.06] text-white/70">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
                </svg>
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">See all profiles</span>
                <span className="block text-[11px] text-white/55">The full picker</span>
              </span>
            </button>
          )}
          {onAddProfile && (
            <button
              ref={el => { itemRefs.current[profiles.length + (onOpenProfilesGate ? 1 : 0)] = el }}
              role="menuitem"
              onClick={() => { close(false); onAddProfile() }}
              className="mt-1 flex w-full items-center gap-3 border-t border-white/[0.06] px-3.5 py-3 text-left text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/85"
            >
              <span className="grid h-11 w-11 flex-none place-items-center rounded-full border border-dashed border-white/25 bg-white/[0.04]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">Add profile</span>
                <span className="block text-[11px] text-white/60">Taste onboarding in Settings</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
