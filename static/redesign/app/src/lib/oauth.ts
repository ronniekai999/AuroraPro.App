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