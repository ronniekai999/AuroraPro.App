// @vitest-environment jsdom
//
// The built-in avatars: the profile's initial in dark ink on a two-tone disc.
// They replaced an animated orb that drew as a near-black disc at the sizes
// the app uses (24px and up), so what is pinned here is that the new disc
// keeps the initial readable at every point of every gradient, that it is
// drawn in the ink that check reads, and that every value already stored on
// a profile still resolves. Their layout in a real browser (a picker's discs
// are square and not empty) is scripts/verify-avatar-discs.mjs.

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NEBULAS, NebulaAvatar, nebulaFill, parseNebula } from './NebulaAvatar'
import { ProfileAvatar } from './ProfileAvatar'
import { AvatarPicker } from './settings/ProfilePickers'
import css from '../index.css?raw'
import tailwindConfig from '../../tailwind.config.js?raw'

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = ([r, g, b]: readonly number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
// A background as the DOM normalises it (jsdom writes hex colours as rgb()).
const painted = (background: string) => { const el = document.createElement('i'); el.style.background = background; return el.style.background }

// The initial is drawn in the action ink; read it from the stylesheet so a
// change of ink is checked against the gradients too.
const INK = (() => {
  const m = css.match(/--on-action:\s*(#[0-9a-fA-F]{6})\s*;/)
  if (!m) throw new Error('--on-action not found in index.css')
  return hex(m[1])
})()

describe('the nebula avatars', () => {
  // A 24px disc carries a 12px initial, so AA's 4.5:1 applies. CSS mixes a
  // gradient in sRGB, and a mix of two passing stops can be darker than
  // either (the midpoint of red and green is darker than red), so the
  // gradient is sampled along its length, not just at its stops. The white
  // highlight on top only lightens (pinned below), so it is left out: this
  // is the worst case.
  it('carry the dark initial at 4.5:1 or better everywhere on every gradient', () => {
    for (const n of NEBULAS) {
      const stops = n.stops.map(hex)
      for (let s = 0; s < stops.length - 1; s++) {
        for (let i = 0; i <= 20; i++) {
          const t = i / 20
          const c = stops[s].map((v, k) => v + (stops[s + 1][k] - v) * t)
          expect(contrast(INK, c), `${n.id} at ${s + t}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  // The check above reads --on-action; the discs are drawn with the
  // text-action-on utility. Both renderers use that class, and Tailwind maps
  // it to that variable, so the ink checked is the ink drawn.
  it('draw the initial in the ink the contrast check reads', () => {
    expect(tailwindConfig).toMatch(/action:\s*\{[^}]*\bon:\s*"var\(--on-action\)"/)
    const { container } = render(
      <>
        <ProfileAvatar avatarUrl="nebula:tidal" name="Maya" colorKey={3} />
        <NebulaAvatar nebula="tidal" initial="M" className="h-full w-full" />
      </>,
    )
    expect(container.querySelector('[data-profile-avatar="nebula"]')).toHaveClass('text-action-on')
    expect(container.querySelector('.nebula-disc svg')).toHaveClass('text-action-on')
    expect(container.querySelector('.nebula-disc text')).toHaveAttribute('fill', 'currentColor')
  })

  // The whole fill, so the highlight cannot gain a darkening stop or a layer
  // without this changing too.
  it('paint the gradient under a white highlight and nothing else', () => {
    expect(nebulaFill(parseNebula('aurora')!)).toBe(
      'radial-gradient(110% 80% at 28% 0%, rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0) 60%), '
      + 'linear-gradient(150deg, #ec4899, #a855f7, #2dd4bf)',
    )
  })

  // Profiles store these ids; renaming one would drop every profile that
  // chose it back to the plain initial disc.
  it('keep every id profiles already store, in the form the server accepts', () => {
    expect(NEBULAS.map(n => n.id)).toEqual([
      'amethyst', 'tidal', 'blossom', 'ember', 'verdant', 'cobalt', 'rose', 'mirage', 'solstice', 'aurora',
    ])
    for (const n of NEBULAS) {
      expect(`nebula:${n.id}`).toMatch(/^nebula:[a-z0-9_-]{1,32}$/)
      expect(parseNebula(`nebula:${n.id}`)).toBe(n)
    }
  })

  it('draw a profile\'s initial on its nebula, hidden from assistive technology', () => {
    const { container } = render(<ProfileAvatar avatarUrl="nebula:tidal" name=" maya" colorKey={3} size={24} />)
    const disc = container.querySelector<HTMLElement>('[data-profile-avatar]')!
    expect(disc.dataset.profileAvatar).toBe('nebula')
    expect(disc).toHaveAttribute('aria-hidden', 'true')
    expect(disc.textContent).toBe('M')
    // The 12px floor: 42% of 24 would be 10.
    expect(disc.style.fontSize).toBe('12px')
    expect(disc.style.background).toBe(painted(nebulaFill(parseNebula('tidal')!)))
  })

  it('fall back to the profile\'s own colour for an unknown id', () => {
    const { container } = render(<ProfileAvatar avatarUrl="nebula:nonesuch" name="Maya" colorKey={3} />)
    const disc = container.querySelector<HTMLElement>('[data-profile-avatar]')!
    expect(disc.dataset.profileAvatar).toBe('initial')
    expect(disc.textContent).toBe('M')
  })

  // The picker's disc has no fixed size, so its initial is SVG text on a
  // 100-unit square: 42 units is 42% of the disc at any size.
  it('draw the picker\'s disc with the initial given, scaled with the disc, or bare without one', () => {
    const tidal = parseNebula('tidal')!
    const { container, rerender } = render(<NebulaAvatar nebula={tidal} initial="S" className="h-full w-full" />)
    const disc = container.querySelector<HTMLElement>('.nebula-disc')!
    expect(disc).toHaveAttribute('aria-hidden', 'true')
    expect(disc.textContent).toBe('S')
    expect(disc.style.background).toBe(painted(nebulaFill(tidal)))
    expect(disc.querySelector('svg')).toHaveAttribute('viewBox', '0 0 100 100')
    expect(disc.querySelector('text')).toHaveAttribute('font-size', '42')
    rerender(<NebulaAvatar nebula={tidal} className="h-full w-full" />)
    expect(container.querySelector('.nebula-disc')!.textContent).toBe('')
    expect(container.querySelector('.nebula-disc svg')).toBeNull()
  })

  it('show the profile\'s own initial on every disc of the Settings picker, and none without a name', () => {
    const discs = () => [...document.querySelectorAll('[role="radio"] .nebula-disc')].map(d => d.textContent)
    const { rerender } = render(<AvatarPicker profileId={1} profileName=" 🎬 Movies" avatarUrl="nebula:tidal" onPick={async () => {}} />)
    expect(discs()).toEqual(Array(NEBULAS.length).fill('🎬'))
    rerender(<AvatarPicker profileId={1} profileName="  " avatarUrl="nebula:tidal" onPick={async () => {}} />)
    expect(discs()).toEqual(Array(NEBULAS.length).fill(''))
  })
})
