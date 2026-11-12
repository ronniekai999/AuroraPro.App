// Settings: a list of sections and the one that is open. The URL names the
// section (/settings/<pane>, lib/settingsPanes), so each has an address and
// Back moves between them; App owns the URL and tells this view which one.

import { useState } from 'react'
import { type Toast } from '@/components/Toast'
import { type Profile, type User as ApiUser } from '@/lib/api'
import { isRestrictedProfile } from '@/lib/profileSession'
import { DEFAULT_SETTINGS_PANE, type SettingsPane } from '@/lib/settingsPanes'
import { AccountPane } from './settings/AccountPane'
import { AppPane } from './settings/AppPane'
import { PlaybackPane } from './settings/PlaybackPane'
import { ProfilesPane } from './settings/ProfilesPane'
import { SettingsShell } from './settings/SettingsShell'

interface SettingsViewProps {
  user?: ApiUser
  /** Signs out. The server ends every session on the account, on every
   *  device; the button says so. */
  onLogout?: () => void
  onToast?: (message: string, type?: Toast['type']) => void
  activeProfile?: Profile | null
  /** Whether the session's profile is known (a binding read, or an account
   *  with no profile). While it is not, the profile and sign-in management
   *  controls stay hidden, as for a restricted profile, since the session
   *  could be acting as one. */
  profileKnown?: boolean
  /** Opens "Your profile" (/profile). Not offered to a session acting as a
   *  profile with a content limit, which is not shown that page. */
  onOpenProfilePage?: () => void
  /** Called after a change to profiles App also holds (a PIN, a limit, a
   *  name, an avatar, a new or deleted profile), so its copy, which decides
   *  what the session is offered and whether a switch prompts, is re-read. */
  onProfilesChanged?: () => void
  /** The pane the URL names (/settings/<pane>), or null for /settings. */
  pane?: SettingsPane | null
  /** Ask App to show another pane (it navigates to that pane's URL). Without
   *  it the view keeps the choice itself. */
  onPaneChange?: (pane: SettingsPane) => void
}

export default function SettingsView({
  user, onLogout, onToast, activeProfile = null, profileKnown = false, onOpenProfilePage, onProfilesChanged, pane, onPaneChange,
}: SettingsViewProps = {}) {
  const [ownPane, setOwnPane] = useState<SettingsPane>(pane ?? DEFAULT_SETTINGS_PANE)
  const current = onPaneChange ? (pane ?? DEFAULT_SETTINGS_PANE) : ownPane
  const offeredProfilePage = profileKnown && !isRestrictedProfile(activeProfile)

  return (
    <SettingsShell
      current={current}
      onPane={onPaneChange ?? setOwnPane}
      onOpenProfilePage={offeredProfilePage ? onOpenProfilePage : undefined}
      wide={current === 'profiles'}
    >
      {current === 'playback' && <PlaybackPane />}
      {current === 'app' && <AppPane onToast={onToast} />}
      {current === 'account' && (
        <AccountPane user={user} activeProfile={activeProfile} profileKnown={profileKnown} onLogout={onLogout} onToast={onToast} />
      )}
      {current === 'profiles' && (
        <ProfilesPane actingProfile={activeProfile} profileKnown={profileKnown} onToast={onToast} onProfilesChanged={onProfilesChanged} />
      )}
    </SettingsShell>
  )
}
