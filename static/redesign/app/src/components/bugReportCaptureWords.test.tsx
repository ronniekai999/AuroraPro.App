// @vitest-environment jsdom
// A capture or a recording that fails is said in the app's words: the
// capture library's and the browser's ("The operation is insecure.",
// "Could not start video source") are for a developer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const toBlob = vi.hoisted(() => vi.fn())
vi.mock('html-to-image', () => ({ toBlob }))

import { BugReportModal } from './BugReportModal'

const dialog = () => screen.getByRole('dialog')
const said = () => dialog().querySelector('#bug-error')

beforeEach(() => { toBlob.mockReset() })
afterEach(() => { vi.unstubAllGlobals() })

describe('the bug report form: capture and recording', () => {
  it('says a capture that failed in its own words', async () => {
    const user = userEvent.setup()
    toBlob.mockRejectedValue(new DOMException('The operation is insecure.', 'SecurityError'))
    render(<BugReportModal prefillName="" onClose={() => {}} onSubmitted={() => {}} />)
    await user.click(within(dialog()).getByRole('button', { name: /Capture this page/ }))
    await waitFor(() => expect(said()).toHaveTextContent('The capture failed. Try again, or attach a screenshot from your device instead.'))
    expect(dialog().textContent).not.toMatch(/insecure/)
  })

  it('says a recording the browser could not start in its own words', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('MediaRecorder', class { static isTypeSupported() { return true } })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockRejectedValue(new DOMException('Could not start video source', 'NotReadableError')) },
    })
    render(<BugReportModal prefillName="" onClose={() => {}} onSubmitted={() => {}} />)
    await user.click(within(dialog()).getByRole('button', { name: /Record screen/ }))
    await waitFor(() => expect(said()).toHaveTextContent('Screen recording could not start.'))
    expect(dialog().textContent).not.toMatch(/video source/)
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices
  })

  it('says a recorder that could not start in its own words', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('MediaRecorder', class {
      static isTypeSupported() { return true }
      ondataavailable: unknown = null
      onstop: unknown = null
      onerror: unknown = null
      start() { throw new DOMException('The MediaRecorder is in an invalid state', 'InvalidStateError') }
      stop() {}
    })
    const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), onended: null }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }) },
    })
    render(<BugReportModal prefillName="" onClose={() => {}} onSubmitted={() => {}} />)
    await user.click(within(dialog()).getByRole('button', { name: /Record screen/ }))
    await waitFor(() => expect(said()).toHaveTextContent('Screen recording could not start.'))
    expect(dialog().textContent).not.toMatch(/invalid state/)
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices
  })

  it('says a recorder that could not be made in its own words', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('MediaRecorder', class {
      static isTypeSupported() { return true }
      constructor() { throw new DOMException('Failed to construct MediaRecorder: bad codec', 'NotSupportedError') }
    })
    const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), onended: null }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }) },
    })
    render(<BugReportModal prefillName="" onClose={() => {}} onSubmitted={() => {}} />)
    await user.click(within(dialog()).getByRole('button', { name: /Record screen/ }))
    await waitFor(() => expect(said()).toHaveTextContent('Screen recording could not start.'))
    expect(dialog().textContent).not.toMatch(/codec|construct/)
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices
  })
})
