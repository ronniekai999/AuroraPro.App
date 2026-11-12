// The title's quality in a line of small chips: resolution, HDR, the best
// audio, the number of subtitles. Descriptive, not controls (the actionable
// "Play in" version buttons are DetailView's).

import { cn } from '../../lib/utils'
import type { QualityChip } from '../../lib/detail'

interface QualityChipsProps {
  chips: QualityChip[]
  className?: string
}

export function QualityChips({ chips, className }: QualityChipsProps) {
  if (chips.length === 0) return null
  return (
    <ul aria-label="Quality" className={cn('flex flex-wrap gap-2', className)}>
      {chips.map((c, i) => (
        <li
          key={`${c.kind}-${i}`}
          className="px-2 py-1 rounded-chip border border-line-strong text-[12px] font-semibold text-ink whitespace-nowrap"
        >
          {c.label}
        </li>
      ))}
    </ul>
  )
}
