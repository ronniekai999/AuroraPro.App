// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DetailView from './DetailView'
import type { Media } from '@/lib/types'

const api = vi.hoisted(() => ({
  getRecap: vi.fn(),
  getRecapStatus: vi.fn(),
  getUserRating: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getRecap: api.getRecap,
    getRecapStatus: api.getRecapStatus,
    getUserRating: api.getUserRating,
  }
})

vi.mock('@/components/detail/DetailRail', () => ({
  DetailRail: ({ onPrevious }: { onPrevious?: () => void }) => (
    <div>{onPrevious && <button type="button" onClick={onPrevious}>Previously</button>}</div>
  ),
}))

const show: Media = {
  id: 42,
  title: 'Charmed',
  year: 1998,
  rating: 8,
  duration: '',
  genre: 'Drama',
  type: 'show',
  poster: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  description: 'Three sisters discover their powers.',
}

function renderDetail(profileId: number) {
  return render(
    <DetailView
      media={show}
      profileId={profileId}
      selectedSeason={8}
      apiEpisodes={[]}
      onBack={() => {}}
      onPlay={() => {}}
      onToggleLib={() => {}}
      inLibrary
    />,
  )
}

beforeEach(() => {
  api.getRecap.mockReset()
  api.getRecapStatus.mockReset()
  api.getUserRating.mockReset().mockResolvedValue(0)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
})

describe('DetailView Previously affordance', () => {
  it('uses show-wide status for the active profile instead of the selected season rows', async () => {
    api.getRecapStatus.mockResolvedValue({ available: true, has_ask_history: false })
    renderDetail(7)

    expect(await screen.findByRole('button', { name: 'Previously' })).toBeInTheDocument()
    expect(api.getRecapStatus).toHaveBeenCalledWith(42, 7, expect.any(AbortSignal))
  })

  it('refreshes on profile change and keeps management access for saved history', async () => {
    api.getRecapStatus
      .mockResolvedValueOnce({ available: true, has_ask_history: false })
      .mockResolvedValueOnce({ available: false, reason: 'no_history', has_ask_history: true })
    const rendered = renderDetail(7)
    expect(await screen.findByRole('button', { name: 'Previously' })).toBeInTheDocument()

    rendered.rerender(
      <DetailView
        media={show}
        profileId={8}
        selectedSeason={8}
        apiEpisodes={[]}
        onBack={() => {}}
        onPlay={() => {}}
        onToggleLib={() => {}}
        inLibrary
      />,
    )
    await waitFor(() => expect(api.getRecapStatus).toHaveBeenLastCalledWith(42, 8, expect.any(AbortSignal)))
    expect(screen.getByRole('button', { name: 'Previously' })).toBeInTheDocument()
  })

  it('never renders the previous profile recap while the new profile loads', async () => {
    const user = userEvent.setup()
    api.getRecapStatus.mockResolvedValue({ available: true, has_ask_history: false })
    api.getRecap
      .mockResolvedValueOnce({
        available: true,
        recap: 'Private recap for profile seven.',
        suggested_questions: [],
        up_to: { episode_id: 513, season: 5, episode: 13 },
      })
      .mockReturnValueOnce(new Promise(() => {}))
    const rendered = renderDetail(7)
    await user.click(await screen.findByRole('button', { name: 'Previously' }))
    expect(await screen.findByText('Private recap for profile seven.')).toBeInTheDocument()

    rendered.rerender(
      <DetailView
        media={show}
        profileId={8}
        selectedSeason={8}
        apiEpisodes={[]}
        onBack={() => {}}
        onPlay={() => {}}
        onToggleLib={() => {}}
        inLibrary
      />,
    )

    await waitFor(() => expect(api.getRecap).toHaveBeenLastCalledWith(42, 8))
    expect(screen.queryByText('Private recap for profile seven.')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Generating recap')).toBeInTheDocument()
  })
})
