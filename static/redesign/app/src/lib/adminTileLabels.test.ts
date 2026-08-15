// Pins the NOUNS on the admin stat tiles, by scanning source text.
//
// The dashboard once showed "846 Media File Entries" beside "8,177 Skip
// Markers" and read as a 10x counting bug. Neither number was wrong; both
// labels were. movie_count + show_count is COUNT(*) over media_items —
// title rows, no files, no episodes — while the skip figure counts actual
// video files.
//
// The first fix relabelled the dashboard tile and MISSED the stage panel in
// App.tsx, which renders the same two fields and called them "Files"
// outright. Two surfaces, same data, contradictory nouns. A unit test over
// the extracted arithmetic could not catch that, because the arithmetic was
// never what was wrong.
//
// So this reads the components as text, in the manner of
// TestSPAProbeEmitsNoNativeOnlyCapabilities (see CLAUDE.md): wherever
// movie_count and show_count are rendered, the label must not call them
// files. Deliberately blunt — it cannot model how a label is assembled, and
// that is the point. A clever assertion would be one more thing to keep in
// sync.

// Sources arrive via Vite's `?raw`, NOT node:fs. tsconfig.app.json pins
// "types": ["vite/client"] and includes all of src/, so a node builtin here
// fails `tsc -b` — which is what `npm run build` runs, which is what
// scripts/aurora-update.sh runs on the box. `npm test` stays green through
// all of it (vitest.config.ts documents that exact trap), so the first
// symptom would have been every auto-deploy failing on main. `?raw` is
// declared by vite/client, so it typechecks with the config as it stands.
import adminViewSrc from '../components/admin/AdminView.tsx?raw'
import appSrc from '../App.tsx?raw'
import { describe, expect, it } from 'vitest'

const SURFACES: { name: string; text: string }[] = [
  { name: 'AdminView dashboard tile', text: adminViewSrc },
  { name: 'App stage status panel', text: appSrc },
]

describe('admin stat tile labels', () => {
  for (const { name, text } of SURFACES) {
    it(`${name} does not label media_items rows as files`, () => {
      // Find each place the value is RENDERED, then read back to the
      // nearest preceding label. Searching a window rather than a single
      // line, because a tile literal may span lines — and comment lines
      // are skipped, since the fix for this very bug explains itself in a
      // comment that names both fields.
      const isComment = (idx: number) => {
        const lineStart = text.lastIndexOf('\n', idx) + 1
        return /^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, idx + 1))
      }
      const sites: number[] = []
      const re = /stats\.movie_count/g
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!isComment(m.index)) sites.push(m.index)
      }
      expect(sites.length, 'surface no longer renders movie_count').toBeGreaterThan(0)

      for (const idx of sites) {
        const before = text.slice(Math.max(0, idx - 800), idx)
        const labels = [...before.matchAll(/label:\s*'([^']*)'|label:\s*"([^"]*)"/g)]
        expect(labels.length, `no label precedes stats.movie_count at ${idx}`).toBeGreaterThan(0)
        const last = labels[labels.length - 1]
        const labelText = (last[1] ?? last[2]).toLowerCase()
        expect(labelText, `"${labelText}" calls title rows files`).not.toMatch(/\bfiles?\b/)
        expect(labelText, `"${labelText}" claims to count episodes`).not.toMatch(/\bepisodes?\b/)
      }
    })
  }

  it('the skip tile is not labelled as a count of markers', () => {
    // It counts files ANALYZED — a file the detector found nothing in
    // still counts. "Skip Markers" named the wrong noun and invited the
    // comparison that started all this.
    const text = adminViewSrc
    const line = text.split('\n').find((l: string) => l.includes('skipCoverage(skipStatus)'))
    expect(line, 'skip tile no longer derives from skipCoverage').toBeDefined()
    const tile = text.slice(text.indexOf(line!), text.indexOf(line!) + 1200)
    expect(tile).toMatch(/label:\s*'Skip Analysis'/)
  })
})
