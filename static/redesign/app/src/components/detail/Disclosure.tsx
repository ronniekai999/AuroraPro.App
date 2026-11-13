// A panel that opens under its own heading: a title, a one-line summary of
// what is inside while it is closed, and the content. Used for the parts of
// the title page most visits never need (technical media info, admin tools).

import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export function Disclosure({ title, summary, defaultOpen = false, children }: {
  title: string
  summary?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className="rounded-control bg-surface-raised">
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(o => !o)}
          className="stage-disclosure-head w-full min-h-[56px] px-4 sm:px-5 py-2 flex items-center gap-3 text-left rounded-control"
        >
          <span className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-[15px] font-semibold text-ink">{title}</span>
            {summary && <span className="text-[13px] text-ink-2">{summary}</span>}
          </span>
          <ChevronDown
            size={20}
            aria-hidden="true"
            className={`flex-none text-ink-2 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </h2>
      {/* `hidden`, not unmounted: the control's aria-controls keeps pointing
          at a real element, and the content keeps its state across a close. */}
      <div id={id} hidden={!open} className="px-4 sm:px-5 pb-5 pt-1">
        {children}
      </div>
    </div>
  )
}
