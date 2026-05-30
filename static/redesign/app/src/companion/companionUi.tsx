// Aurora V2 — Companion shared UI primitives.
//
// Small, dependency-light bits shared across the companion surfaces so
// the brand mark + OAuth provider treatment + reduced-motion handling
// live in one place. Styling matches the mobile-companion mockup +
// Aurora's index.css tokens.

import { useEffect, useState } from 'react'

// useReducedMotion — reactive `prefers-reduced-motion: reduce`. Used to
// suppress the floating-reaction rise, mic pulse ring, and button hover
// scale per the quality bar. SSR-safe (defaults to false when matchMedia
// is unavailable) and updates live if the OS setting changes.
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return reduced
}

// AURORA_REDUCED_MOTION — a best-effort synchronous snapshot for the few
// spots that only need a one-time class decision and can't take a hook
// (e.g. a className built at module scope). Prefer useReducedMotion in
// components. Guarded for SSR / older browsers.
export const AURORA_REDUCED_MOTION: boolean =
  typeof window !== 'undefined' && !!window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

// CompanionBrand — the Aurora logo mark + (optional) wordmark, matching
// the mockup's glowing rounded-square mark.
export function CompanionBrand({
  size = 'md',
  withWord = false,
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg'
  withWord?: boolean
  className?: string
}) {
  const dim = size === 'lg' ? 'h-16 w-16 rounded-[18px]' : size === 'sm' ? 'h-8 w-8 rounded-[10px]' : 'h-10 w-10 rounded-xl'
  const icon = size === 'lg' ? 'h-9 w-9' : size === 'sm' ? 'h-5 w-5' : 'h-6 w-6'
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div
        className={`flex flex-shrink-0 items-center justify-center bg-gradient-to-br from-purple-500 to-purple-800 shadow-[0_0_28px_rgba(168,85,247,0.55)] ${dim}`}
      >
        <svg viewBox="0 0 24 24" fill="none" className={icon} aria-hidden="true">
          <path d="M12 3C7 3 3 8 3 14c2-3 5-4 9-4s7 1 9 4c0-6-4-11-9-11z" fill="#fff" opacity=".95" />
          <circle cx="12" cy="16" r="2.4" fill="#fff" />
        </svg>
      </div>
      {withWord && (
        <span className="font-display text-base font-bold uppercase tracking-[0.14em] text-white">
          Aurora<span className="text-[#D8B4FE]"> Pro</span>
        </span>
      )}
    </div>
  )
}

// ── OAuth providers — the 5 existing Aurora providers. Icons + brand
// colors mirror App.tsx's OAuthSignInButton so the companion sign-in
// reads as the same product. Kept here (not imported from App.tsx) so
// the companion tree stays decoupled from the giant App module.

export type CompanionOAuthProvider = 'google' | 'discord' | 'twitch' | 'facebook' | 'twitter'

export interface CompanionOAuthMeta {
  provider: CompanionOAuthProvider
  label: string
  // Tailwind classes for the button surface.
  className: string
  icon: React.ReactNode
}

export const COMPANION_OAUTH_PROVIDERS: Record<CompanionOAuthProvider, CompanionOAuthMeta> = {
  google: {
    provider: 'google',
    label: 'Google',
    className: 'bg-white hover:bg-white/95 text-gray-800',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
        <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
        <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
      </svg>
    ),
  },
  discord: {
    provider: 'discord',
    label: 'Discord',
    className: 'bg-[#5865F2] hover:bg-[#4752C4] text-white',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
      </svg>
    ),
  },
  twitch: {
    provider: 'twitch',
    label: 'Twitch',
    className: 'bg-[#9146FF] hover:bg-[#7c2fff] text-white',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
      </svg>
    ),
  },
  facebook: {
    provider: 'facebook',
    label: 'Facebook',
    className: 'bg-[#1877F2] hover:bg-[#1665D8] text-white',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
      </svg>
    ),
  },
  twitter: {
    provider: 'twitter',
    label: 'X',
    className: 'bg-black hover:bg-zinc-800 text-white border border-white/10',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
}
