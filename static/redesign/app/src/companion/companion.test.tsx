// @vitest-environment jsdom
// The phone companion: its join screen, its sign-in and its room.
//
// What these pin is what each screen says and what it calls. The
// connection itself (useCompanion) is replaced where the root is mounted,
// and is not what is under test here.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APIError, type User } from '@/lib/api'
import { QUICK_REACTIONS } from '@/lib/reactions'
import type { VoiceState } from '@/lib/voice'
import type { CompanionState, UseCompanion } from '@/hooks/useCompanion'

const api = vi.hoisted(() => ({
  getCompanionPartyPreview: vi.fn(),
  fetchMe: vi.fn(),
  getSetupStatus: vi.fn(),
  getStoredUser: vi.fn(),
  login: vi.fn(),
}))
vi.mock('@/lib/api', async orig => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }))

const ambient = vi.hoisted(() => ({ ambientFor: vi.fn() }))
vi.mock('@/lib/ambient', () => ambient)

const companion = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/hooks/useCompanion', () => ({ useCompanion: () => companion.current }))

import { JoinScreen, plannedStartPhrase } from './JoinScreen'
import { CompanionRoom, type CompanionRoomProps } from './CompanionRoom'
import { CompanionApp } from './CompanionApp'

const MORGAN = { id: 1, username: 'morgan', email: 'm@example.test', role: 'user' } as User

const ROOM: CompanionState = {
  code: 'FRD4YC',
  joining: false,
  partyName: 'Friday crew',
  mediaTitle: 'Night Train to Meridian',
  mediaPoster: '/p3.jpg',
  mediaItemId: 107,
  hostUserId: 2,
  isPlaying: true,
  currentTimeMs: 2_467_000,
  participants: [
    { user_id: 2, username: 'priya', is_host: true, is_buffering: false, last_seen: '', ready: true },
    { user_id: 3, username: 'jonah', is_host: false, is_buffering: false, last_seen: '', ready: true },
    { user_id: 4, username: 'dana', is_host: false, is_buffering: false, last_seen: '', ready: true },
    { user_id: 1, username: 'morgan', is_host: false, is_buffering: false, last_seen: '', ready: true, companion: true },
  ],
  chat: [
    { id: 'c1', user_id: 2, username: 'priya', message: 'Pausing for one minute.', timestamp: '' },
    { id: 'c2', user_id: 1, username: 'morgan', message: 'On my phone.', timestamp: '' },
  ],
  recentReactions: [],
  connected: true,
  reconnecting: false,
  status: 'connected',
  synced: true,
  error: null,
} as CompanionState

const NO_VOICE: VoiceState = { enabled: false, muted: true, peers: [], selfSpeaking: false, status: '' }

function room(over: Partial<CompanionRoomProps> = {}) {
  const props: CompanionRoomProps = {
    state: ROOM,
    voice: NO_VOICE,
    currentUserId: 1,
    sendChat: vi.fn(),
    sendReaction: vi.fn(),
    joinVoice: vi.fn(() => Promise.resolve()),
    toggleMute: vi.fn(),
    leaveVoice: vi.fn(),
    onLeave: vi.fn(),
    ...over,
  }
  const view = render(<CompanionRoom {...props} />)
  return { props, ...view }
}

/** The companion's own alerts and statuses hold text only when there is
 *  something to say. */
const said = (role: 'alert' | 'status') => screen.getAllByRole(role).map(el => el.textContent ?? '').filter(Boolean)

beforeEach(() => {
  api.getCompanionPartyPreview.mockReset().mockResolvedValue(null)
  api.fetchMe.mockReset()
  api.getSetupStatus.mockReset().mockResolvedValue({ setup_complete: true, has_users: true, oauth_google_enabled: true })
  api.getStoredUser.mockReset().mockReturnValue(null)
  api.login.mockReset()
  ambient.ambientFor.mockReset().mockResolvedValue(null)
  // A browser that can use the microphone: jsdom has no media devices.
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } })
})
afterEach(() => { vi.useRealTimers() })

describe('the companion’s join screen', () => {
  it('has one field for the code, which keeps only the six letters and numbers of a code', async () => {
    const user = userEvent.setup()
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} />)
    const boxes = screen.getAllByRole('textbox')
    expect(boxes).toHaveLength(1)
    const code = screen.getByLabelText('Party code')
    expect(code).toBe(boxes[0])
    await user.type(code, 'frd-4yc99')
    expect(code).toHaveValue('FRD4YC')
    expect(screen.getByText('Joining as morgan')).toBeInTheDocument()
  })

  it('answers Enter on an incomplete code with what is missing, and joins nothing', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn(() => ({ ok: true }))
    render(<JoinScreen user={MORGAN} onJoin={onJoin} />)
    const code = screen.getByLabelText('Party code')
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled()
    await user.type(code, 'frd{Enter}')
    expect(said('alert')).toEqual(['Enter the full 6-character code.'])
    expect(code).toHaveAttribute('aria-invalid', 'true')
    expect(code.getAttribute('aria-describedby')!.split(' ')).toContain(screen.getByRole('alert').id)
    expect(onJoin).not.toHaveBeenCalled()
    // Typing again withdraws the refusal.
    await user.type(code, '4')
    expect(said('alert')).toEqual([])
    expect(code).toHaveAttribute('aria-invalid', 'false')
  })

  it('joins with the complete code, by the button and by Enter, and shows a refused join', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn<(code: string) => { ok: boolean; error?: string }>(() => ({ ok: true }))
    render(<JoinScreen user={MORGAN} onJoin={onJoin} />)
    const code = screen.getByLabelText('Party code')
    await user.type(code, 'frd4yc')
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(onJoin).toHaveBeenCalledTimes(1)
    expect(onJoin).toHaveBeenLastCalledWith('FRD4YC')
    // Enter is one join, not the key and the form's submit both.
    await user.type(code, '{Enter}')
    expect(onJoin).toHaveBeenCalledTimes(2)
    onJoin.mockReturnValueOnce({ ok: false, error: 'You are not signed in.' })
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(said('alert')).toEqual(['You are not signed in.'])
  })

  it('offers no Join to a phone that is not signed in: it shows the sign-in, and says so on Enter', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn(() => ({ ok: true }))
    render(<JoinScreen user={null} onJoin={onJoin} signInSlot={<p>the sign-in</p>} initialCode="FRD4YC" />)
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Sign in to join' })).toBeInTheDocument()
    expect(screen.getByText('the sign-in')).toBeInTheDocument()
    expect(screen.queryByText(/^Joining as/)).toBeNull()
    await user.type(screen.getByLabelText('Party code'), '{Enter}')
    expect(said('alert')).toEqual(['Sign in to join the party.'])
    expect(onJoin).not.toHaveBeenCalled()
  })

  it('shows what is on in the party a complete code names, and asks about no incomplete one', async () => {
    const user = userEvent.setup()
    api.getCompanionPartyPreview.mockResolvedValue({ code: 'FRD4YC', partyName: 'Friday crew', mediaTitle: 'Night Train to Meridian', participantCount: 3, startedAt: '2026-10-01T19:00:00Z', scheduledStartAt: null })
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} />)
    const code = screen.getByLabelText('Party code')
    await user.type(code, 'frd4y')
    await new Promise(r => setTimeout(r, 400))
    expect(api.getCompanionPartyPreview).not.toHaveBeenCalled()
    await user.type(code, 'c')
    expect(await screen.findByText('Friday crew is live')).toBeInTheDocument()
    // Everyone in the room, phones included: "here", not "watching".
    expect(screen.getByText('Night Train to Meridian · 3 here')).toBeInTheDocument()
    expect(api.getCompanionPartyPreview).toHaveBeenCalledTimes(1)
    expect(api.getCompanionPartyPreview.mock.calls[0][0]).toBe('FRD4YC')
    // The card goes with the code it was for.
    await user.type(code, '{Backspace}')
    expect(screen.queryByText('Friday crew is live')).toBeNull()
  })

  it('names a party that has no name by what it is', async () => {
    api.getCompanionPartyPreview.mockResolvedValue({ code: 'NONAME', mediaTitle: 'The Orchard', startedAt: '2026-10-01T19:00:00Z' })
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} initialCode="NONAME" />)
    expect(await screen.findByText('This party is live')).toBeInTheDocument()
    expect(screen.getByText('The Orchard')).toBeInTheDocument()
  })

  // A code is pasted more often than typed: with its dash, or as the link
  // the TV's QR code holds. The field has no length limit of its own, which
  // used to cut the paste before the dash was taken out.
  it('takes a code pasted with a separator or as a join link whole', async () => {
    const user = userEvent.setup()
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} />)
    const code = screen.getByLabelText('Party code')
    expect(code).not.toHaveAttribute('maxlength')
    await user.click(code)
    await user.paste('frd-4yc')
    expect(code).toHaveValue('FRD4YC')
    await user.clear(code)
    await user.paste('https://aurora.example.test/join/moon42')
    expect(code).toHaveValue('MOON42')
    await user.clear(code)
    await user.paste('https://aurora.example.test/p/Later7/')
    expect(code).toHaveValue('LATER7')
    // And never more than six, however much is pasted.
    await user.clear(code)
    await user.paste('abcdefghij')
    expect(code).toHaveValue('ABCDEF')
  })

  // The server holds a planned party before it starts, and answers for it
  // as it does for a live one.
  it('does not call a party live before it has started, and says when it starts', async () => {
    const at = new Date(Date.now() + 26 * 3600e3)
    at.setMinutes(0, 0, 0)
    api.getCompanionPartyPreview.mockResolvedValue({ code: 'LATER7', partyName: 'Sunday film', mediaTitle: 'The Orchard', participantCount: 0, startedAt: null, scheduledStartAt: at.toISOString() })
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} initialCode="LATER7" />)
    expect(await screen.findByText('Sunday film has not started')).toBeInTheDocument()
    expect(screen.queryByText(/is live/)).toBeNull()
    expect(screen.queryByText(/0 (here|watching)/)).toBeNull()
    expect(screen.getByText(/^The Orchard, starts (tomorrow|[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+) at \d/)).toBeInTheDocument()
  })

  // A planned party whose start failed stays unstarted on the server.
  it('does not go on saying "starts" once the planned time has passed', async () => {
    api.getCompanionPartyPreview.mockResolvedValue({ code: 'LATER7', partyName: 'Sunday film', mediaTitle: 'The Orchard', participantCount: 0, startedAt: null, scheduledStartAt: new Date(Date.now() - 3 * 24 * 3600e3).toISOString() })
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} initialCode="LATER7" />)
    expect(await screen.findByText('Sunday film has not started')).toBeInTheDocument()
    expect(screen.getByText(/^The Orchard, was planned for /)).toBeInTheDocument()
    expect(screen.queryByText(/starts/)).toBeNull()
  })

  it('words a planned time by the day it falls on, and "tonight" only from the late afternoon', () => {
    const now = new Date(2026, 9, 1, 15, 0)
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString()
    expect(plannedStartPhrase(at(1, 20), now)).toBe('starts tonight at 8:00 PM')
    expect(plannedStartPhrase(at(1, 16, 30), now)).toBe('starts today at 4:30 PM')
    expect(plannedStartPhrase(at(2, 8), now)).toBe('starts tomorrow at 8:00 AM')
    expect(plannedStartPhrase(at(9, 20), now)).toMatch(/^starts Fri, Oct 9 at 8:00 PM$/)
    // Passed, the party still not started.
    expect(plannedStartPhrase(at(1, 8), now)).toBe('was planned for today at 8:00 AM')
    expect(plannedStartPhrase(new Date(2026, 8, 30, 20).toISOString(), now)).toBe('was planned for yesterday at 8:00 PM')
    // A planned time of this evening that has passed is not "tonight" to come.
    expect(plannedStartPhrase(at(1, 18), new Date(2026, 9, 1, 21, 0))).toBe('was planned for today at 6:00 PM')
  })

  // A character typed into the middle of a complete code would push its
  // last one out and send the caret to the end.
  it('takes no more typing into a complete code, and leaves the caret where it was', async () => {
    const user = userEvent.setup()
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} initialCode="FRD4YC" />)
    const code = screen.getByLabelText('Party code') as HTMLInputElement
    await user.click(code)
    code.setSelectionRange(3, 3)
    await user.keyboard('X')
    expect(code).toHaveValue('FRD4YC')
    expect(code.selectionStart).toBe(3)
    // Typing over a selection replaces it, as anywhere.
    code.setSelectionRange(0, 3)
    await user.keyboard('M')
    expect(code).toHaveValue('M4YC')
  })

  it('says only that a party has not started when it has no planned time', async () => {
    api.getCompanionPartyPreview.mockResolvedValue({ code: 'LATER7', mediaTitle: 'The Orchard', participantCount: 1, startedAt: null, scheduledStartAt: null })
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} initialCode="LATER7" />)
    expect(await screen.findByText('This party has not started')).toBeInTheDocument()
    expect(screen.getByText('The Orchard')).toBeInTheDocument()
  })

  // The danger border is the field's way of saying its code is wrong. A
  // complete code with nobody signed in, or a join the app refused, is not
  // that.
  it('marks the field only for a problem with the code itself', async () => {
    const user = userEvent.setup()
    const onJoin = vi.fn<(code: string) => { ok: boolean; error?: string }>(() => ({ ok: false, error: 'You are not signed in.' }))
    const { rerender } = render(<JoinScreen user={null} onJoin={onJoin} initialCode="FRD4YC" />)
    const code = screen.getByLabelText('Party code')
    await user.type(code, '{Enter}')
    expect(said('alert')).toEqual(['Sign in to join the party.'])
    expect(code).toHaveAttribute('aria-invalid', 'false')
    rerender(<JoinScreen user={MORGAN} onJoin={onJoin} initialCode="FRD4YC" />)
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(said('alert')).toEqual(['You are not signed in.'])
    expect(code).toHaveAttribute('aria-invalid', 'false')
  })

  it('shows why the phone was sent back here', () => {
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} externalError="The host ended the party." />)
    expect(said('alert')).toEqual(['The host ended the party.'])
    // That is not about the code in the field.
    expect(screen.getByLabelText('Party code')).toHaveAttribute('aria-invalid', 'false')
  })
})

describe('the companion’s room', () => {
  it('says which party, its code and how many are here, and nothing about a connection that is up', () => {
    room()
    expect(screen.getByRole('heading', { level: 1, name: 'Friday crew' })).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Code FRD4YC · 4 here')).toBeInTheDocument()
    expect(said('status')).toEqual([])
  })

  it('says in words when the connection is not up', () => {
    const { rerender, props } = room({ state: { ...ROOM, reconnecting: true, status: 'reconnecting' } })
    expect(said('status')).toEqual(['Reconnecting…'])
    rerender(<CompanionRoom {...props} state={{ ...ROOM, connected: false, status: 'joining' }} />)
    expect(said('status')).toEqual(['Connecting…'])
    rerender(<CompanionRoom {...props} state={{ ...ROOM, connected: false, status: 'connected' }} />)
    expect(said('status')).toEqual(['Offline'])
  })

  it('falls back to the title, then to plain words, for a party with no name', () => {
    const { rerender, props } = room({ state: { ...ROOM, partyName: undefined } })
    expect(screen.getByRole('heading', { level: 1, name: 'Night Train to Meridian' })).toBeInTheDocument()
    rerender(<CompanionRoom {...props} state={{ ...ROOM, partyName: undefined, mediaTitle: undefined, mediaPoster: undefined }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Watch party' })).toBeInTheDocument()
    // With no title and no poster there is nothing to say is playing.
    expect(screen.queryByRole('region', { name: 'Now playing' })).toBeNull()
  })

  it('says where the film was at the last update, not that it is there now', () => {
    const { rerender, props } = room()
    const playing = screen.getByRole('region', { name: 'Now playing' })
    expect(within(playing).getByText('Night Train to Meridian')).toBeInTheDocument()
    expect(within(playing).getByText('41:07 · playing at the last update')).toBeInTheDocument()
    rerender(<CompanionRoom {...props} state={{ ...ROOM, isPlaying: false, currentTimeMs: 8_460_000 }} />)
    expect(within(screen.getByRole('region', { name: 'Now playing' })).getByText('2:21:00 · paused at the last update')).toBeInTheDocument()
  })

  // The colour comes from the poster drawn in the now-playing card, and is
  // that poster's only: the sample answers later, and by then the party may
  // be on another title.
  it('washes the screen with the colour of the poster on screen, and with no other poster\'s', async () => {
    const answers: ((color: string | null) => void)[] = []
    ambient.ambientFor.mockImplementation(() => new Promise(resolve => { answers.push(resolve) }))
    const { rerender, props, container } = room()
    const screenRoot = container.firstElementChild as HTMLElement
    const art = () => screenRoot.querySelector('section[aria-label="Now playing"] img') as HTMLImageElement
    expect(screenRoot.querySelector('.companion-wash')).not.toBeNull()
    expect(screenRoot.style.getPropertyValue('--ambient')).toBe('transparent')
    fireEvent.load(art())
    expect(ambient.ambientFor).toHaveBeenCalledWith(art())
    await act(async () => { answers.forEach(a => a('rgba(29, 65, 72, 0.6)')) })
    expect(screenRoot.style.getPropertyValue('--ambient')).toBe('rgba(29, 65, 72, 0.6)')

    // The party moves to another title. Its poster has not answered yet,
    // and the first title's colour is not kept for it.
    const before = answers.length
    rerender(<CompanionRoom {...props} state={{ ...ROOM, mediaPoster: '/p9.jpg' }} />)
    expect(screenRoot.style.getPropertyValue('--ambient')).toBe('transparent')
    fireEvent.load(art())
    await act(async () => { answers.slice(before).forEach(a => a('rgba(72, 40, 29, 0.6)')) })
    expect(screenRoot.style.getPropertyValue('--ambient')).toBe('rgba(72, 40, 29, 0.6)')

    // A poster with no colour worth showing leaves the screen plain.
    const again = answers.length
    rerender(<CompanionRoom {...props} state={{ ...ROOM, mediaPoster: '/grey.jpg' }} />)
    fireEvent.load(art())
    await act(async () => { answers.slice(again).forEach(a => a(null)) })
    expect(screenRoot.style.getPropertyValue('--ambient')).toBe('transparent')
  })

  it('lists who is here, the viewer as "You", with what is known of how each is here', () => {
    room({
      voice: { enabled: true, muted: true, selfSpeaking: false, status: '', peers: [
        { userId: 2, username: 'priya', speaking: true, connecting: false },
        { userId: 3, username: 'jonah', speaking: false, connecting: false },
      ] },
    })
    const people = within(screen.getByRole('list', { name: 'Participants' })).getAllByRole('listitem')
    expect(people.map(li => li.textContent)).toEqual([
      'PpriyaHost, talking',
      'JjonahIn voice',
      'DdanaHere',
      'MYouIn voice, on phone',
    ])
    // The ring is on the one who is speaking, and on nobody else.
    expect(people.map(li => li.querySelector('[data-speaking]') !== null)).toEqual([true, false, false, false])
  })

  it('says only that someone is here, or the host, when it knows nothing more of them', () => {
    room()
    const people = within(screen.getByRole('list', { name: 'Participants' })).getAllByRole('listitem')
    expect(people.map(li => li.textContent)).toEqual(['PpriyaHost', 'JjonahHere', 'DdanaHere', 'MYouOn phone'])
  })

  it('shows the chat a line a message, the viewer’s own as "You"', () => {
    const { rerender, props } = room()
    const chat = screen.getByRole('log', { name: 'Chat' })
    expect([...chat.querySelectorAll('p')].map(p => p.textContent)).toEqual(['priya Pausing for one minute.', 'You On my phone.'])
    rerender(<CompanionRoom {...props} state={{ ...ROOM, chat: [] }} />)
    expect(within(screen.getByRole('log', { name: 'Chat' })).getByText(/^Nothing said yet\./)).toBeInTheDocument()
  })

  it('sends the reaction that was pressed', async () => {
    const user = userEvent.setup()
    const { props } = room()
    const reactions = within(screen.getByRole('group', { name: 'Quick reactions' })).getAllByRole('button')
    // The app's nine (lib/reactions, held against the server's list there),
    // each sent as it is listed.
    expect(reactions).toHaveLength(9)
    for (const [i, button] of reactions.entries()) {
      await user.click(button)
      expect(props.sendReaction).toHaveBeenLastCalledWith(QUICK_REACTIONS[i])
    }
    expect(props.sendReaction).toHaveBeenCalledTimes(9)
    // The heart is sent bare, which is what the server lists, and drawn as
    // the emoji.
    const heart = screen.getByRole('button', { name: 'React with \u2764\uFE0F' })
    expect(heart.textContent).toBe('\u2764\uFE0F')
    await user.click(heart)
    expect(props.sendReaction).toHaveBeenLastCalledWith('\u2764')
  })

  it('sends a typed message once, trimmed, and leaves the field empty and in focus', async () => {
    const user = userEvent.setup()
    const { props } = room()
    const field = screen.getByLabelText('Message the party')
    const send = screen.getByRole('button', { name: 'Send message' })
    // Nothing to send: the button is off, and neither it nor Enter sends.
    expect(send).toHaveAttribute('aria-disabled', 'true')
    await user.click(send)
    await user.type(field, '   {Enter}')
    expect(props.sendChat).not.toHaveBeenCalled()
    await user.clear(field)
    await user.type(field, '  back in two minutes ')
    expect(send).toHaveAttribute('aria-disabled', 'false')
    await user.type(field, '{Enter}')
    expect(props.sendChat).toHaveBeenCalledTimes(1)
    expect(props.sendChat).toHaveBeenLastCalledWith('back in two minutes')
    expect(field).toHaveValue('')
    await user.type(field, 'again')
    await user.click(send)
    expect(props.sendChat).toHaveBeenCalledTimes(2)
    expect(props.sendChat).toHaveBeenLastCalledWith('again')
    expect(field).toHaveFocus()
  })

  it('asks for voice once however fast it is pressed, and keeps the focus while it starts', async () => {
    let done!: () => void
    const joinVoice = vi.fn(() => new Promise<void>(r => { done = r }))
    room({ joinVoice })
    const voice = screen.getByRole('button', { name: 'Join voice' })
    voice.focus()
    act(() => { voice.click(); voice.click() })
    expect(joinVoice).toHaveBeenCalledTimes(1)
    const starting = screen.getByRole('button', { name: 'Starting…' })
    expect(starting).toBe(voice)
    expect(starting).toHaveAttribute('aria-disabled', 'true')
    expect(starting).not.toBeDisabled()
    expect(starting).toHaveFocus()
    fireEvent.click(starting)
    expect(joinVoice).toHaveBeenCalledTimes(1)
    await act(async () => { done() })
    expect(screen.getByRole('button', { name: 'Join voice' })).toHaveAttribute('aria-disabled', 'false')
    // Not in voice: there is no voice to leave.
    expect(screen.queryByRole('button', { name: 'Leave voice' })).toBeNull()
  })

  it('says why voice did not start, in the screen’s one alert', async () => {
    const user = userEvent.setup()
    const joinVoice = vi.fn(() => Promise.reject(Object.assign(new Error('x'), { reason: 'denied' })))
    const { rerender, props } = room({ joinVoice })
    await user.click(screen.getByRole('button', { name: 'Join voice' }))
    expect(said('alert')).toEqual(['The microphone is blocked. Allow it for this site in your browser’s settings.'])
    const voice = screen.getByRole('button', { name: 'Join voice' })
    expect(document.getElementById(voice.getAttribute('aria-describedby')!)?.textContent).toMatch(/^The microphone is blocked/)
    // What the server refused is said in the same place, beside it.
    rerender(<CompanionRoom {...props} state={{ ...ROOM, error: 'You are sending messages too fast.' }} />)
    expect(said('alert')).toEqual(['You are sending messages too fast. The microphone is blocked. Allow it for this site in your browser’s settings.'])
    // An error that came with the connection gone is the join screen’s.
    rerender(<CompanionRoom {...props} state={{ ...ROOM, connected: false, error: 'Connection lost.' }} />)
    expect(said('alert')).toEqual(['The microphone is blocked. Allow it for this site in your browser’s settings.'])
  })

  it('makes the same button the mute switch once in voice, and offers a way out of voice', async () => {
    const user = userEvent.setup()
    const { rerender, props } = room({ voice: { ...NO_VOICE, enabled: true, muted: true } })
    expect(screen.queryByRole('button', { name: 'Join voice' })).toBeNull()
    expect(screen.getByText('You are in voice, muted.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Unmute' }))
    expect(props.toggleMute).toHaveBeenCalledTimes(1)
    expect(props.joinVoice).not.toHaveBeenCalled()
    rerender(<CompanionRoom {...props} voice={{ ...NO_VOICE, enabled: true, muted: false }} />)
    expect(screen.getByText('Your microphone is on.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mute' }))
    expect(props.toggleMute).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: 'Leave voice' }))
    expect(props.leaveVoice).toHaveBeenCalledTimes(1)
  })

  // Who else is in voice is known only to a phone that is in voice itself.
  it('says nothing of other people\'s voice while this phone is out of it', () => {
    room({
      voice: { ...NO_VOICE, enabled: false, peers: [{ userId: 3, username: 'jonah', speaking: false, connecting: false }] },
    })
    const people = within(screen.getByRole('list', { name: 'Participants' })).getAllByRole('listitem')
    expect(people.map(li => li.textContent)).toEqual(['PpriyaHost', 'JjonahHere', 'DdanaHere', 'MYouOn phone'])
  })

  it('puts the focus on the room\'s heading on the way in', () => {
    room()
    expect(screen.getByRole('heading', { level: 1, name: 'Friday crew' })).toHaveFocus()
  })

  // The words stay when there is nowhere to send them.
  it('keeps a message that could not be sent, and says why Send is off while the connection is down', async () => {
    const user = userEvent.setup()
    const { rerender, props } = room({ state: { ...ROOM, reconnecting: true, status: 'reconnecting' } })
    const field = screen.getByLabelText('Message the party')
    const send = screen.getByRole('button', { name: 'Send message' })
    await user.type(field, 'back in two minutes')
    expect(send).toHaveAttribute('aria-disabled', 'true')
    const why = 'Not connected. What you type is kept here until the connection is back.'
    expect(send).toHaveAccessibleDescription(why)
    expect(field).toHaveAccessibleDescription(why)
    await user.type(field, '{Enter}')
    await user.click(send)
    expect(props.sendChat).not.toHaveBeenCalled()
    expect(field).toHaveValue('back in two minutes')

    // Back: the note goes, and the same words are sent.
    rerender(<CompanionRoom {...props} state={ROOM} />)
    expect(screen.queryByText(why)).toBeNull()
    expect(send).toHaveAttribute('aria-disabled', 'false')
    expect(field).not.toHaveAttribute('aria-describedby')
    await user.click(send)
    expect(props.sendChat).toHaveBeenCalledWith('back in two minutes')
    expect(field).toHaveValue('')
  })

  // The socket can be gone a moment before the screen has heard of it.
  it('keeps the words when the connection says it did not send them', async () => {
    const user = userEvent.setup()
    const sendChat = vi.fn(() => false)
    room({ sendChat })
    const field = screen.getByLabelText('Message the party')
    await user.type(field, 'still here{Enter}')
    expect(sendChat).toHaveBeenCalledWith('still here')
    expect(field).toHaveValue('still here')
  })

  // The history that arrives with the connection is not news, and a live
  // region would read all of it out.
  //
  // The states are the ones the connection really goes through, in its
  // order (useCompanion.test.tsx pins that order): joining; connected as
  // the socket opens, with nothing arrived; then the room's state, history
  // and all, in one message.
  it('does not announce the chat it arrives to, only what is said after', async () => {
    const frames = () => new Promise(done => setTimeout(done, 80))
    const empty = { ...ROOM, chat: [], participants: [], partyName: undefined, mediaTitle: undefined, mediaPoster: undefined, synced: false }
    const { rerender, props } = room({ state: { ...empty, connected: false, status: 'joining' } })
    const log = screen.getByRole('log', { name: 'Chat' })
    expect(log).toHaveAttribute('aria-live', 'off')
    // The socket is open. Nothing has been sent to it yet, and it stays off
    // however long that takes.
    rerender(<CompanionRoom {...props} state={{ ...empty, connected: true, status: 'connected' }} />)
    await frames()
    expect(log).toHaveAttribute('aria-live', 'off')
    // The state arrives, with the history: still off in the commit that
    // draws it, and on a frame later.
    rerender(<CompanionRoom {...props} state={ROOM} />)
    expect(log).toHaveAttribute('aria-live', 'off')
    await waitFor(() => expect(log).toHaveAttribute('aria-live', 'polite'))
    // A drop: off, and off still when the socket has reopened and the
    // history has yet to come again.
    rerender(<CompanionRoom {...props} state={{ ...ROOM, connected: false, reconnecting: true, status: 'reconnecting', synced: false }} />)
    expect(log).toHaveAttribute('aria-live', 'off')
    rerender(<CompanionRoom {...props} state={{ ...ROOM, synced: false }} />)
    await frames()
    expect(log).toHaveAttribute('aria-live', 'off')
    rerender(<CompanionRoom {...props} state={ROOM} />)
    await waitFor(() => expect(log).toHaveAttribute('aria-live', 'polite'))
  })

  // A history that comes back shorter than the chat's box fires no scroll
  // event: a reader who had scrolled back in a longer one must not be left
  // unfollowed for good.
  it('counts a reader as at the end again when everything left is within reach', () => {
    const msg = (id: string) => ({ id, user_id: 2, username: 'priya', message: 'more', timestamp: '' })
    const { rerender, props } = room()
    const log = screen.getByRole('log', { name: 'Chat' })
    let height = 2000
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 300 })
    log.scrollTop = 0
    fireEvent.scroll(log)
    // The history is replaced by a short one; no scroll event comes.
    height = 320
    rerender(<CompanionRoom {...props} state={{ ...ROOM, chat: [msg('n1')] }} />)
    height = 420
    rerender(<CompanionRoom {...props} state={{ ...ROOM, chat: [msg('n1'), msg('n2')] }} />)
    expect(log.scrollTop).toBe(420)
  })

  it('says when the connection is back, and that the message is still there', async () => {
    const user = userEvent.setup()
    const down = { ...ROOM, connected: false, reconnecting: true, status: 'reconnecting' as const, synced: false }
    const { rerender, props } = room()
    // The first connection is not a return.
    expect(said('status')).toEqual([])
    rerender(<CompanionRoom {...props} state={down} />)
    await user.type(screen.getByLabelText('Message the party'), 'still here')
    rerender(<CompanionRoom {...props} state={ROOM} />)
    expect(said('status')).toEqual(['Connected again. Your message is still in the field.'])
    rerender(<CompanionRoom {...props} state={down} />)
    await user.clear(screen.getByLabelText('Message the party'))
    rerender(<CompanionRoom {...props} state={ROOM} />)
    expect(said('status')).toEqual(['Connected again.'])
  })

  it('follows a new message when the reader was at the end, and not when they had scrolled back', () => {
    const msg = (id: string, message = 'more') => ({ id, user_id: 2, username: 'priya', message, timestamp: '' })
    const { rerender, props } = room()
    const log = screen.getByRole('log', { name: 'Chat' })
    let height = 1000
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 300 })
    // At the end: a new line is followed, however tall it is.
    log.scrollTop = 700
    fireEvent.scroll(log)
    height = 1400
    rerender(<CompanionRoom {...props} state={{ ...ROOM, chat: [...ROOM.chat, msg('c3', 'a very tall message')] }} />)
    expect(log.scrollTop).toBe(1400)
    // Scrolled back to read: left where they are.
    log.scrollTop = 200
    fireEvent.scroll(log)
    height = 1500
    rerender(<CompanionRoom {...props} state={{ ...ROOM, chat: [...ROOM.chat, msg('c3'), msg('c4')] }} />)
    expect(log.scrollTop).toBe(200)
    // The list is capped: a new message can arrive with the count unchanged.
    log.scrollTop = 1200
    fireEvent.scroll(log)
    height = 1600
    rerender(<CompanionRoom {...props} state={{ ...ROOM, chat: [ROOM.chat[1], msg('c3'), msg('c4'), msg('c5')].slice(-4) }} />)
    rerender(<CompanionRoom {...props} state={{ ...ROOM, chat: [msg('c3'), msg('c4'), msg('c5'), msg('c6')] }} />)
    expect(log.scrollTop).toBe(1600)
  })

  // A note appears above the message field, or the voice row opens, and the
  // chat's box gets shorter under someone who was at its end.
  it('stays at the end when the chat\'s own box changes height, unless the reader had scrolled back', () => {
    let resized: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resized = cb } observe() {} disconnect() {} })
    try {
      room()
      const log = screen.getByRole('log', { name: 'Chat' })
      Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 900 })
      Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 300 })
      log.scrollTop = 600
      fireEvent.scroll(log)
      log.scrollTop = 560
      act(() => resized())
      expect(log.scrollTop).toBe(900)
      log.scrollTop = 100
      fireEvent.scroll(log)
      act(() => resized())
      expect(log.scrollTop).toBe(100)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a name or a message in another script from reordering what is beside it', () => {
    room({ state: { ...ROOM, chat: [{ id: 'r1', user_id: 2, username: 'נועה', message: 'שלום!', timestamp: '' }] } })
    const line = screen.getByRole('log', { name: 'Chat' }).querySelector('p')!
    expect([...line.querySelectorAll('bdi')].map(b => b.textContent)).toEqual(['נועה', 'שלום!'])
    const people = within(screen.getByRole('list', { name: 'Participants' })).getAllByRole('listitem')
    expect(people[0].querySelector('bdi')?.textContent).toBe('priya')
  })

  it('tells a browser with no microphone API that voice is not available, and asks for nothing', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    const { props } = room()
    await user.click(screen.getByRole('button', { name: 'Join voice' }))
    expect(said('alert')).toEqual(['Voice is not available in this browser.'])
    expect(props.joinVoice).not.toHaveBeenCalled()
  })

  // Voice goes with the room's connection, and the button goes back to
  // "Join voice" by itself.
  it('says when voice ended by itself, and nothing when the person left it', async () => {
    const user = userEvent.setup()
    const inVoice = { ...NO_VOICE, enabled: true, muted: false }
    const { rerender, props } = room({ voice: inVoice })
    await user.click(screen.getByRole('button', { name: 'Leave voice' }))
    rerender(<CompanionRoom {...props} voice={NO_VOICE} />)
    expect(said('alert')).toEqual([])
    rerender(<CompanionRoom {...props} voice={inVoice} />)
    rerender(<CompanionRoom {...props} voice={NO_VOICE} />)
    expect(said('alert')).toEqual(['Voice ended when the connection dropped. Join voice again once you are reconnected.'])
  })

  it('reads out only the refusal that changed', () => {
    room()
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveAttribute('aria-atomic', 'false')
  })

  it('leaves the party from the header', async () => {
    const user = userEvent.setup()
    const { props } = room()
    await user.click(screen.getByRole('button', { name: 'Leave the party' }))
    expect(props.onLeave).toHaveBeenCalledTimes(1)
  })
})

describe('the companion’s sign-in', () => {
  const idle = (): UseCompanion => ({
    state: { ...ROOM, code: null, status: 'idle', connected: false, participants: [], chat: [] },
    voice: NO_VOICE,
    join: vi.fn(() => ({ ok: true })),
    leave: vi.fn(),
    sendChat: vi.fn(),
    sendReaction: vi.fn(),
    joinVoice: vi.fn(() => Promise.resolve()),
    toggleMute: vi.fn(),
    leaveVoice: vi.fn(),
  })
  const mount = (at = '/join/FRD4YC') => render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="join" element={<CompanionApp />} />
        <Route path="join/:code" element={<CompanionApp />} />
      </Routes>
    </MemoryRouter>,
  )

  beforeEach(() => {
    companion.current = idle()
    api.fetchMe.mockRejectedValue(new Error('no session'))
  })

  it('offers each provider the server has on, and the username form behind one press', async () => {
    const user = userEvent.setup()
    mount()
    expect(await screen.findByRole('heading', { name: 'Sign in to join' })).toBeInTheDocument()
    const google = await screen.findByRole('link', { name: 'Continue with Google' })
    expect(google.getAttribute('href')).toContain('/api/auth/oauth/google/start')
    expect(google.getAttribute('href')).toContain('FRD4YC')
    expect(screen.queryByRole('link', { name: 'Continue with Discord' })).toBeNull()
    expect(screen.queryByLabelText('Username')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Sign in with username' }))
    // The button that was pressed is gone; the first field has the focus.
    expect(screen.getByLabelText('Username')).toHaveFocus()
    expect((companion.current as UseCompanion).join).not.toHaveBeenCalled()
  })

  it('sends one sign-in however fast it is pressed, keeps the fields and the focus while it is out, and shows a refusal', async () => {
    const user = userEvent.setup()
    let refuse!: (e: Error) => void
    api.login.mockImplementation(() => new Promise((_, rej) => { refuse = rej }))
    mount()
    await user.click(await screen.findByRole('button', { name: 'Sign in with username' }))
    const submit = screen.getByRole('button', { name: 'Sign in' })
    // Nothing typed: it says what is missing and sends nothing.
    await user.click(submit)
    expect(said('alert')).toEqual(['Enter your username and password.'])
    expect(api.login).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Username'), 'morgan')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    expect(said('alert')).toEqual([])
    submit.focus()
    act(() => { submit.click(); submit.click() })
    expect(api.login).toHaveBeenCalledTimes(1)
    expect(api.login).toHaveBeenCalledWith('morgan', 'wrong')
    const out = screen.getByRole('button', { name: 'Signing in…' })
    expect(out).toBe(submit)
    expect(out).toHaveAttribute('aria-disabled', 'true')
    expect(out).not.toBeDisabled()
    expect(out).toHaveFocus()
    expect(screen.getByLabelText('Username')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('Password')).toHaveAttribute('readonly')
    fireEvent.click(out)
    expect(api.login).toHaveBeenCalledTimes(1)
    // What the server really sends for a wrong password, which is not what
    // is shown.
    await act(async () => { refuse(new APIError(401, 'invalid credentials', { error: { code: 401, message: 'invalid credentials' } })) })
    expect(said('alert')).toEqual(['That username and password do not match an account.'])
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveFocus()
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('readonly')
  })

  it('words each kind of sign-in refusal itself, never in the server\'s or the browser\'s words', async () => {
    const user = userEvent.setup()
    api.login
      .mockRejectedValueOnce(new APIError(429, 'rate limit exceeded, try again later', { error: { code: 429, message: 'rate limit exceeded, try again later' } }, 180))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new APIError(502, 'Bad Gateway', '<html>Bad Gateway</html>'))
    mount()
    await user.click(await screen.findByRole('button', { name: 'Sign in with username' }))
    expect(screen.getByLabelText('Username')).toHaveAttribute('name', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute('name', 'password')
    await user.type(screen.getByLabelText('Username'), 'morgan')
    await user.type(screen.getByLabelText('Password'), 'pw')
    const submit = screen.getByRole('button', { name: 'Sign in' })
    await user.click(submit)
    await waitFor(() => expect(said('alert')).toEqual(['Too many tries. Try again in about 3 minutes.']))
    await user.click(submit)
    await waitFor(() => expect(said('alert')).toEqual(['The server could not be reached. Check the connection and try again.']))
    await user.click(submit)
    await waitFor(() => expect(said('alert')).toEqual(['The server could not sign you in just now. Try again.']))
  })

  it('joins the party in the address once signed in', async () => {
    const user = userEvent.setup()
    api.login.mockResolvedValue(MORGAN)
    mount()
    await user.click(await screen.findByRole('button', { name: 'Sign in with username' }))
    await user.type(screen.getByLabelText('Username'), 'morgan')
    await user.type(screen.getByLabelText('Password'), 'right{Enter}')
    await waitFor(() => expect((companion.current as UseCompanion).join).toHaveBeenCalledWith('FRD4YC'))
    expect((companion.current as UseCompanion).join).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Joining as morgan')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in to join' })).toBeNull()
  })

  // After the last reconnect attempt fails, the room is replaced by the
  // join screen. "What you type is kept" has to hold through that.
  it('keeps what was typed in a party through a connection that was given up on, and drops it when the person leaves', async () => {
    const user = userEvent.setup()
    api.fetchMe.mockResolvedValue(MORGAN)
    api.getStoredUser.mockReturnValue(MORGAN)
    const inRoom = (): UseCompanion => ({ ...idle(), state: ROOM })
    // A new element each time, or React has nothing to re-render for.
    const tree = () => (
      <MemoryRouter initialEntries={['/join/FRD4YC']}>
        <Routes>
          <Route path="join" element={<CompanionApp />} />
          <Route path="join/:code" element={<CompanionApp />} />
        </Routes>
      </MemoryRouter>
    )
    companion.current = inRoom()
    const view = render(tree())
    await user.type(await screen.findByLabelText('Message the party'), 'are you still there?')
    // The connection is given up on: the join screen, with why.
    companion.current = { ...idle(), state: { ...ROOM, code: 'FRD4YC', connected: false, synced: false, status: 'error', error: 'Lost connection to the party. Refresh to retry.' } }
    view.rerender(tree())
    expect(await screen.findByLabelText('Party code')).toBeInTheDocument()
    expect(screen.queryByLabelText('Message the party')).toBeNull()
    // Back in the same party: the words are there.
    companion.current = inRoom()
    view.rerender(tree())
    expect(await screen.findByLabelText('Message the party')).toHaveValue('are you still there?')
    // Another party's field is its own.
    companion.current = { ...idle(), state: { ...ROOM, code: 'MOON42' } }
    view.rerender(tree())
    expect(screen.getByLabelText('Message the party')).toHaveValue('')
    // Leaving a party is the end of what was being said in it.
    companion.current = inRoom()
    view.rerender(tree())
    expect(screen.getByLabelText('Message the party')).toHaveValue('are you still there?')
    await user.click(screen.getByRole('button', { name: 'Leave the party' }))
    view.rerender(tree())
    expect(screen.getByLabelText('Message the party')).toHaveValue('')
  })

  it('says it is loading while the session is checked, with nothing to press', () => {
    api.fetchMe.mockReturnValue(new Promise(() => {}))
    mount('/join')
    expect(said('status')).toEqual(['Loading…'])
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
