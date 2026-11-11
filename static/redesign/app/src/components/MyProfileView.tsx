// Your profile: who you are on this server, and the watching statistics and
// achievements that used to sit at the foot of Home. Placeholder contents;
// the props are the seam with App.

import type { Profile, User as ApiUser } from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'

export interface MyProfileViewProps {
  user: ApiUser
  /** The profile the server has bound to this session, or null. */
  activeProfile: Profile | null
  /** Whether the session's profile is known (a binding read, or an account
   *  with no profile). Nothing personal should show until it is. */
  profileKnown: boolean
  /** Open the public member page (/user/:username) for a member. */
  onOpenMember: (username: string) => void
  /** Open Settings (optionally at a pane). */
  onOpenSettings: () => void
}

export default function MyProfileView({ user, activeProfile, onOpenMember, onOpenSettings }: MyProfileViewProps) {
  return (
    <div className="animate-fade-in">
      <PageHeader title={activeProfile?.name ?? user.username} sub="Your profile" />
      <div className="flex flex-wrap gap-3">
        <button type="button" className="stage-btn stage-btn-ghost" onClick={() => onOpenMember(user.username)}>How other members see you</button>
        <button type="button" className="stage-btn stage-btn-quiet" onClick={onOpenSettings}>Settings</button>
      </div>
    </div>
  )
}
