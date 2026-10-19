// Settings view — user profile, connected accounts (OAuth), profiles +
// watchlists, appearance/content-tone dials. Extracted from App.tsx
// (2026-06-17 app split, Phase 2.2) as the first non-admin lazy view of
// real size. ConnectedAccountsCard + ProfilesAndWatchlistsCard are
// module-private helpers used only here, so they ride along; the OAuth
// provider-label helper they share with App's link-mode toast lives in
// @/lib/oauth (shared leaf). `onToast={addToast}` is App's stable toast
// callback, threaded in unchanged.

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { Icon } from '@/components/Icon'
import { installPrompt, installUIState, isStandaloneDisplay, isIOSDevice } from '@/lib/pwa'
import { pushUIState, pushSupported, enablePush, disablePush, type PushUIState } from '@/lib/push'
import { getPushConfig, sendPushTest } from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { MATURITY_OPTIONS, type MaturityPref } from '@/lib/maturity'
import { nextRadioIndex } from '@/lib/radiogroup'
import { type Toast } from '@/components/Toast'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { oauthProviderLabel } from '@/lib/oauth'
import {
  AUDIO_LANGUAGE_OPTIONS,
  FONT_OPTIONS,
  GLOW_OPTIONS,
  MAX_STREAM_BITRATE_OPTIONS,
  applyFont,
  applyGlow,
  applyMaxStreamBps,
  applyPreferredAudioLanguage,
  applyPreferredQuality,
  currentFont,
  currentGlow,
  currentMaxStreamBps,
  currentPreferredAudioLanguage,
  currentPreferredQuality,
  readPrefsSnapshot,
  writePrefs,
  type AudioLanguageChoice,
  type FontChoice,
  type GlowChoice,
  type QualityChoice,
} from '@/lib/appearance'
import { NebulaAvatar, NEBULAS, parseNebula, nebulaValue } from '@/components/NebulaAvatar'
import { GamificationCard } from '@/components/GamificationCard'
import {
  listOAuthLinks,
  startOAuthLink,
  unlinkOAuth,
  listProfiles,
  createProfile,
  listWatchlists,
  createWatchlist,
  deleteWatchlist,
  getMyProfile,
  updateMyProfile,
  setProfilePin,
  type User as ApiUser,
  type Profile,
  type ProfileUnlock,
  type OAuthLinksResponse,
  type Watchlist,
  type MemberProfile,
} from '@/lib/api'
import { SOCIAL_NETWORKS, normalizeHandleInput } from '@/lib/socialLinks'
import { ProfilePinDialog } from '@/components/ProfilePinDialog'
import { isRestrictedProfile, openDoorProfiles } from '@/lib/profileSession'

/* ─────────────────────── SETTINGS VIEW ─────────────────────── */
interface SettingsViewProps {
  user?: ApiUser
  onLogout?: () => void
  onToast?: (message: string, type?: Toast['type']) => void
  activeProfile?: Profile | null
  onMaturityChange?: (pref: number) => void | Promise<void>
  onAvatarChange?: (avatarUrl: string) => void | Promise<void>
  /** Opens /user/:username for the signed-in user (threaded from App's
   *  navigate — SettingsView itself doesn't own routing). */
  onOpenMyProfile?: () => void
  /** Called after a change to profiles App also holds (a PIN set or removed),
   *  so its copy, which decides whether a switch prompts, is re-read. */
  onProfilesChanged?: () => void
}
export default function SettingsView({ user: settingsUser, onLogout, onToast, activeProfile, onMaturityChange, onAvatarChange, onOpenMyProfile, onProfilesChanged }: SettingsViewProps = {}) {
  // Phase E2c content-tone dial. Optimistic local override so the chip flips
  // instantly; reset when the active profile changes (server value wins again).
  const [localMaturity, setLocalMaturity] = useState<number | null>(null)
  useEffect(() => { setLocalMaturity(null) }, [activeProfile?.id])
  const currentMaturity = localMaturity ?? activeProfile?.maturity_pref ?? -1
  // Same optimistic pattern for the per-profile avatar picker.
  const [localAvatar, setLocalAvatar] = useState<string | null>(null)
  useEffect(() => { setLocalAvatar(null) }, [activeProfile?.id])
  const currentAvatar = localAvatar ?? activeProfile?.avatar_url ?? ''
  // The first useEffect write is skipped so just opening Settings
  // doesn't rewrite the stored object.
  const skipFirstWriteRef = useRef(true)
  const [settings, setSettings] = useState(() => {
    const parsed = readPrefsSnapshot()
    return {
      autoplay: parsed.autoplay !== false,
      hdr: parsed.hdr !== false,
      notifications: parsed.notifications !== false,
      hardwareDecoding: parsed.hardwareDecoding !== false,
      subtitleLang: (parsed.subtitleLang as string) ?? 'en',
      audioLang: (parsed.audioLang as string) ?? 'en',
    }
  })

  // Appearance + quality dials are real React state now, sourced from the
  // shared helpers rather than read out of a cached prefs blob (Aurora Stage
  // Phase 7a). Previously each was read from `rawRef.current` and written with
  // its own inline localStorage call, and a `setSettings(s => ({...s}))` was
  // fired purely to force a re-render because ref mutations are invisible to
  // React. Actual state makes the re-render automatic and the three encodings
  // of the typeface default collapse to one.
  // Radio refs, so arrow-key movement can put real focus on the newly checked
  // option — the roving tabIndex alone changes which button is REACHABLE, not
  // which one is focused.
  const glowRefs = useRef<Partial<Record<GlowChoice, HTMLButtonElement | null>>>({})
  const fontRefs = useRef<Partial<Record<FontChoice, HTMLButtonElement | null>>>({})
  const toneRefs = useRef<Record<number, HTMLButtonElement | null>>({})

  const [fontChoice, setFontChoice] = useState<FontChoice>(currentFont)
  const [glowChoice, setGlowChoice] = useState<GlowChoice>(currentGlow)
  const [quality, setQuality] = useState<QualityChoice>(currentPreferredQuality)
  // Delivery preferences (September 2026 playback pass): both are read at
  // play time by lib/streaming.ts, so a change here applies to the next play.
  const [audioLang, setAudioLang] = useState<AudioLanguageChoice>(currentPreferredAudioLanguage)
  const [maxBps, setMaxBps] = useState<number>(currentMaxStreamBps)

  // Persist on every change, merging over a FRESH read so unknown keys
  // (volume, muted, legacy V1 values) round-trip unmodified.
  //
  // The fresh read is the fix for a real clobber. This used to merge over a
  // `rawRef` snapshot captured at mount, and `aurora_prefs` has three writers:
  // this effect, appearance.ts's writePref, and VideoPlayer's writeVolumePref —
  // which persists `player_volume` (and only that; `muted` is deliberately never
  // stored, and `autoplay` is read-only there). SettingsView stays mounted
  // beneath the player, so: open Settings, play something, change the volume,
  // come back and toggle any switch → Settings wrote
  // `{...mountTimeSnapshot, ...settings}` and silently reverted the volume.
  //
  // Reading at write time fixes that for every key OUTSIDE `settings`, and makes
  // applyFont/applyGlow (which do their own read-modify-write) safe to call from
  // the handlers below. It does NOT protect the six keys `settings` itself owns:
  // those come from a mount-time snapshot, so a future second writer of
  // `autoplay`/`hdr`/`subtitleLang`/… would still be clobbered by the next
  // toggle. No live bug — the three writers' key sets are disjoint today — but
  // that is the invariant to preserve, not "reads fresh so nothing can be lost".
  useEffect(() => {
    if (skipFirstWriteRef.current) {
      skipFirstWriteRef.current = false
      return
    }
    // Via the shared writer — this used to be a third hand-rolled
    // read-modify-write of `aurora_prefs`, with the same shape as the two the
    // blob's owner already implements.
    writePrefs(settings)
  }, [settings])

  const toggle = (key: keyof typeof settings) => {
    setSettings(prev => ({ ...prev, [key]: typeof prev[key] === 'boolean' ? !prev[key] : prev[key] }))
  }

  // Install-as-app card state. The store subscription makes the one-tap
  // button appear the moment Chrome volunteers its install prompt, even with
  // Settings already open; the decision itself is the tested pure function in
  // lib/pwa. Standalone/iOS are stable per page load, so reading them during
  // render is fine.
  const hasInstallPrompt = useSyncExternalStore(installPrompt.subscribe, installPrompt.has)
  const installedNow = useSyncExternalStore(installPrompt.subscribe, installPrompt.installedThisSession)
  const appInstallState = installUIState({
    // `installedNow` covers the tab that just triggered the install — it
    // keeps running as a plain tab (standalone stays false), and telling that
    // user "open your browser's menu" would point them at the menu they just
    // used.
    standalone: isStandaloneDisplay(window) || installedNow,
    hasDeferredPrompt: hasInstallPrompt,
    isIOS: isIOSDevice(navigator),
  })
  const handleInstall = () => {
    installPrompt.prompt().then(outcome => {
      if (outcome === 'accepted') onToast?.('Aurora is installing to your device', 'success')
    }).catch(() => {
      // Chrome rejects prompt() on a stale event. Degrade to guidance — an
      // uncaught rejection here would land in the diagnostic buffer as an
      // app error, which this best-effort feature must never cause.
      onToast?.('The install prompt could not be shown — try your browser menu instead', 'error')
    })
  }

  const sections = [
    {
      title: 'Playback',
      icon: 'play',
      items: [
        { key: 'autoplay' as const, label: 'Auto-play next episode', desc: 'Automatically continue to the next episode' },
        { key: 'hdr' as const, label: 'HDR Tone Mapping', desc: 'Enable HDR to SDR conversion' },
        { key: 'hardwareDecoding' as const, label: 'Hardware Decoding', desc: 'Use GPU acceleration for video decoding' },
      ]
    },
    // Notifications moved out of this generic-toggle array: the card now
    // combines the in-app pref with the device push controls, which need
    // real state (permission, subscription, server switch) a bare toggle
    // can't express. See the dedicated card below.
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader title="Settings" sub="Configure your preferences" />

      {/* Two columns from md up, one below — the mockup's .set-grid. The page
          was `max-w-3xl` and a single `space-y-6` stack, which on a 1440px
          screen left roughly half the viewport empty while the user scrolled
          past nine cards.
          `items-start` matters: grid items stretch to the row's height by
          default, so a short card (Quality) beside a tall one (Appearance)
          would grow a panel of empty glass to match it. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        {/* Appearance — Glow Style picker. Writes
            aurora_prefs.glow_intensity and live-updates <html data-glow>
            so panels/cards reflow their border + halo immediately.
            Default ("aurora") is the unprefixed :root token set in
            index.css; only "subtle" and "heavy" set the attribute. */}
        {/* md:col-span-2 — the glow row is 3-up and the typeface row 2x2, so
            this card needs the full width to avoid four chips of two words
            each wrapping. */}
        <div className="glass-panel rounded-2xl p-6 md:col-span-2">
          <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
            <Icon name="eye" size={18} className="text-purple-400" />
            Appearance
          </h2>
          <div className="space-y-3">
            <div>
              <p className="text-white/80 text-sm font-medium">Glow Style</p>
              <p className="text-white/55 text-xs">Border and halo around panels, cards, and the hero.</p>
            </div>
            {/* GLOW_OPTIONS from lib/appearance, not a literal list. The copy
                is the shared copy; the only thing lost is the "(default)"
                suffix, which the shared list omits because the onboarding
                "Make it yours" step renders the same options and calling one
                "default" there is meaningless. */}
            {/* Arrow keys + one tab stop, via the shared radiogroup helper.
                All four radiogroups on this page previously left every option a
                separate tab stop with the arrows dead — see lib/radiogroup. */}
            <div
              role="radiogroup"
              aria-label="Glow style"
              className="grid grid-cols-3 gap-3"
              // Inline event handler rather than a factory that takes a focus
              // callback: react-hooks/refs flags PASSING a ref-reading function
              // as an argument during render, while a ref read inside an event
              // handler is exactly what the rule permits. The movement
              // arithmetic still lives in the tested nextRadioIndex.
              onKeyDown={e => {
                const ids = GLOW_OPTIONS.map(o => o.id)
                const n = nextRadioIndex(e.key, Math.max(0, ids.indexOf(glowChoice)), ids.length)
                if (n === null) return
                e.preventDefault()
                applyGlow(ids[n]); setGlowChoice(ids[n])
                glowRefs.current[ids[n]]?.focus()
              }}
            >
              {GLOW_OPTIONS.map(opt => {
                const active = glowChoice === opt.id
                return (
                  <button
                    key={opt.id}
                    ref={el => { glowRefs.current[opt.id] = el }}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => { applyGlow(opt.id); setGlowChoice(opt.id) }}
                    className="stage-opt text-left"
                  >
                    <p className={`text-sm font-medium ${active ? 'text-white' : 'text-white/80'}`}>{opt.label}</p>
                    <p className="text-white/55 text-xs mt-0.5">{opt.desc}</p>
                  </button>
                )
              })}
            </div>

            {/* Typeface. FONT_OPTIONS + applyFont + currentFont from
                lib/appearance — the consolidation deferred from Phase 0.
                Previously this radiogroup carried its OWN copy of the four
                options, its own default fallback, and its own
                remove-attribute-when-default branch, duplicating applyFont()
                exactly. That made three independent encodings of "which system
                is the default" (here, appearance.ts, and the pre-paint shim in
                main.tsx), of which only appearance.ts was under test — so a
                drift between them would have been invisible. Two remain, and
                main.tsx consumes ATTRIBUTED_FONTS from the same module.

                Each chip still previews its own display face via opt.font. */}
            <div className="pt-1">
              <p className="text-white/80 text-sm font-medium">Typeface</p>
              <p className="text-white/55 text-xs">Display and body fonts used across the app.</p>
            </div>
            <div
              role="radiogroup"
              aria-label="Typeface"
              className="grid grid-cols-2 gap-3"
              onKeyDown={e => {
                const ids = FONT_OPTIONS.map(o => o.id)
                const n = nextRadioIndex(e.key, Math.max(0, ids.indexOf(fontChoice)), ids.length)
                if (n === null) return
                e.preventDefault()
                applyFont(ids[n]); setFontChoice(ids[n])
                fontRefs.current[ids[n]]?.focus()
              }}
            >
              {FONT_OPTIONS.map(opt => {
                const active = fontChoice === opt.id
                return (
                  <button
                    key={opt.id}
                    ref={el => { fontRefs.current[opt.id] = el }}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => { applyFont(opt.id); setFontChoice(opt.id) }}
                    className="stage-opt text-left"
                  >
                    <p className={`text-base font-semibold ${active ? 'text-white' : 'text-white/80'}`} style={{ fontFamily: opt.font }}>{opt.label}</p>
                    <p className="text-white/55 text-xs mt-0.5">{opt.desc}</p>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Avatar — per-profile animated nebula. Optimistic localAvatar flips the
            selection instantly; onAvatarChange persists via PUT /api/profiles/:id
            and refreshes the profile list so the switcher + account menu update. */}
        {/* md:col-span-2 — the 10-up nebula grid inside is keyed on `sm:`
            (a VIEWPORT query) but is sized by its grid COLUMN. At 768px a
            half-width column gave (280-108)/10 = 17px swatches, with the
            selected one's ring about a fifth of its diameter. Spanning the full
            width restores ~50px. No viewport breakpoint can express "my column
            is narrow", which is the general trap in moving a full-width page
            into columns. */}
        {onAvatarChange && activeProfile && (
          <div className="glass-panel rounded-2xl p-6 md:col-span-2">
            <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
              <Icon name="user" size={18} className="text-purple-400" />
              Avatar
            </h2>
            <div className="space-y-3">
              <div>
                <p className="text-white/80 text-sm font-medium">Nebula for {activeProfile.name}</p>
                <p className="text-white/40 text-xs">Your animated signature — shows in the profile switcher and account menu.</p>
              </div>
              <div role="radiogroup" aria-label="Avatar" className="grid grid-cols-5 gap-3 sm:grid-cols-10">
                {NEBULAS.map(n => {
                  const sel = parseNebula(currentAvatar)?.id === n.id
                  return (
                    <button
                      key={n.id}
                      type="button"
                      role="radio"
                      aria-checked={sel}
                      aria-label={n.name}
                      title={n.name}
                      onClick={() => {
                        const prev = localAvatar
                        setLocalAvatar(nebulaValue(n.id))
                        Promise.resolve(onAvatarChange(nebulaValue(n.id))).catch(() => setLocalAvatar(prev))
                      }}
                      className={`relative aspect-square rounded-full transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 ${
                        sel ? 'scale-110 ring-2 ring-white/50' : 'hover:scale-105'
                      }`}
                    >
                      <NebulaAvatar nebula={n} active={sel} className="block h-full w-full" />
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Content Tone (Phase E2c) — per-profile maturity LEAN for recommendations.
            A SOFT recall bias (the recommender adds a small distance penalty by
            how far an item's rating tier is from this pick), distinct from a
            profile's hard age limit. Writes maturity_pref via PUT /api/profiles/:id
            and invalidates the hero cache so it re-curates on the next Home visit. */}
        {onMaturityChange && activeProfile && (
          <div className="glass-panel rounded-2xl p-6">
            <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
              <Icon name="sparkle" size={18} className="text-purple-400" />
              Content Tone
            </h2>
            <div className="space-y-3">
              <div>
                <p className="text-white/80 text-sm font-medium">Recommendation lean for {activeProfile.name}</p>
                <p className="text-white/40 text-xs">Nudges what surfaces first toward a maturity tier — it doesn't hide anything (that's the age limit). Applies on your next Home visit.</p>
              </div>
              <div
                role="radiogroup"
                aria-label="Content tone"
                className="grid grid-cols-2 gap-3"
                onKeyDown={e => {
                  const vals = MATURITY_OPTIONS.map(o => o.v)
                  const n = nextRadioIndex(e.key, Math.max(0, vals.indexOf(currentMaturity as MaturityPref)), vals.length)
                  if (n === null) return
                  e.preventDefault()
                  const prev = currentMaturity
                  setLocalMaturity(vals[n])
                  Promise.resolve(onMaturityChange(vals[n])).catch(() => setLocalMaturity(prev))
                  toneRefs.current[vals[n]]?.focus()
                }}
              >
                {/* MATURITY_OPTIONS from lib/maturity, not a literal list. -1 is
                    AUTO, not off: the recommender derives the lean from the
                    profile's watched rating tiers (server-side, Phase E2c auto
                    mode) and explicit picks (0/1/2) always override it. The
                    profile switcher's subtitle reads the same list, so the
                    surface that writes this field and the surface that reports
                    it cannot describe its four values differently. */}
                {MATURITY_OPTIONS.map(opt => {
                  const active = currentMaturity === opt.v
                  return (
                    <button
                      key={opt.v}
                      ref={el => { toneRefs.current[opt.v] = el }}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={active ? 0 : -1}
                      onClick={() => {
                        const prev = currentMaturity
                        setLocalMaturity(opt.v)
                        // Roll back the optimistic selection if the save rejects.
                        Promise.resolve(onMaturityChange(opt.v)).catch(() => setLocalMaturity(prev))
                      }}
                      // .stage-opt like its two siblings — this was the last
                      // radiogroup on the page still hand-rolling the selected
                      // fill/border/shadow triple inline.
                      className="stage-opt text-left"
                    >
                      <p className={`text-sm font-medium ${active ? 'text-white' : 'text-white/80'}`}>{opt.label}</p>
                      <p className="text-white/55 text-xs mt-0.5">{opt.desc}</p>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {sections.map(section => (
          <div key={section.title} className="glass-panel rounded-2xl p-6">
            <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
              <Icon name={section.icon} size={18} className="text-purple-400" />
              {section.title}
            </h2>
            <div className="space-y-4">
              {section.items.map(item => (
                <div key={item.key} className="flex items-center justify-between py-2">
                  <div>
                    <p id={`setting-label-${item.key}`} className="text-white/80 text-sm font-medium">{item.label}</p>
                    <p className="text-white/60 text-xs">{item.desc}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!settings[item.key]}
                    aria-labelledby={`setting-label-${item.key}`}
                    className={`toggle ${settings[item.key] ? 'active' : ''}`}
                    onClick={() => toggle(item.key)}
                  >
                    <div className="toggle-handle" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Notifications: the in-app pref plus per-device Web Push
            (see docs/push.md). Push state is capability-
            driven — PushControls decides what this browser/device can do
            via the tested pushUIState machine. */}
        <div className="glass-panel rounded-2xl p-6">
          <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
            <Icon name="bell" size={18} className="text-purple-400" />
            Notifications
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <p id="setting-label-notifications" className="text-white/80 text-sm font-medium">Enable Notifications</p>
                <p className="text-white/60 text-xs">Get notified about new episodes and completions</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={!!settings.notifications}
                aria-labelledby="setting-label-notifications"
                className={`toggle ${settings.notifications ? 'active' : ''}`}
                onClick={() => toggle('notifications')}
              >
                <div className="toggle-handle" />
              </button>
            </div>
            <PushControls onToast={onToast} />
          </div>
        </div>

        {/* Install-as-app (see docs/push.md).
            Which body renders is decided by installUIState: an installed app
            confirms itself; a captured browser prompt gets a one-tap button;
            iOS gets the Add-to-Home-Screen walkthrough it requires (and which
            push will require in Phase 2); everywhere else gets the browser-
            menu pointer, because our service worker deliberately has no fetch
            handler and Chromium may therefore never volunteer its prompt. */}
        <div className="glass-panel rounded-2xl p-6">
          <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
            <Icon name="download" size={18} className="text-purple-400" />
            App
          </h2>
          {appInstallState === 'installed' && (
            <div className="flex items-center gap-2 text-sm text-white/80">
              <Icon name="check" size={16} className="text-emerald-400" />
              Running as an installed app on this device.
            </div>
          )}
          {appInstallState === 'prompt' && (
            <div className="space-y-3">
              <p className="text-white/60 text-xs">
                Get Aurora as an app on this device — its own icon and a full-screen window.
              </p>
              <button
                type="button"
                onClick={handleInstall}
                className="rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 px-4 py-2 text-sm font-medium text-white/90 transition-colors"
              >
                Install Aurora
              </button>
            </div>
          )}
          {appInstallState === 'ios-guide' && (
            <div className="space-y-3">
              <p className="text-white/60 text-xs">
                Add Aurora to your Home Screen to use it as an app:
              </p>
              {/* No "in Safari": every iOS browser is WebKit and has a Share
                  menu with this entry — naming Safari would misdirect
                  Chrome-on-iOS users. */}
              <ol className="list-decimal list-inside space-y-1.5 text-sm text-white/80">
                <li>Tap the Share button</li>
                <li>Choose &ldquo;Add to Home Screen&rdquo;</li>
                <li>Open Aurora from your Home Screen</li>
              </ol>
            </div>
          )}
          {appInstallState === 'manual' && (
            <p className="text-white/60 text-sm">
              To use Aurora as an app, open your browser&rsquo;s menu and choose
              &ldquo;Install Aurora&rdquo; or &ldquo;Add to Home screen&rdquo;.
            </p>
          )}
        </div>

        {/* Language */}
        <div className="glass-panel rounded-2xl p-6">
          <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
            <Icon name="globe" size={18} className="text-purple-400" />
            Language
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm font-medium">Audio Language</p>
                <p className="text-white/40 text-xs">Preferred audio track</p>
              </div>
              <Select value={settings.audioLang} onValueChange={(value) => setSettings(p => ({ ...p, audioLang: value }))}>
                <SelectTrigger size="sm" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="ja">Japanese</SelectItem>
                  <SelectItem value="es">Spanish</SelectItem>
                  <SelectItem value="fr">French</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm font-medium">Subtitle Language</p>
                <p className="text-white/40 text-xs">Preferred subtitle track</p>
              </div>
              <Select
                value={settings.subtitleLang === '' ? 'none' : settings.subtitleLang}
                onValueChange={(value) => setSettings(p => ({ ...p, subtitleLang: value === 'none' ? '' : value }))}
              >
                <SelectTrigger size="sm" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="ja">Japanese</SelectItem>
                  <SelectItem value="es">Spanish</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Phase 5 — Quality preference. Drives pickFile in handlePlay
            (handlePlayContinue was removed 2028-05-28; see the tombstone
            comment in App near `handleRefreshMetadata`). Default 'auto' =
            prefer 1080p, fall back to whatever exists. */}
        <div className="glass-panel rounded-2xl p-6">
          <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
            <Icon name="play" size={18} className="text-purple-400" />
            Quality
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm font-medium">Preferred resolution</p>
                <p className="text-white/40 text-xs">When a title has multiple files, pick this resolution if available.</p>
              </div>
              <select
                aria-label="Preferred resolution"
                value={quality}
                onChange={e => {
                  const q = e.target.value as QualityChoice
                  applyPreferredQuality(q)
                  setQuality(q)
                }}
                className="text-sm py-2 px-3"
              >
                <option value="auto">Auto (1080p preferred)</option>
                <option value="1080p">1080p</option>
                <option value="4k">4K when available</option>
              </select>
            </div>
            {/* Bitrate ceiling — the remote-viewer knob. Above it the server
                transcodes onto a ladder capped at this rate instead of handing
                this browser a direct play or remux it cannot sustain. */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm font-medium">Streaming bitrate limit</p>
                <p className="text-white/40 text-xs">Set this on a slow connection. Files above the limit are transcoded down instead of buffering.</p>
              </div>
              <select
                aria-label="Streaming bitrate limit"
                value={String(maxBps)}
                onChange={e => {
                  const bps = Number(e.target.value)
                  applyMaxStreamBps(bps)
                  setMaxBps(bps)
                }}
                className="text-sm py-2 px-3"
              >
                {MAX_STREAM_BITRATE_OPTIONS.map(o => (
                  <option key={o.bps} value={String(o.bps)}>{o.label}</option>
                ))}
                {/* A stored value outside the preset list (only reachable by
                    editing localStorage) must still be SHOWN, or the select
                    would read "No limit" while every request carried it. */}
                {!MAX_STREAM_BITRATE_OPTIONS.some(o => o.bps === maxBps) && (
                  <option value={String(maxBps)}>{`Custom (${(maxBps / 1_000_000).toFixed(1)} Mbps)`}</option>
                )}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm font-medium">Preferred audio language</p>
                <p className="text-white/40 text-xs">Picks this language's track by default when the file has one. The in-player track menu still overrides it.</p>
              </div>
              <select
                aria-label="Preferred audio language"
                value={audioLang}
                onChange={e => {
                  const l = e.target.value as AudioLanguageChoice
                  applyPreferredAudioLanguage(l)
                  setAudioLang(l)
                }}
                className="text-sm py-2 px-3"
              >
                {AUDIO_LANGUAGE_OPTIONS.map(o => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Account — M10 Phase 1. Sign-out lives here; the old "Phase 3"
            profile-editing promise landed as the My Profile card below
            (social phase 1). Password change still pending. */}
        {(settingsUser || onLogout) && (
          <div className="glass-panel rounded-2xl p-6">
            <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
              <Icon name="user" size={18} className="text-purple-400" />
              Account
            </h2>
            <div className="space-y-4">
              {settingsUser && (
                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-white/80 text-sm font-medium">Signed in</p>
                    <p className="text-white/40 text-xs">{settingsUser.username} &middot; {settingsUser.role}</p>
                  </div>
                </div>
              )}
              {onLogout && (
                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-red-400 text-sm font-medium">Sign Out</p>
                    <p className="text-white/40 text-xs">End your session on this device</p>
                  </div>
                  <button
                    onClick={onLogout}
                    className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 text-sm transition-colors"
                  >
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* These three span both columns, each via a wrapper div that is the
            grid item (the two helper cards render their own glass panel inside).

            All three hold lists that grow — linked providers, profiles +
            watchlists, an achievements grid — so a half-width column would
            wrap every row. `contents` is deliberately NOT used to hoist the
            helpers' internals into the grid: they would then be laid out as
            individual grid items, splitting each card's header away from its
            list. */}
        <div className="md:col-span-2">
          {/* My Profile — member-visible identity (social phase 1): display
              name, bio, social handles, watch-history sharing. */}
          <MemberProfileCard onToast={onToast} onOpenMyProfile={onOpenMyProfile} />
        </div>

        <div className="md:col-span-2">
          {/* Connected accounts — multi-provider OAuth linking (carve-out D). */}
          <SignInMethodsCard activeProfile={activeProfile ?? null} onToast={onToast} />
        </div>

        <div className="md:col-span-2">
          <ProfilesAndWatchlistsCard actingProfile={activeProfile ?? null} onToast={onToast} onProfilesChanged={onProfilesChanged} />
        </div>

        {/* Gamification: XP card + achievements grid. */}
        <div className="md:col-span-2 mt-2">
          <h2 className="text-white font-display font-bold type-section mb-4">Your Progress</h2>
          <GamificationCard />
        </div>
      </div>
    </div>
  )
}
// My Profile card — the member-visible identity editor (social phase 1).
// Fetches its own data like ConnectedAccountsCard does: this card is the
// only consumer of /api/me/profile, so App doesn't own the state. The form
// doubles as the privacy control surface — share_watch_history is the
// opt-in for the profile page's Recently Watched strip, default off.
function MemberProfileCard({ onToast, onOpenMyProfile }: {
  onToast?: (message: string, type?: Toast['type']) => void
  onOpenMyProfile?: () => void
}) {
  const [loaded, setLoaded] = useState<MemberProfile | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    display_name: '',
    bio: '',
    social_x: '',
    social_instagram: '',
    social_facebook: '',
    social_snapchat: '',
    share_watch_history: false,
  })

  const syncForm = (p: MemberProfile) => setForm({
    display_name: p.display_name ?? '',
    bio: p.bio ?? '',
    social_x: p.social_x ?? '',
    social_instagram: p.social_instagram ?? '',
    social_facebook: p.social_facebook ?? '',
    social_snapchat: p.social_snapchat ?? '',
    share_watch_history: p.share_watch_history,
  })

  useEffect(() => {
    let cancelled = false
    getMyProfile()
      .then(p => { if (!cancelled) { setLoaded(p); syncForm(p) } })
      .catch(() => { if (!cancelled) setErr('Failed to load your profile') })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    // Reduce pasted URLs/@handles to bare handles before submit. null =
    // the paste can't honestly be reduced (unknown host, deep path,
    // page-route segment like profile.php) — refuse with a per-network
    // error instead of saving a wrong-but-shape-valid handle (PR-428
    // review). Length is checked here too so an over-long clean handle
    // reads "too long", not the server regex path's "not a URL".
    const handles: Partial<Record<(typeof SOCIAL_NETWORKS)[number]['key'], string>> = {}
    for (const n of SOCIAL_NETWORKS) {
      const norm = normalizeHandleInput(form[n.key], n)
      if (norm === null) {
        onToast?.(`${n.label}: couldn't read a username from that link — enter just the handle`, 'error')
        return
      }
      if (norm.length > n.maxLen) {
        onToast?.(`${n.label} handle is too long (max ${n.maxLen} characters)`, 'error')
        return
      }
      handles[n.key] = norm
    }
    setSaving(true)
    try {
      // share_watch_history is NOT in this patch — the toggle persists
      // itself on flip (it's a privacy control; deferred-save would let a
      // "turn it off" silently evaporate on nav-away).
      const p = await updateMyProfile({
        display_name: form.display_name,
        bio: form.bio,
        ...handles,
      })
      setLoaded(p)
      syncForm(p)
      onToast?.('Profile updated', 'success')
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Failed to update profile', 'error')
    } finally {
      setSaving(false)
    }
  }

  // The share toggle commits immediately (one-field atomic patch on the
  // server): every other control on this Settings page persists on
  // interaction, and a privacy switch is the last place a silent
  // discard-on-nav-away is acceptable. Optimistic flip, roll back on error.
  const toggleShare = async () => {
    const next = !form.share_watch_history
    setForm(f => ({ ...f, share_watch_history: next }))
    try {
      const p = await updateMyProfile({ share_watch_history: next })
      setLoaded(p)
      setForm(f => ({ ...f, share_watch_history: p.share_watch_history }))
      onToast?.(next ? 'Recently watched is now visible on your profile' : 'Watch history hidden from your profile', 'success')
    } catch (e) {
      setForm(f => ({ ...f, share_watch_history: !next }))
      onToast?.(e instanceof Error ? e.message : 'Failed to update sharing', 'error')
    }
  }

  const inputCls = 'w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-white placeholder:text-white/25'

  return (
    <div className="glass-panel rounded-2xl p-6">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h2 className="text-white text-lg font-semibold flex items-center gap-2">
          <Icon name="user" size={18} className="text-purple-400" />
          My Profile
        </h2>
        {onOpenMyProfile && (
          <button
            type="button"
            onClick={onOpenMyProfile}
            className="px-3 py-1.5 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-lg text-white/75 text-xs transition-colors"
          >
            View my profile
          </button>
        )}
      </div>
      <p className="text-white/40 text-xs mb-5">
        {loaded ? <>What other members see at /user/{loaded.username}.</> : 'What other members see on your profile page.'}
      </p>

      {err && <p className="text-red-300/85 text-sm">{err}</p>}
      {!err && !loaded && <p className="text-white/40 text-sm">Loading…</p>}
      {!err && loaded && (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-white/60 text-xs block mb-1.5">Display name</span>
              <input
                value={form.display_name}
                onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                placeholder={loaded.username}
                maxLength={80}
                className={inputCls}
              />
            </label>
          </div>
          <label className="block">
            <span className="text-white/60 text-xs block mb-1.5">Bio</span>
            <textarea
              value={form.bio}
              onChange={e => setForm(f => ({ ...f, bio: e.target.value }))}
              placeholder="A line or two about you"
              rows={3}
              maxLength={500}
              className={`${inputCls} resize-y`}
            />
          </label>
          <div className="grid sm:grid-cols-2 gap-4">
            {SOCIAL_NETWORKS.map(n => (
              <label key={n.key} className="block">
                <span className="text-white/60 text-xs block mb-1.5">{n.label}</span>
                <input
                  value={form[n.key]}
                  onChange={e => setForm(f => ({ ...f, [n.key]: e.target.value }))}
                  // Paste the profile URL or the @handle — save reduces both.
                  placeholder={`@${n.placeholder}`}
                  maxLength={120}
                  className={inputCls}
                />
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-white/80 text-sm font-medium">Share watch history</p>
              <p className="text-white/40 text-xs">Show your recently watched titles on your profile — applies immediately. Off by default; only your default profile's completed titles are ever shown.</p>
            </div>
            <button
              type="button"
              aria-pressed={form.share_watch_history}
              onClick={toggleShare}
              className={`px-4 py-2 rounded-lg text-sm border transition-colors ${
                form.share_watch_history
                  ? 'bg-purple-500/15 hover:bg-purple-500/25 border-purple-500/40 text-purple-200'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.08] text-white/60'
              }`}
            >
              {form.share_watch_history ? 'On' : 'Off'}
            </button>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-4 py-2 bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/40 rounded-lg text-purple-200 text-sm transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Connected accounts card — multi-provider OAuth linking (audit carve-out D).
// Lists linked providers (with Disconnect) and available providers (with
// Connect). Disconnect is disabled for the user's only sign-in method (no
// password AND a single linked identity) so they can't lock themselves out —
// mirrors the server's unlink lockout guard, which is the real enforcement.
// On mount it also consumes a ?linked=<provider> marker left by the link-mode
// callback redirect: shows a success toast and strips the param so a refresh
// doesn't re-toast.
// A restricted session cannot link or unlink sign-in methods (the server
// refuses: a new link would let it sign in again without the password,
// after its session ends), so it gets a note instead of the card.
export function SignInMethodsCard({ activeProfile, onToast }: {
  activeProfile: Profile | null
  onToast?: (message: string, type?: Toast['type']) => void
}) {
  return isRestrictedProfile(activeProfile)
    ? <p className="glass-panel rounded-2xl p-6 text-white/55 text-sm">Sign-in methods can only be managed from a profile without a content limit.</p>
    : <ConnectedAccountsCard onToast={onToast} />
}

function ConnectedAccountsCard({ onToast }: { onToast?: (message: string, type?: Toast['type']) => void }) {
  const [links, setLinks] = useState<OAuthLinksResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Per-provider in-flight flag so a button shows "…" and can't double-fire.
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setLinks(await listOAuthLinks())
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load')
    }
  }, [])
  // Fetch on mount. The ?linked=<provider> success toast + param strip are
  // handled once at the App level (so they fire regardless of the active
  // view); by the time this card mounts the param is already gone, and this
  // fetch reflects the freshly connected provider.
  useEffect(() => { void reload() }, [reload])

  const handleConnect = async (provider: string) => {
    setBusy(provider)
    try {
      // Navigates away to the provider on success, so we don't clear busy.
      await startOAuthLink(provider)
    } catch (e) {
      setBusy(null)
      onToast?.(e instanceof Error ? e.message : `Couldn't connect ${oauthProviderLabel(provider)}`, 'error')
    }
  }

  const handleDisconnect = async (provider: string) => {
    if (!window.confirm(`Disconnect your ${oauthProviderLabel(provider)} account from Aurora?`)) return
    setBusy(provider)
    try {
      await unlinkOAuth(provider)
      onToast?.(`Disconnected your ${oauthProviderLabel(provider)} account.`, 'info')
      await reload()
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : `Couldn't disconnect ${oauthProviderLabel(provider)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  // The only-sign-in-method case: no password and a single linked identity.
  // Each Disconnect is disabled (with a tooltip) in this state. The server
  // still enforces this with a 409, so the disable is a UX courtesy.
  const onlySignInMethod = !!links && !links.hasPassword && links.linked.length <= 1

  return (
    <div className="glass-panel rounded-2xl p-6">
      <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
        <Icon name="key" size={18} className="text-purple-400" />
        Connected Accounts
      </h2>
      <p className="text-white/40 text-xs mb-4">
        Link OAuth providers to sign in to Aurora without a password.
      </p>
      {err && <p className="text-red-300 text-sm mb-3">{err}</p>}
      {links === null && !err && <p className="text-white/40 text-sm">Loading…</p>}
      {links && (
        <div className="space-y-2">
          {links.linked.map(l => (
            <div key={l.provider} className="flex items-center justify-between py-2 border-b border-white/[0.03] last:border-0">
              <div>
                <p className="text-white/80 text-sm font-medium">{oauthProviderLabel(l.provider)}</p>
                <p className="text-white/40 text-xs">
                  Connected {new Date(l.linkedAt).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => void handleDisconnect(l.provider)}
                disabled={onlySignInMethod || busy === l.provider}
                title={onlySignInMethod ? 'This is your only way to sign in. Set a password or link another provider first.' : undefined}
                className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy === l.provider ? '…' : 'Disconnect'}
              </button>
            </div>
          ))}
          {links.available.map(p => (
            <div key={p} className="flex items-center justify-between py-2 border-b border-white/[0.03] last:border-0">
              <div>
                <p className="text-white/80 text-sm font-medium">{oauthProviderLabel(p)}</p>
                <p className="text-white/40 text-xs">Not connected</p>
              </div>
              <button
                onClick={() => void handleConnect(p)}
                disabled={busy === p}
                className="px-3 py-1.5 bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 rounded-lg text-purple-100 text-xs transition-colors disabled:opacity-40"
              >
                {busy === p ? '…' : 'Connect'}
              </button>
            </div>
          ))}
          {links.linked.length === 0 && links.available.length === 0 && (
            <p className="text-white/40 text-sm">No OAuth providers are enabled on this server.</p>
          )}
        </div>
      )}
    </div>
  )
}


// Profiles + Watchlists card. Lists profiles (CRUD-lite), expands
// into watchlists per profile (lazy-loaded), and manages each profile's PIN.
//
// A session acting as a restricted profile (one with a content limit) gets no
// management controls: the server refuses those writes from it anyway, and a
// kid's session should not be shown a way to try.
function ProfilesAndWatchlistsCard({ actingProfile, onToast, onProfilesChanged }: {
  actingProfile: Profile | null
  onToast?: (message: string, type?: Toast['type']) => void
  onProfilesChanged?: () => void
}) {
  const restricted = isRestrictedProfile(actingProfile)
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [activeProfileId, setActiveProfileId] = useState<number | null>(null)
  const [lists, setLists] = useState<Watchlist[]>([])
  const [listsLoading, setListsLoading] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [newListName, setNewListName] = useState('')
  const [newPin, setNewPin] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  // A PIN change or removal waiting for the current PIN (or the password).
  const [pinConfirm, setPinConfirm] = useState<{ profile: Profile; pin: string } | null>(null)

  const reloadProfiles = useCallback(async () => {
    try {
      const ps = await listProfiles()
      setProfiles(ps)
      if (!activeProfileId && ps.length > 0) {
        setActiveProfileId(ps.find(p => p.is_default)?.id ?? ps[0].id)
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'failed') }
  }, [activeProfileId])
  useEffect(() => { void reloadProfiles() }, [reloadProfiles])

  useEffect(() => { setNewPin('') }, [activeProfileId])

  const savePin = async (profile: Profile, pin: string, current?: ProfileUnlock) => {
    await setProfilePin(profile.id, pin, current)
    setNewPin('')
    await reloadProfiles()
    onProfilesChanged?.()
    onToast?.(pin ? `PIN set for ${profile.name}` : `PIN removed from ${profile.name}`, 'success')
  }
  const requestPinChange = async (profile: Profile, pin: string) => {
    // An existing PIN must be confirmed first; a first PIN needs nothing.
    if (profile.has_pin) { setPinConfirm({ profile, pin }); return }
    setPinBusy(true)
    try { await savePin(profile, pin) } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Could not set the PIN', 'error')
    } finally { setPinBusy(false) }
  }

  useEffect(() => {
    if (!activeProfileId) { setLists([]); return }
    let cancelled = false
    setListsLoading(true)
    listWatchlists(activeProfileId)
      .then(ls => { if (!cancelled) setLists(ls) })
      .catch(() => { if (!cancelled) setLists([]) })
      .finally(() => { if (!cancelled) setListsLoading(false) })
    return () => { cancelled = true }
  }, [activeProfileId])

  return (
    <div className="glass-panel rounded-2xl p-6">
      <h2 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
        <Icon name="user" size={18} className="text-purple-400" />
        Profiles &amp; Watchlists
      </h2>
      {err && <p className="text-red-300 text-sm mb-3">{err}</p>}
      {profiles === null && <p className="text-white/40 text-sm">Loading…</p>}
      {profiles && (
        <>
          <div className="flex items-center gap-2 flex-wrap mb-4">
            {profiles.map(p => (
              <button
                key={p.id}
                onClick={() => setActiveProfileId(p.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  activeProfileId === p.id
                    ? 'bg-purple-600/25 border-purple-500/40 text-purple-200'
                    : 'bg-white/[0.04] border-white/[0.06] text-white/70 hover:bg-white/[0.08]'
                }`}
              >
                {p.name}{p.is_default && ' ★'}{p.has_pin && <span className="sr-only"> (locked)</span>}
                {p.has_pin && <Icon name="lock" size={11} className="ml-1 inline-block align-[-1px] opacity-70" />}
              </button>
            ))}
            {!restricted && (
              <div className="flex items-center gap-1">
                <input value={newProfileName} onChange={e => setNewProfileName(e.target.value)} placeholder="New profile" className="px-2 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-xs text-white w-32" />
                <button
                  disabled={!newProfileName.trim()}
                  onClick={async () => { try { await createProfile(newProfileName.trim()); setNewProfileName(''); await reloadProfiles(); onProfilesChanged?.() } catch (e) { window.alert(e instanceof Error ? e.message : 'failed') } }}
                  className="px-2 py-1.5 bg-purple-600/40 hover:bg-purple-600/60 text-white text-xs rounded disabled:opacity-40"
                >+</button>
              </div>
            )}
          </div>
          {restricted ? (
            <p className="text-white/50 text-xs mb-4">
              {actingProfile?.name} has a content limit, so profiles and PINs can only be managed from a profile without one.
            </p>
          ) : (
            <ProfileLockPanel
              profile={profiles.find(p => p.id === activeProfileId) ?? null}
              profiles={profiles}
              newPin={newPin}
              setNewPin={setNewPin}
              busy={pinBusy}
              onSave={pin => { const p = profiles.find(x => x.id === activeProfileId); if (p) void requestPinChange(p, pin) }}
              onRemove={() => { const p = profiles.find(x => x.id === activeProfileId); if (p) setPinConfirm({ profile: p, pin: '' }) }}
            />
          )}
          {pinConfirm && (
            <ProfilePinDialog
              profile={pinConfirm.profile}
              title={pinConfirm.pin ? `Change ${pinConfirm.profile.name}’s PIN` : `Remove ${pinConfirm.profile.name}’s PIN`}
              description="Enter the current PIN, or the account password, to confirm."
              submitLabel={pinConfirm.pin ? 'Change PIN' : 'Remove PIN'}
              onSubmit={async unlock => {
                await savePin(pinConfirm.profile, pinConfirm.pin, unlock)
                setPinConfirm(null)
              }}
              onCancel={() => setPinConfirm(null)}
            />
          )}
          {activeProfileId && (
            <>
              <div className="flex items-center justify-between mb-2">
                <p className="text-white/60 text-xs uppercase tracking-wider">Watchlists</p>
                <div className="flex gap-1">
                  <input value={newListName} onChange={e => setNewListName(e.target.value)} placeholder="New list" className="px-2 py-1 bg-white/[0.04] border border-white/[0.06] rounded text-xs text-white w-32" />
                  <button
                    disabled={!newListName.trim()}
                    onClick={async () => { try { await createWatchlist(activeProfileId, newListName.trim()); setNewListName(''); setLists(await listWatchlists(activeProfileId)) } catch (e) { window.alert(e instanceof Error ? e.message : 'failed') } }}
                    className="px-2 py-1 bg-purple-600/40 hover:bg-purple-600/60 text-white text-xs rounded disabled:opacity-40"
                  >+</button>
                </div>
              </div>
              {listsLoading && <p className="text-white/40 text-xs">Loading…</p>}
              {!listsLoading && lists.length === 0 && <p className="text-white/40 text-xs">No watchlists yet.</p>}
              {lists.map(l => (
                <div key={l.id} className="flex items-center justify-between py-1.5 border-b border-white/[0.03] last:border-0">
                  <span className="text-white/80 text-sm">{l.name}</span>
                  <button onClick={async () => { if (!window.confirm(`Delete watchlist "${l.name}"?`)) return; try { await deleteWatchlist(activeProfileId, l.id); setLists(await listWatchlists(activeProfileId)) } catch (e) { window.alert(e instanceof Error ? e.message : 'failed') } }} className="text-red-400/70 hover:text-red-300 text-xs">delete</button>
                </div>
              ))}
            </>
          )}
        </>
      )}
      {/* Metadata attribution — TMDB's API terms require this notice
          wherever their data is used; TheTVDB asks for a linkback. */}
      <div className="mt-8 pt-4 border-t border-white/[0.06] space-y-1">
        <p className="text-white/40 text-xs">
          This product uses the TMDB API but is not endorsed or certified by{' '}
          <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className="text-white/60 hover:text-white/90 underline">TMDB</a>.
        </p>
        <p className="text-white/40 text-xs">
          TV metadata provided by{' '}
          <a href="https://thetvdb.com" target="_blank" rel="noreferrer" className="text-white/60 hover:text-white/90 underline">TheTVDB</a>.
        </p>
      </div>
    </div>
  )
}

// ProfileLockPanel sets, changes or removes the selected profile's PIN, and
// says plainly what an unlocked profile means: anyone on the account can
// switch to it, which undoes every restricted profile's limit if it has none.
function ProfileLockPanel({ profile, profiles, newPin, setNewPin, busy, onSave, onRemove }: {
  profile: Profile | null
  profiles: Profile[]
  newPin: string
  setNewPin: (pin: string) => void
  busy: boolean
  onSave: (pin: string) => void
  onRemove: () => void
}) {
  if (!profile) return null
  const openDoors = openDoorProfiles(profiles)
  const pinOk = /^[0-9]{4}$/.test(newPin)
  return (
    <div className="mb-5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <p id="profile-lock-label" className="text-white/80 text-sm font-medium">Profile lock for {profile.name}</p>
      <p className="text-white/55 text-xs mt-0.5">
        {profile.has_pin
          ? 'Switching to this profile needs its PIN or the account password.'
          : 'No PIN: anyone signed in to this account can switch to it.'}
        {' '}Setting or changing the PIN signs out the account’s other devices using this profile
        {profile.is_default ? ', and those that never picked one' : ''}; they need to sign in again.
      </p>
      {openDoors.length > 0 && (
        <p className="text-amber-200/80 text-xs mt-2">
          Profiles with a content limit can switch to {openDoors.map(p => p.name).join(', ')} without a PIN,
          and each may have a looser limit or none. Set a PIN on any that does to keep the limits in place.
        </p>
      )}
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={e => { e.preventDefault(); if (pinOk && !busy) onSave(newPin) }}
      >
        <label htmlFor="profile-new-pin" className="sr-only">{profile.has_pin ? 'New PIN' : 'PIN'}</label>
        <input
          id="profile-new-pin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          // Browsers ignore "off" on password fields and offer to save the
          // PIN as the site's password, or to overwrite the saved account
          // password with it. See ProfilePinDialog.
          autoComplete="new-password"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          maxLength={4}
          value={newPin}
          onChange={e => setNewPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
          placeholder={profile.has_pin ? 'New PIN' : '4 digits'}
          className="w-28 px-2 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-xs text-white tracking-[0.3em]"
        />
        <button
          type="submit"
          disabled={!pinOk || busy}
          className="px-3 py-1.5 bg-purple-600/40 hover:bg-purple-600/60 text-white text-xs rounded disabled:opacity-40"
        >
          {profile.has_pin ? 'Change PIN' : 'Set PIN'}
        </button>
        {profile.has_pin && (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="px-3 py-1.5 text-red-300/80 hover:text-red-200 text-xs rounded disabled:opacity-40"
          >
            Remove PIN
          </button>
        )}
      </form>
    </div>
  )
}

/* ─────────────────────── PUSH CONTROLS ─────────────────────── */

/** navigator.serviceWorker.ready never rejects — it waits forever when no
 *  registration exists (e.g. registration failed at boot). Every use here
 *  must therefore be bounded, or an edge-case device shows a spinner
 *  eternally and the enable flow hangs a tap. */
function readyWithTimeout(ms = 4000): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('service worker never became ready')), ms)),
  ])
}

/**
 * Per-device Web Push controls (see docs/push.md). What
 * renders is decided by the tested pushUIState machine over real
 * capability inputs; every path out of 'off'/'on' is a direct response to
 * a user tap — no automatic permission prompts, ever.
 */
function PushControls({ onToast }: { onToast?: (message: string, type?: Toast['type']) => void }) {
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

  const handleEnable = () => {
    if (busy) return
    setBusy(true)
    enablePush({
      requestPermission: () => Notification.requestPermission(),
      ready: () => readyWithTimeout(),
    }).then(result => {
      if (result === 'enabled') onToast?.('Push enabled — this device will get notifications even when Aurora is closed', 'success')
      else if (result === 'failed') onToast?.('Could not enable push on this device', 'error')
      // permission-denied / server-disabled: the refreshed card explains.
    }).catch(() => {
      // enablePush itself rejects when the config fetch or the SW-ready
      // wait fails (readyWithTimeout's 4s bound exists for exactly the
      // registration-failed device) — same user answer, no unhandled
      // rejection in the diagnostic buffer.
      onToast?.('Could not enable push on this device', 'error')
    }).finally(() => {
      setBusy(false)
      void refresh()
    })
  }

  const handleDisable = () => {
    if (busy) return
    setBusy(true)
    disablePush({ ready: () => readyWithTimeout() })
      .then(() => onToast?.('Push disabled on this device', 'info'))
      .catch(() => onToast?.('Could not disable push on this device', 'error'))
      .finally(() => {
        setBusy(false)
        void refresh()
      })
  }

  const handleTest = () => {
    if (busy) return
    setBusy(true)
    sendPushTest()
      .then(r => onToast?.(`Test sent to ${r.devices} device${r.devices === 1 ? '' : 's'}`, 'success'))
      .catch((e: unknown) => onToast?.(e instanceof Error ? e.message : 'Test failed', 'error'))
      .finally(() => setBusy(false))
  }

  if (state === 'loading') {
    return <p className="text-white/40 text-xs py-2">Checking push support…</p>
  }

  const explain: Partial<Record<typeof state, string>> = {
    'unsupported': 'This browser does not support push notifications.',
    'error': 'Push notifications are not available right now.',
    'server-disabled': 'Push is turned off by the server operator.',
    'ios-needs-install': 'On iPhone and iPad, push works from the installed app — add Aurora to your Home Screen first (see the App card).',
    'permission-denied': 'Notifications are blocked for Aurora in your browser settings — re-allow them there, then come back.',
  }
  if (state in explain) {
    return (
      <div className="flex items-center justify-between py-2">
        <div>
          <p className="text-white/80 text-sm font-medium">Push to this device</p>
          <p className="text-white/60 text-xs">{explain[state]}</p>
        </div>
      </div>
    )
  }

  const on = state === 'on'
  return (
    <>
      <div className="flex items-center justify-between py-2">
        <div>
          <p id="setting-label-push" className="text-white/80 text-sm font-medium">Push to this device</p>
          <p className="text-white/60 text-xs">
            Request updates, reels, and admin alerts — even when Aurora is closed
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="setting-label-push"
          disabled={busy}
          className={`toggle ${on ? 'active' : ''} ${busy ? 'opacity-50' : ''}`}
          onClick={on ? handleDisable : handleEnable}
        >
          <div className="toggle-handle" />
        </button>
      </div>
      {on && (
        <button
          type="button"
          disabled={busy}
          onClick={handleTest}
          className="rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 px-4 py-2 text-sm font-medium text-white/90 transition-colors disabled:opacity-50"
        >
          Send test notification
        </button>
      )}
    </>
  )
}
