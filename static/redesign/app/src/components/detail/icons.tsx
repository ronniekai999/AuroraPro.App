// Aurora V2 — inline icons for the DetailView family.
//
// Self-contained so the detail components never import App.tsx's `Icon`
// (imports are one-directional: components never reach back into App).
// These mirror the lucide-style glyphs used in the approved mockups.

type IconProps = { size?: number; className?: string }

const stroke = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className,
})

const fill = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'currentColor',
  className,
})

export function ArrowLeftIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  )
}

export function StarIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...fill(size, className)}>
      <path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z" />
    </svg>
  )
}

export function PlayIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...fill(size, className)}>
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

// counter-clockwise arrow — reads as "restart / from the beginning"
export function RestartIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8" />
      <path d="M3 4v4h4" />
    </svg>
  )
}

export function PlusIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function ListIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export function UsersIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    </svg>
  )
}

export function RefreshIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8" />
      <path d="M3 4v4h4" />
    </svg>
  )
}

export function InfoIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  )
}

// corner-frame — resolution chip
export function ResIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    </svg>
  )
}

// headphones — audio chip
export function AudioIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />
    </svg>
  )
}

// lines — subtitles chip
export function SubsIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M5 7h14M5 12h14M5 17h9" />
    </svg>
  )
}
