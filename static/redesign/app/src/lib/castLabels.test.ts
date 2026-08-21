// `cast_held` must never be rendered as "casting".
//
// It means "something fetched this session with a cast-scoped token", and
// Safari and iOS put such a token on the LOCAL <video> src because native HLS
// cannot authenticate by cookie (issue #317) — so ordinary local playback in
// those browsers sets the flag with no receiver anywhere. An admin surface
// that reads it as a TV mislabels a large share of ordinary viewers, which is
// the same mystery-row confusion the cast pairing exists to end. Only
// `cast_clone_of` (via isReceiverSession) proves a receiver.
//
// That rule was prose in three comments and enforced by nothing. This reads
// AdminView.tsx and fails if a cast word appears in a `cast_held` expression,
// in the shape of internal/streaming's TestSPAProbeEmitsNoNativeOnlyCapabilities.

// Source arrives via Vite's `?raw`, NOT node:fs — tsconfig.app.json pins
// "types": ["vite/client"] and includes all of src/, so a node builtin here
// passes `npm test` and fails `tsc -b`, i.e. every auto-deploy. See the same
// note in adminTileLabels.test.ts, which learned it the hard way.
import adminViewSrc from '../components/admin/AdminView.tsx?raw'
import { describe, expect, it } from 'vitest'

// Strip block and line comments so the rule's own explanations — which must
// say "casting" to explain why the code does not — are not scanned.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
}

// Things that prove a receiver: membership in a group's castRows (which
// groupCastStreams fills only from rows carrying cast_clone_of), or the
// cast_clone_of field itself. An expression carrying one of these has earned
// its cast wording; cast_held alone has not.
const RECEIVER_EVIDENCE = /castRows|cast_clone_of|isReceiverSession/

describe('cast_held is never presented as casting', () => {
  it('never derives cast wording from cast_held alone in AdminView', () => {
    const src = stripComments(adminViewSrc)
    const offenders: string[] = []
    // Every JSX expression container mentioning cast_held. Non-greedy to the
    // next closing brace keeps each match to one expression.
    for (const m of src.matchAll(/\{[^{}]*cast_held[^{}]*\}/g)) {
      const expr = m[0]
      // The identifiers themselves contain "cast"; only other cast wording
      // counts as a label.
      const wording = expr.replace(/cast_held|cast_clone_of|isReceiverSession|castRows/g, '')
      if (/\bcast(ing|s)?\b/i.test(wording) && !RECEIVER_EVIDENCE.test(expr)) {
        offenders.push(expr.trim())
      }
    }
    expect(offenders, 'a cast label is derived from cast_held with no receiver evidence — Safari and iOS set that flag for ordinary local playback (#317); gate the label on cast_clone_of / isReceiverSession instead').toEqual([])
  })

  it('still labels receivers from cast_clone_of, so the rule was not satisfied by deleting the feature', () => {
    // Guards the test above against the degenerate fix of removing every cast
    // label: isReceiverSession must remain the thing driving them.
    const src = stripComments(adminViewSrc)
    expect(src).toMatch(/isReceiverSession\(/)
  })
})
