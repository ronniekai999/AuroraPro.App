// @vitest-environment jsdom
//
// The built-in avatars: the profile's initial in dark ink on a two-tone disc.
// They replaced an animated orb that drew as a near-black disc at the sizes
// the app uses (24-56px), so what is pinned here is that the new disc keeps
// the initial readable at every point of every gradient, and that every value
// already stored on a profile still resolves.

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NEBULAS, NebulaAvatar, nebulaFill, parseNebula } from './NebulaAvatar'
import { ProfileAvatar } from './ProfileAvatar'
import css from '../index.css?raw'

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
  // highlight on top only lightens, so it is left out: this is the worst case.
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
    // The 12px floor: half of 24 would be 10.
    expect(disc.style.fontSize).toBe('12px')
    expect(disc.style.background).toBe(painted(nebulaFill(parseNebula('tidal')!)))
  })

  it('fall back to the profile\'s own colour for an unknown id', () => {
    const { container } = render(<ProfileAvatar avatarUrl="nebula:nonesuch" name="Maya" colorKey={3} />)
    const disc = container.querySelector<HTMLElement>('[data-profile-avatar]')!
    expect(disc.dataset.profileAvatar).toBe('initial')
    expect(disc.textContent).toBe('M')
  })

  it('draw the picker\'s disc with the initial given, or bare without one', () => {
    const tidal = parseNebula('tidal')!
    const { container, rerender } = render(<NebulaAvatar nebula={tidal} initial="S" className="h-full w-full" />)
    const disc = container.querySelector<HTMLElement>('.nebula-disc')!
    expect(disc).toHaveAttribute('aria-hidden', 'true')
    expect(disc.textContent).toBe('S')
    expect(disc.style.background).toBe(painted(nebulaFill(tidal)))
    rerender(<NebulaAvatar nebula={tidal} className="h-full w-full" />)
    expect(container.querySelector('.nebula-disc')!.textContent).toBe('')
  })

  it('paint the gradient under a highlight that only lightens', () => {
    const fill = nebulaFill(parseNebula('aurora')!)
    expect(fill).toContain('linear-gradient(150deg, #ec4899, #a855f7, #2dd4bf)')
    expect(fill).toMatch(/^radial-gradient\([^;]*rgba\(255, 255, 255, 0\.45\)/)
  })
})
