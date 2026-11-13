// How the admin page says what came of something: a failure beside the
// control that failed, a result said once in its panel, and a notice that
// stays until it is dismissed, for something the admin still has to do.

import { forwardRef, useCallback, useState } from 'react'
import type { Failure } from './adminFailure'

/** A failure's words: the page's first; the server's own text, when there
 *  is any, as a second line in plain text. Inside a dialog these go in its
 *  own alert region, through ConfirmDialog's `error`. */
export function FailureText({ failure }: { failure: Failure }) {
  return (
    <>
      <p className="text-danger-ink">{failure.says}</p>
      {failure.server && <p className="mt-1 text-[13px] text-ink-2 [overflow-wrap:anywhere]">{failure.server}</p>}
    </>
  )
}

/** A failure, said beside the control that failed. */
export function FailureNote({ failure, className = '' }: { failure: Failure | null; className?: string }) {
  if (!failure) return null
  return (
    <div role="alert" className={`min-w-0 text-[14px] leading-snug ${className}`}>
      <FailureText failure={failure} />
    </div>
  )
}

/** The words for a panel's status line. The same words twice in a row are
 *  still two things said: a status line whose text does not change is not
 *  read out again, so the repeat differs by a trailing space. */
export function useSaid(): [string, (text: string) => void] {
  const [said, setSaid] = useState('')
  const say = useCallback((text: string) => setSaid(prev => (prev === text ? `${text}\u00a0` : text)), [])
  return [said, say]
}

/** A panel's status line: in the page while it says something, and always
 *  there for assistive technology to read what it says next. */
export function StatusLine({ said, className = '' }: { said: string; className?: string }) {
  return <p role="status" className={said ? `text-[14px] leading-snug text-ink ${className}` : 'sr-only'}>{said}</p>
}

/** Something the admin has to do later (restart the server), kept in its
 *  panel until it is dismissed. It takes the focus when a dialog that led to
 *  it closes, so it is focusable without being in the Tab order. */
export const StandingNotice = forwardRef<HTMLDivElement, {
  title: string
  children: React.ReactNode
  onDismiss: () => void
}>(function StandingNotice({ title, children, onDismiss }, ref) {
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-label={title}
      className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 rounded-control border border-line-strong bg-surface-raised-2 p-4"
    >
      <div className="min-w-0 flex-1 basis-[16rem]">
        <p className="text-[15px] font-semibold text-warn">{title}</p>
        <div className="mt-1 text-[14px] leading-snug text-ink-2">{children}</div>
      </div>
      <button type="button" onClick={onDismiss} className="stage-btn stage-btn-sm stage-hit44 stage-btn-quiet flex-none">
        Dismiss{' '}<span className="sr-only">{title}</span>
      </button>
    </div>
  )
})
