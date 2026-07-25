// Settings view — user profile, connected accounts (OAuth), profiles +
// watchlists, appearance/content-tone dials. Extracted from App.tsx
// (2026-06-17 app split, Phase 2.2) as the first non-admin lazy view of
// real size. ConnectedAccountsCard + ProfilesAndWatchlistsCard are
// module-private helpers used only here, so they ride along; the OAuth
// provider-label helper they share with App's link-mode toast lives in
// @/lib/oauth (shared leaf). `onToast={addToast}` is App's stable toast
// callback, threaded in unchanged.

import { useState, useEffect, useRef, useCallback } from 'react'
import { Icon } from '@/components/Icon'
import { type Toast } from '@/components/Toast'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { oauthProviderLabel } from '@/lib/oauth'
import { ATTRIBUTED_FONTS, type FontChoice } from '@/lib/appearance'
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
  type User as ApiUser,
  type Profile,
  type OAuthLinksResponse,
  type Watchlist,
} from '@/lib/api'

/* ─────────────────────── SETTINGS VIEW ─────────────────────── */
interface SettingsViewProps {
  user?: ApiUser
  onLogout?: () => void
  onToast?: (message: string, type?: Toast['type']) => void
  activeProfile?: Profile | null
  onMaturityChange?: (pref: number) => void | Promise<void>
  onAvatarChange?: (avatarUrl: string) => void | Promise<void>
}
export default function SettingsView({ user: settingsUser, onLogout, onToast, activeProfile, onMaturityChange, onAvatarChange }: SettingsViewProps = {}) {
  // Phase E2c content-tone dial. Optimistic local override so the chip flips
  // instantly; reset when the active profile changes (server value wins again).
  const [localMaturity, setLocalMaturity] = useState<number | null>(null)
  useEffect(() => { setLocalMaturity(null) }, [activeProfile?.id])
  const currentMaturity = localMaturity ?? activeProfile?.maturity_pref ?? -1
  // Same optimistic pattern for the per-profile avatar picker.
  const [localAvatar, setLocalAvatar] = useState<string | null>(null)
  useEffect(() => { setLocalAvatar(null) }, [activeProfile?.id])
  const currentAvatar = localAvatar ?? activeProfile?.avatar_url ?? ''
  // Persist to localStorage under `aurora_prefs`. We capture the raw
  // parsed object in a ref and merge before each write so any keys
  // this component doesn't know about (e.g. legacy `volume`, `muted`)
  // round-trip untouched instead of being clobbered.
  //
  // The first useEffect write is skipped so just opening Settings
  // doesn't rewrite the stored object.
  const rawRef = useRef<Record<string, unknown>>({})
  const skipFirstWriteRef = useRef(true)
  const [settings, setSettings] = useState(() => {
    try {
      const raw = localStorage.getItem('aurora_prefs')
      if (raw) {
        // JSON.parse can return null/string/number if localStorage
        // was tampered with. Guard before property access.
        const parsedRaw: unknown = JSON.parse(raw)
        if (!parsedRaw || typeof parsedRaw !== 'object') {
          throw new Error('aurora_prefs is not an object')
        }
        const parsed = parsedRaw as Record<string, unknown>
        rawRef.current = parsed
        return {
          autoplay: parsed.autoplay !== false,
          hdr: parsed.hdr !== false,
          notifications: parsed.notifications !== false,
          hardwareDecoding: parsed.hardwareDecoding !== false,
          subtitleLang: (parsed.subtitleLang as string) ?? 'en',
          audioLang: (parsed.audioLang as string) ?? 'en',
        }
      }
    } catch { /* ignore */ }
    return {
      autoplay: true,
      hdr: true,
      notifications: true,
      hardwareDecoding: true,
      subtitleLang: 'en',
      audioLang: 'en',
    }
  })

  // Persist on every change. Merges over the raw object so unknown
  // V1 keys (volume, muted, etc.) round-trip unmodified.
  useEffect(() => {
    if (skipFirstWriteRef.current) {
      skipFirstWriteRef.current = false
      return
    }
    try {
      const merged = { ...rawRef.current, ...settings }
      localStorage.setItem('aurora_prefs', JSON.stringify(merged))
      rawRef.current = merged
    } catch { /* ignore */ }
  }, [settings])

  const toggle = (key: keyof typeof settings) => {
    setSettings(prev => ({ ...prev, [key]: typeof prev[key] === 'boolean' ? !prev[key] : prev[key] }))
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
    {
      title: 'Notifications',
      icon: 'bell',
      items: [
        { key: 'notifications' as const, label: 'Enable Notifications', desc: 'Get notified about new episodes and completions' },
      ]
    },
  ]

  return (
    <div className="animate-fade-in max-w-3xl">
      <div className="mb-8">
        <h1 className="text-white text-3xl font-bold font-display">Settings</h1>
        <p className="text-white/50 text-sm mt-1">Configure your preferences</p>
      </div>

      <div className="space-y-6">
        {/* Appearance — Glow Style picker. Writes
            aurora_prefs.glow_intensity and live-updates <html data-glow>
            so panels/cards reflow their border + halo immediately.
            Default ("aurora") is the unprefixed :root token set in
            index.css; only "subtle" and "heavy" set the attribute. */}
        <div className="glass-panel rounded-xl p-6">
          <h3 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
            <Icon name="eye" size={18} className="text-purple-400" />
            Appearance
          </h3>
          <div className="space-y-3">
            <div>
              <p className="text-white/80 text-sm font-medium">Glow Style</p>
              <p className="text-white/40 text-xs">Border and halo around panels, cards, and the hero.</p>
            </div>
            <div role="radiogroup" aria-label="Glow style" className="grid grid-cols-3 gap-3">
              {([
                { id: 'subtle', label: 'Subtle', desc: 'Faint white edge' },
                { id: 'aurora', label: 'Aurora', desc: 'White + purple (default)' },
                { id: 'heavy',  label: 'Heavy',  desc: 'Bright white + purple bloom' },
              ] as const).map(opt => {
                // Read via rawRef so an unrelated keys' update doesn't lose
                // this value. The `setSettings(s => ({...s}))` below forces
                // the chip to re-render after each click since rawRef
                // mutations are invisible to React.
                const stored = rawRef.current.glow_intensity
                const current = typeof stored === 'string' ? stored : 'aurora'
                const active = current === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      rawRef.current = { ...rawRef.current, glow_intensity: opt.id }
                      try { localStorage.setItem('aurora_prefs', JSON.stringify(rawRef.current)) } catch { /* ignore */ }
                      // "aurora" is the default — no attribute needed (and removing
                      // it keeps a clean DOM for users who never touched the setting).
                      if (opt.id === 'aurora') document.documentElement.removeAttribute('data-glow')
                      else document.documentElement.setAttribute('data-glow', opt.id)
                      // Force re-render so the active chip updates.
                      setSettings(s => ({ ...s }))
                    }}
                    className={`text-left p-3 rounded-lg border transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 ${
                      active
                        ? 'border-purple-400/60 bg-purple-500/10 shadow-[0_0_20px_rgba(168,85,247,0.25)]'
                        : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                    }`}
                  >
                    <p className={`text-sm font-medium ${active ? 'text-white' : 'text-white/80'}`}>{opt.label}</p>
                    <p className="text-white/40 text-xs mt-0.5">{opt.desc}</p>
                  </button>
                )
              })}
            </div>

            {/* Typeface — writes aurora_prefs.font_choice and live-updates
                <html data-font> so all display + body text reflows into the
                chosen system immediately (CSS vars --font-sans/--font-display
                in index.css). Default ("eclipse": Bricolage Grotesque + Inter)
                is the unprefixed :root token set; only the other three set the
                attribute. Each chip previews its own display face.

                2026-07-25 (Aurora Stage Phase 0) — default flipped 'nova' →
                'eclipse'. The option list, the fallback below, and the
                remove-attribute branch all moved together; keep them in sync
                with applyFont() in lib/appearance.ts and the pre-paint shim in
                main.tsx. (This radiogroup deliberately duplicates that logic
                rather than importing it — consolidating is Phase 7 work, when
                this card gets its Option B two-column treatment.) */}
            <div className="pt-1">
              <p className="text-white/80 text-sm font-medium">Typeface</p>
              <p className="text-white/40 text-xs">Display and body fonts used across the app.</p>
            </div>
            <div role="radiogroup" aria-label="Typeface" className="grid grid-cols-2 gap-3">
              {([
                { id: 'eclipse', label: 'Eclipse', desc: 'Editorial · default', font: "'Bricolage Grotesque', sans-serif" },
                { id: 'nova',    label: 'Nova',    desc: 'Futuristic',          font: "'Sora', sans-serif" },
                { id: 'halo',    label: 'Halo',    desc: 'Polished',            font: "'Outfit', sans-serif" },
                { id: 'current', label: 'Classic', desc: 'Original',            font: "'Space Grotesk', sans-serif" },
              ] as const).map(opt => {
                // Validate against the allowlist, not just `typeof string`:
                // an unrecognized value (tampered or legacy) otherwise left
                // EVERY chip unselected — aria-checked="false" across the
                // radiogroup — while appearance.ts and the pre-paint shim
                // both resolved it to the default. Three encodings, one
                // answer.
                const stored = rawRef.current.font_choice
                const current = ATTRIBUTED_FONTS.includes(stored as FontChoice) ? (stored as FontChoice) : 'eclipse'
                const active = current === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      rawRef.current = { ...rawRef.current, font_choice: opt.id }
                      try { localStorage.setItem('aurora_prefs', JSON.stringify(rawRef.current)) } catch { /* ignore */ }
                      // "eclipse" is the default — no attribute (matches the unprefixed
                      // :root tokens in index.css and keeps a clean DOM).
                      if (opt.id === 'eclipse') document.documentElement.removeAttribute('data-font')
                      else document.documentElement.setAttribute('data-font', opt.id)
                      // Force re-render so the active chip updates.
                      setSettings(s => ({ ...s }))
                    }}
                    className={`text-left p-3 rounded-lg border transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 ${
                      active
                        ? 'border-purple-400/60 bg-purple-500/10 shadow-[0_0_20px_rgba(168,85,247,0.25)]'
                        : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                    }`}
                  >
                    <p className={`text-base font-semibold ${active ? 'text-white' : 'text-white/80'}`} style={{ fontFamily: opt.font }}>{opt.label}</p>
                    <p className="text-white/40 text-xs mt-0.5">{opt.desc}</p>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Avatar — per-profile animated nebula. Optimistic localAvatar flips the
            selection instantly; onAvatarChange persists via PUT /api/profiles/:id
            and refreshes the profile list so the switcher + account menu update. */}
        {onAvatarChange && activeProfile && (
          <div className="glass-panel rounded-xl p-6">
            <h3 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
              <Icon name="user" size={18} className="text-purple-400" />
              Avatar
            </h3>
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
          <div className="glass-panel rounded-xl p-6">
            <h3 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
              <Icon name="sparkle" size={18} className="text-purple-400" />
              Content Tone
            </h3>
            <div className="space-y-3">
              <div>
                <p className="text-white/80 text-sm font-medium">Recommendation lean for {activeProfile.name}</p>
                <p className="text-white/40 text-xs">Nudges what surfaces first toward a maturity tier — it doesn't hide anything (that's the age limit). Applies on your next Home visit.</p>
              </div>
              <div role="radiogroup" aria-label="Content tone" className="grid grid-cols-2 gap-3">
                {([
                  // -1 is AUTO, not off: the recommender derives the lean from
                  // the profile's watched rating tiers (server-side, Phase E2c
                  // auto mode). Explicit picks (0/1/2) always override it.
                  { v: -1, label: 'Auto', desc: 'Follows what you watch (default)' },
                  { v: 0, label: 'Family', desc: 'Gentle · G–PG / TV-G' },
                  { v: 1, label: 'Teen', desc: 'PG-13 · TV-14' },
                  { v: 2, label: 'Mature', desc: 'Intense · R · TV-MA' },
                ] as const).map(opt => {
                  const active = currentMaturity === opt.v
                  return (
                    <button
                      key={opt.v}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        const prev = currentMaturity
                        setLocalMaturity(opt.v)
                        // Roll back the optimistic selection if the save rejects.
                        Promise.resolve(onMaturityChange(opt.v)).catch(() => setLocalMaturity(prev))
                      }}
                      className={`text-left p-3 rounded-lg border transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 ${
                        active
                          ? 'border-purple-400/60 bg-purple-500/10 shadow-[0_0_20px_rgba(168,85,247,0.25)]'
                          : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                      }`}
                    >
                      <p className={`text-sm font-medium ${active ? 'text-white' : 'text-white/80'}`}>{opt.label}</p>
                      <p className="text-white/40 text-xs mt-0.5">{opt.desc}</p>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {sections.map(section => (
          <div key={section.title} className="glass-panel rounded-xl p-6">
            <h3 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
              <Icon name={section.icon} size={18} className="text-purple-400" />
              {section.title}
            </h3>
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

        {/* Language */}
        <div className="glass-panel rounded-xl p-6">
          <h3 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
            <Icon name="globe" size={18} className="text-purple-400" />
            Language
          </h3>
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
        <div className="glass-panel rounded-xl p-6">
          <h3 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
            <Icon name="play" size={18} className="text-purple-400" />
            Quality
          </h3>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white/80 text-sm font-medium">Preferred resolution</p>
              <p className="text-white/40 text-xs">When a title has multiple files, pick this resolution if available.</p>
            </div>
            <select
              value={(rawRef.current.preferred_quality as string) || 'auto'}
              onChange={e => {
                rawRef.current = { ...rawRef.current, preferred_quality: e.target.value }
                try { localStorage.setItem('aurora_prefs', JSON.stringify(rawRef.current)) } catch { /* ignore */ }
                // Force a re-render so the select reflects.
                setSettings(s => ({ ...s }))
              }}
              className="text-sm py-2 px-3"
            >
              <option value="auto">Auto (1080p preferred)</option>
              <option value="1080p">1080p</option>
              <option value="4k">4K when available</option>
            </select>
          </div>
        </div>

        {/* Account — M10 Phase 1. Only logout is functional today.
            Profile editing + password change land in Phase 3. */}
        {(settingsUser || onLogout) && (
          <div className="glass-panel rounded-xl p-6">
            <h3 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
              <Icon name="user" size={18} className="text-purple-400" />
              Account
            </h3>
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

        {/* Connected accounts — multi-provider OAuth linking (carve-out D). */}
        <ConnectedAccountsCard onToast={onToast} />

        <ProfilesAndWatchlistsCard />

        {/* Gamification: XP card + achievements grid. */}
        <div className="mt-6">
          <h2 className="text-white text-xl font-semibold mb-4">Your Progress</h2>
          <GamificationCard />
        </div>
      </div>
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
    <div className="glass-panel rounded-xl p-6">
      <h3 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
        <Icon name="key" size={18} className="text-purple-400" />
        Connected Accounts
      </h3>
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
// into watchlists per profile (lazy-loaded).
function ProfilesAndWatchlistsCard() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [activeProfileId, setActiveProfileId] = useState<number | null>(null)
  const [lists, setLists] = useState<Watchlist[]>([])
  const [listsLoading, setListsLoading] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [newListName, setNewListName] = useState('')

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
    <div className="glass-panel rounded-xl p-6">
      <h3 className="text-white text-lg font-semibold mb-4 flex items-center gap-2">
        <Icon name="user" size={18} className="text-purple-400" />
        Profiles &amp; Watchlists
      </h3>
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
                {p.name}{p.is_default && ' ★'}
              </button>
            ))}
            <div className="flex items-center gap-1">
              <input value={newProfileName} onChange={e => setNewProfileName(e.target.value)} placeholder="New profile" className="px-2 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-xs text-white w-32" />
              <button
                disabled={!newProfileName.trim()}
                onClick={async () => { try { await createProfile(newProfileName.trim()); setNewProfileName(''); await reloadProfiles() } catch (e) { window.alert(e instanceof Error ? e.message : 'failed') } }}
                className="px-2 py-1.5 bg-purple-600/40 hover:bg-purple-600/60 text-white text-xs rounded disabled:opacity-40"
              >+</button>
            </div>
          </div>
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
