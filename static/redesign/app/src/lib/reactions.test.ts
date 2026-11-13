// The reactions the app offers against the list the server accepts.
//
// Three of the nine once offered were refused on every press (a heart with a
// variation selector, where the server lists the bare one, and two the server
// never listed): nothing floated on any screen, the room showed the server's
// refusal, and each press still spent one of the sender's thirty a minute.
// The server's list is read from its own source here, in the manner of
// profileLimits.test.ts, so the two cannot drift apart unseen.

import { describe, expect, it } from 'vitest'
import managerGo from '../../../../../internal/watchparty/manager.go?raw'
import { QUICK_REACTIONS, drawnReaction } from './reactions'

/** The keys of `allowedReactions`, decoded from Go's \UXXXXXXXX escapes.
 *  An entry on a comment line is not an entry: a reaction commented out of
 *  the map is one the server refuses. */
function serverReactions(source: string): string[] {
  const block = /var allowedReactions = map\[string\]bool\{([\s\S]*?)\n\}/.exec(source)
  if (!block) throw new Error('allowedReactions not found in internal/watchparty/manager.go: this test is out of date, not passing')
  // Block comments first, then comment lines.
  const live = block[1].replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  return [...live.matchAll(/"((?:\\U[0-9A-Fa-f]{8})+)":\s*true/g)].map(m =>
    [...m[1].matchAll(/\\U([0-9A-Fa-f]{8})/g)].map(c => String.fromCodePoint(parseInt(c[1], 16))).join(''))
}

describe('the reactions a party offers', () => {
  const accepted = serverReactions(managerGo)

  it('does not count an entry the server has commented out', () => {
    const source = 'var allowedReactions = map[string]bool{\n\t"\\U0001F525": true, // fire\n\t// "\\U0001F480": true, // skull\n\t/* "\\U0001F92F": true,\n\t   "\\U0001F60E": true, */\n}\n'
    expect(serverReactions(source)).toEqual(['🔥'])
  })

  it('reads a real list from the server', () => {
    // Not vacuous: fifteen today, and a list that parsed to nothing would
    // make the check below pass for anything.
    expect(accepted.length).toBeGreaterThanOrEqual(9)
    expect(accepted).toContain('🔥')
    expect(accepted).toContain('\u2764')
    expect(accepted).not.toContain('\u2764\uFE0F')
  })

  it('offers nine, each of them one the server accepts as it is sent', () => {
    expect(QUICK_REACTIONS).toHaveLength(9)
    expect(new Set(QUICK_REACTIONS).size).toBe(9)
    expect(QUICK_REACTIONS.filter(r => !accepted.includes(r))).toEqual([])
  })

  it('sends the bare heart and draws it as the emoji', () => {
    expect(QUICK_REACTIONS).toContain('\u2764')
    expect(drawnReaction('\u2764')).toBe('\u2764\uFE0F')
    // Everything else is drawn as it is.
    for (const r of QUICK_REACTIONS.filter(x => x !== '\u2764')) expect(drawnReaction(r)).toBe(r)
  })
})
