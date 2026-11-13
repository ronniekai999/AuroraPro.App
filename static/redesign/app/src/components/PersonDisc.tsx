import { personColor, personInitial } from '@/lib/personColor'

interface PersonDiscProps {
  name: string
  /** What picks the colour; the person's id where there is one. */
  colorKey?: number | string
  /** Diameter in px, the ring included. */
  size?: number
  /** Draws the aurora ring that means "this person is speaking right now". */
  speaking?: boolean
  /** The surface the disc sits on, for the gap between ring and disc and for
   *  the edge that separates overlapping discs. */
  surface?: string
  /** An uploaded picture, when the person has one. */
  imageUrl?: string | null
  className?: string
}

/**
 * A person as a coloured disc with their initial. Decorative: every call site
 * prints the name beside it or names the whole group, so the disc itself is
 * hidden from assistive technology (an initial read aloud before the name it
 * abbreviates is noise).
 *
 * The aurora ring is the one place this component uses the brand gradient,
 * and it means exactly one thing: live presence.
 */
export function PersonDisc({
  name, colorKey, size = 32, speaking = false, surface = 'var(--surface-raised)', imageUrl, className = '',
}: PersonDiscProps) {
  const ring = Math.max(2, Math.round(size / 16))
  const inner = size - ring * 2
  return (
    <span
      aria-hidden="true"
      data-speaking={speaking || undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        // The ring is the outer disc showing round the inner one; when nobody
        // is speaking it is the surface colour, so the disc keeps its size and
        // nothing shifts when someone starts to talk.
        background: speaking ? 'var(--aurora)' : surface,
      }}
    >
      <span
        className="inline-flex items-center justify-center overflow-hidden rounded-full font-bold"
        style={{
          width: inner,
          height: inner,
          boxShadow: `0 0 0 ${Math.max(1, ring - 1)}px ${surface}`,
          background: personColor(colorKey ?? name),
          color: 'var(--on-action)',
          fontSize: Math.max(12, Math.round(inner * 0.42)),
        }}
      >
        {imageUrl ? <img src={imageUrl} alt="" className="h-full w-full object-cover" /> : personInitial(name)}
      </span>
    </span>
  )
}
