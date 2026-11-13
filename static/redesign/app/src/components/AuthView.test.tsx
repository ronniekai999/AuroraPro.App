// @vitest-environment jsdom
//
// The signed-out pages: sign in, and create an account. What they draw is
// what the server's setup-status says and no more: no server name, no
// verdict on an invite code, nothing of the library.

import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'

const api = vi.hoisted(() => ({
  getSetupStatus: vi.fn<() => Promise<Record<string, unknown>>>(),
  login: vi.fn<(u: string, p: string) => Promise<unknown>>(),
  register: vi.fn<(body: Record<string, unknown>) => Promise<unknown>>(),
}))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  ...api,
}))

import AuthView, { refusalSays } from './AuthView'
import { APIError } from '@/lib/api'
import { consumeDeviceIntent, consumeDevicePairing } from '@/lib/devicePairing'
import { resetRestoreRecordForTest } from '@/hooks/useRestoreRecord'

/** A refusal as the server sends one: a status and its sentence. */
const refused = (status: number, sentence: string) => new APIError(status, sentence, { error: { code: status, message: sentence } })

const USER = { id: 1, username: 'morgan', email: 'm@example.test', role: 'user' }
const status = (over: Record<string, unknown> = {}) => ({
  setup_complete: true, has_users: true,
  oauth_google_enabled: false, oauth_discord_enabled: false, oauth_twitch_enabled: false, oauth_facebook_enabled: false, oauth_twitter_enabled: false,
  ...over,
})
const where = { path: '' }
function Where() {
  const { pathname } = useLocation()
  useEffect(() => { where.path = pathname }, [pathname])
  return null
}
const onLogin = vi.fn()
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
async function open(at = '/', setup: Record<string, unknown> | Error = status()) {
  if (setup instanceof Error) api.getSetupStatus.mockRejectedValue(setup)
  else api.getSetupStatus.mockResolvedValue(setup)
  render(<MemoryRouter initialEntries={[at]}><Where /><AuthView onLogin={onLogin} /></MemoryRouter>)
  await flush()
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const toRegister = () => fireEvent.click(screen.getByRole('button', { name: 'Create an account' }))

beforeEach(() => {
  api.login.mockResolvedValue(USER)
  api.register.mockResolvedValue({ user: USER })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState({}, '', '/') })

describe('the sign-in page', () => {
  it('is headed for someone coming back, with a username and a password to give', async () => {
    await open()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome back')
    expect(document.querySelector('[data-auth]')!.getAttribute('data-auth')).toBe('signin')
    type('Username', 'morgan')
    type('Password', 'correct horse')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await flush()
    expect(api.login).toHaveBeenCalledWith('morgan', 'correct horse')
    expect(onLogin).toHaveBeenCalledWith(USER)
  })

  // The artboard has "Morgan's media server" and a wall of the library's
  // posters. The server tells a signed-out visitor neither, and must not.
  it('names no server and shows nothing of the library', async () => {
    // Anything the pages asked the server for besides how it is set up
    // would go through fetch (the module's other calls are the real ones).
    const asked = vi.fn(async () => new Response('[]'))
    vi.stubGlobal('fetch', asked)
    await open()
    expect(screen.getByText('Sign in to your media server.')).toBeInTheDocument()
    expect(document.querySelectorAll('img, picture, video, [style*="url("]')).toHaveLength(0)
    expect(api.getSetupStatus).toHaveBeenCalledTimes(1)
    expect(asked).not.toHaveBeenCalled()
    // Nor does the page that makes an account.
    toRegister()
    await flush()
    expect(document.querySelectorAll('img, picture, video, [style*="url("]')).toHaveLength(0)
    expect(api.getSetupStatus).toHaveBeenCalledTimes(1)
    expect(asked).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    // The wall is twelve empty frames, hidden from assistive tech; the line under it is read.
    const frames = document.querySelector('.auth-wall-frames')!
    expect(frames.getAttribute('aria-hidden')).toBe('true')
    expect(frames.children).toHaveLength(12)
    expect([...frames.children].every(f => f.childNodes.length === 0)).toBe(true)
    expect(screen.getByText('Lights down. Your library is ready.').closest('[aria-hidden="true"]')).toBeNull()
  })

  it('asks for both fields before asking the server', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('Enter a username and a password.')
    expect(api.login).not.toHaveBeenCalled()
  })

  it('says a refusal in its own words, never the server\'s, and can be tried again', async () => {
    api.login.mockRejectedValueOnce(refused(401, 'invalid credentials'))
    await open()
    type('Username', 'morgan')
    type('Password', 'wrong')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('That username and password do not match.')
    expect(document.body.textContent).not.toContain('invalid credentials')
    // The next try clears it while it is out.
    let answer!: (u: unknown) => void
    api.login.mockImplementationOnce(() => new Promise(done => { answer = done }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled()
    answer(USER)
    await flush()
    expect(onLogin).toHaveBeenCalledWith(USER)
  })

  it('offers the sign-in providers the server has switched on, each a link to its own start', async () => {
    await open('/', status({ oauth_google_enabled: true, oauth_twitter_enabled: true }))
    const group = screen.getByRole('group', { name: 'Other ways to sign in' })
    const links = within(group).getAllByRole('link')
    expect(links.map(l => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Continue with Google', '/api/auth/oauth/google/start'],
      ['Continue with X', '/api/auth/oauth/twitter/start'],
    ])
    cleanup()
    // None switched on, or the server could not say: no divider and no group.
    await open()
    expect(screen.queryByRole('group', { name: 'Other ways to sign in' })).toBeNull()
    expect(document.querySelector('.auth-or')).toBeNull()
    cleanup()
    await open('/', new Error('HTTP 503'))
    expect(screen.queryByRole('group', { name: 'Other ways to sign in' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('keeps a provider link in the tree, marked unavailable, while a sign-in is out', async () => {
    api.login.mockImplementationOnce(() => new Promise(() => {}))
    await open('/', status({ oauth_google_enabled: true }))
    type('Username', 'morgan')
    type('Password', 'pw')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    const link = screen.getByText('Continue with Google')
    expect(link.getAttribute('aria-disabled')).toBe('true')
    expect(link.hasAttribute('href')).toBe(false)
  })
})

// The fields and the button are disabled while the server is asked, which
// drops the focus to the page; and the button that takes the viewer from one
// page to the other goes with the page it was on.
describe('where the focus goes', () => {
  it('to the field a refusal is about, and to the first field when it is about none', async () => {
    api.login.mockRejectedValueOnce(refused(401, 'invalid credentials'))
    await open()
    type('Username', 'morgan')
    type('Password', 'wrong')
    const press = screen.getByRole('button', { name: 'Sign in' })
    press.focus()
    fireEvent.click(press)
    await flush()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByLabelText('Username'))
    // The server is down: no field is at fault, and the first one gets it.
    api.login.mockRejectedValueOnce(refused(500, 'internal error'))
    screen.getByLabelText('Password').focus()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await flush()
    expect(document.activeElement).toBe(screen.getByLabelText('Username'))
  })

  it('to the field the server names on the page that makes an account, and to the invite code when none is named', async () => {
    await open()
    toRegister()
    type('Invite code', 'LANTERN-7Q4K')
    type('Username', 'theo')
    type('Email', 'theo@example')
    type('Password', 'short')
    const press = async () => { fireEvent.click(screen.getByRole('button', { name: 'Create account' })); await flush() }
    for (const [status, sentence, label] of [
      [400, 'invalid email format', 'Email'],
      [400, 'password must be at least 8 characters', 'Password'],
      [400, 'invalid or expired invite code', 'Invite code'],
      [409, 'that username or email is unavailable', 'Username'],
      // No field is at fault: the form's first.
      [429, 'rate limit exceeded, try again later', 'Invite code'],
    ] as const) {
      api.register.mockRejectedValueOnce(refused(status, sentence))
      ;(document.activeElement as HTMLElement | null)?.blur()
      await press()
      expect(document.activeElement, sentence).toBe(screen.getByLabelText(label))
    }
  })

  it('to the first thing missing when the page itself asks for it', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await flush()
    expect(document.activeElement).toBe(screen.getByLabelText('Username'))
    type('Username', 'morgan')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await flush()
    expect(document.activeElement).toBe(screen.getByLabelText('Password'))
    toRegister()
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await flush()
    expect(document.activeElement).toBe(screen.getByLabelText('Invite code'))
    type('Invite code', 'LANTERN-7Q4K')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await flush()
    expect(document.activeElement).toBe(screen.getByLabelText('Email'))
  })

  it('to the new page\'s heading when the viewer goes from one page to the other, and nowhere when the page opens', async () => {
    await open()
    // Opening the page takes no focus.
    expect(document.activeElement).toBe(document.body)
    toRegister()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Create an account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Welcome back' }))
    cleanup()
    // A server with no account opens on the form that makes one, by itself: no focus moves.
    await open('/', status({ setup_complete: false, has_users: false }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Set up this server')
    expect(document.activeElement).toBe(document.body)
  })
})

describe('connecting a TV from the sign-in page', () => {
  it('leads to the page that pairs one, which says what the sign-in is for and does not offer itself', async () => {
    await open()
    fireEvent.click(screen.getByRole('link', { name: 'Connect a TV with a code' }))
    await flush()
    expect(where.path).toBe('/device')
    expect(screen.getByText('Sign in to connect your TV. Its code comes next.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Connect a TV with a code' })).toBeNull()
    // Still the sign-in page: the same fields, the same heading.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome back')
  })

  it('says so when the page is opened on a TV\'s link', async () => {
    await open('/device')
    expect(screen.getByText('Sign in to connect your TV. Its code comes next.')).toBeInTheDocument()
    expect(screen.queryByText('Sign in to your media server.')).toBeNull()
  })

  // A provider's round trip comes back to the app's front page. What the
  // viewer was here for is kept for the tab across it.
  /** Follows a provider's link as far as its click handler (jsdom goes nowhere). */
  const follow = (name: string) => {
    const link = screen.getByText(name)
    link.addEventListener('click', e => e.preventDefault())
    fireEvent.click(link)
  }
  it('remembers, across a provider\'s sign-in, that the viewer came to connect a TV', async () => {
    await open('/', status({ oauth_google_enabled: true }))
    fireEvent.click(screen.getByRole('link', { name: 'Connect a TV with a code' }))
    await flush()
    follow('Continue with Google')
    expect(consumeDeviceIntent()).toBe(true)
    // Used once.
    expect(consumeDeviceIntent()).toBe(false)
  })

  it('remembers nothing of the kind from the plain sign-in page', async () => {
    await open('/', status({ oauth_google_enabled: true }))
    follow('Continue with Google')
    expect(consumeDeviceIntent()).toBe(false)
    expect(consumeDevicePairing()).toBeNull()
  })

  it('carries a TV\'s code in the address across a provider\'s sign-in', async () => {
    // The app is served under /v2: that is the address the code is read from.
    window.history.replaceState({}, '', '/v2/device?code=abcd-1234')
    await open('/device', status({ oauth_google_enabled: true }))
    follow('Continue with Google')
    expect(consumeDevicePairing()).toBe('ABCD-1234')
  })

  it('remembers nothing while a sign-in is out and the link is unavailable', async () => {
    api.login.mockImplementationOnce(() => new Promise(() => {}))
    window.history.replaceState({}, '', '/v2/device?code=abcd-1234')
    await open('/device', status({ oauth_google_enabled: true }))
    type('Username', 'morgan')
    type('Password', 'pw')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    follow('Continue with Google')
    expect(consumeDeviceIntent()).toBe(false)
    expect(consumeDevicePairing()).toBeNull()
  })
})

describe('the page that creates an account', () => {
  it('is reached from the sign-in page and leads back, keeping what was typed', async () => {
    await open()
    type('Username', 'theo')
    toRegister()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Create an account')
    expect(document.querySelector('[data-auth]')!.getAttribute('data-auth')).toBe('register')
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('theo')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome back')
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('theo')
  })

  it('asks for the invite code a server with accounts needs, and makes the account with it', async () => {
    await open()
    toRegister()
    expect(screen.getByText('This server is private. Signing up with a password needs an invite code from its admin.')).toBeInTheDocument()
    type('Invite code', 'lantern-7q4k')
    // Codes are upper case; typed in lower, they are shown as they will be sent.
    expect((screen.getByLabelText('Invite code') as HTMLInputElement).value).toBe('LANTERN-7Q4K')
    type('Username', 'theo')
    type('Email', 'theo@example.test')
    type('Password', 'long enough')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await flush()
    expect(api.register).toHaveBeenCalledWith({ username: 'theo', email: 'theo@example.test', password: 'long enough', invite_code: 'LANTERN-7Q4K' })
    expect(onLogin).toHaveBeenCalledWith(USER)
  })

  // The artboard marks a typed code "Valid". No route checks a code before
  // the account is made, so the page gives no verdict on one.
  it('gives no verdict on an invite code as it is typed', async () => {
    await open()
    toRegister()
    type('Invite code', 'LANTERN-7Q4K')
    await flush()
    expect(document.body.textContent).not.toMatch(/valid/i)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('asks for what the server will need before asking it: the code, then all three fields', async () => {
    await open()
    toRegister()
    const press = async () => { fireEvent.click(screen.getByRole('button', { name: 'Create account' })); await flush() }
    type('Username', 'theo')
    type('Password', 'long enough')
    await press()
    expect(screen.getByRole('alert').textContent).toBe('Enter the invite code from this server’s admin.')
    type('Invite code', 'LANTERN-7Q4K')
    // The server refuses a new account with no email address.
    await press()
    expect(screen.getByRole('alert').textContent).toBe('Enter a username, an email address and a password.')
    type('Email', '   ')
    await press()
    expect(screen.getByRole('alert').textContent).toBe('Enter a username, an email address and a password.')
    expect(api.register).not.toHaveBeenCalled()
  })

  it('carries the typed invite code to a sign-in provider, and none from the sign-in page', async () => {
    await open('/', status({ oauth_discord_enabled: true }))
    expect(screen.getByText('Continue with Discord').getAttribute('href')).toBe('/api/auth/oauth/discord/start')
    toRegister()
    // There the links make an account, and their group says so.
    expect(screen.getByRole('group', { name: 'Other ways to create an account' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Other ways to sign in' })).toBeNull()
    type('Invite code', 'lantern 7q4k')
    expect(screen.getByText('Continue with Discord').getAttribute('href')).toBe('/api/auth/oauth/discord/start?invite=LANTERN+7Q4K')
    // Back on the sign-in page the code stays behind.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByText('Continue with Discord').getAttribute('href')).toBe('/api/auth/oauth/discord/start')
  })
})

describe('a server with no account yet', () => {
  it('opens on the form that makes the first one, with no invite code and no way to sign in', async () => {
    await open('/', status({ setup_complete: false, has_users: false }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Set up this server')
    expect(screen.getByText('Nobody has an account here yet. The one you make now becomes the server’s admin.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Invite code')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    type('Username', 'morgan')
    type('Email', 'm@example.test')
    type('Password', 'long enough')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await flush()
    expect(api.register).toHaveBeenCalledWith({ username: 'morgan', email: 'm@example.test', password: 'long enough', invite_code: '' })
  })
})

// The server's own refusals (internal/api/auth_handlers.go, and the rate
// limiter's), each as the page says it and with the field it is about.
describe('what a refusal says', () => {
  const NOT_NOW = { signin: 'Could not sign in just now. Try again in a moment.', making: 'The account could not be created just now. Try again in a moment.' }
  it.each([
    [401, 'invalid credentials', 'That username and password do not match.', 'username'],
    [400, 'username and password required', 'Enter a username and a password.', 'username'],
    [400, 'invite code required', 'Enter the invite code from this server’s admin.', 'invite'],
    [400, 'invalid or expired invite code', 'That invite code was not accepted. Check it with the server’s admin.', 'invite'],
    [409, 'that username or email is unavailable', 'That username or email is already in use.', 'username'],
    [400, 'username, email, and password required', 'Enter a username, an email address and a password.', 'username'],
    [400, 'username must be 3-50 characters', 'A username needs 3 to 50 characters.', 'username'],
    [400, 'username may only contain letters, numbers, underscores, and hyphens', 'A username can have letters, numbers, underscores and hyphens.', 'username'],
    [400, 'invalid email format', 'That email address does not look right.', 'email'],
    [400, 'password must be at least 8 characters', 'A password needs 8 to 128 characters.', 'password'],
    [400, 'password must be at most 128 characters', 'A password needs 8 to 128 characters.', 'password'],
  ] as const)('%i %s', (code, server, page, field) => {
    expect(refusalSays(refused(code, server), true)).toEqual({ says: page, field })
  })

  it('says a sign-in or an account refused while a database restore runs is paused, not failed', () => {
    const restoring = new APIError(503, 'a database restore is running; signing in and changes to sign-in details are paused until it ends',
      { error: { code: 503, reason: 'restore_running', message: 'a database restore is running' } })
    expect(refusalSays(restoring, false)).toEqual({ says: 'A database restore is running on this server, so signing in is paused until it has finished.', field: null })
    expect(refusalSays(restoring, true)).toEqual({ says: 'A database restore is running on this server, so accounts cannot be made until it has finished.', field: null })
    // Another 503 (a proxy's) is the general sentence.
    expect(refusalSays(new APIError(503, 'Service Unavailable', null), false)).toEqual({ says: 'Could not sign in just now. Try again in a moment.', field: null })
  })

  it('says a rate limit is one, whatever its words, and a request that got no answer is the connection', () => {
    expect(refusalSays(refused(429, 'rate limit exceeded, try again later'), false)).toEqual({ says: 'Too many tries. Wait a moment and try again.', field: null })
    expect(refusalSays(refused(429, 'slow down'), true)).toEqual({ says: 'Too many tries. Wait a moment and try again.', field: null })
    expect(refusalSays(new TypeError('Failed to fetch'), false)).toEqual({ says: 'The server could not be reached. Check your connection and try again.', field: null })
  })

  // Each of these has a word in it ("password", "invite", "username") that
  // a field's line was once matched on: a server fault told its viewer that
  // a password needs 8 to 128 characters, or that the code was not accepted.
  it('makes no statement about a field from a server fault that happens to name one', () => {
    for (const [code, server] of [
      [500, 'failed to hash password'],
      [500, 'failed to process invite code'],
      [500, 'failed to create user'],
      [500, 'failed to generate refresh token'],
      [500, 'internal error'],
      // A known sentence under a status it does not come with.
      [500, 'invalid credentials'],
      [503, 'invalid or expired invite code'],
    ] as const) {
      expect(refusalSays(refused(code, server), true), server).toEqual({ says: NOT_NOW.making, field: null })
      expect(refusalSays(refused(code, server), false), server).toEqual({ says: NOT_NOW.signin, field: null })
    }
  })

  it('says nothing of a message it does not know, and matches no sentence by a word inside it', () => {
    for (const leaked of [
      'pq: relation "users" does not exist at character 15', '', 'HTTP 400', 'invalid request body',
      // Not the server's sentences: longer, shorter, or another case.
      'the password must be at least 8 characters long', 'username', 'Invalid credentials', 'email', 'invite',
    ]) {
      expect(refusalSays(refused(400, leaked), false), leaked).toEqual({ says: NOT_NOW.signin, field: null })
      expect(refusalSays(refused(400, leaked), true), leaked).toEqual({ says: NOT_NOW.making, field: null })
    }
    // The server's own sentences under their own statuses, but not as it writes them.
    for (const [code, altered] of [[401, 'Invalid credentials'], [401, 'invalid credentials.'], [409, 'That username or email is unavailable'], [400, 'INVALID EMAIL FORMAT']] as const) {
      expect(refusalSays(refused(code, altered), false), altered).toEqual({ says: NOT_NOW.signin, field: null })
    }
    // Something thrown that is neither the server's answer nor fetch's failure.
    expect(refusalSays(new Error('that username or email is unavailable'), true)).toEqual({ says: NOT_NOW.making, field: null })
    expect(refusalSays(undefined, false)).toEqual({ says: NOT_NOW.signin, field: null })
  })

  it('is what the register page shows when the server refuses', async () => {
    api.register.mockRejectedValueOnce(refused(409, 'that username or email is unavailable'))
    await open()
    toRegister()
    type('Invite code', 'LANTERN-7Q4K')
    type('Username', 'theo')
    type('Email', 'theo@example.test')
    type('Password', 'long enough')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('That username or email is already in use.')
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('says a server fault on sign-in as one, in the page\'s words', async () => {
    api.login.mockRejectedValueOnce(refused(500, 'failed to generate refresh token'))
    await open()
    type('Username', 'morgan')
    type('Password', 'correct horse')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('Could not sign in just now. Try again in a moment.')
    expect(document.body.textContent).not.toContain('refresh token')
  })

  // The page could not read how the server is set up, so it drew no invite
  // field; the server then asks for a code. The field is drawn, and asked for.
  it('draws the invite field when the server asks for a code the page had no field for', async () => {
    api.register.mockRejectedValueOnce(refused(400, 'invite code required'))
    await open('/', new Error('HTTP 503'))
    toRegister()
    expect(screen.queryByLabelText('Invite code')).toBeNull()
    type('Username', 'theo')
    type('Email', 'theo@example.test')
    type('Password', 'long enough')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('Enter the invite code from this server’s admin.')
    const code = screen.getByLabelText('Invite code')
    expect(document.activeElement).toBe(code)
    // And it is needed from then on, before the server is asked again.
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await flush()
    expect(api.register).toHaveBeenCalledTimes(1)
    type('Invite code', 'lantern-7q4k')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await flush()
    expect(api.register).toHaveBeenLastCalledWith({ username: 'theo', email: 'theo@example.test', password: 'long enough', invite_code: 'LANTERN-7Q4K' })
  })
})

describe('a database restore this browser started', () => {
  // From a restore's wipe until it commits, and after one that fails past
  // it or succeeds, its admin is signed out and lands here: this page reads
  // the restore by the ticket the browser kept, with no session.
  const keep = (seen: string | null = null) =>
    localStorage.setItem('aurora.restore', JSON.stringify({ ticket: 't'.repeat(43), file: 'aurora-backup.dump', seen }))
  const answer = (res: Response | Error) => vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) =>
    String(url) === '/api/restore/status'
      ? (res instanceof Error ? Promise.reject(res) : Promise.resolve(res.clone()))
      : Promise.reject(new Error(`unexpected fetch ${String(url)}`))))
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
  afterEach(() => { localStorage.clear(); resetRestoreRecordForTest() })

  it('says one is running, on the sign-in page and the first-run page alike', async () => {
    keep('running')
    answer(json(200, { state: 'running', step: 'restoring', database: 'unchanged', file: 'aurora-backup.dump', started_at: '2026-11-13T15:00:00Z', restart_required: false }))
    await open()
    const note = await screen.findByRole('region', { name: 'A restore is running' })
    expect(note).toHaveTextContent('Until it has finished, Aurora waits for it: pages hang (some fail after a minute) and signing in is paused.')
    cleanup()
    await open('/', status({ has_users: false }))
    expect(await screen.findByRole('region', { name: 'A restore is running' })).toBeInTheDocument()
  })

  it('says to restart after one that succeeded, and puts it away when dismissed', async () => {
    keep('running')
    answer(json(200, { state: 'succeeded', database: 'restored', file: 'aurora-backup.dump', started_at: '2026-11-13T15:00:00Z', finished_at: '2026-11-13T15:10:00Z', restart_required: true, message: 'Restore complete.' }))
    await open()
    const note = await screen.findByRole('region', { name: 'Restart Aurora now' })
    expect(note).toHaveTextContent('Sign-ins from before the restore have ended: sign in again with an account from the backup.')
    // The sign-in form is still there to use.
    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    fireEvent.click(within(note).getByRole('button', { name: /Dismiss/ }))
    expect(screen.queryByRole('region', { name: 'Restart Aurora now' })).toBeNull()
    expect(localStorage.getItem('aurora.restore')).toBeNull()
  })

  it('says the database holds the old data or the backup after one cut off as it committed', async () => {
    keep('running')
    answer(json(200, { state: 'failed', step: 'restoring', database: 'unknown', file: 'aurora-backup.dump', started_at: '2026-11-13T15:00:00Z', finished_at: '2026-11-13T15:10:00Z', restart_required: false, message: 'psql ended without reporting whether the COMMIT took effect' }))
    await open()
    const note = await screen.findByRole('region', { name: 'Aurora cannot tell whether the restore from aurora-backup.dump went through' })
    expect(note).toHaveTextContent('the database holds either what it held before or the backup')
    // The server's own text is for the Admin page only.
    expect(note).not.toHaveTextContent('COMMIT took effect')
  })

  it('says Aurora has no record of one it last saw running', async () => {
    keep('running')
    answer(json(404, { error: { code: 404, reason: 'restore_unknown', message: 'no restore with this ticket' } }))
    await open()
    expect(await screen.findByRole('region', { name: 'Aurora has no record of the restore from aurora-backup.dump' })).toHaveTextContent('the restore was stopped and rolled back, so the database is as it was')
  })

  it('says nothing, and asks nothing, without a restore', async () => {
    answer(new Error('no fetch expected'))
    await open()
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('region')).toBeNull()
  })
})
