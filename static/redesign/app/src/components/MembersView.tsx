// MembersView — the member directory (/members, social phase 2): everyone on
// this server, with follow/unfollow. This is how you find someone to follow;
// reached from the avatar dropdown's Members row and from profile pages.
//
// Self-contained like UserProfileView: fetches its own list, keeps follow
// state locally with optimistic flips (roll back on error). Card click goes
// to the member's profile via onOpenMember (App navigates — same reason
// SettingsView doesn't own routing either).

import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import { followMember, listMembers, unfollowMember, type MemberSummary } from '@/lib/api'

export default function MembersView({ onOpenMember, currentUsername, onToast }: {
  onOpenMember: (username: string) => void
  /** Signed-in user's username — their own card links but never offers a
   *  follow button (self-follows are a server-side 400). */
  currentUsername?: string
  onToast?: (message: string, type?: 'success' | 'error' | 'info') => void
}) {
  const [members, setMembers] = useState<MemberSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // usernames with an in-flight follow/unfollow — debounces double-clicks.
  const [busy, setBusy] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    listMembers()
      .then(m => { if (!cancelled) setMembers(m) })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load members')
      })
    return () => { cancelled = true }
  }, [])

  const toggleFollow = async (m: MemberSummary) => {
    if (busy.has(m.username)) return
    setBusy(prev => new Set(prev).add(m.username))
    const next = !m.is_following
    // Optimistic flip; roll back on error.
    setMembers(list => list?.map(x => x.username === m.username ? { ...x, is_following: next } : x) ?? null)
    try {
      await (next ? followMember(m.username) : unfollowMember(m.username))
    } catch (e) {
      setMembers(list => list?.map(x => x.username === m.username ? { ...x, is_following: !next } : x) ?? null)
      onToast?.(e instanceof Error ? e.message : 'Failed to update follow', 'error')
    } finally {
      setBusy(prev => {
        const s = new Set(prev)
        s.delete(m.username)
        return s
      })
    }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader title="Members" sub="Everyone on this server. Follow someone to see what they finish." />

      {error && <p role="alert" className="rounded-control bg-surface-raised p-6 text-[15px] text-ink">{error}</p>}
      {!error && !members && <p className="py-16 text-center text-sm text-ink-2">Loading members…</p>}
      {!error && members && members.length === 0 && <p className="py-16 text-center text-sm text-ink-2">Nobody else is on this server yet.</p>}
      {!error && members && members.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {members.map(m => {
            const isMe = !!currentUsername && m.username.toLowerCase() === currentUsername.toLowerCase()
            const shownName = m.display_name || m.username
            return (
              <li key={m.user_id} className="flex min-h-[76px] items-center gap-3 rounded-control bg-surface-raised p-3.5">
                <button
                  type="button"
                  onClick={() => onOpenMember(m.username)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-control text-left"
                >
                  <ProfileAvatar avatarUrl={m.avatar_url} name={shownName} memberKey={m.user_id} size={48} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold text-ink">{shownName}{isMe && <span className="font-normal text-ink-2"> (you)</span>}</span>
                    <span className="block truncate text-[13px] text-ink-2">@{m.username}</span>
                  </span>
                </button>
                {!isMe && (
                  // No aria-pressed: the label itself carries the state
                  // (see the member page's follow button).
                  <button
                    type="button"
                    onClick={() => toggleFollow(m)}
                    disabled={busy.has(m.username)}
                    className={`stage-btn flex-none px-4 ${m.is_following ? 'stage-btn-ghost is-on' : 'stage-btn-outline'}`}
                  >
                    {m.is_following ? 'Following' : 'Follow'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
