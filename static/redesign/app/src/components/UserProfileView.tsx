// UserProfileView — a member's profile page (/user/:username). Social phase 1.
//
// Self-contained: fetches GET /api/members/:username itself, so deep links,
// refresh, and back/forward all hydrate without App owning more state — App
// only parses the username out of the URL and threads onSelect so clicking a
// recent-watch card runs the same → /title/:id flow every rail uses.
//
// Privacy surface notes (mirror the server contract in social_handlers.go):
// history_visible === false means the member keeps their watch history
// private — render a quiet line, not an empty rail. is_me && sharing off
// still shows the strip (the server sends it) with an "only you can see
// this" subtitle, so your own page is an exact preview of what opting in
// would reveal.

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { MediaRail } from '@/components/MediaRail'
import { PageHeader } from '@/components/PageHeader'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import {
  backdropURL,
  followMember,
  getMemberProfile,
  listMemberFollowers,
  listMemberFollowing,
  posterURL,
  unfollowMember,
  type MemberProfileResponse,
  type MemberRecentWatch,
  type MemberSummary,
} from '@/lib/api'
import { SOCIAL_NETWORKS, socialUrl } from '@/lib/socialLinks'
import { type Media } from '@/lib/types'

function mapWatchToMedia(w: MemberRecentWatch): Media {
  return {
    id: w.id,
    title: w.title,
    year: w.year || 0,
    rating: w.rating || 0,
    duration: '',
    genre: '',
    type: w.type === 'show' ? 'show' : 'movie',
    poster: posterURL(w.poster_path),
    backdrop: backdropURL(w.backdrop_path, 'w780'),
    description: '',
  }
}

// watchedAgo — compact relative label for the card subtitle ("today",
// "3d ago", "2w ago", then a plain month+year). Local rather than shared:
// the admin chunk's timeAgo lives in the lazy admin bundle, and pulling it
// into a shared leaf for one label isn't worth the coupling.
function watchedAgo(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const days = Math.floor((Date.now() - t) / 86_400_000)
  if (days <= 0) return 'Watched today'
  if (days === 1) return 'Watched yesterday'
  if (days < 7) return `Watched ${days}d ago`
  if (days < 30) return `Watched ${Math.floor(days / 7)}w ago`
  return 'Watched ' + new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

export default function UserProfileView({ username, onSelect, onCardContext, onOpenMember }: {
  username: string
  onSelect: (m: Media) => void
  // The card menu (right click, More, a long press), required by every
  // surface that renders a card: see MediaCardCinema.
  onCardContext: (e: MouseEvent, m: Media) => void
  /** Navigate to another member's profile (follower/following rows). */
  onOpenMember?: (username: string) => void
}) {
  const [resp, setResp] = useState<MemberProfileResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Follow state lives locally once loaded so the button + count flip
  // optimistically; server truth re-arrives on any refetch.
  const [isFollowing, setIsFollowing] = useState(false)
  const [followerCount, setFollowerCount] = useState(0)
  const [followBusy, setFollowBusy] = useState(false)
  // Which connections list is expanded, and its rows (fetched on expand).
  const [expanded, setExpanded] = useState<'followers' | 'following' | null>(null)
  const [connections, setConnections] = useState<MemberSummary[] | null>(null)
  const [connError, setConnError] = useState(false)
  // Monotonic token: only the LATEST expand's response may render, so a
  // slow followers fetch can't land under the Following heading after a
  // quick flip (PR-429 review). Cross-profile staleness is handled by the
  // key={username} remount at the call site.
  const connSeqRef = useRef(0)

  const toggleFollow = async () => {
    if (followBusy || !resp) return
    setFollowBusy(true)
    const next = !isFollowing
    setIsFollowing(next)
    setFollowerCount(c => c + (next ? 1 : -1))
    try {
      await (next ? followMember(username) : unfollowMember(username))
    } catch {
      setIsFollowing(!next)
      setFollowerCount(c => c + (next ? -1 : 1))
    } finally {
      setFollowBusy(false)
    }
  }

  const toggleConnections = (which: 'followers' | 'following') => {
    if (expanded === which) {
      setExpanded(null)
      return
    }
    const seq = ++connSeqRef.current
    setExpanded(which)
    setConnections(null)
    setConnError(false)
    const fetcher = which === 'followers' ? listMemberFollowers : listMemberFollowing
    fetcher(username)
      .then(list => { if (connSeqRef.current === seq) setConnections(list) })
      .catch(() => {
        if (connSeqRef.current === seq) {
          setConnections([])
          setConnError(true)
        }
      })
  }

  useEffect(() => {
    let cancelled = false
    setResp(null)
    setError(null)
    setExpanded(null)
    setConnections(null)
    // Same issue-#261 contract handleSelect follows: a profile opened from
    // a scrolled page must start at the top. Instant, not smooth — the
    // content is being replaced.
    window.scrollTo({ top: 0, behavior: 'auto' })
    getMemberProfile(username)
      .then(r => {
        if (cancelled) return
        setResp(r)
        setIsFollowing(r.is_following)
        setFollowerCount(r.follower_count)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        // apiFetch surfaces the server's message ("member not found") —
        // show it rather than a generic failure so a dead link reads as
        // exactly that.
        setError(e instanceof Error ? e.message : 'Failed to load profile')
      })
    return () => { cancelled = true }
  }, [username])

  if (error) {
    return (
      <div className="animate-fade-in">
        <div role="alert" className="rounded-control bg-surface-raised p-6">
          <p className="text-[15px] font-semibold text-ink">{error}</p>
          {/* The hint about the link only makes sense for a 404: under a
              500 it would blame the URL for a server problem. */}
          {error.toLowerCase().includes('not found') && (
            <p className="mt-1 text-[13px] text-ink-2">Check the link: member pages live at /user/&lt;username&gt;.</p>
          )}
        </div>
      </div>
    )
  }
  if (!resp) {
    return (
      <div className="animate-fade-in">
        <p className="py-16 text-center text-sm text-ink-2">Loading the page…</p>
      </div>
    )
  }

  const { profile, is_me: isMe, history_visible: historyVisible, recent_watches: watches } = resp
  const shownName = profile.display_name || profile.username
  // UTC, not local: the server truncates member_since to Jan-1 UTC, so a
  // viewer west of UTC would read local getFullYear() as the prior year.
  const memberYear = new Date(profile.member_since).getUTCFullYear()
  const socials = SOCIAL_NETWORKS
    .map(n => ({ n, handle: profile[n.key] }))
    .filter((s): s is { n: typeof s.n; handle: string } => !!s.handle)
  // Keyed by media id for MediaRail's per-card subtitle resolver.
  const watchedAt: Record<number, string> = {}
  for (const w of watches) watchedAt[w.id] = watchedAgo(w.watched_at)

  return (
    <div className="animate-fade-in">
      <PageHeader title={shownName} sub={isMe ? 'Your member page' : 'Member page'} />

      <div className="rounded-control bg-surface-raised p-5 md:p-7">
        <div className="flex flex-col items-start gap-5 sm:flex-row">
          <ProfileAvatar avatarUrl={profile.avatar_url} name={shownName} memberKey={profile.user_id} size={96} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-4">
              <h2 className="truncate font-display text-[22px] font-semibold text-ink">{shownName}</h2>
              {!isMe && (
                // No aria-pressed: the accessible name itself flips
                // (Follow/Following), and pairing both makes a screen
                // reader announce the state twice.
                <button
                  type="button"
                  onClick={toggleFollow}
                  disabled={followBusy}
                  className={`stage-btn flex-none ${isFollowing ? 'stage-btn-ghost is-on' : 'stage-btn-primary'}`}
                >
                  {isFollowing ? 'Following' : 'Follow'}
                </button>
              )}
            </div>
            <p className="mt-0.5 text-sm text-ink-2">
              @{profile.username} &middot; Member since {Number.isNaN(memberYear) ? 'an unknown year' : memberYear}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-1 text-sm">
              <button
                type="button"
                onClick={() => toggleConnections('followers')}
                aria-expanded={expanded === 'followers'}
                aria-controls="member-connections"
                className="-ml-2 min-h-11 rounded-control px-2 text-ink-2 transition-colors hover:text-ink"
              >
                <span className="font-semibold tabular-nums text-ink">{followerCount}</span> follower{followerCount === 1 ? '' : 's'}
              </button>
              <button
                type="button"
                onClick={() => toggleConnections('following')}
                aria-expanded={expanded === 'following'}
                aria-controls="member-connections"
                className="min-h-11 rounded-control px-2 text-ink-2 transition-colors hover:text-ink"
              >
                <span className="font-semibold tabular-nums text-ink">{resp.following_count}</span> following
              </button>
            </div>
            {profile.bio && (
              // whitespace-pre-line: the bio is the one field with line
              // breaks (the server keeps them). break-words: it is written
              // by a member, and a 500-character unbroken token (a pasted
              // URL) must wrap instead of scrolling the page sideways.
              <p className="mt-2 max-w-2xl whitespace-pre-line break-words text-[15px] leading-relaxed text-ink">{profile.bio}</p>
            )}
            {socials.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {socials.map(({ n, handle }) => (
                  <a
                    key={n.key}
                    href={socialUrl(n, handle)}
                    // An outside address a member supplied (a handle of a
                    // checked shape on a fixed domain): it never runs here.
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-surface-raised-2 px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-action-soft"
                  >
                    {n.label}
                    {/* Facebook handles run to 60 characters: capped so one
                        long handle cannot overflow a phone. */}
                    <span className="inline-block max-w-[18ch] truncate font-normal text-ink-2">@{handle}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        {expanded && (
          <div id="member-connections" className="mt-5 border-t border-line pt-5">
            <p className="mb-3 text-xs font-semibold text-ink-2">
              {expanded === 'followers' ? 'Followers' : 'Following'}
            </p>
            {connections === null && <p className="text-sm text-ink-2">Loading…</p>}
            {connections !== null && connections.length === 0 && (
              // A failed request must not pass for an empty list.
              <p className="text-sm text-ink-2">
                {connError
                  ? 'This list could not be loaded. Try again.'
                  : expanded === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}
              </p>
            )}
            {connections !== null && connections.length > 0 && (
              <div className="grid gap-1 sm:grid-cols-2">
                {connections.map(m => (
                  <button
                    key={m.user_id}
                    type="button"
                    onClick={() => onOpenMember?.(m.username)}
                    className="flex min-h-11 min-w-0 items-center gap-3 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-surface-raised-2"
                  >
                    <ProfileAvatar avatarUrl={m.avatar_url} name={m.display_name || m.username} memberKey={m.user_id} size={32} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-ink">{m.display_name || m.username}</span>
                      <span className="block truncate text-xs text-ink-2">@{m.username}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-8">
        {historyVisible ? (
          watches.length > 0 ? (
            <MediaRail
              title="Recently finished"
              subtitle={isMe
                ? (!profile.share_watch_history
                    ? 'Only you can see this: sharing is off on your profile page'
                    : 'Finished titles only. What is in progress stays in Continue Watching')
                : undefined}
              items={watches.map(mapWatchToMedia)}
              aspect="poster"
              onSelect={onSelect}
              onCardContext={onCardContext}
              cardSubtitleFor={m => watchedAt[m.id]}
            />
          ) : (
            <p className="text-sm text-ink-2">
              {isMe
                ? 'Nothing finished yet. Titles show here once you finish them; what is in progress stays in Continue Watching.'
                : 'No finished titles yet.'}
            </p>
          )
        ) : (
          <p className="text-sm text-ink-2">
            {isMe
              // The server hides the strip from a profile with a content
              // limit: it is the account default's history, not this one's.
              ? 'This account’s watch history isn’t shown to profiles with a content limit.'
              : `${shownName} keeps their watch history private.`}
          </p>
        )}
      </div>
    </div>
  )
}
