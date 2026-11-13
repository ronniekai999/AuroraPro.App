// Admin view + its tabs (libraries, server settings, rooms, requests,
// sessions, flagged, logs, LLM, OAuth, backup/restore), the server
// update panel, and the now-playing widget. Extracted from App.tsx
// (2026-06-17 app split) as the first lazy-loaded view chunk —
// non-admins never fetch this bundle. AdminView is the default export
// (lazy-loaded by App); the tab components are module-private.
// ManualMatchModal is imported from its own module because App also
// uses it (the global manual-identify overlay) and must not pull this
// chunk to get it.

import { useState, useEffect, useCallback, useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/Icon'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import { formatRequestDate } from '@/lib/format'
import { skipCoverage, skipMarkerTotals, formatSkipMarkers } from '@/lib/adminDashboardTiles'
import { castLabel, castRoles, groupCastStreams } from '@/lib/activeStreams'
import ManualMatchModal from './ManualMatchModal'
import { AdminShell, type AdminSection } from './AdminShell'
import { PlaybackHealth } from './PlaybackHealth'
import { SettingRow, SettingSwitch } from '@/components/settings/controls'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useReturnFocus } from '@/lib/returnFocus'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { adminFailure, restoreServerLine, type Failure } from './adminFailure'
import { FailureNote, FailureText, StandingNotice, StatusLine, useSaid } from './AdminNotes'
import { useConfirmedAction } from './useConfirmedAction'
import { backupPanelMounted, beginRestore, clearRestoreOutcome, finishRestore, useRestoreOutcome } from './restoreOutcome'
import { RestoreRecordNote } from '@/components/RestoreRecordNote'
import { useRestoreRecord, type RestoreRecord } from '@/hooks/useRestoreRecord'
import {
  RESTORE_TICKET_HEADER, newRestoreTicket, noteRestoreSeen, putBackRestore, rememberRestore, rememberedRestore, restoreWords,
} from '@/lib/restoreStatus'
import {
  parseReferralOptionsSetting,
  serializeReferralOptions,
  validateReferralOptions,
  referralOptionsFromSummary,
  referralSourceLabel,
  isRemovedSummaryRow,
  hasDeceptiveRunes,
  REFERRAL_OTHER_LABEL,
  type ReferralOption,
} from '@/lib/referral'
import {
  getAdminReferralSummary,
  type AdminReferralSummary,
  APIError,
  NetworkError,
  apiFetchResponse,
  getAdminRestoreStatus,
  approveRequest,
  createInvite,
  createLibrary,
  createRoom,
  deleteLibrary,
  deleteRoom,
  deleteStreamSession,
  deleteUser,
  denyRequest,
  diagnoseSession,
  getAdminDashboard,
  getAdminLLM,
  getAdminOAuth,
  getAIRematchStatus,
  getAllSettings,
  getEmbeddingStatus,
  getSkipMarkerStatus,
  getUpdateStatus,
  listAdminActivity,
  listAdminActivityTypes,
  listAdminLogs,
  listAdminSessions,
  listAdminUsers,
  listFlaggedItems,
  listLibraries,
  getLibraryHealth,
  previewLibraryRetype,
  retypeLibrary,
  listPendingApprovals,
  listRooms,
  manualMatch,
  purgeImageCache,
  scanLibrary,
  startAIRematch,
  testAdminLLM,
  testARRConnection,
  tmdbPosterURL,
  triggerUpdate,
  updateAdminLLM,
  updateAdminOAuth,
  updateSettings,
  updateUserRole,
  type ActiveStreamRow,
  type ActivityEntry,
  type ActivityEventType,
  type AdminUser,
  type AIRematchJobStatus,
  type EmbeddingStatus,
  type Library,
  type LibraryHealthReport,
  type RetypePreview,
  type LLMSettings,
  type LLMTestResult,
  type LogEntry,
  type LogLevelFilter,
  type MediaRequest,
  type OAuthSettings,
  type Room,
  type ServerMediaItem,
  type ServerSettingsMap,
  type ServerStats,
  type SessionDiagnostic,
  type SkipMarkerStatus,
  type UpdateState,
  type UpdateStatus,
} from '@/lib/api'
import { abortAfter } from '@/lib/catalogUpdates'

// server_settings keys for the referral prompt, from migration 046. Named here so
// the editor and the Go whitelist can't drift on a string literal.
const REFERRAL_QUESTION_KEY = 'referral_prompt_question'
const REFERRAL_OPTIONS_KEY = 'referral_prompt_options'

/* ─────────────────────── ADMIN VIEW ─────────────────────── */
// Admin backup + restore card. Backup is a tokenized anchor
// download; restore is a multipart upload guarded by a hard-confirm.
function AdminBackupRestore({ downloadBackup, accountId, record }: {
  downloadBackup: () => Promise<Failure | null>
  /** The signed-in account: a restore's outcome is said to it only. */
  accountId: number
  /** The server's record of the latest restore, read by the page. */
  record: RestoreRecord
}) {
  const [file, setFile] = useState<File | null>(null)
  const [doneBlocked, setDoneBlocked] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState<Failure | null>(null)
  // A refusal that lands after the dialog was left is said by the panel's
  // record of the last restore (below), not a second time by the flow.
  const restoreFlow = useConfirmedAction<File>(f => `restoring the database from ${f.name}`, { lateFailureInPanel: false })
  const [restoreSaid, sayRestore] = useSaid()
  const submitting = restoreFlow.busy
  // What came of the last restore lives outside this panel (restoreOutcome):
  // the restore can end after the panel, or the whole Admin page, has gone.
  // While the panel is up it says it, so the app's alert does not.
  const { outcome, out } = useRestoreOutcome()
  useEffect(() => backupPanelMounted(), [])
  // The server's own record of the latest restore (hooks/useRestoreRecord,
  // read by the page). A restore no longer ends with its request, so after a
  // reload, or for a restore this tab did not start or got no answer for,
  // this is what says it is running or how it went.
  const serverRunning = record.status?.state === 'running'
  const mine = outcome && outcome.accountId === accountId ? outcome : null
  // This tab's own answer, when it is one: Aurora said how the restore went.
  const answered = !!mine && (mine.ok || !mine.lost)
  const recordSays = (!!record.status && record.status.state !== 'none') || !!record.lost || !!record.waiting
  // A record of a failure that touched the database says more than this
  // tab's answer does (that the database is empty, and what to do), so it is
  // said in its place.
  const recordFailedPastWipe = record.status?.state === 'failed' && record.status.database !== 'unchanged'
  // The record is said unless this tab's answer already says the same
  // restore; a restore running now is always said. Not while this tab has a
  // restore out (`out`, which outlives a remount of this panel): its record
  // does not exist until the upload ends.
  const showRecord = out === 0 && recordSays && (serverRunning || !answered || recordFailedPastWipe)
  const restored = mine?.ok ? mine.file : null
  // An outcome that lands while this panel is up is said in its status line,
  // whichever panel sent the restore (the admin may have left the section
  // and come back): the notice itself is not read out.
  const outcomeAtMount = useRef(outcome)
  useEffect(() => {
    if (!outcome || outcome === outcomeAtMount.current || outcome.accountId !== accountId) return
    outcomeAtMount.current = outcome
    if (outcome.ok) sayRestore(`Restored the database from ${outcome.file}. Restart Aurora now.`)
  }, [outcome, accountId, sayRestore])
  // A request that got no answer is said only until the record can say more,
  // and this tab's failure not beside a record of it that says more.
  const lastFailure = mine && !mine.ok && (!mine.lost || !recordSays) && !(showRecord && recordFailedPastWipe) ? mine.failure : null
  const restoreRef = useRef<HTMLButtonElement | null>(null)
  const noticeRef = useRef<HTMLDivElement | null>(null)
  // The restore POST can take minutes — guard against setState after
  // unmount if the admin tabs away mid-upload.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const onSubmit = () => {
    if (!file || submitting || doneBlocked || out > 0 || serverRunning) return
    restoreFlow.ask(file)
  }

  // The dialog stays up while the restore runs (one answer, one upload)
  // until it offers its way out; the outcome goes to restoreOutcome either way.
  const restore = () => restoreFlow.run(async f => {
    // Once the upload is done the server runs the restore to its end,
    // whatever becomes of this page, so nothing holds the page. The ticket
    // is kept before the upload starts: a reload at any point after can
    // still read how the restore went, on the sign-in page too.
    const previous = rememberedRestore()
    const ticket = newRestoreTicket()
    rememberRestore(ticket, f.name)
    beginRestore()
    try {
      const form = new FormData()
      form.append('backup', f)
      const res = await apiFetchResponse('/api/admin/restore', {
        method: 'POST',
        body: form,
        headers: { [RESTORE_TICKET_HEADER]: ticket },
      })
      const ct = res.headers.get('content-type') || ''
      const body = ct.includes('application/json')
        ? await res.json().catch(() => ({}))
        : { error: await res.text().catch(() => '') }
      if (!res.ok) {
        // Extract the actual error message. Aurora's WriteError emits
        // a NESTED shape { error: { code, message } }; legacy paths
        // use a flat string { error: "..." }. Without this extraction,
        // `new Error(body.error)` on the nested shape stringifies the
        // object to literally "[object Object]" — masking the real
        // diagnostic (e.g. "permission denied to create extension").
        let errMsg = `HTTP ${res.status}`
        const errField = (body as Record<string, unknown>).error
        if (typeof errField === 'string') {
          errMsg = errField
        } else if (errField && typeof errField === 'object' && 'message' in errField) {
          const nested = (errField as Record<string, unknown>).message
          if (typeof nested === 'string') errMsg = nested
        }
        // Another restore was running and this one never started: the
        // ticket kept for that one (this browser's, maybe) goes back.
        if (res.status === 409) putBackRestore(ticket, previous)
        // An APIError, so the status reaches the words below.
        throw new APIError(res.status, errMsg, body)
      }
      noteRestoreSeen(ticket, 'succeeded')
      finishRestore({ accountId, file: f.name, ok: true })
      // Lock the button after success.
      if (mountedRef.current) setDoneBlocked(true)
      return null
    } catch (e) {
      console.error('[Aurora] Restore failed', e)
      const { failure, lost } = restoreFailure(e)
      // Aurora answered: this browser knows how it ended.
      if (!lost) noteRestoreSeen(ticket, 'failed')
      finishRestore(lost ? { accountId, file: f.name, ok: false, failure, lost } : { accountId, file: f.name, ok: false, failure })
      return failure
    }
  })

  return (
    <div className="space-y-6">
      {restored && (
        <StandingNotice ref={noticeRef} title="Restart Aurora now" onDismiss={() => { clearRestoreOutcome(); record.dismiss() }}>
          The database has been restored from {restored}. Until Aurora is restarted, the server goes on
          working from what it held before the restore, and what people see can be out of date.
        </StandingNotice>
      )}
      <div className="bg-surface-raised rounded-control p-6">
        <h3 className="text-ink font-semibold mb-2">Database backup</h3>
        <p className="text-ink-2 text-sm mb-4 leading-relaxed">
          Download a binary snapshot of Aurora's database — users, libraries, media items, watch
          parties, progress, settings. Use this before a server migration or as a periodic safety net.
        </p>
        <p className="text-ink-2 text-xs mb-4 leading-relaxed">
          <strong className="text-ink-2">Included:</strong> all Aurora tables except ephemeral
          session state (refresh tokens, scanner progress).
          <br />
          <strong className="text-ink-2">Not included:</strong> the media files themselves and
          Aurora's config file (<code>aurora.env</code>) — copy those manually.
          <br />
          <strong className="text-ink-2">Format:</strong> PostgreSQL custom-format dump (<code>.dump</code>)
          — restorable here or via <code>pg_restore</code> from the command line.
        </p>
        <button
          onClick={() => {
            setDownloadFailed(null)
            void downloadBackup().then(failure => { if (mountedRef.current) setDownloadFailed(failure) })
          }}
          className="stage-btn stage-btn-primary"
        >
          <Icon name="folder" size={16} /> Download backup
        </button>
        <FailureNote failure={downloadFailed} className="mt-3" />
      </div>

      <div className="bg-surface-raised rounded-control p-6">
        <h3 className="text-warn font-semibold mb-2">Database restore</h3>
        <p className="text-ink-2 text-sm mb-3 leading-relaxed">
          Upload a previously-downloaded <code>.dump</code> backup file to restore the database.
        </p>
        <p className="text-warn text-sm mb-3 leading-relaxed pl-3 border-l-2 border-current">
          <strong>Destructive operation.</strong> This OVERWRITES all existing data. After restore
          completes, <strong>Aurora must be restarted</strong> — current connections will see stale
          state until you do.
        </p>
        <p className="text-ink-2 text-xs mb-4 leading-relaxed">
          Once the file is uploaded, the restore runs on the server to its end whether or not this
          page stays open, and this browser shows how it went: here, or on the sign-in page. Restarting
          Aurora stops it, and so does an automatic update: pause <code>aurora-update.timer</code> first.
          While it replaces the data nobody can sign in. It wraps every change in a single transaction: if any
          statement fails, the restore rolls back and the database is left empty, and nobody can sign
          in to restore again from here, so restore a backup from the server's command line before
          restarting Aurora. Legacy <code>.sql.gz</code> backups need to be restored via the
          command line: <code>gunzip &lt; file.sql.gz | psql $DATABASE_URL</code>.
        </p>
        {showRecord && <RestoreRecordNote record={record} server={restoreServerLine(record.status)} className="mb-4" />}
        <div className="flex gap-3 flex-wrap items-center">
          <input
            type="file"
            accept=".dump,application/octet-stream"
            disabled={submitting || doneBlocked || serverRunning || out > 0}
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            className="min-w-0 max-w-full text-sm text-ink-2 file:mr-3 file:px-3 file:py-1.5 file:rounded-chip file:border-0 file:bg-surface-raised-2 file:text-ink file:cursor-pointer hover:file:bg-action-soft"
          />
          <button
            ref={restoreRef}
            onClick={e => {
              // Not every browser focuses a button on a click, and the
              // dialog gives focus back to what had it.
              e.currentTarget.focus()
              onSubmit()
            }}
            disabled={!file || submitting || doneBlocked || serverRunning || out > 0}
            className="stage-btn stage-btn-destructive"
          >
            <Icon name="refresh" size={16} /> {doneBlocked ? 'Restart Aurora to continue' : 'Restore database'}
          </button>
        </div>
        {file && !doneBlocked && (
          <p className="text-ink-2 text-xs mt-2">
            Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
          </p>
        )}
        <StatusLine said={restoreSaid} className="mt-3" />
        <div className="mt-3 empty:hidden">{restoreFlow.panelNotes}</div>
        {/* The last restore's failure, kept in the panel once its dialog is
            put down (or said here first, when the dialog was left): one that
            stopped part way can have left the database empty. */}
        {!restoreFlow.dialog.open && !restoreFlow.busy && <FailureNote failure={lastFailure} className="mt-3" />}
      </div>

      <ConfirmDialog
        {...restoreFlow.dialog}
        error={restoreFlow.dialog.error && <FailureText failure={restoreFlow.dialog.error} />}
        stopWaitingLabel="Close and keep it running"
        title={restoreFlow.asked ? `Restore the database from ${restoreFlow.asked.name}?` : 'Restore the database?'}
        confirmLabel={submitting ? 'Restoring…' : 'Restore database'}
        destructive
        safeFirst
        onConfirm={() => { void restore() }}
        // A restore that finished locks the button that asked: the notice
        // that says to restart takes the focus.
        fallbackFocus={() => noticeRef.current ?? restoreRef.current}
        details={submitting
          ? <p role="status" className="text-[14px] leading-snug text-ink">Uploading and restoring. This can take several minutes. Closing this tab before the upload has finished stops the restore before anything is changed; once it has, the restore goes on without this tab.</p>
          : undefined}
      >
        Everything Aurora holds now is replaced by what is in this file{restoreFlow.asked ? ` (${(restoreFlow.asked.size / 1024 / 1024).toFixed(1)} MB)` : ''}:
        accounts, profiles, libraries, watch history, lists and settings. What is there now cannot be brought
        back except from another backup. Once the file is uploaded the restore runs on the server to its end:
        reloading or closing this tab does not stop it, and this browser shows how it went, here or on the
        sign-in page. Restarting Aurora does stop it, and so does an automatic update, which does not wait for
        it: pause aurora-update.timer first. Everyone is signed out by it. Restart Aurora once it has succeeded;
        if it fails, read what it says before restarting.
      </ConfirmDialog>
    </div>
  )
}

/** What a restore that did not finish is said to have done, and whether
 *  Aurora answered at all (`lost`: the server's record then says more). Where it stopped
 *  decides the database's state: every refusal of the file comes before the
 *  old data is cleared, and a failure of the restore itself comes after. */
function restoreFailure(e: unknown): { failure: Failure; lost: boolean } {
  // Aurora itself never answers a restore with 502, 503 or 504: those come
  // from a proxy in front of it that gave up waiting, while the restore may
  // still be running. They are no answer, not a restore that failed.
  const noAnswer = e instanceof NetworkError || (e instanceof APIError && [502, 503, 504].includes(e.status))
  const lost = 'The connection to the server was lost during the restore. If the upload had finished, the restore goes on on the server without this page: do not restart Aurora until you know how it ended, since a restart stops a restore still running. Admin, under Backup and restore, shows how it ends once Aurora can be asked, and so does the sign-in page in this browser.'
  return {
    lost: noAnswer,
    failure: adminFailure(e, 'restore the database', { 502: lost, 503: lost, 504: lost, 400: 'The server refused this file, and the database was not changed.', 409: 'A backup or restore is already running, so this one did not start. The database was not changed by it. Wait for the other to finish, then try again.', 413: 'The file is too large to restore from here, and the database was not changed.', noAnswer: lost, otherwise: 'The restore did not finish. Depending on where it stopped, the database is either as it was or empty. Read what the server said before going on.' }),
  }
}

function NowPlayingWidget() {
  const [items, setItems] = useState<ActiveStreamRow[]>([])
  const [users, setUsers] = useState<Map<number, string>>(new Map())
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const ss = await listAdminSessions()
        if (cancelled) return
        setItems(ss)
        // Enrich with usernames the first time we see a new user_id.
        const missing = Array.from(new Set(ss.map(s => s.user_id))).filter(uid => !users.has(uid))
        if (missing.length > 0) {
          try {
            const us = await listAdminUsers()
            if (cancelled) return
            const next = new Map(users)
            for (const u of us) next.set(u.id, u.username)
            setUsers(next)
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    void tick()
    const id = window.setInterval(tick, 5000)
    return () => { cancelled = true; window.clearInterval(id) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const nameFor = (s: ActiveStreamRow) => s.username || users.get(s.user_id) || `User ${s.user_id}`
  // One group per VIEWER: a Chromecast's receiver session nests under the
  // local session driving it instead of standing beside it as an identical
  // second row. See lib/activeStreams for the orphan/cycle rules.
  const groups = groupCastStreams(items)
  // One classification for the whole list, so both the parent rows and the
  // nested receiver rows describe the same session the same way.
  const roles = castRoles(items)
  const labelOf = (s: ActiveStreamRow) => castLabel(roles.get(s.id) ?? 'none')
  if (groups.length === 0) return (
    <div className="bg-surface-raised rounded-control p-6">
      <h3 className="text-ink font-semibold mb-2">Now playing</h3>
      <p className="text-ink-2 text-sm">No active streams.</p>
    </div>
  )
  const kindBadge = (s: ActiveStreamRow) => (
    <span className={`badge-glass text-xs ${s.kind === 'transcode' ? 'bg-surface-raised-2 text-warn border-line' : 'bg-surface-raised-2 text-ok border-line'}`}>{s.kind}</span>
  )
  return (
    <div className="bg-surface-raised rounded-control p-6">
      <h3 className="text-ink font-semibold mb-4">Now playing ({groups.length})</h3>
      <div className="space-y-3">
        {groups.map(({ row: s, castRows }) => (
          // The relationship is carried by the TEXT ("Cast receiver for
          // {name}"), because that is what actually reaches assistive tech —
          // the indent and the left border are decoration, and a screen
          // reader would otherwise read two unrelated rows, the very
          // confusion this change exists to end. The <ul>/<li> below groups
          // the receivers of one session; it does not, on its own, tie them
          // to the row above.
          <div key={s.id} className="border-b border-line last:border-0">
            <div className="flex items-center gap-4 py-2">
              {/* The disc's initial is the account's own name's, never the
                  "User 12" fallback's, which would make every unknown account
                  a uniform "U". */}
              <ProfileAvatar name={s.username || users.get(s.user_id) || '?'} memberKey={s.user_id} size={40} />
              <div className="flex-1 min-w-0">
                <p className="text-ink text-sm font-medium truncate">{nameFor(s)}</p>
                <p className="text-ink-2 text-xs truncate">
                  {s.file_name}
                  {s.resolution && ` · ${s.resolution}`}
                  {s.kind === 'direct' && ` · Direct Play`}
                  {/* Every cast-related word comes from castLabel(), never
                      from a condition written here: the rule that cast_held
                      must not read as "casting" is enforced where the strings
                      are produced (lib/activeStreams, castLabels.test.ts),
                      and markup that re-derives it would sit outside that. */}
                  {labelOf(s).detail && ` · ${labelOf(s).detail}`}
                </p>
                {/* The dashboard has no hover affordance, so the badge's
                    explanation rides along for everyone rather than only for
                    the Sessions tab's screen-reader users. */}
                {labelOf(s).description && (
                  <p className="sr-only">{labelOf(s).description}</p>
                )}
              </div>
              {kindBadge(s)}
            </div>
            {castRows.length > 0 && (
              <ul className="list-none m-0 p-0">
                {castRows.map(c => (
                  <li key={c.id} className="flex items-center gap-4 py-2 pl-6 ml-5 border-l border-line">
                    <Icon name="tv" size={16} className="text-ink flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-ink-2 text-sm truncate">
                        Cast receiver for {nameFor(s)}
                        {/* A clone the receiver has not fetched from yet:
                            minted, not yet leased (MarkCastHeld is earned by
                            a real fetch). Usually a blink; a persistent one
                            is a clone the TV never took. */}
                        {!c.cast_held && <span className="text-ink-2"> · connecting</span>}
                      </p>
                      <p className="text-ink-2 text-xs truncate">
                        {c.file_name}
                        {c.resolution && ` · ${c.resolution}`}
                      </p>
                    </div>
                    {kindBadge(c)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────── UpdatePanel ───────────────────────
//
// Self-contained dashboard widget that surfaces the auto-updater
// state and exposes a manual "Check now" trigger.
//
// Backend wiring:
//   - GET  /api/admin/system/update/status — returns the JSON written
//     by scripts/aurora-update.sh into /var/lib/aurora/update-status.json
//   - POST /api/admin/system/update — shells out to
//     `sudo -n systemctl start aurora-update.service`; the actual
//     update runs asynchronously
//
// Polling cadence:
//   - 10 s when in a TERMINAL state (idle / success / failed / unknown)
//   - 2 s while the updater is ACTIVE (checking / updating / building /
//     installing / restarting) so the user sees phase transitions live
// The cadence flips automatically as the state changes.
const ACTIVE_STATES = new Set<UpdateState>(['checking', 'updating', 'building', 'installing', 'restarting'])

function updateStateMeta(state: UpdateState): { label: string; color: string; spinning: boolean } {
  switch (state) {
    case 'checking':      return { label: 'Checking',     color: 'bg-surface-raised-2 text-ink-2 border-line', spinning: true }
    case 'updating':      return { label: 'Pulling',      color: 'bg-surface-raised-2 text-ink-2 border-line', spinning: true }
    case 'building':      return { label: 'Building',     color: 'bg-surface-raised-2 text-warn border-line', spinning: true }
    case 'installing':    return { label: 'Installing',   color: 'bg-surface-raised-2 text-warn border-line', spinning: true }
    case 'restarting':    return { label: 'Restarting',   color: 'bg-surface-raised-2 text-warn border-line', spinning: true }
    case 'success':       return { label: 'Up to date',   color: 'bg-surface-raised-2 text-ok border-line', spinning: false }
    case 'failed':        return { label: 'Failed',       color: 'bg-surface-raised-2 text-danger-ink border-line', spinning: false }
    case 'misconfigured': return { label: 'Misconfigured', color: 'bg-surface-raised-2 text-warn border-line', spinning: false }
    case 'idle':          return { label: 'Up to date',   color: 'bg-surface-raised-2 text-ok border-line', spinning: false }
    case 'unknown':       return { label: 'Not run yet',  color: 'bg-surface-raised-2 text-ink-2 border-line', spinning: false }
    // A state this build has no word for: the server can be newer than the
    // page. Shown as the server names it, not left undefined (which took the
    // whole admin page down when its fields were read).
    default:              return { label: String(state), color: 'bg-surface-raised-2 text-ink-2 border-line', spinning: false }
  }
}

// Render an RFC3339 timestamp as "5 minutes ago" / "just now".
// Kept local instead of importing date-fns because the admin
// dashboard already avoids that dep — keeps the bundle small.
function timeAgo(rfc3339: string): string {
  const then = new Date(rfc3339).getTime()
  if (Number.isNaN(then)) return 'never'
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSec < 5)   return 'just now'
  if (diffSec < 60)  return `${diffSec}s ago`
  const m = Math.floor(diffSec / 60)
  if (m < 60)        return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24)        return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function UpdatePanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [triggering, setTriggering] = useState(false)
  // Tick is a render-counter for "x ago" so the elapsed string
  // updates without having to refetch. Driven by its OWN
  // interval — decoupled from the polling cadence (Audit M2).
  const [, setTick] = useState(0)

  // stateRef mirrors the current update state so the poll
  // interval's tick callback can read the LATEST state without
  // its closure capturing a stale value. Updated whenever status
  // changes.
  const stateRef = useRef<UpdateState>('unknown')
  useEffect(() => {
    if (status) stateRef.current = status.state
  }, [status])

  // Polling: 2s during an active update (live phase transitions),
  // 10s otherwise. Uses a ref-counter for the slow-cadence skip —
  // Date.now()-modulo drifts vs real time and bursts/stalls.
  useEffect(() => {
    let cancelled = false
    const tickRef = { count: 0 }
    const fetchStatus = async () => {
      try {
        const s = await getUpdateStatus()
        if (!cancelled) {
          setStatus(s)
          // Clear any prior transient error. Without this, a single
          // 502 caught during the ~50 ms backend-restart window
          // would stick in the UI forever (until the user navigates
          // away), even though subsequent polls succeed.
          setError(null)
        }
      } catch (e) {
        if (cancelled) return
        // Aurora restarts the service mid-update; a 502 during an
        // ACTIVE state is expected. Suppress transient errors so the
        // dashboard doesn't flash a misleading "HTTP 502".
        if (ACTIVE_STATES.has(stateRef.current)) return
        setError(e instanceof Error ? e.message : 'Failed to read update status')
      }
    }
    void fetchStatus()
    const id = window.setInterval(() => {
      tickRef.count = (tickRef.count + 1) % 5
      const active = ACTIVE_STATES.has(stateRef.current)
      // Active: fetch every 2 s tick. Idle: fetch only when the
      // tick counter wraps back to 0, so every 5th tick = 10 s.
      if (!active && tickRef.count !== 0) return
      void fetchStatus()
    }, 2000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  // Low-rate interval to invalidate the "N min ago" relative string,
  // decoupled from the status-poll cadence.
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => (t + 1) % 1000), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const handleTrigger = useCallback(async () => {
    setError(null)
    setTriggering(true)
    try {
      await triggerUpdate()
      // Optimistically set state to `checking` so the button locks
      // out immediately — without this, fast double-clicks could
      // re-fire the trigger during the script's first-write delay.
      setStatus(prev => ({
        state: 'checking',
        at: new Date().toISOString(),
        message: 'Update requested — pulling latest…',
        old_sha: prev?.new_sha ?? prev?.old_sha ?? null,
        new_sha: null,
      }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to trigger update')
    } finally {
      setTriggering(false)
    }
  }, [])

  if (!status) {
    return (
      <div className="bg-surface-raised rounded-control p-6">
        <h3 className="text-ink font-semibold mb-2">Updates</h3>
        <p className="text-ink-2 text-sm">{error ?? 'Loading update status…'}</p>
      </div>
    )
  }

  const meta = updateStateMeta(status.state)
  const isActive = ACTIVE_STATES.has(status.state)
  const shortSha = (s?: string | null) => (s ? s.slice(0, 7) : null)

  return (
    <div className="bg-surface-raised rounded-control p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-ink font-semibold">Updates</h3>
          <span className={`badge-glass text-xs ${meta.color}`}>
            {meta.spinning && (
              <span className="inline-block w-2 h-2 rounded-full bg-current mr-1.5 animate-pulse" />
            )}
            {meta.label}
          </span>
        </div>
        <button
          type="button"
          onClick={handleTrigger}
          disabled={triggering || isActive}
          className="stage-btn stage-btn-ghost"
          title={isActive ? 'An update is already in progress' : 'Pull, rebuild, restart now'}
        >
          {triggering ? 'Starting…' : isActive ? 'Updating…' : 'Update now'}
        </button>
      </div>

      <div className="space-y-2 text-sm">
        <p className="text-ink">{status.message}</p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
          <span>Last check: {timeAgo(status.at)}</span>
          {shortSha(status.new_sha) && (
            <span className="font-mono">
              {status.state === 'success' ? 'Now at' : 'Target'}: {shortSha(status.new_sha)}
            </span>
          )}
          {shortSha(status.old_sha) && status.old_sha !== status.new_sha && (
            <span className="font-mono">From: {shortSha(status.old_sha)}</span>
          )}
        </div>

        {status.state === 'unknown' && (
          <p className="text-ink-2 text-xs">
            The auto-update timer fires every 5 minutes. If this never populates, run <code className="text-ink bg-surface-raised-2 px-1 rounded-chip">systemctl status aurora-update.timer</code> on the server.
          </p>
        )}

        {error && (
          <p className="text-danger-ink text-xs">{error}</p>
        )}
      </div>
    </div>
  )
}

// Changing a library's type. Deliberately its own component and its own
// two-step flow rather than a select on the row: this DELETES every catalog row
// of the old type — watch progress, watchlist entries and ratings with them —
// and then rescans from disk. A dropdown that saved on change would look like
// renaming the library.
//
// The preview's items_to_delete is echoed back on confirm. If the catalog moved
// in between (a scan finished, another admin acted) the server answers 409 and
// nothing happens, so the number an admin approves is the number that goes.
function RetypeLibraryButton({ lib, onDone, say }: { lib: Library; onDone: () => void; say: (text: string) => void }) {
  // BOTH targets are offered, including the one the library already claims.
  //
  // Offering only the opposite type made the documented repair path unreachable
  // — and on the exact state the runbook is written for it offered the action
  // that UNDOES the fix. After a hand-applied `UPDATE libraries SET type='show'`
  // with movie rows still present, the only button was "Change to Movies", whose
  // preview correctly reported 0 items to delete ("nothing to delete") and whose
  // confirm set the library back to movie. A review found it.
  const [checking, setChecking] = useState(false)
  // A check that could not be made, said beside the buttons. The change it
  // leads to is asked in the dialog, which says a refusal itself.
  const [checkFailed, setCheckFailed] = useState<Failure | null>(null)
  const change = useConfirmedAction<RetypePreview>(p => `changing ${p.library_name} to ${p.target_type === 'show' ? 'TV shows' : 'Movies'}`)
  const preview = change.asked
  const busy = checking || change.busy
  const rowRef = useRef<HTMLDivElement | null>(null)

  const open = async (t: 'movie' | 'show') => {
    // Not `disabled` while it is out: the dialog gives the focus back to the
    // button that asked, and a disabled one cannot take it.
    if (busy) return
    setChecking(true)
    setCheckFailed(null)
    try { change.ask(await previewLibraryRetype(lib.id, t)) }
    catch (e) {
      setCheckFailed(adminFailure(e, `check what changing ${lib.name} would delete`, { read: true, 404: `${lib.name} is no longer on the server.` }))
    }
    finally { setChecking(false) }
  }

  const confirmRetype = () => change.run(async p => {
    try {
      const res = await retypeLibrary(lib.id, p.target_type, p.items_to_delete)
      say(`Deleted ${res.items_deleted} item${res.items_deleted === 1 ? '' : 's'} from ${p.library_name} and started a rescan.`)
      onDone()
      return null
    } catch (e) {
      if (e instanceof APIError && e.status === 404) {
        say(`${p.library_name} is no longer on the server.`)
        onDone()
        return null
      }
      // A 409 here is the interlock doing its job: the count shown is not the
      // count there now (or a scan holds the library), and nothing went.
      return adminFailure(e, `change ${p.library_name}`, { 409: 'Nothing was deleted. The library has changed since it was checked, or a scan of it is running. Cancel, wait for any scan to finish, and check again to see the new figure.', 404: `${p.library_name} is no longer on the server.` })
    }
  })

  const label = (t: 'movie' | 'show') => (t === 'show' ? 'TV shows' : 'Movies')
  return (
    <div ref={rowRef} className="mt-3">
      <div className="flex flex-wrap gap-2.5">
        {(['movie', 'show'] as const).map(t => (
          <button
            key={t}
            onClick={e => { e.currentTarget.focus(); void open(t) }}
            aria-disabled={busy || undefined}
            data-retype={t}
            title={t === lib.type
              ? `Re-apply ${t === 'show' ? 'TV Shows' : 'Movies'}: purges any catalog rows that disagree with the library's type, then rescans`
              : `Change this library to ${t === 'show' ? 'TV Shows' : 'Movies'}`}
            className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost"
          >
            {checking ? 'Checking…' : t === lib.type
              ? `Re-apply ${t === 'show' ? 'TV' : 'Movies'}`
              : `Change to ${t === 'show' ? 'TV' : 'Movies'}`}
          </button>
        ))}
      </div>
      <FailureNote failure={checkFailed} className="mt-2" />
      <div className="mt-2 empty:hidden">{change.panelNotes}</div>
      <ConfirmDialog
        {...change.dialog}
        error={change.dialog.error && <FailureText failure={change.dialog.error} />}
        title={preview
          ? (preview.current_type === preview.target_type
              ? `Re-apply ${label(preview.target_type)} to ${preview.library_name}?`
              : `Change ${preview.library_name} to ${label(preview.target_type)}?`)
          : ''}
        confirmLabel={change.busy ? 'Working…' : preview && preview.items_to_delete === 0 ? 'Change and rescan' : 'Delete and rescan'}
        destructive
        safeFirst
        onConfirm={() => { void confirmRetype() }}
        fallbackFocus={() => rowRef.current?.querySelector<HTMLElement>(`[data-retype="${preview?.target_type ?? lib.type}"]`)}
        details={preview && (
          <div className="text-[14px] leading-snug">
            {preview.casualties && preview.casualties.length > 0 && (
              <ul className="space-y-0.5" aria-label="What is deleted">
                {preview.casualties.map(c => (
                  <li key={c.table} className="text-warn">
                    <span className="tabular-nums">{c.rows}</span> × <span className="font-mono break-all">{c.table}</span>{c.why ? ` — ${c.why}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {preview.items_to_delete === 0 && (
              <p className="text-ink-2">Nothing to delete — this only changes the type and rescans.</p>
            )}
          </div>
        )}
      >
        {preview && <>
          This deletes {preview.items_to_delete} catalog item{preview.items_to_delete === 1 ? '' : 's'} and everything attached to them,
          then rescans from disk. {preview.items_kept > 0 && `${preview.items_kept} item${preview.items_kept === 1 ? '' : 's'} already of the target type ${preview.items_kept === 1 ? 'is' : 'are'} kept. `}
          The files on disk are not touched. There is no undo.
        </>}
      </ConfirmDialog>
    </div>
  )
}

function AdminLibrariesTab() {
  const [items, setItems] = useState<Library[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<'movie' | 'show'>('movie')
  const [newPaths, setNewPaths] = useState('')
  // Metadata-match health (#510). Fetched alongside the list rather than folded
  // into it because /api/libraries is member-visible and this is not. A failure
  // here is swallowed: it is a diagnostic, and losing it must not take the
  // libraries list down with it.
  const [health, setHealth] = useState<LibraryHealthReport | null>(null)
  const [said, say] = useSaid()
  const [addFailed, setAddFailed] = useState<Failure | null>(null)
  // A scan that did not start, said under the row it was asked from.
  const [scanFailed, setScanFailed] = useState<{ id: number; failure: Failure } | null>(null)
  // The library a delete is being asked about, and what came of the answer.
  const del = useConfirmedAction<Library>(lib => `deleting the library ${lib.name}`)
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const confirmDelete = () => del.run(async lib => {
    try {
      await deleteLibrary(lib.id)
      say(`Deleted the library ${lib.name}.`)
      await reload()
      return null
    } catch (e) {
      // Already gone: there is nothing to answer again. The list is read
      // again and says so.
      if (e instanceof APIError && e.status === 404) {
        say(`${lib.name} was already gone from the server.`)
        await reload()
        return null
      }
      return adminFailure(e, `delete ${lib.name}`)
    }
  })
  const reload = useCallback(async () => {
    try { setItems(await listLibraries()) }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
    try { setHealth(await getLibraryHealth()) }
    catch { setHealth(null) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const healthFor = (id: number) => health?.libraries.find(h => h.library_id === id)
  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-control p-5">
        <h3 className="text-ink font-semibold mb-3">Add a library</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input aria-label="Library name" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name" className="px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
          <select aria-label="Library type" value={newType} onChange={e => setNewType(e.target.value as 'movie' | 'show')} className="px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm">
            <option value="movie">Movies</option>
            <option value="show">TV Shows</option>
          </select>
          <input aria-label="Folders on the server, separated by commas" value={newPaths} onChange={e => setNewPaths(e.target.value)} placeholder="/path/to/library (comma-separated for multi)" className="md:col-span-2 px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </div>
        <button
          disabled={!newName || !newPaths || creating}
          onClick={async () => {
            setCreating(true)
            setAddFailed(null)
            try {
              await createLibrary({ name: newName, type: newType, paths: newPaths.split(',').map(s => s.trim()).filter(Boolean) })
              setNewName(''); setNewPaths('')
              await reload()
            } catch (e) {
              setAddFailed(adminFailure(e, 'add the library', { 400: 'The server refused this library.' }))
            } finally { setCreating(false) }
          }}
          className="stage-btn stage-btn-primary mt-3"
        >
          {creating ? 'Adding…' : 'Add'}
        </button>
        <FailureNote failure={addFailed} className="mt-3" />
      </div>
      <div className="bg-surface-raised rounded-control p-5">
        <h3 ref={listHeadingRef} tabIndex={-1} className="text-ink font-semibold mb-3">Libraries on this server</h3>
        <StatusLine said={said} className="mb-3" />
        <div className="mb-3 empty:hidden">{del.panelNotes}</div>
        {err && <p className="text-danger-ink text-sm">{err}</p>}
        {items === null && <p className="text-ink-2 text-sm">Loading…</p>}
        {items && items.length === 0 && <p className="text-ink-2 text-sm">No libraries yet.</p>}
        {health?.install_warning && (
          <div className="mb-3 p-3 rounded-control bg-surface-raised-2 border border-line">
            <p className="text-warn text-xs">{health.install_warning}</p>
          </div>
        )}
        {items && items.map(lib => {
          const h = healthFor(lib.id)
          return (
          <div key={lib.id} className="py-3 border-b border-line last:border-0">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-ink text-sm font-medium truncate">{lib.name}</p>
              <p className="text-ink-2 text-xs truncate">
                {lib.type} · {lib.paths.join(', ')}
                {h && h.items > 0 && (
                  <span className={h.warning ? 'text-warn' : ''}>
                    {' · '}{h.matched}/{h.items} matched ({h.matched_pct}%)
                  </span>
                )}
              </p>
            </div>
            <button
              onClick={async () => {
                setScanFailed(null)
                try { await scanLibrary(lib.id); say(`Started a scan of ${lib.name}.`) }
                catch (e) {
                  setScanFailed({ id: lib.id, failure: adminFailure(e, `start a scan of ${lib.name}`, { 409: `A scan of ${lib.name} is already running.`, 404: `${lib.name} is no longer on the server.` }) })
                }
              }}
              className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost"
            >Scan{' '}<span className="sr-only">{lib.name}</span></button>
            <button
              // While a delete is out, says so through the panel's line and
              // asks nothing: a second question would name the wrong library.
              {...del.openerProps}
              onClick={e => {
                // Not every browser focuses a button on a click, and the
                // dialog gives focus back to what had it.
                e.currentTarget.focus()
                del.ask(lib)
              }}
              className="stage-btn stage-btn-sm stage-hit44 stage-btn-danger"
            >Delete{' '}<span className="sr-only">{lib.name}</span></button>
          </div>
          {scanFailed?.id === lib.id && <FailureNote failure={scanFailed.failure} className="mt-2" />}
          {h?.warning && (
            <p className="mt-2 text-warn text-xs leading-relaxed">{h.warning}</p>
          )}
          <RetypeLibraryButton lib={lib} onDone={() => { void reload() }} say={say} />
          </div>
          )
        })}
      </div>
      <ConfirmDialog
        {...del.dialog}
        error={del.dialog.error && <FailureText failure={del.dialog.error} />}
        title={del.asked ? `Delete the library ${del.asked.name}?` : ''}
        confirmLabel={del.busy ? 'Deleting…' : 'Delete library'}
        destructive
        safeFirst
        onConfirm={() => { void confirmDelete() }}
        // The row that asked goes with the library.
        fallbackFocus={() => listHeadingRef.current}
      >
        Its titles leave Aurora, and with them everyone&rsquo;s watch history, lists and ratings for those
        titles. The files on disk are not touched: adding the folders again brings the titles back, but not
        that history. This cannot be undone.
      </ConfirmDialog>
    </div>
  )
}

// A row of the General settings: its words on the left and one control on
// the right, the control named by the label and described by the line under
// it.
function NumberSetting({ label, desc, min, max, value, onChange }: {
  label: string
  desc: string
  min: number
  max: number
  value: string
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <SettingRow label={label} desc={desc} htmlFor={id} descId={`${id}-desc`}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        aria-describedby={`${id}-desc`}
        onChange={e => onChange(e.target.value)}
        className="w-28 tabular-nums"
      />
    </SettingRow>
  )
}

function SwitchSetting({ label, desc, checked, onChange }: {
  label: string
  desc: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  const id = useId()
  return (
    <SettingRow label={label} desc={desc} labelId={id} descId={`${id}-desc`}>
      <SettingSwitch checked={checked} onChange={onChange} labelledBy={id} describedBy={`${id}-desc`} />
    </SettingRow>
  )
}

// Server admin tab — hosts ops that don't fit a dedicated tab:
// server-settings, image-cache purge, ARR (Radarr/Sonarr) test & save.
function AdminServerSettingsTab() {
  const [settings, setSettings] = useState<ServerSettingsMap | null>(null)
  const [edited, setEdited] = useState<ServerSettingsMap>({})
  const [saving, setSaving] = useState(false)
  // inviteCode state previously lived here for the Server-tab Invite UI.
  // The Invite UI now lives on the Users tab inside AdminView; that
  // component owns its own inviteCode state.
  const [arrTest, setArrTest] = useState<{ svc: string; msg: string } | null>(null)
  // A read of the settings that failed (at the start, or after a save), and
  // a save that failed, said under the Save button that was pressed.
  const [loadFailed, setLoadFailed] = useState<Failure | null>(null)
  const [saveFailed, setSaveFailed] = useState<{ from: 'general' | 'arr'; failure: Failure } | null>(null)
  // The image cache: the question, what came of it, and the line that says so.
  const purgeFlow = useConfirmedAction<true>(() => 'purging the image cache')
  const [purgeSaid, sayPurge] = useSaid()
  const purgeRef = useRef<HTMLButtonElement | null>(null)
  const purge = () => purgeFlow.run(async () => {
    try {
      const r = await purgeImageCache()
      sayPurge(`Purged ${r.files_purged ?? 0} files (${((r.bytes_freed ?? 0) / 1024 / 1024).toFixed(1)} MB freed).`)
      return null
    } catch (e) {
      // A 5xx here is the server's set-up (no image proxy) or its disk, which
      // trying again does not change: no promise that it will.
      return adminFailure(e, 'purge the image cache', { otherwise: 'The server could not purge the image cache.' })
    }
  })
  const reload = useCallback(async () => {
    try { setSettings(await getAllSettings()); setEdited({}); setLoadFailed(null) }
    catch (e) { setLoadFailed(adminFailure(e, 'read the server settings', { read: true })) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const val = (k: string, dflt: string) => (k in edited ? edited[k] : settings?.[k] ?? dflt)
  const setVal = (k: string, v: string) => setEdited(prev => ({ ...prev, [k]: v }))
  const save = async (from: 'general' | 'arr') => {
    if (Object.keys(edited).length === 0) return
    setSaveFailed(null)
    setSaving(true)
    try {
      // Empty ARR API key means "keep existing"; never send '' or
      // we'd overwrite the stored key and silently unhook the ARR.
      const patch: ServerSettingsMap = {}
      for (const [k, v] of Object.entries(edited)) {
        if (k.endsWith('_api_key') && v === '') continue
        patch[k] = v
      }
      if (Object.keys(patch).length === 0) { setEdited({}); return }
      await updateSettings(patch); await reload()
    }
    catch (e) { setSaveFailed({ from, failure: adminFailure(e, 'save the settings', { 400: 'The server refused these settings.' }) }) }
    finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-control p-5">
        <h3 className="text-ink font-semibold mb-3">General</h3>
        <FailureNote failure={loadFailed} className="mb-3" />
        {settings === null ? (loadFailed ? null : <p className="text-ink-2 text-sm">Loading…</p>) : (
          <div>
            <NumberSetting label="Transcode max sessions" desc="Concurrent FFmpeg processes; 0 = unlimited" min={0} max={1000} value={val('transcode_max_sessions', '0')} onChange={v => setVal('transcode_max_sessions', v)} />
            <NumberSetting label="Transcode max sessions per user" desc="Streams one account may hold; 0 = default (3)" min={0} max={100} value={val('transcode_max_sessions_per_user', '0')} onChange={v => setVal('transcode_max_sessions_per_user', v)} />
            <NumberSetting label="Scan interval (seconds)" desc="Default for new libraries; 0 = manual only" min={0} max={86400} value={val('scan_interval_default', '0')} onChange={v => setVal('scan_interval_default', v)} />
            <SwitchSetting label="Now playing broadcast" desc="Stream notifications to admin dashboard" checked={val('now_playing_enabled', 'true') === 'true'} onChange={on => setVal('now_playing_enabled', on ? 'true' : 'false')} />
            <SwitchSetting label="Push notifications" desc="Deliver via browser push services (Google/Apple/Mozilla); payloads are end-to-end encrypted" checked={val('push_enabled', 'true') === 'true'} onChange={on => setVal('push_enabled', on ? 'true' : 'false')} />
            <SwitchSetting label="Filesystem watch" desc="Auto-detect changes between scans" checked={val('filesystem_watch_enabled', 'true') === 'true'} onChange={on => setVal('filesystem_watch_enabled', on ? 'true' : 'false')} />
            <SwitchSetting label="Requests enabled" desc="Users can request titles via Radarr/Sonarr" checked={val('requests_enabled', 'false') === 'true'} onChange={on => setVal('requests_enabled', on ? 'true' : 'false')} />
            <NumberSetting label="Active request quota" desc="Per user; requests over this are held for approval (default 10)" min={1} max={10000} value={val('requests_quota_active', '10')} onChange={v => setVal('requests_quota_active', v)} />
            <NumberSetting label="Daily request quota" desc="Per user, rolling 24h; requests over this are held for approval (default 25)" min={1} max={10000} value={val('requests_quota_daily', '25')} onChange={v => setVal('requests_quota_daily', v)} />
            <button
              disabled={saving || Object.keys(edited).length === 0}
              onClick={() => void save('general')}
              className="stage-btn stage-btn-primary mt-4"
            >{saving ? 'Saving…' : Object.keys(edited).length > 0 ? `Save ${Object.keys(edited).length} change${Object.keys(edited).length === 1 ? '' : 's'}` : 'No changes'}</button>
            {saveFailed?.from === 'general' && <FailureNote failure={saveFailed.failure} className="mt-3" />}
          </div>
        )}
      </div>

      {/* Invite Codes section moved to Admin → Users tab (its natural home).
          See `tab === 'users'` block in AdminView. */}

      <div className="bg-surface-raised rounded-control p-5">
        <h3 className="text-ink font-semibold mb-3">Image cache</h3>
        <p className="text-ink-2 text-xs mb-3">Delete cached TMDB poster/backdrop images. The cache repopulates on demand; useful after rescanning a large library or running out of disk.</p>
        <button
          ref={purgeRef}
          {...purgeFlow.openerProps}
          onClick={e => { e.currentTarget.focus(); purgeFlow.ask(true) }}
          className="stage-btn stage-btn-ghost"
        >Purge image cache</button>
        <StatusLine said={purgeSaid} className="mt-3" />
        <div className="mt-3 empty:hidden">{purgeFlow.panelNotes}</div>
        <ConfirmDialog
          {...purgeFlow.dialog}
          error={purgeFlow.dialog.error && <FailureText failure={purgeFlow.dialog.error} />}
          title="Purge the image cache?"
          confirmLabel={purgeFlow.busy ? 'Purging…' : 'Purge image cache'}
          onConfirm={() => { void purge() }}
          fallbackFocus={() => purgeRef.current}
        >
          Every picture in the server&rsquo;s image cache is deleted from its disk: posters, backdrops, stills,
          cast photos and the rest. Nothing else is: each image is fetched again the next time someone views it,
          so pages show their images more slowly for a while.
        </ConfirmDialog>
      </div>

      <div className="bg-surface-raised rounded-control p-5">
        <h3 className="text-ink font-semibold mb-3">Radarr and Sonarr (requests)</h3>
        {settings && (['radarr', 'radarr_4k', 'sonarr', 'sonarr_4k'] as const).map(svc => {
          const urlKey = `${svc}_url`, keyKey = `${svc}_api_key`
          const label = svc === 'radarr' ? 'Radarr' : svc === 'radarr_4k' ? 'Radarr 4K' : svc === 'sonarr' ? 'Sonarr' : 'Sonarr 4K'
          return (
            <div key={svc} className="border-b border-line last:border-0 py-3">
              <p className="text-ink text-sm mb-2">{label}</p>
              <div className="flex gap-2 flex-wrap">
                <input aria-label={`${label} address`} value={val(urlKey, '')} onChange={e => setVal(urlKey, e.target.value)} placeholder={svc.startsWith('sonarr') ? 'http://sonarr:8989' : 'http://radarr:7878'} className="flex-1 min-w-[200px] px-3 py-1.5 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
                <input type="password" aria-label={`${label} API key`} data-screenshot-exclude="true" defaultValue="" onChange={e => setVal(keyKey, e.target.value)} placeholder={settings[keyKey] ? 'API key (saved)' : 'API key'} className="flex-1 min-w-[200px] px-3 py-1.5 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
                <button
                  onClick={async () => {
                    // The stored key comes back masked (****abcd);
                    // sending the mask to ARR would always 401 and
                    // falsely fail a working integration. Require
                    // the user to retype the key for a Test.
                    const typedKey = edited[keyKey]
                    if (!typedKey) {
                      setArrTest({ svc, msg: 'Type your API key in the field above to test (the saved key is masked).' })
                      return
                    }
                    try {
                      const r = await testARRConnection(svc, val(urlKey, ''), typedKey)
                      // Server returns `connected`, not `ok`.
                      setArrTest({ svc, msg: r.connected ? 'OK · connection succeeded' : `Failed: ${r.error ?? 'unknown'}` })
                    } catch (e) { setArrTest({ svc, msg: 'Failed: ' + (e instanceof Error ? e.message : 'unknown') }) }
                  }}
                  className="stage-btn stage-btn-ghost"
                >Test{' '}<span className="sr-only">{label}</span></button>
              </div>
              <p role="status" className={arrTest?.svc === svc ? `text-xs mt-1 ${arrTest.msg.startsWith('OK') ? 'text-ok' : 'text-danger-ink'}` : 'sr-only'}>{arrTest?.svc === svc ? arrTest.msg : ''}</p>
            </div>
          )
        })}
        {/* Section-scoped Save button. Shares the same `edited` state
            and save() with the top of the panel — operators typing in
            ARR fields shouldn't need to scroll back up. */}
        {settings && (
          <div className="mt-3 pt-3 border-t border-line flex items-center gap-3">
            <button
              disabled={saving || Object.keys(edited).length === 0}
              onClick={() => void save('arr')}
              className="stage-btn stage-btn-primary"
            >{saving ? 'Saving…' : Object.keys(edited).length > 0 ? `Save ${Object.keys(edited).length} change${Object.keys(edited).length === 1 ? '' : 's'}` : 'No changes'}</button>
            <p className="text-ink-2 text-xs">
              Empty API key fields are ignored on save (so the stored key isn't wiped). Use Test first to verify before saving.
            </p>
          </div>
        )}
        {saveFailed?.from === 'arr' && <FailureNote failure={saveFailed.failure} className="mt-3" />}
      </div>
    </div>
  )
}

function AdminRoomsTab() {
  const [items, setItems] = useState<Room[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [said, say] = useSaid()
  const [makeFailed, setMakeFailed] = useState<Failure | null>(null)
  const del = useConfirmedAction<Room>(room => `deleting the room ${room.name}`)
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const confirmDelete = () => del.run(async room => {
    try {
      await deleteRoom(room.id)
      say(`Deleted the room ${room.name}.`)
      await reload()
      return null
    } catch (e) {
      if (e instanceof APIError && e.status === 404) {
        say(`${room.name} was already gone from the server.`)
        await reload()
        return null
      }
      // Rooms are not admin routes: a 403 here is the server's rule that only
      // the room's owner deletes it.
      return adminFailure(e, `delete ${room.name}`, { 403: 'Only the person who made this room can delete it.' })
    }
  })
  const reload = useCallback(async () => {
    try { setItems(await listRooms()) }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }, [])
  useEffect(() => { void reload() }, [reload])
  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-control p-5">
        <h3 className="text-ink font-semibold mb-3">Make a room</h3>
        <p className="text-ink-2 text-xs mb-3">Rooms have a stable code that survives across watch parties. Share the code once; friends can rejoin even after the host leaves.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <input aria-label="Room name" value={name} onChange={e => setName(e.target.value)} placeholder="Room name" className="px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
          <input aria-label="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Description (optional)" className="px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </div>
        <button
          disabled={!name.trim()}
          onClick={async () => { setMakeFailed(null); try { await createRoom({ name: name.trim(), description: desc.trim() || undefined }); setName(''); setDesc(''); await reload() } catch (e) { setMakeFailed(adminFailure(e, 'make the room', { 400: 'The server refused this room.' })) } }}
          className="stage-btn stage-btn-primary mt-3"
        >Make room</button>
        <FailureNote failure={makeFailed} className="mt-3" />
      </div>
      <div className="bg-surface-raised rounded-control p-5">
        <h3 ref={listHeadingRef} tabIndex={-1} className="text-ink font-semibold mb-3">Rooms on this server</h3>
        <StatusLine said={said} className="mb-3" />
        <div className="mb-3 empty:hidden">{del.panelNotes}</div>
        {err && <p className="text-danger-ink text-sm">{err}</p>}
        {items === null && <p className="text-ink-2 text-sm">Loading…</p>}
        {items && items.length === 0 && <p className="text-ink-2 text-sm">No rooms yet.</p>}
        {items && items.map(r => (
          <div key={r.id} className="flex items-center justify-between py-3 border-b border-line last:border-0 gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-ink text-sm font-medium truncate">{r.name} <span className="text-ink font-mono text-xs ml-2">{r.code}</span></p>
              {r.description && <p className="text-ink-2 text-xs truncate">{r.description}</p>}
              {r.active_party_code && (
                // Emit the working `{BASE}p/CODE` URL as an <a> so
                // admins can right-click → copy. Pull the base from
                // Vite's BASE_URL so this stays in lockstep if the
                // SPA mount moves.
                <p className="text-ok text-xs">
                  Live now — join via{' '}
                  <a
                    href={`${import.meta.env.BASE_URL}p/${r.active_party_code}`}
                    className="underline hover:text-ok"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {import.meta.env.BASE_URL}p/{r.active_party_code}
                  </a>
                </p>
              )}
            </div>
            <button
              {...del.openerProps}
              onClick={e => { e.currentTarget.focus(); del.ask(r) }}
              className="stage-btn stage-btn-sm stage-hit44 stage-btn-danger"
            >Delete{' '}<span className="sr-only">{r.name}</span></button>
          </div>
        ))}
      </div>
      <ConfirmDialog
        {...del.dialog}
        error={del.dialog.error && <FailureText failure={del.dialog.error} />}
        title={del.asked ? `Delete the room ${del.asked.name}?` : ''}
        confirmLabel={del.busy ? 'Deleting…' : 'Delete room'}
        destructive
        safeFirst
        onConfirm={() => { void confirmDelete() }}
        fallbackFocus={() => listHeadingRef.current}
      >
        {del.asked && <>Its code, {del.asked.code}, stops working. If a watch party is on in it now, the party ends for everyone in it. This cannot be undone.</>}
      </ConfirmDialog>
    </div>
  )
}

// AdminRequestsTab — the media-request approval queue (carve-out C).
// Lists requests held in 'pending_approval' (parked by the per-user quota
// gate in the Create handler) and lets an admin Approve (→ dispatch to
// Radarr/Sonarr) or Deny (→ mark failed) each one. Self-contained fetch +
// reload, mirroring AdminRoomsTab.
function AdminRequestsTab() {
  const [items, setItems] = useState<MediaRequest[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // The requests with an approve or deny out, so that row's buttons do
  // nothing until it ends. A set, each id removed only by its own request:
  // one id for the list let row B's answer unlock row A while A's approve was
  // still out, and the server's approve checks then writes the status with
  // nothing between, so two could both pass and the title be sent twice.
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set())
  const busyRef = useRef<Set<number>>(new Set())
  const isBusy = (id: number) => busyIds.has(id) || busyRef.current.has(id)
  const reload = useCallback(async () => {
    try { setItems(await listPendingApprovals()); setErr(null) }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }, [])
  useEffect(() => { void reload() }, [reload])

  // What came of an approve or a deny: null when it went through, 'gone'
  // when the request was already gone (the list is read again), else the
  // failure. A deny is answered in its dialog, an approve under its row.
  const act = useCallback(async (id: number, fn: (id: number) => Promise<void>, doing: string): Promise<Failure | null | 'gone'> => {
    busyRef.current.add(id)
    setBusyIds(new Set(busyRef.current))
    try { await fn(id); await reload(); return null }
    catch (e) {
      if (e instanceof APIError && e.status === 404) { await reload(); return 'gone' }
      return adminFailure(e, doing, { 400: 'The server refused this: the request may no longer be waiting for approval.' })
    }
    finally {
      busyRef.current.delete(id)
      setBusyIds(new Set(busyRef.current))
    }
  }, [reload])
  const [said, say] = useSaid()
  const [approveFailed, setApproveFailed] = useState<{ id: number; failure: Failure } | null>(null)
  // The deny's dialog has its own busy flag, apart from the rows' marks:
  // another row's answer must not unlock this dialog.
  const deny = useConfirmedAction<MediaRequest>(req => `denying the request for ${req.title}`)
  const headingRef = useRef<HTMLHeadingElement | null>(null)

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-control p-5">
        <h3 ref={headingRef} tabIndex={-1} className="text-ink font-semibold mb-1">Waiting for approval</h3>
        <p className="text-ink-2 text-xs mb-3">Requests that hit a user's quota are held here. Approve to dispatch to Radarr/Sonarr, or deny to reject.</p>
        <StatusLine said={said} className="mb-2" />
        <div className="mb-2 empty:hidden">{deny.panelNotes}</div>
        {err && <p className="text-danger-ink text-sm">{err}</p>}
        {items === null && <p className="text-ink-2 text-sm">Loading…</p>}
        {items && items.length === 0 && <p className="text-ink-2 text-sm">No requests awaiting approval.</p>}
        {items && items.map(req => {
          const poster = tmdbPosterURL(req.poster_path)
          return (
            <div key={req.id} className="py-3 border-b border-line last:border-0">
            <div className="flex items-center gap-3">
              <div className="w-[44px] h-[66px] rounded-chip overflow-hidden flex-shrink-0 bg-surface-raised-2 flex items-center justify-center">
                {poster ? (
                  <img
                    key={poster}
                    src={poster}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      const img = e.currentTarget as HTMLImageElement
                      img.style.display = 'none'
                      const fallback = img.nextElementSibling as HTMLElement | null
                      if (fallback) fallback.style.display = 'flex'
                    }}
                  />
                ) : null}
                <div
                  className="w-full h-full items-center justify-center"
                  style={{ display: poster ? 'none' : 'flex' }}
                  aria-hidden="true"
                >
                  <Icon name={req.media_type === 'tv' ? 'tv' : 'film'} size={16} className="text-ink-3" />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-ink text-sm font-medium truncate">{req.title}{req.year ? ` (${req.year})` : ''}</p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-ink-2 text-xs uppercase">{req.media_type === 'tv' ? 'TV' : 'Movie'}</span>
                  {req.quality_4k && <span className="badge-glass bg-surface-raised-2 text-ink border border-line text-xs">4K</span>}
                  {req.quality_1080p && <span className="badge-glass bg-surface-raised-2 text-ink-2 border border-line text-xs">1080p</span>}
                  {req.username && <span className="text-ink-2 text-xs">by {req.username}</span>}
                  <span className="text-ink-2 text-xs">{formatRequestDate(req.requested_at)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2.5 flex-shrink-0">
                <button
                  // Not `disabled` while out: a refusal is said beside this
                  // button, and a disabled one drops the focus.
                  aria-disabled={isBusy(req.id) || undefined}
                  onClick={async () => {
                    if (isBusy(req.id)) return
                    setApproveFailed(null)
                    const failure = await act(req.id, approveRequest, `approve the request for ${req.title}`)
                    if (failure === 'gone') say(`The request for ${req.title} was already gone from the server.`)
                    else if (failure) setApproveFailed({ id: req.id, failure })
                    else say(`Approved the request for ${req.title}.`)
                  }}
                  className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost"
                >Approve{' '}<span className="sr-only">{req.title}</span></button>
                <button
                  // Not `disabled` while its own deny is out: the dialog
                  // gives the focus back to it if the deny is refused.
                  {...deny.openerProps}
                  aria-disabled={isBusy(req.id) || deny.busy || undefined}
                  onClick={e => {
                    if (isBusy(req.id)) return
                    e.currentTarget.focus()
                    deny.ask(req)
                  }}
                  className="stage-btn stage-btn-sm stage-hit44 stage-btn-danger"
                >Deny{' '}<span className="sr-only">{req.title}</span></button>
              </div>
            </div>
            {approveFailed?.id === req.id && <FailureNote failure={approveFailed.failure} className="mt-2" />}
            </div>
          )
        })}
      </div>
      <ConfirmDialog
        {...deny.dialog}
        error={deny.dialog.error && <FailureText failure={deny.dialog.error} />}
        title={deny.asked ? `Deny the request for ${deny.asked.title}?` : ''}
        confirmLabel={deny.busy ? 'Denying…' : 'Deny request'}
        cancelLabel="Keep it waiting"
        destructive
        onConfirm={() => {
          void deny.run(async req => {
            const failure = await act(req.id, denyRequest, `deny the request for ${req.title}`)
            if (failure === 'gone') { say(`The request for ${req.title} was already gone from the server.`); return null }
            if (!failure) say(`Denied the request for ${req.title}.`)
            return failure
          })
        }}
        // The row that asked leaves the list with the deny.
        fallbackFocus={() => headingRef.current}
      >
        {deny.asked && <>The request{deny.asked.username ? ` from ${deny.asked.username}` : ''} is closed as denied, and it is not sent to Radarr or Sonarr.</>}
      </ConfirmDialog>
    </div>
  )
}

// One row per SESSION — Diagnose and Stop act on a session, and an operator
// killing a cast needs to reach the receiver's clone and the local player's
// session separately. Grouping only orders and indents them, and carries each
// row's cast label along so the markup never re-derives one.
function sessionRows(items: ActiveStreamRow[]) {
  const roles = castRoles(items)
  const labelFor = (s: ActiveStreamRow) => castLabel(roles.get(s.id) ?? 'none')
  return groupCastStreams(items).flatMap(g => [
    { s: g.row, isCastRow: false, label: labelFor(g.row) },
    ...g.castRows.map(c => ({
      s: c,
      // Nested under its source in THIS table. Distinct from "is a receiver",
      // which is the role's business: a receiver whose source is missing or
      // unpaired renders top-level and still gets the Cast badge.
      isCastRow: true,
      label: labelFor(c),
    })),
  ])
}

function AdminSessionsTab() {
  const [items, setItems] = useState<ActiveStreamRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // The diagnostic dialog, filled when Diagnose is pressed on a transcode
  // row: FFmpeg's stderr and each variant's state, so a "variant start
  // failed" can be read here and not in the syslog.
  const [diag, setDiag] = useState<SessionDiagnostic | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagErr, setDiagErr] = useState<string | null>(null)
  // Which request the dialog is waiting for. Closing it, or asking about
  // another stream, moves this on, and an answer for an earlier one is
  // dropped: it used to open the dialog again after it had been closed.
  const diagAsked = useRef(0)
  // Focus goes back to the Diagnose button that was pressed. The list is
  // read again every five seconds, and a stream that ended meanwhile takes
  // its row, and that button, away: Refresh is always there.
  const refreshRef = useRef<HTMLButtonElement | null>(null)
  const diagFocus = useReturnFocus(() => refreshRef.current)
  const closeDiagnose = () => {
    diagAsked.current++
    setDiag(null); setDiagErr(null); setDiagLoading(false)
  }
  // The stream a stop is being asked about, and what came of the answer.
  const stop = useConfirmedAction<ActiveStreamRow>(row => `stopping the stream of ${row.file_name}`)
  const [said, say] = useSaid()
  const reload = useCallback(async () => {
    try { setItems(await listAdminSessions()) }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }, [])
  useEffect(() => { void reload(); const id = window.setInterval(() => void reload(), 5000); return () => window.clearInterval(id) }, [reload])
  const openDiagnose = useCallback(async (sessionID: string) => {
    const asked = ++diagAsked.current
    setDiag(null); setDiagErr(null); setDiagLoading(true)
    try {
      const answer = await diagnoseSession(sessionID)
      if (diagAsked.current !== asked) return
      setDiag(answer)
    } catch (e) {
      if (diagAsked.current !== asked) return
      setDiagErr(e instanceof Error ? e.message : 'failed')
    }
    setDiagLoading(false)
  }, [])
  const confirmStop = () => stop.run(async s => {
    try {
      await deleteStreamSession(s.id)
      say(`Stopped the stream of ${s.file_name}.`)
      await reload()
      return null
    } catch (e) {
      if (e instanceof APIError && e.status === 404) {
        say(`The stream of ${s.file_name} had already ended.`)
        await reload()
        return null
      }
      return adminFailure(e, 'stop the stream')
    }
  })
  return (
    <div className="bg-surface-raised rounded-control p-5">
      <StatusLine said={said} className="mb-3" />
      <div className="mb-3 empty:hidden">{stop.panelNotes}</div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-ink-2 text-sm">Everything playing right now, and how the server is delivering it.</p>
        <button ref={refreshRef} type="button" onClick={() => void reload()} className="stage-btn stage-btn-sm stage-hit44 stage-btn-quiet flex-none">Refresh</button>
      </div>
      {/* Active streams now span BOTH kinds (transcode + direct-play).
          The Kind column tells operators which pipeline is serving
          the stream; Stop is only available for transcode sessions
          (direct-play has no FFmpeg process to terminate — it
          expires from the registry after 60s of no byte-serves). */}
      {err && <p className="text-danger-ink text-sm">{err}</p>}
      {items === null && <p className="text-ink-2 text-sm">Loading…</p>}
      {items && items.length === 0 && <p className="text-ink-2 text-sm">No active streams.</p>}
      {items && items.length > 0 && (
        // Seven columns do not fit a phone. The table scrolls sideways inside
        // its panel; it used to push the whole page 950px wide.
        <div className="overflow-x-auto">
        <table className="data-table w-full min-w-[44rem]">
          <thead>
            <tr><th>Session</th><th>Kind</th><th>User</th><th>File</th><th>Detail</th><th>Started</th><th></th></tr>
          </thead>
          <tbody>
            {/* One <tr> per SESSION — Diagnose and Stop act on a session, and an
                operator killing a cast needs to reach the receiver's clone
                and the local player's session separately. Grouping only
                orders and indents them: a receiver's clone sits directly
                under the session it was cloned from, so the two rows a cast
                produces read as one cast instead of a duplicate. */}
            {sessionRows(items).map(({ s, isCastRow, label }) => {
              const isTranscode = s.kind === 'transcode'
              return (
                <tr key={s.id}>
                  <td className="font-mono text-xs">
                    {/* The glyph carries the nesting visually; the sr-only
                        text carries it for everyone else. Without the
                        second half a screen reader gets two adjacent,
                        unrelated-looking sessions — the same confusion this
                        grouping exists to end. */}
                    {isCastRow && <span className="text-ink-3 mr-1" aria-hidden="true">└</span>}
                    {isCastRow && <span className="sr-only">Cast receiver for the session above: </span>}
                    {s.id.slice(0, 10)}
                  </td>
                  <td>
                    <span className={`inline-block px-2 py-0.5 rounded-chip text-xs font-medium ${
                      isTranscode
                        ? 'bg-surface-raised-2 text-warn border border-line'
                        : 'bg-surface-raised-2 text-ok border border-line'
                    }`}>
                      {isTranscode ? 'Transcode' : 'Direct'}
                    </span>
                    {/* Every word here comes from castLabel(), keyed off the
                        row's role rather than off a condition re-derived in
                        markup — the rule that cast_held must never read as
                        "casting" is enforced where those strings are produced
                        (lib/activeStreams, castLabels.test.ts), and a
                        condition written here would sit outside it.

                        "Cast" is provable from cast_clone_of: the row is a
                        clone CloneForCast made for a receiver, so killing it
                        stops the TV while killing its source does not.
                        "Lease" is all cast_held supports on its own — it is
                        not evidence of a receiver at all.

                        The explanation is sr-only text rather than a `title`,
                        which never reaches a keyboard or a screen reader on a
                        non-focusable span. */}
                    {label.badge && (
                      <span className={`ml-1 inline-block px-2 py-0.5 rounded-chip text-xs font-medium ${
                        label.badge === 'Cast'
                          ? 'bg-surface-raised-2 text-ink border border-line'
                          : 'bg-surface-raised-2 text-ink-2 border border-line'
                      }`}>
                        {label.badge}
                        <span className="sr-only"> {label.description}</span>
                      </span>
                    )}
                  </td>
                  <td>{s.username || s.user_id}</td>
                  <td className="max-w-[280px] truncate" title={s.file_name}>{s.file_name}</td>
                  <td>
                    {isTranscode ? (
                      <>
                        {s.resolution && <span className="text-ink-2 text-xs">{s.resolution}</span>}
                        {s.remux && <span className="ml-1 text-ink-2 text-xs">remux</span>}
                        {s.active_variants && s.active_variants.length > 0 && (
                          <span className="ml-1 text-ink-2 text-xs">({s.active_variants.join(', ')})</span>
                        )}
                      </>
                    ) : (
                      // QA review fix — `decision` is hard-coded to
                      // "direct_play" in all three Touch call sites,
                      // so the previous "direct_stream" branch was
                      // dead code. If remux (direct_stream) ever
                      // wires through to the registry, restore the
                      // conditional here.
                      <span className="text-ink-2 text-xs">Direct play</span>
                    )}
                  </td>
                  <td className="text-ink-2 text-xs">{new Date(s.started_at).toLocaleTimeString()}</td>
                  <td>
                    {isTranscode ? (
                      <div className="flex items-center gap-2.5">
                        <button onClick={() => void openDiagnose(s.id)} className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost" title="Show FFmpeg stderr and variant state">Diagnose</button>
                        <button
                          {...stop.openerProps}
                          onClick={e => { e.currentTarget.focus(); stop.ask(s) }}
                          className="stage-btn stage-btn-sm stage-hit44 stage-btn-danger"
                        >Stop{' '}<span className="sr-only">the stream of {s.file_name}</span></button>
                      </div>
                    ) : (
                      // Direct-play has no FFmpeg lifecycle to terminate.
                      // The registry GCs after 60s of no byte-serves; an
                      // explicit Stop button would mislead operators.
                      <span className="text-ink-2 text-xs" title="Direct-play sessions auto-expire when the client stops requesting bytes">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}

      <ConfirmDialog
        {...stop.dialog}
        error={stop.dialog.error && <FailureText failure={stop.dialog.error} />}
        title={stop.asked ? `Stop ${stop.asked.username || `user ${stop.asked.user_id}`}'s stream?` : ''}
        confirmLabel={stop.busy ? 'Stopping…' : 'Stop stream'}
        destructive
        onConfirm={() => { void confirmStop() }}
        // The row goes when the stream does.
        fallbackFocus={() => refreshRef.current}
      >
        {stop.asked && <>The server stops transcoding {stop.asked.file_name} now. Whoever is watching it loses that stream; their player may start a new one.</>}
      </ConfirmDialog>

      {/* What FFmpeg is doing for one stream. The app's dialog: focus
          stays inside, Escape and Close leave, and focus goes back to the
          row's Diagnose button. */}
      <Dialog
        open={!!(diag || diagLoading || diagErr)}
        onOpenChange={open => { if (!open) closeDiagnose() }}
      >
        <DialogContent
          {...diagFocus}
          overlayClassName="z-[80]"
          className="z-[81] block max-h-[80vh] w-[calc(100%-2rem)] overflow-y-auto overscroll-contain border-0 p-5 sm:max-w-3xl"
        >
            <DialogTitle className="mb-3 pr-10 font-display text-[20px] font-semibold leading-tight text-ink">Session diagnostic</DialogTitle>
            <DialogDescription className="sr-only">What the server is running for this stream.</DialogDescription>
            {diagLoading && <p role="status" className="text-ink-2 text-sm">Loading…</p>}
            {diagErr && <p role="alert" className="text-danger-ink text-sm">{diagErr}</p>}
            {diag && (
              <div className="space-y-3 font-mono text-xs">
                <div>
                  <div className="text-ink-2">Session</div>
                  <div className="text-ink break-all">{diag.session_id}</div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-ink-2">Source codec</div>
                    <div className="text-ink">{diag.source_video_codec || '—'}</div>
                  </div>
                  <div>
                    <div className="text-ink-2">Hardware acceleration</div>
                    <div className="text-ink">{diag.hw_accel}</div>
                  </div>
                  <div>
                    <div className="text-ink-2">Mode</div>
                    <div className="text-ink">{diag.remux ? 'remux' : 'transcode'}</div>
                  </div>
                  <div>
                    <div className="text-ink-2">File path</div>
                    <div className="text-ink break-all">{diag.file_path}</div>
                  </div>
                </div>
                <div>
                  <div className="text-ink-2 mb-1">Variants ({diag.variants?.length || 0})</div>
                  <div className="space-y-2">
                    {diag.variants?.map((v) => (
                      <div key={v.profile} className="border border-line rounded-control p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-ink font-medium">{v.profile}</span>
                          {v.started && !v.exited && <span className="px-1.5 py-0.5 text-xs rounded-chip bg-surface-raised-2 text-ok border border-line">running</span>}
                          {v.exited && <span className="px-1.5 py-0.5 text-xs rounded-chip bg-surface-raised-2 text-danger-ink border border-line">exited</span>}
                          {(v.restart_attempts ?? 0) > 0 && <span className="text-ink-2">restarts={v.restart_attempts}</span>}
                        </div>
                        {v.error && (
                          <div className="mb-1">
                            <div className="text-ink-2">error</div>
                            <div className="text-danger-ink whitespace-pre-wrap break-words">{v.error}</div>
                          </div>
                        )}
                        {v.stderr_tail && (
                          <div>
                            <div className="text-ink-2">ffmpeg stderr tail</div>
                            <pre className="text-ink-2 whitespace-pre-wrap break-words bg-surface-page rounded-chip p-2 max-h-64 overflow-y-auto">{v.stderr_tail}</pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** How long after a dialog closed on a match in flight the list is read a
 *  second time: long enough for a server that was a moment from done. */
const REREAD_AFTER_MS = 4000

function AdminFlaggedTab() {
  const [items, setItems] = useState<ServerMediaItem[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // The item whose match dialog is open.
  const [matchTarget, setMatchTarget] = useState<ServerMediaItem | null>(null)
  // What the last match did, said in the list's status line. The dialog
  // closes and the row leaves the list, so without it nothing says a match
  // was saved.
  // `sure` is a match the server confirmed. Anything else is said in plain
  // ink: the colour of success on "may or may not have been saved" reads as
  // success.
  const [said, setSaid] = useState<{ text: string; sure: boolean }>({ text: '', sure: false })
  // The same words twice in a row (two items with one title) are still two
  // things said: a status line whose text does not change is not read out
  // again, so the repeat differs by a trailing space.
  const say = (text: string, sure: boolean) => setSaid(prev => ({ text: prev.text === text ? `${text}\u00a0` : text, sure }))
  const listRef = useRef<HTMLDivElement | null>(null)
  // After a read of the list that followed a match of `id`. Closing the
  // dialog gives the focus back to that item's Match button; the read then
  // takes the row away, and the list takes the focus when the row has gone
  // and the focus with it. It is asked once per such read, when the read
  // has landed and only if the focus was in that row at that moment, so
  // nothing is left set to move the focus at some later reload, and the
  // focus is not taken from someone who has put it elsewhere meanwhile (a
  // click into the page to read, four seconds on). The page is not
  // scrolled for it.
  const [handBack, setHandBack] = useState<{ id: number } | null>(null)
  const itemsRef = useRef(items)
  useLayoutEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => {
    if (!handBack) return
    const now = itemsRef.current
    if (!now || now.some(it => it.id === handBack.id)) return
    if (!document.activeElement || document.activeElement === document.body) listRef.current?.focus({ preventScroll: true })
  }, [handBack])
  // Called when a read has landed and before it is drawn: the row is still
  // in the page if it was.
  const handBackIfInRow = (id: number) => {
    const row = listRef.current?.querySelector(`[data-flagged="${id}"]`)
    if (row?.contains(document.activeElement)) setHandBack({ id })
  }
  // The second read after the dialog was closed on a match in flight.
  const rereadTimer = useRef<number | null>(null)
  useEffect(() => () => { if (rereadTimer.current !== null) window.clearTimeout(rereadTimer.current) }, [])
  // 2026-05-26 — AI re-matcher job status. Polled while a job is
  // active so the operator sees live progress; falls back to
  // single-shot fetch when no job is running. acceptingId tracks the
  // item whose Accept-suggestion button is in flight so we can show
  // a per-row spinner state rather than a global one.
  const [aiJob, setAiJob] = useState<AIRematchJobStatus | null>(null)
  const [aiEnabled, setAiEnabled] = useState<boolean>(true)
  const [aiStarting, setAiStarting] = useState(false)
  const [acceptingId, setAcceptingId] = useState<number | null>(null)
  // A sweep that did not start, said under its button; an accept that was
  // refused, said under that item's suggestion.
  const [startFailed, setStartFailed] = useState<Failure | null>(null)
  const [acceptFailed, setAcceptFailed] = useState<{ id: number; failure: Failure } | null>(null)

  // 2026-05-27 (deep-debug Bug 1 fix) — polling refs lifted out of the
  // mount-only effect so startJob can restart the recursive chain.
  // Previously the polling chain only kicked off if a job was active at
  // mount time. Clicking "Re-match with AI" later created a job but no
  // setTimeout existed to advance it — the progress card froze at the
  // initial snapshot. Now both the mount effect AND startJob route
  // through pollOnce(), which schedules itself recursively when the
  // server reports an active job.
  const pollTimerRef = useRef<number | null>(null)
  const pollCancelledRef = useRef(false)

  // Reads are numbered as they start, and one that lands after a
  // later-started read has landed is dropped: two can be out at once (the
  // read after a dialog closed mid-match and the one four seconds on; the
  // sweep's poll), and the older answer must not go up over the newer.
  const readStarted = useRef(0)
  const readLanded = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++readStarted.current
    try {
      const list = await listFlaggedItems()
      if (mine < readLanded.current) return
      readLanded.current = mine
      setItems(list)
      setErr(null)
    }
    catch (e) {
      // A failure lands by the same rule as an answer: not over a newer
      // read's list, and a newer read that succeeds takes it down.
      if (mine < readLanded.current) return
      readLanded.current = mine
      setErr(e instanceof Error ? e.message : 'failed')
    }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const pollOnce = useCallback(async () => {
    try {
      const s = await getAIRematchStatus()
      if (pollCancelledRef.current) return
      setAiEnabled(s.enabled)
      setAiJob(s.job ?? null)
      const active = s.job && (!s.job.finished_at || s.job.finished_at.startsWith('0001'))
      if (active) {
        // Refresh the items list too — newly-suggested rows appear
        // in the response as the worker progresses.
        void reload()
        // Clear any prior timer before scheduling, so a click during a
        // running poll doesn't fan out into multiple parallel chains.
        if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current)
        pollTimerRef.current = window.setTimeout(() => void pollOnce(), 5000)
      }
    } catch { /* ignore — non-fatal panel */ }
  }, [reload])

  // Pull job status on mount + start polling if a job is already active.
  // The recursive chain in pollOnce keeps going until finished_at is set.
  useEffect(() => {
    pollCancelledRef.current = false
    void pollOnce()
    return () => {
      pollCancelledRef.current = true
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [pollOnce])

  const startJob = useCallback(async () => {
    setAiStarting(true)
    setStartFailed(null)
    try {
      await startAIRematch()
      // Re-enter the poll chain so the progress card advances. Without
      // this call the first setTimeout never gets scheduled and the
      // operator sees a frozen progress bar (deep-debug Bug 1).
      void pollOnce()
    } catch (e) {
      setStartFailed(adminFailure(e, 'start the AI re-match', { 409: 'A re-match is already running.', 503: 'AI matching is not turned on for this server.' }))
    } finally { setAiStarting(false) }
  }, [pollOnce])

  // Accept the AI's suggestion for one item — one click reuses the
  // existing /api/media/{id}/match endpoint with the suggested TMDB
  // id, which is exactly what the operator would do in the manual
  // match modal (just without the search step). Optimistically drops
  // the item from the local list; reload() catches the
  // server-authoritative state on the next pass.
  const acceptSuggestion = useCallback(async (item: ServerMediaItem) => {
    if (!item.ai_suggested_tmdb_id) return
    setAcceptingId(item.id)
    setAcceptFailed(null)
    try {
      await manualMatch(item.id, { tmdb_id: item.ai_suggested_tmdb_id, type: item.type })
      setItems(prev => prev ? prev.filter(i => i.id !== item.id) : prev)
    } catch (e) {
      setAcceptFailed({ id: item.id, failure: adminFailure(e, `accept the suggestion for ${item.title}`, { 404: `${item.title} is no longer on the server.` }) })
    } finally { setAcceptingId(null) }
  }, [])

  const jobActive = !!aiJob && (!aiJob.finished_at || aiJob.finished_at.startsWith('0001'))
  const jobProgress = aiJob && aiJob.total > 0 ? Math.round((aiJob.processed / aiJob.total) * 100) : 0
  // 2026-05-27 (deep-debug Bug 2) — distinguish eval pass from retry
  // pass for the operator. Bar hits 100% when processed === total (eval
  // pass done), but the retry pass keeps running afterwards bumping
  // Retried/RetryMatched without advancing Processed. Without this
  // label the progress card looks "stuck at 100% while running" — a
  // confusing UX. The retry pass typically lasts seconds; this label
  // explains why the bar is frozen while the job is still active.
  const inRetryPhase = jobActive && aiJob && aiJob.total > 0 && aiJob.processed >= aiJob.total

  return (
    <div className="bg-surface-raised rounded-control p-5">
      {/* The words over the button on a phone: side by side there, the
          words were a narrow column beside it. */}
      <div className="mb-3 flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-ink-2 text-sm">
            Media files that the scanner couldn't auto-match against a TMDB/TVDB record.
            The AI matcher auto-promotes high-confidence picks and suggests sub-threshold
            ones for one-click approval below. Use "Match" to manually search if neither
            applies.
          </p>
        </div>
        {aiEnabled && (
          <button
            onClick={() => void startJob()}
            disabled={aiStarting || jobActive}
            title={jobActive ? 'A rematch job is already running' : 'Re-evaluate every flagged item with AI'}
            className="stage-btn stage-btn-sm stage-hit44 stage-btn-primary flex-shrink-0"
          >
            {aiStarting ? 'Starting…' : jobActive ? 'AI sweep running' : 'Re-match with AI'}
          </button>
        )}
      </div>
      <FailureNote failure={startFailed} className="mb-3" />

      {/* AI job progress card — shown while a job is active OR for ~30s
          after completion so the operator sees the final result.
          Counts: processed/total + matched (auto-promoted) + suggested
          (sub-threshold, awaiting approval) + failed (LLM/parse errors). */}
      {aiJob && (
        <div className="mb-4 p-3 rounded-control bg-surface-raised-2 border border-line">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-ink text-xs font-medium">
              {jobActive
                ? (inRetryPhase
                    ? `AI retry pass running… (${aiJob.retried ?? 0} re-attempted)`
                    : `AI re-matching… ${aiJob.processed}/${aiJob.total}`)
                : `AI sweep complete (${aiJob.processed}/${aiJob.total})`}
            </p>
            <p className="text-ink-2 text-xs">
              auto-matched <span className="text-ok font-mono">{aiJob.matched}</span>
              {' · '}
              suggested <span className="text-ink font-mono">{aiJob.suggested}</span>
              {aiJob.failed > 0 && <>{' · '}failed <span className="text-warn font-mono">{aiJob.failed}</span></>}
              {/* Retry pass: items where confidence ≥ threshold but
                  EnrichByTMDBID failed at eval time. Server tries
                  again with no new LLM call. Only render the counter
                  when the pass actually touched something so jobs
                  with no stuck items don't show a noisy "+0 retry". */}
              {(aiJob.retried ?? 0) > 0 && (
                <>{' · '}retry-recovered <span className="text-ok font-mono">{aiJob.retry_matched ?? 0}</span><span className="text-ink-2">/{aiJob.retried}</span></>
              )}
            </p>
          </div>
          <div className="h-1 rounded-full bg-[var(--track)] overflow-hidden">
            <div
              className="h-full bg-action transition-[width]"
              style={{ width: `${jobProgress}%` }}
            />
          </div>
        </div>
      )}

      <p role="status" className={said.text ? `mb-2 text-sm leading-snug ${said.sure ? 'text-ok' : 'text-ink'}` : 'sr-only'}>{said.text}</p>
      {err && <p className="text-danger-ink text-sm">{err}</p>}
      {items === null && <p className="text-ink-2 text-sm">Loading…</p>}
      {/* Takes the focus when the row that had it leaves the list. The
          line for an empty list is inside it, so that focus never lands on
          a group with nothing in it. */}
      <div ref={listRef} tabIndex={-1} aria-label="Flagged items" role="group" className="rounded-control">
      {items && items.length === 0 && <p className="text-ink-2 text-sm">Nothing flagged — your library is clean.</p>}
      {items && items.map(it => {
        const hasSuggestion = !!it.ai_suggested_tmdb_id
        const confidence = it.ai_match_confidence ?? 0
        const evaluated = !!it.ai_match_ran_at
        return (
          <div key={it.id} data-flagged={it.id} className="py-3 border-b border-line last:border-0">
            <div className="flex items-start gap-3">
              <span className="text-warn text-xs uppercase font-semibold flex-shrink-0">{(it.match_status || 'flagged').replace(/_/g, ' ')}</span>
              <div className="min-w-0 flex-1">
                <p className="text-ink text-sm font-medium truncate">{it.title}{it.year ? ` (${it.year})` : ''}</p>
                <p className="text-ink-2 text-xs truncate">{it.file_path}</p>
              </div>
              <button
                onClick={() => setMatchTarget(it)}
                className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost flex-shrink-0"
              >
                Match{' '}<span className="sr-only">{it.title}</span>
              </button>
            </div>
            {/* AI suggestion strip — only when the matcher has a real
                pick to surface. Evaluated-with-no-suggestion items get
                a quieter inline note further down. */}
            {hasSuggestion && (
              <div className="ml-[88px] mt-2 p-2.5 rounded-chip bg-surface-raised-2 border border-line flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-ink text-xs">
                    <span className="font-semibold">AI suggests:</span>{' '}
                    <span className="text-ink">
                      {it.ai_suggested_title || `TMDB ${it.ai_suggested_tmdb_id}`}
                      {it.ai_suggested_year ? ` (${it.ai_suggested_year})` : ''}
                    </span>
                    <span className="ml-2 px-1.5 py-0.5 rounded-chip bg-surface-raised-2 text-ink text-xs font-mono">
                      {confidence}% confident
                    </span>
                  </p>
                  {it.ai_match_reasoning && (
                    <p className="text-ink-2 text-xs mt-1 leading-snug">{it.ai_match_reasoning}</p>
                  )}
                </div>
                <button
                  disabled={acceptingId === it.id}
                  onClick={() => void acceptSuggestion(it)}
                  className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost flex-shrink-0"
                >
                  {acceptingId === it.id ? 'Accepting…' : 'Accept'}
                </button>
              </div>
            )}
            {acceptFailed?.id === it.id && <FailureNote failure={acceptFailed.failure} className="ml-[88px] mt-2" />}
            {/* Evaluated but no pick — quieter inline note so the
                operator knows AI tried and gave up (vs hasn't tried yet). */}
            {evaluated && !hasSuggestion && (
              <p className="ml-[88px] mt-2 text-ink-2 text-xs italic">
                AI evaluated — no candidate fit
                {it.ai_match_reasoning ? `: ${it.ai_match_reasoning}` : '.'}
              </p>
            )}
          </div>
        )
      })}
      </div>
      {matchTarget && (
        <ManualMatchModal
          target={matchTarget}
          // The row a match was made from leaves with the next read. If
          // that read lands before the dialog has gone, the button it would
          // give the focus back to is not there any more: the list is.
          fallbackFocus={() => listRef.current}
          onClose={matchInFlight => {
            const { id, title } = matchTarget
            setMatchTarget(null)
            if (!matchInFlight) return
            // Closed on a match that was still being sent: the server may
            // have saved it or not, and may still be at it. Nothing is
            // claimed. The list is read now, and again after a wait, since
            // a read that comes before the server has finished shows the
            // item still flagged.
            say(`The dialog was closed while the match for ${title} was still being sent, so it may or may not have been saved. This list is read again now and once more in a few seconds: a match that was saved can take a moment to show.`, false)
            const read = () => void reload().then(() => handBackIfInRow(id))
            read()
            if (rereadTimer.current !== null) window.clearTimeout(rereadTimer.current)
            rereadTimer.current = window.setTimeout(read, REREAD_AFTER_MS)
          }}
          onMatched={() => {
            const { id, title } = matchTarget
            setMatchTarget(null)
            say(`Matched ${title}.`, true)
            void reload().then(() => handBackIfInRow(id))
          }}
        />
      )}
    </div>
  )
}

const OLLAMA_LOCAL_DEFAULT = 'http://localhost:11434'
const OLLAMA_CLOUD_DEFAULT = 'https://ollama.com'

function AdminLLMTab({ restartNeeded, onRestartNeeded, onDismissRestart }: {
  /** Settings saved in this visit to the admin page need a restart to take
   *  effect. Kept by the page, so it is still said when this section is
   *  opened again. */
  restartNeeded: boolean
  onRestartNeeded: () => void
  onDismissRestart: () => void
}) {
  const [s, setS] = useState<LLMSettings | null>(null)
  const [said, say] = useSaid()
  const [saveFailed, setSaveFailed] = useState<Failure | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [apiKeyEdit, setApiKeyEdit] = useState('')
  const [anthropicKeyEdit, setAnthropicKeyEdit] = useState('')
  const [openaiKeyEdit, setOpenaiKeyEdit] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LLMTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  // Last server-confirmed settings — the restore source when the operator
  // switches providers back and forth before saving.
  const loadedRef = useRef<LLMSettings | null>(null)
  useEffect(() => {
    const ac = new AbortController()
    getAdminLLM(ac.signal).then(next => { loadedRef.current = next; setS(next) }).catch(e => { if (e.name !== 'AbortError') setErr(e.message) })
    return () => ac.abort()
  }, [])
  if (err) return <p className="text-danger-ink text-sm">{err}</p>
  if (!s) return <p className="text-ink-2 text-sm">Loading…</p>
  const hostedChat = s.provider === 'anthropic' || s.provider === 'openai'
  const openaiEmbeds = s.embed_provider === 'openai'
  const showAnthropicKey = s.provider === 'anthropic'
  const showOpenAIKey = s.provider === 'openai' || openaiEmbeds
  // Model names only make sense within a provider family. When the operator
  // switches families, carrying the old family's tags forward would persist
  // them on save — hosted chat then 404s on an Ollama tag after restart, and
  // the embed path re-embeds against a model the provider doesn't serve. So:
  // crossing families blanks the model fields (blank = the new provider's
  // default, which the placeholders spell out); returning to the loaded
  // family restores the server-confirmed values.
  const chatFamily = (p: string) => (p === 'anthropic' || p === 'openai') ? p : 'ollama'
  const embedFamily = (p: string) => p === 'openai' ? 'openai' : 'ollama'
  const changeProvider = (p: string) => {
    const next = { ...s, provider: p }
    if (chatFamily(p) !== chatFamily(s.provider)) {
      const loaded = loadedRef.current
      if (loaded && chatFamily(p) === chatFamily(loaded.provider)) {
        next.chat_model = loaded.chat_model; next.chat_model_fast = loaded.chat_model_fast; next.chat_model_smart = loaded.chat_model_smart
      } else {
        next.chat_model = ''; next.chat_model_fast = ''; next.chat_model_smart = ''
      }
    }
    // Local and Ollama Cloud are the same transport, told apart only by
    // ollama_url (CheckProviderCombo 400s local-on-ollama.com and
    // cloud-on-non-https) — so flipping just the dropdown otherwise looks
    // like a no-op until Save rejects it. Swap the URL along with it, but
    // only when it still holds the OTHER side's default (i.e. the operator
    // hasn't customized it), so a deliberately-set LAN/proxy URL is never
    // clobbered.
    if (p === 'ollama_cloud' && (s.ollama_url === '' || s.ollama_url === OLLAMA_LOCAL_DEFAULT)) {
      next.ollama_url = OLLAMA_CLOUD_DEFAULT
    } else if (p !== 'ollama_cloud' && s.ollama_url === OLLAMA_CLOUD_DEFAULT) {
      next.ollama_url = ''
    }
    setS(next)
  }
  const changeEmbedProvider = (p: string) => {
    const next = { ...s, embed_provider: p }
    if (embedFamily(p) !== embedFamily(s.embed_provider)) {
      const loaded = loadedRef.current
      next.embed_model = (loaded && embedFamily(p) === embedFamily(loaded.embed_provider)) ? loaded.embed_model : ''
    }
    setS(next)
  }
  const chatPlaceholder = s.provider === 'anthropic' ? 'blank = claude-sonnet-5' : s.provider === 'openai' ? 'blank = gpt-5.6-terra' : (s.effective_chat_model ? `blank = ${s.effective_chat_model}` : 'e.g. qwen3:4b-instruct')
  const smartPlaceholder = s.provider === 'anthropic' ? 'Discover curation · blank = claude-opus-5' : s.provider === 'openai' ? 'Discover curation · blank = gpt-5.6-sol' : 'Discover curation · blank = Chat Model'
  const embedPlaceholder = openaiEmbeds ? 'blank = text-embedding-3-small' : (s.effective_embed_model ? `blank = ${s.effective_embed_model}` : 'e.g. qwen3-embedding:0.6b')
  const chatAvailable = testResult?.endpoints.find(ep => ep.role === 'chat')?.available ?? []
  const embedAvailable = testResult?.endpoints.find(ep => ep.role === 'embed')?.available ?? []
  return (
    <div className="bg-surface-raised rounded-control p-5 space-y-3">
      <h3 className="text-ink font-semibold mb-2">Search and recommendations</h3>
      <p className="text-ink-2 text-xs mb-3">Configures the LLM used for natural-language search and recommendation reranking. Local runs chat on your own box; Ollama Cloud runs chat on ollama.com; Anthropic (Claude) and OpenAI (ChatGPT) run chat on their hosted APIs with your API key. Embeddings run on local Ollama by default, or on OpenAI — Anthropic has no embeddings API. Enable/disable the whole stack via LLM_ENABLED.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Provider</span>
          <select value={s.provider} onChange={e => changeProvider(e.target.value)} className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm">
            <option value="">Default (env config)</option>
            <option value="ollama_cloud">Ollama Cloud</option>
            <option value="local">Local (Ollama)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (ChatGPT)</option>
          </select>
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Embedding provider</span>
          <select value={s.embed_provider} onChange={e => changeEmbedProvider(e.target.value)} className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm">
            <option value="">Local (Ollama)</option>
            <option value="openai">OpenAI</option>
          </select>
          <span className="block text-xs text-warn mt-1">Changing the embedding provider or model clears stored vectors and re-embeds the whole library on restart{openaiEmbeds ? ' (OpenAI API cost applies)' : ''}.</span>
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Ollama URL{hostedChat ? ' (local embeds + reranker only)' : ''}</span>
          <input value={s.ollama_url} onChange={e => setS({ ...s, ollama_url: e.target.value })} placeholder={s.provider === 'ollama_cloud' ? OLLAMA_CLOUD_DEFAULT : OLLAMA_LOCAL_DEFAULT} className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
          {s.provider === 'ollama_cloud' && <span className="block text-xs text-ink-2 mt-1">Must be an https ollama.com URL — this is what actually distinguishes Ollama Cloud from Local.</span>}
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Embed URL (optional)</span>
          <input value={s.embed_url} onChange={e => setS({ ...s, embed_url: e.target.value })} placeholder="http://localhost:11434" className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Chat model</span>
          <input value={s.chat_model} onChange={e => setS({ ...s, chat_model: e.target.value })} placeholder={chatPlaceholder} list="llm-chat-models" className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Embed model</span>
          <input value={s.embed_model} onChange={e => setS({ ...s, embed_model: e.target.value })} placeholder={embedPlaceholder} list="llm-embed-models" className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Fast Model (optional)</span>
          <input value={s.chat_model_fast ?? ''} onChange={e => setS({ ...s, chat_model_fast: e.target.value })} placeholder="hero rerank + rail reasons · blank = Chat Model" list="llm-chat-models" className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Smart Model (optional)</span>
          <input value={s.chat_model_smart ?? ''} onChange={e => setS({ ...s, chat_model_smart: e.target.value })} placeholder={smartPlaceholder} list="llm-chat-models" className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Ollama API Key {s.has_api_key && <span className="text-ok text-xs">SET</span>}</span>
          <input type="password" data-screenshot-exclude="true" value={apiKeyEdit} onChange={e => setApiKeyEdit(e.target.value)} placeholder={s.api_key_masked || 'leave empty to keep existing'} className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
        {showAnthropicKey && (
          <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Anthropic API Key {s.has_anthropic_api_key && <span className="text-ok text-xs">SET</span>}</span>
            <input type="password" data-screenshot-exclude="true" value={anthropicKeyEdit} onChange={e => setAnthropicKeyEdit(e.target.value)} placeholder={s.anthropic_api_key_masked || 'sk-ant-… · leave empty to keep existing'} className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
          </label>
        )}
        {showOpenAIKey && (
          <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">OpenAI API Key {s.has_openai_api_key && <span className="text-ok text-xs">SET</span>}</span>
            <input type="password" data-screenshot-exclude="true" value={openaiKeyEdit} onChange={e => setOpenaiKeyEdit(e.target.value)} placeholder={s.openai_api_key_masked || 'sk-… · leave empty to keep existing'} className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
          </label>
        )}
      </div>
      <datalist id="llm-chat-models">{chatAvailable.map(m => <option key={m} value={m} />)}</datalist>
      <datalist id="llm-embed-models">{embedAvailable.map(m => <option key={m} value={m} />)}</datalist>
      <label className="flex flex-wrap items-center gap-2 mt-2 text-sm text-ink-2">
        <input type="checkbox" checked={s.debug_log} onChange={e => setS({ ...s, debug_log: e.target.checked })} />
        Debug log <span className="text-ink-2 text-xs">(verbose LLM call traces — adds disk I/O)</span>
      </label>
      <label className={`flex items-center gap-2 mt-2 text-sm ${hostedChat ? 'text-ink-3' : 'text-ink-2'}`} title={hostedChat ? 'Always on for Anthropic/OpenAI — they enforce schemas natively' : undefined}>
        <input type="checkbox" disabled={hostedChat} checked={hostedChat ? true : (s.structured_outputs ?? false)} onChange={e => setS({ ...s, structured_outputs: e.target.checked })} />
        Structured outputs <span className="text-ink-2 text-xs">{hostedChat ? '(always on for Anthropic/OpenAI)' : '(OpenAI json_schema path for the hero rerank — restart required)'}</span>
      </label>
      <label className="flex flex-wrap items-center gap-2 mt-2 text-sm text-ink-2">
        Reasoning effort
        <select value={s.reasoning_effort ?? ''} onChange={e => setS({ ...s, reasoning_effort: e.target.value })} className="max-w-full px-2 py-1 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm">
          <option value="">Default (model decides)</option>
          <option value="low">Low — fastest{hostedChat ? '' : ', recommended for gpt-oss'}</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="none">None</option>
        </select>
        <span className="text-ink-2 text-xs">{s.provider === 'anthropic' ? 'maps to Claude output effort' : s.provider === 'openai' ? 'sent as reasoning_effort' : 'gpt-oss · structured /v1 path'} · restart required</span>
      </label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Reranker Model (optional)</span>
          <input value={s.rerank_model ?? ''} onChange={e => setS({ ...s, rerank_model: e.target.value })} placeholder="fast chat model · listwise rerank · e.g. gpt-oss:20b · blank = off" className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Reranker URL (optional)</span>
          <input value={s.rerank_url ?? ''} onChange={e => setS({ ...s, rerank_url: e.target.value })} placeholder="blank = chat endpoint · set only to run rerank on a local box" className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Repeat window (hrs)</span>
          <input type="number" min={0} value={s.repeat_window_hours ?? 72} onChange={e => setS({ ...s, repeat_window_hours: Math.max(0, parseInt(e.target.value || '0', 10) || 0) })} placeholder="anti-repetition · 0 = off" className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
        <label className="text-sm text-ink-2"><span className="block text-xs text-ink-2 mb-1">Taste modes (1–3)</span>
          <input type="number" min={1} max={3} value={s.taste_centroids ?? 3} onChange={e => setS({ ...s, taste_centroids: Math.min(3, Math.max(1, parseInt(e.target.value || '1', 10) || 1)) })} placeholder="multi-centroid taste · 1 = off" className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm" />
        </label>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button
          // Not `disabled` while it saves: what came of it is said beside
          // this button, and a disabled one drops the focus.
          aria-disabled={saving || undefined}
          onClick={async () => {
            if (saving) return
            setSaving(true)
            setSaveFailed(null)
            let saved: { restart_required?: boolean } | null = null
            try {
              const body: Record<string, unknown> = {
                provider: s.provider, embed_provider: s.embed_provider,
                ollama_url: s.ollama_url, embed_url: s.embed_url,
                chat_model: s.chat_model, embed_model: s.embed_model, debug_log: s.debug_log,
                chat_model_fast: s.chat_model_fast ?? '', chat_model_smart: s.chat_model_smart ?? '',
                structured_outputs: s.structured_outputs ?? false, reasoning_effort: s.reasoning_effort ?? '',
                rerank_model: s.rerank_model ?? '', rerank_url: s.rerank_url ?? '',
                repeat_window_hours: s.repeat_window_hours ?? 72,
                taste_centroids: s.taste_centroids ?? 3,
              }
              if (apiKeyEdit) body.api_key = apiKeyEdit
              if (anthropicKeyEdit) body.anthropic_api_key = anthropicKeyEdit
              if (openaiKeyEdit) body.openai_api_key = openaiKeyEdit
              const ack = await updateAdminLLM(body as Parameters<typeof updateAdminLLM>[0])
              saved = ack
              // The PUT returns an ack, not the settings — re-fetch so the
              // form reflects what was persisted (masked keys, SET badges).
              const next = await getAdminLLM()
              loadedRef.current = next
              setS(next); setApiKeyEdit(''); setAnthropicKeyEdit(''); setOpenaiKeyEdit('')
              // Said every time, also when the restart notice is already up:
              // the notice is not read out by itself.
              if (ack.restart_required) { onRestartNeeded(); say('Saved. Restart Aurora to apply these settings.') }
              else say('AI provider settings saved.')
            } catch (e) {
              if (saved) {
                // Saved; only the read back failed, whatever its kind. Not
                // called a failed save.
                if (saved.restart_required) { onRestartNeeded(); say('Saved. Restart Aurora to apply these settings.') }
                setSaveFailed({ says: 'Saved. The settings could not be read back: reload to see them.', server: adminFailure(e, 'read the settings back').server })
              } else {
                setSaveFailed(adminFailure(e, 'save the AI provider settings', { 400: 'The server refused these settings.' }))
              }
            }
            finally { setSaving(false) }
          }}
          className="stage-btn stage-btn-primary"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          disabled={testing}
          onClick={async () => {
            setTesting(true); setTestResult(null); setTestError(null)
            try {
              const body: Parameters<typeof testAdminLLM>[0] = {
                provider: s.provider, embed_provider: s.embed_provider,
                ollama_url: s.ollama_url, embed_url: s.embed_url,
                chat_model: s.chat_model, embed_model: s.embed_model,
              }
              // Unsaved keys ride the probe (fixed vendor hosts server-side);
              // omitted = test the stored key.
              if (anthropicKeyEdit) body.anthropic_api_key = anthropicKeyEdit
              if (openaiKeyEdit) body.openai_api_key = openaiKeyEdit
              setTestResult(await testAdminLLM(body))
            } catch (e) { setTestError(e instanceof Error ? e.message : 'test failed') }
            finally { setTesting(false) }
          }}
          className="stage-btn stage-btn-ghost"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      <FailureNote failure={saveFailed} />
      <StatusLine said={said} />
      {restartNeeded && (
        <StandingNotice title="Restart Aurora to use the new AI settings" onDismiss={onDismissRestart}>
          The AI provider settings are saved. Aurora goes on using the ones it started with until it is restarted.
        </StandingNotice>
      )}
      {testError && <p className="text-danger-ink text-xs mt-2">{testError}</p>}
      {testResult && (
        <div className="mt-2 space-y-1 text-xs">
          {testResult.endpoints.map(ep => (
            <div key={ep.role + (ep.provider ?? '') + ep.url} className="text-ink-2">
              <span className="uppercase text-ink-2 mr-1">{ep.role}{ep.provider ? ` · ${ep.provider}` : ''}</span>
              <span className="mr-2">{ep.url}</span>
              {ep.reachable ? (
                <span className="text-ok">reachable</span>
              ) : (
                <span className="text-danger-ink">unreachable{ep.error ? ` — ${ep.error}` : ''}</span>
              )}
              {ep.models && Object.entries(ep.models).map(([m, ok]) => (
                <span key={m} className={ok ? 'ml-2 text-ok' : 'ml-2 text-warn'}>
                  {m}: {ok ? 'found' : ep.provider ? 'not available to this API key' : 'missing — ollama pull ' + m}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Phase B — AdminOAuthTab refactored to render one section per
// provider via OAuthProviderSection. Adding a new provider to this
// UI is now: append one <OAuthProviderSection> element with the
// provider name + console URL. No state duplication, no save-loop
// edits.
function AdminOAuthTab() {
  const [s, setS] = useState<OAuthSettings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const ac = new AbortController()
    getAdminOAuth(ac.signal).then(setS).catch(e => { if (e.name !== 'AbortError') setErr(e.message) })
    return () => ac.abort()
  }, [])
  if (err) return <p className="text-danger-ink text-sm">{err}</p>
  if (!s) return <p className="text-ink-2 text-sm">Loading…</p>
  return (
    <div className="space-y-4">
      {/* Above the provider cards because it spans them: the prompt exists to
          replace the attribution that the per-provider bypass toggles below
          give up. */}
      <ReferralPromptSection />
      <ReferralSummarySection />
      <OAuthProviderSection
        provider="google"
        label="Google"
        consoleURL="https://console.cloud.google.com/apis/credentials"
        settings={s}
        onUpdate={setS}
      />
      <OAuthProviderSection
        provider="discord"
        label="Discord"
        consoleURL="https://discord.com/developers/applications"
        settings={s}
        onUpdate={setS}
      />
      <OAuthProviderSection
        provider="twitch"
        label="Twitch"
        consoleURL="https://dev.twitch.tv/console/apps"
        settings={s}
        onUpdate={setS}
      />
      <OAuthProviderSection
        provider="facebook"
        label="Facebook"
        consoleURL="https://developers.facebook.com/apps/"
        settings={s}
        onUpdate={setS}
      />
      <OAuthProviderSection
        provider="twitter"
        label="X (Twitter)"
        consoleURL="https://developer.x.com/en/portal/dashboard"
        settings={s}
        onUpdate={setS}
      />
    </div>
  )
}

// Referral prompt editor (migration 046). Sits with the bypass toggles it
// depends on: when a provider bypasses the invite gate, the invite code — the
// only record of where an account came from — is what gets skipped, and this
// question is what replaces it.
interface EditableOption extends ReferralOption { rowId: number }

/** Truncate by CHARACTER, not UTF-16 unit — slicing mid-surrogate renders a
 *  replacement glyph — and mark that it was cut. */
function truncateChars(s: string, max: number): string {
  const chars = [...s]
  return chars.length <= max ? s : chars.slice(0, max).join('') + '…'
}

function ReferralPromptSection() {
  const [question, setQuestion] = useState('')
  // Rows carry a client-side id so React keys are stable across removal. With
  // key={i} the LAST DOM row is the one destroyed, which leaves focus on a
  // Remove button whose aria-label now names a different option — a second
  // press deletes a row the admin never targeted.
  const [rows, setRows] = useState<EditableOption[]>([])
  const nextRowId = useRef(0)
  // Keys that already existed when the settings loaded. Their answers are
  // stored BY KEY, so renaming one orphans every answer that used it — the
  // exact failure storing keys instead of labels exists to prevent. Renaming
  // the label is free and is what the operator actually wants.
  const [lockedKeys, setLockedKeys] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    getAllSettings(ac.signal)
      .then(map => {
        setQuestion(map[REFERRAL_QUESTION_KEY] ?? '')
        const parsed = parseReferralOptionsSetting(map[REFERRAL_OPTIONS_KEY] ?? '')
        setRows(parsed.map(o => ({ ...o, rowId: nextRowId.current++ })))
        setLockedKeys(new Set(parsed.map(o => o.key)))
      })
      .catch(e => { if (e.name !== 'AbortError') setErr(e instanceof Error ? e.message : 'Failed to load') })
      .finally(() => setLoading(false))
    return () => ac.abort()
  }, [])

  // Mirrors the Go validator so a rejected save names the offending ROW. The
  // settings whitelist can only answer yes/no, so without this the admin gets
  // a bare "invalid value for setting" with no idea which line is wrong.
  // lockedKeys is passed so a stored key that today's pattern rejects doesn't
  // raise an error on a field the admin cannot edit.
  const issues = validateReferralOptions(rows, lockedKeys)
  const issueFor = (i: number) => issues.find(x => x.index === i)?.message
  const listIssue = issues.find(x => x.index === -1)?.message
  const questionIssue = [...question.trim()].length > 200
    ? 'Question must be 200 characters or fewer.'
    : hasDeceptiveRunes(question.trim())
      ? 'Question contains a hidden or direction-changing character.'
      : null
  const blocked = saving || issues.length > 0 || !!questionIssue
  // Why Save is unavailable, as text. The state can exist from first paint
  // (stored options already invalid), so there is no event to announce and a
  // purely visual cue reaches nobody who cannot see it.
  const blockedReason = saving ? null
    : issues.length > 0 ? `Fix ${issues.length === 1 ? 'the issue' : `${issues.length} issues`} above to save.`
    : questionIssue ? 'Fix the question above to save.'
    : null

  const save = async () => {
    setSaving(true); setErr(null); setSaved(false)
    try {
      await updateSettings({
        [REFERRAL_QUESTION_KEY]: question.trim(),
        [REFERRAL_OPTIONS_KEY]: rows.length ? serializeReferralOptions(rows) : '',
      })
      setLockedKeys(new Set(rows.map(o => o.key.trim())))
      setSaved(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-ink-2 text-sm">Loading…</p>

  return (
    <div className="bg-surface-raised rounded-control p-5 space-y-3">
      <h3 className="text-ink font-semibold mb-1">Referral prompt</h3>
      <p className="text-ink-2 text-xs">
        Asked once, of accounts created through a provider whose invite bypass is on below.
        Everyone else is never asked. Leave blank to use the defaults.
      </p>

      <div>
        <label htmlFor="referral-question" className="block text-ink text-sm mb-1.5">Question</label>
        <input
          id="referral-question"
          type="text"
          value={question}
          onChange={e => { setQuestion(e.target.value); setSaved(false) }}
          aria-invalid={!!questionIssue || undefined}
          aria-describedby={questionIssue ? 'referral-question-err' : undefined}
          placeholder="How did you hear about Aurora?"
          className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm"
        />
        {questionIssue && <p id="referral-question-err" className="text-danger-ink text-xs mt-1">{questionIssue}</p>}
      </div>

      <div>
        <p className="text-ink text-sm mb-1.5">Options</p>
        {listIssue && <p className="text-danger-ink text-xs mb-2">{listIssue}</p>}
        <div className="space-y-2">
          {rows.map((row, i) => {
            const locked = lockedKeys.has(row.key.trim())
            const issue = issueFor(i)
            const errId = `referral-opt-${row.rowId}-err`
            return (
              <div key={row.rowId}>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={row.key}
                    readOnly={locked}
                    aria-label={`Option ${i + 1} key${locked ? ' (locked)' : ''}`}
                    aria-invalid={!!issue || undefined}
                    aria-describedby={issue ? errId : undefined}
                    onChange={e => { setRows(p => p.map((r, j) => j === i ? { ...r, key: e.target.value } : r)); setSaved(false) }}
                    placeholder="key"
                    title={locked ? 'Answers are stored by this key, so it cannot be renamed.' : undefined}
                    className={'w-40 px-3 py-2 rounded-chip text-sm font-mono border '
                      + (locked
                        // Dashed and dimmer, with no text cursor: a field that
                        // takes focus and then discards what you type has to
                        // look like one that will.
                        ? 'bg-surface-raised border-dashed border-line text-ink-2 cursor-not-allowed'
                        : 'bg-surface-raised-2 border-line text-ink')}
                  />
                  <input
                    type="text"
                    value={row.label}
                    aria-label={`Option ${i + 1} label`}
                    aria-invalid={!!issue || undefined}
                    aria-describedby={issue ? errId : undefined}
                    onChange={e => { setRows(p => p.map((r, j) => j === i ? { ...r, label: e.target.value } : r)); setSaved(false) }}
                    placeholder="Label shown to the user"
                    className="flex-1 px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => { setRows(p => p.filter((_, j) => j !== i)); setSaved(false) }}
                    aria-label={`Remove option ${row.label || row.key || i + 1}`}
                    aria-describedby={issue ? errId : undefined}
                    className="stage-btn stage-btn-quiet"
                  >
                    Remove
                  </button>
                </div>
                {issue && <p id={errId} className="text-danger-ink text-xs mt-1">{issue}</p>}
                {locked && !issue && (
                  <p className="text-ink-2 text-xs mt-1">
                    Key locked — answers are stored by it. Rename the label instead.
                  </p>
                )}
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-between mt-2">
          <button
            type="button"
            onClick={() => { setRows(p => [...p, { key: '', label: '', rowId: nextRowId.current++ }]); setSaved(false) }}
            disabled={rows.length >= 12}
            className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost"
          >
            + Add option
          </button>
          <span className="text-ink-2 text-xs">
            “{REFERRAL_OTHER_LABEL}” with a free-text box is always offered last. It is not
            listed here because it cannot be edited or turned off.
          </span>
        </div>
      </div>

      {/* Rendered unconditionally so the region exists before it has content —
          a live region created at the same moment as its text is not announced,
          which would leave a screen-reader admin with no feedback at all on
          either success or failure. */}
      <p role="alert" className="text-danger-ink text-sm empty:hidden">{err}</p>
      <div className="flex items-center gap-3">
        {/* aria-disabled, not the native attribute. `disabled` removes the
            button from the tab order, so an admin who cannot see it finds no
            Save at all and no clue why — and when the stored options are
            already invalid that state exists from first paint, with no event to
            announce. This stays focusable and carries its own reason. */}
        <button
          type="button"
          onClick={() => { if (!blocked) void save() }}
          aria-disabled={blocked || undefined}
          aria-describedby={blockedReason ? 'referral-save-blocked' : undefined}
          className="stage-btn stage-btn-primary"
        >
          {saving ? 'Saving…' : 'Save prompt'}
        </button>
        {blockedReason && (
          <span id="referral-save-blocked" className="text-ink-2 text-xs">{blockedReason}</span>
        )}
        <span role="status" className="text-ink-2 text-xs">{saved ? 'Saved.' : ''}</span>
      </div>
    </div>
  )
}

// Where signups say they came from. Counts and percentages only — a chart
// library for one bar list would be a dependency for nothing, and the numbers
// are the accessible content either way.
function ReferralSummarySection() {
  const [days, setDays] = useState(0)
  const [data, setData] = useState<AdminReferralSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    setErr(null)
    getAdminReferralSummary(days, ac.signal)
      .then(setData)
      .catch(e => { if (e.name !== 'AbortError') setErr(e instanceof Error ? e.message : 'Failed to load') })
    return () => ac.abort()
  }, [days])

  const top = data && data.by_source.length ? data.by_source[0].count : 0
  return (
    <div className="bg-surface-raised rounded-control p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-ink font-semibold">Where sign-ups came from</h3>
        <label className="text-ink-2 text-xs">
          <span className="sr-only">Time window</span>
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="px-2 py-1 bg-surface-raised-2 border border-line rounded-chip text-ink text-xs"
          >
            <option value={0}>All time</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </div>

      <p role="alert" className="text-danger-ink text-sm empty:hidden">{err}</p>
      {!data && !err && <p className="text-ink-2 text-sm">Loading…</p>}
      {data && (
        <>
          <div className="flex gap-6 text-sm">
            <span className="text-ink">{data.answered.toLocaleString()} <span className="text-ink-2">answered</span></span>
            <span className="text-ink">{data.skipped.toLocaleString()} <span className="text-ink-2">skipped</span></span>
            <span className="text-ink">{data.pending.toLocaleString()} <span className="text-ink-2">not yet asked</span></span>
          </div>
          {data.total === 0 ? (
            <p className="text-ink-2 text-sm">
              No one has been asked yet. Accounts become eligible when they sign up through a
              provider with its invite bypass turned on.
            </p>
          ) : data.by_source.length === 0 ? (
            <p className="text-ink-2 text-sm">No answers yet.</p>
          ) : (
            <div className="space-y-1.5">
              {data.by_source.map(row => {
                const pct = data.answered > 0 ? Math.round((row.count / data.answered) * 100) : 0
                return (
                  <div key={row.key} className="flex items-center gap-3">
                    {/* A deleted option's answers are still shown — dropping
                        them would under-report history every time an operator
                        tidies the list. A null label does NOT mean removed:
                        the implicit "other" never has a stored option, so the
                        key decides the styling, not the label's presence. */}
                    <span className={`w-48 shrink-0 text-sm ${isRemovedSummaryRow(row) ? 'text-ink-2 italic' : 'text-ink'}`}>
                      {row.label ?? referralSourceLabel(row.key, [])}
                    </span>
                    <div className="flex-1 h-2 rounded-full bg-surface-raised-2 overflow-hidden" aria-hidden="true">
                      <div
                        className="h-full rounded-full bg-action"
                        style={{ width: `${top > 0 ? (row.count / top) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right text-ink-2 text-sm tabular-nums">
                      {row.count.toLocaleString()} · {pct}%
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// One user's referral answer for the Users table. The detail is untrusted free
// text from that user, rendered here as a text node (React escapes it) because
// an admin's screen is exactly where an injection would matter.
function ReferralCell({ user, options, answeredAt }: {
  user: AdminUser
  options: ReferralOption[]
  /** Pre-formatted; fmtRelative is scoped to the AdminView component. */
  answeredAt?: string
}) {
  if (!user.referral_status) {
    // Never eligible — a password signup, an invited user, or a provider with
    // no bypass. Not "we forgot to ask".
    return <span className="text-ink-2" title="Not eligible — signed up with an invite or a password">—</span>
  }
  if (user.referral_status === 'pending') {
    return <span className="text-ink-2 text-sm">Pending</span>
  }
  if (user.referral_status === 'skipped') {
    return <span className="text-ink-2 text-sm">— (skipped)</span>
  }
  const label = referralSourceLabel(user.referral_source ?? '', options)
  return (
    <span className="text-ink-2 text-sm" title={answeredAt ? `Answered ${answeredAt}` : undefined}>
      {label}
      {user.referral_detail && (
        <span className="text-ink-2"> — “{truncateChars(user.referral_detail, 60)}”</span>
      )}
    </span>
  )
}

// Phase B — One section per OAuth provider. The triple-flatness
// of the OAuthSettings shape (google_*, discord_*, twitch_*) makes
// per-provider field access a bit awkward in TS, so we use bracket
// access via the provider prefix. Type-safe at the boundary because
// the prop union is constrained.
function OAuthProviderSection({ provider, label, consoleURL, settings, onUpdate }: {
  provider: 'google' | 'discord' | 'twitch' | 'facebook' | 'twitter'
  label: string
  // Provider's developer-console URL — surfaced as a "Get credentials"
  // helper link next to the client_id field, so admins know where to
  // register a new OAuth app.
  consoleURL: string
  settings: OAuthSettings
  onUpdate: React.Dispatch<React.SetStateAction<OAuthSettings | null>>
}) {
  const [secretEdit, setSecretEdit] = useState('')
  const [saving, setSaving] = useState(false)
  const [said, say] = useSaid()
  const [saveFailed, setSaveFailed] = useState<Failure | null>(null)

  // Field accessors keyed by provider prefix. Avoids three near-
  // identical copies of the same JSX.
  const enabledKey = `${provider}_enabled` as const
  const clientIDKey = `${provider}_client_id` as const
  const redirectKey = `${provider}_redirect_url` as const
  const bypassKey = `${provider}_bypass_invite` as const
  const hasSecretKey = `${provider}_has_secret` as const
  const maskedKey = `${provider}_client_secret_masked` as const

  const enabled = settings[enabledKey] as boolean
  const clientID = settings[clientIDKey] as string
  const redirectURL = settings[redirectKey] as string
  const bypassInvite = settings[bypassKey] as boolean
  const hasSecret = settings[hasSecretKey] as boolean
  const maskedSecret = settings[maskedKey] as string

  const setField = (key: keyof OAuthSettings, val: string | boolean) => {
    onUpdate(prev => prev && { ...prev, [key]: val })
  }

  const callbackHint = `https://your-aurora/api/auth/oauth/${provider}/callback`

  return (
    <div className="bg-surface-raised rounded-control p-5 space-y-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-ink font-semibold">
          {label} OAuth (Sign-in)
          {enabled && <span className="ml-2 text-ok text-xs uppercase tracking-wider">Enabled</span>}
        </h3>
        <a
          href={consoleURL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink hover:text-ink text-xs underline-offset-4 hover:underline"
        >
          Open {label} developer console ↗
        </a>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setField(enabledKey, e.target.checked)}
        />
        Enable {label} Sign-In
      </label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-sm text-ink-2">
          <span className="block text-xs text-ink-2 mb-1">Client ID</span>
          <input
            value={clientID}
            onChange={e => setField(clientIDKey, e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm"
          />
        </label>
        <label className="text-sm text-ink-2">
          <span className="block text-xs text-ink-2 mb-1">
            Client Secret {hasSecret && <span className="text-ok text-xs">SET</span>}
          </span>
          <input
            type="password"
            data-screenshot-exclude="true"
            value={secretEdit}
            onChange={e => setSecretEdit(e.target.value)}
            placeholder={maskedSecret || 'leave empty to keep existing'}
            className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm"
          />
        </label>
        <label className="md:col-span-2 text-sm text-ink-2">
          <span className="block text-xs text-ink-2 mb-1">
            Redirect URL <span className="text-ink-2">(must match {label} Console verbatim)</span>
          </span>
          <input
            value={redirectURL}
            onChange={e => setField(redirectKey, e.target.value)}
            placeholder={callbackHint}
            className="w-full px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <input
          type="checkbox"
          checked={bypassInvite}
          onChange={e => setField(bypassKey, e.target.checked)}
        />
        Bypass invite-code requirement for {label} sign-up
      </label>
      <button
        // Not `disabled` while it saves: what came of it is said beside this
        // button, and a disabled one drops the focus.
        aria-disabled={saving || undefined}
        onClick={async () => {
          if (saving) return
          setSaving(true)
          setSaveFailed(null)
          let saved = false
          try {
            // Build a per-provider patch — only this provider's
            // fields. The admin endpoint accepts the full union
            // type but writing only what changed keeps writes
            // surgical and avoids accidental cross-provider edits.
            const body: Record<string, unknown> = {
              [enabledKey]: enabled,
              [clientIDKey]: clientID,
              [redirectKey]: redirectURL,
              [bypassKey]: bypassInvite,
            }
            if (secretEdit) body[`${provider}_client_secret`] = secretEdit
            await updateAdminOAuth(body as Parameters<typeof updateAdminOAuth>[0])
            saved = true
            setSecretEdit('')
            // The PUT answers an acknowledgement, not the settings: read them
            // again, and take this provider's fields from what was stored
            // (another provider's card keeps what is being typed in it).
            const next = await getAdminOAuth()
            onUpdate(prev => {
              if (!prev) return next
              const mine = Object.fromEntries(Object.entries(next).filter(([k]) => k.startsWith(`${provider}_`)))
              return { ...prev, ...mine } as OAuthSettings
            })
            // Sign-in reads these on every request: nothing waits on a restart.
            say(`${label} sign-in settings saved.`)
          } catch (e) {
            setSaveFailed(saved
              ? { says: 'Saved. The settings could not be read back: reload to see them.', server: adminFailure(e, 'read the settings back').server }
              : adminFailure(e, `save the ${label} sign-in settings`, { 400: 'The server refused these settings.' }))
          } finally {
            setSaving(false)
          }
        }}
        className="stage-btn stage-btn-primary mt-3"
      >
        {saving ? 'Saving…' : `Save ${label} settings`}
      </button>
      <FailureNote failure={saveFailed} />
      <StatusLine said={said} />
    </div>
  )
}

/* ──────────────────── ADMIN USER ROW ACTIONS (3-dot menu) ─────────────────── */
// Per-user kebab menu in the admin Users table: promote/demote + delete.
// Replaces the bare "Delete" button so role changes get a home too.
//
// The menu renders into a document.body portal with fixed positioning anchored
// to the trigger's bounding rect. That's deliberate: the Users table scrolls
// sideways inside its panel, and a scroller clips an absolutely positioned
// child. A body portal escapes that, so the menu is never clipped, including
// on the last row. Closes on outside click, Escape, and scroll/resize (the
// anchor would otherwise drift).
function UserRowMenu({
  user,
  onRoleChanged,
  onDeleted,
  reloadUsers,
  say,
}: {
  user: AdminUser
  onRoleChanged: (role: 'admin' | 'user') => void
  /** The row goes, and this menu and its dialog with it: the caller puts the
   *  focus somewhere that stays. */
  onDeleted: () => void
  /** Reads the users again in place; true when the read succeeded. Used
   *  after a role change that failed (the server may have made it anyway: a
   *  demotion answers 500 when only the sign-out that follows failed) and
   *  after one that found the user gone. */
  reloadUsers: () => Promise<boolean>
  say: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  // The question a menu item asked, and its one request.
  // A role question carries the role it was asked about, fixed when it is
  // asked: the row can change under an open question (a re-read after a
  // change that may have happened), and a retry of "Remove admin" must never
  // become "Make admin".
  type Asked = { what: 'role'; from: 'admin' | 'user' } | { what: 'delete' }
  const flow = useConfirmedAction<Asked>(a => a.what === 'role' ? `changing ${user.username}'s role` : `deleting ${user.username}`)
  const asking = flow.asked
  const busy = flow.busy
  // What came of a change the dialog was closed on (it may have happened),
  // said beside the menu's button.
  const [rowNote, setRowNote] = useState<Failure | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Anchor the portal under the trigger, right-aligned to it.
  const place = useCallback(() => {
    const t = triggerRef.current
    if (!t) return
    const r = t.getBoundingClientRect()
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
  }, [])

  useEffect(() => {
    if (!open) return
    place()
    const onDocClick = (e: MouseEvent) => {
      const tgt = e.target as Node
      if (triggerRef.current?.contains(tgt)) return
      if (menuRef.current?.contains(tgt)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    // Anchor coords are viewport-relative; a scroll/resize would strand the
    // menu, so we just close it (matches native <select> behavior).
    const onReflow = () => setOpen(false)
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, place])

  const isAdmin = user.role === 'admin'

  // A menu item asks its question in the app's dialog; the menu closes, and
  // the dialog gives the focus back to the menu's button.
  const ask = (what: 'role' | 'delete') => {
    if (busy) return
    setOpen(false)
    triggerRef.current?.focus()
    setRowNote(null)
    flow.ask(what === 'role' ? { what, from: isAdmin ? 'admin' : 'user' } : { what })
  }

  const handleRole = () => flow.run(async asked => {
    if (asked.what !== 'role') return null
    // The row no longer has the role the question was about: nothing is
    // sent, and the question is put down.
    if (user.role !== asked.from) {
      say(`${user.username}'s role has changed since you asked, so nothing was sent. Check it and ask again.`)
      return null
    }
    const nextRole: 'admin' | 'user' = asked.from === 'admin' ? 'user' : 'admin'
    try {
      await updateUserRole(user.id, nextRole)
      onRoleChanged(nextRole)
      setOpen(false)
      say(nextRole === 'admin' ? `${user.username} is now an admin.` : `${user.username} is no longer an admin.`)
      return null
    } catch (err) {
      const read = await reloadUsers()
      if (err instanceof APIError && err.status === 404) {
        say(`${user.username} was already gone from the server.`)
        return null
      }
      // A refusal (the last admin) changed nothing: it is said in the
      // dialog, whose question stays what it was.
      if (err instanceof APIError && err.status < 500) return adminFailure(err, `change ${user.username}'s role`)
      // Anything else may have changed the role. The question is put down
      // (its words could be the wrong way round by now) and the list read
      // again says what is so.
      setRowNote({
        says: read
          ? `Could not confirm the change. The list has been read again: check ${user.username}'s role.`
          : `Could not confirm the change, and the list could not be read again. Reload this page to check ${user.username}'s role.`,
        server: adminFailure(err, `change ${user.username}'s role`).server,
      })
      return null
    }
  })

  const handleDelete = () => flow.run(async () => {
    try {
      await deleteUser(user.id)
      // onDeleted() removes this row, unmounting the component (and this
      // dialog): say it first.
      setOpen(false)
      say(`Deleted ${user.username}.`)
      onDeleted()
      return null
    } catch (err) {
      if (err instanceof APIError && err.status === 404) {
        say(`${user.username} was already gone from the server.`)
        // The read takes the row away, this dialog with it: the page hands
        // the focus on as it does for a delete that went through.
        await reloadUsers()
        onDeleted()
        return null
      }
      return adminFailure(err, `delete ${user.username}`)
    }
  })
  const roleFrom = asking?.what === 'role' ? asking.from : (isAdmin ? 'admin' : 'user')

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => { if (!busy) setOpen(o => !o) }}
        // Not `disabled` while a change is out: the dialog gives the focus
        // back to this button, and a disabled one cannot take it.
        aria-disabled={busy || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${user.username}`}
        className="grid h-11 w-11 place-items-center rounded-control text-ink-2 hover:text-ink hover:bg-action-soft aria-disabled:opacity-50"
      >
        <Icon name="moreVertical" size={16} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="w-48 rounded-control bg-surface-raised-2 shadow-[shadow:var(--shadow-modal)] z-[60] overflow-hidden animate-fade-in"
        >
          <button
            role="menuitem"
            onClick={() => ask('role')}
            disabled={busy}
            className="w-full min-h-[44px] text-left px-4 py-2.5 text-sm text-ink hover:bg-action-soft disabled:opacity-50 flex items-center gap-2.5"
          >
            <Icon name="shield" size={14} className="text-ink-2" />
            {isAdmin ? 'Remove admin' : 'Make admin'}
          </button>
          <div className="border-t border-line" />
          <button
            role="menuitem"
            onClick={() => ask('delete')}
            disabled={busy}
            className="w-full min-h-[44px] text-left px-4 py-2.5 text-sm text-danger-ink hover:bg-action-soft disabled:opacity-50 flex items-center gap-2.5"
          >
            <Icon name="trash" size={14} className="text-danger-ink" />
            Delete user
          </button>
        </div>,
        document.body,
      )}
      <ConfirmDialog
        {...flow.dialog}
        open={asking?.what === 'role'}
        error={flow.dialog.error && <FailureText failure={flow.dialog.error} />}
        title={roleFrom === 'admin' ? `Remove admin from ${user.username}?` : `Make ${user.username} an admin?`}
        confirmLabel={busy ? 'Changing…' : roleFrom === 'admin' ? 'Remove admin' : 'Make admin'}
        safeFirst={roleFrom !== 'admin'}
        onConfirm={() => { void handleRole() }}
        fallbackFocus={() => triggerRef.current}
      >
        {roleFrom === 'admin'
          ? `${user.username} loses the admin pages and every admin power. They stay signed in.`
          : `${user.username} gets the admin pages and every admin power: users, libraries, settings, backups and restores.`}
      </ConfirmDialog>
      <ConfirmDialog
        {...flow.dialog}
        open={asking?.what === 'delete'}
        error={flow.dialog.error && <FailureText failure={flow.dialog.error} />}
        title={`Delete ${user.username}?`}
        confirmLabel={busy ? 'Deleting…' : 'Delete user'}
        destructive
        safeFirst
        onConfirm={() => { void handleDelete() }}
        fallbackFocus={() => triggerRef.current}
      >
        Their profiles, watch history, lists, collections, requests and rooms are deleted with them, and every
        device they are signed in on is signed out. This cannot be undone.
      </ConfirmDialog>
      <div className="mt-1 max-w-[16rem] text-left empty:hidden">{flow.panelNotes}<FailureNote failure={rowNote} /></div>
    </>
  )
}

// AdminView wired to /api/admin/* endpoints. Each tab lazy-fetches
// on first visit and caches for the session.
// Dashboard stat tile (Aurora Stage Phase 7a).
//
// The mockup's .stat-tile leads with the VALUE at display size and puts the
// label under it; the previous markup did the reverse — a 14px label row with an
// icon, then the number. On a four-up row of numbers the number is what you
// scan, so it goes first and gets the display face.
//
// Extracted because the dashboard rendered this same block twice, verbatim, for
// the two stat rows (core stats, and the optional embedding/skip-marker pair).
export type StatTileProps = {
  label: string
  value: string
  icon: string
  color: string
  /** Tooltip on the label. Use it wherever a tile's denominator isn't
   *  what the label implies — these numbers sit in one row and read as
   *  comparable when several of them count different populations. */
  hint?: string
  /** Optional second line under the label, for a breakdown the headline
   *  figure doesn't carry. */
  sub?: string
}

function StatTile({ label, value, icon, color, hint, sub }: StatTileProps) {
  return (
    <div className="bg-surface-raised rounded-control px-[18px] py-4">
      {/* tabular-nums so a row of tiles does not jitter its digits as the
          numbers tick — several of these poll. */}
      <p className="text-ink font-display font-extrabold text-[26px] leading-none tracking-tight tabular-nums">
        {value}
      </p>
      <div
        className={`text-ink-2 text-xs mt-1.5 flex items-center gap-[7px] ${hint ? 'cursor-help' : ''}`}
        title={hint}
      >
        <Icon name={icon} size={13} className={color} />
        {label}
        {hint && <span className="text-ink-3">ⓘ</span>}
      </div>
      {sub && <p className="text-ink-2 text-xs mt-1 tabular-nums">{sub}</p>}
    </div>
  )
}

// The sections, their names and their grouping live in AdminShell. `AdminTab`
// is the name this file has always used for one.
type AdminTab = AdminSection

export default function AdminView({ currentAdminId, catalogVersion = 0, initialSection, sectionAsk = 0 }: {
  currentAdminId: number
  /** App's live catalog version (hooks/useCatalogVersion); a change means a
   *  scan added titles, so the dashboard's counts refresh. */
  catalogVersion?: number
  /** The section the page opens on (the scan bar's "Open Libraries"); the
   *  overview when none is asked for. */
  initialSection?: AdminSection
  /** Counts the asks for `initialSection`. A new one while the page is up
   *  opens that section again, in place: the page is not remounted (which
   *  fetched the dashboard again and dropped what the open section held). */
  sectionAsk?: number
}) {
  const [tab, setTab] = useState<AdminTab>(initialSection ?? 'dashboard')
  // The server's record of the latest restore, read when the page opens and
  // again when a restore this tab sent ends (hooks/useRestoreRecord): a
  // restore no longer ends with its request, so a reload, another admin or a
  // request that got no answer learns of it here.
  const { outcome: restoreOutcomeNow, out: restoresOut, ended: restoresEnded } = useRestoreOutcome()
  const restoreMine = restoreOutcomeNow && restoreOutcomeNow.accountId === currentAdminId ? restoreOutcomeNow : null
  // A restore of this tab's that got no answer: keep asking until the server
  // says how it went (the no-answer words promise it).
  const restoreUnanswered = !!restoreMine && !restoreMine.ok && !!restoreMine.lost
  const restoreRecord = useRestoreRecord({ adminRead: getAdminRestoreStatus, recheck: restoresEnded, keepAsking: restoreUnanswered })
  // This tab's own answer is said by RestoreOutcomeAlert; the record is not
  // said beside it, except for a restore running now.
  const restoreAnswered = !!restoreMine && (restoreMine.ok || !restoreMine.lost)
  // A restore running is always said, this tab's own included. What the
  // admin must act on is said when this tab has no answer of its own about
  // it, and not while a request of this tab's is out (its record does not
  // exist until the upload ends).
  const restoreAside = restoreRecord.status?.state === 'running' || (restoresOut === 0 && !restoreAnswered &&
    (!!restoreRecord.lost || (!!restoreRecord.status && !!restoreWords(restoreRecord.status)?.urgent)))
  useEffect(() => {
    if (initialSection) setTab(initialSection)
  }, [sectionAsk, initialSection])

  // /api/admin/backup streams a pg_dump archive. We fetch with the
  // Authorization header (rather than a tokenized anchor) so the
  // token never enters the DOM, then materialize the response as a
  // Blob for download. Trade-off: whole-archive buffering, but
  // pg_dump custom-format is self-compressed so even multi-GB DBs
  // fit comfortably.
  // Answers what came of it, said beside the button by the backup panel.
  const downloadBackup = useCallback(async (): Promise<Failure | null> => {
    try {
      const res = await apiFetchResponse('/api/admin/backup')
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        // The server's sentence from its error shape ({error: {message}} or
        // {error: "…"}), else the text as sent.
        let said = body.slice(0, 200)
        try {
          const err = (JSON.parse(body) as { error?: unknown }).error
          if (typeof err === 'string') said = err
          else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') said = (err as { message: string }).message
        } catch { /* not JSON: the text as it came */ }
        // An APIError, so the status reaches the words the panel says.
        throw new APIError(res.status, said || `HTTP ${res.status}`, body)
      }
      // Derive a filename from Content-Disposition; fall back to a
      // timestamp-based default.
      const cd = res.headers.get('content-disposition') || ''
      const m = /filename="?([^"]+)"?/i.exec(cd)
      const filename = m ? m[1] : `aurora-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Release the blob URL on the next tick so the browser has
      // finished kicking off the save dialog.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return null
    } catch (e) {
      return adminFailure(e, 'download a backup', { 409: 'A backup or restore is already running. Try again when it has finished.' })
    }
  }, [])
  // What the admin still has to do, kept while the page is up so that it is
  // said again when its section is opened again.
  const [llmRestart, setLLMRestart] = useState(false)
  const [usersSaid, sayUsers] = useSaid()
  const [inviteFailed, setInviteFailed] = useState<Failure | null>(null)
  // The users read again in place (a role change that may or may not have
  // been made): the list stays up meanwhile, and a failed read keeps it.
  const reloadUsers = useCallback(async () => {
    try { setUsers(await listAdminUsers()); return true } catch { /* the list on screen stays */ return false }
  }, [])
  // A deleted user's row takes its menu, and the focus in it, away: the
  // users table takes it instead, once the row has gone.
  const usersTableRef = useRef<HTMLDivElement | null>(null)
  const [userGone, setUserGone] = useState(0)
  useEffect(() => {
    if (userGone === 0) return
    if (!document.activeElement || document.activeElement === document.body) usersTableRef.current?.focus({ preventScroll: true })
  }, [userGone])

  const [stats, setStats] = useState<ServerStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsErr, setStatsErr] = useState<string | null>(null)
  const [embStatus, setEmbStatus] = useState<EmbeddingStatus | null>(null)
  // Smart Skip coverage (intro/credits markers) — same lazy-card
  // pattern as the embedding status above.
  const [skipStatus, setSkipStatus] = useState<SkipMarkerStatus | null>(null)
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersErr, setUsersErr] = useState<string | null>(null)
  // Current referral options, for resolving the Users table's stored keys to
  // labels. Empty is fine — unknown keys render as "removed: <key>".
  const [referralOptions, setReferralOptions] = useState<ReferralOption[]>([])
  // Invite code generation lives on the Users tab (its natural home)
  // rather than the Server settings tab. Local state so the latest code
  // sticks around until the admin clicks Generate again or navigates away.
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityErr, setActivityErr] = useState<string | null>(null)
  // '' = every type. Filtering is server-side (?type=), so this must clear
  // `activity` to let the fetch effect re-run — same dance as logLevel.
  const [activityType, setActivityType] = useState('')
  const [activityTypes, setActivityTypes] = useState<ActivityEventType[] | null>(null)
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const [logLevel, setLogLevel] = useState<LogLevelFilter>('all')
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsErr, setLogsErr] = useState<string | null>(null)

  // Side-cards (Skip Analysis, Titles Embedded) load once on mount, on their
  // own effect. They used to share the dashboard-stats effect below,
  // but that effect's cleanup fires the moment stats first resolves
  // (its [stats] dep flips null -> object), which aborted these
  // still-in-flight requests whenever the heavier skip-marker COUNT
  // query lost the race to the stats fetch. The card then stayed blank
  // until a page refresh warmed the DB cache and let it win the race
  // (issue #313 follow-up). A mount-only effect is cleaned up only on
  // unmount, so these requests always run to completion.
  useEffect(() => {
    const cardsAc = new AbortController()
    getEmbeddingStatus(cardsAc.signal).then(setEmbStatus).catch(() => { /* card hides if unavailable */ })
    getSkipMarkerStatus(cardsAc.signal).then(setSkipStatus).catch(() => { /* card hides if unavailable */ })
    return () => cardsAc.abort()
  }, [])

  // Dashboard is the landing tab — fetch on mount. The other tabs
  // fetch when the user navigates to them so we don't trigger four
  // API calls just because someone clicked "Admin".
  useEffect(() => {
    if (stats !== null) return
    // Dashboard-stats fetch uses a cancelled flag rather than an
    // AbortController so an in-flight retry is not killed by cleanup —
    // only stale setState is suppressed.
    let cancelled = false
    setStatsLoading(true)
    getAdminDashboard()
      .then(s => { if (!cancelled) setStats(s) })
      .catch(err => {
        if (cancelled || (err && err.name === 'AbortError')) return
        setStatsErr(err instanceof Error ? err.message : 'Failed to load stats')
      })
      .finally(() => { if (!cancelled) setStatsLoading(false) })
    return () => { cancelled = true }
  }, [stats])

  // A scan added titles (catalogVersion moved) since the dashboard's numbers
  // were read: refetch them while the dashboard tab is showing, or when it is
  // next shown. Quiet: the old numbers stay until the new ones land, and a
  // failure keeps them (the next update or showing tries again). The view
  // mounts fresh on each visit to /admin, so this only covers changes while
  // it is open.
  //
  // One refresh at a time, not aborted by the next update (on a busy server
  // that starved every refresh until the scan ended): once it lands the
  // numbers are still behind if another update came, and this runs again.
  // Only an unmount aborts it, so re-running on the new stats object cannot
  // abort the side cards' requests, the race the comment on the mount-only
  // effect above describes.
  const dashboardVersionRef = useRef(catalogVersion)
  const dashboardRefreshRef = useRef<AbortController | null>(null)
  useEffect(() => () => {
    dashboardRefreshRef.current?.abort()
    dashboardRefreshRef.current = null
  }, [])
  useEffect(() => {
    if (tab !== 'dashboard' || stats === null) return
    if (dashboardVersionRef.current === catalogVersion || dashboardRefreshRef.current) return
    const version = catalogVersion
    const ac = new AbortController()
    dashboardRefreshRef.current = ac
    const stopTimeout = abortAfter(ac)
    // The side cards count files and titles too; each keeps its last value
    // when its own refetch fails.
    Promise.all([
      getAdminDashboard(ac.signal),
      getEmbeddingStatus(ac.signal).catch(() => null),
      getSkipMarkerStatus(ac.signal).catch(() => null),
    ])
      .then(([s, emb, skip]) => {
        stopTimeout()
        if (dashboardRefreshRef.current !== ac) return
        dashboardRefreshRef.current = null
        dashboardVersionRef.current = version
        setStats(s)
        if (emb) setEmbStatus(emb)
        if (skip) setSkipStatus(skip)
      })
      .catch(() => {
        // Keep the numbers on screen (also after LIVE_REFRESH_TIMEOUT_MS).
        stopTimeout()
        if (dashboardRefreshRef.current === ac) dashboardRefreshRef.current = null
      })
  }, [tab, stats, catalogVersion])

  useEffect(() => {
    if (tab !== 'users' || users !== null) return
    const ac = new AbortController()
    setUsersLoading(true)
    listAdminUsers(ac.signal)
      .then(u => setUsers(u))
      .catch(err => {
        if (err && err.name === 'AbortError') return
        setUsersErr(err instanceof Error ? err.message : 'Failed to load users')
      })
      .finally(() => setUsersLoading(false))
    return () => ac.abort()
  }, [tab, users])

  // The Referral column stores option KEYS, so it needs the option list the
  // server actually SERVES to render labels. That is not the raw
  // `referral_prompt_options` setting: empty is the normal state and means
  // "built-in defaults in use", so parsing it here resolved labels against []
  // and every live default key rendered as "<removed: friend>" on any
  // instance whose operator never customized the list — the exact failure
  // referralOptionsFromSummary's comment documents. The summary endpoint
  // labels every answered key against the effective list server-side; derive
  // the options from its rows (windowDays 0 — a window would drop keys whose
  // answers all pre-date it).
  // Refetched on every entry to the tab — NOT folded into the users effect
  // above, whose `users !== null` guard would have pinned the labels for the
  // session, so editing an option on the OAuth tab and coming back here
  // showed the old text until a full reload. Failure is non-fatal: a failed
  // FIRST fetch leaves [], so labels degrade to "<removed: key>", which is
  // honest; a failed refetch keeps the previous entry's labels instead.
  useEffect(() => {
    if (tab !== 'users') return
    const ac = new AbortController()
    getAdminReferralSummary(0, ac.signal)
      .then(s => setReferralOptions(referralOptionsFromSummary(s.by_source)))
      .catch(() => { /* labels degrade to the raw key */ })
    return () => ac.abort()
  }, [tab])

  useEffect(() => {
    if (tab !== 'activity' || activity !== null) return
    const ac = new AbortController()
    setActivityLoading(true)
    // Clear a prior failure before retrying, like the logs effect below.
    // Without this a transient error stayed pinned above the rows for the
    // life of the mount, even once a later load succeeded.
    setActivityErr(null)
    listAdminActivity(50, { eventType: activityType, signal: ac.signal })
      .then(a => setActivity(a))
      .catch(err => {
        if (err && err.name === 'AbortError') return
        setActivityErr(err instanceof Error ? err.message : 'Failed to load activity')
      })
      .finally(() => setActivityLoading(false))
    // Cleanup so a rapid tab-switch doesn't fire setState on an
    // unmounted AdminView.
    return () => ac.abort()
  }, [tab, activity, activityType])

  // Filter options, loaded once per mount alongside the first activity page.
  // A failure here leaves the dropdown at "All activity" rather than blocking
  // the log itself — the rows are the point, the filter is an affordance.
  useEffect(() => {
    if (tab !== 'activity' || activityTypes !== null) return
    const ac = new AbortController()
    listAdminActivityTypes(ac.signal)
      .then(t => setActivityTypes(t))
      .catch(() => { /* dropdown stays on "All activity" */ })
    return () => ac.abort()
  }, [tab, activityTypes])

  useEffect(() => {
    if (tab !== 'logs' || logs !== null) return
    const ac = new AbortController()
    setLogsLoading(true)
    setLogsErr(null)
    // logLevel is a dependency, but the `logs !== null` guard above would
    // block the refetch — switching filters clears `logs` first (see the
    // toggle) so this effect re-runs against the other ring.
    listAdminLogs(logLevel, ac.signal)
      .then(l => setLogs(l))
      .catch(err => {
        if (err && err.name === 'AbortError') return
        setLogsErr(err instanceof Error ? err.message : 'Failed to load logs')
      })
      .finally(() => setLogsLoading(false))
    // Same cleanup pattern as activity above.
    return () => ac.abort()
  }, [tab, logs, logLevel])

  // Helpers for human-readable formatting.
  const fmtBytes = (n: number): string => {
    if (n <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
    return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
  }
  const fmtRelative = (iso: string): string => {
    const then = new Date(iso).getTime()
    if (!then) return iso
    const diff = Date.now() - then
    if (diff < 60_000) return 'just now'
    // QA BUG-007 — pluralize correctly for n === 1.
    // "min" stays unchanged across counts (it's already abbreviated),
    // "hr" / "day" pick the singular when n is exactly 1.
    const mins = Math.floor(diff / 60_000)
    if (diff < 3_600_000) return `${mins} min ago`
    const hrs = Math.floor(diff / 3_600_000)
    if (diff < 86_400_000) return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'} ago`
    const days = Math.floor(diff / 86_400_000)
    return `${days} ${days === 1 ? 'day' : 'days'} ago`
  }

  return (
    // A section opens when its name is pressed, and only then loads what it
    // shows (the effects above key on `tab`): two of them poll, so nothing is
    // mounted that is not on screen.
    <AdminShell current={tab} onSection={setTab}>
      {/* Every section but Backup and restore (which says the record
          itself): a restore running, or one whose end the admin must act on,
          that this tab has no answer of its own about. */}
      {tab !== 'backup' && restoreAside && (
        <RestoreRecordNote record={restoreRecord} server={restoreServerLine(restoreRecord.status)} className="mb-6" />
      )}
      {tab === 'dashboard' && (
        <div>
          {statsErr && (
            <div className="mb-6 px-5 py-3 rounded-control bg-surface-raised-2 border border-line text-danger-ink text-sm">{statsErr}</div>
          )}
          {statsLoading && !stats && (
            <div className="mb-6 text-ink-2 text-sm">Loading stats…</div>
          )}
          {(skipStatus?.enabled || embStatus?.enabled) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4 mb-6">
              {([
                ...(embStatus && embStatus.enabled
                  ? [{
                      label: 'Titles embedded',
                      value: `${embStatus.embedded.toLocaleString()} / ${embStatus.total.toLocaleString()}`,
                      icon: 'cpu',
                      color: embStatus.pending > 0 ? 'text-warn' : 'text-ok',
                      hint: 'Media items with a semantic-search embedding — one per title (movie or show), not one per file. Shares its denominator with the Movies and shows tile, not with Skip analysis.',
                    }]
                  : []),
                ...(skipStatus && skipStatus.enabled
                  // Return type annotated, not left to `satisfies` on the
                  // enclosing array: contextual typing does not flow into an
                  // IIFE return, so excess-property checking silently stops
                  // at this element. A `hnit:` typo would compile clean and
                  // drop the tooltip this change exists to add.
                  ? ((): StatTileProps[] => {
                      const { analyzed, total, behind, empty } = skipCoverage(skipStatus)
                      return [{
                        // Was "Skip Markers", which named the wrong noun:
                        // the figure counts FILES the detector has been
                        // through, and a file it found nothing in still
                        // counts. The marker counts the endpoint already
                        // returns now ride the sub-line.
                        label: 'Skip analysis',
                        value: `${analyzed.toLocaleString()} / ${total.toLocaleString()}`,
                        icon: 'film',
                        color: empty ? 'text-ink-3' : behind ? 'text-warn' : 'text-ok',
                        hint: 'Video files scanned for intro/recap/credits: every episode file plus every movie file. A file the detector found nothing in still counts as analyzed, so this is coverage, not markers found. Both figures cover the CURRENT detector version, plus hand-edited markers, which survive a bump. So after a detector bump coverage drops to zero while the marker counts fall only to the hand-edited remainder, and players keep using markers from the previous version until each file is re-swept. Counts FILES — the Movies and shows tile counts titles, and the Server card below counts episode rows, so neither will reconcile against this exactly (a dual-version episode is two files, one row).',
                        sub: formatSkipMarkers(skipMarkerTotals(skipStatus)),
                      }]
                    })()
                  : []),
              ] satisfies StatTileProps[]).map(s => (
                <StatTile key={s.label} {...s} />
              ))}
            </div>
          )}
          {stats && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {([
                  // QA BUG-002 relabelled "Total Media" -> "Media File
                  // Entries" to stress this is a raw row count, not the
                  // deduped title count on browse pages. That fixed one
                  // reading and broke another: the figure counts no
                  // files at all. It is movie_count + show_count from
                  // media_items, so every episode is excluded — which
                  // parked "846 media FILES" next to a Skip Analysis
                  // tile counting 8,177 actual files and made a correct
                  // dashboard look broken. Name the rows it counts, and
                  // send episodes to the Server card below.
                  {
                    label: 'Movies and shows',
                    value: (stats.movie_count + stats.show_count).toLocaleString(),
                    icon: 'film',
                    color: 'text-ink-2',
                    hint: 'Title rows: movies plus series. Episodes are NOT included — the Server card below counts those separately. Raw COUNT, so cross-library duplicates are counted twice and this can exceed the deduped total on browse pages.',
                  },
                  { label: 'Users', value: stats.user_count.toLocaleString(), icon: 'users', color: 'text-ink-2' },
                  {
                    label: 'Active streams',
                    value: String(stats.active_streams),
                    icon: 'monitor',
                    color: 'text-ink-2',
                    hint: 'Streams being watched — transcode plus direct play. A Chromecast holds two server sessions for one viewer (the paused browser session and the cast-safe clone the TV pulls); they count once here and are nested together under Now playing.',
                  },
                  { label: 'Disk free', value: `${stats.disk_free_gb.toFixed(1)} GB`, icon: 'hardDrive', color: 'text-ink-2' },
                ] satisfies StatTileProps[]).map(s => (
                  <StatTile key={s.label} {...s} />
                ))}
              </div>

              <div className="bg-surface-raised rounded-control p-6 mb-6">
                <h3 className="text-ink font-semibold mb-4">Server</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-ink-2 text-xs uppercase tracking-wide mb-1">Version</p>
                    <p className="text-ink">{stats.version}</p>
                  </div>
                  <div>
                    <p className="text-ink-2 text-xs uppercase tracking-wide mb-1">Uptime</p>
                    <p className="text-ink">{stats.uptime}</p>
                  </div>
                  <div title="Aurora's Go process RSS after the last GC. FFmpeg transcoders run as separate subprocesses and aren't counted here. PostgreSQL runs in its own container with its own memory budget.">
                    <p className="text-ink-2 text-xs uppercase tracking-wide mb-1 cursor-help">Memory <span className="text-ink-3">ⓘ</span></p>
                    <p className="text-ink">{stats.memory_alloc_mb} MB</p>
                  </div>
                  <div>
                    <p className="text-ink-2 text-xs uppercase tracking-wide mb-1">Goroutines</p>
                    <p className="text-ink">{stats.goroutines}</p>
                  </div>
                  <div>
                    <p className="text-ink-2 text-xs uppercase tracking-wide mb-1">Libraries</p>
                    <p className="text-ink">{stats.library_count}</p>
                  </div>
                  <div>
                    <p className="text-ink-2 text-xs uppercase tracking-wide mb-1">Episodes</p>
                    <p className="text-ink">{stats.episode_count.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-ink-2 text-xs uppercase tracking-wide mb-1">Library size</p>
                    <p className="text-ink">{fmtBytes(stats.total_file_size_bytes)}</p>
                  </div>
                  <div>
                    <p className="text-ink-2 text-xs uppercase tracking-wide mb-1">Active parties</p>
                    <p className="text-ink">{stats.active_parties}</p>
                  </div>
                </div>
              </div>

              {/* Phase 8 — Update panel. Surfaces the auto-updater
                  status (5-min timer) and exposes a manual "Update
                  now" trigger for quick patching. Self-contained
                  polling — slows to 10s when idle, accelerates to
                  2s during an active update so the user sees phase
                  transitions live. */}
              <div className="mb-6">
                <UpdatePanel />
              </div>

              {/* Phase 5 — Now Playing widget. Uses listAdminSessions
                  as the source (live stream sessions are the closest
                  proxy for "who is currently watching"). Polls every
                  5s; the dashboard tab is already lazy-loaded so the
                  poll is dormant when the admin isn't looking. */}
              <NowPlayingWidget />
            </>
          )}
        </div>
      )}

      {tab === 'users' && (
        <div className="space-y-4">
          {/* Invite section — primary entry point for adding new users.
              Lives here (next to the user list) rather than under
              Server settings because that's where admins look. */}
          <div className="bg-surface-raised rounded-control p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="text-ink font-semibold mb-1">Invite a user</h3>
                <p className="text-ink-2 text-xs">Generate a one-time code. Share it with the person you want to invite — they'll enter it on the Register screen.</p>
              </div>
              <button
                disabled={inviteBusy}
                onClick={async () => {
                  setInviteBusy(true); setInviteCopied(false); setInviteFailed(null)
                  try { const r = await createInvite(); setInviteCode(r.code); sayUsers('A new invite code is ready below.') }
                  catch (e) { setInviteFailed(adminFailure(e, 'make an invite code')) }
                  finally { setInviteBusy(false) }
                }}
                className="stage-btn stage-btn-primary"
              >{inviteBusy ? 'Generating…' : 'Generate invite code'}</button>
            </div>
            <FailureNote failure={inviteFailed} className="mt-3" />
            <StatusLine said={usersSaid} className="mt-3" />
            {/* data-screenshot-exclude — a live invite code is a one-time
                credential; blank the whole reveal block from bug-report
                screenshots (the capture path drops tagged subtrees). */}
            {inviteCode && (
              <div data-screenshot-exclude="true" className="mt-4 p-4 bg-surface-raised-2 border border-line rounded-chip flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="text-ink-2 text-xs mb-1">Share this code:</p>
                  <p className="font-mono text-lg text-ink tracking-wider break-all">{inviteCode}</p>
                </div>
                <button
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(inviteCode); setInviteCopied(true); setTimeout(() => setInviteCopied(false), 2000) }
                    catch { /* clipboard API may be unavailable on http:// — silently no-op */ }
                  }}
                  className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost"
                >{inviteCopied ? '✓ Copied' : 'Copy'}</button>
              </div>
            )}
          </div>

          {/* Scrolls sideways on a phone. It was `overflow-hidden`, which cut
              the last columns off, the row's menu with them. */}
          <div ref={usersTableRef} tabIndex={-1} role="region" aria-label="Users on this server" className="bg-surface-raised rounded-control overflow-x-auto">
          {usersLoading && !users && <p className="p-6 text-ink-2 text-sm">Loading users…</p>}
          {usersErr && <p className="p-6 text-danger-ink text-sm">{usersErr}</p>}
          {users && (
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Sign-in</th>
                  <th>Referral</th>
                  <th>Created</th>
                  <th>Last login</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <ProfileAvatar avatarUrl={u.avatar_url} name={u.username} memberKey={u.id} size={32} />
                        <div>
                          <p className="text-ink text-sm font-medium">{u.username}</p>
                          <p className="text-ink-2 text-xs">{u.email || '—'}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`badge-glass text-xs ${u.role === 'admin' ? 'bg-surface-raised-2 text-ink border-line' : 'bg-surface-raised-2 text-ink-2 border-line'}`}>
                        {u.role}
                      </span>
                    </td>
                    <td>
                      <span className="text-ink-2 text-sm">{u.oauth_provider ? u.oauth_provider : 'password'}</span>
                    </td>
                    <td>
                      <ReferralCell
                        user={u}
                        options={referralOptions}
                        answeredAt={u.referral_answered_at ? fmtRelative(u.referral_answered_at) : undefined}
                      />
                    </td>
                    <td className="text-ink-2">{fmtRelative(u.created_at)}</td>
                    <td className="text-ink-2">{u.last_login_at ? fmtRelative(u.last_login_at) : 'Never'}</td>
                    <td className="text-right">
                      {/* 3-dot actions: promote/demote + delete. Hidden on the
                          current admin's own row — the server refuses both
                          self-delete and self-role-change with a 4xx, so this
                          just spares them a menu of dead options. */}
                      {currentAdminId !== u.id && (
                        <div className="flex flex-col items-end">
                          <UserRowMenu
                            user={u}
                            onRoleChanged={(role) => setUsers(prev => prev ? prev.map(x => x.id === u.id ? { ...x, role } : x) : prev)}
                            onDeleted={() => { setUsers(prev => prev ? prev.filter(x => x.id !== u.id) : prev); setUserGone(n => n + 1) }}
                            reloadUsers={reloadUsers}
                            say={sayUsers}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={7} className="text-ink-2 text-sm text-center py-6">No users found.</td></tr>
                )}
              </tbody>
            </table>
          )}
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="bg-surface-raised rounded-control p-6">
          <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
            <p className="text-ink-2 font-sans text-sm">What people did on this server, newest first.</p>
            {/* Server-side filter (?type=). The option list comes from the
                server's distinct event types, so it can't drift from the
                types handlers actually write, and only lists what this
                instance has recorded. */}
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <span>Filter</span>
              <select
                value={activityType}
                onChange={e => {
                  setActivityType(e.target.value)
                  // Let the fetch effect's `activity !== null` guard re-run
                  // against the new filter, exactly like the log-level toggle.
                  setActivity(null)
                }}
                className="px-3 py-2 bg-surface-raised-2 border border-line rounded-chip text-ink text-sm"
              >
                <option value="">All activity</option>
                {(activityTypes ?? []).map(t => (
                  <option key={t.event_type} value={t.event_type}>
                    {t.event_type.replace(/_/g, ' ')} ({t.count})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {activityLoading && !activity && <p className="text-ink-2 text-sm">Loading activity…</p>}
          {activityErr && <p className="text-danger-ink text-sm">{activityErr}</p>}
          {activity && (
            <div className="space-y-3">
              {activity.length === 0 && (
                <p className="text-ink-2 text-sm">
                  {activityType
                    ? `No "${activityType.replace(/_/g, ' ')}" activity recorded.`
                    : 'No recent activity.'}
                </p>
              )}
              {activity.map((e) => (
                <div key={e.id} className="flex items-center gap-4 py-2 border-b border-line last:border-0">
                  <div className="w-8 h-8 rounded-full bg-surface-raised-2 flex items-center justify-center flex-shrink-0">
                    <Icon name="activity" size={14} className="text-ink" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-ink-2 text-sm">{e.event_type.replace(/_/g, ' ')}</span>
                  </div>
                  {e.username && <span className="text-ink-2 text-xs">{e.username}</span>}
                  <span className="text-ink-2 text-xs whitespace-nowrap">{fmtRelative(e.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'logs' && (
        <div className="bg-surface-raised rounded-control p-6 font-mono text-xs">
          <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
            <p className="text-ink-2 font-sans text-sm">The server’s own log, newest first.</p>
            {/* Level filter. 'Problems' reads a SEPARATE server-side ring for
                WARN+ERROR rather than filtering what's already loaded: the
                main ring holds ~1000 entries, which is minutes of history at
                Aurora's request volume, so a client-side filter would show
                nothing for an incident twenty minutes old. */}
            <div className="flex items-center gap-1 rounded-control bg-surface-raised-2 p-1 font-sans" role="group" aria-label="Log level filter">
              {([
                { key: 'all' as const, label: 'All' },
                { key: 'problems' as const, label: 'Warnings & errors' },
              ]).map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  aria-pressed={logLevel === opt.key}
                  onClick={() => {
                    if (logLevel === opt.key) return
                    setLogLevel(opt.key)
                    // Clear so the fetch effect's `logs !== null` guard lets
                    // it re-run against the other ring.
                    setLogs(null)
                  }}
                  className={`h-11 rounded-art px-3.5 text-[13px] font-semibold transition-colors ${
                    logLevel === opt.key ? 'bg-action text-action-on' : 'text-ink-2 hover:text-ink'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {logLevel === 'problems' && (
            <p className="text-ink-2 text-xs font-sans mb-3">
              Warnings and errors are kept in a dedicated buffer, so these reach
              much further back than the full log.
            </p>
          )}
          {logsLoading && !logs && <p className="text-ink-2 text-sm font-sans">Loading logs…</p>}
          {logsErr && <p className="text-danger-ink text-sm font-sans">{logsErr}</p>}
          {logs && (
            <div className="space-y-1 max-h-[500px] overflow-y-auto">
              {logs.length === 0 && (
                <p className="text-ink-2 text-sm font-sans">
                  {logLevel === 'problems'
                    ? 'No warnings or errors recorded.'
                    : 'No log entries.'}
                </p>
              )}
              {logs.map((entry, i) => {
                // QA BUG-011 — surface structured attrs.
                // RequestLogger emits method/path/status/latency/user_id;
                // without rendering these the log view was just a wall
                // of "[INFO] request" with no triage value. For request
                // logs we format compactly; for everything else we dump
                // remaining attrs as key=value pairs (skipping null/empty).
                const attrs = entry.attrs ?? {}
                const isRequest = entry.message === 'request'
                let summary = ''
                if (isRequest) {
                  const method = String(attrs.method ?? '')
                  const path = String(attrs.path ?? '')
                  const status = attrs.status
                  const latency = attrs.latency
                  const uid = attrs.user_id
                  const parts: string[] = []
                  if (method) parts.push(method)
                  if (status !== undefined && status !== null) parts.push(String(status))
                  if (path) parts.push(path)
                  if (latency !== undefined && latency !== null && latency !== '') parts.push(String(latency))
                  if (uid !== undefined && uid !== null && uid !== 0 && uid !== '') parts.push(`uid=${String(uid)}`)
                  summary = parts.join(' ')
                } else {
                  // Non-request log — show message then any non-empty attrs.
                  // Filter only on null/undefined/empty-string. Zero values
                  // (e.g. retries=0 / queued=0 / failed=0) are legitimate
                  // log signals indicating "no work pending" or "no
                  // errors" and should NOT be hidden. Errors are
                  // pre-stringified by ringbuffer.go's serializeAttrValue
                  // so they render as readable text, not "{}".
                  const tail = Object.entries(attrs)
                    .filter(([_, v]) => v !== null && v !== undefined && v !== '')
                    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                    .join(' ')
                  summary = tail ? `${entry.message} · ${tail}` : entry.message
                }
                return (
                  <div key={i} className="flex gap-3">
                    <span className="text-ink-2 flex-shrink-0">{new Date(entry.time).toLocaleString()}</span>
                    <span className={`flex-shrink-0 ${
                      entry.level === 'ERROR' || entry.level === 'error' ? 'text-danger-ink' :
                      entry.level === 'WARN' || entry.level === 'warn' ? 'text-warn' :
                      'text-ink'
                    }`}>
                      [{entry.level.toUpperCase()}]
                    </span>
                    <span className="text-ink-2 break-words">{summary}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'libraries' && <AdminLibrariesTab />}
      {tab === 'rooms' && <AdminRoomsTab />}
      {tab === 'requests' && <AdminRequestsTab />}
      {tab === 'server' && <AdminServerSettingsTab />}
      {tab === 'sessions' && <AdminSessionsTab />}
      {tab === 'flagged' && <AdminFlaggedTab />}
      {tab === 'llm' && <AdminLLMTab restartNeeded={llmRestart} onRestartNeeded={() => setLLMRestart(true)} onDismissRestart={() => setLLMRestart(false)} />}
      {tab === 'oauth' && <AdminOAuthTab />}
      {tab === 'backup' && <AdminBackupRestore downloadBackup={downloadBackup} accountId={currentAdminId} record={restoreRecord} />}
      {tab === 'health' && <PlaybackHealth />}
    </AdminShell>
  )
}
