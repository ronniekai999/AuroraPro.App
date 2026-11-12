// Settings, "App and notifications" (/settings/app): how the app looks on
// this device, push notifications to it, installing it, and the credits the
// metadata providers require.

import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { Icon } from '@/components/Icon'
import { type Toast } from '@/components/Toast'
import { applyReduceEffects, currentReduceEffects } from '@/lib/appearance'
import { getPushConfig, sendPushTest } from '@/lib/api'
import { installPrompt, installUIState, isIOSDevice, isStandaloneDisplay } from '@/lib/pwa'
import { disablePush, enablePush, pushSupported, pushUIState, type PushUIState } from '@/lib/push'
import { PaneSection, SettingRow, SettingSwitch } from './controls'

type OnToast = (message: string, type?: Toast['type']) => void

export function AppPane({ onToast }: { onToast?: OnToast }) {
  const ids = useId()
  const [reduceEffects, setReduceEffects] = useState<boolean>(currentReduceEffects)

  return (
    <>
      <PaneSection title="Appearance" note="Kept in this browser.">
        <SettingRow
          labelId={`${ids}-effects`}
          descId={`${ids}-effects-desc`}
          label="Reduce effects"
          desc="No blur behind the top bar, the tab bar and the floating controls. Easier on older graphics hardware."
        >
          <SettingSwitch
            checked={reduceEffects}
            labelledBy={`${ids}-effects`}
            describedBy={`${ids}-effects-desc`}
            onChange={next => {
              applyReduceEffects(next)
              setReduceEffects(next)
            }}
          />
        </SettingRow>
      </PaneSection>

      <PaneSection title="Notifications" note="The bell in the app always shows them. This is about reaching this device when Aurora is closed.">
        <PushControls onToast={onToast} />
      </PaneSection>

      <InstallCard onToast={onToast} />

      {/* TMDB's API terms require this notice wherever their data is used;
          TheTVDB asks for a link back. */}
      <p className="mt-10 max-w-[62ch] text-[13px] leading-relaxed text-ink-3">
        This product uses the TMDB API but is not endorsed or certified by{' '}
        <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className="text-ink-2 underline underline-offset-2 hover:text-ink">TMDB</a>.
        {' '}TV metadata provided by{' '}
        <a href="https://thetvdb.com" target="_blank" rel="noreferrer" className="text-ink-2 underline underline-offset-2 hover:text-ink">TheTVDB</a>.
      </p>
    </>
  )
}

/* ─────────────────────── Install as an app ─────────────────────── */

// Which body shows is decided by installUIState (lib/pwa): an installed app
// says so; a captured browser prompt gets a one-tap button; iOS gets the Add
// to Home Screen steps it requires; everywhere else gets the browser-menu
// pointer, because the service worker has no fetch handler and Chromium may
// therefore never volunteer its prompt.
function InstallCard({ onToast }: { onToast?: OnToast }) {
  // The store subscription makes the button appear the moment the browser
  // offers its prompt, with this page already open. Standalone and iOS are
  // stable for a page load, so reading them during render is fine.
  const hasInstallPrompt = useSyncExternalStore(installPrompt.subscribe, installPrompt.has)
  const installedNow = useSyncExternalStore(installPrompt.subscribe, installPrompt.installedThisSession)
  const state = installUIState({
    // `installedNow` covers the tab that just started the install: it keeps
    // running as a plain tab, and pointing its user at the browser menu they
    // just used would be wrong.
    standalone: isStandaloneDisplay(window) || installedNow,
    hasDeferredPrompt: hasInstallPrompt,
    isIOS: isIOSDevice(navigator),
  })
  const install = () => {
    installPrompt.prompt().then(outcome => {
      if (outcome === 'accepted') onToast?.('Aurora is installing on this device', 'success')
    }).catch(() => {
      // Chrome rejects prompt() on a stale event. An uncaught rejection here
      // would be recorded as an app error, which this must never cause.
      onToast?.('The install prompt could not be shown. Try your browser’s menu instead.', 'error')
    })
  }
  const id = useId()

  return (
    <section aria-labelledby={id} className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-control bg-surface-raised p-6">
      <div className="min-w-0 flex-1 basis-[18rem]">
        <h2 id={id} className="font-display text-[22px] font-semibold leading-tight text-ink">Use Aurora like an app</h2>
        {state === 'installed' && (
          <p className="mt-2 flex items-center gap-2 text-[14px] text-ink-2">
            <Icon name="check" size={16} className="flex-none text-ok" />
            Running as an installed app on this device.
          </p>
        )}
        {state === 'prompt' && (
          <p className="mt-2 max-w-[52ch] text-[14px] leading-snug text-ink-2">It gets its own icon and opens in its own window, without the browser’s bars.</p>
        )}
        {state === 'ios-guide' && (
          <>
            <p className="mt-2 text-[14px] leading-snug text-ink-2">Add Aurora to your Home Screen to use it as an app:</p>
            {/* No "in Safari": every browser on iOS has a Share menu with
                this entry, and naming Safari would misdirect the others. */}
            <ol className="mt-2 list-inside list-decimal space-y-1 text-[14px] text-ink">
              <li>Tap the Share button</li>
              <li>Choose “Add to Home Screen”</li>
              <li>Open Aurora from your Home Screen</li>
            </ol>
          </>
        )}
        {state === 'manual' && (
          <p className="mt-2 max-w-[52ch] text-[14px] leading-snug text-ink-2">
            Open your browser’s menu and choose “Install Aurora” or “Add to Home screen”.
          </p>
        )}
      </div>
      {state === 'prompt' && (
        <button type="button" onClick={install} className="stage-btn stage-btn-primary flex-none">Install Aurora</button>
      )}
    </section>
  )
}

/* ─────────────────────── Push to this device ─────────────────────── */

/** navigator.serviceWorker.ready never rejects: it waits for ever when no
 *  registration exists (registration failed at boot, say). Every use here is
 *  bounded, or such a device would show "Checking…" for ever and the switch
 *  would hang on a tap. */
function readyWithTimeout(ms = 4000): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('service worker never became ready')), ms)),
  ])
}

const PUSH_UNAVAILABLE: Partial<Record<PushUIState | 'error', string>> = {
  'unsupported': 'This browser does not support push notifications.',
  'error': 'Push notifications are not available right now.',
  'server-disabled': 'Push is turned off on this server.',
  'ios-needs-install': 'On an iPhone or iPad, push works from the installed app. Add Aurora to your Home Screen first (the steps are below).',
  'permission-denied': 'Notifications are blocked for Aurora in this browser’s settings. Allow them there, then come back.',
}

/**
 * Push for this device (docs/push.md). What shows is decided by the
 * pushUIState machine over what this browser can really do, and every change
 * is the direct result of a tap: the permission prompt is never raised
 * unasked.
 */
function PushControls({ onToast }: { onToast?: OnToast }) {
  const ids = useId()
  const [state, setState] = useState<PushUIState | 'loading' | 'error'>('loading')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!pushSupported(window)) {
      setState('unsupported')
      return
    }
    try {
      const [cfg, sub] = await Promise.all([
        getPushConfig(),
        readyWithTimeout().then(r => r.pushManager.getSubscription()),
      ])
      setState(pushUIState({
        supported: true,
        serverEnabled: cfg.enabled && !!cfg.vapid_public_key,
        isIOS: isIOSDevice(navigator),
        standalone: isStandaloneDisplay(window),
        permission: Notification.permission,
        subscribed: !!sub,
      }))
    } catch {
      setState('error')
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const enable = () => {
    if (busy) return
    setBusy(true)
    enablePush({
      requestPermission: () => Notification.requestPermission(),
      ready: () => readyWithTimeout(),
    }).then(result => {
      if (result === 'enabled') onToast?.('Push is on for this device', 'success')
      else if (result === 'failed') onToast?.('Push could not be turned on for this device', 'error')
      // permission-denied and server-disabled: the refreshed row explains.
    }).catch(() => {
      // enablePush rejects when the config fetch or the bounded wait for the
      // service worker fails: the same answer for the person.
      onToast?.('Push could not be turned on for this device', 'error')
    }).finally(() => {
      setBusy(false)
      void refresh()
    })
  }
  const disable = () => {
    if (busy) return
    setBusy(true)
    disablePush({ ready: () => readyWithTimeout() })
      .then(() => onToast?.('Push is off for this device', 'info'))
      .catch(() => onToast?.('Push could not be turned off for this device', 'error'))
      .finally(() => {
        setBusy(false)
        void refresh()
      })
  }
  const test = () => {
    if (busy) return
    setBusy(true)
    sendPushTest()
      .then(r => onToast?.(`Test sent to ${r.devices} device${r.devices === 1 ? '' : 's'}`, 'success'))
      .catch((e: unknown) => onToast?.(e instanceof Error ? e.message : 'The test could not be sent', 'error'))
      .finally(() => setBusy(false))
  }

  if (state === 'loading') {
    return <SettingRow label="Push to this device" desc="Checking what this browser can do…" />
  }
  const unavailable = PUSH_UNAVAILABLE[state]
  if (unavailable) {
    return <SettingRow label="Push to this device" desc={unavailable} />
  }

  const on = state === 'on'
  return (
    <>
      <SettingRow
        labelId={`${ids}-push`}
        descId={`${ids}-push-desc`}
        label="Push to this device"
        desc="Request updates, watch-party invitations and reminders reach this device even when Aurora is closed. Push belongs to the account, so it is the same whichever profile is watching."
      >
        <SettingSwitch
          checked={on}
          disabled={busy}
          labelledBy={`${ids}-push`}
          describedBy={`${ids}-push-desc`}
          onChange={() => (on ? disable() : enable())}
        />
      </SettingRow>
      {on && (
        <SettingRow label="Test it" desc="Sends one notification to every device this account has turned push on for.">
          <button type="button" disabled={busy} onClick={test} className="stage-btn stage-btn-ghost">Send a test</button>
        </SettingRow>
      )}
    </>
  )
}
