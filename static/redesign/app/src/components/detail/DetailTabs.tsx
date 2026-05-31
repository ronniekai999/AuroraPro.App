// Aurora V2 — DetailView underline tab bar (controlled).
//
// A lightweight controlled component, NOT the Radix ui/tabs primitive
// (whose pill skin doesn't match the underline look). Parent owns the
// active id and swaps the content below.

import { cn } from '../../lib/utils'

export interface DetailTab {
  id: string
  label: string
}

interface DetailTabsProps {
  tabs: DetailTab[]
  active: string
  onChange: (id: string) => void
  className?: string
}

export function DetailTabs({ tabs, active, onChange, className }: DetailTabsProps) {
  return (
    <div
      role="tablist"
      className={cn('flex items-center gap-7 border-b border-white/[0.08]', className)}
    >
      {tabs.map((t) => {
        const on = t.id === active
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`detail-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`detail-panel-${t.id}`}
            onClick={() => onChange(t.id)}
            className={cn(
              'relative py-2.5 text-[0.95rem] font-semibold transition-colors',
              on ? 'text-white' : 'text-white/45 hover:text-white/80',
            )}
          >
            {t.label}
            {on && (
              <span className="absolute left-0 right-0 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-purple-500 to-purple-300 shadow-[0_0_12px_rgba(168,85,247,0.7)]" />
            )}
          </button>
        )
      })}
    </div>
  )
}
