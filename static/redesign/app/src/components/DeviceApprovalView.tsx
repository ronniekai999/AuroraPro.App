import { useEffect, useRef, useState, type FormEvent } from 'react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'

interface Props {
  username: string
  initialCode: string
}

export default function DeviceApprovalView({ username, initialCode }: Props) {
  const [code, setCode] = useState(initialCode)
  const [device, setDevice] = useState<{ device_name: string; user_id: number; username: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  async function lookup(event: FormEvent) {
    event.preventDefault()
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    setDevice(null)
    try {
      const result = await apiFetch<{ device_name: string; user_id: number; username: string }>(`/api/auth/device/preview?code=${encodeURIComponent(code.trim())}`, {
        signal: controller.signal,
      })
      if (!controller.signal.aborted) setDevice(result)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not find this device.')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  async function approve() {
    if (busy || !device) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/api/auth/device/authorize', { method: 'POST', body: { user_code: code.trim(), expected_user_id: device.user_id }, signal: controller.signal })
      if (!controller.signal.aborted) setApproved(true)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not approve this device.')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <section className="max-w-xl">
      <PageHeader eyebrow="AuroraPro on TV" title="Connect your TV" sub={`Signing in as ${device?.username ?? username}`} />
      {approved ? (
        <p className="text-white/80" role="status">TV approved. Return to your TV to choose a profile and start watching.</p>
      ) : (
        <>
          <form onSubmit={lookup} className="space-y-4">
            <label htmlFor="device-code" className="block text-sm text-white/80">Enter the code shown on your TV</label>
            <input id="device-code" name="device-code" value={code} disabled={busy} maxLength={9}
              onChange={event => { setCode(event.target.value.toUpperCase()); setDevice(null); setError(null) }}
              autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-1234"
              className="w-full rounded-lg border border-white/20 bg-white/[0.06] px-4 py-3 text-xl tracking-widest text-white" />
            <button type="submit" disabled={busy || code.replaceAll('-', '').trim().length !== 8}
              className="rounded-lg border border-purple-400/40 bg-purple-500/20 px-4 py-2.5 font-semibold text-purple-100 transition-colors hover:bg-purple-500/30 disabled:opacity-50">{busy ? 'Checking…' : 'Find TV'}</button>
          </form>
          {device && (
            <div className="mt-6 space-y-4 rounded-xl border border-white/20 bg-white/[0.04] p-5">
              <p className="text-white">{device.device_name} wants to sign in to your AuroraPro account.</p>
              <p className="text-sm text-white/70">Approve only if you started sign-in on this TV and its code matches <strong>{code}</strong>.</p>
              <button type="button" onClick={() => void approve()} disabled={busy}
                className="rounded-lg border border-purple-400/40 bg-purple-500/20 px-4 py-2.5 font-semibold text-purple-100 transition-colors hover:bg-purple-500/30 disabled:opacity-50">{busy ? 'Approving…' : `Approve TV for ${device.username}`}</button>
            </div>
          )}
          {error && <p role="alert" className="mt-4 text-red-300">{error}</p>}
        </>
      )}
    </section>
  )
}
