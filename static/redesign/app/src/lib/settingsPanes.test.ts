import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS_PANE, SETTINGS_PANES, settingsPaneFromPath, settingsPath } from './settingsPanes'

describe('settings panes', () => {
  it('round-trips every pane through its path', () => {
    for (const p of SETTINGS_PANES) expect(settingsPaneFromPath(settingsPath(p.id))).toBe(p.id)
  })

  it('names no pane for /settings itself, an unknown pane, or another page', () => {
    for (const path of ['/settings', '/settings/', '/settings/typeface', '/settings/playback/extra', '/movies', '/']) {
      expect(settingsPaneFromPath(path), path).toBeNull()
    }
  })

  it('has a default that is a real pane, and includes parental controls', () => {
    expect(SETTINGS_PANES.map(p => p.id)).toContain(DEFAULT_SETTINGS_PANE)
    expect(SETTINGS_PANES.find(p => p.id === 'profiles')?.label).toBe('Profiles and parental controls')
  })
})
