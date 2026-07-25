import { useEffect, useRef, useState } from 'react'
import type { Profile } from '@/lib/api'
import { ProfileAvatar } from './ProfileAvatar'

interface ProfileSwitcherProps {
  profiles: Profile[]
  activeProfileId: number | null
  onSelect: (id: number) => void
  // Navigates to where profiles are created (Settings). Optional so the
  // component renders without it; the Add-Profile row is simply absent.
  onAddProfile?: () => void
}

/**
 * Human label for Profile.maturity_pref, used as the menu row's subtitle.
 *
 * The mockup gives each profile a taste blurb ("Sci-fi & docs", "Kids-safe").
 * Nothing on Profile stores one, so this reports the maturity dial — a real
 * field — and returns null rather than inventing text when it is unset.
 * -1 is the server's "no preference" sentinel.
 */
export function maturityLabel(pref: number | undefined): string | null {
  if (pref === undefined || pref < 0) return null
  if (pref <= 7) return 'Kids-safe'
  if (pref <= 13) return 'Family'
  if (pref <= 16) return 'Teen'
  return 'All ages allowed'
}

/**
 * ProfileSwitcher is the top-bar profile control, showing each profile's chosen
 * nebula avatar (replacing the old plain <select>). With one profile it's a
 * static chip; with several it opens a menu of avatar + name rows. Mirrors the
 * UserMenu dropdown behavior (outside-click + Escape to close).
 */
export function ProfileSwitcher({ profiles, activeProfileId, onSelect, onAddProfile }: ProfileSwitcherProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const active =
    profiles.find((p) => p.id === activeProfileId) ?? profiles.find((p) => p.is_default) ?? profiles[0]
  const canSwitch = profiles.length > 1

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!active) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => canSwitch && setOpen((o) => !o)}
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
          className="animate-fade-in absolute right-0 z-[50] mt-2 w-[268px] overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0a0a0f]/95 shadow-2xl backdrop-blur-xl"
        >
          {/* "Who's watching?" rather than "Switch profile" — the mockup's
              framing, and the one that says what a profile IS. */}
          <div className="stage-eyebrow px-3.5 pt-3 pb-2 !text-[10px]">Who&rsquo;s watching?</div>
          {profiles.map((p) => {
            const sel = p.id === active.id
            return (
              <button
                key={p.id}
                role="menuitemradio"
                aria-checked={sel}
                onClick={() => {
                  onSelect(p.id)
                  setOpen(false)
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
                  {/* The subtitle the mockup carries. Only real facts: default
                      and maturity. No invented "Sci-fi & docs" taste blurb —
                      nothing on Profile holds one. */}
                  <span className="block truncate text-[11px] text-white/50">
                    {[p.is_default ? '★ default' : null, maturityLabel(p.maturity_pref)]
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
          {/* Dashed Add-Profile row — the mockup's `.orb.add` tile, adapted to
              this menu. It navigates to Settings, where profile creation and
              the taste-onboarding flow already live, rather than duplicating
              the form here. Rendered only when the host wires onAddProfile, so
              the component stays usable without it. */}
          {onAddProfile && (
            <button
              role="menuitem"
              onClick={() => { onAddProfile(); setOpen(false) }}
              className="mt-1 flex w-full items-center gap-3 border-t border-white/[0.06] px-3.5 py-3 text-left text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/85"
            >
              <span className="grid h-11 w-11 flex-none place-items-center rounded-full border border-dashed border-white/25 bg-white/[0.04]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">Add profile</span>
                <span className="block text-[11px] text-white/45">Taste onboarding in Settings</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
