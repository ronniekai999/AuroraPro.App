import type { CSSProperties } from 'react'

// The built-in animated "nebula" avatars offered during onboarding. Each is a
// living aurora orb — three drifting, screen-blended gradient blobs in a colour
// family. Stored on a profile as `avatar_url = "nebula:<id>"` (the server's
// avatar validation accepts this id form alongside http(s) image URLs), so the
// choice follows the profile everywhere its avatar renders.
export interface NebulaDef {
  id: string
  /** Poetic display name shown under the orb in the picker. */
  name: string
  c1: string
  c2: string
  c3: string
}

export const NEBULAS: readonly NebulaDef[] = [
  { id: 'amethyst', name: 'Amethyst', c1: '#A855F7', c2: '#D8B4FE', c3: '#7E22CE' },
  { id: 'tidal', name: 'Tidal', c1: '#2dd4bf', c2: '#22d3ee', c3: '#0ea5e9' },
  { id: 'blossom', name: 'Blossom', c1: '#ec4899', c2: '#f9a8d4', c3: '#db2777' },
  { id: 'ember', name: 'Ember', c1: '#f59e0b', c2: '#fcd34d', c3: '#fb7185' },
  { id: 'verdant', name: 'Verdant', c1: '#10b981', c2: '#6ee7b7', c3: '#34d399' },
  { id: 'cobalt', name: 'Cobalt', c1: '#6366f1', c2: '#a5b4fc', c3: '#818cf8' },
  { id: 'rose', name: 'Rose', c1: '#f43f5e', c2: '#fda4af', c3: '#fb7185' },
  { id: 'mirage', name: 'Mirage', c1: '#06b6d4', c2: '#c084fc', c3: '#8b5cf6' },
  { id: 'solstice', name: 'Solstice', c1: '#eab308', c2: '#fde047', c3: '#f59e0b' },
  { id: 'aurora', name: 'Aurora', c1: '#A855F7', c2: '#2dd4bf', c3: '#ec4899' },
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

interface NebulaAvatarProps {
  /** A nebula def, a bare id ("aurora"), or a stored value ("nebula:aurora"). */
  nebula: NebulaDef | string
  /** Diameter in px. Omit to size via className (e.g. "w-full h-full"). */
  size?: number
  /** Extra classes applied to the orb element. */
  className?: string
  /** Brighter, livelier "selected" treatment used by the picker grid. */
  active?: boolean
}

/**
 * NebulaAvatar renders the living aurora orb for a nebula. Colours are passed as
 * CSS custom properties so the shared `.neb-*` keyframes in index.css drive the
 * drift animation for every instance without per-instance styles. Provide `size`
 * for a fixed diameter, or omit it and size the orb via `className`.
 */
export function NebulaAvatar({ nebula, size, className = '', active = false }: NebulaAvatarProps) {
  const def = typeof nebula === 'string' ? parseNebula(nebula) : nebula
  if (!def) return null
  const style = {
    '--c1': def.c1,
    '--c2': def.c2,
    '--c3': def.c3,
    ...(size != null ? { width: size, height: size } : {}),
  } as CSSProperties
  return (
    <span className={`neb${active ? ' neb-active' : ''}${className ? ' ' + className : ''}`} style={style} aria-hidden="true">
      <span className="neb-l neb-l1" />
      <span className="neb-l neb-l2" />
      <span className="neb-l neb-l3" />
      <span className="neb-core" />
    </span>
  )
}
