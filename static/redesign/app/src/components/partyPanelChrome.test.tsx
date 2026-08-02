// @vitest-environment jsdom
//
// Watch-party chrome — two user-reported confusions (2026-08):
//
//   1. Minimizing the chat parked the restore chip ON the player title.
//      The chip's own classes put it at viewport `top-4 left-4` — mirroring
//      the VoicePill pinned at `top-4 right-4` on the opposite side of the
//      screen — but the `stage-party-dock` class opted it into a theater-mode
//      CSS re-anchor (index.css) that moved it into the theater box's
//      top-left corner, exactly where the player topbar draws the title.
//      The class and the CSS rule are gone; these tests pin the chip to its
//      viewport anchoring so the hook can't quietly come back.
//
//   2. The rail-header minimize button wore the corners-out glyph — the
//      universal FULLSCREEN icon, while the player's real fullscreen button
//      is on screen at the same time. It's now a window-chrome minus, and
//      the restore chip is a chat bubble instead of that same glyph.

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

const renderPanel = (variant: 'rail' | 'minimal') =>
  render(
    <PartyPanel
      state={state}
      currentUserId={2}
      onSendChat={noop}
      onLeave={noop}
      onClose={noop}
      variant={variant}
      onToggleVariant={vi.fn()}
    />,
  )

const glyphPaths = (button: HTMLElement) =>
  [...button.querySelectorAll('path')].map(p => p.getAttribute('d'))

describe('minimal face — the restore chip', () => {
  const chip = () => {
    renderPanel('minimal')
    return screen.getByRole('button', { name: 'Open the party chat' })
  }

  it('stays viewport-anchored top-left, opposite the top-right VoicePill', () => {
    const el = chip()
    expect(el.className).toMatch(/\bfixed\b/)
    expect(el.className).toMatch(/\btop-4\b/)
    expect(el.className).toMatch(/\bleft-4\b/)
  })

  it('does not carry the theater re-anchor hook that parked it on the title', () => {
    expect(chip().className).not.toMatch(/stage-party-dock/)
  })

  it('does not wear the fullscreen glyph', () => {
    expect(glyphPaths(chip())).not.toContain(FULLSCREEN_GLYPH)
  })
})

describe('rail header — the minimize button', () => {
  const minimize = () => {
    renderPanel('rail')
    return screen.getByRole('button', { name: 'Minimize the party chat' })
  }

  it('is named as a minimize action', () => {
    expect(minimize()).toBeInTheDocument()
  })

  it('does not wear the fullscreen glyph', () => {
    expect(glyphPaths(minimize())).not.toContain(FULLSCREEN_GLYPH)
  })
})
