// The bug report dialog's place in the app. App decides when it is open
// (the "Report a bug" entries are in the identity panel and on the Me page;
// see hooks/useBugReportEntry); this mounts the dialog while it is, and
// says so in a toast when a report has been filed.
//
// It is mounted for as long as the server takes reports, whatever else is
// on screen: a recording in progress must outlive a player that a watch
// party opens over the page, so nothing here hides or unmounts the dialog
// for another surface.

import { BugReportModal } from './BugReportModal'
import type { BugReportSubmitResult } from '@/lib/api'

interface Props {
  open: boolean
  /** The session changed profile under the open dialog: it closes as soon
   *  as nothing of its own is in flight, and the person is told why. */
  dismissed?: boolean
  onClose: () => void
  /** Fills in "Your name", so a report says who sent it. */
  prefillName?: string
  onToast: (message: string, type: 'success' | 'error' | 'info') => void
  /** The token's health, which the server tells only a session with admin
   *  powers. The dialog warns such a session when it is failing. */
  tokenHealthy?: boolean
  tokenHealthReason?: string
  /** Where the focus goes when the dialog closes and what opened it is no
   *  longer on the page. */
  focusFallback?: () => void
}

export function BugReportHost({ open, dismissed = false, onClose, prefillName, onToast, tokenHealthy, tokenHealthReason, focusFallback }: Props) {
  if (!open) return null
  return (
    <BugReportModal
      prefillName={prefillName}
      dismissed={dismissed}
      // The person closed it (Cancel, Done, Escape): nothing to explain,
      // also while a dismissal was waiting for a send to finish.
      onClose={onClose}
      // The dialog closed itself: it says why, since nothing was pressed,
      // and that a report it was sending did not go, since the refusal it
      // would have shown goes with it.
      onDismissed={(unsent) => {
        const why = 'The bug report was closed because this tab is now on another profile'
        if (unsent) onToast(`${why}, and the report was not sent: ${unsent}`, 'error')
        else onToast(`${why}.`, 'info')
        onClose()
      }}
      // The dialog itself shows the issue's number; the toast is the
      // confirmation that stays when the dialog is closed. No link: the
      // repository is private, and its address is a login wall for most.
      onSubmitted={(result: BugReportSubmitResult) => onToast(`Bug reported as issue #${result.issue_number}. Thank you.`, 'success')}
      tokenHealthy={tokenHealthy}
      tokenHealthReason={tokenHealthReason}
      focusFallback={focusFallback}
    />
  )
}
