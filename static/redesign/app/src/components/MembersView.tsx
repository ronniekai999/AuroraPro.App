// MembersView — the member directory (/members, social phase 2): everyone on
// this server, with follow/unfollow. This is how you find someone to follow;
// reached from the avatar dropdown's Members row and from profile pages.
//
// Self-contained like UserProfileView: fetches its own list, keeps follow
// state locally with optimistic flips (roll back on error). Card click goes
// to the member's profile via onOpenMember (App navigates — same reason
// SettingsView doesn't own routing either).

import { useEffect, useState } from 'react'
import { Icon } from '@/components/Icon'
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
      <PageHeader title="Members" sub="Everyone on this server — follow someone to see what they watch on your home screen" />

      {error && (
        <div className="glass-panel rounded-2xl p-8 text-center">
          <Icon name="users" size={28} className="text-white/25 mx-auto" />
          <p className="text-white/80 text-sm font-medium mt-3">{error}</p>
        </div>
      )}
      {!error && !members && <p className="text-white/40 text-sm py-16 text-center">Loading members…</p>}
      {!error && members && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {members.map(m => {
            const isMe = !!currentUsername && m.username.toLowerCase() === currentUsername.toLowerCase()
            const shownName = m.display_name || m.username
            return (
              <div key={m.user_id} className="glass-panel rounded-2xl p-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onOpenMember(m.username)}
                  className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-lg"
                >
                  <ProfileAvatar avatarUrl={m.avatar_url} name={shownName} size={48} />
                  <span className="min-w-0">
                    <span className="block text-white text-sm font-medium truncate">{shownName}{isMe && <span className="text-white/35 font-normal"> (you)</span>}</span>
                    <span className="block text-white/40 text-xs truncate">@{m.username}</span>
                  </span>
                </button>
                {!isMe && (
                  // No aria-pressed — the label itself carries the state
                  // (see the profile page's follow button).
                  <button
                    type="button"
                    onClick={() => toggleFollow(m)}
                    disabled={busy.has(m.username)}
                    className={`flex-none px-3 py-1.5 rounded-lg text-xs border transition-colors disabled:opacity-50 ${
                      m.is_following
                        ? 'bg-purple-500/15 hover:bg-purple-500/25 border-purple-500/40 text-purple-200'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.08] text-white/70'
                    }`}
                  >
                    {m.is_following ? 'Following' : 'Follow'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
