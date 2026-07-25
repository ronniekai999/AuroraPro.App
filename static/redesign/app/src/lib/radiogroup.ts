// Keyboard contract for a `role="radiogroup"` built from buttons.
//
// Settings has four of these (Glow, Typeface, Avatar, Content Tone) and none of
// them implemented the pattern: every `role="radio"` was a natural tab stop and
// the arrow keys did nothing. That is worse than a plain button group, because
// NVDA and JAWS switch into focus/forms mode the moment focus enters a `radio`
// and hand the arrow keys to the application — which ignored them. So the only
// key that worked was Tab, which is not how a radio group behaves anywhere else,
// and 21 sequential stops replaced the 4 the pattern specifies.
//
// Aurora Stage Phase 7a. One helper rather than four copies, for the same reason
// FONT_OPTIONS and MATURITY_OPTIONS are one list each: four hand-written
// keyboard handlers is four chances to get the wrap arithmetic wrong.
//
// APG radiogroup, the parts that matter here:
//   - Right/Down move to the next radio and CHECK it (radio groups activate on
//     move — unlike tabs, where manual activation is an option)
//   - Left/Up move to the previous and check it
//   - both wrap
//   - Home/End go to first/last
//   - the group is ONE tab stop: the checked radio has tabIndex 0, the rest -1
//
// Deliberately NOT generalised to tabs: that pattern's automatic-vs-manual
// choice and its `aria-selected` differ, and AdminView implements it inline
// where its async-panel reasoning lives.

/**
 * Given the current index and a key, returns the index to move to — or null if
 * the key is not one this pattern handles (so the caller leaves it alone).
 */
export function nextRadioIndex(key: string, current: number, length: number): number | null {
  if (length === 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % length
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + length) % length
    case 'Home':
      return 0
    case 'End':
      return length - 1
    default:
      return null
  }
}
