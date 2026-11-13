// @vitest-environment jsdom
//
// The error screen stands in for the app, and nothing is above it but the
// root: a throw of its own would leave a blank page. Each test makes one of
// its parts throw as a part really can, after the app itself has stopped:
// the report form on an update (the person typing), and the screen on its
// first draw.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from './ErrorBoundary'
import { thisPage } from '@/lib/errorReport'

const api = vi.hoisted(() => ({
  getBugReportConfig: vi.fn(),
  submitBugReport: vi.fn(),
}))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

// What breaks, per test.
const breaks = vi.hoisted(() => ({ formOnTitle: null as string | null, screen: false }))

vi.mock('@/components/BugReportForm', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/BugReportForm')>()
  function BugReportFields(props: Parameters<typeof real.BugReportFields>[0]) {
    if (breaks.formOnTitle !== null && props.form.title === breaks.formOnTitle) throw new Error('The form broke')
    return <real.BugReportFields {...props} />
  }
  return { ...real, BugReportFields }
})

vi.mock('@/lib/errorReport', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/errorReport')>()
  return {
    ...real,
    describeCaughtError: (...args: Parameters<typeof real.describeCaughtError>) => {
      if (breaks.screen) throw new Error('The screen broke')
      return real.describeCaughtError(...args)
    },
  }
})

function Throws(): never {
  throw new Error('Could not read the list of collections')
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  breaks.formOnTitle = null
  breaks.screen = false
  api.getBugReportConfig.mockReset().mockResolvedValue({ enabled: true })
  api.submitBugReport.mockReset()
  localStorage.setItem('aurora_user', JSON.stringify({ id: 1, username: 'morgan', email: 'morgan@example.test', role: 'user' }))
  localStorage.setItem('aurora_active_profile_id', '1')
  window.history.pushState({}, '', `${import.meta.env.BASE_URL}collections`)
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  window.history.pushState({}, '', '/')
})

describe('the error screen against its own errors', () => {
  it('loses only the report panel when the form throws, and keeps what the app saw and the ways out', async () => {
    const user = userEvent.setup()
    breaks.formOnTitle = 'boom'
    render(<ErrorBoundary><Throws /></ErrorBoundary>)
    await user.click(await screen.findByRole('button', { name: 'Report a problem' }))
    await user.type(screen.getByLabelText(/^Title/), 'boo')
    // The keystroke that breaks the form.
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'boom' } })
    const failed = document.querySelector<HTMLElement>('[data-error-report-failed]')!
    expect(failed).not.toBeNull()
    expect(within(failed).getByRole('alert')).toHaveTextContent('The report form could not be shown. Reload, and report the problem from the app once it is back.')
    await waitFor(() => expect(within(failed).getByRole('alert')).toHaveFocus())
    // The page is the one that opened, about the app's error, not the form's.
    expect(screen.getByRole('heading', { level: 1, name: 'That did not load.' })).toBeInTheDocument()
    expect(document.querySelector('[data-app-saw]')!.textContent).toContain('Could not read the list of collections')
    expect(document.body.textContent).not.toContain('The form broke')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Tonight' })).toBeInTheDocument()
    // Closed, it can be opened again, with a new form.
    breaks.formOnTitle = null
    fireEvent.click(within(failed).getByRole('button', { name: 'Close' }))
    expect(document.querySelector('[data-error-report-failed]')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Report a problem' }))
    expect(screen.getByLabelText(/^Title/)).toHaveValue('')
    expect(api.submitBugReport).not.toHaveBeenCalled()
  })

  it('draws a last page with Reload when the screen itself throws', async () => {
    breaks.screen = true
    const reload = vi.spyOn(thisPage, 'reload').mockImplementation(() => {})
    render(<ErrorBoundary><p>the app</p><Throws /></ErrorBoundary>)
    await act(async () => {})
    expect(screen.queryByText('the app')).toBeNull()
    const last = document.querySelector('[data-error-last-resort]')!
    expect(last).not.toBeNull()
    expect(within(last as HTMLElement).getByRole('heading', { level: 1, name: 'That did not load.' })).toBeInTheDocument()
    expect(last).toHaveTextContent('This page hit a problem and stopped. A reload usually brings it back.')
    fireEvent.click(within(last as HTMLElement).getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
