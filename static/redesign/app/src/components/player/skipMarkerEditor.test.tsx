// @vitest-environment jsdom
//
// The skip-marker editor's unsaved work and its late answers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SkipMarkerEditor } from './SkipMarkerEditor'
import { deleteSkipMarker, getAdminSkipMarkers, putSkipMarker, type SkipMarker } from '@/lib/api'

vi.mock('@/lib/api', async original => ({
  ...await original<typeof import('@/lib/api')>(),
  getAdminSkipMarkers: vi.fn(),
  putSkipMarker: vi.fn(),
  deleteSkipMarker: vi.fn(async () => {}),
}))

const marker = (kind: SkipMarker['kind'], start: number, end: number, detector = 'chapters'): SkipMarker =>
  ({ kind, start_ms: start * 1000, end_ms: end * 1000, detector } as SkipMarker)
const FILE_10 = [marker('intro', 10, 60), marker('credits', 500, 560)]
const FILE_20 = [marker('intro', 5, 35)]

const settle = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
const row = (kind: string) => within(screen.getByRole('group', { name: kind }))
const press = (kind: string, name: string) => fireEvent.click(row(kind).getByRole('button', { name }))
const shown = (kind: string) => screen.getByRole('group', { name: kind }).textContent ?? ''

beforeEach(() => {
  vi.mocked(getAdminSkipMarkers).mockImplementation(async id => (id === 20 ? FILE_20 : FILE_10))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('SkipMarkerEditor: unsaved edits', () => {
  // A write answers with the file's whole list. Taking all of it threw away
  // what had been set on the other kinds and not saved yet.
  it('keeps an unsaved edit to one kind when another kind is saved, turned off or re-detected', async () => {
    vi.mocked(putSkipMarker).mockImplementation(async (_id, _type, body) => (
      FILE_10.filter(m => m.kind !== body.kind).concat(marker(body.kind, body.start_ms / 1000, body.end_ms / 1000, 'manual'))
    ))
    render(<SkipMarkerEditor fileId={10} fileType="media" currentSec={72} onMarkersChanged={() => {}} />)
    await settle()
    expect(shown('intro')).toContain('0:10 to 1:00')

    // The intro's end is moved and NOT saved.
    press('intro', 'End = now')
    expect(shown('intro')).toContain('0:10 to 1:12')

    press('credits', 'Save'); await settle()
    expect(shown('credits')).toContain('manual')
    expect(shown('intro')).toContain('0:10 to 1:12')

    press('recap', 'Off'); await settle()
    expect(shown('recap')).toContain('off')
    expect(shown('intro')).toContain('0:10 to 1:12')

    press('credits', 'Auto'); await settle()
    expect(deleteSkipMarker).toHaveBeenCalledWith(10, 'media', 'credits')
    expect(shown('intro')).toContain('0:10 to 1:12')
  })

  it('takes the server\'s value for the kind that was written, and for kinds with no edit', async () => {
    // The server rounds what it stores, and reports another kind changed
    // meanwhile (the analyser found the credits).
    vi.mocked(putSkipMarker).mockResolvedValue([marker('intro', 10, 70, 'manual'), marker('credits', 505, 561)])
    render(<SkipMarkerEditor fileId={10} fileType="media" currentSec={72} onMarkersChanged={() => {}} />)
    await settle()
    press('intro', 'End = now')
    press('intro', 'Save'); await settle()
    expect(shown('intro')).toContain('0:10 to 1:10')
    expect(shown('credits')).toContain('8:25 to 9:21')
    // Saved, so no longer an unsaved edit: the next answer replaces it.
    vi.mocked(putSkipMarker).mockResolvedValue([marker('intro', 12, 66, 'manual')])
    press('credits', 'Off'); await settle()
    expect(shown('intro')).toContain('0:12 to 1:06')
  })
})

describe('SkipMarkerEditor: an answer that arrives late', () => {
  const deferredWrite = () => {
    let resolve!: (m: SkipMarker[]) => void
    vi.mocked(putSkipMarker).mockImplementation(() => new Promise<SkipMarker[]>(r => { resolve = r }))
    return (m: SkipMarker[]) => act(async () => { resolve(m) })
  }

  // The player hands whatever this reports to its timeline and Skip button.
  it('is dropped once the editor is for another file', async () => {
    const answer = deferredWrite()
    const onMarkersChanged = vi.fn()
    const view = render(<SkipMarkerEditor fileId={10} fileType="media" currentSec={72} onMarkersChanged={onMarkersChanged} />)
    await settle()
    press('intro', 'Save')
    view.rerender(<SkipMarkerEditor fileId={20} fileType="media" currentSec={3} onMarkersChanged={onMarkersChanged} />)
    await settle()
    expect(shown('intro')).toContain('0:05 to 0:35')
    await answer([marker('intro', 10, 72, 'manual'), marker('credits', 500, 560)]); await settle()
    expect(onMarkersChanged).not.toHaveBeenCalled()
    expect(shown('intro')).toContain('0:05 to 0:35')
    expect(shown('credits')).toContain('none')
    // And the new file's buttons are not left disabled by the old request.
    expect(row('intro').getByRole('button', { name: 'End = now' })).toBeEnabled()
  })

  it('is dropped once the editor is gone', async () => {
    const answer = deferredWrite()
    const onMarkersChanged = vi.fn()
    const view = render(<SkipMarkerEditor fileId={10} fileType="media" currentSec={72} onMarkersChanged={onMarkersChanged} />)
    await settle()
    press('intro', 'Save')
    view.unmount()
    await answer([marker('intro', 10, 72, 'manual')]); await settle()
    expect(onMarkersChanged).not.toHaveBeenCalled()
  })

  it('is kept while the editor is only put away', async () => {
    const answer = deferredWrite()
    const onMarkersChanged = vi.fn()
    const view = render(<SkipMarkerEditor fileId={10} fileType="media" currentSec={72} onMarkersChanged={onMarkersChanged} />)
    await settle()
    press('intro', 'Save')
    view.rerender(<SkipMarkerEditor fileId={10} fileType="media" currentSec={72} onMarkersChanged={onMarkersChanged} hidden />)
    const saved = [marker('intro', 10, 60, 'manual'), marker('credits', 500, 560)]
    await answer(saved); await settle()
    expect(onMarkersChanged).toHaveBeenCalledExactlyOnceWith(saved)
  })
})
