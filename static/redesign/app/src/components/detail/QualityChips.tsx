// Aurora V2 — descriptive quality-chip strip (resolution / HDR / audio / subs).
//
// Purely presentational: the chip list is built by deriveQualityChips()
// in lib/detail.ts and passed in. This is NOT the actionable multi-file
// "Play in 4K/1080p" version chooser — that stays in DetailView.

import { cn } from '../../lib/utils'
import type { QualityChip } from '../../lib/detail'
import { ResIcon, AudioIcon, SubsIcon } from './icons'

interface QualityChipsProps {
  chips: QualityChip[]
  className?: string
}

export function QualityChips({ chips, className }: QualityChipsProps) {
  if (chips.length === 0) return null
  return (
    <div className={cn('flex items-center gap-2.5 flex-wrap', className)}>
      {chips.map((c, i) => (
        <span
          key={`${c.kind}-${i}`}
          className={cn(
            'inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-semibold border whitespace-nowrap',
            c.primary
              ? 'bg-purple-500/15 text-purple-100 border-purple-400/30'
              : 'bg-white/[0.06] text-white/85 border-white/10',
          )}
        >
          {c.kind === 'res' && <ResIcon />}
          {c.kind === 'audio' && <AudioIcon />}
          {c.kind === 'subs' && <SubsIcon />}
          {c.label}
        </span>
      ))}
    </div>
  )
}
