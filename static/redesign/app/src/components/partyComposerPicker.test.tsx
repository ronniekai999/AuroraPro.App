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
import { listMembers, type MemberSummary } from '@/lib/api'

const ROSTER: MemberSummary[] = [
  { user_id: 1, username: 'ronnie', display_name: 'Ronnie', is_following: true },
  { user_id: 2, username: 'samir', display_name: 'Samir P', is_following: false },
  { user_id: 3, username: 'sammy', display_name: 'Sammy', is_following: true },
  { user_id: 4, username: 'kass', display_name: 'Kass', is_following: false },
  // A member the OAuth path can really produce (jd@gmail.com -> "jd"):
  // shorter than the query threshold, so a blind floor would hide them.
  { user_id: 5, username: 'jd', display_name: 'JD', is_following: false },
  // Ten matches for "dup" — more than MAX_MEMBER_RESULTS, so the cap bites.
  ...Array.from({ length: 10 }, (_, i): MemberSummary => ({
    user_id: 100 + i,
    username: `dup${String(i).padStart(2, '0')}`,
    is_following: false,
  })),
]

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, listMembers: vi.fn() }
})

// The roster is installed per-test in beforeEach rather than baked into the
// factory, so a test that needs a different one just reassigns it. (A
// `mockResolvedValueOnce` does not survive this file's `clearAllMocks`.)
const mockedListMembers = vi.mocked(listMembers)

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

// Every member row renders its handle as "@name"; the chips deliberately
// omit the "@" so this stays unique to the results list.
const memberRow = (username: string) => screen.queryByText(new RegExp(`^@${username}\\b`))

// The two sr-only live regions are distinguished by accessible name: one
// reports the search results, the other confirms picks and removals.
const resultsStatus = () => screen.getByRole('status', { name: 'Member search results' })
const guestStatus = () => screen.getByRole('status', { name: 'Guest list updates' })

describe('PartyComposerModal people picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedListMembers.mockResolvedValue(ROSTER)
  })

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

    // Echoes the query back. The copy this replaced was a bare "No members
    // match.", so asserting the quoted term is what makes this test fail
    // against the old implementation rather than pass by coincidence.
    expect(screen.getByText(/No members match “zzz”/i)).toBeInTheDocument()
    for (const m of ROSTER) {
      expect(memberRow(m.username)).toBeNull()
    }
  })

  // A blind 3-character floor locks out members the API will happily invite:
  // OAuth derives usernames from an email local-part with no length floor,
  // and 2-character CJK display names are ordinary.
  it('finds a member whose whole name is shorter than the threshold', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')
    await userEvent.type(box, 'jd')

    expect(memberRow('jd')).not.toBeNull()
    // …without that turning into "show everyone on a 2-character query".
    expect(memberRow('sammy')).toBeNull()
    expect(memberRow('samir')).toBeNull()
  })

  it('does not truncate silently — it says how many were hidden', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')
    await userEvent.type(box, 'dup')

    // 10 members match; the picker renders at most MAX_MEMBER_RESULTS.
    expect(screen.getByText(/Showing 8 of 10/i)).toBeInTheDocument()
  })

  it('says the roster is empty rather than blaming the query', async () => {
    mockedListMembers.mockResolvedValue([])
    renderComposer()

    // Exact string: the sr-only live region carries the same sentence
    // without the period, and a loose regex matches both.
    expect(await screen.findByText('Nobody else here yet.')).toBeInTheDocument()
    expect(resultsStatus()).toHaveTextContent('Nobody else here yet')
    // Not "no members match" — that would blame the query for an empty house.
    expect(screen.queryByText(/No members match/i)).toBeNull()
  })

  it('surfaces a roster fetch failure instead of reporting no matches', async () => {
    mockedListMembers.mockRejectedValue(new Error("boom"))
    renderComposer()

    expect(await screen.findByText(/Couldn't load members: boom/i)).toBeInTheDocument()
    // The live region must not tell a screen-reader user that nobody
    // matched when the truth is that we never found out.
    expect(resultsStatus()).toHaveTextContent(/Could not load members/i)
    expect(resultsStatus()).not.toHaveTextContent(/No matching members/i)
  })

  it('announces the true match count, not the rendered one', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')

    await userEvent.type(box, 'sam')
    expect(resultsStatus()).toHaveTextContent(/^2 matching members$/)

    await userEvent.clear(box)
    await userEvent.type(box, 'dup')
    expect(resultsStatus()).toHaveTextContent('10 matching members, showing 8')
  })

  // Picking clears the query, which unmounts the row whose aria-pressed
  // would have carried the confirmation — so without this announcement a
  // screen-reader user gets no signal at all that the pick landed.
  it('announces adding and removing a guest', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')

    await userEvent.type(box, 'sammy')
    await userEvent.click(screen.getByRole('button', { name: /@sammy/ }))
    expect(guestStatus()).toHaveTextContent('Sammy added to the invite list')

    await userEvent.click(screen.getByRole('button', { name: /Remove Sammy/i }))
    expect(guestStatus()).toHaveTextContent('Sammy removed from the invite list')
  })

  // The chip unmounts on click. This dialog has no focus trap, so focus
  // falling to <body> means the next Tab starts behind the dialog.
  it('keeps focus in the dialog after removing a guest chip', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')

    await userEvent.type(box, 'sammy')
    await userEvent.click(screen.getByRole('button', { name: /@sammy/ }))
    await userEvent.click(screen.getByRole('button', { name: /Remove Sammy/i }))

    expect(document.activeElement).toBe(box)
    expect(document.activeElement).not.toBe(document.body)
  })

  // Gating the loading state on the 3-char threshold told a host with a slow
  // roster fetch to "type at least 3 letters" — advice that is wrong for the
  // very members the short-name rule exists to keep reachable.
  it('says it is loading as soon as the host types, not only past the threshold', async () => {
    let release: (m: MemberSummary[]) => void = () => {}
    mockedListMembers.mockReturnValue(new Promise(res => { release = res }))
    renderComposer()

    const box = screen.getByLabelText('Search members by name')
    await userEvent.type(box, 'jd')
    expect(screen.getByText(/Loading members…/i)).toBeInTheDocument()
    expect(screen.queryByText(/Type at least 3 letters/i)).toBeNull()

    release(ROSTER)
    expect(await screen.findByText(/^@jd/)).toBeInTheDocument()
  })

  // Deselecting from the results list is the asymmetric half of pick(): the
  // query must survive so the row doesn't vanish out from under the tap.
  it('leaves the query alone when a result row is deselected', async () => {
    renderComposer()
    const box = await screen.findByLabelText('Search members by name')

    await userEvent.type(box, 'sammy')
    await userEvent.click(screen.getByRole('button', { name: /@sammy/ }))
    await userEvent.type(box, 'sammy') // box was cleared by the pick
    await userEvent.click(screen.getByRole('button', { name: /@sammy/ }))

    expect(box).toHaveValue('sammy')
    expect(memberRow('sammy')).not.toBeNull()
    expect(screen.queryByText('1 invited')).toBeNull()
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
