// Your profile (/profile): how the account appears to other members, the
// avatar and suggestion lean of the profile that is watching, and the
// watching statistics and achievements. It sits in the Settings list, so it
// wears the Settings frame.
//
// A session acting as a profile with a content limit is not shown this page
// (the app does not render it), so everything here is for a profile that may
// edit the account's member profile.

import { type Toast } from '@/components/Toast'
import { GamificationCard } from '@/components/GamificationCard'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import { setProfileMaturity, updateProfile, type Profile, type User as ApiUser } from '@/lib/api'
import { refusalMessage } from '@/lib/profileRefusal'
import type { SettingsPane } from '@/lib/settingsPanes'
import { PaneSection } from './settings/controls'
import { MemberProfileSection } from './settings/MemberProfileEditor'
import { AvatarPicker, LeanPicker } from './settings/ProfilePickers'
import { SettingsShell } from './settings/SettingsShell'

export interface MyProfileViewProps {
  user: ApiUser
  /** The profile the server has bound to this session, or null. */
  activeProfile: Profile | null
  /** Whether the session's profile is known (a binding read, or an account
   *  with no profile). Nothing personal should show until it is. */
  profileKnown: boolean
  /** Open the public member page (/user/:username) for a member. */
  onOpenMember: (username: string) => void
  /** Open Settings, at a pane when one is named. */
  onOpenSettings: (pane?: SettingsPane) => void
  onToast?: (message: string, type?: Toast['type']) => void
  /** Called after the watching profile's avatar or lean changed, so the
   *  app's copy of the profiles is read again. */
  onProfilesChanged?: () => void
}

export default function MyProfileView({ user, activeProfile, profileKnown, onOpenMember, onOpenSettings, onToast, onProfilesChanged }: MyProfileViewProps) {
  const name = activeProfile?.name ?? user.username
  /** Saves one field of the watching profile; a refusal is said and thrown
   *  on, so the picker puts the old choice back. */
  const save = async (write: () => Promise<unknown>, fallback: string) => {
    try {
      await write()
      onProfilesChanged?.()
    } catch (e) {
      onToast?.(refusalMessage(e, fallback), 'error')
      throw e
    }
  }

  return (
    <SettingsShell current="your-profile" onPane={pane => onOpenSettings(pane)} onOpenProfilePage={() => { /* already here */ }}>
      <div className="mb-10 flex flex-wrap items-center gap-x-5 gap-y-4">
        {profileKnown && <ProfileAvatar avatarUrl={activeProfile?.avatar_url} name={name} colorKey={activeProfile?.id} size={96} />}
        <div className="min-w-0 flex-1 basis-[14rem]">
          <h2 className="font-display text-[28px] font-bold leading-tight text-ink">{profileKnown ? name : user.username}</h2>
          <p className="mt-1 text-[13px] text-ink-2">Signed in as {user.username}.</p>
        </div>
        <button type="button" onClick={() => onOpenMember(user.username)} className="stage-btn stage-btn-ghost flex-none">View my page</button>
      </div>

      <PaneSection
        title="How other members see you"
        note={`Your page on this server, at /user/${user.username}. It belongs to the account, not to one profile.`}
      >
        <MemberProfileSection activeProfile={activeProfile} profileKnown={profileKnown} onToast={onToast} />
      </PaneSection>

      {profileKnown && activeProfile && (
        <>
          <PaneSection title="Avatar" note={`For ${activeProfile.name}. It shows in the profile picker and the menu.`}>
            <AvatarPicker
              profileId={activeProfile.id}
              profileName={activeProfile.name}
              avatarUrl={activeProfile.avatar_url}
              onPick={avatarUrl => save(() => updateProfile(activeProfile.id, { avatar_url: avatarUrl }), 'The avatar could not be changed.')}
            />
          </PaneSection>
          <PaneSection
            title="What Aurora leans towards"
            note={`Steers what is suggested to ${activeProfile.name} first, from the next visit to Tonight. It hides nothing; a limit does that.`}
          >
            <LeanPicker
              profileId={activeProfile.id}
              profileName={activeProfile.name}
              pref={activeProfile.maturity_pref}
              onPick={pref => save(() => setProfileMaturity(activeProfile.id, pref), 'The lean could not be changed.')}
            />
          </PaneSection>
        </>
      )}

      {profileKnown && (
        <PaneSection title="Your progress" note="Counted for the account, across its profiles.">
          <GamificationCard />
        </PaneSection>
      )}
    </SettingsShell>
  )
}
