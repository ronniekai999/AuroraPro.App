// The colour a person or profile is drawn in when they have no picture: the
// disc behind their initial, and their name in a party chat. Nine muted tones
// that all carry the dark initial (#0e0f11) at 7:1 or better and read as
// different from one another at 24px.
//
// Chosen by a stable key, so the same person is the same colour on every
// screen and every visit, and two profiles on one account differ whenever
// their keys do.

export const PERSON_COLORS = [
  '#d8b48a', '#86bfae', '#e6c15a', '#9aa6ba', '#e09c8a',
  '#8fb0e0', '#a9cc86', '#d9c98a', '#86c9cf',
] as const

/** A numeric id is used as is, so consecutive ids (an account's profiles,
 *  created one after another) get consecutive, different colours. A name is
 *  hashed. */
export function personColor(key: number | string | null | undefined): string {
  if (typeof key === 'number' && Number.isFinite(key)) {
    return PERSON_COLORS[Math.abs(Math.trunc(key)) % PERSON_COLORS.length]
  }
  const s = String(key ?? '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return PERSON_COLORS[h % PERSON_COLORS.length]
}

export function personInitial(name: string | null | undefined): string {
  const c = (name ?? '').trim().charAt(0)
  return c ? c.toUpperCase() : '?'
}

/** The bubble a chat line is printed on over playing video (the party's chat
 *  ticker): how opaque its dark fill is, and how far the whole bubble dims
 *  before it leaves. The person's name is drawn in their colour ON that
 *  bubble, over whatever frame is behind it, so these two numbers decide
 *  whether a name can be read over a white frame. With them every one of
 *  PERSON_COLORS keeps 4.5:1 or better there in both states (5.27:1 at the
 *  lowest; personColor.test.ts computes it and scripts/contrast.mjs prints
 *  it). At 0.78 and a dim to 0.8 the lowest was 2.73:1. */
export const NAME_BUBBLE_FILL_ALPHA = 0.92
export const NAME_BUBBLE_DIM_OPACITY = 0.9
/** The fill's colour: the page's graphite. */
export const NAME_BUBBLE_FILL_RGB = [14, 15, 17] as const
