// AuroraWordmark — the drawn "AuroraPro" brand lockup.
//
// These are NOT glyphs from a font: the nine letters are hand-drawn vector
// paths from the typeface study in docs/design/aurorapro-typeface/ (see
// generate.mjs there — the canonical source of the path data, where the
// letterforms can be regenerated and previewed against the other concepts).
// Two cuts shipped from that study:
//
//   borealis — rounded geometric monoline, aurora-wave crossbar, brand
//              gradient ink. The primary wordmark; works from ~14px up.
//   photon   — heavyweight display sliced by two light bands with an
//              under-glow. Title-card use only (~40px and up): splash
//              screens, TV surfaces, empty states. index.html's boot splash
//              carries a static copy of this variant (it must paint before
//              any JS loads, so it cannot import this module).
//
// Why drawn paths and not a .woff2: both cuts depend on gradient ink, and
// photon additionally on a mask and a blur filter — none of which a classic
// font file can carry. A wordmark is a fixed piece of art, so it ships as
// art, the way the play-circle mark (AuroraMark) already does.
//
// Rendering notes that are easy to get wrong later:
//   - Gradients MUST stay gradientUnits="userSpaceOnUse". The default
//     objectBoundingBox units are undefined on the zero-width bounding box
//     of a perfectly vertical stem, and Chromium drops those strokes
//     entirely (the r/a/P/u stems vanish).
//   - Size the mark from the consumer with a height class + `w-auto`; the
//     viewBox aspect keeps the width honest.
import { useId } from 'react'

// Shared skeleton: cap top y=30, x-height y=110, baseline y=220.
const BOREALIS_PATHS: readonly string[] = [
  'M 40 220 L 115 30 L 190 220',                              // A
  'M 69 151 C 99 139 131 163 161 151',                        // A wave crossbar
  'M 234 110 V 172 A 48 48 0 0 0 330 172',                    // u bowl
  'M 330 110 V 220',                                          // u stem
  'M 388 110 V 220',                                          // r stem
  'M 388 168 A 58 58 0 0 1 446 110 Q 452 110 458 104',        // r arm + flick
  'M 480 165 A 55 55 0 1 1 590 165 A 55 55 0 1 1 480 165',    // o
  'M 648 110 V 220',                                          // r stem
  'M 648 168 A 58 58 0 0 1 706 110 Q 712 110 718 104',        // r arm + flick
  'M 740 165 A 55 55 0 1 1 850 165 A 55 55 0 1 1 740 165',    // a bowl
  'M 850 110 V 220',                                          // a stem
  'M 912 30 V 220',                                           // P stem
  'M 912 30 H 964 A 47 47 0 0 1 964 124 H 912',               // P bowl
  'M 1048 110 V 220',                                         // r stem
  'M 1048 168 A 58 58 0 0 1 1106 110 Q 1112 110 1118 104',    // r arm + flick
  'M 1140 165 A 55 55 0 1 1 1250 165 A 55 55 0 1 1 1140 165', // o
]

const PHOTON_PATHS: readonly string[] = [
  'M 40 220 L 115 30 L 190 220',
  'M 76 134 H 154',
  'M 234 110 V 172 A 48 48 0 0 0 330 172',
  'M 330 110 V 220',
  'M 388 110 V 220',
  'M 388 168 A 58 58 0 0 1 446 110',
  'M 480 165 A 55 55 0 1 1 590 165 A 55 55 0 1 1 480 165',
  'M 648 110 V 220',
  'M 648 168 A 58 58 0 0 1 706 110',
  'M 740 165 A 55 55 0 1 1 850 165 A 55 55 0 1 1 740 165',
  'M 850 110 V 220',
  'M 912 30 V 220',
  'M 912 30 H 964 A 47 47 0 0 1 964 124 H 912',
  'M 1048 110 V 220',
  'M 1048 168 A 58 58 0 0 1 1106 110',
  'M 1140 165 A 55 55 0 1 1 1250 165 A 55 55 0 1 1 1140 165',
]

// The two full-width "light band" stencil cuts of the photon cut.
const PHOTON_BANDS: ReadonlyArray<{ y: number; h: number }> = [
  { y: 156, h: 12 },
  { y: 184, h: 8 },
]

// Tight boxes around the stroked artwork (stroke/2 beyond the skeleton).
const BOREALIS_VIEWBOX = '27 17 1236 216'   // stroke 26 → ±13
const PHOTON_VIEWBOX = '22 12 1246 226'     // stroke 36 → ±18

export interface AuroraWordmarkProps {
  variant?: 'borealis' | 'photon'
  /**
   * 'gradient' (default) uses the brand ramp. Any CSS color gives flat ink —
   * the study's guidance is flat ink below ~24px rendered height (the
   * gradient has nowhere to travel at nav sizes).
   */
  ink?: string
  className?: string
  /**
   * True when a parent already carries the accessible name (e.g. a button
   * with its own aria-label) — renders aria-hidden.
   */
  decorative?: boolean
  /** Accessible name when not decorative. */
  title?: string
}

export function AuroraWordmark({
  variant = 'borealis',
  ink = 'gradient',
  className,
  decorative = false,
  title = 'Aurora Pro',
}: AuroraWordmarkProps) {
  const uid = useId()
  const inkId = `${uid}-ink`
  const glowId = `${uid}-glow`
  const bandsId = `${uid}-bands`
  const coreId = `${uid}-core`
  const gradient = ink === 'gradient'
  const stroke = gradient ? `url(#${inkId})` : ink

  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': title }

  if (variant === 'photon') {
    return (
      <svg viewBox={PHOTON_VIEWBOX} fill="none" className={className} {...a11y}>
        <defs>
          {gradient && (
            // Vertical: green → cyan → violet, an auroral curtain's real
            // color order shifted onto the brand ramp.
            <linearGradient id={inkId} gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="0" y2="238">
              <stop offset="0" stopColor="#6EE7B7" />
              <stop offset="0.45" stopColor="#22D3EE" />
              <stop offset="1" stopColor="#A855F7" />
            </linearGradient>
          )}
          <filter id={glowId} x="-20%" y="-40%" width="140%" height="180%">
            <feGaussianBlur stdDeviation="10" />
          </filter>
          <mask id={bandsId} maskUnits="userSpaceOnUse" x="0" y="0" width="1290" height="250">
            <rect x="0" y="0" width="1290" height="250" fill="#fff" />
            {PHOTON_BANDS.map(({ y, h }) => (
              <rect key={y} x="0" y={y} width="1290" height={h} fill="#000" />
            ))}
          </mask>
          <g id={coreId} stroke={stroke} strokeWidth="36" strokeLinecap="round" strokeLinejoin="round">
            {PHOTON_PATHS.map((d) => <path key={d} d={d} />)}
          </g>
        </defs>
        {/* Unmasked blurred copy below the cut copy: the glow leaks through
            the band gaps, which is the whole point of the cut. */}
        <use href={`#${coreId}`} filter={`url(#${glowId})`} opacity="0.55" />
        <use href={`#${coreId}`} mask={`url(#${bandsId})`} />
      </svg>
    )
  }

  return (
    <svg viewBox={BOREALIS_VIEWBOX} fill="none" className={className} {...a11y}>
      {gradient && (
        <defs>
          <linearGradient id={inkId} gradientUnits="userSpaceOnUse" x1="27" y1="0" x2="1263" y2="0">
            <stop offset="0" stopColor="#C4B5FD" />
            <stop offset="0.42" stopColor="#A855F7" />
            <stop offset="0.72" stopColor="#7C3AED" />
            <stop offset="1" stopColor="#22D3EE" />
          </linearGradient>
        </defs>
      )}
      <g stroke={stroke} strokeWidth="26" strokeLinecap="round" strokeLinejoin="round">
        {BOREALIS_PATHS.map((d) => <path key={d} d={d} />)}
      </g>
    </svg>
  )
}
