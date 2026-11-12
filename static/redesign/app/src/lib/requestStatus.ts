// What a request's status means, in the words the app uses for it wherever
// a request is shown (the search page's rows, the requests page).
//
// The statuses are the server's (internal/models: RequestStatus):
//   pending           made, not yet handed to the downloader
//   pending_approval  over the account's limit: held until an admin says yes
//   processing        handed to the downloader, being fetched
//   available         in the library
//   failed            refused, or it could not be fetched (error_message)

import type { MediaRequest } from '@/lib/api'

export type RequestTone = 'wait' | 'ok' | 'bad'

export const REQUEST_STATUS: Record<MediaRequest['status'], {
  /** The status as a name: a filter, a row's label. */
  label: string
  tone: RequestTone
  /** The status after "Requested · …" on a row of titles that can be asked for. */
  says: string
  /** One sentence under the label on the requests page. */
  note: string
}> = {
  pending: { label: 'Pending', tone: 'wait', says: 'waiting to be sent to the downloader', note: 'Not sent to the downloader yet.' },
  pending_approval: { label: 'Waiting for approval', tone: 'wait', says: 'waiting for an admin to approve it', note: 'Over the limit, so an admin has to say yes.' },
  processing: { label: 'Processing', tone: 'wait', says: 'being fetched', note: 'With the downloader.' },
  available: { label: 'Available', tone: 'ok', says: 'in the library now', note: 'In the library.' },
  failed: { label: 'Failed', tone: 'bad', says: 'it could not be fetched', note: 'It could not be fetched.' },
}

/** The statuses in the order a request moves through them. */
export const REQUEST_STATUSES = ['pending', 'pending_approval', 'processing', 'available', 'failed'] as const
