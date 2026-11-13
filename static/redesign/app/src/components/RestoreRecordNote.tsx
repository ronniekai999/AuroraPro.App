// What the server recorded of the latest database restore, said where an
// admin will look: the Admin page's backup panel, and the sign-in page, where
// a reload lands while a restore has the database or after one has ended the
// admin's session (hooks/useRestoreRecord, lib/restoreStatus).

import { lostRestoreWords, restoreWords } from '@/lib/restoreStatus'
import type { RestoreRecord } from '@/hooks/useRestoreRecord'

export function RestoreRecordNote({ record, server = null, className = '' }: {
  record: RestoreRecord
  /** The server's own text, as a second line: the Admin page passes it
   *  (restoreServerLine); the sign-in page never does. */
  server?: string | null
  className?: string
}) {
  const { status, lost, unreachable, waiting, dismiss } = record
  // A restore running now is said first, whatever became of a lost ticket.
  const runningNow = status?.state === 'running'
  const words = lost && !runningNow
    ? lostRestoreWords(lost.file, lost.seen === 'running')
    : status
      ? restoreWords(status)
      : waiting
        ? { title: `Asking Aurora about the restore from ${waiting.file}`, says: 'This browser started a restore that has not been heard from since.', urgent: false }
        : null
  if (!words) return null
  // Nothing to put away while it runs, or before the server has said anything.
  const running = runningNow || (!status && !lost && !!waiting)
  return (
    <div
      role="region"
      aria-label={words.title}
      className={`flex flex-wrap items-start justify-between gap-x-6 gap-y-3 rounded-control border border-line-strong bg-surface-raised-2 p-4 text-left ${className}`}
    >
      {/* A live region of its own, so a change of step or the ending is
          read out; the Dismiss button stays out of it. */}
      <div role="status" className="min-w-0 flex-1 basis-[16rem]">
        <p className={`text-[15px] font-semibold ${words.urgent ? 'text-warn' : 'text-ink'}`}>{words.title}</p>
        <p className="mt-1 text-[14px] leading-snug text-ink-2">{words.says}</p>
        {server && !(lost && !runningNow) && <p className="mt-1 text-[13px] text-ink-2 [overflow-wrap:anywhere]">{server}</p>}
        {unreachable && (
          <p className="mt-1 text-[13px] text-ink-2">
            {running ? 'Aurora did not answer just now. Asking again every few seconds.' : 'Aurora did not answer just now.'}
          </p>
        )}
      </div>
      {!running && (
        <button type="button" onClick={dismiss} className="stage-btn stage-btn-sm stage-hit44 stage-btn-quiet flex-none">
          Dismiss{' '}<span className="sr-only">{words.title}</span>
        </button>
      )}
    </div>
  )
}
