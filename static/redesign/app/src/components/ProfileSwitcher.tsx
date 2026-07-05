import { useEffect, useRef, useState } from 'react'
import type { Profile } from '@/lib/api'
import { ProfileAvatar } from './ProfileAvatar'

interface ProfileSwitcherProps {
  profiles: Profile[]
  activeProfileId: number | null
  onSelect: (id: number) => void
}

/**
 * ProfileSwitcher is the top-bar profile control, showing each profile's chosen
 * nebula avatar (replacing the old plain <select>). With one profile it's a
 * static chip; with several it opens a menu of avatar + name rows. Mirrors the
 * UserMenu dropdown behavior (outside-click + Escape to close).
 */
export function ProfileSwitcher({ profiles, activeProfileId, onSelect }: ProfileSwitcherProps) {
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
        // Catalogue plate — the old white-alpha chip was tuned for the
        // dark header and vanished on the paper masthead (review
        // finding).
        className={`flex items-center gap-2 border border-[var(--rule)] bg-[var(--stock)] py-1 pl-1 pr-2.5 text-xs text-[var(--ink)] transition-colors ${
          canSwitch ? 'cursor-pointer hover:bg-[rgba(22,21,17,0.06)]' : 'cursor-default'
        }`}
      >
        <ProfileAvatar avatarUrl={active.avatar_url} name={active.name} size={24} />
        <span className="max-w-[120px] truncate font-medium">{active.name}</span>
        {canSwitch && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[var(--ink-3)]" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        )}
      </button>
      {open && canSwitch && (
        <div
          role="menu"
          className="animate-fade-in absolute right-0 z-[50] mt-2 w-56 overflow-hidden border border-[var(--ink)] bg-[var(--stock)] shadow-hard"
        >
          <div className="px-3 py-2 cat-label">Switch profile</div>
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
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[rgba(22,21,17,0.06)] ${
                  sel ? 'text-[var(--ink)] font-semibold' : 'text-[var(--ink-2)]'
                }`}
              >
                <ProfileAvatar avatarUrl={p.avatar_url} name={p.name} size={32} />
                <span className="flex-1 truncate">
                  {p.name}
                  {p.is_default ? ' ★' : ''}
                </span>
                {sel && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--signal)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12.5l4.2 4.2L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
