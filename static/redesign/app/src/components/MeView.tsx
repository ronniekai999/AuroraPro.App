// "Me": the account page behind the phone tab bar's last tab. On a phone
// there is no room for the top bar's identity menu, so the same things live
// here as a page: who is watching, a row to switch profile, and the account
// links. What a session is offered follows navScope and adminUI, exactly as
// the identity menu does.

import { Icon } from '@/components/Icon'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import type { Profile, User as ApiUser } from '@/lib/api'
import { profileSummary, type NavScope } from '@/lib/navScope'

export interface MeViewProps {
  user: ApiUser
  navScope: NavScope
  adminUI: boolean
  profiles: Profile[]
  /** The profile the server has bound to this session, or null. */
  activeProfileId: number | null
  notifCount: number
  onSelectProfile: (id: number) => void
  onManageProfiles?: () => void
  onOpenNotifications: () => void
  onOpenMyProfile?: () => void
  onOpenRequests?: () => void
  /** "My requests", or "Requests" for a session that is listed everyone's. */
  requestsLabel?: string
  onOpenSettings: () => void
  onOpenAdmin: () => void
  onOpenServer: () => void
  onSignOut: () => void
}

export default function MeView({
  user, navScope, adminUI, profiles, activeProfileId, notifCount,
  onSelectProfile, onManageProfiles, onOpenNotifications,
  onOpenMyProfile, onOpenRequests, requestsLabel = 'My requests', onOpenSettings, onOpenAdmin, onOpenServer, onSignOut,
}: MeViewProps) {
  const active = profiles.find(p => p.id === activeProfileId) ?? null
  const others = profiles.filter(p => p.id !== activeProfileId)
  const full = navScope === 'full'
  const limit = (p: Profile) => p.max_age_rating?.trim()

  const rows: { key: string; label: string; icon: string; onClick: () => void; badge?: number; note?: string }[] = [
    { key: 'notifications', label: 'Notifications', icon: 'bell', onClick: onOpenNotifications, badge: notifCount },
    ...(full && onOpenMyProfile ? [{ key: 'profile', label: 'Your profile', icon: 'user', onClick: onOpenMyProfile }] : []),
    ...(full && onOpenRequests ? [{ key: 'requests', label: requestsLabel, icon: 'download', onClick: onOpenRequests }] : []),
    { key: 'settings', label: 'Settings', icon: 'settings', onClick: onOpenSettings },
    ...(adminUI ? [
      { key: 'admin', label: 'Admin', icon: 'shield', onClick: onOpenAdmin },
      { key: 'server', label: 'Server status', icon: 'server', onClick: onOpenServer },
    ] : []),
    // The server's logout ends every session on the account, on every
    // device; there is no per-device sign-out, and the row must not imply one.
    { key: 'signout', label: 'Sign out', icon: 'log-out', onClick: onSignOut, note: 'Signs out every device on this account' },
  ]

  return (
    <div className="mx-auto max-w-[560px] animate-fade-in">
      <header className="flex items-center gap-3.5 pt-2">
        <ProfileAvatar avatarUrl={active?.avatar_url} name={active?.name ?? user.username} colorKey={active?.id} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-[28px] font-bold leading-tight tracking-[-0.015em] text-ink">{active?.name ?? user.username}</h1>
          <p className="truncate text-[13px] text-ink-2">{active ? profileSummary(active) : `Signed in as ${user.username}`}</p>
        </div>
      </header>

      {(others.length > 0 || (full && onManageProfiles)) && (
        <section aria-label="Switch profile" className="mt-5 flex items-stretch gap-2 overflow-x-auto rounded-control bg-surface-raised p-3">
          {others.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelectProfile(p.id)}
              aria-label={`Switch to ${p.name}${limit(p) ? `, up to ${limit(p)}` : ''}${p.has_pin ? ', locked with a PIN' : ''}`}
              className="flex min-h-16 min-w-[64px] flex-1 flex-col items-center justify-start gap-1 rounded-art px-1 py-1.5 text-center text-xs leading-tight text-ink-2 transition-colors hover:bg-white/[0.08]"
            >
              <ProfileAvatar avatarUrl={p.avatar_url} name={p.name} colorKey={p.id} size={36} />
              <span className="line-clamp-2 max-w-full break-words">{p.name}{limit(p) ? ` · ${limit(p)}` : ''}</span>
            </button>
          ))}
          {full && onManageProfiles && (
            <button
              type="button"
              onClick={onManageProfiles}
              className="flex min-h-16 min-w-[64px] flex-1 flex-col items-center justify-start gap-1 rounded-art px-1 py-1.5 text-center text-xs leading-tight text-ink-2 transition-colors hover:bg-white/[0.08]"
            >
              <span className="grid h-9 w-9 place-items-center rounded-full border border-dashed border-line-strong"><Icon name="settings" size={16} /></span>
              <span>Manage</span>
            </button>
          )}
        </section>
      )}

      <nav aria-label="Account" className="mt-3">
        {rows.map(r => (
          <button
            key={r.key}
            type="button"
            onClick={r.onClick}
            className="flex min-h-14 w-full items-center gap-3 border-b border-line py-2 text-left text-base text-ink transition-colors last:border-b-0 hover:bg-white/[0.04]"
          >
            <Icon name={r.icon} size={20} className="flex-none text-ink-2" />
            <span className="flex-1 leading-tight">
              <span className="block">{r.label}</span>
              {r.note && <span className="block text-[13px] text-ink-2">{r.note}</span>}
            </span>
            {!!r.badge && r.badge > 0 && (
              <span className="h-[22px] min-w-[22px] rounded-full bg-action px-[7px] text-center text-[13px] font-bold leading-[22px] text-action-on">
                {r.badge > 99 ? '99+' : r.badge}<span className="sr-only"> unread</span>
              </span>
            )}
            <Icon name="chevronRight" size={16} className="flex-none text-ink-3" />
          </button>
        ))}
      </nav>
    </div>
  )
}
