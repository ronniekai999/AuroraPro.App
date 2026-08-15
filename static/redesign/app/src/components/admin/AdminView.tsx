// Admin view + its tabs (libraries, server settings, rooms, requests,
// sessions, flagged, logs, LLM, OAuth, backup/restore), the server
// update panel, and the now-playing widget. Extracted from App.tsx
// (2026-06-17 app split) as the first lazy-loaded view chunk —
// non-admins never fetch this bundle. AdminView is the default export
// (lazy-loaded by App); the tab components are module-private.
// ManualMatchModal is imported from its own module because App also
// uses it (the global manual-identify overlay) and must not pull this
// chunk to get it.

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/Icon'
import { PageHeader } from '@/components/PageHeader'
import { formatRequestDate } from '@/lib/format'
import { skipCoverage, skipMarkerTotals, formatSkipMarkers } from '@/lib/adminDashboardTiles'
import ManualMatchModal from './ManualMatchModal'
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
  apiFetchResponse,
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

// server_settings keys for the referral prompt (migration 046). Named here so
// the editor and the Go whitelist can't drift on a string literal.
const REFERRAL_QUESTION_KEY = 'referral_prompt_question'
const REFERRAL_OPTIONS_KEY = 'referral_prompt_options'

/* ─────────────────────── ADMIN VIEW ─────────────────────── */
// Admin backup + restore card. Backup is a tokenized anchor
// download; restore is a multipart upload guarded by a hard-confirm.
function AdminBackupRestore({ downloadBackup }: { downloadBackup: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [doneBlocked, setDoneBlocked] = useState(false)
  // The restore POST can take minutes — guard against setState after
  // unmount if the admin tabs away mid-upload.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const onSubmit = async () => {
    if (!file) return
    const sizeMB = (file.size / 1024 / 1024).toFixed(1)
    const ok = window.confirm(
      `RESTORE — destructive operation\n\n` +
      `Overwrite ALL data with the contents of "${file.name}" (${sizeMB} MB)?\n\n` +
      `Aurora MUST be restarted after the restore completes. This cannot be undone except by ` +
      `restoring a different backup.`
    )
    if (!ok) return
    setSubmitting(true)
    setStatus('Uploading + restoring — may take a few minutes…')
    try {
      const form = new FormData()
      form.append('backup', file)
      const res = await apiFetchResponse('/api/admin/restore', {
        method: 'POST',
        body: form,
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
        throw new Error(errMsg)
      }
      // alert() survives an unmounted React component, so the admin
      // hears the outcome even if they tabbed away mid-restore.
      window.alert((body && body.message) || 'The database has been restored. RESTART AURORA NOW to use the new data.')
      if (!mountedRef.current) return
      setStatus('Restore complete — RESTART AURORA NOW')
      // Lock the button after success.
      setDoneBlocked(true)
    } catch (e) {
      console.error('[Aurora] Restore failed', e)
      const msg = e instanceof Error ? e.message : 'see console'
      // alert on failure too, so the admin still hears about it.
      window.alert('Restore failed: ' + msg)
      if (!mountedRef.current) return
      setStatus('Failed: ' + msg)
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="glass-panel rounded-2xl p-6">
        <h2 className="text-white font-semibold mb-2">Database Backup</h2>
        <p className="text-white/50 text-sm mb-4 leading-relaxed">
          Download a binary snapshot of Aurora's database — users, libraries, media items, watch
          parties, progress, settings. Use this before a server migration or as a periodic safety net.
        </p>
        <p className="text-white/40 text-xs mb-4 leading-relaxed">
          <strong className="text-white/60">Included:</strong> all Aurora tables except ephemeral
          session state (refresh tokens, scanner progress).
          <br />
          <strong className="text-white/60">Not included:</strong> the media files themselves and
          Aurora's config file (<code>aurora.env</code>) — copy those manually.
          <br />
          <strong className="text-white/60">Format:</strong> PostgreSQL custom-format dump (<code>.dump</code>)
          — restorable here or via <code>pg_restore</code> from the command line.
        </p>
        <button
          onClick={downloadBackup}
          className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          <Icon name="folder" size={16} /> Download Backup
        </button>
      </div>

      <div className="glass-panel rounded-2xl p-6" style={{ border: '1px solid rgba(255, 175, 0, 0.25)' }}>
        <h2 className="font-semibold mb-2" style={{ color: '#ffd685' }}>Database Restore</h2>
        <p className="text-white/50 text-sm mb-3 leading-relaxed">
          Upload a previously-downloaded <code>.dump</code> backup file to restore the database.
        </p>
        <p className="text-sm mb-3 leading-relaxed px-3 py-2 rounded-lg border-l-2" style={{ color: '#ffd685', background: 'rgba(255, 175, 0, 0.08)', borderColor: 'rgba(255, 175, 0, 0.6)' }}>
          <strong>Destructive operation.</strong> This OVERWRITES all existing data. After restore
          completes, <strong>Aurora must be restarted</strong> — current connections will see stale
          state until you do.
        </p>
        <p className="text-white/40 text-xs mb-4 leading-relaxed">
          The restore wraps every change in a single transaction. If any statement fails, the entire
          restore rolls back and the database is left in an empty (wiped) state — you can retry with
          a different file. Legacy <code>.sql.gz</code> backups need to be restored via the
          command line: <code>gunzip &lt; file.sql.gz | psql $DATABASE_URL</code>.
        </p>
        <div className="flex gap-3 flex-wrap items-center">
          <input
            type="file"
            accept=".dump,application/octet-stream"
            disabled={submitting || doneBlocked}
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            className="text-sm text-white/70 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-white/10 file:text-white/90 file:cursor-pointer hover:file:bg-white/15"
          />
          <button
            onClick={onSubmit}
            disabled={!file || submitting || doneBlocked}
            className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Icon name="refresh" size={16} /> {doneBlocked ? 'Restart Aurora to continue' : 'Restore Database'}
          </button>
        </div>
        {file && !doneBlocked && (
          <p className="text-white/40 text-xs mt-2">
            Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
          </p>
        )}
        {status && (
          <p className={`text-sm mt-3 ${status.startsWith('Failed') ? 'text-red-300' : 'text-white/70'}`}>{status}</p>
        )}
      </div>
    </div>
  )
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
  if (items.length === 0) return (
    <div className="glass-panel rounded-2xl p-6">
      <h2 className="text-white font-semibold mb-2">Now Playing</h2>
      <p className="text-white/40 text-sm">No active streams.</p>
    </div>
  )
  return (
    <div className="glass-panel rounded-2xl p-6">
      <h2 className="text-white font-semibold mb-4">Now Playing ({items.length})</h2>
      <div className="space-y-3">
        {items.map(s => (
          <div key={s.id} className="flex items-center gap-4 py-2 border-b border-white/[0.03] last:border-0">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {(s.username || users.get(s.user_id) || '?')[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white/90 text-sm font-medium truncate">{s.username || users.get(s.user_id) || `User ${s.user_id}`}</p>
              <p className="text-white/40 text-xs truncate">
                {s.file_name}
                {s.resolution && ` · ${s.resolution}`}
                {s.kind === 'direct' && ` · Direct Play`}
              </p>
            </div>
            <span className={`badge-glass text-xs ${s.kind === 'transcode' ? 'bg-amber-500/10 text-amber-300 border-amber-500/20' : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'}`}>{s.kind}</span>
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
    case 'checking':      return { label: 'Checking',     color: 'bg-blue-500/10 text-blue-300 border-blue-500/20', spinning: true }
    case 'updating':      return { label: 'Pulling',      color: 'bg-blue-500/10 text-blue-300 border-blue-500/20', spinning: true }
    case 'building':      return { label: 'Building',     color: 'bg-amber-500/10 text-amber-300 border-amber-500/20', spinning: true }
    case 'installing':    return { label: 'Installing',   color: 'bg-amber-500/10 text-amber-300 border-amber-500/20', spinning: true }
    case 'restarting':    return { label: 'Restarting',   color: 'bg-amber-500/10 text-amber-300 border-amber-500/20', spinning: true }
    case 'success':       return { label: 'Up to date',   color: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20', spinning: false }
    case 'failed':        return { label: 'Failed',       color: 'bg-red-500/10 text-red-300 border-red-500/20', spinning: false }
    case 'misconfigured': return { label: 'Misconfigured', color: 'bg-amber-500/10 text-amber-300 border-amber-500/20', spinning: false }
    case 'idle':          return { label: 'Up to date',   color: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20', spinning: false }
    case 'unknown':       return { label: 'Not run yet',  color: 'bg-white/5 text-white/50 border-white/10', spinning: false }
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
      <div className="glass-panel rounded-2xl p-6">
        <h2 className="text-white font-semibold mb-2">Updates</h2>
        <p className="text-white/40 text-sm">{error ?? 'Loading update status…'}</p>
      </div>
    )
  }

  const meta = updateStateMeta(status.state)
  const isActive = ACTIVE_STATES.has(status.state)
  const shortSha = (s?: string | null) => (s ? s.slice(0, 7) : null)

  return (
    <div className="glass-panel rounded-2xl p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-white font-semibold">Updates</h2>
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
          className="px-4 py-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 text-sm font-medium border border-purple-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={isActive ? 'An update is already in progress' : 'Pull, rebuild, restart now'}
        >
          {triggering ? 'Starting…' : isActive ? 'Updating…' : 'Update now'}
        </button>
      </div>

      <div className="space-y-2 text-sm">
        <p className="text-white/85">{status.message}</p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/50">
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
          <p className="text-white/40 text-xs">
            The auto-update timer fires every 5 minutes. If this never populates, run <code className="text-purple-300 bg-white/[0.04] px-1 rounded">systemctl status aurora-update.timer</code> on the server.
          </p>
        )}

        {error && (
          <p className="text-red-300 text-xs">{error}</p>
        )}
      </div>
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
  const reload = useCallback(async () => {
    try { setItems(await listLibraries()) }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }, [])
  useEffect(() => { void reload() }, [reload])
  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-2xl p-5">
        <h2 className="text-white font-semibold mb-3">Add Library</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name" className="px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
          <select value={newType} onChange={e => setNewType(e.target.value as 'movie' | 'show')} className="px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm">
            <option value="movie">Movies</option>
            <option value="show">TV Shows</option>
          </select>
          <input value={newPaths} onChange={e => setNewPaths(e.target.value)} placeholder="/path/to/library (comma-separated for multi)" className="md:col-span-2 px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </div>
        <button
          disabled={!newName || !newPaths || creating}
          onClick={async () => {
            setCreating(true)
            try {
              await createLibrary({ name: newName, type: newType, paths: newPaths.split(',').map(s => s.trim()).filter(Boolean) })
              setNewName(''); setNewPaths('')
              await reload()
            } catch (e) {
              window.alert('Failed: ' + (e instanceof Error ? e.message : 'unknown'))
            } finally { setCreating(false) }
          }}
          className="mt-3 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? 'Adding…' : 'Add'}
        </button>
      </div>
      <div className="glass-panel rounded-2xl p-5">
        <h2 className="text-white font-semibold mb-3">Existing Libraries</h2>
        {err && <p className="text-red-300 text-sm">{err}</p>}
        {items === null && <p className="text-white/40 text-sm">Loading…</p>}
        {items && items.length === 0 && <p className="text-white/40 text-sm">No libraries yet.</p>}
        {items && items.map(lib => (
          <div key={lib.id} className="flex items-center justify-between py-3 border-b border-white/[0.04] last:border-0 gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-white/90 text-sm font-medium truncate">{lib.name}</p>
              <p className="text-white/40 text-xs truncate">{lib.type} · {lib.paths.join(', ')}</p>
            </div>
            <button onClick={async () => { try { await scanLibrary(lib.id); window.alert('Scan kicked off.') } catch (e) { window.alert('Scan failed: ' + (e instanceof Error ? e.message : 'unknown')) } }} className="px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.1] text-white/80 text-xs rounded">Scan</button>
            <button onClick={async () => { if (!window.confirm(`Delete library "${lib.name}" and all its media?`)) return; try { await deleteLibrary(lib.id); await reload() } catch (e) { window.alert('Delete failed: ' + (e instanceof Error ? e.message : 'unknown')) } }} className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs rounded">Delete</button>
          </div>
        ))}
      </div>
    </div>
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
  const reload = useCallback(async () => {
    try { setSettings(await getAllSettings()); setEdited({}) }
    catch (e) { window.alert(e instanceof Error ? e.message : 'failed') }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const val = (k: string, dflt: string) => (k in edited ? edited[k] : settings?.[k] ?? dflt)
  const setVal = (k: string, v: string) => setEdited(prev => ({ ...prev, [k]: v }))
  const save = async () => {
    if (Object.keys(edited).length === 0) return
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
    catch (e) { window.alert(e instanceof Error ? e.message : 'failed') }
    finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-2xl p-5">
        <h2 className="text-white font-semibold mb-3">Server Settings</h2>
        {settings === null ? <p className="text-white/40 text-sm">Loading…</p> : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Transcode max sessions</p>
                <p className="text-white/40 text-xs">Concurrent FFmpeg processes; 0 = unlimited</p>
              </div>
              <input type="number" min={0} max={1000} value={val('transcode_max_sessions', '0')} onChange={e => setVal('transcode_max_sessions', e.target.value)} className="px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm w-24" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Transcode max sessions per user</p>
                <p className="text-white/40 text-xs">Streams one account may hold; 0 = default (3)</p>
              </div>
              <input type="number" min={0} max={100} value={val('transcode_max_sessions_per_user', '0')} onChange={e => setVal('transcode_max_sessions_per_user', e.target.value)} className="px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm w-24" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Scan interval (seconds)</p>
                <p className="text-white/40 text-xs">Default for new libraries; 0 = manual only</p>
              </div>
              <input type="number" min={0} max={86400} value={val('scan_interval_default', '0')} onChange={e => setVal('scan_interval_default', e.target.value)} className="px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm w-24" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Now Playing broadcast</p>
                <p className="text-white/40 text-xs">Stream notifications to admin dashboard</p>
              </div>
              <input type="checkbox" checked={val('now_playing_enabled', 'true') === 'true'} onChange={e => setVal('now_playing_enabled', e.target.checked ? 'true' : 'false')} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Push notifications</p>
                <p className="text-white/40 text-xs">Deliver via browser push services (Google/Apple/Mozilla); payloads are end-to-end encrypted</p>
              </div>
              <input type="checkbox" checked={val('push_enabled', 'true') === 'true'} onChange={e => setVal('push_enabled', e.target.checked ? 'true' : 'false')} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Filesystem watch</p>
                <p className="text-white/40 text-xs">Auto-detect changes between scans</p>
              </div>
              <input type="checkbox" checked={val('filesystem_watch_enabled', 'true') === 'true'} onChange={e => setVal('filesystem_watch_enabled', e.target.checked ? 'true' : 'false')} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Requests enabled</p>
                <p className="text-white/40 text-xs">Users can request titles via Radarr/Sonarr</p>
              </div>
              <input type="checkbox" checked={val('requests_enabled', 'false') === 'true'} onChange={e => setVal('requests_enabled', e.target.checked ? 'true' : 'false')} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Active request quota</p>
                <p className="text-white/40 text-xs">Per user; requests over this are held for approval (default 10)</p>
              </div>
              <input type="number" min={1} max={10000} value={val('requests_quota_active', '10')} onChange={e => setVal('requests_quota_active', e.target.value)} className="px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm w-24" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm">Daily request quota</p>
                <p className="text-white/40 text-xs">Per user, rolling 24h; requests over this are held for approval (default 25)</p>
              </div>
              <input type="number" min={1} max={10000} value={val('requests_quota_daily', '25')} onChange={e => setVal('requests_quota_daily', e.target.value)} className="px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm w-24" />
            </div>
            <button
              disabled={saving || Object.keys(edited).length === 0}
              onClick={save}
              className="mt-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg disabled:opacity-50"
            >{saving ? 'Saving…' : Object.keys(edited).length > 0 ? `Save ${Object.keys(edited).length} change${Object.keys(edited).length === 1 ? '' : 's'}` : 'No changes'}</button>
          </div>
        )}
      </div>

      {/* Invite Codes section moved to Admin → Users tab (its natural home).
          See `tab === 'users'` block in AdminView. */}

      <div className="glass-panel rounded-2xl p-5">
        <h2 className="text-white font-semibold mb-3">Image Cache</h2>
        <p className="text-white/40 text-xs mb-3">Delete cached TMDB poster/backdrop images. The cache repopulates on demand; useful after rescanning a large library or running out of disk.</p>
        <button
          onClick={async () => {
            if (!window.confirm('Purge the image cache? Images will re-download on next view.')) return
            try { const r = await purgeImageCache(); window.alert(`Purged ${r.files_purged ?? 0} files (${((r.bytes_freed ?? 0) / 1024 / 1024).toFixed(1)} MB freed).`) }
            catch (e) { window.alert(e instanceof Error ? e.message : 'failed') }
          }}
          className="px-4 py-2 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-200 text-sm rounded-lg"
        >Purge Image Cache</button>
      </div>

      <div className="glass-panel rounded-2xl p-5">
        <h2 className="text-white font-semibold mb-3">Radarr / Sonarr (Requests)</h2>
        {settings && (['radarr', 'radarr_4k', 'sonarr', 'sonarr_4k'] as const).map(svc => {
          const urlKey = `${svc}_url`, keyKey = `${svc}_api_key`
          const label = svc === 'radarr' ? 'Radarr' : svc === 'radarr_4k' ? 'Radarr 4K' : svc === 'sonarr' ? 'Sonarr' : 'Sonarr 4K'
          return (
            <div key={svc} className="border-b border-white/[0.04] last:border-0 py-3">
              <p className="text-white/80 text-sm mb-2">{label}</p>
              <div className="flex gap-2 flex-wrap">
                <input value={val(urlKey, '')} onChange={e => setVal(urlKey, e.target.value)} placeholder="http://radarr:7878" className="flex-1 min-w-[200px] px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
                <input type="password" data-screenshot-exclude="true" defaultValue="" onChange={e => setVal(keyKey, e.target.value)} placeholder={settings[keyKey] ? 'API Key (saved)' : 'API Key'} className="flex-1 min-w-[200px] px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
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
                  className="px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.1] text-white/80 text-sm rounded"
                >Test</button>
              </div>
              {arrTest?.svc === svc && <p className={`text-xs mt-1 ${arrTest.msg.startsWith('OK') ? 'text-emerald-300' : 'text-red-300'}`}>{arrTest.msg}</p>}
            </div>
          )
        })}
        {/* Section-scoped Save button. Shares the same `edited` state
            and save() with the top of the panel — operators typing in
            ARR fields shouldn't need to scroll back up. */}
        {settings && (
          <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center gap-3">
            <button
              disabled={saving || Object.keys(edited).length === 0}
              onClick={save}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg disabled:opacity-50"
            >{saving ? 'Saving…' : Object.keys(edited).length > 0 ? `Save ${Object.keys(edited).length} change${Object.keys(edited).length === 1 ? '' : 's'}` : 'No changes'}</button>
            <p className="text-white/40 text-xs">
              Empty API key fields are ignored on save (so the stored key isn't wiped). Use Test first to verify before saving.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function AdminRoomsTab() {
  const [items, setItems] = useState<Room[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const reload = useCallback(async () => {
    try { setItems(await listRooms()) }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }, [])
  useEffect(() => { void reload() }, [reload])
  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-2xl p-5">
        <h2 className="text-white font-semibold mb-3">Create Persistent Room</h2>
        <p className="text-white/40 text-xs mb-3">Rooms have a stable code that survives across watch parties. Share the code once; friends can rejoin even after the host leaves.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Room name" className="px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
          <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Description (optional)" className="px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </div>
        <button
          disabled={!name.trim()}
          onClick={async () => { try { await createRoom({ name: name.trim(), description: desc.trim() || undefined }); setName(''); setDesc(''); await reload() } catch (e) { window.alert(e instanceof Error ? e.message : 'failed') } }}
          className="mt-3 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg disabled:opacity-50"
        >Create Room</button>
      </div>
      <div className="glass-panel rounded-2xl p-5">
        <h2 className="text-white font-semibold mb-3">Existing Rooms</h2>
        {err && <p className="text-red-300 text-sm">{err}</p>}
        {items === null && <p className="text-white/40 text-sm">Loading…</p>}
        {items && items.length === 0 && <p className="text-white/40 text-sm">No rooms yet.</p>}
        {items && items.map(r => (
          <div key={r.id} className="flex items-center justify-between py-3 border-b border-white/[0.04] last:border-0 gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-white/90 text-sm font-medium truncate">{r.name} <span className="text-purple-300 font-mono text-xs ml-2">{r.code}</span></p>
              {r.description && <p className="text-white/40 text-xs truncate">{r.description}</p>}
              {r.active_party_code && (
                // Emit the working `{BASE}p/CODE` URL as an <a> so
                // admins can right-click → copy. Pull the base from
                // Vite's BASE_URL so this stays in lockstep if the
                // SPA mount moves.
                <p className="text-emerald-300 text-xs">
                  Live now — join via{' '}
                  <a
                    href={`${import.meta.env.BASE_URL}p/${r.active_party_code}`}
                    className="underline hover:text-emerald-200"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {import.meta.env.BASE_URL}p/{r.active_party_code}
                  </a>
                </p>
              )}
            </div>
            <button onClick={async () => { if (!window.confirm(`Delete room "${r.name}"?`)) return; try { await deleteRoom(r.id); await reload() } catch (e) { window.alert(e instanceof Error ? e.message : 'failed') } }} className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs rounded">Delete</button>
          </div>
        ))}
      </div>
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
  // Tracks the request id with an in-flight approve/deny so we can disable
  // both buttons on that row and avoid double-submits.
  const [busy, setBusy] = useState<number | null>(null)
  const reload = useCallback(async () => {
    try { setItems(await listPendingApprovals()); setErr(null) }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const act = useCallback(async (id: number, fn: (id: number) => Promise<void>) => {
    setBusy(id)
    try { await fn(id); await reload() }
    catch (e) { window.alert(e instanceof Error ? e.message : 'failed') }
    finally { setBusy(null) }
  }, [reload])

  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-2xl p-5">
        <h2 className="text-white font-semibold mb-1">Pending Approvals</h2>
        <p className="text-white/40 text-xs mb-3">Requests that hit a user's quota are held here. Approve to dispatch to Radarr/Sonarr, or deny to reject.</p>
        {err && <p className="text-red-300 text-sm">{err}</p>}
        {items === null && <p className="text-white/40 text-sm">Loading…</p>}
        {items && items.length === 0 && <p className="text-white/40 text-sm">No requests awaiting approval.</p>}
        {items && items.map(req => {
          const poster = tmdbPosterURL(req.poster_path)
          return (
            <div key={req.id} className="flex items-center gap-3 py-3 border-b border-white/[0.04] last:border-0">
              <div className="w-[44px] h-[66px] rounded-md overflow-hidden flex-shrink-0 bg-white/5 flex items-center justify-center">
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
                  <Icon name={req.media_type === 'tv' ? 'tv' : 'film'} size={16} className="text-white/25" />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-white/90 text-sm font-medium truncate">{req.title}{req.year ? ` (${req.year})` : ''}</p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-white/40 text-xs uppercase">{req.media_type === 'tv' ? 'TV' : 'Movie'}</span>
                  {req.quality_4k && <span className="badge-glass bg-purple-500/10 text-purple-300 border border-purple-500/20 text-[10px]">4K</span>}
                  {req.quality_1080p && <span className="badge-glass bg-white/[0.04] text-white/60 border border-white/[0.06] text-[10px]">1080p</span>}
                  {req.username && <span className="text-white/40 text-xs">by {req.username}</span>}
                  <span className="text-white/30 text-xs">{formatRequestDate(req.requested_at)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  disabled={busy === req.id}
                  onClick={() => act(req.id, approveRequest)}
                  className="px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs rounded disabled:opacity-50"
                >Approve</button>
                <button
                  disabled={busy === req.id}
                  onClick={() => { if (!window.confirm(`Deny request for "${req.title}"?`)) return; void act(req.id, denyRequest) }}
                  className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs rounded disabled:opacity-50"
                >Deny</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AdminSessionsTab() {
  const [items, setItems] = useState<ActiveStreamRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Diagnose modal — populated when an admin clicks the "Diag"
  // button on a transcode row. Surfaces FFmpeg stderr + per-variant
  // state so operators can debug "variant start failed" 500s
  // without grepping syslog.
  const [diag, setDiag] = useState<SessionDiagnostic | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagErr, setDiagErr] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try { setItems(await listAdminSessions()) }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }, [])
  useEffect(() => { void reload(); const id = window.setInterval(() => void reload(), 5000); return () => window.clearInterval(id) }, [reload])
  const openDiagnose = useCallback(async (sessionID: string) => {
    setDiag(null); setDiagErr(null); setDiagLoading(true)
    try {
      setDiag(await diagnoseSession(sessionID))
    } catch (e) {
      setDiagErr(e instanceof Error ? e.message : 'failed')
    } finally {
      setDiagLoading(false)
    }
  }, [])
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-white font-semibold">Active Streams</h2>
        <button onClick={() => void reload()} className="text-white/60 hover:text-white text-xs">Refresh</button>
      </div>
      {/* Active streams now span BOTH kinds (transcode + direct-play).
          The Kind column tells operators which pipeline is serving
          the stream; Kill is only available for transcode sessions
          (direct-play has no FFmpeg process to terminate — it
          expires from the registry after 60s of no byte-serves). */}
      {err && <p className="text-red-300 text-sm">{err}</p>}
      {items === null && <p className="text-white/40 text-sm">Loading…</p>}
      {items && items.length === 0 && <p className="text-white/40 text-sm">No active streams.</p>}
      {items && items.length > 0 && (
        <table className="data-table w-full">
          <thead>
            <tr><th>Session</th><th>Kind</th><th>User</th><th>File</th><th>Detail</th><th>Started</th><th></th></tr>
          </thead>
          <tbody>
            {items.map(s => {
              const isTranscode = s.kind === 'transcode'
              return (
                <tr key={s.id}>
                  <td className="font-mono text-xs">{s.id.slice(0, 10)}</td>
                  <td>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      isTranscode
                        ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    }`}>
                      {isTranscode ? 'Transcode' : 'Direct'}
                    </span>
                  </td>
                  <td>{s.username || s.user_id}</td>
                  <td className="max-w-[280px] truncate" title={s.file_name}>{s.file_name}</td>
                  <td>
                    {isTranscode ? (
                      <>
                        {s.resolution && <span className="text-white/60 text-xs">{s.resolution}</span>}
                        {s.remux && <span className="ml-1 text-white/40 text-xs">remux</span>}
                        {s.active_variants && s.active_variants.length > 0 && (
                          <span className="ml-1 text-white/40 text-xs">({s.active_variants.join(', ')})</span>
                        )}
                      </>
                    ) : (
                      // QA review fix — `decision` is hard-coded to
                      // "direct_play" in all three Touch call sites,
                      // so the previous "direct_stream" branch was
                      // dead code. If remux (direct_stream) ever
                      // wires through to the registry, restore the
                      // conditional here.
                      <span className="text-white/60 text-xs">Direct Play</span>
                    )}
                  </td>
                  <td className="text-white/40 text-xs">{new Date(s.started_at).toLocaleTimeString()}</td>
                  <td>
                    {isTranscode ? (
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => void openDiagnose(s.id)} className="px-2 py-1 bg-white/[0.05] hover:bg-white/[0.10] text-white/70 text-xs rounded" title="Show FFmpeg stderr + variant state">Diag</button>
                        <button onClick={async () => { if (!window.confirm('Terminate this stream?')) return; try { await deleteStreamSession(s.id); await reload() } catch (e) { window.alert('Failed: ' + (e instanceof Error ? e.message : 'unknown')) } }} className="px-2 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs rounded">Kill</button>
                      </div>
                    ) : (
                      // Direct-play has no FFmpeg lifecycle to terminate.
                      // The registry GCs after 60s of no byte-serves; an
                      // explicit Kill button would mislead operators.
                      <span className="text-white/30 text-xs" title="Direct-play sessions auto-expire when the client stops requesting bytes">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {/* Diagnose modal — admin-only FFmpeg state view for a session. */}
      {(diag || diagLoading || diagErr) && (
        <div className="fixed inset-0 z-[80] flex items-start justify-center pt-24 px-4" onClick={() => { setDiag(null); setDiagErr(null); setDiagLoading(false) }}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div className="relative w-full max-w-3xl bg-[#0a0a0f] border border-white/[0.08] rounded-xl shadow-2xl p-5 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white font-semibold">Session diagnostic</h2>
              <button onClick={() => { setDiag(null); setDiagErr(null); setDiagLoading(false) }} className="text-white/40 hover:text-white" aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
            {diagLoading && <p className="text-white/50 text-sm">Loading…</p>}
            {diagErr && <p className="text-red-300 text-sm">{diagErr}</p>}
            {diag && (
              <div className="space-y-3 font-mono text-xs">
                <div>
                  <div className="text-white/40">Session</div>
                  <div className="text-white/80 break-all">{diag.session_id}</div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-white/40">Source codec</div>
                    <div className="text-white/80">{diag.source_video_codec || '—'}</div>
                  </div>
                  <div>
                    <div className="text-white/40">HW Accel</div>
                    <div className="text-white/80">{diag.hw_accel}</div>
                  </div>
                  <div>
                    <div className="text-white/40">Mode</div>
                    <div className="text-white/80">{diag.remux ? 'remux' : 'transcode'}</div>
                  </div>
                  <div>
                    <div className="text-white/40">File path</div>
                    <div className="text-white/80 break-all">{diag.file_path}</div>
                  </div>
                </div>
                <div>
                  <div className="text-white/40 mb-1">Variants ({diag.variants?.length || 0})</div>
                  <div className="space-y-2">
                    {diag.variants?.map((v) => (
                      <div key={v.profile} className="border border-white/[0.06] rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-white/90 font-medium">{v.profile}</span>
                          {v.started && !v.exited && <span className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">running</span>}
                          {v.exited && <span className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/15 text-red-300 border border-red-500/30">exited</span>}
                          {(v.restart_attempts ?? 0) > 0 && <span className="text-white/40">restarts={v.restart_attempts}</span>}
                        </div>
                        {v.error && (
                          <div className="mb-1">
                            <div className="text-white/40">error</div>
                            <div className="text-red-300/90 whitespace-pre-wrap break-words">{v.error}</div>
                          </div>
                        )}
                        {v.stderr_tail && (
                          <div>
                            <div className="text-white/40">ffmpeg stderr tail</div>
                            <pre className="text-white/70 whitespace-pre-wrap break-words bg-black/40 rounded p-2 max-h-64 overflow-y-auto">{v.stderr_tail}</pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function AdminFlaggedTab() {
  const [items, setItems] = useState<ServerMediaItem[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Phase 5.3 — manual-match modal state.
  const [matchTarget, setMatchTarget] = useState<ServerMediaItem | null>(null)
  // 2026-05-26 — AI re-matcher job status. Polled while a job is
  // active so the operator sees live progress; falls back to
  // single-shot fetch when no job is running. acceptingId tracks the
  // item whose Accept-suggestion button is in flight so we can show
  // a per-row spinner state rather than a global one.
  const [aiJob, setAiJob] = useState<AIRematchJobStatus | null>(null)
  const [aiEnabled, setAiEnabled] = useState<boolean>(true)
  const [aiStarting, setAiStarting] = useState(false)
  const [acceptingId, setAcceptingId] = useState<number | null>(null)

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

  const reload = useCallback(async () => {
    try { setItems(await listFlaggedItems()) }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
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
    try {
      await startAIRematch()
      // Re-enter the poll chain so the progress card advances. Without
      // this call the first setTimeout never gets scheduled and the
      // operator sees a frozen progress bar (deep-debug Bug 1).
      void pollOnce()
    } catch (e) {
      window.alert('Failed to start AI rematch: ' + (e instanceof Error ? e.message : 'unknown'))
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
    try {
      await manualMatch(item.id, { tmdb_id: item.ai_suggested_tmdb_id, type: item.type })
      setItems(prev => prev ? prev.filter(i => i.id !== item.id) : prev)
    } catch (e) {
      window.alert('Accept failed: ' + (e instanceof Error ? e.message : 'unknown'))
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
    <div className="glass-panel rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h2 className="text-white font-semibold">Flagged Items</h2>
          <p className="text-white/40 text-xs mt-1">
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
            className="px-3 py-1.5 rounded-md bg-purple-600/80 hover:bg-purple-500 text-white text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            {aiStarting ? 'Starting…' : jobActive ? 'AI sweep running' : 'Re-match with AI'}
          </button>
        )}
      </div>

      {/* AI job progress card — shown while a job is active OR for ~30s
          after completion so the operator sees the final result.
          Counts: processed/total + matched (auto-promoted) + suggested
          (sub-threshold, awaiting approval) + failed (LLM/parse errors). */}
      {aiJob && (
        <div className="mb-4 p-3 rounded-lg bg-purple-500/[0.05] border border-purple-500/20">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-purple-200 text-xs font-medium">
              {jobActive
                ? (inRetryPhase
                    ? `AI retry pass running… (${aiJob.retried ?? 0} re-attempted)`
                    : `AI re-matching… ${aiJob.processed}/${aiJob.total}`)
                : `AI sweep complete (${aiJob.processed}/${aiJob.total})`}
            </p>
            <p className="text-white/50 text-[10px]">
              auto-matched <span className="text-emerald-300 font-mono">{aiJob.matched}</span>
              {' · '}
              suggested <span className="text-purple-300 font-mono">{aiJob.suggested}</span>
              {aiJob.failed > 0 && <>{' · '}failed <span className="text-amber-300 font-mono">{aiJob.failed}</span></>}
              {/* Retry pass: items where confidence ≥ threshold but
                  EnrichByTMDBID failed at eval time. Server tries
                  again with no new LLM call. Only render the counter
                  when the pass actually touched something so jobs
                  with no stuck items don't show a noisy "+0 retry". */}
              {(aiJob.retried ?? 0) > 0 && (
                <>{' · '}retry-recovered <span className="text-emerald-300 font-mono">{aiJob.retry_matched ?? 0}</span><span className="text-white/30">/{aiJob.retried}</span></>
              )}
            </p>
          </div>
          <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-purple-500 to-purple-400 transition-all"
              style={{ width: `${jobProgress}%` }}
            />
          </div>
        </div>
      )}

      {err && <p className="text-red-300 text-sm">{err}</p>}
      {items === null && <p className="text-white/40 text-sm">Loading…</p>}
      {items && items.length === 0 && <p className="text-white/40 text-sm">Nothing flagged — your library is clean.</p>}
      {items && items.map(it => {
        const hasSuggestion = !!it.ai_suggested_tmdb_id
        const confidence = it.ai_match_confidence ?? 0
        const evaluated = !!it.ai_match_ran_at
        return (
          <div key={it.id} className="py-3 border-b border-white/[0.04] last:border-0">
            <div className="flex items-start gap-3">
              <span className="text-amber-400 text-xs uppercase font-semibold flex-shrink-0">{it.match_status || 'flagged'}</span>
              <div className="min-w-0 flex-1">
                <p className="text-white/90 text-sm font-medium truncate">{it.title}{it.year ? ` (${it.year})` : ''}</p>
                <p className="text-white/40 text-xs truncate">{it.file_path}</p>
              </div>
              <button
                onClick={() => setMatchTarget(it)}
                className="px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.1] text-white/80 text-xs rounded flex-shrink-0"
              >
                Match
              </button>
            </div>
            {/* AI suggestion strip — only when the matcher has a real
                pick to surface. Evaluated-with-no-suggestion items get
                a quieter inline note further down. */}
            {hasSuggestion && (
              <div className="ml-[88px] mt-2 p-2.5 rounded-md bg-purple-500/[0.07] border border-purple-500/20 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-purple-200/90 text-xs">
                    <span className="font-semibold">AI suggests:</span>{' '}
                    <span className="text-white/85">
                      {it.ai_suggested_title || `TMDB ${it.ai_suggested_tmdb_id}`}
                      {it.ai_suggested_year ? ` (${it.ai_suggested_year})` : ''}
                    </span>
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-200 text-[10px] font-mono">
                      {confidence}% confident
                    </span>
                  </p>
                  {it.ai_match_reasoning && (
                    <p className="text-white/55 text-[11px] mt-1 leading-snug">{it.ai_match_reasoning}</p>
                  )}
                </div>
                <button
                  disabled={acceptingId === it.id}
                  onClick={() => void acceptSuggestion(it)}
                  className="px-3 py-1.5 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 text-emerald-100 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                >
                  {acceptingId === it.id ? 'Accepting…' : 'Accept'}
                </button>
              </div>
            )}
            {/* Evaluated but no pick — quieter inline note so the
                operator knows AI tried and gave up (vs hasn't tried yet). */}
            {evaluated && !hasSuggestion && (
              <p className="ml-[88px] mt-2 text-white/35 text-[11px] italic">
                AI evaluated — no candidate fit
                {it.ai_match_reasoning ? `: ${it.ai_match_reasoning}` : '.'}
              </p>
            )}
          </div>
        )
      })}
      {matchTarget && (
        <ManualMatchModal
          target={matchTarget}
          onClose={() => setMatchTarget(null)}
          onMatched={() => { setMatchTarget(null); void reload() }}
        />
      )}
    </div>
  )
}

const OLLAMA_LOCAL_DEFAULT = 'http://localhost:11434'
const OLLAMA_CLOUD_DEFAULT = 'https://ollama.com'

function AdminLLMTab() {
  const [s, setS] = useState<LLMSettings | null>(null)
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
  if (err) return <p className="text-red-300 text-sm">{err}</p>
  if (!s) return <p className="text-white/40 text-sm">Loading…</p>
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
    <div className="glass-panel rounded-2xl p-5 space-y-3">
      <h2 className="text-white font-semibold mb-2">LLM (Search + Recommendations)</h2>
      <p className="text-white/40 text-xs mb-3">Configures the LLM used for natural-language search and recommendation reranking. Local runs chat on your own box; Ollama Cloud runs chat on ollama.com; Anthropic (Claude) and OpenAI (ChatGPT) run chat on their hosted APIs with your API key. Embeddings run on local Ollama by default, or on OpenAI — Anthropic has no embeddings API. Enable/disable the whole stack via LLM_ENABLED.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Provider</span>
          <select value={s.provider} onChange={e => changeProvider(e.target.value)} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm">
            <option value="">Default (env config)</option>
            <option value="ollama_cloud">Ollama Cloud</option>
            <option value="local">Local (Ollama)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (ChatGPT)</option>
          </select>
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Embedding Provider</span>
          <select value={s.embed_provider} onChange={e => changeEmbedProvider(e.target.value)} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm">
            <option value="">Local (Ollama)</option>
            <option value="openai">OpenAI</option>
          </select>
          <span className="block text-[10px] text-amber-300/80 mt-1">Changing the embedding provider or model clears stored vectors and re-embeds the whole library on restart{openaiEmbeds ? ' (OpenAI API cost applies)' : ''}.</span>
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Ollama URL{hostedChat ? ' (local embeds + reranker only)' : ''}</span>
          <input value={s.ollama_url} onChange={e => setS({ ...s, ollama_url: e.target.value })} placeholder={s.provider === 'ollama_cloud' ? OLLAMA_CLOUD_DEFAULT : OLLAMA_LOCAL_DEFAULT} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
          {s.provider === 'ollama_cloud' && <span className="block text-[10px] text-white/40 mt-1">Must be an https ollama.com URL — this is what actually distinguishes Ollama Cloud from Local.</span>}
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Embed URL (optional)</span>
          <input value={s.embed_url} onChange={e => setS({ ...s, embed_url: e.target.value })} placeholder="http://localhost:11434" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Chat Model</span>
          <input value={s.chat_model} onChange={e => setS({ ...s, chat_model: e.target.value })} placeholder={chatPlaceholder} list="llm-chat-models" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Embed Model</span>
          <input value={s.embed_model} onChange={e => setS({ ...s, embed_model: e.target.value })} placeholder={embedPlaceholder} list="llm-embed-models" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Fast Model (optional)</span>
          <input value={s.chat_model_fast ?? ''} onChange={e => setS({ ...s, chat_model_fast: e.target.value })} placeholder="hero rerank + rail reasons · blank = Chat Model" list="llm-chat-models" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Smart Model (optional)</span>
          <input value={s.chat_model_smart ?? ''} onChange={e => setS({ ...s, chat_model_smart: e.target.value })} placeholder={smartPlaceholder} list="llm-chat-models" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Ollama API Key {s.has_api_key && <span className="text-emerald-300 text-[10px]">SET</span>}</span>
          <input type="password" data-screenshot-exclude="true" value={apiKeyEdit} onChange={e => setApiKeyEdit(e.target.value)} placeholder={s.api_key_masked || 'leave empty to keep existing'} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        {showAnthropicKey && (
          <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Anthropic API Key {s.has_anthropic_api_key && <span className="text-emerald-300 text-[10px]">SET</span>}</span>
            <input type="password" data-screenshot-exclude="true" value={anthropicKeyEdit} onChange={e => setAnthropicKeyEdit(e.target.value)} placeholder={s.anthropic_api_key_masked || 'sk-ant-… · leave empty to keep existing'} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
          </label>
        )}
        {showOpenAIKey && (
          <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">OpenAI API Key {s.has_openai_api_key && <span className="text-emerald-300 text-[10px]">SET</span>}</span>
            <input type="password" data-screenshot-exclude="true" value={openaiKeyEdit} onChange={e => setOpenaiKeyEdit(e.target.value)} placeholder={s.openai_api_key_masked || 'sk-… · leave empty to keep existing'} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
          </label>
        )}
      </div>
      <datalist id="llm-chat-models">{chatAvailable.map(m => <option key={m} value={m} />)}</datalist>
      <datalist id="llm-embed-models">{embedAvailable.map(m => <option key={m} value={m} />)}</datalist>
      <label className="flex items-center gap-2 mt-2 text-sm text-white/70">
        <input type="checkbox" checked={s.debug_log} onChange={e => setS({ ...s, debug_log: e.target.checked })} />
        Debug log <span className="text-white/40 text-xs">(verbose LLM call traces — adds disk I/O)</span>
      </label>
      <label className={`flex items-center gap-2 mt-2 text-sm ${hostedChat ? 'text-white/30' : 'text-white/70'}`} title={hostedChat ? 'Always on for Anthropic/OpenAI — they enforce schemas natively' : undefined}>
        <input type="checkbox" disabled={hostedChat} checked={hostedChat ? true : (s.structured_outputs ?? false)} onChange={e => setS({ ...s, structured_outputs: e.target.checked })} />
        Structured outputs <span className="text-white/40 text-xs">{hostedChat ? '(always on for Anthropic/OpenAI)' : '(OpenAI json_schema path for the hero rerank — restart required)'}</span>
      </label>
      <label className="flex items-center gap-2 mt-2 text-sm text-white/70">
        Reasoning effort
        <select value={s.reasoning_effort ?? ''} onChange={e => setS({ ...s, reasoning_effort: e.target.value })} className="px-2 py-1 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm">
          <option value="">Default (model decides)</option>
          <option value="low">Low — fastest{hostedChat ? '' : ', recommended for gpt-oss'}</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="none">None</option>
        </select>
        <span className="text-white/40 text-xs">{s.provider === 'anthropic' ? 'maps to Claude output effort' : s.provider === 'openai' ? 'sent as reasoning_effort' : 'gpt-oss · structured /v1 path'} · restart required</span>
      </label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Reranker Model (optional)</span>
          <input value={s.rerank_model ?? ''} onChange={e => setS({ ...s, rerank_model: e.target.value })} placeholder="fast chat model · listwise rerank · e.g. gpt-oss:20b · blank = off" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Reranker URL (optional)</span>
          <input value={s.rerank_url ?? ''} onChange={e => setS({ ...s, rerank_url: e.target.value })} placeholder="blank = chat endpoint · set only to run rerank on a local box" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Repeat window (hrs)</span>
          <input type="number" min={0} value={s.repeat_window_hours ?? 72} onChange={e => setS({ ...s, repeat_window_hours: Math.max(0, parseInt(e.target.value || '0', 10) || 0) })} placeholder="anti-repetition · 0 = off" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Taste modes (1–3)</span>
          <input type="number" min={1} max={3} value={s.taste_centroids ?? 3} onChange={e => setS({ ...s, taste_centroids: Math.min(3, Math.max(1, parseInt(e.target.value || '1', 10) || 1)) })} placeholder="multi-centroid taste · 1 = off" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button
          disabled={saving}
          onClick={async () => {
            setSaving(true)
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
              // The PUT returns an ack, not the settings — re-fetch so the
              // form reflects what was persisted (masked keys, SET badges).
              const next = await getAdminLLM()
              loadedRef.current = next
              setS(next); setApiKeyEdit(''); setAnthropicKeyEdit(''); setOpenaiKeyEdit('')
              window.alert(ack.restart_required ? 'LLM settings saved. Restart Aurora to apply them.' : 'LLM settings saved.')
            } catch (e) { window.alert('Save failed: ' + (e instanceof Error ? e.message : 'unknown')) }
            finally { setSaving(false) }
          }}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
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
          className="px-4 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {testError && <p className="text-red-300 text-xs mt-2">{testError}</p>}
      {testResult && (
        <div className="mt-2 space-y-1 text-xs">
          {testResult.endpoints.map(ep => (
            <div key={ep.role + (ep.provider ?? '') + ep.url} className="text-white/70">
              <span className="uppercase text-white/40 mr-1">{ep.role}{ep.provider ? ` · ${ep.provider}` : ''}</span>
              <span className="mr-2">{ep.url}</span>
              {ep.reachable ? (
                <span className="text-emerald-300">reachable</span>
              ) : (
                <span className="text-red-300">unreachable{ep.error ? ` — ${ep.error}` : ''}</span>
              )}
              {ep.models && Object.entries(ep.models).map(([m, ok]) => (
                <span key={m} className={ok ? 'ml-2 text-emerald-300' : 'ml-2 text-amber-300'}>
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
  if (err) return <p className="text-red-300 text-sm">{err}</p>
  if (!s) return <p className="text-white/40 text-sm">Loading…</p>
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

  if (loading) return <p className="text-white/40 text-sm">Loading…</p>

  return (
    <div className="glass-panel rounded-2xl p-5 space-y-3">
      <h2 className="text-white font-semibold mb-1">Referral prompt</h2>
      <p className="text-white/55 text-xs">
        Asked once, of accounts created through a provider whose invite bypass is on below.
        Everyone else is never asked. Leave blank to use the defaults.
      </p>

      <div>
        <label htmlFor="referral-question" className="block text-white/80 text-sm mb-1.5">Question</label>
        <input
          id="referral-question"
          type="text"
          value={question}
          onChange={e => { setQuestion(e.target.value); setSaved(false) }}
          aria-invalid={!!questionIssue || undefined}
          aria-describedby={questionIssue ? 'referral-question-err' : undefined}
          placeholder="How did you hear about Aurora?"
          className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm"
        />
        {questionIssue && <p id="referral-question-err" className="text-red-300 text-xs mt-1">{questionIssue}</p>}
      </div>

      <div>
        <p className="text-white/80 text-sm mb-1.5">Options</p>
        {listIssue && <p className="text-red-300 text-xs mb-2">{listIssue}</p>}
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
                    className={'w-40 px-3 py-2 rounded text-sm font-mono border '
                      + (locked
                        // Dashed and dimmer, with no text cursor: a field that
                        // takes focus and then discards what you type has to
                        // look like one that will.
                        ? 'bg-white/[0.02] border-dashed border-white/[0.10] text-white/45 cursor-not-allowed'
                        : 'bg-white/[0.04] border-white/[0.06] text-white')}
                  />
                  <input
                    type="text"
                    value={row.label}
                    aria-label={`Option ${i + 1} label`}
                    aria-invalid={!!issue || undefined}
                    aria-describedby={issue ? errId : undefined}
                    onChange={e => { setRows(p => p.map((r, j) => j === i ? { ...r, label: e.target.value } : r)); setSaved(false) }}
                    placeholder="Label shown to the user"
                    className="flex-1 px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => { setRows(p => p.filter((_, j) => j !== i)); setSaved(false) }}
                    aria-label={`Remove option ${row.label || row.key || i + 1}`}
                    aria-describedby={issue ? errId : undefined}
                    className="px-3 py-2 text-white/50 hover:text-red-300 text-sm rounded"
                  >
                    Remove
                  </button>
                </div>
                {issue && <p id={errId} className="text-red-300 text-xs mt-1">{issue}</p>}
                {locked && !issue && (
                  <p className="text-white/35 text-xs mt-1">
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
            className="px-3 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-white/80 text-xs rounded disabled:opacity-40"
          >
            + Add option
          </button>
          <span className="text-white/35 text-xs">
            “{REFERRAL_OTHER_LABEL}” with a free-text box is always offered last. It is not
            listed here because it cannot be edited or turned off.
          </span>
        </div>
      </div>

      {/* Rendered unconditionally so the region exists before it has content —
          a live region created at the same moment as its text is not announced,
          which would leave a screen-reader admin with no feedback at all on
          either success or failure. */}
      <p role="alert" className="text-red-300 text-sm empty:hidden">{err}</p>
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
          className={'px-4 py-2 bg-purple-600 text-white text-sm rounded-lg '
            + (blocked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-purple-500')}
        >
          {saving ? 'Saving…' : 'Save prompt'}
        </button>
        {blockedReason && (
          <span id="referral-save-blocked" className="text-white/45 text-xs">{blockedReason}</span>
        )}
        <span role="status" className="text-white/55 text-xs">{saved ? 'Saved.' : ''}</span>
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
    <div className="glass-panel rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold">Where sign-ups came from</h2>
        <label className="text-white/55 text-xs">
          <span className="sr-only">Time window</span>
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="px-2 py-1 bg-white/[0.04] border border-white/[0.06] rounded text-white text-xs"
          >
            <option value={0}>All time</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </div>

      <p role="alert" className="text-red-300 text-sm empty:hidden">{err}</p>
      {!data && !err && <p className="text-white/40 text-sm">Loading…</p>}
      {data && (
        <>
          <div className="flex gap-6 text-sm">
            <span className="text-white/80">{data.answered.toLocaleString()} <span className="text-white/45">answered</span></span>
            <span className="text-white/80">{data.skipped.toLocaleString()} <span className="text-white/45">skipped</span></span>
            <span className="text-white/80">{data.pending.toLocaleString()} <span className="text-white/45">not yet asked</span></span>
          </div>
          {data.total === 0 ? (
            <p className="text-white/45 text-sm">
              No one has been asked yet. Accounts become eligible when they sign up through a
              provider with its invite bypass turned on.
            </p>
          ) : data.by_source.length === 0 ? (
            <p className="text-white/45 text-sm">No answers yet.</p>
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
                    <span className={`w-48 shrink-0 text-sm ${isRemovedSummaryRow(row) ? 'text-white/45 italic' : 'text-white/80'}`}>
                      {row.label ?? referralSourceLabel(row.key, [])}
                    </span>
                    <div className="flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden" aria-hidden="true">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-purple-500 to-purple-400"
                        style={{ width: `${top > 0 ? (row.count / top) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right text-white/60 text-sm tabular-nums">
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
    return <span className="text-white/25" title="Not eligible — signed up with an invite or a password">—</span>
  }
  if (user.referral_status === 'pending') {
    return <span className="text-white/40 text-sm">Pending</span>
  }
  if (user.referral_status === 'skipped') {
    return <span className="text-white/40 text-sm">— (skipped)</span>
  }
  const label = referralSourceLabel(user.referral_source ?? '', options)
  return (
    <span className="text-white/70 text-sm" title={answeredAt ? `Answered ${answeredAt}` : undefined}>
      {label}
      {user.referral_detail && (
        <span className="text-white/45"> — “{truncateChars(user.referral_detail, 60)}”</span>
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
  onUpdate: (s: OAuthSettings) => void
}) {
  const [secretEdit, setSecretEdit] = useState('')
  const [saving, setSaving] = useState(false)

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
    onUpdate({ ...settings, [key]: val })
  }

  const callbackHint = `https://your-aurora/api/auth/oauth/${provider}/callback`

  return (
    <div className="glass-panel rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-white font-semibold">
          {label} OAuth (Sign-in)
          {enabled && <span className="ml-2 text-emerald-300 text-[10px] uppercase tracking-wider">Enabled</span>}
        </h2>
        <a
          href={consoleURL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-purple-300 hover:text-purple-200 text-xs underline-offset-4 hover:underline"
        >
          Open {label} developer console ↗
        </a>
      </div>
      <label className="flex items-center gap-2 text-sm text-white/70">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setField(enabledKey, e.target.checked)}
        />
        Enable {label} Sign-In
      </label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-sm text-white/70">
          <span className="block text-xs text-white/40 mb-1">Client ID</span>
          <input
            value={clientID}
            onChange={e => setField(clientIDKey, e.target.value)}
            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm"
          />
        </label>
        <label className="text-sm text-white/70">
          <span className="block text-xs text-white/40 mb-1">
            Client Secret {hasSecret && <span className="text-emerald-300 text-[10px]">SET</span>}
          </span>
          <input
            type="password"
            data-screenshot-exclude="true"
            value={secretEdit}
            onChange={e => setSecretEdit(e.target.value)}
            placeholder={maskedSecret || 'leave empty to keep existing'}
            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm"
          />
        </label>
        <label className="md:col-span-2 text-sm text-white/70">
          <span className="block text-xs text-white/40 mb-1">
            Redirect URL <span className="text-white/30">(must match {label} Console verbatim)</span>
          </span>
          <input
            value={redirectURL}
            onChange={e => setField(redirectKey, e.target.value)}
            placeholder={callbackHint}
            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-white/70">
        <input
          type="checkbox"
          checked={bypassInvite}
          onChange={e => setField(bypassKey, e.target.checked)}
        />
        Bypass invite-code requirement for {label} sign-up
      </label>
      <button
        disabled={saving}
        onClick={async () => {
          setSaving(true)
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
            const next = await updateAdminOAuth(body as Parameters<typeof updateAdminOAuth>[0])
            onUpdate(next)
            setSecretEdit('')
            window.alert(`${label} OAuth settings saved.`)
          } catch (e) {
            window.alert('Save failed: ' + (e instanceof Error ? e.message : 'unknown'))
          } finally {
            setSaving(false)
          }
        }}
        className="mt-3 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {saving ? 'Saving…' : `Save ${label} settings`}
      </button>
    </div>
  )
}

/* ──────────────────── ADMIN USER ROW ACTIONS (3-dot menu) ─────────────────── */
// Per-user kebab menu in the admin Users table: promote/demote + delete.
// Replaces the bare "Delete" button so role changes get a home too.
//
// The menu renders into a document.body portal with fixed positioning anchored
// to the trigger's bounding rect. That's deliberate: the Users table lives in a
// .glass-panel with `overflow-hidden` (clips an absolutely-positioned child)
// AND a backdrop-filter (which makes `position: fixed` resolve against the
// panel, not the viewport). A body portal escapes both traps so the menu is
// never clipped, including on the last row. Closes on outside click, Escape,
// and scroll/resize (the anchor would otherwise drift).
function UserRowMenu({
  user,
  onRoleChanged,
  onDeleted,
}: {
  user: AdminUser
  onRoleChanged: (role: 'admin' | 'user') => void
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
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

  const handleRole = async () => {
    const nextRole: 'admin' | 'user' = isAdmin ? 'user' : 'admin'
    const verb = isAdmin ? 'Remove admin from' : 'Make'
    if (!window.confirm(`${verb} "${user.username}"${isAdmin ? '' : ' an admin'}?`)) return
    setBusy(true)
    try {
      await updateUserRole(user.id, nextRole)
      onRoleChanged(nextRole)
      setOpen(false)
    } catch (err) {
      window.alert('Role change failed: ' + (err instanceof Error ? err.message : 'unknown'))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return
    setBusy(true)
    try {
      await deleteUser(user.id)
      // onDeleted() removes this row, unmounting the component — so close first
      // and let it be the last statement on the success path. No setState runs
      // after the unmount (unlike a finally{} block would).
      setOpen(false)
      onDeleted()
    } catch (err) {
      window.alert('Delete failed: ' + (err instanceof Error ? err.message : 'unknown'))
      setBusy(false) // only reset on the error path, where the row stays mounted
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${user.username}`}
        className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/[0.06] disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-purple-400/60"
      >
        <Icon name="moreVertical" size={16} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="w-48 rounded-xl bg-[#0a0a0f]/95 backdrop-blur-xl border border-white/[0.06] shadow-2xl z-[60] overflow-hidden animate-fade-in"
        >
          <button
            role="menuitem"
            onClick={handleRole}
            disabled={busy}
            className="w-full text-left px-4 py-2.5 text-sm text-white/85 hover:bg-white/[0.06] disabled:opacity-50 flex items-center gap-2.5"
          >
            <Icon name="shield" size={14} className="text-purple-300/70" />
            {isAdmin ? 'Remove admin' : 'Make admin'}
          </button>
          <div className="border-t border-white/[0.06]" />
          <button
            role="menuitem"
            onClick={handleDelete}
            disabled={busy}
            className="w-full text-left px-4 py-2.5 text-sm text-red-300/85 hover:bg-red-500/10 disabled:opacity-50 flex items-center gap-2.5"
          >
            <Icon name="trash" size={14} className="text-red-400/60" />
            Delete user
          </button>
        </div>,
        document.body,
      )}
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
    <div className="glass-panel rounded-2xl px-[18px] py-4">
      {/* tabular-nums so a row of tiles does not jitter its digits as the
          numbers tick — several of these poll. */}
      <p className="text-white font-display font-extrabold text-[26px] leading-none tracking-tight tabular-nums">
        {value}
      </p>
      <div
        className={`text-white/60 text-[11px] mt-1.5 flex items-center gap-[7px] ${hint ? 'cursor-help' : ''}`}
        title={hint}
      >
        <Icon name={icon} size={13} className={color} />
        {label}
        {hint && <span className="text-white/30">ⓘ</span>}
      </div>
      {sub && <p className="text-white/35 text-[10px] mt-1 tabular-nums">{sub}</p>}
    </div>
  )
}

// The thirteen admin sections, in strip order. Hoisted out of the component
// (Aurora Stage Phase 7a) so the arrow-key handler, the label map and the type
// can all be derived from ONE list — the type and the array were previously two
// hand-maintained copies of the same thirteen strings, which is the kind of
// pair that drifts when a tab is added.
export const ADMIN_TABS = [
  'dashboard', 'users', 'libraries', 'rooms', 'requests', 'activity',
  'sessions', 'flagged', 'logs', 'server', 'llm', 'oauth', 'backup',
] as const
export type AdminTab = typeof ADMIN_TABS[number]

// Tab labels that `capitalize` gets wrong, or that read better renamed.
// Module scope: this is a constant, and it used to be rebuilt inside the
// tabs.map callback — thirteen object literals per render.
//
// QA BUG-010 follow-up — the Transcodes tab heading inside reads "Active
// Transcode Streams" but the nav label was just "Sessions", which read as
// generic and made direct-play streams' absence more confusing.
const ADMIN_TAB_LABELS: Partial<Record<AdminTab, string>> = {
  llm: 'LLM',
  oauth: 'OAuth',
  sessions: 'Transcodes',
}

export default function AdminView({ currentAdminId }: { currentAdminId: number }) {
  const [tab, setTab] = useState<AdminTab>('dashboard')
  // Where the roving tabIndex sits. Distinct from `tab` because the strip uses
  // MANUAL activation: arrows move focus without switching panels, so the
  // focused tab and the selected tab diverge until Enter/Space.
  const [focusedTab, setFocusedTab] = useState<AdminTab>('dashboard')
  const tabs = ADMIN_TABS
  // Per-tab refs so arrow-key navigation can move real focus with the roving
  // index (ARIA tabs pattern — the set is one tab stop).
  const tabRefs = useRef<Partial<Record<AdminTab, HTMLButtonElement | null>>>({})

  // /api/admin/backup streams a pg_dump archive. We fetch with the
  // Authorization header (rather than a tokenized anchor) so the
  // token never enters the DOM, then materialize the response as a
  // Blob for download. Trade-off: whole-archive buffering, but
  // pg_dump custom-format is self-compressed so even multi-GB DBs
  // fit comfortably.
  const downloadBackup = useCallback(async () => {
    try {
      const res = await apiFetchResponse('/api/admin/backup')
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`)
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error'
      window.alert('Backup download failed: ' + msg)
    }
  }, [])

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
    <div className="animate-fade-in">
      <PageHeader title="Administration" sub="Server management dashboard" />

      {/* Tab strip — a REAL tablist, sticky under the chrome.
          .stage-toolbar + .stage-tabstrip + .stage-tab, all three already
          existing primitives, rather than a new .stage-admintabs:
            - .stage-toolbar is exactly this job (sticky at the MEASURED
              --chrome-h so it tracks the admin scan bar appearing above the
              nav, blurred fill, bottom border, and static below md where
              pinning a wrapped strip would eat a third of the viewport).
              BrowseView's filter bar is the same pattern.
            - .stage-tabstrip is the horizontally-scrolling strip TopNav uses,
              with the padding/margin trick that stops the active tab's
              underline glow and focus ring being clipped by the scroll box.
              Thirteen tabs overflow at every width, so this matters more here
              than in the nav.
          The old strip was a non-scrolling `flex` of thirteen buttons, which
          simply overflowed its container.

          role="tablist" + arrow-key navigation, not aria-current: these switch
          a panel in place, so they are tabs, and ARIA's tabs pattern requires
          the whole set to be ONE tab stop with Left/Right (plus Home/End)
          moving between them. Phase 6 rejected role="tab" for the filter pills
          precisely because that keyboard contract was not implemented; here it
          is, so the role is honest.

          QA BUG-006 — `capitalize` only uppercases the first letter
          per word, so "llm" → "Llm" and "oauth" → "Oauth". Override
          for the acronyms; everything else still falls through to
          the existing capitalize rule. */}
      {/* The negative margin cancels .stage-page's side padding so the sticky
          strip's fill reaches the VIEWPORT edges at every width, and its own
          padding-inline puts the content back in line with every other page
          system. `.stage-gutter` is NOT on this element any more — `.stage-bleed`
          set the same property later in the file and shadowed it, so it was dead
          and one source-order flip away from reinstating the bug this phase
          started from.
          Corrected three times in six commits, twice wrongly: it claimed the
          viewport edge, then "one gutter outside the capped content above 2016px",
          then still named a class that had just been removed. It also recorded the
          BrowseView inconsistency as unresolved after it was settled — measured at
          HEAD, the two bands are byte-identical at every width. */}
      <div className="stage-toolbar stage-bleed mb-6">
        {/* MANUAL activation: arrows move focus, Enter/Space (native on a
            <button>) selects. Not the automatic variant this started as.
            APG recommends manual "when the tab panel's content is loaded
            asynchronously", and every panel here is exactly that — switching
            tabs fires listAdminUsers / listAdminActivity / listAdminLogs, and
            the Transcodes and Now-Playing panels each start a 5-second polling
            interval on mount. With automatic activation, holding ArrowRight
            from `dashboard` to `backup` mounted and unmounted eleven panels,
            firing their fetches and spinning two intervals up and down. That
            cost was paid only by keyboard users. */}
        <div
          role="tablist"
          aria-label="Administration sections"
          className="stage-tabstrip flex"
          onKeyDown={e => {
            // Arrows walk `focusedTab`, which is where the roving tabIndex sits;
            // `tab` (the selected panel) only moves on click or Enter/Space.
            const i = tabs.indexOf(focusedTab)
            let next = -1
            if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
            else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
            else if (e.key === 'Home') next = 0
            else if (e.key === 'End') next = tabs.length - 1
            if (next < 0) return
            e.preventDefault()
            setFocusedTab(tabs[next])
            // focus() scrolls the tab into view inside .stage-tabstrip by
            // default (preventScroll is false), so no explicit scrollIntoView.
            tabRefs.current[tabs[next]]?.focus()
          }}
        >
          {tabs.map(t => {
            const display = ADMIN_TAB_LABELS[t]
            const selected = tab === t
            return (
              <button
                key={t}
                ref={el => { tabRefs.current[t] = el }}
                type="button"
                role="tab"
                id={`admin-tab-${t}`}
                aria-selected={selected}
                // Only the SELECTED tab's panel exists in the DOM, so pointing
                // the other twelve at `admin-panel-<t>` was a dangling IDREF.
                // ARIA requires IDREFs to resolve; omit rather than dangle.
                aria-controls={selected ? `admin-panel-${t}` : undefined}
                // Roving tabIndex on the FOCUSED tab, which under manual
                // activation is not always the selected one. One tab stop for
                // the set either way.
                tabIndex={focusedTab === t ? 0 : -1}
                onClick={() => { setTab(t); setFocusedTab(t) }}
                // Keeps the roving index honest when focus arrives by click or
                // by Tab rather than by arrow key.
                onFocus={() => setFocusedTab(t)}
                className={`stage-tab ${display ? '' : 'capitalize'}`}
              >
                {display ?? t}
              </button>
            )
          })}
        </div>
      </div>

      {/* One tabpanel wrapper, not thirteen. Only one section is mounted at a
          time, so a single element whose id and aria-labelledby track the active
          tab is both correct and the only version that cannot drift out of sync
          with the strip above.
          NO tabIndex and NO focus-visible:outline-none. The first version had
          both, and the comment justifying them had the behaviour backwards: APG
          gives a tabpanel tabindex="0" only when it holds NOTHING focusable, and
          all thirteen of these are full of buttons and inputs — so it ADDED a
          stop before the content rather than skipping to it. Worse,
          `focus-visible:outline-none` then hid that stop: Tailwind 3 emits
          `outline: 2px solid transparent`, and at (0,2,0) it beat index.css's
          (0,1,0) `:focus-visible` outline floor on both specificity and source
          order. Focus landed on an invisible full-height container — the third
          time this exact cascade has shipped here, and index.css documents it
          twice. */}
      <div
        role="tabpanel"
        id={`admin-panel-${tab}`}
        aria-labelledby={`admin-tab-${tab}`}
      >
      {tab === 'dashboard' && (
        <div>
          {statsErr && (
            <div className="mb-6 px-5 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">{statsErr}</div>
          )}
          {statsLoading && !stats && (
            <div className="mb-6 text-white/40 text-sm">Loading stats…</div>
          )}
          {(skipStatus?.enabled || embStatus?.enabled) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4 mb-6">
              {([
                ...(embStatus && embStatus.enabled
                  ? [{
                      label: 'Titles Embedded',
                      value: `${embStatus.embedded.toLocaleString()} / ${embStatus.total.toLocaleString()}`,
                      icon: 'cpu',
                      color: embStatus.pending > 0 ? 'text-amber-400' : 'text-emerald-400',
                      hint: 'Media items with a semantic-search embedding — one per title (movie or show), not one per file. Shares its denominator with the Movies + Shows tile, not with Skip Analysis.',
                    }]
                  : []),
                ...(skipStatus && skipStatus.enabled
                  ? (() => {
                      const { analyzed, total, behind } = skipCoverage(skipStatus)
                      return [{
                        // Was "Skip Markers", which named the wrong noun:
                        // the figure counts FILES the detector has been
                        // through, and a file it found nothing in still
                        // counts. The marker counts the endpoint already
                        // returns now ride the sub-line.
                        label: 'Skip Analysis',
                        value: `${analyzed.toLocaleString()} / ${total.toLocaleString()}`,
                        icon: 'film',
                        color: behind ? 'text-amber-400' : 'text-emerald-400',
                        hint: 'Video files scanned for intro/recap/credits: every episode file plus every movie file. A file the detector found nothing in still counts as analyzed, so this is coverage, not markers found. Counts files — the Movies + Shows tile counts titles, so the two are not comparable.',
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
                  // send episodes to the Server panel below.
                  {
                    label: 'Movies + Shows',
                    value: (stats.movie_count + stats.show_count).toLocaleString(),
                    icon: 'film',
                    color: 'text-purple-400',
                    hint: 'Title rows: movies plus series. Episodes are NOT included — see Episodes in the Server panel below. Raw COUNT, so cross-library duplicates are counted twice and this can exceed the deduped total on browse pages.',
                  },
                  { label: 'Users', value: stats.user_count.toLocaleString(), icon: 'users', color: 'text-blue-400' },
                  { label: 'Active Streams', value: String(stats.active_streams), icon: 'monitor', color: 'text-emerald-400' },
                  { label: 'Disk Free', value: `${stats.disk_free_gb.toFixed(1)} GB`, icon: 'hardDrive', color: 'text-amber-400' },
                ] satisfies StatTileProps[]).map(s => (
                  <StatTile key={s.label} {...s} />
                ))}
              </div>

              <div className="glass-panel rounded-2xl p-6 mb-6">
                <h2 className="text-white font-semibold mb-4">Server</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-wide mb-1">Version</p>
                    <p className="text-white/90">{stats.version}</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-wide mb-1">Uptime</p>
                    <p className="text-white/90">{stats.uptime}</p>
                  </div>
                  <div title="Aurora's Go process RSS after the last GC. FFmpeg transcoders run as separate subprocesses and aren't counted here. PostgreSQL runs in its own container with its own memory budget.">
                    <p className="text-white/40 text-xs uppercase tracking-wide mb-1 cursor-help">Memory <span className="text-white/30">ⓘ</span></p>
                    <p className="text-white/90">{stats.memory_alloc_mb} MB</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-wide mb-1">Goroutines</p>
                    <p className="text-white/90">{stats.goroutines}</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-wide mb-1">Libraries</p>
                    <p className="text-white/90">{stats.library_count}</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-wide mb-1">Episodes</p>
                    <p className="text-white/90">{stats.episode_count.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-wide mb-1">Library Size</p>
                    <p className="text-white/90">{fmtBytes(stats.total_file_size_bytes)}</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-wide mb-1">Active Parties</p>
                    <p className="text-white/90">{stats.active_parties}</p>
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
          <div className="glass-panel rounded-2xl p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-white font-semibold mb-1">Invite a user</h2>
                <p className="text-white/40 text-xs">Generate a one-time code. Share it with the person you want to invite — they'll enter it on the Register screen.</p>
              </div>
              <button
                disabled={inviteBusy}
                onClick={async () => {
                  setInviteBusy(true); setInviteCopied(false)
                  try { const r = await createInvite(); setInviteCode(r.code) }
                  catch (e) { window.alert(e instanceof Error ? e.message : 'failed to generate invite') }
                  finally { setInviteBusy(false) }
                }}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm rounded-lg whitespace-nowrap"
              >{inviteBusy ? 'Generating…' : 'Generate Invite Code'}</button>
            </div>
            {/* data-screenshot-exclude — a live invite code is a one-time
                credential; blank the whole reveal block from bug-report
                screenshots (the capture path drops tagged subtrees). */}
            {inviteCode && (
              <div data-screenshot-exclude="true" className="mt-4 p-4 bg-white/[0.04] border border-white/[0.06] rounded flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="text-white/60 text-xs mb-1">Share this code:</p>
                  <p className="font-mono text-lg text-purple-300 tracking-wider break-all">{inviteCode}</p>
                </div>
                <button
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(inviteCode); setInviteCopied(true); setTimeout(() => setInviteCopied(false), 2000) }
                    catch { /* clipboard API may be unavailable on http:// — silently no-op */ }
                  }}
                  className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 text-xs rounded whitespace-nowrap"
                >{inviteCopied ? '✓ Copied' : 'Copy'}</button>
              </div>
            )}
          </div>

          <div className="glass-panel rounded-2xl overflow-hidden">
          {usersLoading && !users && <p className="p-6 text-white/40 text-sm">Loading users…</p>}
          {usersErr && <p className="p-6 text-red-300 text-sm">{usersErr}</p>}
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
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center text-white text-xs font-bold">
                          {u.username[0]?.toUpperCase() || '?'}
                        </div>
                        <div>
                          <p className="text-white/90 text-sm font-medium">{u.username}</p>
                          <p className="text-white/40 text-xs">{u.email || '—'}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`badge-glass text-xs ${u.role === 'admin' ? 'bg-purple-500/10 text-purple-300 border-purple-500/20' : 'bg-white/5 text-white/50 border-white/10'}`}>
                        {u.role}
                      </span>
                    </td>
                    <td>
                      <span className="text-white/60 text-sm">{u.oauth_provider ? u.oauth_provider : 'password'}</span>
                    </td>
                    <td>
                      <ReferralCell
                        user={u}
                        options={referralOptions}
                        answeredAt={u.referral_answered_at ? fmtRelative(u.referral_answered_at) : undefined}
                      />
                    </td>
                    <td className="text-white/40">{fmtRelative(u.created_at)}</td>
                    <td className="text-white/40">{u.last_login_at ? fmtRelative(u.last_login_at) : 'Never'}</td>
                    <td className="text-right">
                      {/* 3-dot actions: promote/demote + delete. Hidden on the
                          current admin's own row — the server refuses both
                          self-delete and self-role-change with a 4xx, so this
                          just spares them a menu of dead options. */}
                      {currentAdminId !== u.id && (
                        <div className="flex justify-end">
                          <UserRowMenu
                            user={u}
                            onRoleChanged={(role) => setUsers(prev => prev ? prev.map(x => x.id === u.id ? { ...x, role } : x) : prev)}
                            onDeleted={() => setUsers(prev => prev ? prev.filter(x => x.id !== u.id) : prev)}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={7} className="text-white/40 text-sm text-center py-6">No users found.</td></tr>
                )}
              </tbody>
            </table>
          )}
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="glass-panel rounded-2xl p-6">
          <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
            <h2 className="text-white font-semibold">Recent Activity</h2>
            {/* Server-side filter (?type=). The option list comes from the
                server's distinct event types, so it can't drift from the
                types handlers actually write, and only lists what this
                instance has recorded. */}
            <label className="flex items-center gap-2 text-xs text-white/40">
              <span>Filter</span>
              <select
                value={activityType}
                onChange={e => {
                  setActivityType(e.target.value)
                  // Let the fetch effect's `activity !== null` guard re-run
                  // against the new filter, exactly like the log-level toggle.
                  setActivity(null)
                }}
                className="px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm"
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
          {activityLoading && !activity && <p className="text-white/40 text-sm">Loading activity…</p>}
          {activityErr && <p className="text-red-300 text-sm">{activityErr}</p>}
          {activity && (
            <div className="space-y-3">
              {activity.length === 0 && (
                <p className="text-white/40 text-sm">
                  {activityType
                    ? `No "${activityType.replace(/_/g, ' ')}" activity recorded.`
                    : 'No recent activity.'}
                </p>
              )}
              {activity.map((e) => (
                <div key={e.id} className="flex items-center gap-4 py-2 border-b border-white/[0.03] last:border-0">
                  <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center flex-shrink-0">
                    <Icon name="activity" size={14} className="text-purple-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-white/70 text-sm">{e.event_type.replace(/_/g, ' ')}</span>
                  </div>
                  {e.username && <span className="text-white/40 text-xs">{e.username}</span>}
                  <span className="text-white/30 text-xs whitespace-nowrap">{fmtRelative(e.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'logs' && (
        <div className="glass-panel rounded-2xl p-6 font-mono text-xs">
          <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
            <h2 className="text-white font-semibold font-sans">System Logs</h2>
            {/* Level filter. 'Problems' reads a SEPARATE server-side ring for
                WARN+ERROR rather than filtering what's already loaded: the
                main ring holds ~1000 entries, which is minutes of history at
                Aurora's request volume, so a client-side filter would show
                nothing for an incident twenty minutes old. */}
            <div className="flex items-center gap-1 rounded-lg bg-white/5 p-1 font-sans" role="group" aria-label="Log level filter">
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
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    logLevel === opt.key
                      ? 'bg-white/15 text-white'
                      : 'text-white/50 hover:text-white/80'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {logLevel === 'problems' && (
            <p className="text-white/40 text-[11px] font-sans mb-3">
              Warnings and errors are kept in a dedicated buffer, so these reach
              much further back than the full log.
            </p>
          )}
          {logsLoading && !logs && <p className="text-white/40 text-sm font-sans">Loading logs…</p>}
          {logsErr && <p className="text-red-300 text-sm font-sans">{logsErr}</p>}
          {logs && (
            <div className="space-y-1 max-h-[500px] overflow-y-auto">
              {logs.length === 0 && (
                <p className="text-white/40 text-sm font-sans">
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
                    <span className="text-white/40 flex-shrink-0">{new Date(entry.time).toLocaleString()}</span>
                    <span className={`flex-shrink-0 ${
                      entry.level === 'ERROR' || entry.level === 'error' ? 'text-red-400' :
                      entry.level === 'WARN' || entry.level === 'warn' ? 'text-amber-400' :
                      'text-purple-400'
                    }`}>
                      [{entry.level.toUpperCase()}]
                    </span>
                    <span className="text-white/60 break-words">{summary}</span>
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
      {tab === 'llm' && <AdminLLMTab />}
      {tab === 'oauth' && <AdminOAuthTab />}
      {tab === 'backup' && <AdminBackupRestore downloadBackup={downloadBackup} />}
      </div>
    </div>
  )
}
