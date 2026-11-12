// @vitest-environment jsdom
//
// Host succession (2026-08) — the PartyPanel side of "a party survives
// its host leaving". The server hands the party to the most senior
// remaining watcher on a host leave (promoteSuccessorLocked); the
// panel's job is to offer the right choices:
//
//   - host with an eligible successor → button says "Leave Party", and
//     the dialog offers "Hand off & leave" (plain onLeave — the server
//     does the promoting) vs "End for everyone" (onEndParty → the
//     deliberate POST /end).
//   - host with NO eligible successor (alone, or only phone companions,
//     who can't inherit — no player) → the historical "End the party?"
//     confirm, because their leave really does end it.
//   - guest → silent leave, no dialog. Unchanged.

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PartyPanel } from './PartyPanel'
import type { PartyState } from '@/hooks/useParty'
import type { PartyParticipant } from '@/lib/party'

const HOST: PartyParticipant = {
  user_id: 1, username: 'miles', is_host: true, is_buffering: false, last_seen: '', ready: true,
}
const GUEST: PartyParticipant = {
  user_id: 2, username: 'ron', is_host: false, is_buffering: false, last_seen: '', ready: true,
}
const PHONE: PartyParticipant = {
  user_id: 3, username: 'javon', is_host: false, is_buffering: false, last_seen: '', ready: false,
  companion: true,
}

const baseState = (participants: PartyParticipant[]): PartyState => ({
  joining: false,
  code: 'AH2T5Y',
  partyName: "miles's Party",
  mediaTitle: 'The Haunted Mansion',
  hostUserId: 1,
  participants,
  chat: [],
  recentReactions: [],
  isPlaying: true,
  currentTimeMs: 0,
  hlsStartSec: 0,
  rev: 0,
  roomConnected: true,
  syncConnected: true,
  reconnecting: false,
  syncReconnecting: false,
  scheduledStartAt: null,
  startedAt: null,
  error: null,
})

const renderPanel = (opts: {
  participants: PartyParticipant[]
  currentUserId: number
  onLeave?: () => void
  onEndParty?: () => void
}) =>
  render(
    <PartyPanel
      state={baseState(opts.participants)}
      currentUserId={opts.currentUserId}
      onSendChat={() => {}}
      onLeave={opts.onLeave ?? (() => {})}
      onClose={() => {}}
      onEndParty={opts.onEndParty}
    />,
  )

describe('host with an eligible successor', () => {
  it('labels the action "Leave Party" — leaving no longer ends the show', () => {
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1 })
    expect(screen.getByRole('button', { name: 'Leave Party' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'End Party' })).toBeNull()
  })

  it('offers hand-off vs end-for-everyone, wired to the right callbacks', async () => {
    const user = userEvent.setup()
    const onLeave = vi.fn()
    const onEndParty = vi.fn()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1, onLeave, onEndParty })

    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    // Hand-off is a plain leave — the SERVER promotes; the client must
    // not pretend to know the successor.
    await user.click(screen.getByRole('button', { name: 'Hand off & leave' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(onEndParty).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    await user.click(screen.getByRole('button', { name: 'End for everyone' }))
    expect(onEndParty).toHaveBeenCalledTimes(1)
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('omits "End for everyone" when the parent did not wire onEndParty', async () => {
    const user = userEvent.setup()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1 })
    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    expect(screen.getByRole('button', { name: 'Hand off & leave' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'End for everyone' })).toBeNull()
  })
})

describe('host with no eligible successor', () => {
  it('keeps the historical end-confirm when only companions remain', async () => {
    // A phone companion can't inherit the party (no player, no sync
    // socket — the server's rule), so this host's leave still ends it
    // and the UI must say so, not promise a hand-off.
    const user = userEvent.setup()
    const onLeave = vi.fn()
    renderPanel({ participants: [HOST, PHONE], currentUserId: 1, onLeave })

    await user.click(screen.getByRole('button', { name: 'End Party' }))
    expect(screen.queryByRole('button', { name: 'Hand off & leave' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'End party' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('keeps the historical end-confirm for a lone host', async () => {
    const user = userEvent.setup()
    renderPanel({ participants: [HOST], currentUserId: 1 })
    await user.click(screen.getByRole('button', { name: 'End Party' }))
    expect(screen.queryByRole('button', { name: 'Hand off & leave' })).toBeNull()
    expect(screen.getByRole('button', { name: 'End party' })).toBeInTheDocument()
  })
})

describe('guest', () => {
  it('leaves silently — no dialog, callback fires directly', async () => {
    const user = userEvent.setup()
    const onLeave = vi.fn()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 2, onLeave })
    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Hand off & leave' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'End for everyone' })).toBeNull()
  })
})

// The confirm declares itself modal, so it has to be one: a screen reader
// that honours `aria-modal` exposes nothing outside it, and a user whose
// focus was left behind is then nowhere.
describe('the host\u2019s leave confirmation as a modal', () => {
  const open = async () => {
    const user = userEvent.setup()
    const onLeave = vi.fn(), onEndParty = vi.fn()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1, onLeave, onEndParty })
    const leave = screen.getByRole('button', { name: 'Leave Party' })
    await user.click(leave)
    const dialog = screen.getByRole('alertdialog', { name: 'Leave the party?' })
    return { user, leave, dialog, onLeave, onEndParty }
  }

  it('takes focus, on the answer that changes nothing', async () => {
    const { dialog } = await open()
    expect(within(dialog).getByRole('button', { name: 'Keep watching' })).toHaveFocus()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription(/hosting passes to another/)
  })

  it('keeps Tab among its own buttons, in both directions', async () => {
    const { dialog } = await open()
    const keep = within(dialog).getByRole('button', { name: 'Keep watching' })
    const handOff = within(dialog).getByRole('button', { name: 'Hand off & leave' })
    handOff.focus()
    expect(fireEvent.keyDown(handOff, { key: 'Tab' })).toBe(false)
    expect(keep).toHaveFocus()
    expect(fireEvent.keyDown(keep, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(handOff).toHaveFocus()
    // Between the ends Tab is the browser's to move.
    keep.focus()
    expect(fireEvent.keyDown(keep, { key: 'Tab' })).toBe(true)
  })

  it('closes on Escape without the key reaching the app, and leaves nobody out of the party', async () => {
    const { leave, onLeave, onEndParty } = await open()
    const appHandler = vi.fn()
    window.addEventListener('keydown', appHandler)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    window.removeEventListener('keydown', appHandler)
    expect(appHandler).not.toHaveBeenCalled()
    expect(onLeave).not.toHaveBeenCalled()
    expect(onEndParty).not.toHaveBeenCalled()
    // Focus is back where it came from, on every way of closing.
    expect(leave).toHaveFocus()
  })

  it('returns focus to the leave button when dismissed with Keep watching', async () => {
    const { user, leave, dialog } = await open()
    await user.click(within(dialog).getByRole('button', { name: 'Keep watching' }))
    expect(leave).toHaveFocus()
  })

  it('does not listen for Escape once it is closed', async () => {
    const { user, dialog } = await open()
    await user.click(within(dialog).getByRole('button', { name: 'Keep watching' }))
    const appHandler = vi.fn()
    window.addEventListener('keydown', appHandler)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', appHandler)
    expect(appHandler).toHaveBeenCalledTimes(1)
  })
})

// The player listens on window for its shortcuts. With the confirm open, a
// key is the confirm's: an arrow or a "k" pressed at "End the party?" was
// seeking and pausing the film for everyone.
describe('keys while the host\u2019s leave confirmation is open', () => {
  it('do not reach a shortcut listener on window, and reach it again once it is closed', async () => {
    const user = userEvent.setup()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1 })
    const shortcuts = vi.fn()
    window.addEventListener('keydown', shortcuts)
    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    shortcuts.mockClear()
    for (const key of ['ArrowLeft', 'k', 'f', 'm', ' ', 'Tab']) fireEvent.keyDown(document.activeElement!, { key })
    expect(shortcuts).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Keep watching' }))
    shortcuts.mockClear()
    fireEvent.keyDown(document.body, { key: 'k' })
    expect(shortcuts).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', shortcuts)
  })

  // The rail is outside the element that goes fullscreen, so in browser
  // fullscreen the confirm is not drawn, but focus can still be on the leave
  // button: a Space there opened it unseen, and the player's keys were dead
  // until it closed.
  it('are left alone while the confirm is not drawn, in browser fullscreen', async () => {
    const user = userEvent.setup()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1 })
    const shortcuts = vi.fn()
    window.addEventListener('keydown', shortcuts)
    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    const elsewhere = document.createElement('div')
    document.body.append(elsewhere)
    // jsdom has no Fullscreen API; this is what a browser reports.
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => elsewhere })
    shortcuts.mockClear()
    for (const key of ['ArrowLeft', 'k', 'f']) fireEvent.keyDown(document.body, { key })
    expect(shortcuts).toHaveBeenCalledTimes(3)
    // Tab is not pulled into a confirm nobody can see.
    const outside = screen.getByPlaceholderText(/Message the party/)
    outside.focus()
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(true)
    expect(outside).toHaveFocus()
    delete (document as unknown as { fullscreenElement?: Element }).fullscreenElement
    elsewhere.remove()
    window.removeEventListener('keydown', shortcuts)
  })

  // A prompt the app opens above the confirm from elsewhere keeps its keys:
  // its Tab is not pulled under it, and what it listens for arrives.
  it('are left to a dialog opened above the confirm from elsewhere', async () => {
    const user = userEvent.setup()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1 })
    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    const prompt = document.createElement('div')
    prompt.setAttribute('role', 'dialog')
    prompt.innerHTML = '<input aria-label="PIN" /><button>Unlock</button>'
    document.body.append(prompt)
    const reached = vi.fn()
    window.addEventListener('keydown', reached)
    const pin = prompt.querySelector('input')!
    pin.focus()
    expect(fireEvent.keyDown(pin, { key: 'Tab' })).toBe(true)
    expect(pin).toHaveFocus()
    fireEvent.keyDown(pin, { key: '4' })
    expect(reached).toHaveBeenCalledTimes(2)
    window.removeEventListener('keydown', reached); prompt.remove()
  })

  it('leave a Tab with a modifier to the browser', async () => {
    const user = userEvent.setup()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1 })
    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    const outside = screen.getByPlaceholderText(/Message the party/)
    outside.focus()
    expect(fireEvent.keyDown(outside, { key: 'Tab', ctrlKey: true })).toBe(true)
    expect(outside).toHaveFocus()
  })

  it('bring focus into the confirm when Tab is pressed with focus outside it', async () => {
    const user = userEvent.setup()
    renderPanel({ participants: [HOST, GUEST], currentUserId: 1 })
    await user.click(screen.getByRole('button', { name: 'Leave Party' }))
    const outside = screen.getByPlaceholderText(/Message the party/)
    outside.focus()
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(false)
    expect(screen.getByRole('button', { name: 'Keep watching' })).toHaveFocus()
  })
})
