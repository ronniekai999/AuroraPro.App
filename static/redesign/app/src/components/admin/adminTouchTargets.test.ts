// A button drawn at 36px gets its 44px target on a touch screen from
// `stage-hit44`, by class at each call site (index.css says why it is not on
// the button class itself). The admin page has many such buttons and no
// rendered check of them, so this reads the sources: a small button added
// without the class fails here.
//
// Sources arrive through Vite's `?raw` (see lib/adminTileLabels.test.ts for
// why not node:fs).
import adminView from './AdminView.tsx?raw'
import matchModal from './ManualMatchModal.tsx?raw'
import playbackHealth from './PlaybackHealth.tsx?raw'
import adminShell from './AdminShell.tsx?raw'
import { describe, expect, it } from 'vitest'

const SOURCES: Record<string, string> = {
  'AdminView.tsx': adminView,
  'ManualMatchModal.tsx': matchModal,
  'PlaybackHealth.tsx': playbackHealth,
  'AdminShell.tsx': adminShell,
}

describe('small buttons on the admin page', () => {
  it('each carry the 44px touch target', () => {
    let seen = 0
    for (const [file, text] of Object.entries(SOURCES)) {
      text.split('\n').forEach((line, i) => {
        if (!/\bstage-btn-sm\b/.test(line)) return
        seen++
        expect(/\bstage-hit44\b/.test(line), `${file}:${i + 1} has a 36px button with no 44px target`).toBe(true)
      })
    }
    // The check is of something: the page does have small buttons.
    expect(seen).toBeGreaterThan(10)
  })
})
