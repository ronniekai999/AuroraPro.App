// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({ createCollection: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  createCollection: api.createCollection,
}))

import { APIError } from '@/lib/api'
import { CollectionsModal } from './CollectionsModal'

afterEach(() => { cleanup(); vi.clearAllMocks() })

// A refused or failed create was shown as the server's own words.
describe('making a collection that fails', () => {
  it.each([
    ['the server failed', new APIError(500, 'pq: deadlock detected', null), 'Could not make the collection just now.'],
    ['the server refused it', new APIError(400, 'pq: deadlock detected', null), 'Could not make the collection.'],
  ])('says so in the app\'s words when %s', async (_how, err, says) => {
    api.createCollection.mockRejectedValue(err)
    render(<CollectionsModal isAdmin={false} onClose={() => {}} onCreated={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Marvel Cinematic Universe'), { target: { value: 'Rainy nights' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Collection' }))
    expect((await screen.findByRole('alert')).textContent).toBe(says)
    expect(document.body.textContent).not.toContain('deadlock')
  })
})
