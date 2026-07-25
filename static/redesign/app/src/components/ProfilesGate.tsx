// "Who's watching?" — the full-page profile stage (Aurora Stage Phase 7b, D7).
//
// Mockup screen 02. A self-gating overlay, the same shape as TasteOnboardingGate:
// the host renders it unconditionally and it decides whether to appear. That
// keeps the policy (lib/profileGate) in one place instead of spread across the
// host's render conditions.
//
// D7 policy: first visit per device, then remembered; skipped entirely when
// there is only one profile; openable on demand from the switcher.
//
// NOT a route. It is an overlay, so it composites over whatever page you were on
// and needs no router change, no history entry, and no answer to "what happens
// if someone bookmarks /profiles while signed out". The mockup draws it at a URL;
// the behaviour it depicts is a gate, and a gate is what this is.

import { useEffect, useRef } from 'react'
import type { Profile } from '@/lib/api'
import { ProfileAvatar } from './ProfileAvatar'
import { Icon } from './Icon'
import { maturityLeanLabel } from '@/lib/maturity'
import { hasSeenProfileGate, markProfileGateSeen, shouldShowProfileGate } from '@/lib/profileGate'
import { nextRadioIndex } from '@/lib/radiogroup'

interface ProfilesGateProps {
  profiles: Profile[]
  activeProfileId: number | null
  onSelect: (id: number) => void
  /** Routes to where profiles are created (Settings). */
  onAddProfile?: () => void
  /** True once the signed-in user and their profile list have loaded. */
  ready: boolean
  /** Set by the switcher's "Who's watching?" item to open the gate on demand. */
  forced?: boolean
  /** Called on any dismissal, so the host can clear `forced`. */
  onDismiss?: () => void
}

export function ProfilesGate({
  profiles, activeProfileId, onSelect, onAddProfile, ready, forced = false, onDismiss,
}: ProfilesGateProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const open = shouldShowProfileGate({
    profileCount: profiles.length,
    seen: hasSeenProfileGate(),
    forced,
    ready,
  })

  // Focus the active profile's orb (or the first) on open, so a keyboard user
  // starts inside the gate rather than at the top of a document they can't see.
  useEffect(() => {
    if (!open) return
    const i = Math.max(0, profiles.findIndex(p => p.id === activeProfileId))
    const t = window.setTimeout(() => itemRefs.current[i]?.focus(), 0)
    return () => window.clearTimeout(t)
    // Deliberately keyed on `open` only: re-running when activeProfileId
    // changes would yank focus mid-interaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Scroll lock — the gate covers the viewport and the page behind it is inert.
  // Restores the previous value rather than clearing, for the same reason the
  // theater does: something else may hold a lock.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  const pick = (id: number) => {
    markProfileGateSeen()
    onSelect(id)
    onDismiss?.()
  }

  // Escape dismisses only when the gate was opened BY HAND. On a first visit it
  // is a genuine gate — dismissing it without a choice would leave the app
  // running as whichever profile happened to be stored, which is the ambiguity
  // the gate exists to remove.
  const dismissable = forced

  return (
    <div
      className="fixed inset-0 z-[70] overflow-y-auto aurora-bg"
      role="dialog"
      aria-modal="true"
      aria-label="Who's watching?"
      onKeyDown={e => {
        if (e.key === 'Escape' && dismissable) { e.stopPropagation(); onDismiss?.() }
      }}
    >
      {/* Same starfield + wash the sign-in screen uses; this is the other
          "before you're in the app" surface and they should read as a pair. */}
      <div className="stage-stars" aria-hidden="true" />
      <div className="page-tint" aria-hidden="true" />

      <div className="relative z-[1] min-h-full flex flex-col items-center justify-center px-6 py-16">
        <h1 className="font-display font-extrabold text-white text-3xl md:type-browse text-center">
          Who&rsquo;s watching?
        </h1>
        <p className="text-white/65 text-sm md:text-base mt-3 text-center max-w-[46ch]">
          Pick a profile — your taste, watchlists and progress travel with you.
        </p>

        {/* role="radiogroup": exactly one profile ends up active, and the
            keyboard contract is the radiogroup one (arrows move and select, the
            set is one tab stop) — the same helper Settings' dials use. */}
        <div
          role="radiogroup"
          aria-label="Profiles"
          className="mt-10 flex flex-wrap items-start justify-center gap-6 md:gap-9"
          onKeyDown={e => {
            const n = nextRadioIndex(
              e.key,
              Math.max(0, profiles.findIndex(p => p.id === activeProfileId)),
              profiles.length,
            )
            if (n === null) return
            e.preventDefault()
            itemRefs.current[n]?.focus()
          }}
        >
          {profiles.map((p, i) => {
            const sel = p.id === activeProfileId
            const sub = [p.is_default ? 'Default' : null, maturityLeanLabel(p.maturity_pref)]
              .filter(Boolean).join(' · ')
            return (
              <button
                key={p.id}
                ref={el => { itemRefs.current[i] = el }}
                type="button"
                role="radio"
                aria-checked={sel}
                tabIndex={sel ? 0 : -1}
                onClick={() => pick(p.id)}
                className="group flex w-[132px] flex-col items-center gap-3 rounded-2xl p-2 text-center transition-transform hover:scale-[1.04] focus-visible:scale-[1.04]"
              >
                {/* 118px orbs, the mockup's size. The ring is the selected cue
                    and it survives a monochrome display, unlike a colour shift
                    on a radial-gradient orb. */}
                <ProfileAvatar
                  avatarUrl={p.avatar_url}
                  name={p.name}
                  size={118}
                  className={
                    sel
                      ? 'ring-[3px] ring-purple-300/90 ring-offset-4 ring-offset-[#050505]'
                      : 'ring-2 ring-white/10 group-hover:ring-white/30'
                  }
                />
                <span className="min-w-0 w-full">
                  <span className="block truncate font-display text-[15px] font-bold text-white">{p.name}</span>
                  <span className="block truncate text-[11.5px] text-white/60">{sub || 'Profile'}</span>
                </span>
              </button>
            )
          })}

          {/* Dashed Add-Profile tile — the mockup's `.orb.add`. Outside the
              radiogroup semantically (it is an action, not a choice), so it is a
              plain button after the set rather than a fifth radio. */}
          {onAddProfile && (
            <button
              type="button"
              onClick={() => { markProfileGateSeen(); onAddProfile(); onDismiss?.() }}
              className="flex w-[132px] flex-col items-center gap-3 rounded-2xl p-2 text-center text-white/55 transition-colors hover:text-white/85"
            >
              <span className="grid h-[118px] w-[118px] place-items-center rounded-full border-2 border-dashed border-white/25 bg-white/[0.04]">
                <Icon name="plus" size={34} />
              </span>
              <span>
                <span className="block font-display text-[15px] font-bold">Add profile</span>
                <span className="block text-[11.5px] text-white/45">Taste onboarding in Settings</span>
              </span>
            </button>
          )}
        </div>

        {dismissable && (
          <button
            type="button"
            onClick={() => onDismiss?.()}
            className="stage-btn stage-btn-sm stage-btn-quiet mt-10"
          >
            Keep watching as {profiles.find(p => p.id === activeProfileId)?.name ?? 'current profile'}
          </button>
        )}
      </div>
    </div>
  )
}
