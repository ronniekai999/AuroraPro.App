// The Settings page's panes and their URLs: /settings/<pane>. /settings with
// no pane (and any pane this build does not know) shows the first one.

export interface SettingsPaneInfo {
  id: 'playback' | 'app' | 'account' | 'profiles'
  label: string
}
export type SettingsPane = SettingsPaneInfo['id']

export const SETTINGS_PANES: readonly SettingsPaneInfo[] = [
  { id: 'playback', label: 'Playback' },
  { id: 'app', label: 'App and notifications' },
  { id: 'account', label: 'Account and sign-in' },
  { id: 'profiles', label: 'Profiles and parental controls' },
]

export const DEFAULT_SETTINGS_PANE: SettingsPane = 'playback'

/** The pane a pathname names, or null when it names none this build knows
 *  (including a pathname that is not under /settings at all). */
export function settingsPaneFromPath(pathname: string): SettingsPane | null {
  const m = /^\/settings\/([a-z-]+)\/?$/.exec(pathname)
  if (!m) return null
  return SETTINGS_PANES.find(p => p.id === m[1])?.id ?? null
}

export function settingsPath(pane: SettingsPane): string {
  return `/settings/${pane}`
}
