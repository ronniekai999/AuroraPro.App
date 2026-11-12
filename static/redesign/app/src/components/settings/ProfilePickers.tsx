// The two per-profile choices a profile may always make for itself, wherever
// they are shown: its avatar, and what its suggestions lean towards.
//
// Each shows the new choice at once and puts the old one back if the save is
// refused. Each is one tab stop with arrow keys inside it, as a radio group
// is everywhere else (lib/radiogroup).

import { useEffect, useRef, useState } from 'react'
import { NebulaAvatar, NEBULAS, nebulaValue, parseNebula } from '@/components/NebulaAvatar'
import { MATURITY_OPTIONS, type MaturityPref } from '@/lib/maturity'
import { nextRadioIndex } from '@/lib/radiogroup'

export function AvatarPicker({ profileId, profileName, avatarUrl, onPick }: {
  profileId: number
  profileName: string
  avatarUrl: string | undefined
  /** Saves the avatar; rejects when the server refuses. */
  onPick: (avatarUrl: string) => Promise<unknown>
}) {
  // What was just picked, until the profile record catches up or the save fails.
  const [local, setLocal] = useState<string | null>(null)
  useEffect(() => { setLocal(null) }, [profileId, avatarUrl])
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const selectedId = parseNebula(local ?? avatarUrl)?.id ?? null
  // With nothing chosen yet the first one is the tab stop.
  const tabStop = selectedId ?? NEBULAS[0].id

  const pick = (id: string) => {
    const value = nebulaValue(id)
    setLocal(value)
    void onPick(value).catch(() => setLocal(null))
  }

  return (
    <div
      role="radiogroup"
      aria-label={`Avatar for ${profileName}`}
      className="flex flex-wrap gap-3"
      onKeyDown={e => {
        const at = Math.max(0, NEBULAS.findIndex(n => n.id === tabStop))
        const next = nextRadioIndex(e.key, at, NEBULAS.length)
        if (next === null) return
        e.preventDefault()
        pick(NEBULAS[next].id)
        refs.current[NEBULAS[next].id]?.focus()
      }}
    >
      {NEBULAS.map(n => {
        const sel = n.id === selectedId
        return (
          <button
            key={n.id}
            ref={el => { refs.current[n.id] = el }}
            type="button"
            role="radio"
            aria-checked={sel}
            aria-label={n.name}
            title={n.name}
            tabIndex={n.id === tabStop ? 0 : -1}
            onClick={() => pick(n.id)}
            // The ring is the whole sign of which one is chosen, so it is
            // the ink colour with a gap of the page between it and the disc.
            className={`relative h-12 w-12 flex-none rounded-full ${sel ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface-page' : ''}`}
          >
            <NebulaAvatar nebula={n} active={sel} className="block h-full w-full" />
          </button>
        )
      })}
    </div>
  )
}

export function LeanPicker({ profileId, profileName, pref, onPick }: {
  profileId: number
  profileName: string
  /** The stored lean; undefined reads as Auto. */
  pref: number | undefined
  /** Saves the lean; rejects when the server refuses. */
  onPick: (pref: MaturityPref) => Promise<unknown>
}) {
  const [local, setLocal] = useState<number | null>(null)
  useEffect(() => { setLocal(null) }, [profileId, pref])
  const refs = useRef<Record<number, HTMLButtonElement | null>>({})
  const current = local ?? pref ?? -1
  const values = MATURITY_OPTIONS.map(o => o.v)
  // An out-of-range stored value checks nothing; Auto is then the tab stop.
  const tabStop = values.includes(current as MaturityPref) ? current : -1

  const pick = (v: MaturityPref) => {
    setLocal(v)
    void onPick(v).catch(() => setLocal(null))
  }

  return (
    <div
      role="radiogroup"
      aria-label={`What suggestions for ${profileName} lean towards`}
      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      onKeyDown={e => {
        const next = nextRadioIndex(e.key, Math.max(0, values.indexOf(tabStop as MaturityPref)), values.length)
        if (next === null) return
        e.preventDefault()
        pick(values[next])
        refs.current[values[next]]?.focus()
      }}
    >
      {/* One list for the control that writes the lean and the places that
          report it (lib/maturity). -1 is Auto, not off: the server derives
          the lean from what the profile has watched. */}
      {MATURITY_OPTIONS.map(opt => (
        <button
          key={opt.v}
          ref={el => { refs.current[opt.v] = el }}
          type="button"
          role="radio"
          aria-checked={current === opt.v}
          tabIndex={opt.v === tabStop ? 0 : -1}
          onClick={() => pick(opt.v)}
          className="stage-opt text-left"
        >
          <span className="block text-[15px] font-semibold text-ink">{opt.label}</span>
          <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">{opt.desc}</span>
        </button>
      ))}
    </div>
  )
}
