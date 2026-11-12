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
import type { User } from '@/lib/api'
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

const companion = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/hooks/useCompanion', () => ({ useCompanion: () => companion.current }))

import { JoinScreen } from './JoinScreen'
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
    api.getCompanionPartyPreview.mockResolvedValue({ code: 'FRD4YC', partyName: 'Friday crew', mediaTitle: 'Night Train to Meridian', participantCount: 3 })
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} />)
    const code = screen.getByLabelText('Party code')
    await user.type(code, 'frd4y')
    await new Promise(r => setTimeout(r, 400))
    expect(api.getCompanionPartyPreview).not.toHaveBeenCalled()
    await user.type(code, 'c')
    expect(await screen.findByText('Friday crew is live')).toBeInTheDocument()
    expect(screen.getByText('Night Train to Meridian · 3 watching')).toBeInTheDocument()
    expect(api.getCompanionPartyPreview).toHaveBeenCalledTimes(1)
    expect(api.getCompanionPartyPreview.mock.calls[0][0]).toBe('FRD4YC')
    // The card goes with the code it was for.
    await user.type(code, '{Backspace}')
    expect(screen.queryByText('Friday crew is live')).toBeNull()
  })

  it('names a party that has no name by what it is', async () => {
    api.getCompanionPartyPreview.mockResolvedValue({ code: 'NONAME', mediaTitle: 'The Orchard' })
    render(<JoinScreen user={MORGAN} onJoin={() => ({ ok: true })} initialCode="NONAME" />)
    expect(await screen.findByText('This party is live')).toBeInTheDocument()
    expect(screen.getByText('The Orchard')).toBeInTheDocument()
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
      'DdanaWatching',
      'MYouIn voice, on phone',
    ])
    // The ring is on the one who is speaking, and on nobody else.
    expect(people.map(li => li.querySelector('[data-speaking]') !== null)).toEqual([true, false, false, false])
  })

  it('does not call someone it knows nothing more about anything but watching, or host', () => {
    room()
    const people = within(screen.getByRole('list', { name: 'Participants' })).getAllByRole('listitem')
    expect(people.map(li => li.textContent)).toEqual(['PpriyaHost', 'JjonahWatching', 'DdanaWatching', 'MYouOn phone'])
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
    expect(reactions.map(b => b.getAttribute('aria-label'))).toEqual(
      ['😂', '😱', '🔥', '❤️', '👏', '🤯', '😭', '💀', '🎉'].map(e => `React with ${e}`),
    )
    await user.click(screen.getByRole('button', { name: 'React with 🔥' }))
    expect(props.sendReaction).toHaveBeenCalledTimes(1)
    expect(props.sendReaction).toHaveBeenCalledWith('🔥')
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
    await act(async () => { refuse(new Error('Invalid username or password.')) })
    expect(said('alert')).toEqual(['Invalid username or password.'])
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveFocus()
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('readonly')
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

  it('says it is loading while the session is checked, with nothing to press', () => {
    api.fetchMe.mockReturnValue(new Promise(() => {}))
    mount('/join')
    expect(said('status')).toEqual(['Loading…'])
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
