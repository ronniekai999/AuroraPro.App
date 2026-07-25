// Human-readable OAuth provider labels, shared by the Connected
// Accounts UI (SettingsView's ConnectedAccountsCard) and App's OAuth
// link-mode return toast. Extracted from App.tsx (2026-06-17 app split,
// Phase 2.2) so the lazy SettingsView chunk and App can both reach it
// without one importing the other. Keys match the provider Name()
// values on the Go side (oauth_*.go). A provider not in this map falls
// back to a capitalized version of its key, so adding a new provider
// server-side degrades gracefully without a frontend change.

const OAUTH_PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  discord: 'Discord',
  twitch: 'Twitch',
  facebook: 'Facebook',
  twitter: 'X',
}

export function oauthProviderLabel(p: string): string {
  return OAUTH_PROVIDER_LABELS[p] ?? (p.charAt(0).toUpperCase() + p.slice(1))
}
// ── Sign-in tile list (Aurora Stage Phase 7a) ───────────────────────────────
//
// The five providers the sign-in screen can offer, each paired with the
// setup-status flag that gates it. Replaces five hand-written
// `{setupStatus?.oauth_X_enabled && <OAuthSignInButton provider="X" …/>}` blocks
// plus a five-term `||` in the section guard — two places that had to be edited
// together to add a provider.
//
// It lives HERE rather than in App.tsx because the labels were already in this
// file: a list in App would have been a second copy of OAUTH_PROVIDER_LABELS,
// which is the duplication this phase has been unwinding everywhere else. The
// label is derived, not restated.
//
// `provider` is the server's route segment (/api/auth/oauth/{provider}/start) —
// note it stays `twitter` while the label is `X`; renaming the key to match the
// rebrand would 404.

export type OAuthProvider = 'google' | 'discord' | 'twitch' | 'facebook' | 'twitter'

/** Keys on SetupStatus that gate each provider. */
export type OAuthEnabledFlag =
  | 'oauth_google_enabled'
  | 'oauth_discord_enabled'
  | 'oauth_twitch_enabled'
  | 'oauth_facebook_enabled'
  | 'oauth_twitter_enabled'

export interface OAuthSignInProvider {
  provider: OAuthProvider
  flag: OAuthEnabledFlag
  /** Short visible label. The accessible name is built from it at the call site. */
  label: string
}

const SIGN_IN_ORDER: readonly OAuthProvider[] = ['google', 'discord', 'twitch', 'facebook', 'twitter']

export const OAUTH_SIGN_IN_PROVIDERS: readonly OAuthSignInProvider[] = SIGN_IN_ORDER.map(provider => ({
  provider,
  flag: `oauth_${provider}_enabled` as OAuthEnabledFlag,
  label: oauthProviderLabel(provider),
}))
