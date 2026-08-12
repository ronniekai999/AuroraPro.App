// @vitest-environment jsdom
//
// Watch-party composer — the people picker (2026-08).
//
// The picker used to render every account on the server the moment the modal
// opened: a scrolling wall of names in front of a host who wanted to invite
// one person, growing with every member added. It's search-first now — it
// lists nobody until the query is long enough to mean something specific.
//
// The ranking itself is asserted in lib/partyInvites.test.ts. What's tested
// here is the part a user would notice: that the list is genuinely gone until
// they type, that a short query still shows nothing, and — the failure this
// shape invites — that people already picked stay visible and stay in the
// payload once the query that found them is gone.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PartyComposerModal, type PartyComposerLaunch } from './PartyComposerModal'
import type { MemberSummary } from '@/lib/api'

const ROSTER: MemberSummary[] = [
  { user_id: 1, username: 'ronnie', display_name: 'Ronnie', is_following: true },
  { user_id: 2, username: 'samir', display_name: 'Samir P', is_following: false },
  { user_id: 3, username: 'sammy', display_name: 'Sammy', is_following: true },
  { user_id: 4, username: 'kass', display_name: 'Kass', is_following: false },
]

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, listMembers: vi.fn(async () => ROSTER) }
})

// The share card the booked state hands off to renders a canvas; nothing here
// books a party, but the import chain is stubbed so jsdom's missing canvas
// APIs can't turn a picker test into a rendering failure.
vi.mock('./PartyShareCardModal', () => ({
  PartyShareCardModal: () => null,
}))

// Typed so the payload assertions below read mock.calls without casting —
// what onLaunch receives IS the deliverable of this screen.
type LaunchFn = (launch: PartyComposerLaunch) => Promise<{ ok: boolean }>

function renderComposer(onLaunch = vi.fn<LaunchFn>(async () => ({ ok: true }))) {
  render(
    <PartyComposerModal
      mediaTitle="The Haunted Mansion"
      mediaType="movie"
      currentUsername="miles"
      onClose={vi.fn()}
      onLaunch={onLaunch}
    />,
  )
  return onLaunch
}

// Every member row renders its handle as "@name"; the chips and the CTA don't.
const memberRow = (username: string) => screen.queryByText(new RegExp(`^@${username}\\b`))

describe('PartyComposerModal people picker', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('lists nobody on open, however many members exist', async () => {
    renderComposer()
    // Wait for the roster fetch to land — the point is that it lands and
    // STILL nothing is listed.
    await screen.findByText(/Type at least 3 letters/i)
    for (const m of ROSTER) {
      expect(memberRow(m.username)).toBeNull()
    }
  })

  it('still lists nobody below the threshold', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')
    await userEvent.type(box, 'sa')
    expect(memberRow('samir')).toBeNull()
    expect(memberRow('sammy')).toBeNull()
    expect(screen.getByText(/Type at least 3 letters/i)).toBeInTheDocument()
  })

  it('shows the matches once the query is long enough, and only the matches', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')
    await userEvent.type(box, 'sam')

    expect(memberRow('samir')).not.toBeNull()
    expect(memberRow('sammy')).not.toBeNull()
    // Non-matching members stay out of it — this is a search, not a filter
    // over a list that was already on screen.
    expect(memberRow('ronnie')).toBeNull()
    expect(memberRow('kass')).toBeNull()
  })

  it('says so when nothing matches, rather than falling back to everyone', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')
    await userEvent.type(box, 'zzz')

    expect(screen.getByText(/No members match/i)).toBeInTheDocument()
    for (const m of ROSTER) {
      expect(memberRow(m.username)).toBeNull()
    }
  })

  // The regression this design invites: results are transient, so if the
  // chip row didn't exist, clearing the box would erase all evidence of who
  // you'd invited while quietly keeping them in the payload.
  it('keeps picked people visible after the query that found them is gone', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')

    await userEvent.type(box, 'sammy')
    await userEvent.click(screen.getByRole('button', { name: /@sammy/ }))

    // Picking clears the box so the next name can be typed straight away.
    expect(box).toHaveValue('')
    expect(memberRow('sammy')).toBeNull() // the RESULT row is gone…
    // …but the person is still on screen, and still counted.
    expect(screen.getByRole('button', { name: /Remove Sammy/i })).toBeInTheDocument()
    expect(screen.getByText('1 invited')).toBeInTheDocument()
  })

  it('sends everyone picked across separate searches', async () => {
    const onLaunch = renderComposer()
    const box = await screen.findByLabelText('Search members by name')

    await userEvent.type(box, 'sammy')
    await userEvent.click(screen.getByRole('button', { name: /@sammy/ }))
    await userEvent.type(box, 'kass')
    await userEvent.click(screen.getByRole('button', { name: /@kass/ }))

    await userEvent.click(screen.getByRole('button', { name: /Start party & send invites/i }))

    expect(onLaunch).toHaveBeenCalledTimes(1)
    const launch = onLaunch.mock.calls[0][0]
    expect([...launch.usernames].sort()).toEqual(['kass', 'sammy'])
  })

  it('drops someone removed via their chip', async () => {
    const onLaunch = renderComposer()
    const box = await screen.findByLabelText('Search members by name')

    await userEvent.type(box, 'sammy')
    await userEvent.click(screen.getByRole('button', { name: /@sammy/ }))
    await userEvent.click(screen.getByRole('button', { name: /Remove Sammy/i }))

    expect(screen.queryByText('1 invited')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /^Start party$/i }))
    const launch = onLaunch.mock.calls[0][0]
    expect(launch.usernames).toEqual([])
  })
})
