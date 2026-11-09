// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MediaRequest } from '@/lib/api'
import RequestsView from './RequestsView'

const request = (id: number, extra: Partial<MediaRequest> = {}): MediaRequest => ({
  id,
  user_id: 1,
  media_type: 'movie',
  tmdb_id: 1000 + id,
  title: `Title ${id}`,
  poster_path: '',
  overview: '',
  year: 2001,
  status: 'available',
  quality_1080p: true,
  quality_4k: false,
  requested_at: '2026-11-08T12:00:00Z',
  updated_at: '2026-11-08T12:00:00Z',
  ...extra,
})

describe('RequestsView overview', () => {
  // The overview used to sit behind a Show/Hide overview toggle. It is now
  // part of the card, with nothing to press.
  it('shows each overview without a toggle', () => {
    render(
      <RequestsView
        requests={[
          request(1, { overview: 'A witch family moves to a hidden town.' }),
          request(2, { overview: 'A masked killer returns home.' }),
        ]}
        onRequestSubmitted={() => {}}
        onRequestDeleted={() => {}}
      />,
    )
    expect(screen.getByText('A witch family moves to a hidden town.')).toBeInTheDocument()
    expect(screen.getByText('A masked killer returns home.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /overview/i })).not.toBeInTheDocument()
  })

  // Some older TMDB entries carry no overview, or only whitespace: the card
  // renders nothing for them. Compared as whole cards rather than by tag, so
  // the check holds whatever element the overview is drawn in: a whitespace
  // overview must render exactly what an empty one does, and an empty one
  // must render nothing a real overview adds.
  it('renders nothing for a blank overview', () => {
    const card = (overview: string) => {
      const { container, unmount } = render(
        <RequestsView
          requests={[request(1, { overview })]}
          onRequestSubmitted={() => {}}
          onRequestDeleted={() => {}}
        />,
      )
      const li = container.querySelector('li')
      expect(li).not.toBeNull()
      const html = li!.innerHTML
      const elements = li!.querySelectorAll('*').length
      unmount()
      return { html, elements }
    }
    const empty = card('')
    expect(card('   ').html).toBe(empty.html)
    expect(card('Some overview.').elements).toBeGreaterThan(empty.elements)
  })
})
