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

import { useEffect, useState } from 'react'
import { Icon } from '@/components/Icon'
import { MediaRail } from '@/components/MediaRail'
import { PageHeader } from '@/components/PageHeader'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import {
  backdropURL,
  getMemberProfile,
  posterURL,
  type MemberProfileResponse,
  type MemberRecentWatch,
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
    backdrop: backdropURL(w.backdrop_path),
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

export default function UserProfileView({ username, onSelect }: {
  username: string
  onSelect: (m: Media) => void
}) {
  const [resp, setResp] = useState<MemberProfileResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setResp(null)
    setError(null)
    // Same issue-#261 contract handleSelect follows: a profile opened from
    // a scrolled page must start at the top. Instant, not smooth — the
    // content is being replaced.
    window.scrollTo({ top: 0, behavior: 'auto' })
    getMemberProfile(username)
      .then(r => { if (!cancelled) setResp(r) })
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
        <div className="glass-panel rounded-2xl p-8 text-center">
          <Icon name="user" size={28} className="text-white/25 mx-auto" />
          <p className="text-white/80 text-sm font-medium mt-3">{error}</p>
          {/* The link hint only makes sense for a 404 — under a 500 it
              would blame the URL for a server problem. */}
          {error.toLowerCase().includes('not found') && (
            <p className="text-white/40 text-xs mt-1">Check the link — profiles live at /user/&lt;username&gt;.</p>
          )}
        </div>
      </div>
    )
  }
  if (!resp) {
    return (
      <div className="animate-fade-in">
        <p className="text-white/40 text-sm py-16 text-center">Loading profile…</p>
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
      <PageHeader title={shownName} sub={isMe ? 'Your member profile' : 'Member profile'} />

      <div className="glass-panel rounded-2xl p-6 md:p-8">
        <div className="flex flex-col sm:flex-row gap-6 items-start">
          <ProfileAvatar avatarUrl={profile.avatar_url} name={shownName} size={96} />
          <div className="min-w-0 flex-1">
            <h2 className="text-white text-xl font-semibold truncate">{shownName}</h2>
            <p className="text-white/40 text-sm mt-0.5">
              @{profile.username} &middot; Member since {Number.isNaN(memberYear) ? '—' : memberYear}
            </p>
            {profile.bio && (
              // whitespace-pre-line: the bio is the one multi-line profile
              // field (the server preserves its newlines). break-words:
              // member-authored text — a 500-char unbroken token (pasted
              // URL) must wrap instead of forcing horizontal scroll.
              <p className="text-white/70 text-sm mt-3 max-w-2xl whitespace-pre-line break-words">{profile.bio}</p>
            )}
            {socials.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {socials.map(({ n, handle }) => (
                  <a
                    key={n.key}
                    href={socialUrl(n, handle)}
                    // External, user-supplied destination (shape-validated
                    // handle on a fixed domain) — never runs in our context.
                    target="_blank"
                    rel="noopener noreferrer"
                    className="badge-glass inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-white/75 hover:text-white transition-colors"
                  >
                    <Icon name="globe" size={12} className="text-white/40" />
                    {n.label}
                    {/* Facebook handles run to 60 chars — cap the chip so
                        one long handle can't overflow a phone viewport. */}
                    <span className="text-white/35 inline-block max-w-[18ch] truncate">@{handle}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-8">
        {historyVisible ? (
          watches.length > 0 ? (
            <MediaRail
              title="Recently Watched"
              subtitle={isMe && !profile.share_watch_history
                ? 'Only you can see this — sharing is off in Settings'
                : undefined}
              items={watches.map(mapWatchToMedia)}
              aspect="poster"
              onSelect={onSelect}
              cardSubtitleFor={m => watchedAt[m.id]}
            />
          ) : (
            <p className="text-white/40 text-sm">
              {isMe ? 'Nothing completed yet — finished titles show up here.' : 'No completed titles yet.'}
            </p>
          )
        ) : (
          <p className="text-white/40 text-sm flex items-center gap-2">
            <Icon name="eye" size={14} className="text-white/25" />
            {shownName} keeps their watch history private.
          </p>
        )}
      </div>
    </div>
  )
}
