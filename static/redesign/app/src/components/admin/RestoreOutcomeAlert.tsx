// Says what came of a database restore when the Admin page's backup panel is
// not there to (restoreOutcome.ts says when that happens). Mounted by App for
// a session that has the admin UI, so a profile with a limit is never shown
// it; it waits until an admin session in this tab has the admin UI again.
// While mounted it also keeps the restore's status read (the restore runs on
// the server, and the tab follows it from wherever the admin is), takes up a
// restore this tab followed before a reload, and with none followed looks for
// one already running.
//
// Kept out of the Admin page's chunk: App loads it with the rest of the app.

import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { useReturnFocus } from '@/lib/returnFocus'
import { FailureText } from './AdminNotes'
import { markRestoreSeen, useRestoreOutcome, useRestoreWatch } from './restoreOutcome'

export function RestoreOutcomeAlert({ accountId }: { accountId: number }) {
  const { outcome, seen } = useRestoreOutcome()
  useRestoreWatch(accountId)
  const returnFocus = useReturnFocus()
  // Said once, and only to the account whose restore it was (another
  // account signed in on this tab never sees it). A backup panel that is up
  // when it lands has said it already (`seen`).
  const open = !!outcome && outcome.accountId === accountId && !seen
  return (
    <AlertDialog open={open} onOpenChange={next => { if (!next) markRestoreSeen() }}>
      <AlertDialogContent {...returnFocus} className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
        {outcome && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display text-[22px] leading-tight">
                {outcome.ok ? 'Restart Aurora now' : `The restore from ${outcome.file} did not go through`}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="text-[15px] leading-relaxed text-ink-2">
                  {outcome.ok
                    ? <p>The database has been restored from {outcome.file}. Until Aurora is restarted, the server goes on working from what it held before the restore, and what people see can be out of date.</p>
                    : <FailureText failure={outcome.failure} />}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              {/* Radix's alert dialog puts the focus on its Cancel: the one
                  answer here is that, or the focus stays behind the dialog. */}
              <AlertDialogCancel className={buttonVariants({ className: 'h-11' })}>OK</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
