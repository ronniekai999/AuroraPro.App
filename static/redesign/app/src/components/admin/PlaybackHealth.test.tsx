// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PlaybackHealthSummary } from '@/lib/api'
import { PlaybackHealth, percent, seconds } from './PlaybackHealth'

const api = vi.hoisted(() => ({ getPlaybackHealth: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const summary = (over: Partial<PlaybackHealthSummary> = {}): PlaybackHealthSummary => ({
  window_hours: 168, sessions: 96, p50_first_frame_ms: 1840, p95_first_frame_ms: 6200,
  direct_play_ratio: 0.885, rebuffer_ratio: 0.004, error_rate: 0.021, abandoned_ratio: 0.1, settled_sessions: 90,
  by_decision: [
    { decision: 'direct_play', count: 85, p50_first_frame_ms: 900, p95_first_frame_ms: 2100 },
    { decision: 'direct_stream', count: 4, p50_first_frame_ms: 2500, p95_first_frame_ms: null },
    { decision: 'transcode', count: 7, p50_first_frame_ms: 4800, p95_first_frame_ms: 12400 },
  ],
  burn_in_sessions: 2,
  top_reasons: [{ reason: 'audio_codec', count: 6 }, { reason: 'bit_depth', count: 3 }, { reason: 'unspecified', count: 2 }],
  ...over,
})

beforeEach(() => { api.getPlaybackHealth.mockReset().mockResolvedValue(summary()) })

const tile = (label: string) => screen.getByText(label).closest('div') as HTMLElement

describe('Playback health', () => {
  it('asks for the last 7 days first, and says how many sessions that was', async () => {
    render(<PlaybackHealth />)
    expect(api.getPlaybackHealth).toHaveBeenCalledWith(168, expect.anything())
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('96 playback sessions in the last 7 days.'))
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('says each number in plain words', async () => {
    render(<PlaybackHealth />)
    await screen.findByText('How things played')
    expect(tile('Played as they are')).toHaveTextContent('89%')
    expect(tile('Played as they are')).toHaveTextContent('11 sessions were repackaged or converted')
    expect(tile('Wait for the first picture')).toHaveTextContent('1.8 s')
    expect(tile('Wait for the first picture')).toHaveTextContent('One start in twenty took 6.2 s or longer.')
    // A share that is not zero never reads "0%".
    expect(tile('Time spent buffering')).toHaveTextContent('under 1%')
    expect(tile('Playback that failed')).toHaveTextContent('2%')
    expect(tile('Never reported an ending')).toHaveTextContent('10%')
    expect(tile('Never reported an ending')).toHaveTextContent('Of the 90 sessions old enough to have ended.')
  })

  it('lists each way of delivering a title by what it means, with its waits', async () => {
    render(<PlaybackHealth />)
    const table = await screen.findByRole('table', { name: 'How each was delivered' })
    const rows = within(table).getAllByRole('row').slice(1).map(r => r.textContent)
    expect(rows[0]).toMatch(/^Played as it is.*850\.9 s2\.1 s$/)
    expect(rows[1]).toMatch(/^Repackaged.*42\.5 sNot measured$/)
    expect(rows[2]).toMatch(/^Converted.*74\.8 s12 s$/)
    expect(within(table).queryByText(/direct_play|direct_stream|transcode/)).toBeNull()
  })

  it('says why sessions were not played as they are, in words, most common first', async () => {
    render(<PlaybackHealth />)
    const list = await screen.findByRole('list', { name: 'Why 11 sessions were not played as they are' })
    expect(within(list).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      'The device cannot play the audio format6',
      'The video is 10-bit or deeper, which the device does not take3',
      'No reason recorded2',
    ])
    expect(screen.getByText(/2 sessions had subtitles drawn into the picture/)).toBeInTheDocument()
  })

  it('asks again for another period, keeps one request per choice, and says the new count', async () => {
    render(<PlaybackHealth />)
    await screen.findByText('How things played')
    api.getPlaybackHealth.mockResolvedValue(summary({ window_hours: 720, sessions: 1 }))
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }))
    expect(api.getPlaybackHealth).toHaveBeenLastCalledWith(720, expect.anything())
    expect(api.getPlaybackHealth).toHaveBeenCalledTimes(2)
    // The other period's numbers are not shown as this period's.
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    expect(screen.queryByText('How things played')).toBeNull()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 playback session in the last 30 days.'))
    fireEvent.click(screen.getByRole('button', { name: 'Last 24 hours' }))
    expect(api.getPlaybackHealth).toHaveBeenLastCalledWith(24, expect.anything())
  })

  it('says so when nothing was played, and shows no empty tables', async () => {
    api.getPlaybackHealth.mockResolvedValue(summary({ sessions: 0, by_decision: [], top_reasons: [], burn_in_sessions: 0, p50_first_frame_ms: null, p95_first_frame_ms: null, settled_sessions: 0 }))
    render(<PlaybackHealth />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No playback was recorded in the last 7 days.'))
    expect(screen.queryByText('How things played')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  // A bare 0% for sessions that never reported an ending would read as a
  // clean bill of health when there is nothing to judge yet.
  it('does not turn "no data" into a number', async () => {
    api.getPlaybackHealth.mockResolvedValue(summary({ settled_sessions: 0, abandoned_ratio: 0, p50_first_frame_ms: null, p95_first_frame_ms: null, top_reasons: [], burn_in_sessions: 0 }))
    render(<PlaybackHealth />)
    await screen.findByText('How things played')
    expect(tile('Never reported an ending')).toHaveTextContent('Too soon to say')
    expect(tile('Never reported an ending')).toHaveTextContent('No session in this period is old enough to have ended yet.')
    expect(tile('Wait for the first picture')).toHaveTextContent('Not measured')
    expect(screen.queryByText(/not played as/)).toBeNull()
    expect(screen.queryByText(/subtitles drawn into the picture/)).toBeNull()
  })

  it('says when the numbers cannot be loaded, and tries again when asked', async () => {
    api.getPlaybackHealth.mockRejectedValueOnce(new Error('HTTP 500: failed to compute playback summary'))
    render(<PlaybackHealth />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The playback numbers could not be loaded.')
    expect(screen.queryByText('How things played')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByText('How things played')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.getPlaybackHealth).toHaveBeenCalledTimes(2)
  })

  it('says what the numbers are, and that they name nobody', async () => {
    render(<PlaybackHealth />)
    expect(screen.getByText(/They hold no title and no name: nothing here says who watched what\./)).toBeInTheDocument()
  })

  it('writes waits and shares so that small ones are not lost', () => {
    expect([seconds(null), seconds(0), seconds(940), seconds(9940), seconds(10400), seconds(61000)]).toEqual([null, '0.0 s', '0.9 s', '9.9 s', '10 s', '61 s'])
    expect([percent(0), percent(0.004), percent(0.01), percent(0.456), percent(0.995), percent(1)]).toEqual(['0%', 'under 1%', '1%', '46%', 'over 99%', '100%'])
  })
})
