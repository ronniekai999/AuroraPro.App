// @vitest-environment jsdom
//
// Tonight's "Happening now" strip: a party that is running and an invitation
// nobody has answered, above the first rail.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TonightLive, tonightLiveRows } from './TonightLive'
import type { ActiveParty, MyPartyInvite } from '@/lib/api'

const NOW = new Date('2026-11-11T18:00:00')
const party = (over: Partial<ActiveParty> = {}): ActiveParty => ({
  code: 'MOON42', host_user_id: 2, party_name: 'Friday crew', media_title: 'Night Train to Meridian', media_poster: '',
  participant_count: 3, max_participants: 0, is_playing: true, started_at: '2026-11-11T17:20:00Z', ...over,
})
const invite = (over: Partial<MyPartyInvite> = {}): MyPartyInvite => ({
  invite_id: 7, party_code: 'KEST88', media_title: 'Kestrel', host_username: 'Jonah', rsvp: 'pending',
  scheduled_start_at: '2026-11-12T20:00:00', started_at: null, created_at: '2026-11-10T12:00:00Z', ...over,
})

afterEach(cleanup)

describe('what the strip lists', () => {
  it('lists parties someone else is running, most watched first, and not a booked one that has not started', () => {
    const rows = tonightLiveRows([
      party({ code: 'A', participant_count: 2 }),
      party({ code: 'B', participant_count: 5 }),
      party({ code: 'C', scheduled_start_at: '2026-11-12T20:00:00Z', started_at: null }),
    ], null, 1)
    expect(rows.live.map(p => p.code)).toEqual(['B', 'A'])
  })

  it('does not offer the viewer their own party to join', () => {
    expect(tonightLiveRows([party({ host_user_id: 1 })], null, 1).live).toEqual([])
  })

  it('lists invitations not yet answered, and none that were', () => {
    const rows = tonightLiveRows([], [
      invite({ invite_id: 1 }), invite({ invite_id: 2, rsvp: 'going' }), invite({ invite_id: 3, rsvp: 'maybe' }), invite({ invite_id: 4, rsvp: 'declined' }),
    ], 1)
    expect(rows.pending.map(i => i.invite_id)).toEqual([1])
  })

  it('shows a party once when the viewer is also invited to it', () => {
    const rows = tonightLiveRows([party({ code: 'SAME' })], [invite({ party_code: 'SAME' })], 1)
    expect(rows.live).toHaveLength(1)
    expect(rows.pending).toEqual([])
  })
})

describe('the strip', () => {
  const props = { currentUserId: 1, onJoin: () => {}, onRsvp: () => {}, now: NOW }

  it('draws nothing when nothing is happening', () => {
    const { container } = render(<TonightLive {...props} parties={[]} invites={[]} />)
    expect(container.firstChild).toBeNull()
    cleanup()
    // Invitations still loading are nothing yet, not an empty panel.
    expect(render(<TonightLive {...props} parties={[]} invites={null} />).container.firstChild).toBeNull()
  })

  it('says who is watching what, live, and joins on a press', () => {
    const onJoin = vi.fn()
    render(<TonightLive {...props} onJoin={onJoin} parties={[party()]} invites={[]} />)
    const strip = screen.getByRole('region', { name: 'Happening now' })
    expect(strip.textContent).toContain('3 watching Night Train to Meridian')
    expect(strip.textContent).toContain('Live now · Friday crew')
    fireEvent.click(within(strip).getByRole('button', { name: 'Join the party watching Night Train to Meridian' }))
    expect(onJoin).toHaveBeenCalledWith('MOON42')
  })

  it('opens, rather than joins, the party this session is already in', () => {
    render(<TonightLive {...props} parties={[party()]} invites={[]} inPartyCode="MOON42" />)
    expect(screen.getByRole('button', { name: 'Open the party watching Night Train to Meridian' }).textContent).toBe('Open')
  })

  it('names a party with no title by its own name, without repeating it', () => {
    render(<TonightLive {...props} parties={[party({ media_title: '', party_name: 'Friday crew' })]} invites={[]} />)
    const strip = screen.getByRole('region', { name: 'Happening now' })
    expect(strip.textContent).toContain('3 watching Friday crew')
    expect(strip.textContent).not.toContain('Live now · Friday crew')
  })

  it('offers an invitation its answers and its lobby', () => {
    const onRsvp = vi.fn()
    const onJoin = vi.fn()
    render(<TonightLive {...props} onRsvp={onRsvp} onJoin={onJoin} parties={[]} invites={[invite()]} />)
    const strip = screen.getByRole('region', { name: 'Happening now' })
    expect(strip.textContent).toContain('Jonah invited you to watch Kestrel')
    expect(strip.textContent).toContain('Tomorrow')
    fireEvent.click(within(strip).getByRole('button', { name: "I'm in" }))
    expect(onRsvp).toHaveBeenLastCalledWith(7, 'going')
    fireEvent.click(within(strip).getByRole('button', { name: 'Maybe' }))
    expect(onRsvp).toHaveBeenLastCalledWith(7, 'maybe')
    fireEvent.click(within(strip).getByRole('button', { name: 'Open the lobby for Kestrel' }))
    expect(onJoin).toHaveBeenCalledWith('KEST88')
  })

  // An invitation is listed while its party is held, and a party is held for
  // a while past a planned time it did not start at.
  it('does not give a planned time that has passed as one still to come', () => {
    const line = (id: number) => document.querySelector(`[data-live-invite="${id}"] .tonight-live-sub`)!.textContent
    render(<TonightLive {...props} parties={[]} invites={[
      invite({ invite_id: 1, scheduled_start_at: '2026-11-11T10:00:00' }),
      invite({ invite_id: 2, party_code: 'OTHR22', scheduled_start_at: '2026-11-11T17:59:00', party_name: 'Film club' }),
      invite({ invite_id: 3, party_code: 'SOON33', scheduled_start_at: '2026-11-11T20:00:00' }),
      invite({ invite_id: 4, party_code: 'NOON44', scheduled_start_at: '2026-11-12T09:00:00' }),
    ]} />)
    expect(line(1)).toBe('Was planned for Today · 10:00 AM')
    expect(line(2)).toBe('Was planned for Tonight · 5:59 PM · Film club')
    // To come: the time alone, and a morning is not "Tonight".
    expect(line(3)).toBe('Tonight · 8:00 PM')
    expect(line(4)).toBe('Tomorrow · 9:00 AM')
  })

  // A party's poster is stored as a bare image path ("abc.jpg"), not an
  // address: used as the picture's source it asked the app's own origin for
  // a page that is no picture, and the box stayed empty.
  it("asks the image proxy for an invitation's poster, whether or not the stored path has a leading slash", () => {
    render(<TonightLive {...props} parties={[]} invites={[
      invite({ invite_id: 1, media_poster: 'abc.jpg' }),
      invite({ invite_id: 2, party_code: 'OTHR22', media_poster: '/def.jpg' }),
      invite({ invite_id: 3, party_code: 'NONE33', media_poster: '' }),
    ]} />)
    const strip = screen.getByRole('region', { name: 'Happening now' })
    expect([...strip.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual([
      '/api/images/w154/abc.jpg', '/api/images/w154/def.jpg',
    ])
  })

  it('says an invitation whose party has started is live, and offers to join it', () => {
    render(<TonightLive {...props} parties={[]} invites={[invite({ started_at: '2026-11-11T17:00:00Z' })]} />)
    const strip = screen.getByRole('region', { name: 'Happening now' })
    expect(strip.textContent).toContain('Live now')
    expect(within(strip).getByRole('button', { name: 'Join Kestrel' })).toBeTruthy()
  })
})
