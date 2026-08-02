// @vitest-environment jsdom
//
// Watch-party chrome — two user-reported confusions (2026-08):
//
//   1. Minimizing the chat parked the restore chip ON the player title.
//      The chip belongs at viewport `top-4 left-4`, mirroring the VoicePill
//      pinned at `top-4 right-4` on the opposite side of the screen. The old
//      theater rule re-anchored it INTO the theater box's top-left — the
//      corner the player topbar's title block owns. The rule now adjusts
//      `top` ONLY (via `--theater-chip-top`, index.css): unchanged while the
//      box is inset, below the always-visible topbar when the theater goes
//      full-bleed and the title moves under the viewport corner. jsdom
//      computes no CSS geometry, so these tests pin the React half of that
//      contract: the base utilities and the `stage-party-dock` hook the
//      theater rule keys on. The rule's own geometry lives in index.css and
//      the manual verify-built-css.mjs report.
//
//   2. The rail-header minimize button wore the corners-out glyph — the
//      universal FULLSCREEN icon, while the player's real fullscreen button
//      is on screen at the same time. It's now a window-chrome minus named
//      "Minimize the party chat", and the restore chip is a chat bubble
//      named "Open the party chat" instead of that same corners-out glyph.

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PartyPanel } from './PartyPanel'
import type { PartyState } from '@/hooks/useParty'

// The corners-out "expand" path both buttons used to share. Pinning the exact
// path is deliberate: any other glyph is acceptable — this one specifically
// reads as "go fullscreen".
const FULLSCREEN_GLYPH =
  'M4 4h7v2H6v5H4V4zm9 0h7v7h-2V6h-5V4zM4 13h2v5h5v2H4v-7zm14 0h2v7h-7v-2h5v-5z'

const state: PartyState = {
  joining: false,
  code: 'AH2T5Y',
  partyName: "miles's Party",
  mediaTitle: 'The Haunted Mansion',
  hostUserId: 1,
  participants: [
    { user_id: 1, username: 'miles', is_host: true, is_buffering: false, last_seen: '', ready: true },
    { user_id: 2, username: 'ron', is_host: false, is_buffering: false, last_seen: '', ready: false },
  ],
  chat: [],
  recentReactions: [],
  isPlaying: false,
  currentTimeMs: 0,
  hlsStartSec: 0,
  rev: 0,
  roomConnected: true,
  syncConnected: true,
  reconnecting: false,
  syncReconnecting: false,
  error: null,
}

const noop = () => {}

const renderPanel = (
  variant: 'rail' | 'minimal',
  onToggleVariant?: () => void,
) =>
  render(
    <PartyPanel
      state={state}
      currentUserId={2}
      onSendChat={noop}
      onLeave={noop}
      onClose={noop}
      variant={variant}
      onToggleVariant={onToggleVariant}
    />,
  )

const glyphPaths = (button: HTMLElement) =>
  [...button.querySelectorAll('path')].map(p => p.getAttribute('d'))

describe('minimal face — the restore chip', () => {
  const chip = (onToggleVariant: () => void = vi.fn()) => {
    renderPanel('minimal', onToggleVariant)
    return screen.getByRole('button', { name: 'Open the party chat' })
  }

  it('anchors viewport top-left, opposite the top-right VoicePill', () => {
    const el = chip()
    expect(el.className).toMatch(/\bfixed\b/)
    expect(el.className).toMatch(/\btop-4\b/)
    expect(el.className).toMatch(/\bleft-4\b/)
  })

  it('carries the stage-party-dock hook for the full-bleed top adjustment', () => {
    // Without this class the theater rule can't lower the chip below the
    // full-bleed topbar, and the chip sits on the title again on any
    // sub-1024px viewport.
    expect(chip().className).toMatch(/\bstage-party-dock\b/)
  })

  it('does not wear the fullscreen glyph', () => {
    expect(glyphPaths(chip())).not.toContain(FULLSCREEN_GLYPH)
  })

  it('expands back to the rail on click', async () => {
    const user = userEvent.setup()
    const onToggleVariant = vi.fn()
    await user.click(chip(onToggleVariant))
    expect(onToggleVariant).toHaveBeenCalledTimes(1)
  })

  it('is absent when the parent locks the minimal presentation', () => {
    renderPanel('minimal', undefined)
    expect(
      screen.queryByRole('button', { name: 'Open the party chat' }),
    ).toBeNull()
  })
})

describe('rail header — the minimize button', () => {
  const minimize = (onToggleVariant: () => void = vi.fn()) => {
    renderPanel('rail', onToggleVariant)
    return screen.getByRole('button', { name: 'Minimize the party chat' })
  }

  it('does not wear the fullscreen glyph', () => {
    expect(glyphPaths(minimize())).not.toContain(FULLSCREEN_GLYPH)
  })

  it('collapses the rail on click', async () => {
    const user = userEvent.setup()
    const onToggleVariant = vi.fn()
    await user.click(minimize(onToggleVariant))
    expect(onToggleVariant).toHaveBeenCalledTimes(1)
  })

  it('is absent for rail-only callers', () => {
    renderPanel('rail', undefined)
    expect(
      screen.queryByRole('button', { name: 'Minimize the party chat' }),
    ).toBeNull()
  })
})
