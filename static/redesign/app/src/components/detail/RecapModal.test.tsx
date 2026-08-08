// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecapModal } from './RecapModal'

const api = vi.hoisted(() => ({
	APIError: class APIError extends Error {
		status: number
		body: unknown
		constructor(status: number, message: string, body: unknown = null) {
			super(message)
			this.status = status
			this.body = body
		}
	},
  askPreviously: vi.fn(),
  clearRecapConversation: vi.fn(),
  clearUnsafeRecapTurns: vi.fn(),
  getRecapConversation: vi.fn(),
  markWatched: vi.fn(),
}))

vi.mock('@/lib/api', () => api)

const boundary = { episode_id: 513, season: 5, episode: 13, title: 'Something Wicca This Way Goes' }

const emptyConversation = () => ({
  available: true,
	can_ask: true,
  turns: [],
  current_up_to: boundary,
  hidden_turn_count: 0,
})

const turn = (overrides = {}) => ({
  id: 1,
  request_id: '550e8400-e29b-41d4-a716-446655440000',
  question: 'What happened to Paige?',
  answer: 'Cole erased Paige as a Halliwell, but she fought her way back and restored her bond with her sisters.',
  up_to: boundary,
  mode: 'grounded' as const,
  created_at: '2026-08-08T12:00:00Z',
  ...overrides,
})

const renderModal = (overrides = {}) => render(
  <RecapModal
    mediaId={42}
    profileId={7}
    title="Charmed"
    loading={false}
    recap="Phoebe and her sisters defeated Cole and restored the Power of Three."
    suggestedQuestions={['Why is Cole back?', 'Who is Sam?', 'What is happening at the Manor?']}
    upTo={boundary}
    onClose={() => {}}
    onStart={() => {}}
    {...overrides}
  />,
)

beforeEach(() => {
	for (const mock of Object.values(api)) {
		if ('mockReset' in mock && typeof mock.mockReset === 'function') mock.mockReset()
	}
  api.getRecapConversation.mockResolvedValue(emptyConversation())
  api.askPreviously.mockResolvedValue({ turn: turn(), current_up_to: boundary })
  api.clearRecapConversation.mockResolvedValue(undefined)
  api.clearUnsafeRecapTurns.mockResolvedValue(undefined)
  api.markWatched.mockResolvedValue({ message: 'marked as watched' })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
})

describe('RecapModal Ask Previously', () => {
  it('enters Ask within the recap and submits an initial suggestion', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
    expect(await screen.findByText('You might also ask')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Why is Cole back/i }))

    await waitFor(() => expect(api.askPreviously).toHaveBeenCalledTimes(1))
    expect(api.askPreviously.mock.calls[0][0]).toBe(42)
    expect(api.askPreviously.mock.calls[0][2]).toBe('Why is Cole back?')
    expect(await screen.findByText(/restored her bond with her sisters/i)).toBeInTheDocument()
    expect(screen.queryByText('You might also ask')).not.toBeInTheDocument()
  })

  it('allows only one in-flight question at a time', async () => {
    const user = userEvent.setup()
    let finishAnswer: (value: unknown) => void = () => {}
    api.askPreviously.mockReturnValue(new Promise(resolve => { finishAnswer = resolve }))
    renderModal()

    await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
    const composer = await screen.findByRole('textbox', { name: 'Ask about what you’ve watched' })
    await user.type(composer, 'What happened to Paige?')
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })

    expect(api.askPreviously).toHaveBeenCalledTimes(1)
    finishAnswer({ turn: turn(), current_up_to: boundary })
    expect(await screen.findByText(/restored her bond with her sisters/i)).toBeInTheDocument()
  })

  it('does not expose the composer until availability is confirmed', async () => {
    const user = userEvent.setup()
    let rejectLoad: (reason?: unknown) => void = () => {}
    api.getRecapConversation.mockReturnValue(new Promise((_, reject) => { rejectLoad = reject }))
    renderModal()

    await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
    expect(screen.queryByRole('textbox', { name: 'Ask about what you’ve watched' })).not.toBeInTheDocument()
    rejectLoad(new Error('History is unavailable.'))
    expect(await screen.findByText('History is unavailable.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Ask about what you’ve watched' })).not.toBeInTheDocument()
  })

  it('loads persisted turns and prepends an earlier cursor page', async () => {
    const user = userEvent.setup()
    api.getRecapConversation
      .mockResolvedValueOnce({
        available: true,
				can_ask: true,
        turns: [turn()],
        current_up_to: boundary,
        hidden_turn_count: 0,
        next_before_turn_id: 1,
      })
      .mockResolvedValueOnce({
        available: true,
				can_ask: true,
        turns: [turn({ id: 0, question: 'Who is Sam?', answer: 'Sam is Paige’s biological father.' })],
        current_up_to: boundary,
        hidden_turn_count: 0,
      })
    renderModal()
    await user.click(screen.getByRole('button', { name: 'Ask Previously' }))

    expect(await screen.findByText('What happened to Paige?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Load earlier questions' }))
    expect(await screen.findByText('Who is Sam?')).toBeInTheDocument()
    expect(api.getRecapConversation).toHaveBeenLastCalledWith(42, 7, 1, expect.any(AbortSignal))
  })

  it('retries a failed answer with the same idempotency key', async () => {
    const user = userEvent.setup()
    api.askPreviously
      .mockRejectedValueOnce(new Error('The AI took too long.'))
      .mockResolvedValueOnce({ turn: turn(), current_up_to: boundary })
    renderModal()
    await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
    await screen.findByText('You might also ask')

    const composer = screen.getByRole('textbox', { name: 'Ask about what you’ve watched' })
    await user.type(composer, 'What happened to Paige?')
    await user.keyboard('{Enter}')
    expect(await screen.findByText('The AI took too long.')).toBeInTheDocument()
    const firstRequestID = api.askPreviously.mock.calls[0][1]

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api.askPreviously).toHaveBeenCalledTimes(2))
    expect(api.askPreviously.mock.calls[1][1]).toBe(firstRequestID)
    expect(await screen.findByText(/restored her bond with her sisters/i)).toBeInTheDocument()
  })

  it('protects rewound history and can clear only hidden answers', async () => {
    const user = userEvent.setup()
		api.getRecapConversation
			.mockResolvedValueOnce({
      available: true,
				can_ask: true,
      turns: [turn({ up_to: { ...boundary, season: 4, episode: 22 } })],
				current_up_to: { episode_id: 402, season: 4, episode: 22 },
				hidden_turn_count: 2,
				highest_hidden_up_to: boundary,
			})
			.mockRejectedValueOnce(new Error('Reconciliation failed.'))
    renderModal({ upTo: { episode_id: 402, season: 4, episode: 22 } })
    await user.click(screen.getByRole('button', { name: 'Ask Previously' }))

    expect(await screen.findByText('2 later answers are hidden')).toBeInTheDocument()
    expect(screen.queryByText('Why did Cole return after Season 5?')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear hidden answers' }))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear hidden answers' }))
		await waitFor(() => expect(api.clearUnsafeRecapTurns).toHaveBeenCalledWith(42, 7, expect.any(AbortSignal)))
		expect(screen.queryByText('2 later answers are hidden')).not.toBeInTheDocument()
		expect(await screen.findByText('Reconciliation failed.')).toBeInTheDocument()
  })

  it('restores the highest hidden episode through the existing progress API', async () => {
    const user = userEvent.setup()
    const onRefreshRecap = vi.fn().mockResolvedValue(undefined)
    api.getRecapConversation
      .mockResolvedValueOnce({ ...emptyConversation(), hidden_turn_count: 1, highest_hidden_up_to: boundary })
      .mockResolvedValueOnce(emptyConversation())
    renderModal({ onRefreshRecap })
    await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
    await user.click(await screen.findByRole('button', { name: /Restore to S5 · E13/ }))
    await user.click(await screen.findByRole('button', { name: 'Restore progress' }))

		await waitFor(() => expect(api.markWatched).toHaveBeenCalledWith(42, { episode_id: 513, profile_id: 7 }, expect.any(AbortSignal)))
    expect(onRefreshRecap).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.getRecapConversation).toHaveBeenCalledTimes(2))
  })

  it('aborts stale history and reloads when the active profile changes', async () => {
    const user = userEvent.setup()
    api.getRecapConversation
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(emptyConversation())
    const rendered = renderModal()

    await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
    await waitFor(() => expect(api.getRecapConversation).toHaveBeenCalledTimes(1))
    const staleSignal = api.getRecapConversation.mock.calls[0][3] as AbortSignal

    rendered.rerender(
      <RecapModal
        mediaId={42}
        profileId={8}
        title="Charmed"
        loading={false}
        recap="Phoebe and her sisters defeated Cole and restored the Power of Three."
        suggestedQuestions={['Why is Cole back?', 'Who is Sam?', 'What is happening at the Manor?']}
        upTo={boundary}
        onClose={() => {}}
        onStart={() => {}}
      />,
    )
    await waitFor(() => expect(staleSignal.aborted).toBe(true))
    await user.click(await screen.findByRole('button', { name: 'Ask Previously' }))
    expect(await screen.findByText('You might also ask')).toBeInTheDocument()
    expect(api.getRecapConversation).toHaveBeenLastCalledWith(42, 8, undefined, expect.any(AbortSignal))
  })

	it('removes the previous profile conversation in the identity-change commit', async () => {
		const user = userEvent.setup()
		api.getRecapConversation
			.mockResolvedValueOnce({
				...emptyConversation(),
				turns: [turn({ question: 'Profile seven private question', answer: 'Profile seven private answer.' })],
			})
			.mockResolvedValueOnce(emptyConversation())
		const rendered = renderModal()
		await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
		expect(await screen.findByText('Profile seven private question')).toBeInTheDocument()

		rendered.rerender(
			<RecapModal mediaId={42} profileId={8} title="Charmed" loading={false} recap="Safe recap" suggestedQuestions={['What changed?']} upTo={boundary} onClose={() => {}} />,
		)
		expect(screen.queryByText('Profile seven private question')).not.toBeInTheDocument()
		expect(screen.queryByText('Profile seven private answer.')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Ask Previously' })).toBeInTheDocument()
	})

	it('drops retained turns when progress regresses during pagination', async () => {
		const user = userEvent.setup()
		const e10 = { episode_id: 110, season: 1, episode: 10 }
		const e5 = { episode_id: 105, season: 1, episode: 5 }
		const e4 = { episode_id: 104, season: 1, episode: 4 }
		api.getRecapConversation
			.mockResolvedValueOnce({
				available: true,
				can_ask: true,
				turns: [turn({ id: 10, question: 'Unsafe E10 question', up_to: e10 })],
				current_up_to: e10,
				hidden_turn_count: 0,
				next_before_turn_id: 10,
			})
			.mockResolvedValueOnce({
				available: true,
				can_ask: true,
				turns: [turn({ id: 4, question: 'Safe E4 question', up_to: e4 })],
				current_up_to: e5,
				hidden_turn_count: 1,
			})
			.mockResolvedValueOnce({
				available: true,
				can_ask: true,
				turns: [turn({ id: 4, question: 'Safe E4 question', up_to: e4 })],
				current_up_to: e5,
				hidden_turn_count: 1,
			})
		renderModal({ upTo: e10 })
		await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
		expect(await screen.findByText('Unsafe E10 question')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Load earlier questions' }))
		expect(await screen.findByText('Safe E4 question')).toBeInTheDocument()
		expect(screen.queryByText('Unsafe E10 question')).not.toBeInTheDocument()
		expect(api.getRecapConversation).toHaveBeenLastCalledWith(42, 7, undefined, expect.any(AbortSignal))
	})

	it('drops retained turns when a successful submission reports a lower boundary', async () => {
		const user = userEvent.setup()
		const e10 = { episode_id: 110, season: 1, episode: 10 }
		const e5 = { episode_id: 105, season: 1, episode: 5 }
		const safeTurn = turn({ id: 5, question: 'Safe at E5?', answer: 'Yes.', up_to: e5 })
		api.getRecapConversation
			.mockResolvedValueOnce({ available: true, can_ask: true, turns: [turn({ id: 10, question: 'Unsafe E10 question', up_to: e10 })], current_up_to: e10, hidden_turn_count: 0 })
			.mockResolvedValueOnce({ available: true, can_ask: true, turns: [safeTurn], current_up_to: e5, hidden_turn_count: 1 })
		api.askPreviously.mockResolvedValueOnce({ turn: safeTurn, current_up_to: e5 })
		renderModal({ upTo: e10 })
		await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
		await user.type(await screen.findByRole('textbox', { name: 'Ask about what you’ve watched' }), 'Safe at E5?')
		await user.keyboard('{Enter}')
		expect(await screen.findByText('Safe at E5?')).toBeInTheDocument()
		expect(screen.queryByText('Unsafe E10 question')).not.toBeInTheDocument()
	})

	it('reloads and hides stale turns after a boundary-related 409', async () => {
		const user = userEvent.setup()
		const e10 = { episode_id: 110, season: 1, episode: 10 }
		const e5 = { episode_id: 105, season: 1, episode: 5 }
		api.getRecapConversation
			.mockResolvedValueOnce({ available: true, can_ask: true, turns: [turn({ id: 10, question: 'Unsafe E10 question', up_to: e10 })], current_up_to: e10, hidden_turn_count: 0 })
			.mockResolvedValueOnce({ available: true, can_ask: true, turns: [], current_up_to: e5, hidden_turn_count: 1 })
		api.askPreviously.mockRejectedValueOnce(new api.APIError(409, 'Viewing progress changed.'))
		renderModal({ upTo: e10 })
		await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
		await user.type(await screen.findByRole('textbox', { name: 'Ask about what you’ve watched' }), 'What changed?')
		await user.keyboard('{Enter}')
		expect(await screen.findByText('Viewing progress changed.')).toBeInTheDocument()
		expect(screen.queryByText('Unsafe E10 question')).not.toBeInTheDocument()
	})

	it('keeps unavailable saved history manageable without exposing the composer', async () => {
		const user = userEvent.setup()
		api.getRecapConversation.mockResolvedValueOnce({
			available: true,
			can_ask: false,
			reason: 'no_history',
			turns: [],
			hidden_turn_count: 1,
			highest_hidden_up_to: boundary,
		})
		renderModal({ recap: undefined, unavailableReason: 'no_history', hasAskHistory: true })
		await user.click(screen.getByRole('button', { name: 'Ask history' }))
		expect(await screen.findByText('1 later answer is hidden')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Restore to S5 · E13/ })).toBeInTheDocument()
		expect(screen.queryByRole('textbox', { name: 'Ask about what you’ve watched' })).not.toBeInTheDocument()
		expect(screen.queryByText(/Spoiler guard · through/)).not.toBeInTheDocument()
		await waitFor(() => expect(screen.getByRole('heading', { name: 'Ask about what you’ve watched' })).toHaveFocus())
	})

	it('clears full history, restores suggestions, and cancels stale loads', async () => {
		const user = userEvent.setup()
		api.getRecapConversation
			.mockResolvedValueOnce({ ...emptyConversation(), turns: [turn()] })
			.mockResolvedValueOnce(emptyConversation())
		renderModal()
		await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
		await user.click(await screen.findByRole('button', { name: 'Clear history' }))
		const dialog = await screen.findByRole('alertdialog')
		await user.click(within(dialog).getByRole('button', { name: 'Clear history' }))
		await waitFor(() => expect(api.clearRecapConversation).toHaveBeenCalledWith(42, 7, expect.any(AbortSignal)))
		expect(await screen.findByText('You might also ask')).toBeInTheDocument()
	})

	it('removes cleared history locally even when reconciliation fails', async () => {
		const user = userEvent.setup()
		api.getRecapConversation
			.mockResolvedValueOnce({ ...emptyConversation(), turns: [turn()] })
			.mockRejectedValueOnce(new Error('Reconciliation failed.'))
		renderModal()
		await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
		expect(await screen.findByText('What happened to Paige?')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Clear history' }))
		await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clear history' }))
		expect(await screen.findByText('Reconciliation failed.')).toBeInTheDocument()
		expect(screen.queryByText('What happened to Paige?')).not.toBeInTheDocument()
		expect(screen.queryByText(/restored her bond with her sisters/i)).not.toBeInTheDocument()
	})

	it('does not submit during IME composition or with Shift+Enter', async () => {
		const user = userEvent.setup()
		renderModal()
		await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
		const composer = await screen.findByRole('textbox', { name: 'Ask about what you’ve watched' })
		await user.type(composer, '質問')
		fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', isComposing: true })
		fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', shiftKey: true })
		expect(api.askPreviously).not.toHaveBeenCalled()
		fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })
		await waitFor(() => expect(api.askPreviously).toHaveBeenCalledTimes(1))
	})

	it('restores focus to Ask Previously when returning to the recap', async () => {
		const user = userEvent.setup()
		renderModal()
		await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
		await user.click(await screen.findByRole('button', { name: 'Back to recap' }))
		await waitFor(() => expect(screen.getByRole('button', { name: 'Ask Previously' })).toHaveFocus())
	})

	it('ignores a completed restore after the active profile changes', async () => {
		const user = userEvent.setup()
		let finishRestore: (value: unknown) => void = () => {}
		api.getRecapConversation.mockResolvedValue({ ...emptyConversation(), hidden_turn_count: 1, highest_hidden_up_to: boundary })
		api.markWatched.mockReturnValue(new Promise(resolve => { finishRestore = resolve }))
		const onRefreshRecap = vi.fn().mockResolvedValue(undefined)
		const rendered = renderModal({ onRefreshRecap })
		await user.click(screen.getByRole('button', { name: 'Ask Previously' }))
		await user.click(await screen.findByRole('button', { name: /Restore to S5 · E13/ }))
		await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore progress' }))
		await waitFor(() => expect(api.markWatched).toHaveBeenCalledTimes(1))

		rendered.rerender(
			<RecapModal mediaId={42} profileId={8} title="Charmed" loading={false} recap="Safe recap" suggestedQuestions={['What changed?']} upTo={boundary} onClose={() => {}} onRefreshRecap={onRefreshRecap} />,
		)
		finishRestore({ message: 'done' })
		await waitFor(() => expect(screen.getByRole('button', { name: 'Ask Previously' })).toBeInTheDocument())
		expect(onRefreshRecap).not.toHaveBeenCalled()
	})
})
