// @vitest-environment jsdom
//
// The share card's two SPA-side promises:
//
//   1. The "Share card" button is HOST-ONLY. The server 403s a non-host
//      asking for card-links, but a button that 403s is a bug report; the
//      lobby must not render it for a guest at all.
//   2. The card is offered from the composer's SCHEDULED-success state and
//      nowhere else — "right now" means the host is about to be in the
//      room, not posting about it.

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// vi.mock is hoisted above the imports, so the doubles have to be too.
const { getPartyCardLinks, getPartyInviteRoster, listMembers } = vi.hoisted(() => ({
  getPartyCardLinks: vi.fn(),
  getPartyInviteRoster: vi.fn(async () => []),
  listMembers: vi.fn(async () => []),
}))

vi.mock('@/lib/api', () => ({
  getPartyCardLinks,
  getPartyInviteRoster,
  listMembers,
}))

import { PartyShareCardModal } from './PartyShareCardModal'
import { PartyLobbyCard } from './PartyLobbyCard'
import { PartyComposerModal } from './PartyComposerModal'

const LINKS = {
  code: '7K2QD9',
  story: 'http://localhost:3000/api/parties/7K2QD9/card.png?v=story&t=abcdef0123456789',
  page: 'http://localhost:3000/p/7K2QD9',
}

const soon = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()

describe('PartyShareCardModal', () => {
  it('renders the signed preview and the Phase 1 actions', async () => {
    getPartyCardLinks.mockResolvedValueOnce(LINKS)
    render(<PartyShareCardModal code="7K2QD9" onClose={() => {}} />)

    const img = await screen.findByAltText('Watch party card for code 7K2QD9')
    expect(img).toHaveAttribute('src', LINKS.story)
    expect(screen.getByRole('button', { name: 'Download PNG' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    // Phase 1 ships one crop; the tab strip is the seam Phase 2 widens.
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    // The privacy promise is stated on the surface that publishes it.
    expect(screen.getByText(/nobody\s+you invited is shown/i)).toBeInTheDocument()
  })

  it('surfaces a card-links failure instead of a broken preview', async () => {
    getPartyCardLinks.mockRejectedValueOnce(new Error('only the host can share this party’s card'))
    render(<PartyShareCardModal code="7K2QD9" onClose={() => {}} />)
    expect(await screen.findByText(/only the host can share/i)).toBeInTheDocument()
    expect(screen.queryByAltText('Watch party card for code 7K2QD9')).not.toBeInTheDocument()
  })

  it('uses the caller’s heading when one is supplied', async () => {
    getPartyCardLinks.mockResolvedValueOnce(LINKS)
    render(<PartyShareCardModal code="7K2QD9" title="Party booked 🎉" onClose={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'Party booked 🎉' })).toBeInTheDocument()
  })
})

describe('PartyLobbyCard share button', () => {
  it('offers the card to the host', async () => {
    getPartyCardLinks.mockResolvedValue(LINKS)
    render(<PartyLobbyCard code="7K2QD9" scheduledStartAt={soon()} isHost onStartNow={() => {}} />)

    const btn = screen.getByRole('button', { name: 'Share card' })
    await userEvent.click(btn)
    await waitFor(() => expect(getPartyCardLinks).toHaveBeenCalledWith('7K2QD9', expect.anything()))
    expect(screen.getByRole('dialog', { name: 'Watch party share card' })).toBeInTheDocument()
  })

  it('hides it from a guest', () => {
    render(<PartyLobbyCard code="7K2QD9" scheduledStartAt={soon()} isHost={false} />)
    expect(screen.queryByRole('button', { name: 'Share card' })).not.toBeInTheDocument()
  })
})

describe('PartyComposerModal scheduled-success state', () => {
  it('hands a booked party straight to the share card', async () => {
    getPartyCardLinks.mockResolvedValue(LINKS)
    const onLaunch = vi.fn(async () => ({ ok: true, code: '7K2QD9' }))
    render(
      <PartyComposerModal
        mediaTitle="Jurassic World Dominion"
        onClose={() => {}}
        onLaunch={onLaunch}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Schedule' }))
    // Take the first quick-pick chip, whatever tonight/tomorrow it offers.
    const chip = screen.getAllByRole('button').find(b => /Tonight|Tomorrow/.test(b.textContent ?? ''))
    expect(chip).toBeDefined()
    await userEvent.click(chip!)
    await userEvent.click(screen.getByRole('button', { name: /Schedule party/ }))

    expect(await screen.findByRole('heading', { name: 'Party booked 🎉' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download PNG' })).toBeInTheDocument()
  })

  it('closes without the card for a right-now party', async () => {
    const onClose = vi.fn()
    const onLaunch = vi.fn(async () => ({ ok: true, code: '7K2QD9' }))
    render(
      <PartyComposerModal mediaTitle="Dune" onClose={onClose} onLaunch={onLaunch} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Start party' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: 'Party booked 🎉' })).not.toBeInTheDocument()
  })
})
