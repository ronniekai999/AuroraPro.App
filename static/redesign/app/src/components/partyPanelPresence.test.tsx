// @vitest-environment jsdom
//
// Party presence: who is speaking, and the rail telling the page it is open.
//
// The aurora ring round a person's disc means one thing, "this person is
// speaking right now", in the rail's roster and in the minimal face's voice
// pill alike. And the rail stamps `html[data-party-rail]`, which is what lets
// a boxed player leave room for it instead of sitting underneath it.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { PartyPanel } from './PartyPanel'
import type { PartyState } from '@/hooks/useParty'
import type { VoiceState } from '@/lib/voice'

const state: PartyState = {
  joining: false,
  code: 'AH2T5Y',
  partyName: 'Friday crew',
  mediaTitle: 'Night Train',
  hostUserId: 1,
  participants: [
    { user_id: 1, username: 'priya', is_host: true, is_buffering: false, last_seen: '', ready: true },
    { user_id: 2, username: 'jonah', is_host: false, is_buffering: false, last_seen: '', ready: false },
    { user_id: 3, username: 'dana', is_host: false, is_buffering: true, last_seen: '', ready: false },
  ],
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
}
const noop = () => {}
const voiceOf = (over: Partial<VoiceState>): VoiceState =>
  ({ enabled: true, muted: false, peers: [], selfSpeaking: false, status: 'Live', ...over })
const peer = (userId: number, username: string, speaking: boolean) =>
  ({ userId, username, speaking, connecting: false }) as VoiceState['peers'][number]

const panel = (variant: 'rail' | 'minimal', voice?: VoiceState, currentUserId = 2) => (
  <PartyPanel
    state={state}
    currentUserId={currentUserId}
    onSendChat={noop}
    onLeave={noop}
    onClose={noop}
    variant={variant}
    onToggleVariant={noop}
    voice={voice}
    onJoinVoice={noop}
    onLeaveVoice={noop}
    onToggleVoiceMute={noop}
  />
)
const speakingNames = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-speaking]')].map(d => d.closest('li')?.getAttribute('title') ?? '')

afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-party-rail'); document.documentElement.removeAttribute('data-party-dock') })

describe('the rail roster', () => {
  it('rings exactly the people who are speaking: a peer by the voice mesh, yourself by your own mic', () => {
    const view = render(panel('rail', voiceOf({ peers: [peer(1, 'priya', true), peer(3, 'dana', false)], selfSpeaking: false })))
    const roster = within(screen.getByRole('complementary', { name: 'Party' })).getByRole('list')
    expect(speakingNames(roster)).toEqual(['priya (host), talking · ready'])
    view.rerender(panel('rail', voiceOf({ peers: [peer(1, 'priya', false)], selfSpeaking: true })))
    expect(speakingNames(roster)).toEqual(['jonah, talking'])
  })

  it('rings nobody when nobody is in voice', () => {
    render(panel('rail', voiceOf({ enabled: false })))
    expect(document.querySelector('[data-speaking]')).toBeNull()
  })

  it('says who is speaking in words too, so the ring is not the only signal', () => {
    render(panel('rail', voiceOf({ peers: [peer(1, 'priya', true)] })))
    expect(screen.getByText('Voice · 1 talking')).toBeInTheDocument()
    expect(screen.getByText('priya is speaking')).toBeInTheDocument()
    // The roster line carries the state as text as well.
    expect(within(screen.getByRole('list')).getByText('talking · ready')).toBeInTheDocument()
    expect(within(screen.getByRole('list')).getByText('buffering')).toBeInTheDocument()
  })

  it('shows voice and playback state together: being in voice does not hide "ready" or "buffering"', () => {
    render(panel('rail', voiceOf({ peers: [peer(1, 'priya', false), peer(3, 'dana', false)] })))
    const titles = within(screen.getByRole('list')).getAllByRole('listitem').map(li => li.getAttribute('title'))
    expect(titles).toEqual(['priya (host), in voice · ready', 'jonah, in voice', 'dana, in voice · buffering'])
  })
})

describe('the voice pill (minimal face)', () => {
  it('rings the speaking peer and names the group for a screen reader', () => {
    render(panel('minimal', voiceOf({ peers: [peer(1, 'priya', true), peer(3, 'dana', false)] })))
    const group = screen.getByRole('img', { name: 'In voice: you, priya (talking), dana' })
    const ringed = [...group.querySelectorAll('[data-speaking]')]
    expect(ringed).toHaveLength(1)
    expect(ringed[0].parentElement).toHaveAttribute('title', 'priya, talking')
    expect(screen.getByText('1 talking')).toBeInTheDocument()
  })

  it('carries the hook that moves it below the player\'s top bar', () => {
    render(panel('minimal', voiceOf({})))
    const pill = () => document.querySelector<HTMLElement>('.stage-voice-pill')!
    expect(within(pill()).getByRole('button', { name: 'Mute microphone' })).toBeInTheDocument()
    expect(pill().className).toMatch(/\bfixed\b/)
    expect(pill().className).toMatch(/\btop-4\b/)
    expect(pill().className).toMatch(/\bright-4\b/)
    cleanup()
    render(panel('minimal', voiceOf({ enabled: false })))
    expect(within(pill()).getByRole('button', { name: /Join voice/ })).toBeInTheDocument()
    expect(pill().className).toMatch(/\btop-4\b/)
  })
})

describe('one person, one colour', () => {
  const colourOf = (el: Element) => (el.querySelector('span') as HTMLElement).style.background
  it('you are the same colour in the voice pill as in the rail\'s roster', () => {
    const voice = voiceOf({ peers: [peer(1, 'priya', false)] })
    const rail = render(panel('rail', voice))
    const mine = within(screen.getByRole('list')).getAllByRole('listitem')[1].querySelector('[aria-hidden="true"]')!
    const railColour = colourOf(mine)
    expect(railColour).not.toBe('')
    rail.unmount()
    render(panel('minimal', voice))
    const pillDiscs = [...screen.getByRole('img', { name: /^In voice:/ }).querySelectorAll(':scope > span > [aria-hidden="true"]')]
    expect(colourOf(pillDiscs[0])).toBe(railColour)
  })
})

describe('the minimal face tells the page its dock is on screen', () => {
  it('stamps html[data-party-dock] while the dock is up, and only then', () => {
    const view = render(panel('minimal'))
    expect(document.documentElement.dataset.partyDock).toBe('open')
    expect(document.querySelector('.stage-party-minidock')).not.toBeNull()
    view.rerender(panel('rail'))
    expect(document.documentElement.hasAttribute('data-party-dock')).toBe(false)
    view.unmount()
    expect(document.documentElement.hasAttribute('data-party-dock')).toBe(false)
  })
})

describe('the rail tells the page it is open', () => {
  it('stamps html[data-party-rail] while the rail is up, and only then', () => {
    const view = render(panel('rail'))
    expect(document.documentElement.dataset.partyRail).toBe('open')
    view.rerender(panel('minimal'))
    expect(document.documentElement.hasAttribute('data-party-rail')).toBe(false)
    view.rerender(panel('rail'))
    expect(document.documentElement.dataset.partyRail).toBe('open')
    view.unmount()
    expect(document.documentElement.hasAttribute('data-party-rail')).toBe(false)
  })
})
