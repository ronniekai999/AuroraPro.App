// The built-in avatars a profile can choose: the profile's initial in dark ink
// on a bright two-tone disc. Stored on a profile as `avatar_url =
// "nebula:<id>"` (the server's avatar validation accepts this id form beside
// http(s) image URLs), so the choice follows the profile everywhere its avatar
// renders. The ids keep the "nebula" name from when each was drawn as an
// animated orb; that orb was buried under a fixed 30px inner shadow and an 11px
// blur, which at 24-56px left a near-black disc, so the stored values stayed
// and only the drawing changed.

export interface NebulaDef {
  id: string
  /** Display name, read out as the picker button's label. */
  name: string
  /** The gradient's colour stops, top-left to bottom-right. Every point of
   *  the gradient carries the dark initial at 4.5:1 or better, so a 12px
   *  initial on a 24px disc still passes AA (NebulaAvatar.test.tsx checks). */
  stops: readonly string[]
}

export const NEBULAS: readonly NebulaDef[] = [
  { id: 'amethyst', name: 'Amethyst', stops: ['#d8b4fe', '#a855f7'] },
  { id: 'tidal', name: 'Tidal', stops: ['#5eead4', '#06b6d4'] },
  { id: 'blossom', name: 'Blossom', stops: ['#f9a8d4', '#ec4899'] },
  { id: 'ember', name: 'Ember', stops: ['#fcd34d', '#f97316'] },
  { id: 'verdant', name: 'Verdant', stops: ['#86efac', '#10b981'] },
  { id: 'cobalt', name: 'Cobalt', stops: ['#c7d2fe', '#818cf8'] },
  { id: 'rose', name: 'Rose', stops: ['#fda4af', '#f43f5e'] },
  { id: 'mirage', name: 'Mirage', stops: ['#67e8f9', '#a855f7'] },
  { id: 'solstice', name: 'Solstice', stops: ['#fef08a', '#eab308'] },
  { id: 'aurora', name: 'Aurora', stops: ['#ec4899', '#a855f7', '#2dd4bf'] },
]

export const NEBULA_PREFIX = 'nebula:'

const byId = new Map(NEBULAS.map((n) => [n.id, n]))

/**
 * parseNebula resolves a stored avatar value to a nebula definition. Accepts the
 * full stored form ("nebula:aurora") or a bare id ("aurora"); returns null for
 * anything else (an http(s) image URL, empty, or an unknown id) so callers can
 * fall back to an image/initial.
 */
export function parseNebula(value?: string | null): NebulaDef | null {
  if (!value) return null
  const id = value.startsWith(NEBULA_PREFIX) ? value.slice(NEBULA_PREFIX.length) : value
  return byId.get(id) ?? null
}

/** The stored avatar value for a nebula id, e.g. "aurora" → "nebula:aurora". */
export function nebulaValue(id: string): string {
  return NEBULA_PREFIX + id
}

/** The CSS background a nebula's disc is painted with: its gradient under a
 *  soft white highlight at the top left. The highlight only lightens, so it
 *  can only raise the initial's contrast. */
export function nebulaFill(def: NebulaDef): string {
  return 'radial-gradient(110% 80% at 28% 0%, rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0) 60%), '
    + `linear-gradient(150deg, ${def.stops.join(', ')})`
}

interface NebulaAvatarProps {
  /** A nebula def, a bare id ("aurora"), or a stored value ("nebula:aurora"). */
  nebula: NebulaDef | string
  /** The letter drawn on the disc; empty draws the disc alone (a picker
   *  shown before the profile has a name). */
  initial?: string
  /** Extra classes on the disc. It has no size of its own: size it here
   *  (e.g. "h-full w-full"). The initial scales with the disc. */
  className?: string
}

/**
 * NebulaAvatar draws a nebula's disc at whatever size its className gives it,
 * for the pickers, whose discs are sized by their grid. A profile's avatar at
 * a fixed size is ProfileAvatar, which paints the same fill.
 *
 * The initial is SVG text on a 100-unit square, so it is 42% of the disc's
 * width (ProfileAvatar's share) at any size, with nothing measured. It was
 * sized in container units first, and the disc had to be a size container
 * for that: inside onboarding's fieldset, whose minimum width is its
 * content's, Chromium then laid every button out zero pixels wide.
 */
export function NebulaAvatar({ nebula, initial = '', className = '' }: NebulaAvatarProps) {
  const def = typeof nebula === 'string' ? parseNebula(nebula) : nebula
  if (!def) return null
  return (
    <span className={`nebula-disc ${className}`} style={{ background: nebulaFill(def) }} aria-hidden="true">
      {initial && (
        <svg viewBox="0 0 100 100" className="nebula-disc-initial font-display font-bold text-action-on" focusable="false">
          <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="42" fill="currentColor">{initial}</text>
        </svg>
      )}
    </span>
  )
}
