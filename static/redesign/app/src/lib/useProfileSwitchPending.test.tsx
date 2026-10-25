// @vitest-environment jsdom
//
// The contract App's views rely on: pending on the render that changes the
// profile, and no longer once that render's effects have run. Every render's
// value is recorded, because the one that matters never survives to the end of
// an act() (its effects flip it straight back).

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { useProfileSwitchPending } from './useProfileSwitchPending'

function record() {
  const seen: [number | null, boolean][] = []
  function Probe({ id, settled = true }: { id: number | null; settled?: boolean }) {
    seen.push([id, useProfileSwitchPending(id, settled)])
    return null
  }
  return { seen, Probe }
}
const pendingFor = (seen: [number | null, boolean][], id: number | null) =>
  seen.filter(([at]) => at === id).map(([, pending]) => pending)

describe('useProfileSwitchPending', () => {
  it('is pending for the render that switches, until its effects run', () => {
    const { seen, Probe } = record()
    const view = render(<Probe id={1} />)
    view.rerender(<Probe id={2} />)
    expect(seen).toEqual([[1, false], [2, true], [2, false]])
  })

  it('does not count the startup binding arriving as a switch', () => {
    const { seen, Probe } = record()
    const view = render(<Probe id={null} settled={false} />)
    // App sets the binding and the startup flag in one render.
    view.rerender(<Probe id={1} settled={true} />)
    expect(seen.every(([, pending]) => !pending)).toBe(true)
  })

  it('counts a pick from the picker an unreadable binding opened', () => {
    const { seen, Probe } = record()
    const view = render(<Probe id={null} settled={false} />)
    // Startup settles without a binding; the catalog loads behind the picker.
    view.rerender(<Probe id={null} settled={true} />)
    view.rerender(<Probe id={2} settled={true} />)
    expect(pendingFor(seen, null).every(p => !p)).toBe(true)
    expect(pendingFor(seen, 2)).toEqual([true, false])
  })

  it('counts losing the binding, and a pick after it', () => {
    const { seen, Probe } = record()
    const view = render(<Probe id={1} />)
    view.rerender(<Probe id={null} />)
    view.rerender(<Probe id={2} />)
    expect(pendingFor(seen, null)).toEqual([true, false])
    expect(pendingFor(seen, 2)).toEqual([true, false])
  })
})
