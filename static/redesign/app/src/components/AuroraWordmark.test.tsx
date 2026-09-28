// @vitest-environment jsdom
//
// The drawn-wordmark contract. Two of these assertions encode hard-won
// rendering facts rather than preferences:
//
//   - gradientUnits="userSpaceOnUse" is REQUIRED. With the default
//     objectBoundingBox units, a gradient is undefined on the zero-width
//     bounding box of a perfectly vertical stem and Chromium drops the
//     stroke — the r/a/P/u stems of the wordmark silently vanish while
//     every curved letter renders. (Found the hard way in the typeface
//     study; the component itself is now the durable source.)
//
//   - IDs must be per-instance. TopNav (decorative, flat) and the sign-in
//     hero (gradient) can mount together; with fixed ids the first defs in
//     document order would capture every url(#…) reference.

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AuroraWordmark } from './AuroraWordmark'

describe('AuroraWordmark', () => {
  it('names itself "Aurora Pro" by default', () => {
    render(<AuroraWordmark />)
    expect(screen.getByRole('img', { name: 'Aurora Pro' })).toBeInTheDocument()
  })

  it('is hidden from the tree when decorative (parent carries the name)', () => {
    const { container } = render(<AuroraWordmark decorative />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('gradient ink uses userSpaceOnUse so vertical stems keep their stroke', () => {
    const { container } = render(<AuroraWordmark />)
    const grad = container.querySelector('linearGradient')
    expect(grad).not.toBeNull()
    expect(grad).toHaveAttribute('gradientUnits', 'userSpaceOnUse')
  })

  it('flat ink renders no gradient and strokes with the given color', () => {
    const { container } = render(<AuroraWordmark ink="#DDD6FE" />)
    expect(container.querySelector('linearGradient')).toBeNull()
    expect(container.querySelector('g')).toHaveAttribute('stroke', '#DDD6FE')
  })

  it('photon cut layers a glowing copy under a band-masked copy', () => {
    const { container } = render(<AuroraWordmark variant="photon" />)
    expect(container.querySelector('mask')).not.toBeNull()
    expect(container.querySelector('filter')).not.toBeNull()
    const uses = container.querySelectorAll('use')
    expect(uses).toHaveLength(2)
    expect(uses[0].getAttribute('filter')).toMatch(/^url\(#/)
    expect(uses[1].getAttribute('mask')).toMatch(/^url\(#/)
  })

  it('two instances never share defs ids', () => {
    const { container } = render(
      <>
        <AuroraWordmark />
        <AuroraWordmark variant="photon" />
        <AuroraWordmark />
      </>,
    )
    const ids = Array.from(container.querySelectorAll('[id]')).map((el) => el.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
