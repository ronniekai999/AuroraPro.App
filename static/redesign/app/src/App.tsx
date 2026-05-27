import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router'
import {
  fetchMe,
  getAccessToken,
  apiFetchResponse,
  getStoredUser,
  getMedia,
  getMediaFiles,
  getSeasons,
  getEpisodes,
  listMedia,
  listRecent,
  listMediaWithTotal,
  listGenres,
  getHeroPool,
  getDiscoverRails,
  getAnchorRails,
  searchForMatch,
  manualMatch,
  listContinueWatching,
  listRequests,
  getBugReportConfig,
  type BugReportConfig,
  mapContinueToMedia,
  tmdbPosterURL,
  searchMedia,
  searchTmdb,
  createRequest,
  createQuickParty,
  login as apiLogin,
  logout as apiLogout,
  posterURL,
  backdropURL,
  getAdminDashboard,
  listAdminActivity,
  listAdminLogs,
  listAdminUsers,
  listLibraries,
  createLibrary,
  deleteLibrary,
  scanLibrary,
  listAdminSessions,
  deleteStreamSession,
  diagnoseSession,
  type SessionDiagnostic,
  listFlaggedItems,
  getAIRematchStatus,
  startAIRematch,
  type AIRematchJobStatus,
  getAdminLLM,
  updateAdminLLM,
  getAdminOAuth,
  updateAdminOAuth,
  listProfiles,
  createProfile,
  listWatchlists,
  createWatchlist,
  deleteWatchlist,
  addToWatchlist,
  refreshMetadata,
  markWatched,
  clearProgress,
  deleteRequest,
  deleteUser,
  listRooms,
  createRoom,
  deleteRoom,
  createInvite,
  purgeImageCache,
  testARRConnection,
  getAllSettings,
  updateSettings,
  getSetupStatus,
  register,
  type ActivityEntry,
  type AdminUser,
  type AudioTrack,
  type SubtitleTrack,
  type ContinueWatchingItem,
  type HeroPick,
  type HeroPersonalization,
  type Library,
  type LLMSettings,
  type MatchSearchResult,
  type LogEntry,
  type MediaDetail,
  type MediaFile,
  type MediaRequest,
  type OAuthSettings,
  type Profile,
  type Room,
  type ServerMediaItem,
  type ServerSettingsMap,
  type ServerStats,
  type SetupStatus,
  type TmdbSearchResult,
  type ActiveStreamRow,
  type Watchlist,
  type Episode as ApiEpisode,
  type User as ApiUser,
  // Auto-updater (Phase 8) — surfaces the systemd-driven updater
  // status + manual trigger in the admin dashboard.
  getUpdateStatus,
  triggerUpdate,
  type UpdateStatus,
  type UpdateState,
} from '@/lib/api'
import { VideoPlayer, pickFile, type PlayTarget } from '@/components/VideoPlayer'
import { PartyPanel } from '@/components/PartyPanel'
import { PartyHubModal } from '@/components/PartyHubModal'
import { MediaCardCinema } from '@/components/MediaCardCinema'
import { BugReportButton } from '@/components/BugReportButton'
import { ReactionOverlay } from '@/components/ReactionOverlay'
import { ContextMenu, type MediaContextItem } from '@/components/ContextMenu'
import { ScanProgressBar } from '@/components/ScanProgressBar'
import { SearchPalette } from '@/components/SearchPalette'
// Phase 6 — Collections, Calendar, Gamification UI components.
import { CollectionsModal } from '@/components/CollectionsModal'
import { CollectionsView } from '@/components/CollectionsView'
import { CalendarView } from '@/components/CalendarView'
import { GamificationCard } from '@/components/GamificationCard'
// Phase 6 — Dynamic theming: extract a dominant color from a poster
// to tint the detail view's accent buttons.
import { extractPalette, DEFAULT_PALETTE } from '@/lib/themeFromImage'
import { useParty } from '@/hooks/useParty'

/* ─────────────────────── TYPES ─────────────────────── */
interface Media {
  id: number
  title: string
  year: number
  rating: number
  duration: string
  genre: string
  type: 'movie' | 'show' | 'anime'
  poster: string
  backdrop?: string
  description: string
  progress?: number
  episodes?: Episode[]
  cast?: string[]
  tags?: string[]
  // LLM-generated per-pick reason. Populated for items that came from
  // a personalized endpoint (Hero rerank, Discover rails). MediaCard
  // surfaces this as a hover tooltip on cards in those rails.
  reason?: string
}

interface Episode {
  id: number
  title: string
  number: number
  duration: string
  description: string
  thumb: string
}

interface Toast {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
}

/* ─────────────────────── MOCK DATA ─────────────────────── */

// Mock rail arrays (CONTINUE_WATCHING, NEW_ARRIVALS, etc.) were
// removed. Their numeric IDs collided with real Aurora media IDs and
// could stream the wrong item if a Play click hit the mock card
// during the home-load window. MOVIES/SHOWS/ANIME arrays remain only
// because Search's deleted-mock-fallback path references them.

/* ─────────────────────── ICONS ─────────────────────── */
function Icon({ name, size = 20, className = '' }: { name: string; size?: number; className?: string }) {
  const icons: Record<string, React.ReactNode> = {
    home: <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z M9 22V12h6v10" />,
    movie: <><rect x="2" y="2" width="20" height="20" rx="2.18" /><path d="M7 2v20M17 2v20M2 12h20" /></>,
    tv: <><rect x="2" y="7" width="20" height="15" rx="2" /><polyline points="17 2 12 7 7 2" /></>,
    library: <><path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" /></>,
    bell: <><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></>,
    server: <><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></>,
    search: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>,
    play: <polygon points="5 3 19 12 5 21 5 3" />,
    pause: <><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
    check: <polyline points="20 6 9 17 4 12" />,
    x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
    star: <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
    chevronRight: <polyline points="9 18 15 12 9 6" />,
    chevronLeft: <polyline points="15 18 9 12 15 6" />,
    arrowLeft: <><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>,
    moreVertical: <><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></>,
    eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>,
    refresh: <><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></>,
    film: <><rect x="2" y="2" width="20" height="20" rx="2.18" /><path d="M7 2v20M17 2v20M2 12h20" /></>,
    hardDrive: <><line x1="22" y1="12" x2="2" y2="12" /><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" /><line x1="6" y1="16" x2="6.01" y2="16" /><line x1="10" y1="16" x2="10.01" y2="16" /></>,
    zap: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
    activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    user: <><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
    users: <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></>,
    clock: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
    info: <><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></>,
    maximize: <><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" /></>,
    menu: <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>,
    volume: <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" /></>,
    volumeX: <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>,
    skipForward: <><polygon points="5 4 15 12 5 20 5 4" /><line x1="19" y1="5" x2="19" y2="19" /></>,
    skipBack: <><polygon points="19 20 9 12 19 4 19 20" /><line x1="5" y1="19" x2="5" y2="5" /></>,
    download: <><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
    send: <><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>,
    trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></>,
    edit: <><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></>,
    folder: <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />,
    key: <><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></>,
    monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></>,
    cpu: <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></>,
    barChart: <><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></>,
    pieChart: <><path d="M21.21 15.89A10 10 0 118 2.83" /><path d="M22 12A10 10 0 0012 2v10z" /></>,
    log: <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></>,
    database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></>,
    wrench: <><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" /></>,
    upload: <><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>,
    globe: <><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" /></>,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></>,
    unlock: <><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 019.9-1" /></>,
    heart: <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />,
    list: <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></>,
    fileText: <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" /></>,
    rss: <><path d="M4 11a9 9 0 019 9" /><path d="M4 4a16 16 0 0116 16" /><circle cx="5" cy="19" r="1" /></>,
    mic: <><path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></>,
    circle: <circle cx="12" cy="12" r="10" />,
    // Feather's "log-out" shape — used by the avatar dropdown for
    // the Sign Out action. The hyphenated `log-out` is the canonical
    // Feather name; keeping it here lets call sites use the standard
    // name verbatim.
    'log-out': <><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
    // Diamond/sparkle for the AI-matched gem badge on .media-card-cinema.
    // Solid fill so it reads as a jewel against the gradient bg.
    sparkle: <path d="M12 2L13.5 8.5 20 10 13.5 11.5 12 18 10.5 11.5 4 10 10.5 8.5z" fill="currentColor" />,
    // Generic compass/planet for the rail-container header. Used as a
    // default decorative glyph next to the rail title; rails with their
    // own dedicated icon (e.g. Continue Watching) can pass a different
    // name via the new MediaRail `icon` prop.
    compass: <><circle cx="12" cy="12" r="10" /><polygon points="16 8 14 14 8 16 10 10 16 8" fill="currentColor" stroke="none" /></>,
  }
  return (
    // 2026-05-27 (deep-debug Bug 19) — aria-hidden because icons are
    // almost always decorative; the surrounding button/link carries the
    // accessible name via aria-label or visible text. Without this,
    // screen readers announce "graphic" alongside the button label
    // ("Add to library, graphic"). The very rare exception (an icon-only
    // control with no aria-label or text companion) is an a11y bug at
    // the call site, not something this component should paper over.
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {icons[name] || null}
    </svg>
  )
}

/* ─────────────────────── HERO SECTION ─────────────────────── */
// When `hero` is absent we render a NEUTRAL placeholder rather than
// falling back to a mock entry — the mock id collided with a real
// database id and Play would stream the wrong title.
function HeroSection({ hero: heroProp, onPlay, onInfo, reason, onRefreshHero, onPauseChange, personalization, resume }: {
  hero?: Media
  onPlay: (m: Media) => void
  onInfo: (m: Media) => void
  // Phase 5.3 — personalization reason ("Because you finished
  // Severance"). Rendered above the title. Empty/undefined hides.
  reason?: string
  // Optional Refresh suggestions button (admin or end-user with
  // LLM enabled). Forces a fresh /api/me/hero pull.
  onRefreshHero?: () => void
  // Pause auto-rotation while user hovers.
  onPauseChange?: (paused: boolean) => void
  // Personalization status — drives the cold-start hint that replaces
  // the empty reason line when we're below the watch-history threshold.
  // null = unknown / not yet loaded.
  personalization?: HeroPersonalization | null
  // 2026-05-27 — Continue Watching resume bundle for the current hero.
  // When set, the primary CTA reads "Resume at MM:SS" (or "Resume S2E5
  // · MM:SS" for shows) and calls `resume.onPlay(resume.item)` instead
  // of the fresh `onPlay(hero)`. Mirrors the DetailView pattern. The
  // discriminated `{ item, onPlay }` bundle makes partial wiring a
  // type error (same rationale as DetailViewProps.resume).
  resume?: {
    item: ContinueWatchingItem
    onPlay: (c: ContinueWatchingItem) => void
  }
}) {
  // useState MUST be called before any conditional return so hook
  // ordering stays stable across renders (Rules of Hooks).
  const [mousePos, setMousePos] = useState({ x: 0.5, y: 0.5 })
  if (!heroProp) {
    return (
      <section className="relative w-full h-[55vh] min-h-[420px] max-h-[600px] rounded-2xl overflow-hidden mb-8 bg-gradient-to-br from-purple-950/40 via-[#0a0a0f] to-[#050505] border border-white/[0.04] flex items-center justify-center">
        <div className="text-center px-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-purple-600/20 border border-purple-500/30 mb-4">
            <svg width="28" height="28" viewBox="0 0 36 36" fill="none">
              <circle cx="18" cy="18" r="16" stroke="#A855F7" strokeWidth="2.5" opacity="0.5" />
              <path d="M14 11L26 18L14 25Z" fill="#A855F7" />
            </svg>
          </div>
          <h2 className="text-white/70 text-2xl font-bold font-display tracking-wide">Welcome to Aurora</h2>
          <p className="text-white/40 text-sm mt-2">Loading your featured content…</p>
        </div>
      </section>
    )
  }
  const hero = heroProp
  // Backdrop → poster → gradient fallback chain (some TMDB rows have
  // no backdrop image).
  const bgImage = hero.backdrop || hero.poster || ''
  // Subtle parallax: backdrop drifts ~2% with the mouse so the hero
  // doesn't feel like a static still. The transition smooths cursor
  // jitter into a slow drift instead of jumpy 1:1 tracking.
  const parallaxX = (mousePos.x - 0.5) * 2
  const parallaxY = (mousePos.y - 0.5) * 2

  return (
    <section
      // Bleed to viewport edges: HomeView wraps content in p-8, so
      // -mx-8 -mt-8 cancels that padding for the hero only.
      className="relative w-full h-[60vh] min-h-[480px] max-h-[680px] overflow-hidden -mx-8 -mt-8 mb-10 bg-[#050505]"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        setMousePos({
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height
        })
      }}
      // Pause rotation over the entire hero. Do NOT put key={hero.id}
      // on this <section>: a remount-based crossfade breaks pause-on-
      // hover because browsers don't reliably synthesize mouseenter
      // on element replacement. Key the <img> instead.
      onMouseEnter={() => onPauseChange?.(true)}
      onMouseLeave={() => onPauseChange?.(false)}
    >
      {/* Brand-gradient fallback base layer. The positioned gradient
          stack above only covers part of the hero; this paints the
          violet→ink gradient under everything so a missing/errored
          backdrop still feels on-brand. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-br from-purple-950/40 via-[#0a0a0f] to-[#050505]"
      />
      {/* Backdrop image. Key on the IMG (not the section) so the
          image element remounts on rotation — drives the fade-in
          animation per-tick — without unmounting the parent that
          owns the hover handlers and mousePos state. */}
      {bgImage ? (
        <img
          key={bgImage}
          src={bgImage}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 ease-out animate-fade-in"
          style={{
            transform: `scale(1.05) translate(${parallaxX}%, ${parallaxY}%)`,
          }}
          loading="eager"
          decoding="async"
          onError={(e) => {
            // 404 happens when the server hasn't mirrored the TMDB
            // image yet. Hide the broken-image icon; the gradient
            // layer below takes over.
            const img = e.currentTarget
            img.style.display = 'none'
          }}
        />
      ) : null}

      {/* Phase 5.3 final QA — gradient stack rebuilt for a seamless
          "futuristic" feel. Three layers, each with a job:
          1. Bottom fade — covers the lower two-thirds of the hero,
             ramping from solid #050505 at the bottom to transparent
             at the top of the fade. The bottom matches the page
             background EXACTLY (#050505) so there's no visible seam
             where the hero ends and the rails begin.
          2. Left fade — a softer, more gradual sweep so the
             subtitle text reads cleanly without a hard "the
             gradient starts here" line. Doesn't go fully solid at
             the left edge — keeps a hint of the image visible.
          3. Aurora-violet glow — subtle radial wash at the focal
             point, mix-blend-screen so it tints the image rather
             than overlaying it. Adds the brand's purple mood
             without dominating the artwork. */}
      <div className="absolute bottom-0 left-0 right-0 h-2/3 bg-gradient-to-t from-[#050505] via-[#050505]/95 to-transparent pointer-events-none" />
      <div className="absolute top-0 bottom-0 left-0 w-2/3 bg-gradient-to-r from-[#050505]/95 via-[#050505]/45 to-transparent pointer-events-none" />
      <div
        className="absolute inset-0 pointer-events-none mix-blend-screen opacity-30"
        style={{
          background: 'radial-gradient(ellipse 60% 70% at 20% 60%, rgba(168, 85, 247, 0.35), transparent 65%)',
        }}
      />

      {/* Subtitle */}
      <div className="absolute bottom-8 left-8 right-8 z-20 flex items-end justify-between gap-4">
        <div className="max-w-2xl">
          <div className="flex items-center gap-3 mb-3">
            <span className="badge-glass bg-purple-500/10 text-purple-300 border border-purple-500/20">
              <Icon name="star" size={12} /> {reason ? 'Recommended' : 'Featured'}
            </span>
            <span className="text-white/60 text-sm">
              {hero.genre}{hero.genre && hero.year ? ' • ' : ''}{hero.year || ''}
            </span>
          </div>
          {/* Phase 5.3 — personalization reason ("Because you watched X").
              When the reason is empty AND we're in cold-start mode, show
              a hint about the watch-history threshold instead — same
              visual slot, but explanatory copy that tells the user why
              the picks aren't personalized yet. */}
          {reason ? (
            <p className="text-purple-200/80 text-xs italic mb-2 max-w-md">{reason}</p>
          ) : personalization?.coldStart ? (
            <p className="text-purple-200/70 text-xs italic mb-2 max-w-md">
              Watch {Math.max(0, personalization.threshold - personalization.historyCount)} more {personalization.threshold - personalization.historyCount === 1 ? 'title' : 'titles'} to unlock personalized picks &amp; Discover rails ({personalization.historyCount}/{personalization.threshold} so far).
            </p>
          ) : null}
          <h2 className="text-white text-4xl md:text-5xl font-bold font-display mb-3 drop-shadow-2xl">{hero.title}</h2>
          {hero.description && (
            <p className="text-white/70 text-sm md:text-base max-w-xl mb-4 line-clamp-2 drop-shadow-lg">{hero.description}</p>
          )}
          <div className="flex items-center gap-3">
            {/* 2026-05-27 — Resume-aware primary CTA. When the hero
                has a CW match, click resumes at the saved position via
                resume.onPlay (which threads through to App's
                handlePlayContinue). Otherwise the classic Play button
                starts fresh via onPlay(hero). The DetailView's "From
                start" affordance still works because handlePlay itself
                stays unmodified — only the Hero's call site decides
                between fresh and resume. Same discriminated-bundle
                pattern as DetailViewProps.resume.

                Deep-debug H1 — stale-closure guard: the click handler
                checks `resume.item.media_item_id === hero.id` before
                dispatching so a mid-flight hero rotation between the
                user's hover and click doesn't end up resuming the
                NEW hero with the OLD CW record. If the identities
                no longer match, fall through to the fresh-play path
                for whatever's currently visible.

                Deep-debug M5 — sub-second guard: a 5s threshold on
                position_ms hides "Resume at 0:00" labels for users
                who opened-then-immediately-closed a title. The
                server's `position_ms > 0` filter alone wasn't enough
                because brief opens save ~100-2000ms of progress
                that's effectively "fresh." */}
            {resume && isResumable(resume.item) ? (
              <button
                onClick={() => {
                  if (resume.item.media_item_id !== hero.id) {
                    onPlay(hero) // hero rotated mid-click; play fresh instead
                    return
                  }
                  resume.onPlay(resume.item)
                }}
                // Deep-debug M4 — visual differentiator: indigo tint
                // (vs purple Play) + a clock icon prefix so users
                // scanning the Hero can tell at a glance that this
                // button resumes rather than restarts. Same shape
                // and glow weight to keep it readable as the primary
                // CTA.
                className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full font-medium transition-all duration-200 hover:scale-105 glow-purple"
                title={`Resume from your last position (${formatResumeTime(resume.item.position_ms)})`}
                aria-label={formatResumeAriaLabel(resume.item)}
              >
                <Icon name="clock" size={16} /> {formatResumeLabel(resume.item)}
              </button>
            ) : (
              <button
                onClick={() => onPlay(hero)}
                className="flex items-center gap-2 px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-full font-medium transition-all duration-200 hover:scale-105 glow-purple"
              >
                <Icon name="play" size={18} /> Play
              </button>
            )}
            <button
              onClick={() => onInfo(hero)}
              className="flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/15 backdrop-blur-md text-white rounded-full font-medium transition-all duration-200 border border-white/10 hover:border-white/20"
            >
              <Icon name="info" size={18} /> More Info
            </button>
          </div>
        </div>
        {/* Refresh-suggestions button: rerolls the personalized pool.
            In cold-start mode the reroll is deterministic (popular-
            unwatched, no LLM input), so we explain that in the tooltip
            instead of letting the user think it's broken. */}
        {onRefreshHero && (
          <button
            onClick={onRefreshHero}
            title={personalization?.coldStart
              ? `Refresh — picks won't change in cold-start (${personalization.historyCount}/${personalization.threshold} titles watched). Watch a few more to unlock personalized rerolls.`
              : 'Refresh suggestions'}
            className="p-2 rounded-full bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.06] text-white/70 hover:text-white transition-colors"
          >
            <Icon name="refresh" size={16} />
          </button>
        )}
      </div>
    </section>
  )
}

/* ─────────────────────── MEDIA RAIL ───────────────────────
 * 2026-05-27 — Aurora Cinema Card redesign.
 *
 * The rail is now wrapped in a glassy .rail-container with a decorative
 * header (icon + title + divider line + See-All), and each card uses the
 * new <MediaCardCinema> component (extracted 2028-05-28 so grid views
 * can share the design too). Landscape aspect is preserved for callers
 * that pass aspect='landscape' (e.g. Continue Watching cards). */
// onPlay is still accepted for backward compatibility with callers
// (HomeView etc.) but the new cinema card design no longer renders a
// hover-only Play CTA — clicking the card opens detail where Play
// is the primary CTA. Keeping the prop in the type avoids touching
// every call site; ignoring it via destructure-rest avoids the
// unused-var lint.
function MediaRail({ title, items, onSelect, aspect = 'poster', onCardContext, libraryIds, onToggleLib, onSeeAll, icon = 'compass', resolveResume }: {
  title: string
  items: Media[]
  onSelect: (m: Media) => void
  onPlay?: (m: Media) => void
  aspect?: 'poster' | 'landscape'
  // 2026-05-27 — Per-card resume resolver. Caller passes a function
  // that returns a click handler when the item has a Continue
  // Watching match worth resuming (caller decides — typically only
  // wired for the Continue Watching rail so partial-watches on
  // other rails don't sprout resume pills). MediaRail invokes this
  // per-card and forwards the result to MediaCardCinema's onResume.
  resolveResume?: (m: Media) => (() => void) | undefined
  // Phase 5.2 parity — right-click on a card opens the context
  // menu (Mark Watched / Clear Progress / Add to Watchlist /
  // Refresh Metadata for admins).
  onCardContext?: (e: React.MouseEvent, m: Media) => void
  // My Library — set of IDs currently saved by the user. When passed
  // with onToggleLib, each card renders a top-left + button (purple ✓
  // when already in the library). Optional so existing callers that
  // don't care about library state stay unchanged.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // QA 2026-05-25 — "See All" was a non-functional button (no onClick)
  // that the QA report flagged as misleading because clicking it did
  // nothing (and felt like a scroll glitch since the rail itself
  // scrolls horizontally when you drag). Now: optional callback;
  // when supplied the button is shown and clickable, when not the
  // button is hidden entirely. AI-curated rails (no dedicated page
  // for them) skip it; "Top Rated Movies" etc. wire it to navigate
  // to the right browse view with the matching sort.
  onSeeAll?: () => void
  // Optional Icon name for the decorative glyph next to the rail
  // title. Defaults to 'compass' for the generic case; specific
  // rails can pass their own (e.g. 'clock' for Continue Watching,
  // 'sparkle' for AI-curated Discover rails).
  icon?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  return (
    <section className="rail-container">
      <div className="rail-header">
        <span className="rail-icon"><Icon name={icon} size={16} /></span>
        <h2 className="rail-title">{title}</h2>
        <span className="rail-spacer" aria-hidden="true" />
        {onSeeAll && (
          <button onClick={onSeeAll} className="rail-see-all">
            See All <Icon name="chevronRight" size={14} />
          </button>
        )}
      </div>
      <div ref={scrollRef} className="rail-scroll scrollbar-hide">
        {items.map((item) => (
          <MediaCardCinema
            key={item.id}
            item={item}
            onSelect={() => onSelect(item)}
            onCardContext={onCardContext ? (e) => onCardContext(e, item) : undefined}
            libraryIds={libraryIds}
            onToggleLib={onToggleLib ? () => onToggleLib(item) : undefined}
            className={aspect === 'poster' ? 'w-[180px]' : 'w-[320px]'}
            aspect={aspect}
            onResume={resolveResume?.(item)}
          />
        ))}
      </div>
    </section>
  )
}

/* ─────────────────────── AUTH VIEW ─────────────────────── */
// Maps server-side auth-failure messages to a small whitelist of
// user-safe strings. Whitelist (not blacklist) so that an endpoint
// which accidentally leaks stack-trace / schema detail won't surface
// it through this UI.
function filterAuthError(msg: string): string {
  const lower = msg.toLowerCase()
  const knownPatterns: Array<{ match: string; safe: string }> = [
    { match: 'invalid credentials', safe: 'Invalid username or password.' },
    { match: 'rate limit', safe: 'Too many attempts — please wait a moment and try again.' },
    { match: 'rate-limited', safe: 'Too many attempts — please wait a moment and try again.' },
    { match: 'too many requests', safe: 'Too many attempts — please wait a moment and try again.' },
    { match: 'invite', safe: 'Invite code required or invalid.' },
    { match: 'already exists', safe: 'That username or email is already in use.' },
    { match: 'username', safe: 'Username is invalid or unavailable.' },
    { match: 'email', safe: 'Email address is invalid or unavailable.' },
    { match: 'password', safe: 'Password does not meet requirements.' },
    { match: 'unauthorized', safe: 'Authentication required.' },
    { match: 'forbidden', safe: 'You do not have permission to do that.' },
    { match: 'network', safe: 'Network error — check your connection and try again.' },
    { match: 'failed to fetch', safe: 'Network error — check your connection and try again.' },
  ]
  for (const p of knownPatterns) {
    if (lower.includes(p.match)) return p.safe
  }
  return 'Login failed. Please try again.'
}

// AuthView — login + registration. Registration requires an invite
// code in most deployments; the setup-status probe below relaxes that
// for a fresh install.
function AuthView({ onLogin }: { onLogin: (user: ApiUser) => void }) {
  const [isRegister, setIsRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Phase 5 — setup wizard. On a fresh install (no users in DB),
  // the first registrant becomes admin and no invite code is
  // needed. Probe /api/auth/setup-status to detect the state and
  // skip the invite-code field on the register form.
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    void getSetupStatus().then(s => { if (!cancelled) setSetupStatus(s) }).catch(() => { /* non-fatal */ })
    return () => { cancelled = true }
  }, [])
  // Auto-flip to register mode on a fresh install so the first
  // visitor knows what to do.
  useEffect(() => {
    if (setupStatus && !setupStatus.has_users) setIsRegister(true)
  }, [setupStatus])
  const inviteRequired = !!(setupStatus?.has_users)

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setError(null)
    if (isRegister) {
      if (!username || !password) {
        setError('Username and password are required.')
        return
      }
      if (inviteRequired && !inviteCode) {
        setError('Invite code is required.')
        return
      }
      setSubmitting(true)
      try {
        const t = await register({ username, email, password, invite_code: inviteCode })
        onLogin(t.user)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Register failed')
      } finally { setSubmitting(false) }
      return
    }
    if (!username || !password) {
      setError('Username and password are required.')
      return
    }
    setSubmitting(true)
    try {
      const user = await apiLogin(username, password)
      onLogin(user)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed'
      // Bucket unknown error strings into a generic message; see
      // filterAuthError above for the whitelist rationale.
      setError(filterAuthError(msg))
    } finally {
      setSubmitting(false)
    }
  }, [isRegister, username, email, password, inviteCode, inviteRequired, onLogin])

  return (
    <div className="min-h-screen flex items-center justify-center aurora-bg p-4">
      <div className="w-full max-w-[420px]">
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-purple-600/20 border border-purple-500/30 mb-4">
            <svg width="28" height="28" viewBox="0 0 36 36" fill="none">
              <circle cx="18" cy="18" r="16" stroke="#A855F7" strokeWidth="2.5" opacity="0.5" />
              <path d="M14 11L26 18L14 25Z" fill="#A855F7" />
            </svg>
          </div>
          <h1 className="text-white text-2xl font-bold font-display tracking-wide">AURORA</h1>
          <p className="text-white/40 text-sm mt-1">Your personal media universe</p>
        </div>

        {/* Card */}
        <form onSubmit={handleSubmit} className="glass-panel rounded-2xl p-8">
          <h2 className="text-white text-xl font-semibold mb-1">
            {isRegister ? (setupStatus && !setupStatus.has_users ? 'Welcome to Aurora' : 'Create Account') : 'Welcome Back'}
          </h2>
          <p className="text-white/40 text-sm mb-6">
            {isRegister
              ? (setupStatus && !setupStatus.has_users
                ? "You're the first user on this server — your account becomes the admin."
                : 'Sign up to start streaming')
              : 'Sign in to your media server'}
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-white/60 text-sm mb-2">Username</label>
              <input
                type="text"
                placeholder="Enter username"
                className="w-full"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete={isRegister ? 'new-username' : 'username'}
                disabled={submitting}
              />
            </div>
            {isRegister && (
              <div>
                <label className="block text-white/60 text-sm mb-2">Email</label>
                <input
                  type="email"
                  placeholder="you@example.com"
                  className="w-full"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  disabled={submitting}
                />
              </div>
            )}
            <div>
              <label className="block text-white/60 text-sm mb-2">Password</label>
              <input
                type="password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                disabled={submitting}
              />
            </div>
            {isRegister && inviteRequired && (
              <div>
                <label className="block text-white/60 text-sm mb-2">Invite Code</label>
                <input
                  type="text"
                  placeholder="From your server admin"
                  className="w-full"
                  value={inviteCode}
                  onChange={e => setInviteCode(e.target.value.toUpperCase())}
                  disabled={submitting}
                />
              </div>
            )}
          </div>

          {error && (
            <div className="mt-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full mt-6 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-xl font-medium transition-all duration-200 hover:scale-[1.02] glow-purple disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {submitting ? 'Signing in…' : isRegister ? 'Create Account' : 'Sign In'}
          </button>

          {/* OAuth sign-in row. The ?invite= query forwards an entered
              invite code through the round-trip so register-mode
              sign-ins claim it atomically server-side. Each button
              renders only when its provider is enabled in setupStatus. */}
          {(setupStatus?.oauth_google_enabled || setupStatus?.oauth_discord_enabled || setupStatus?.oauth_twitch_enabled || setupStatus?.oauth_facebook_enabled || setupStatus?.oauth_twitter_enabled) && (
            <>
              <div className="flex items-center gap-3 my-6">
                <div className="flex-1 h-px bg-white/[0.06]" />
                <span className="text-white/30 text-xs uppercase tracking-wider">or</span>
                <div className="flex-1 h-px bg-white/[0.06]" />
              </div>
              <div className="space-y-2">
                {setupStatus?.oauth_google_enabled && (
                  <OAuthSignInButton
                    provider="google"
                    label="Continue with Google"
                    inviteCode={isRegister ? inviteCode : ''}
                    disabled={submitting}
                  />
                )}
                {setupStatus?.oauth_discord_enabled && (
                  <OAuthSignInButton
                    provider="discord"
                    label="Continue with Discord"
                    inviteCode={isRegister ? inviteCode : ''}
                    disabled={submitting}
                  />
                )}
                {setupStatus?.oauth_twitch_enabled && (
                  <OAuthSignInButton
                    provider="twitch"
                    label="Continue with Twitch"
                    inviteCode={isRegister ? inviteCode : ''}
                    disabled={submitting}
                  />
                )}
                {setupStatus?.oauth_facebook_enabled && (
                  <OAuthSignInButton
                    provider="facebook"
                    label="Continue with Facebook"
                    inviteCode={isRegister ? inviteCode : ''}
                    disabled={submitting}
                  />
                )}
                {setupStatus?.oauth_twitter_enabled && (
                  <OAuthSignInButton
                    provider="twitter"
                    label="Continue with X"
                    inviteCode={isRegister ? inviteCode : ''}
                    disabled={submitting}
                  />
                )}
              </div>
            </>
          )}

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => { setIsRegister(!isRegister); setError(null) }}
              className="text-purple-400 hover:text-purple-300 text-sm transition-colors"
            >
              {isRegister ? 'Already have an account? Sign In' : "Don't have an account? Register"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Phase B — OAuth sign-in button. Per-provider brand icon + colors.
// Renders as an <a> rather than a button + window.location because
// the browser handles the cross-site redirect natively (no JS state
// to preserve at this point; the round-trip's success page sets
// localStorage tokens before re-entering the SPA).
function OAuthSignInButton({ provider, label, inviteCode, disabled }: {
  provider: 'google' | 'discord' | 'twitch' | 'facebook' | 'twitter'
  label: string
  inviteCode: string
  disabled: boolean
}) {
  // Build the start URL. inviteCode is forwarded as ?invite=CODE so
  // the server can atomically claim it pre-flight (see
  // oauth_handlers.go Start handler).
  const params = new URLSearchParams()
  if (inviteCode.trim()) params.set('invite', inviteCode.trim())
  const qs = params.toString()
  const href = `/api/auth/oauth/${provider}/start${qs ? '?' + qs : ''}`

  // Per-provider visual treatment. Discord blurple, Twitch purple,
  // Google neutral-with-color-mark. Each button keeps the same
  // dimensions so the row reads as a uniform stack.
  const config = {
    google: {
      bg: 'bg-white hover:bg-white/95 text-gray-800',
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
      bg: 'bg-[#5865F2] hover:bg-[#4752C4] text-white',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      ),
    },
    twitch: {
      bg: 'bg-[#9146FF] hover:bg-[#7c2fff] text-white',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
        </svg>
      ),
    },
    facebook: {
      bg: 'bg-[#1877F2] hover:bg-[#1665D8] text-white',
      icon: (
        // Official Facebook "f" mark.
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
        </svg>
      ),
    },
    twitter: {
      // X's brand is solid black; we add a subtle lift on hover.
      bg: 'bg-black hover:bg-zinc-800 text-white border border-white/10',
      icon: (
        // The X mark — official post-rebrand glyph.
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      ),
    },
  }[provider]

  return (
    <a
      href={disabled ? undefined : href}
      onClick={(e) => { if (disabled) e.preventDefault() }}
      className={`w-full flex items-center justify-center gap-3 py-2.5 rounded-xl font-medium transition-all duration-200 hover:scale-[1.01] disabled:opacity-50 ${config.bg} ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      {config.icon}
      {label}
    </a>
  )
}

/* ─────────────────────── SIDEBAR ─────────────────────── */
// Sidebar conditionally renders the Admin link for admins. The
// server-side /api/admin/* endpoints enforce the gate too — the
// frontend check is for UX, not security.
function Sidebar({ user: sidebarUser, currentView, onNavigate, serverOpen, setServerOpen, notifOpen, setNotifOpen, notifCount, mobileOpen, onMobileClose }: {
  user?: ApiUser
  currentView: string
  onNavigate: (v: string) => void
  serverOpen: boolean
  setServerOpen: (v: boolean) => void
  notifOpen: boolean
  setNotifOpen: (v: boolean) => void
  notifCount: number
  // QA BUG-012 — mobile drawer support. Below md (768px) the sidebar
  // is hidden by default and slides in over content when mobileOpen
  // is true. md+ ignores both props; the sidebar is always visible.
  mobileOpen: boolean
  onMobileClose: () => void
}) {
  const isAdmin = sidebarUser?.role === 'admin'
  const navItems = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'movies', label: 'Movies', icon: 'movie' },
    { id: 'shows', label: 'TV Shows', icon: 'tv' },
    { id: 'collections', label: 'Collections', icon: 'star' },
    { id: 'calendar', label: 'Calendar', icon: 'clock' },
    { id: 'library', label: 'My Library', icon: 'library' },
    { id: 'requests', label: 'Requests', icon: 'download' },
    ...(isAdmin ? [{ id: 'admin', label: 'Admin', icon: 'settings' }] : []),
  ]

  return (
    <aside className={`fixed left-0 top-0 bottom-0 w-[240px] bg-[#050505] border-r border-white/[0.06] z-50 flex flex-col transition-transform duration-200 md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      {/* Brand — Phase 8 fix: clicking the logo always returns to
          home, matching every other media-app convention (Netflix,
          Spotify, YouTube etc). `type="button"` prevents form
          submission if the sidebar ever ends up inside a form. */}
      <button
        type="button"
        onClick={() => { onNavigate('home'); onMobileClose() }}
        className="p-5 flex items-center gap-3 hover:bg-white/[0.02] transition-colors"
        aria-label="Go to home"
      >
        <div className="w-9 h-9 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center">
          <svg width="20" height="20" viewBox="0 0 36 36" fill="none">
            <circle cx="18" cy="18" r="16" stroke="#A855F7" strokeWidth="2.5" opacity="0.5" />
            <path d="M14 11L26 18L14 25Z" fill="#A855F7" />
          </svg>
        </div>
        <span className="text-white font-bold text-lg font-display tracking-wider">AURORA</span>
      </button>

      {/* Nav */}
      <nav className="flex-1 px-3 py-2 space-y-1">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-link-item w-full ${currentView === item.id ? 'active' : ''}`}
            onClick={() => { onNavigate(item.id); onMobileClose() }}
          >
            <Icon name={item.icon} size={18} />
            {item.label}
          </button>
        ))}
      </nav>

      {/* Bottom Actions */}
      <div className="p-3 border-t border-white/[0.06]">
        <button
          className={`nav-link-item w-full ${serverOpen ? 'active' : ''}`}
          onClick={() => { setServerOpen(!serverOpen); setNotifOpen(false) }}
        >
          <Icon name="server" size={18} />
          Server Status
        </button>
        <button
          className={`nav-link-item w-full ${notifOpen ? 'active' : ''}`}
          onClick={() => { setNotifOpen(!notifOpen); setServerOpen(false) }}
        >
          <div className="relative">
            <Icon name="bell" size={18} />
            {notifCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-purple-600 rounded-full text-[10px] font-bold flex items-center justify-center">
                {notifCount}
              </span>
            )}
          </div>
          Notifications
        </button>
        <button
          className={`nav-link-item w-full ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => { onNavigate('settings'); onMobileClose() }}
        >
          <Icon name="settings" size={18} />
          Settings
        </button>
        <div className="mt-2 pt-2 border-t border-white/[0.04]">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center text-white text-xs font-bold">
              {sidebarUser?.username[0]?.toUpperCase() || 'U'}
            </div>
            <div className="min-w-0">
              <p className="text-white/80 text-sm font-medium truncate">{sidebarUser?.username || 'User'}</p>
              <p className="text-white/40 text-xs capitalize">{sidebarUser?.role || 'online'}</p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}

/* ─────────────────────── HOME VIEW ─────────────────────── */
// HomeView. Rails are cached at App level so navigating away-and-back
// reuses the previously-fetched data.
interface HomeViewProps {
  onSelect: (m: Media) => void
  onPlay: (m: Media) => void
  hero?: Media
  // `kind` is a stable discriminator. Don't use the user-visible
  // `title` for behavior: renaming or localizing it would silently
  // break the Continue Watching code path.
  rails?: {
    title: string
    items: Media[]
    aspect: 'poster' | 'landscape'
    kind?: 'continue-watching'
    // QA 2026-05-25 — when present, MediaRail renders a clickable
    // "See All" affordance that routes here. Built-in rails wire it
    // ("Top Rated Movies" → /movies + sort=rating); curated/AI rails
    // (no dedicated browse page) leave it undefined so the button
    // hides — no more misleading clicks that do nothing.
    seeAllTarget?: { view: 'movies' | 'shows'; sortBy?: 'rating' | 'recent' | 'title' | 'year' }
  }[]
  // App-level navigation callback so HomeView can request a route
  // change for See All clicks. Optional so the type stays backwards
  // compatible with renderers that don't wire it (the See All button
  // simply won't appear in that case).
  onNavigate?: (view: string, opts?: { sortBy?: 'rating' | 'recent' | 'title' | 'year' }) => void
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  // 2028-05-28 (deep-debug Bug C) — `continueItems` and `onPlayContinue`
  // were dead after the cinema-card swap removed the rail's hover Play CTA.
  // They previously fed a `railPlay` interceptor that resumed Continue
  // Watching cards at the saved position_ms / episode_id; with no Play CTA
  // for the interceptor to attach to, the props are unreachable. Resume
  // now happens via card-click → detail view → Play; tracked as a separate
  // follow-up.
  onCardContext?: (e: React.MouseEvent, m: Media) => void
  // Phase 5.3 — hero reason + refresh + pause hooks.
  heroReason?: string
  onRefreshHero?: () => void
  onHeroPauseChange?: (paused: boolean) => void
  // Cold-start hint info — passed through from the /api/me/hero response.
  // null = unknown (initial load); set when the response lands.
  heroPersonalization?: HeroPersonalization | null
  // My Library + button on cards. Set of saved IDs for fast O(1) lookup
  // per render; callback toggles membership when the user clicks +.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
  // 2026-05-27 — Hero resume awareness. When the hero media has a CW
  // record (position_ms > 0), App passes the matched ContinueWatchingItem
  // here so HeroSection can label its primary CTA "Resume at MM:SS"
  // instead of "Play" — matching the DetailView Resume CTA shipped in
  // PR #97. Bundled with its handler in a discriminated `heroResume`
  // shape (same pattern as DetailView's `resume`) so partial wiring is
  // a type error. Undefined = no CW match for the current hero, render
  // the classic Play button.
  heroResume?: {
    item: ContinueWatchingItem
    onPlay: (c: ContinueWatchingItem) => void
  }
  // 2026-05-27 — Continue Watching one-click resume affordance.
  // When set, the home Continue Watching rail's cards each get a
  // Resume pill on hover; click on the pill calls onPlay with the
  // matched record, bypassing detail. Card click still opens detail
  // (preserves the "click → detail → act" pattern for non-CW
  // interactions like "I want to see the description"). Discriminated
  // bundle so partial wiring is a type error. Wired ONLY on the
  // home CW rail — other rails (Top Rated, Discover, etc.) don't
  // sprout resume pills even if the user has progress on a title
  // they happen to contain.
  cwResume?: {
    items: ContinueWatchingItem[]
    onPlay: (c: ContinueWatchingItem) => void
  }
}
function HomeView({ onSelect, onPlay, hero, rails, loading, error, onRetry, onCardContext, heroReason, onRefreshHero, onHeroPauseChange, heroPersonalization, libraryIds, onToggleLib, onNavigate, heroResume, cwResume }: HomeViewProps) {
  // Do NOT fall back to mock rails: their IDs collide with real
  // media IDs and silently route Play to the wrong title. Empty
  // rails during the load window are correct.
  const effectiveRails = rails ?? []
  // Deep-debug H3 — keep the latest cwResume bundle in a ref so the
  // Resume pill click handler resolves the freshest ContinueWatchingItem
  // at click-time (not render-time). Without this, a mid-hover
  // continueItems refresh would still dispatch the stale match
  // captured when the rail mapped.
  const cwResumeRef = useRef(cwResume)
  useEffect(() => { cwResumeRef.current = cwResume }, [cwResume])

  return (
    <div className="animate-fade-in">
      <HeroSection
        hero={hero}
        onPlay={onPlay}
        onInfo={onSelect}
        reason={heroReason}
        onRefreshHero={onRefreshHero}
        onPauseChange={onHeroPauseChange}
        personalization={heroPersonalization ?? null}
        resume={heroResume}
      />
      {error && (
        <div className="mb-6 px-5 py-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">Couldn't load your library</p>
            <p className="text-red-300/70 text-xs mt-1">{error}</p>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-4 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-white/90 text-sm transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {loading && !rails && (
        <div className="mb-6 px-5 py-3 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-200 text-sm">
          Loading your library…
        </div>
      )}
      {effectiveRails.map((rail, i) => {
        if (rail.items.length === 0) return null
        const seeAllHandler = rail.seeAllTarget && onNavigate
          ? () => onNavigate(rail.seeAllTarget!.view, { sortBy: rail.seeAllTarget!.sortBy })
          : undefined
        // 2026-05-27 — Resume pill wiring. ONLY the Continue Watching
        // rail (rail.kind === 'continue-watching') gets the per-card
        // resume resolver. Other rails leave it undefined so
        // partial-watch matches on Top Rated / Discover / etc. don't
        // sprout pills (per design — those rails are discovery-focused,
        // not action-focused).
        //
        // Deep-debug H3 — the click handler resolves the match from
        // `cwResumeRef.current` at click-time (NOT render-time) so a
        // mid-hover continueItems refresh (e.g. another device just
        // watched 2 minutes and the server's position_ms jumped)
        // doesn't dispatch a stale ContinueWatchingItem. isResumable
        // also runs at click-time so a record that fell below the
        // threshold between render and click correctly no-ops.
        const resolveResume = rail.kind === 'continue-watching' && cwResume
          ? (m: Media) => {
              // Render-time check: if there's no resumable record
              // RIGHT NOW, don't show a pill (saves rendering it
              // only to have the click no-op).
              if (!cwResume.items.some(c => c.media_item_id === m.id && isResumable(c))) {
                return undefined
              }
              return () => {
                // Click-time re-lookup against the latest data.
                const latest = cwResumeRef.current
                if (!latest) return
                const match = latest.items.find(
                  c => c.media_item_id === m.id && isResumable(c),
                )
                if (match) latest.onPlay(match)
              }
            }
          : undefined
        return (
          <MediaRail
            key={`${rail.title}-${i}`}
            title={rail.title}
            items={rail.items}
            onSelect={onSelect}
            aspect={rail.aspect}
            onCardContext={onCardContext}
            libraryIds={libraryIds}
            onToggleLib={onToggleLib}
            onSeeAll={seeAllHandler}
            resolveResume={resolveResume}
          />
        )
      })}
    </div>
  )
}

/* ─────────────────────── MOVIES / SHOWS VIEW ─────────────────────── */
type BrowseSort = 'rating' | 'title' | 'year' | 'recent'
function BrowseView({
  items, title, subtitle, total, sortBy, onSortChange,
  genreFilter, onGenreChange, availableGenres,
  onLoadMore, isLoadingMore,
  onSelect, onCardContext,
  libraryIds, onToggleLib,
}: {
  items: Media[]
  title: string
  subtitle: string
  // Real catalog count from the server (paginated total_items). When
  // null the page is still loading; fall back to items.length.
  total?: number | null
  // Sort is parent-controlled: changing it triggers a re-fetch from
  // page 1. Client-side sort is not safe across paginated loads
  // (later pages arrive in server-order and would concat after a
  // re-sorted page 1).
  sortBy: BrowseSort
  onSortChange: (s: BrowseSort) => void
  // Genre is ALSO parent-controlled (QA BUG-003) so it survives
  // the moviesList=null intermediate state on sort changes. Empty
  // string = "All Genres". Genre is now also server-side: changing
  // it clears items and re-fetches page 1, same lifecycle as sort.
  genreFilter: string
  onGenreChange: (g: string) => void
  // Canonical genre catalog from /api/media/genres. Stable across
  // pagination + sort changes so the dropdown never offers a filter
  // that returns zero results, and never hides a genre that exists
  // in the library but hasn't been paginated into view yet. Null
  // while loading.
  availableGenres: string[] | null
  // Load More — appends the next page. Button is rendered only
  // when items.length < total. While in flight isLoadingMore is
  // true so the button can disable + show a spinner.
  onLoadMore: () => void
  isLoadingMore: boolean
  onSelect: (m: Media) => void
  // 2028-05-28 (deep-debug Bug C) — dropped the dead `onPlay?` prop.
  // It was kept "for backward compat" after the cinema-card swap removed
  // the hover Play CTA, but no consumer in BrowseView reads it; leaving
  // it in the type implied a behavior that never fired and confused
  // future readers. Call sites must also drop `onPlay={handlePlay}`.
  onCardContext?: (e: React.MouseEvent, m: Media) => void
  // My Library + button on cards. Same contract as MediaRail.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
}) {
  // Genre is now server-side (Batch A 2026-05-25). The server filters
  // + paginates against the FULL catalog, so `items.length` is already
  // the count of horror titles loaded so far and `total` is the real
  // horror catalog size — not "horror within the loaded page" which
  // was the previous bug (Top-Rated returned 3, A-Z returned 11 for
  // the same Horror filter because the loaded subsets differed).
  //
  // availableGenres comes from /api/media/genres and is stable
  // regardless of pagination. Falls back to deriving from items
  // while the genres fetch is in flight, so first paint isn't blocked.
  const genres = availableGenres && availableGenres.length > 0
    ? ['All Genres', ...availableGenres]
    : ['All Genres', ...Array.from(new Set(items.map(i => i.genre).filter(Boolean)))]

  // No client-side filter — items array already reflects the server's
  // (type + genre + sort) filter set.
  const filtered = items
  const hasMore = total != null && items.length < total
  const remaining = total != null ? Math.max(0, total - items.length) : 0

  // Phase 5.3 final QA — pill identifier above the page headline.
  // "TV Shows" and "Movies" pages both use the same pattern. Built
  // from the page title for now; could be derived from view if we
  // grow more browse pages.
  const pillLabel = title === 'TV Shows' ? 'BROWSE SERIES' : title === 'Movies' ? 'BROWSE FILMS' : 'BROWSE'
  return (
    <div className="animate-fade-in relative">
      {/* Edgeless header: soft blurred blobs anchored to the page
          (not inside a container) so the gradient bleeds without a
          visible seam. */}
      <div
        aria-hidden="true"
        className="absolute -top-8 -left-8 -right-8 h-[360px] pointer-events-none overflow-hidden"
      >
        <div className="absolute -top-32 right-0 w-[600px] h-[600px] rounded-full bg-purple-500/[0.08] blur-3xl" />
        <div className="absolute top-20 -right-20 w-[400px] h-[400px] rounded-full bg-fuchsia-500/[0.05] blur-3xl" />
      </div>

      <div className="relative mb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 mb-3">
          <Icon name={title === 'TV Shows' ? 'tv' : 'film'} size={12} className="text-purple-300" />
          <span className="text-purple-200 text-xs font-medium uppercase tracking-wider">{pillLabel}</span>
        </div>
        <h1 className="text-white text-4xl font-bold font-display">{title}</h1>
        <p className="text-white/60 text-sm mt-2">
          {subtitle}
          <span className="text-white/30 mx-1.5">•</span>
          {/* Server-side filter means `total` is the true catalog
              count for the active (type + genre) combination — no
              longer "filtered subset of loaded page". The branch on
              `genreFilter` is kept only for the label
              ("X Horror titles" vs "X titles"). */}
          {total != null && total > items.length ? (
            <>
              Showing {items.length.toLocaleString()} of{' '}
              <span className="text-white/90 font-medium">{total.toLocaleString()}</span>
              {genreFilter && genreFilter !== 'All Genres' ? ` ${genreFilter}` : ''} title{total === 1 ? '' : 's'}
            </>
          ) : (
            <>
              <span className="text-white/90 font-medium">{(total ?? items.length).toLocaleString()}</span>
              {genreFilter && genreFilter !== 'All Genres' ? ` ${genreFilter}` : ''} title{(total ?? items.length) === 1 ? '' : 's'}
            </>
          )}
        </p>
      </div>

      <div className="relative mb-8">
        {/* Filters */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-white/40 text-sm">Genre:</span>
            <select
              value={genreFilter}
              onChange={(e) => onGenreChange(e.target.value)}
              className="text-sm py-2 px-3"
            >
              {genres.map(g => <option key={g} value={g === 'All Genres' ? '' : g}>{g}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-white/40 text-sm">Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as BrowseSort)}
              className="text-sm py-2 px-3"
            >
              <option value="rating">Top Rated</option>
              <option value="year">Newest</option>
              <option value="title">A-Z</option>
              <option value="recent">Recently Added</option>
            </select>
          </div>
        </div>
      </div>

      {/* Grid — 2028-05-28 switched from inline .media-card to the shared
          <MediaCardCinema/> component so Movies/TV Shows browse views
          match the home rails' design tokens (halo, badges, shelf, reason). */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
        {filtered.map((item) => (
          <MediaCardCinema
            key={item.id}
            item={item}
            onSelect={() => onSelect(item)}
            onCardContext={onCardContext ? (e) => onCardContext(e, item) : undefined}
            libraryIds={libraryIds}
            onToggleLib={onToggleLib ? () => onToggleLib(item) : undefined}
          />
        ))}
      </div>

      {/* Load More — Server caps per_page at 100, so a 2,394-item
          library needs 24 clicks to see every poster. Acceptable
          for now; future iteration could swap for infinite-scroll
          with IntersectionObserver if users ask for it. Button
          shows "Load 100 more (1,294 remaining)" so the user knows
          the cadence + scope.

          With server-side genre filtering, Load More works the same
          whether a genre is selected or not — paginating the filtered
          set instead of the full library. The "filtering loaded titles
          only" banner is gone; counts and pagination now reflect the
          real (type + genre) catalog. */}
      {hasMore && (
        <div className="mt-10 flex flex-col items-center gap-2">
          <button
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="px-6 py-3 rounded-full bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/30 text-purple-100 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {isLoadingMore ? (
              <>
                <span className="w-3 h-3 rounded-full border-2 border-purple-300 border-t-transparent animate-spin" />
                Loading…
              </>
            ) : (
              <>Load {Math.min(100, remaining).toLocaleString()} more</>
            )}
          </button>
          <p className="text-white/40 text-xs">
            {remaining.toLocaleString()} title{remaining === 1 ? '' : 's'} remaining
          </p>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────── CAST CARD ─────────────────────── */
// Each card owns its own image-failure state so a broken thumbnail
// renders the same placeholder as a missing one (instead of an
// 80px hole).
//
// QA 2026-05-25 — placeholder upgraded from a generic person icon
// to first+last initials on a tinted background. The icon-only
// fallback made a row of imageless cast (e.g. older shows where
// TMDB doesn't have headshots) look like a row of identical blanks;
// initials at least disambiguate visually.
function castInitials(name: string): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function CastCard({ member }: { member: { id: number; name: string; profile_path?: string; character?: string; role_type: string } }) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = !!member.profile_path && !imgFailed
  return (
    <div className="flex-shrink-0 w-[100px] text-center">
      {showImg ? (
        <img
          src={posterURL(member.profile_path, 'w185')}
          alt={member.name}
          className="w-[80px] h-[80px] rounded-full object-cover mb-2 mx-auto ring-1 ring-white/10"
          loading="lazy"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div
          className="w-[80px] h-[80px] rounded-full bg-gradient-to-br from-purple-500/20 to-fuchsia-500/15 border border-white/10 mb-2 mx-auto flex items-center justify-center text-white/80 text-xl font-semibold"
          aria-label={`${member.name} avatar placeholder`}
        >
          {castInitials(member.name)}
        </div>
      )}
      <div className="text-white/90 text-xs font-medium truncate">{member.name}</div>
      {member.character && (
        <div className="text-white/40 text-[11px] truncate" title={member.character}>{member.character}</div>
      )}
    </div>
  )
}

/* ─────────────────────── DETAIL VIEW ─────────────────────── */
// 2026-05-27 — Continue Watching resume helpers. Used by Hero,
// DetailView, the home CW rail, and the Library CW grid. Module-
// level so each call site shares the same threshold and format
// rules (deep-debug Phase-2 M1 — was duplicated in 4 places, drifted
// once already).
//
// RESUME_THRESHOLD_MS — the floor below which we treat a CW entry as
// "not really started" (user opened then immediately closed). Set to
// 5s based on UX observation: <5s is virtually always a misclick, and
// "Resume at 0:00" reads as a UI bug. Single source of truth.
const RESUME_THRESHOLD_MS = 5000

// isResumable — true when a Continue Watching record represents
// meaningful playback worth offering Resume for. All call sites that
// gate Resume UI (Hero label, card pill, detail view CTA) should use
// this helper rather than open-coding the threshold check.
function isResumable(c: ContinueWatchingItem | undefined | null): c is ContinueWatchingItem {
  return !!c && c.position_ms >= RESUME_THRESHOLD_MS
}

// formatResumeTime: takes a position in ms and returns a colon-separated
// MM:SS for sub-hour resumes or H:MM:SS for longer ones. Zero-pads
// minutes/seconds so the string stays a fixed width per duration class
// (4:07 not 4:7, 1:02:03 not 1:2:3).
function formatResumeTime(positionMs: number): string {
  const totalSec = Math.max(0, Math.floor(positionMs / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
// formatResumeAriaLabel: spelled-out form of formatResumeTime for
// screen readers. The colon-separated visible label ("Resume at 4:07")
// is read as "four colon zero seven" or "four-oh-seven" depending on
// engine — neither is great. The aria-label uses words.
function formatResumeAriaLabel(c: ContinueWatchingItem): string {
  const totalSec = Math.max(0, Math.floor(c.position_ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`)
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  if (s > 0 || parts.length === 0) parts.push(`${s} second${s === 1 ? '' : 's'}`)
  const time = parts.join(' ')
  // Use `!== undefined` (not truthy) so episode 0 / season 0 (pilots,
  // specials) still get the show prefix. season_number could be 0 in
  // some libraries; same for episode_number.
  if (c.type === 'show' && c.season_number !== undefined && c.episode_number !== undefined) {
    return `Resume Season ${c.season_number} Episode ${c.episode_number} at ${time}`
  }
  return `Resume from ${time}`
}
// formatResumeLabel: builds the human-readable visible label. Movies
// get "Resume at MM:SS"; shows get "Resume S2E5 · MM:SS" so the user
// sees which episode the click will resume.
//
// Why `!== undefined` instead of truthy: episode_number === 0 (a
// "special" / pilot) is a real value in some libraries; the previous
// truthy check rejected it and silently fell back to the movie-style
// "Resume at MM:SS" label, losing the show context. Same for
// season_number on shows that number from 0.
function formatResumeLabel(c: ContinueWatchingItem): string {
  const time = formatResumeTime(c.position_ms)
  if (c.type === 'show' && c.season_number !== undefined && c.episode_number !== undefined) {
    return `Resume S${c.season_number}E${c.episode_number} · ${time}`
  }
  return `Resume at ${time}`
}

interface DetailViewProps {
  media: Media
  onBack: () => void
  onPlay: (m: Media) => void
  onToggleLib: (m: Media) => void
  inLibrary: boolean
  // Phase 2 extras:
  detail?: MediaDetail
  apiEpisodes?: ApiEpisode[]
  onPlayEpisode?: (ep: ApiEpisode) => void
  // Phase 5.3 final QA — fires when the user clicks an episode that
  // has no associated file. App surfaces a toast so the click isn't
  // silent (previously the row was greyed out with no explanation).
  onEpisodeUnavailable?: (ep: ApiEpisode) => void
  loading?: boolean
  error?: string | null
  // Phase 4 — kick off a watch party with this media as the seed.
  onStartParty?: (m: Media) => void
  inParty?: boolean
  // Phase 4.5 — multi-season picker.
  seasons?: { season_number: number; episode_count?: number }[]
  selectedSeason?: number | null
  onSelectSeason?: (n: number) => void
  // Phase 5 — add-to-watchlist. App owns the watchlists state +
  // dialog; DetailView just calls the callback with the media item.
  onAddToWatchlist?: (m: Media) => void
  // Phase 5.2 — admin-only refresh-metadata. Only rendered when
  // the caller is admin (App gates with user.role === 'admin').
  onRefreshMetadata?: (m: Media) => void
  // Admin-only manual identify. Opens ManualMatchModal so the admin
  // can pick a specific TMDB/TVDB id when the auto-matcher landed on
  // the wrong title. Distinct from Refresh (which re-runs the same
  // auto-match and may land on the same wrong answer).
  onIdentify?: (m: Media) => void
  // Phase 5.2 — version selector for movies with multiple files.
  // App passes the files list; DetailView surfaces them as chips.
  // Clicking a chip plays that specific file (4K version, alt cut, etc.).
  files?: MediaFile[]
  onPlayFile?: (m: Media, fileId: number) => void
  // 2026-05-27 — Continue Watching resume restore. When this media has
  // a partial-watch progress entry, App threads BOTH the matched record
  // AND its handler in via this single `resume` prop. The bundled shape
  // (vs the previous split `resumeItem?` + `onPlayContinue?` pair) makes
  // partial wiring a type error: you can't pass only the record without
  // a handler to call it back into App, and you can't pass a handler
  // with no record for it to act on. Undefined → Resume CTA hides and
  // the classic Play button takes its place (zero-behavior change for
  // fresh titles).
  resume?: {
    item: ContinueWatchingItem
    onPlay: (c: ContinueWatchingItem) => void
  }
}
function DetailView({
  media, onBack, onPlay, onToggleLib, inLibrary,
  detail, apiEpisodes, onPlayEpisode, onEpisodeUnavailable, loading, error,
  onStartParty, inParty,
  seasons, selectedSeason, onSelectSeason,
  onAddToWatchlist,
  onRefreshMetadata,
  onIdentify,
  files, onPlayFile,
  resume,
}: DetailViewProps) {
  // Prefer real metadata when available — overview, runtime, rating
  // straight from the server. Falls back to whatever the lightweight
  // Media object had so the page still shows something pre-fetch.
  const description = detail?.overview || media.description
  const rating = detail?.rating ?? media.rating
  const realPoster = detail ? posterURL(detail.poster_path) : media.poster
  const realBackdrop = detail ? backdropURL(detail.backdrop_path) : (media.backdrop || media.poster)
  // Extract a dominant color from the poster for accent tinting.
  // Silently falls back to the default Aurora purple on failure.
  const [palette, setPalette] = useState(DEFAULT_PALETTE)
  useEffect(() => {
    if (!realPoster) return
    let cancelled = false
    extractPalette(realPoster).then(p => { if (!cancelled) setPalette(p) })
    return () => { cancelled = true }
  }, [realPoster])
  const realGenre = (detail?.genres && detail.genres[0]) || media.genre
  // QA BUG-013 — TMDB's TV detail returns per-episode runtime, not
  // the series total. Append "/ep" for any episodic type (shows AND
  // anime — anime is the same data model with a different label) so
  // users don't read "0h 24m" as the total length of a multi-season
  // series.
  const realRuntime = detail?.runtime_minutes
    ? `${Math.floor(detail.runtime_minutes / 60)}h ${detail.runtime_minutes % 60}m${media.type !== 'movie' ? ' / ep' : ''}`
    : media.duration
  // Server returns one CastMember[] for cast AND crew, discriminated
  // by role_type. Split here so cast renders as avatars and crew
  // renders as compact text rows under the title.
  const castMembers = (detail?.cast || []).filter(c => c.role_type === 'cast')
  const directors = (detail?.cast || []).filter(c => c.role_type === 'director')
  const writers = (detail?.cast || []).filter(c => c.role_type === 'writer')
  const creators = (detail?.cast || []).filter(c => c.role_type === 'creator')
  // Audio/subtitle tracks. Lookup order:
  //   1. detail.files[0] — movies
  //   2. files[0] — when a separate /api/media/{id}/files call ran
  //   3. For shows, the first episode that has a file. Show-level
  //      files live in media_files which is always empty for shows
  //      (their files are in episode_files), so without (3) Media
  //      Info would never render for a TV show.
  let trackFile: { audio_tracks?: AudioTrack[]; subtitle_tracks?: SubtitleTrack[] } | undefined =
    detail?.files?.[0] || files?.[0]
  if (!trackFile && media.type === 'show' && apiEpisodes) {
    const epWithFile = apiEpisodes.find(e => e.files && e.files.length > 0)
    // EpisodeFile doesn't carry audio_tracks in our current TS shape
    // (we kept that interface sparse). Cast through unknown so we
    // can read the server fields when present. The cost of being
    // sparse on the type is this one boundary cast.
    const f = epWithFile?.files?.[0] as unknown as
      { audio_tracks?: AudioTrack[]; subtitle_tracks?: SubtitleTrack[] } | undefined
    if (f && (f.audio_tracks?.length || f.subtitle_tracks?.length)) {
      trackFile = f
    }
  }
  const audioTracks = trackFile?.audio_tracks || []
  const subtitleTracks = trackFile?.subtitle_tracks || []
  return (
    <div className="animate-fade-in -mx-8 -mt-8">
      {/* Hero */}
      <div className="relative h-[60vh] min-h-[450px]">
        <img src={realBackdrop} alt="" className="w-full h-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#050505] via-[#050505]/40 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#050505]/80 to-transparent" />

        <button
          onClick={onBack}
          className="absolute top-6 left-6 flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 backdrop-blur-md rounded-full text-white text-sm transition-all border border-white/10"
        >
          <Icon name="arrowLeft" size={16} /> Back
        </button>

        <div className="absolute bottom-8 left-8 right-8 flex items-end gap-8">
          <div className="w-[200px] h-[300px] rounded-2xl overflow-hidden shadow-2xl hidden md:block ring-1 ring-white/10">
            <img src={realPoster} alt={media.title} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 max-w-2xl">
            <div className="flex items-center gap-3 mb-3">
              <span className="badge-glass bg-purple-500/10 text-purple-300 border border-purple-500/20 uppercase">
                {media.type}
              </span>
              {media.tags?.map(tag => (
                <span key={tag} className="badge-glass bg-white/5 text-white/50 border border-white/10">
                  {tag}
                </span>
              ))}
            </div>
            <h1 className="text-white text-5xl font-bold font-display mb-2">{media.title}</h1>
            {/* TMDB tagline. */}
            {detail?.tagline && (
              <p className="text-purple-200/70 text-base italic mb-3">{detail.tagline}</p>
            )}
            <div className="flex items-center gap-4 mb-4 flex-wrap">
              {rating > 0 && (
                <span className="text-yellow-400 flex items-center gap-1">
                  <Icon name="star" size={14} className="fill-yellow-400" /> {rating.toFixed(1)}
                </span>
              )}
              {media.year > 0 && <span className="text-white/50">{media.year}</span>}
              {realRuntime && <span className="text-white/50">{realRuntime}</span>}
              {realGenre && <span className="text-white/50">{realGenre}</span>}
              {detail?.content_rating && (
                <span className="px-2 py-0.5 text-xs border border-white/15 rounded text-white/60">{detail.content_rating}</span>
              )}
            </div>
            {/* Crew row — director/writer/creator under the metadata
                line. V1 renders these as small inline text; we mirror
                that. Skips when no crew data is available. */}
            {(directors.length > 0 || writers.length > 0 || creators.length > 0) && (
              <div className="space-y-1 mb-4 text-sm">
                {directors.length > 0 && (
                  <div className="text-white/60">
                    <span className="text-white/40">Directed by</span>{' '}
                    <span className="text-white/85">{directors.map(d => d.name).join(', ')}</span>
                  </div>
                )}
                {writers.length > 0 && (
                  <div className="text-white/60">
                    <span className="text-white/40">Written by</span>{' '}
                    <span className="text-white/85">{writers.map(w => w.name).join(', ')}</span>
                  </div>
                )}
                {creators.length > 0 && (
                  <div className="text-white/60">
                    <span className="text-white/40">Created by</span>{' '}
                    <span className="text-white/85">{creators.map(c => c.name).join(', ')}</span>
                  </div>
                )}
              </div>
            )}
            {error && (
              <p className="text-red-400 text-sm mb-4">{error}</p>
            )}
            <p className="text-white/70 text-base leading-relaxed mb-6 line-clamp-4">
              {loading && !detail ? 'Loading details…' : (description || 'No description available.')}
            </p>
            {/* Action buttons share uniform height (h-11) and icon
                size (16). flex-wrap + whitespace-nowrap keeps text
                from wrapping inside individual pills on narrow
                viewports. */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* 2026-05-27 — Continue Watching resume CTA. When the
                  parent threads a `resume` bundle for this media, Resume
                  replaces Play as the primary action and a smaller
                  "From start" secondary appears next to it (Plex /
                  Netflix pattern). Without `resume`, only the classic
                  Play renders — same as before the restore.

                  Both buttons rely on the global "Resolving stream…"
                  overlay (App.tsx where setPlayerLoading shows the
                  full-viewport blocker) to prevent double-click races:
                  during the async stream-resolve, the overlay covers
                  these buttons so a second click physically can't
                  reach them. No per-button `disabled` needed. */}
              {resume ? (
                <>
                  <button
                    onClick={() => resume.onPlay(resume.item)}
                    // Same palette/glow as Play so the visual weight
                    // signals "primary CTA" — Resume just inherits the
                    // role here.
                    style={{
                      backgroundColor: palette.accent,
                      boxShadow: `0 0 24px ${palette.glow}`,
                    }}
                    className="h-11 inline-flex items-center gap-2 px-7 text-white rounded-full font-medium transition-all hover:scale-[1.03] whitespace-nowrap"
                    title={`Resume from your last position (${formatResumeTime(resume.item.position_ms)})`}
                    aria-label={formatResumeAriaLabel(resume.item)}
                  >
                    <Icon name="play" size={16} /> {formatResumeLabel(resume.item)}
                  </button>
                  <button
                    onClick={() => onPlay(media)}
                    className="h-11 inline-flex items-center gap-2 px-5 rounded-full font-medium transition-all bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.06] text-white/80 whitespace-nowrap"
                    title="Restart from the beginning"
                    aria-label="Play from the beginning"
                  >
                    {/* `refresh` glyph (counter-clockwise arrow) reads
                        as "restart" more clearly than `skipBack` which
                        is the media-transport "previous track" icon and
                        could be misread as "go back one episode." */}
                    <Icon name="refresh" size={16} /> From start
                  </button>
                </>
              ) : (
                <button
                  onClick={() => onPlay(media)}
                  // Tint background + glow with the poster's dominant
                  // color (falls back to Aurora purple).
                  style={{
                    backgroundColor: palette.accent,
                    boxShadow: `0 0 24px ${palette.glow}`,
                  }}
                  className="h-11 inline-flex items-center gap-2 px-7 text-white rounded-full font-medium transition-all hover:scale-[1.03] whitespace-nowrap"
                >
                  <Icon name="play" size={16} /> Play
                </button>
              )}
              <button
                onClick={() => onToggleLib(media)}
                className={`h-11 inline-flex items-center gap-2 px-6 rounded-full font-medium transition-all border whitespace-nowrap ${
                  inLibrary
                    ? 'bg-purple-600/20 border-purple-500/40 text-purple-300 hover:bg-red-500/20 hover:border-red-500/40 hover:text-red-400'
                    : 'bg-white/10 border-white/10 text-white hover:bg-white/15'
                }`}
              >
                <Icon name={inLibrary ? 'check' : 'plus'} size={16} />
                {inLibrary ? 'In Library' : 'Add to Library'}
              </button>
              {onAddToWatchlist && (
                <button
                  onClick={() => onAddToWatchlist(media)}
                  className="h-11 inline-flex items-center gap-2 px-6 rounded-full font-medium transition-all bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.06] text-white/80 whitespace-nowrap"
                  title="Add to a watchlist"
                >
                  <Icon name="library" size={16} />
                  Add to List
                </button>
              )}
              {onStartParty && (
                <button
                  onClick={() => onStartParty(media)}
                  disabled={inParty}
                  title={inParty ? 'Already in a party. Leave first to start a new one.' : 'Start a watch party'}
                  className="h-11 inline-flex items-center gap-2 px-6 rounded-full font-medium transition-all bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  <Icon name="users" size={16} />
                  {inParty ? 'In Party' : 'Watch Party'}
                </button>
              )}
              {onRefreshMetadata && (
                <button
                  onClick={() => onRefreshMetadata(media)}
                  title="Re-fetch metadata from TMDB/TVDB (auto-match)"
                  className="h-11 inline-flex items-center gap-2 px-6 rounded-full font-medium transition-all bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.06] text-white/80 whitespace-nowrap"
                >
                  <Icon name="refresh" size={16} />
                  Refresh
                </button>
              )}
              {onIdentify && (
                <button
                  onClick={() => onIdentify(media)}
                  title="Manually search TMDB/TVDB and pick the correct match"
                  className="h-11 inline-flex items-center gap-2 px-6 rounded-full font-medium transition-all bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-200 whitespace-nowrap"
                >
                  <Icon name="info" size={16} />
                  Identify
                </button>
              )}
            </div>

            {/* Phase 5.3 final QA — version chips moved INTO the hero
                next to the action buttons. Previously buried below
                the cast section, where users had to scroll past it
                AFTER deciding to play. Versions are a pre-play
                choice (4K vs 1080p vs alt cut), so they belong next
                to Play. Only renders for movies with 2+ files. */}
            {media.type !== 'show' && files && files.length > 1 && onPlayFile && (
              <div className="mt-4 flex items-center gap-2 flex-wrap">
                <span className="text-white/40 text-xs uppercase tracking-wider mr-1">Play in</span>
                {files.map(f => {
                  const tag = f.version_tag || f.resolution || 'Unknown'
                  const is4K = /4k|2160|uhd/i.test(`${f.version_tag || ''} ${f.resolution || ''}`)
                  const sizeGB = f.size_bytes ? (f.size_bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB' : ''
                  const codec = [f.video_codec, f.audio_codec].filter(Boolean).join('/')
                  return (
                    <button
                      key={f.id}
                      onClick={() => onPlayFile(media, f.id)}
                      title={[codec, sizeGB, f.library_name].filter(Boolean).join(' · ')}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border whitespace-nowrap ${
                        is4K
                          ? 'bg-purple-600/25 border-purple-500/50 text-purple-100 hover:bg-purple-600/40 hover:border-purple-400'
                          : 'bg-white/[0.06] border-white/[0.1] text-white/85 hover:bg-white/[0.1] hover:text-white'
                      }`}
                    >
                      {tag}
                      {f.library_name && <span className="text-white/40 ml-1 font-normal">[{f.library_name}]</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-8 py-8">
        {/* Phase 5.3 final QA — Cast row. Avatars + name + character
            from server's CastMember[] (role_type === 'cast'). Mirrors
            V1 (aurora_pro.html renderCast). Horizontal scroll on
            overflow so the row never wraps onto multiple lines on a
            wide cast (TV shows can have 20+ regulars). */}
        {castMembers.length > 0 && (
          <div className="mb-10">
            <h3 className="text-white text-lg font-semibold mb-4">Cast</h3>
            <div className="flex gap-6 overflow-x-auto pb-4 scrollbar-hide">
              {castMembers.slice(0, 20).map((c) => (
                <CastCard key={c.id} member={c} />
              ))}
            </div>
          </div>
        )}

        {/* Phase 5.3 final QA — Media Info (audio/subtitle tracks).
            V1 surfaces this so users can see if their content has
            a 5.1 mix, foreign-language tracks, or forced subs before
            they hit play. Two-column grid; gracefully hides empty
            halves. */}
        {(audioTracks.length > 0 || subtitleTracks.length > 0) && (
          <div className="mb-10">
            <h3 className="text-white text-lg font-semibold mb-4">Media Info</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {audioTracks.length > 0 && (
                <div>
                  <h4 className="text-white/40 text-xs uppercase tracking-wider mb-2">Audio Tracks</h4>
                  <div className="space-y-1">
                    {audioTracks.map((t, i) => (
                      <div key={`a-${i}`} className="text-sm text-white/80 py-1.5 border-b border-white/[0.04] last:border-0">
                        <span className="text-white/60 uppercase mr-2">{t.language || 'und'}</span>
                        <span className="text-white/85">{t.codec.toUpperCase()}</span>
                        {/* Audit H1 — server emits `channels:0` without
                            omitempty when ffprobe couldn't detect.
                            `t.channels && X` would render the literal
                            "0" in JSX; explicit `> 0` avoids that. */}
                        {t.channels !== undefined && t.channels > 0 && (
                          <span className="text-white/50"> · {t.channels}ch</span>
                        )}
                        {t.title && <span className="text-white/50"> · {t.title}</span>}
                        {t.is_default && <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] bg-purple-500/15 text-purple-300 rounded">Default</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {subtitleTracks.length > 0 && (
                <div>
                  <h4 className="text-white/40 text-xs uppercase tracking-wider mb-2">Subtitles</h4>
                  <div className="space-y-1">
                    {subtitleTracks.map((t, i) => (
                      <div key={`s-${i}`} className="text-sm text-white/80 py-1.5 border-b border-white/[0.04] last:border-0">
                        <span className="text-white/60 uppercase mr-2">{t.language || 'und'}</span>
                        <span className="text-white/85">{t.codec.toUpperCase()}</span>
                        {t.title && <span className="text-white/50"> · {t.title}</span>}
                        {t.forced && <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-300 rounded">Forced</span>}
                        {t.default && <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] bg-purple-500/15 text-purple-300 rounded">Default</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* M10 Phase 4.5 — Season picker. Only renders when there's
            more than one season; single-season shows would just have
            a redundant "S1" chip. */}
        {seasons && seasons.length > 1 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white/40 text-xs uppercase tracking-wider mr-2">Season</span>
              {seasons.map(s => (
                <button
                  key={s.season_number}
                  onClick={() => onSelectSeason?.(s.season_number)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                    selectedSeason === s.season_number
                      ? 'bg-purple-600/25 border-purple-500/40 text-purple-200'
                      : 'bg-white/[0.03] border-white/[0.06] text-white/60 hover:bg-white/[0.06] hover:text-white/85'
                  }`}
                  title={s.episode_count ? `${s.episode_count} episodes` : undefined}
                >
                  S{s.season_number}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Episodes — M10 Phase 2: real episodes from the API.
            apiEpisodes is undefined for movies (no episode rail) and
            an empty array while loading (we don't render a stub —
            the description block already shows "Loading details…").
            Phase 5.3 final QA: click ALWAYS fires; missing-file
            episodes route to onEpisodeUnavailable so the App layer
            can surface a toast instead of the user wondering why
            their click did nothing. */}
        {apiEpisodes && apiEpisodes.length > 0 && (
          <div>
            <h3 className="text-white text-lg font-semibold mb-4">
              {selectedSeason ? `Season ${selectedSeason}` : 'Episodes'}
              <span className="text-white/40 text-sm font-normal ml-2">({apiEpisodes.length})</span>
            </h3>
            <div className="space-y-2">
              {apiEpisodes.map((ep) => {
                const hasFile = !!(ep.files && ep.files.length > 0)
                const runtime = ep.runtime_minutes
                  ? `${ep.runtime_minutes}m`
                  : ''
                // Per-episode still: server pre-renders `still_url`
                // on EpisodeDetail. Falls back to the show backdrop
                // when an episode lacks a TMDB still (older shows,
                // pre-air, etc.).
                const stillImg = ep.still_url || realBackdrop
                return (
                  <button
                    key={ep.id}
                    type="button"
                    className={`w-full text-left flex items-center gap-4 p-3 rounded-xl bg-white/[0.02] border border-white/[0.04] transition-all group hover:bg-white/[0.05] hover:border-purple-500/30 cursor-pointer ${
                      hasFile ? '' : 'opacity-70'
                    }`}
                    onClick={() => {
                      // Keep these branches separate so a "has file"
                      // case can never fall through to the
                      // unavailable toast and lie about file presence.
                      if (hasFile) {
                        onPlayEpisode?.(ep)
                        return
                      }
                      onEpisodeUnavailable?.(ep)
                    }}
                    title={hasFile ? 'Play episode' : 'No file available — scan the library or wait for the next pull'}
                  >
                    <div className="w-[160px] h-[90px] rounded-lg overflow-hidden flex-shrink-0 relative bg-white/5">
                      <img src={stillImg} alt="" className="w-full h-full object-cover" loading="lazy" />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          hasFile ? 'bg-purple-600/90' : 'bg-white/20'
                        }`}>
                          <Icon name={hasFile ? 'play' : 'info'} size={16} className="ml-0.5" />
                        </div>
                      </div>
                      {!hasFile && (
                        <div className="absolute top-1 right-1 px-1.5 py-0.5 text-[9px] uppercase tracking-wider rounded bg-black/60 text-white/70">
                          No file
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-purple-400 text-sm font-semibold">E{ep.episode_number}</span>
                        <h4 className="text-white text-sm font-medium truncate">{ep.title || `Episode ${ep.episode_number}`}</h4>
                      </div>
                      {ep.overview && <p className="text-white/40 text-xs line-clamp-2">{ep.overview}</p>}
                    </div>
                    {runtime && <span className="text-white/40 text-sm flex-shrink-0">{runtime}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {/* Empty-state for shows with no episodes loaded. */}
        {media.type === 'show' && (!apiEpisodes || apiEpisodes.length === 0) && !loading && (
          <p className="text-white/40 text-sm">No episodes available yet.</p>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────── LIBRARY VIEW ─────────────────────── */
// My Library — user-saved titles (the + button on cards) plus a
// Continue Watching section. Saved items are the headline; Continue
// Watching appears below as a secondary surface. Saved state lives
// in App-level `library` and is persisted to localStorage.
function LibraryView({ library, continueItems, onSelect, onToggleLib, onPlayContinue }: {
  library: Media[]
  continueItems: ContinueWatchingItem[]
  onSelect: (m: Media) => void
  onToggleLib: (m: Media) => void
  // 2026-05-27 — Continue Watching one-click resume in the
  // LibraryView CW grid. When set, each CW card gets a Resume pill
  // on hover (same pattern as the home CW rail). Optional so the
  // type stays compatible with callers that don't wire it.
  onPlayContinue?: (c: ContinueWatchingItem) => void
}) {
  const [filter, setFilter] = useState<'all' | 'movie' | 'show'>('all')
  const filteredLibrary = filter === 'all'
    ? library
    : library.filter(m => (filter === 'show' ? (m.type === 'show' || m.type === 'anime') : m.type === filter))
  const libraryIds = useMemo(() => new Set(library.map(m => m.id)), [library])
  // Deep-debug H3 — latest-continueItems ref so the Resume pill
  // click handler resolves the freshest record at click-time, not
  // render-time. Without this, a mid-hover refetch (e.g. cross-tab
  // playback updated position_ms) would dispatch a stale record.
  const continueItemsRef = useRef(continueItems)
  useEffect(() => { continueItemsRef.current = continueItems }, [continueItems])

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 mb-3">
          <Icon name="library" size={12} className="text-purple-300" />
          <span className="text-purple-200 text-xs font-medium uppercase tracking-wider">Saved by You</span>
        </div>
        <h1 className="text-white text-4xl font-bold font-display">My Library</h1>
        <p className="text-white/60 text-sm mt-2">
          {library.length === 0
            ? 'Hover any card and click + to save titles here.'
            : library.length === 1
              ? '1 saved title.'
              : `${library.length} saved titles.`}
        </p>
      </div>

      {/* Filter pills — only relevant when there are saved items */}
      {library.length > 0 && (
        <div className="flex items-center gap-3 mb-6">
          {(['all', 'movie', 'show'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                filter === f
                  ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                  : 'bg-white/5 text-white/50 border border-white/[0.06] hover:bg-white/10'
              }`}
            >
              {f === 'all' ? 'All' : f === 'movie' ? 'Movies' : 'TV Shows'}
            </button>
          ))}
        </div>
      )}

      {/* Saved items grid.
          QA BUG-003 — the empty-state copy was "Your library is empty",
          which read as contradictory when the Continue Watching rail
          below it had items. Distinguish the two surfaces in the
          copy: "saved titles" vs "in-progress watches". */}
      {library.length === 0 ? (
        <div className="text-center py-16">
          <Icon name="library" size={48} className="mx-auto text-purple-400/30 mb-4" />
          <h3 className="text-white/70 text-lg mb-2">No saved titles yet</h3>
          <p className="text-white/40 text-sm max-w-md mx-auto">
            Hover any title and click the <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-500/40 border border-purple-300/40 text-white text-[10px] font-bold align-middle mx-0.5">+</span> in the top-left to bookmark it here.{continueItems.length > 0 ? ' Your in-progress watches still appear in the Continue Watching rail below.' : ''}
          </p>
        </div>
      ) : filteredLibrary.length === 0 ? (
        <p className="text-white/40 text-sm">No {filter === 'movie' ? 'movies' : 'TV shows'} saved.</p>
      ) : (
        // 2028-05-28 — Saved library grid converted to <MediaCardCinema/>
        // so My Library matches the home rails. The library is a closed
        // set (every card IS in the library) so onToggleLib here is
        // always a "remove" — MediaCardCinema renders the filled-purple
        // ✓ state because libraryIds.has(m.id) is always true. The
        // click on the badge triggers onToggleLib which fires the remove.
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5 mb-12">
          {filteredLibrary.map((m) => (
            <MediaCardCinema
              key={m.id}
              item={m}
              onSelect={() => onSelect(m)}
              libraryIds={libraryIds}
              onToggleLib={() => onToggleLib(m)}
            />
          ))}
        </div>
      )}

      {/* Continue Watching — secondary section below Saved */}
      {continueItems.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Icon name="clock" size={16} className="text-purple-300" />
            <h2 className="text-white text-xl font-semibold">Continue Watching</h2>
            <span className="text-white/40 text-sm">({continueItems.length})</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
            {continueItems.map(c => {
              const m = mapContinueToMedia(c)
              const sub = c.type === 'show' && c.season_number && c.episode_number
                ? `S${c.season_number}E${c.episode_number}`
                : (c.year ? String(c.year) : undefined)
              // mapContinueToMedia already normalizes progress to 0..1
              // (api.ts:1689 divides by 100 — server emits 0-100). The
              // `m` here carries it on m.progress, so no per-card
              // wrapper needed. Rating=0 is also from mapContinueToMedia
              // and the card's meta-star guard hides the star.
              // 2026-05-27 — Resume pill: one click on the pill
              // resumes via App's handlePlayContinue (threaded
              // through as onPlayContinue prop). Shared RESUME_THRESHOLD
              // via isResumable() — same gate as Hero, home CW rail,
              // DetailView. Deep-debug H3 — read continueItems via
              // ref at click-time so a mid-hover refresh doesn't
              // dispatch a stale record.
              const resumeHandler = onPlayContinue && isResumable(c)
                ? () => {
                    const latest = continueItemsRef.current.find(
                      x => x.media_item_id === c.media_item_id
                        && x.episode_id === c.episode_id,
                    )
                    if (latest && isResumable(latest)) onPlayContinue(latest)
                  }
                : undefined
              return (
                <MediaCardCinema
                  key={`${c.media_item_id}-${c.episode_id ?? ''}`}
                  item={m}
                  onSelect={() => onSelect(m)}
                  libraryIds={libraryIds}
                  onToggleLib={() => onToggleLib(m)}
                  subtitle={sub}
                  onResume={resumeHandler}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────── REQUEST ERROR HUMANIZER ─────────────────────── */
// Server-side request errors are raw Radarr/Sonarr/TVDB API
// responses meant for logs. Pattern-match the common shapes and
// surface a short, friendly sentence. The raw error stays available
// as a tooltip in RequestsView for admin debugging.
function humanizeRequestError(raw: string, mediaType: 'movie' | 'tv'): string {
  if (!raw) return ''
  const r = raw.toLowerCase()
  const kind = mediaType === 'tv' ? 'show' : 'movie'

  // Already-added: Radarr's MovieExistsValidator / Sonarr's
  // SeriesExistsValidator. Common when a user re-requests after a
  // successful add, or a TMDB ID was matched to an existing import.
  if (r.includes('movieexistsvalidator') || r.includes('this movie has already been added')
      || r.includes('seriesexistsvalidator') || r.includes('this series has already been added')) {
    return mediaType === 'tv'
      ? 'This series is already in your Sonarr library.'
      : 'This movie is already in your Radarr library.'
  }

  // TVDB miss — show hasn't propagated yet or doesn't exist on
  // TVDB at all (common for Asian content with non-Latin titles).
  if (r.includes('tvdb') && (r.includes('not found') || r.includes('not be added to tvdb yet') || r.includes("couldn't find") || r.includes('series not found'))) {
    return `TVDB doesn't have this ${kind} yet — try again in a few hours or add it manually at thetvdb.com.`
  }

  // Sonarr's TMDB→TVDB resolver failed
  if (r.includes('sonarr') && (r.includes('lookup') || r.includes('resolve'))) {
    return `Sonarr couldn't match this ${kind} to a TVDB entry.`
  }

  // Generic *arr API failures (4xx/5xx from the *arr endpoint)
  if (r.includes('failed to add') && r.includes('radarr')) {
    return 'Radarr rejected this request. The download server may be busy — try again shortly.'
  }
  if (r.includes('failed to add') && r.includes('sonarr')) {
    return 'Sonarr rejected this request. The download server may be busy — try again shortly.'
  }

  // Network / auth — Aurora's own client-side translation
  if (r.includes('connection refused') || r.includes('econnrefused') || r.includes('dial tcp')) {
    return 'Couldn\'t reach the download server. Check that Radarr/Sonarr is online.'
  }
  if (r.includes('timeout') || r.includes('deadline exceeded')) {
    return 'The download server took too long to respond. Try again in a moment.'
  }
  if (r.includes('401') || r.includes('unauthorized') || r.includes('api key')) {
    return 'Download server rejected our API key. Ask an admin to verify keys in Admin → Integrations.'
  }
  if (r.includes('quality profile') || r.includes('qualityprofile')) {
    return 'Quality profile not configured. An admin needs to pick a default in Admin → Integrations.'
  }

  // Path / root folder problems
  if (r.includes('root folder') || r.includes('rootfolder')) {
    return 'Download server has no root folder configured. An admin needs to set one.'
  }

  // No matches from TMDB search (very rare since we usually only
  // submit valid TMDB IDs, but possible if metadata changed since)
  if (r.includes('no matches') || r.includes('no results')) {
    return `We couldn't find a matching ${kind}. The metadata may have changed since you requested.`
  }

  // Fall back: strip the noisy JSON-validator block (the
  // `[{ "propertyName": ..., "errorMessage": ... }]` payload) and
  // present whatever readable prefix remains. If the result is
  // still too long or looks like raw API output, use a generic.
  const stripped = raw
    .replace(/\[\s*\{[\s\S]*\}\s*\]/g, '')     // strip JSON arrays
    .replace(/api error \(status \d+\):?\s*/i, '')
    .replace(/^[a-z]+: /i, '')                   // strip "radarr:" prefixes
    .trim()
    .replace(/\s+/g, ' ')
  if (stripped.length > 0 && stripped.length < 140) {
    // Capitalize first letter for sentence-case polish.
    return stripped[0].toUpperCase() + stripped.slice(1)
  }
  return 'Something went wrong on the download server. Hover for technical details.'
}

/* ─────────────────────── REQUESTS VIEW ─────────────────────── */
// RequestsView — submitted requests with status. Includes an inline
// TMDB search + create dialog.
function RequestsView({ requests, onRequestSubmitted, onRequestDeleted }: { requests: MediaRequest[] | null; onRequestSubmitted: (r: MediaRequest) => void; onRequestDeleted: (id: number) => void }) {
  const [filter, setFilter] = useState<'all' | 'pending' | 'processing' | 'available' | 'failed'>('all')
  // QA 2026-05-25 — request cards looked clickable but didn't do
  // anything when clicked. The request carries `overview` text from
  // TMDB that we were fetching and storing but never rendering. Now:
  // clicking a card toggles an inline overview reveal. Tracks which
  // request IDs are currently expanded so multiple can be open at
  // once. Closes on a second click. Stays a no-op if overview is
  // empty (some older TMDB entries have nothing).
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  // Inline TMDB search + create dialog.
  const [createOpen, setCreateOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<TmdbSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState<number | null>(null) // tmdb_id currently submitting
  // 4K toggle — default false. We can't easily probe whether a 4K
  // ARR service is configured here, so we always offer it.
  const [requestQuality4K, setRequestQuality4K] = useState(false)
  useEffect(() => {
    if (!createOpen) return
    const q = searchQ.trim()
    if (!q) { setSearchResults([]); return }
    setSearching(true)
    const ac = new AbortController()
    const id = window.setTimeout(() => {
      void searchTmdb(q, ac.signal).then(r => setSearchResults(r)).catch(() => setSearchResults([])).finally(() => setSearching(false))
    }, 300)
    return () => { window.clearTimeout(id); ac.abort() }
  }, [searchQ, createOpen])

  const statusColors: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    processing: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    available: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    failed: 'bg-red-500/10 text-red-400 border-red-500/20',
  }

  if (requests === null) {
    return (
      <div className="animate-fade-in">
        <div className="mb-6">
          <h1 className="text-white text-3xl font-bold font-display">Requests</h1>
          <p className="text-white/40 text-sm mt-2">Loading requests…</p>
        </div>
      </div>
    )
  }

  const filtered = filter === 'all' ? requests : requests.filter(r => r.status === filter)

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-white text-3xl font-bold font-display">Requests</h1>
          <p className="text-white/50 text-sm mt-1">{requests.length} total</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          Request New
        </button>
      </div>

      {/* Phase 4.6 — TMDB search + create dialog. Small modal so
          users don't lose scroll position in the requests list. */}
      {createOpen && (
        <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 pt-20" onClick={() => setCreateOpen(false)}>
          <div className="w-full max-w-xl bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-5 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white text-lg font-semibold">Request a Movie or TV Show</h2>
              <button onClick={() => setCreateOpen(false)} className="w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/70 hover:text-white text-lg flex items-center justify-center">×</button>
            </div>
            <input
              type="text"
              autoFocus
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Search TMDB for title…"
              className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-sm focus:outline-none focus:bg-white/[0.06] mb-3"
            />
            {/* 4K request toggle. Server-side, this routes to the
                configured *_4k Radarr/Sonarr; without one it falls
                back to the 1080p ARR. */}
            <label className="flex items-center gap-2 mb-3 text-sm text-white/70">
              <input type="checkbox" checked={requestQuality4K} onChange={e => setRequestQuality4K(e.target.checked)} />
              Request in 4K when available
            </label>
            <div className="flex-1 overflow-y-auto space-y-2">
              {searching && <p className="text-white/40 text-sm">Searching…</p>}
              {!searching && searchResults.length === 0 && searchQ.trim() && <p className="text-white/40 text-sm">No matches.</p>}
              {searchResults.map(r => (
                <div key={`${r.media_type}-${r.tmdb_id}`} className="flex items-center gap-3 p-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.04]">
                  {/* QA 2026-05-25 — explicit placeholder for entries
                      with no TMDB poster (older + obscure titles).
                      Previously rendered as an empty box; now shows
                      a film/TV glyph centered in the same frame, so
                      the row layout stays consistent. */}
                  <div className="w-[50px] h-[75px] rounded bg-white/5 flex-shrink-0 overflow-hidden flex items-center justify-center">
                    {r.poster_path ? (
                      // crossOrigin so the BugReport screenshot
                      // capture (html2canvas with useCORS) can
                      // include this image in the canvas without
                      // tainting it. TMDB serves Access-Control-
                      // Allow-Origin: * so the request succeeds.
                      <img src={tmdbPosterURL(r.poster_path)} alt="" crossOrigin="anonymous" className="w-full h-full object-cover" />
                    ) : (
                      <Icon name={r.media_type === 'tv' ? 'tv' : 'film'} size={20} className="text-white/25" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white/90 text-sm font-medium truncate">{r.title}{r.year ? ` (${r.year})` : ''}</p>
                    <p className="text-white/40 text-xs uppercase">{r.media_type === 'tv' ? 'TV' : 'Movie'}</p>
                  </div>
                  <button
                    disabled={submitting === r.tmdb_id}
                    onClick={async () => {
                      setSubmitting(r.tmdb_id)
                      try {
                        const created = await createRequest({
                          media_type: r.media_type,
                          tmdb_id: r.tmdb_id,
                          title: r.title,
                          poster_path: r.poster_path || '',
                          overview: r.overview || '',
                          year: r.year || 0,
                          quality_1080p: !requestQuality4K,
                          quality_4k: requestQuality4K,
                        })
                        onRequestSubmitted(created)
                        setCreateOpen(false)
                        setSearchQ('')
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : 'Failed to submit'
                        window.alert('Request failed: ' + msg)
                      } finally {
                        setSubmitting(null)
                      }
                    }}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitting === r.tmdb_id ? 'Submitting…' : 'Request'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-6 flex-wrap">
        {(['all', 'pending', 'processing', 'available', 'failed'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all capitalize ${
              filter === f
                ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                : 'bg-white/5 text-white/50 border border-white/[0.06] hover:bg-white/10'
            }`}
          >
            {f} {f !== 'all' && `(${requests.filter(r => r.status === f).length})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20">
          <Icon name="download" size={48} className="mx-auto text-white/20 mb-4" />
          <h3 className="text-white/60 text-lg mb-2">No requests {filter !== 'all' ? `in "${filter}"` : 'yet'}</h3>
          <p className="text-white/40 text-sm">Use the "Request New" button above to submit one.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map(req => {
            const poster = tmdbPosterURL(req.poster_path)
            const isExpanded = expanded.has(req.id)
            const hasOverview = !!req.overview && req.overview.trim().length > 0
            const toggle = () => {
              if (!hasOverview) return
              setExpanded(prev => {
                const next = new Set(prev)
                if (next.has(req.id)) next.delete(req.id)
                else next.add(req.id)
                return next
              })
            }
            return (
              <div key={req.id} className={`glass-card rounded-xl p-4 flex gap-4 ${hasOverview ? 'cursor-pointer hover:bg-white/[0.02] transition-colors' : 'cursor-default'}`}
                onClick={toggle}
                role={hasOverview ? 'button' : undefined}
                aria-expanded={hasOverview ? isExpanded : undefined}
                aria-label={hasOverview ? `${req.title}, click to ${isExpanded ? 'hide' : 'show'} overview` : undefined}
              >
                <div className="w-[70px] h-[105px] rounded-lg overflow-hidden flex-shrink-0 bg-white/5">
                  {poster ? <img src={poster} alt={req.title} crossOrigin="anonymous" className="w-full h-full object-cover" /> : null}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-white text-sm font-semibold truncate">{req.title}{req.year ? ` (${req.year})` : ''}</h3>
                  <div className="flex items-center gap-2 mt-1 mb-2 flex-wrap">
                    <span className="text-white/40 text-xs uppercase">{req.media_type === 'tv' ? 'TV' : 'Movie'}</span>
                    {req.quality_4k && <span className="badge-glass bg-purple-500/10 text-purple-300 border border-purple-500/20 text-[10px]">4K</span>}
                    {req.quality_1080p && <span className="badge-glass bg-white/[0.04] text-white/60 border border-white/[0.06] text-[10px]">1080p</span>}
                  </div>
                  {hasOverview && isExpanded && (
                    <p className="text-white/60 text-xs mb-2 leading-relaxed">{req.overview}</p>
                  )}
                  {req.error_message && (
                    // Phase 5.3 final QA — show humanized error in
                    // the body; keep the raw server response in the
                    // tooltip so admins can still debug.
                    <p className="text-red-400 text-xs mb-2 line-clamp-2" title={req.error_message}>
                      {humanizeRequestError(req.error_message, req.media_type)}
                    </p>
                  )}
                  <div className="flex items-center justify-between">
                    <span className={`badge-glass border text-xs capitalize ${statusColors[req.status]}`}>
                      {req.status}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-white/30 text-xs">{formatRequestDate(req.requested_at)}</span>
                      {(req.status === 'pending' || req.status === 'failed') && (
                        <button
                          onClick={async (e) => {
                            // Wrap click stops propagation to the
                            // newly-clickable card wrapper — without
                            // this, clicking delete also toggles the
                            // overview expand.
                            e.stopPropagation()
                            if (!window.confirm(`Delete request for "${req.title}"?`)) return
                            try {
                              await deleteRequest(req.id)
                              onRequestDeleted(req.id)
                            } catch (err) {
                              window.alert('Delete failed: ' + (err instanceof Error ? err.message : 'unknown'))
                            }
                          }}
                          className="text-red-400/70 hover:text-red-300 text-xs"
                          title="Delete request"
                        >
                          delete
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function formatRequestDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!t) return ''
  const diff = Date.now() - t
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(iso).toLocaleDateString()
}

/* ─────────────────────── SETTINGS VIEW ─────────────────────── */
interface SettingsViewProps {
  user?: ApiUser
  onLogout?: () => void
}
function SettingsView({ user: settingsUser, onLogout }: SettingsViewProps = {}) {
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
          </div>
        </div>

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
                    <p className="text-white/80 text-sm font-medium">{item.label}</p>
                    <p className="text-white/40 text-xs">{item.desc}</p>
                  </div>
                  <button
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
              <select value={settings.audioLang} onChange={(e) => setSettings(p => ({ ...p, audioLang: e.target.value }))} className="text-sm py-2 px-3">
                <option value="en">English</option>
                <option value="ja">Japanese</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/80 text-sm font-medium">Subtitle Language</p>
                <p className="text-white/40 text-xs">Preferred subtitle track</p>
              </div>
              <select value={settings.subtitleLang} onChange={(e) => setSettings(p => ({ ...p, subtitleLang: e.target.value }))} className="text-sm py-2 px-3">
                <option value="en">English</option>
                <option value="ja">Japanese</option>
                <option value="es">Spanish</option>
                <option value="">None</option>
              </select>
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
    </div>
  )
}

/* ─────────────────────── SEARCH VIEW ─────────────────────── */
// SearchView — debounced 300ms per keystroke (the semantic path is
// LLM-routed and not free).
function SearchView({ query, onSelect, libraryIds, onToggleLib }: {
  query: string
  onSelect: (m: Media) => void
  // 2028-05-28 (deep-debug Bug C) — dropped the dead `onPlay?` prop. The
  // cinema card has no hover Play CTA for it to attach to, and the
  // SearchView body never read it; leaving it in the type implied a
  // behavior that never fired. Call site must also drop `onPlay={handlePlay}`.
  // My Library + button — same contract as MediaRail / BrowseView.
  libraryIds?: Set<number>
  onToggleLib?: (m: Media) => void
}) {
  const [results, setResults] = useState<Media[]>([])
  // Driven by the server's X-Search-Mode response — only show the
  // Smart badge when semantic search actually fired.
  const [searchMode, setSearchMode] = useState<'literal' | 'semantic'>('literal')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Track the most-recent query the user typed so a late-resolving
  // response from a stale query doesn't overwrite the current results.
  const lastQueryRef = useRef<string>('')

  useEffect(() => {
    lastQueryRef.current = query
    setError(null)
    const q = query.trim()
    if (!q) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const ac = new AbortController()
    const debounceId = window.setTimeout(() => {
      // Server-side: trigram + optional semantic routing. Endpoint
      // returns an array, not a paginated envelope.
      void (async () => {
        try {
          const r = await searchMedia(q, 30, ac.signal)
          // Ignore stale responses (debounce can let an old request
          // through if the user types fast).
          if (lastQueryRef.current !== q) return
          setResults(r.items as Media[])
          setSearchMode(r.mode)
        } catch (err) {
          if (err && (err as Error).name === 'AbortError') return
          if (lastQueryRef.current !== q) return
          setError(err instanceof Error ? err.message : 'Search failed')
          setResults([])
        } finally {
          if (lastQueryRef.current === q) setLoading(false)
        }
      })()
    }, 300)
    return () => {
      window.clearTimeout(debounceId)
      ac.abort()
    }
  }, [query])

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-white text-3xl font-bold font-display">Search Results</h1>
          {/* Smart badge renders only when the server actually used
              the semantic path. */}
          {!loading && results.length > 0 && searchMode === 'semantic' && (
            <span className="px-3 py-1 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-200 text-xs font-medium">
              ✨ Smart search
            </span>
          )}
        </div>
        <p className="text-white/50 text-sm mt-1">
          {loading
            ? `Searching for "${query}"…`
            : query
              ? `${results.length} result${results.length === 1 ? '' : 's'} for "${query}"`
              : 'Type in the search box above to find titles'}
        </p>
        {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
      </div>

      {!loading && query && results.length === 0 && !error ? (
        <div className="text-center py-20">
          <Icon name="search" size={48} className="mx-auto text-white/20 mb-4" />
          <h3 className="text-white/60 text-lg">No results found</h3>
          <p className="text-white/40 text-sm mt-1">Try a different search term</p>
        </div>
      ) : (
        // 2028-05-28 — Search results converted to <MediaCardCinema/>
        // for consistency with the rest of the app.
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
          {results.map(item => (
            <MediaCardCinema
              key={item.id}
              item={item}
              onSelect={() => onSelect(item)}
              libraryIds={libraryIds}
              onToggleLib={onToggleLib ? () => onToggleLib(item) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}

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
      <div className="glass-panel rounded-xl p-6">
        <h3 className="text-white font-semibold mb-2">Database Backup</h3>
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

      <div className="glass-panel rounded-xl p-6" style={{ border: '1px solid rgba(255, 175, 0, 0.25)' }}>
        <h3 className="font-semibold mb-2" style={{ color: '#ffd685' }}>Database Restore</h3>
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
    <div className="glass-panel rounded-xl p-6">
      <h3 className="text-white font-semibold mb-2">Now Playing</h3>
      <p className="text-white/40 text-sm">No active streams.</p>
    </div>
  )
  return (
    <div className="glass-panel rounded-xl p-6">
      <h3 className="text-white font-semibold mb-4">Now Playing ({items.length})</h3>
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
      <div className="glass-panel rounded-xl p-6">
        <h3 className="text-white font-semibold mb-2">Updates</h3>
        <p className="text-white/40 text-sm">{error ?? 'Loading update status…'}</p>
      </div>
    )
  }

  const meta = updateStateMeta(status.state)
  const isActive = ACTIVE_STATES.has(status.state)
  const shortSha = (s?: string | null) => (s ? s.slice(0, 7) : null)

  return (
    <div className="glass-panel rounded-xl p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-white font-semibold">Updates</h3>
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
      <div className="glass-panel rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">Add Library</h3>
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
      <div className="glass-panel rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">Existing Libraries</h3>
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
      <div className="glass-panel rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">Server Settings</h3>
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

      <div className="glass-panel rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">Image Cache</h3>
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

      <div className="glass-panel rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">Radarr / Sonarr (Requests)</h3>
        {settings && (['radarr', 'radarr_4k', 'sonarr', 'sonarr_4k'] as const).map(svc => {
          const urlKey = `${svc}_url`, keyKey = `${svc}_api_key`
          const label = svc === 'radarr' ? 'Radarr' : svc === 'radarr_4k' ? 'Radarr 4K' : svc === 'sonarr' ? 'Sonarr' : 'Sonarr 4K'
          return (
            <div key={svc} className="border-b border-white/[0.04] last:border-0 py-3">
              <p className="text-white/80 text-sm mb-2">{label}</p>
              <div className="flex gap-2 flex-wrap">
                <input value={val(urlKey, '')} onChange={e => setVal(urlKey, e.target.value)} placeholder="http://radarr:7878" className="flex-1 min-w-[200px] px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
                <input type="password" defaultValue="" onChange={e => setVal(keyKey, e.target.value)} placeholder={settings[keyKey] ? 'API Key (saved)' : 'API Key'} className="flex-1 min-w-[200px] px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
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
      <div className="glass-panel rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">Create Persistent Room</h3>
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
      <div className="glass-panel rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">Existing Rooms</h3>
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
    <div className="glass-panel rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-semibold">Active Streams</h3>
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
              <h3 className="text-white font-semibold">Session diagnostic</h3>
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

function AdminFlaggedTab(_props: { onSelect: (id: number) => void }) {
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
    <div className="glass-panel rounded-xl p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h3 className="text-white font-semibold">Flagged Items</h3>
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

// Phase 5.3 — Manual match modal. Search TMDB (and TVDB for shows),
// pick a candidate, confirm. Posts to /api/media/{id}/match. Also
// supports direct-ID entry for the case where the user has the
// TMDB/TVDB ID handy from a browser tab.
function ManualMatchModal({ target, onClose, onMatched }: {
  target: ServerMediaItem
  onClose: () => void
  onMatched: () => void
}) {
  const isShow = target.type === 'show'
  const [q, setQ] = useState(target.title)
  const [results, setResults] = useState<MatchSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [directIdSource, setDirectIdSource] = useState<'tmdb' | 'tvdb'>('tmdb')
  const [directId, setDirectId] = useState('')
  useEffect(() => {
    const term = q.trim()
    if (!term) { setResults([]); return }
    const ac = new AbortController()
    setSearching(true)
    const t = window.setTimeout(() => {
      void searchForMatch(term, isShow ? 'show' : 'movie', ac.signal)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => { window.clearTimeout(t); ac.abort() }
  }, [q, isShow])

  const submit = async (source: 'tmdb' | 'tvdb', id: number) => {
    setSubmitting(true)
    try {
      const body: { tmdb_id?: number; tvdb_id?: number; type: 'movie' | 'show' } = {
        type: isShow ? 'show' : 'movie',
      }
      if (source === 'tvdb') body.tvdb_id = id
      else body.tmdb_id = id
      await manualMatch(target.id, body)
      window.alert(`Matched "${target.title}". Metadata is re-enriching in the background.`)
      onMatched()
    } catch (err) {
      window.alert('Match failed: ' + (err instanceof Error ? err.message : 'unknown'))
    } finally { setSubmitting(false) }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 pt-16" onClick={onClose}>
      <div className="w-full max-w-xl bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-5 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-white text-lg font-semibold">Match "{target.title}"</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/70 hover:text-white text-lg flex items-center justify-center">×</button>
        </div>
        <p className="text-white/40 text-xs mb-3 truncate">{target.file_path}</p>

        <input
          type="text"
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={isShow ? 'Search TMDB or TVDB for the show…' : 'Search TMDB for the movie…'}
          className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-sm focus:outline-none focus:bg-white/[0.06] mb-3"
        />

        <div className="flex-1 overflow-y-auto space-y-2 mb-3">
          {searching && <p className="text-white/40 text-sm">Searching…</p>}
          {!searching && q.trim() && results.length === 0 && <p className="text-white/40 text-sm">No candidates.</p>}
          {results.map(r => (
            <div key={`${r.source}-${r.id}`} className="flex items-center gap-3 p-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.04]">
              <div className="w-[50px] h-[75px] rounded bg-white/5 flex-shrink-0 overflow-hidden flex items-center justify-center">
                {/* Audit L3 (Phase 5.3 audit-8) — TMDB posters are
                    relative paths (need CDN prefix); TVDB
                    image_url is a full URL (render directly).
                    QA 2026-05-25 — explicit glyph fallback for
                    posterless candidates. */}
                {r.poster_path ? (
                  <img
                    src={r.source === 'tvdb' ? r.poster_path : tmdbPosterURL(r.poster_path)}
                    alt=""
                    crossOrigin="anonymous"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Icon name="film" size={20} className="text-white/25" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white/90 text-sm font-medium truncate">{r.title}{r.year ? ` (${r.year})` : ''}</p>
                <p className="text-white/40 text-[10px] uppercase">{r.source} · id {r.id}</p>
                {r.overview && <p className="text-white/40 text-xs line-clamp-2 mt-1">{r.overview}</p>}
              </div>
              <button
                disabled={submitting}
                onClick={() => void submit(r.source, r.id)}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded disabled:opacity-50"
              >
                Match
              </button>
            </div>
          ))}
        </div>

        {/* Direct-ID path — when the user has a TMDB/TVDB ID in hand. */}
        <div className="border-t border-white/[0.06] pt-3">
          <p className="text-white/40 text-xs mb-2">Or match by ID directly:</p>
          <div className="flex gap-2">
            <select value={directIdSource} onChange={e => setDirectIdSource(e.target.value as 'tmdb' | 'tvdb')} className="px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm">
              <option value="tmdb">TMDB</option>
              {isShow && <option value="tvdb">TVDB</option>}
            </select>
            <input
              value={directId}
              onChange={e => setDirectId(e.target.value)}
              placeholder="123456"
              className="flex-1 px-3 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm"
            />
            <button
              disabled={submitting || !directId.trim() || !/^\d+$/.test(directId.trim())}
              onClick={() => void submit(directIdSource, parseInt(directId.trim(), 10))}
              className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded disabled:opacity-50"
            >
              {submitting ? 'Matching…' : 'Match by ID'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function AdminLLMTab() {
  const [s, setS] = useState<LLMSettings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [apiKeyEdit, setApiKeyEdit] = useState('')
  useEffect(() => {
    const ac = new AbortController()
    getAdminLLM(ac.signal).then(setS).catch(e => { if (e.name !== 'AbortError') setErr(e.message) })
    return () => ac.abort()
  }, [])
  if (err) return <p className="text-red-300 text-sm">{err}</p>
  if (!s) return <p className="text-white/40 text-sm">Loading…</p>
  return (
    <div className="glass-panel rounded-xl p-5 space-y-3">
      <h3 className="text-white font-semibold mb-2">LLM (Search + Recommendations)</h3>
      <p className="text-white/40 text-xs mb-3">Configures the LLM used for natural-language search and recommendation reranking. Leave provider blank to disable.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Provider</span>
          <select value={s.provider} onChange={e => setS({ ...s, provider: e.target.value })} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm">
            <option value="">Disabled</option>
            <option value="ollama_cloud">Ollama Cloud</option>
            <option value="local">Local (Ollama)</option>
          </select>
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Ollama URL</span>
          <input value={s.ollama_url} onChange={e => setS({ ...s, ollama_url: e.target.value })} placeholder="http://localhost:11434" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Embed URL (optional)</span>
          <input value={s.embed_url} onChange={e => setS({ ...s, embed_url: e.target.value })} placeholder="http://localhost:11434" className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Chat Model</span>
          <input value={s.chat_model} onChange={e => setS({ ...s, chat_model: e.target.value })} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">Embed Model</span>
          <input value={s.embed_model} onChange={e => setS({ ...s, embed_model: e.target.value })} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
        <label className="text-sm text-white/70"><span className="block text-xs text-white/40 mb-1">API Key {s.has_api_key && <span className="text-emerald-300 text-[10px]">SET</span>}</span>
          <input type="password" value={apiKeyEdit} onChange={e => setApiKeyEdit(e.target.value)} placeholder={s.api_key_masked || 'leave empty to keep existing'} className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm" />
        </label>
      </div>
      <label className="flex items-center gap-2 mt-2 text-sm text-white/70">
        <input type="checkbox" checked={s.debug_log} onChange={e => setS({ ...s, debug_log: e.target.checked })} />
        Debug log <span className="text-white/40 text-xs">(verbose LLM call traces — adds disk I/O)</span>
      </label>
      <button
        disabled={saving}
        onClick={async () => {
          setSaving(true)
          try {
            const body: Record<string, unknown> = {
              provider: s.provider, ollama_url: s.ollama_url, embed_url: s.embed_url,
              chat_model: s.chat_model, embed_model: s.embed_model, debug_log: s.debug_log,
            }
            if (apiKeyEdit) body.api_key = apiKeyEdit
            const next = await updateAdminLLM(body as Parameters<typeof updateAdminLLM>[0])
            setS(next); setApiKeyEdit('')
            window.alert('LLM settings saved.')
          } catch (e) { window.alert('Save failed: ' + (e instanceof Error ? e.message : 'unknown')) }
          finally { setSaving(false) }
        }}
        className="mt-3 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
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
    <div className="glass-panel rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-white font-semibold">
          {label} OAuth (Sign-in)
          {enabled && <span className="ml-2 text-emerald-300 text-[10px] uppercase tracking-wider">Enabled</span>}
        </h3>
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

// AdminView wired to /api/admin/* endpoints. Each tab lazy-fetches
// on first visit and caches for the session.
function AdminView({ currentAdminId }: { currentAdminId: number }) {
  type AdminTab = 'dashboard' | 'users' | 'libraries' | 'rooms' | 'activity' | 'sessions' | 'flagged' | 'logs' | 'server' | 'llm' | 'oauth' | 'backup'
  const [tab, setTab] = useState<AdminTab>('dashboard')
  const tabs: readonly AdminTab[] = ['dashboard', 'users', 'libraries', 'rooms', 'activity', 'sessions', 'flagged', 'logs', 'server', 'llm', 'oauth', 'backup'] as const

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
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersErr, setUsersErr] = useState<string | null>(null)
  // Invite code generation lives on the Users tab (its natural home)
  // rather than the Server settings tab. Local state so the latest code
  // sticks around until the admin clicks Generate again or navigates away.
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityErr, setActivityErr] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsErr, setLogsErr] = useState<string | null>(null)

  // Dashboard is the landing tab — fetch on mount. The other tabs
  // fetch when the user navigates to them so we don't trigger four
  // API calls just because someone clicked "Admin".
  useEffect(() => {
    if (stats !== null) return
    const ac = new AbortController()
    setStatsLoading(true)
    getAdminDashboard(ac.signal)
      .then(s => setStats(s))
      .catch(err => {
        if (err && err.name === 'AbortError') return
        setStatsErr(err instanceof Error ? err.message : 'Failed to load stats')
      })
      .finally(() => setStatsLoading(false))
    return () => ac.abort()
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

  useEffect(() => {
    if (tab !== 'activity' || activity !== null) return
    const ac = new AbortController()
    setActivityLoading(true)
    listAdminActivity(50, ac.signal)
      .then(a => setActivity(a))
      .catch(err => {
        if (err && err.name === 'AbortError') return
        setActivityErr(err instanceof Error ? err.message : 'Failed to load activity')
      })
      .finally(() => setActivityLoading(false))
    // Cleanup so a rapid tab-switch doesn't fire setState on an
    // unmounted AdminView.
    return () => ac.abort()
  }, [tab, activity])

  useEffect(() => {
    if (tab !== 'logs' || logs !== null) return
    const ac = new AbortController()
    setLogsLoading(true)
    listAdminLogs(ac.signal)
      .then(l => setLogs(l))
      .catch(err => {
        if (err && err.name === 'AbortError') return
        setLogsErr(err instanceof Error ? err.message : 'Failed to load logs')
      })
      .finally(() => setLogsLoading(false))
    // Same cleanup pattern as activity above.
    return () => ac.abort()
  }, [tab, logs])

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
      <div className="mb-6">
        <h1 className="text-white text-3xl font-bold font-display">Administration</h1>
        <p className="text-white/50 text-sm mt-1">Server management dashboard</p>
      </div>

      {/* Tabs.
          QA BUG-006 — `capitalize` only uppercases the first letter
          per word, so "llm" → "Llm" and "oauth" → "Oauth". Override
          for the acronyms; everything else still falls through to
          the existing capitalize rule. */}
      <div className="flex items-center gap-2 mb-6 border-b border-white/[0.06] pb-1">
        {tabs.map(t => {
          const labelOverride: Partial<Record<AdminTab, string>> = {
            llm: 'LLM',
            oauth: 'OAuth',
            // QA BUG-010 follow-up — tab heading inside reads
            // "Active Transcode Streams" but the nav label was
            // just "Sessions", which read as generic and made
            // direct-play streams' absence more confusing.
            sessions: 'Transcodes',
          }
          const display = labelOverride[t]
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium ${display ? '' : 'capitalize'} transition-all border-b-2 -mb-0.5 ${
                tab === t
                  ? 'text-purple-400 border-purple-500'
                  : 'text-white/40 border-transparent hover:text-white/70'
              }`}
            >
              {display ?? t}
            </button>
          )
        })}
      </div>

      {tab === 'dashboard' && (
        <div>
          {statsErr && (
            <div className="mb-6 px-5 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">{statsErr}</div>
          )}
          {statsLoading && !stats && (
            <div className="mb-6 text-white/40 text-sm">Loading stats…</div>
          )}
          {stats && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {[
                  // QA BUG-002 — relabel "Total Media" → "Media File
                  // Entries" so it reads as raw row count, not the
                  // deduped title count users see on browse pages.
                  // Same source as the Server Status tile: raw COUNT
                  // includes cross-library duplicates.
                  { label: 'Media File Entries', value: (stats.movie_count + stats.show_count).toLocaleString(), icon: 'film', color: 'text-purple-400' },
                  { label: 'Users', value: stats.user_count.toLocaleString(), icon: 'users', color: 'text-blue-400' },
                  { label: 'Active Streams', value: String(stats.active_streams), icon: 'monitor', color: 'text-emerald-400' },
                  { label: 'Disk Free', value: `${stats.disk_free_gb.toFixed(1)} GB`, icon: 'hardDrive', color: 'text-amber-400' },
                ].map(s => (
                  <div key={s.label} className="glass-panel rounded-xl p-5">
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`${s.color}`}>
                        <Icon name={s.icon} size={20} />
                      </div>
                      <span className="text-white/50 text-sm">{s.label}</span>
                    </div>
                    <p className="text-white text-2xl font-bold">{s.value}</p>
                  </div>
                ))}
              </div>

              <div className="glass-panel rounded-xl p-6 mb-6">
                <h3 className="text-white font-semibold mb-4">Server</h3>
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
          <div className="glass-panel rounded-xl p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="text-white font-semibold mb-1">Invite a user</h3>
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
            {inviteCode && (
              <div className="mt-4 p-4 bg-white/[0.04] border border-white/[0.06] rounded flex items-center justify-between gap-4 flex-wrap">
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

          <div className="glass-panel rounded-xl overflow-hidden">
          {usersLoading && !users && <p className="p-6 text-white/40 text-sm">Loading users…</p>}
          {usersErr && <p className="p-6 text-red-300 text-sm">{usersErr}</p>}
          {users && (
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Sign-in</th>
                  <th>Created</th>
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
                    <td className="text-white/40">{fmtRelative(u.created_at)}</td>
                    <td>
                      {/* Phase 5.2 parity — Delete user. Server-side
                          also refuses self-delete with a 4xx; this
                          double-check just hides the button when
                          the row is the current admin's. */}
                      {currentAdminId !== u.id && (
                        <button
                          onClick={async () => {
                            if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return
                            try {
                              await deleteUser(u.id)
                              setUsers(prev => prev ? prev.filter(x => x.id !== u.id) : prev)
                            } catch (err) {
                              window.alert('Delete failed: ' + (err instanceof Error ? err.message : 'unknown'))
                            }
                          }}
                          className="px-2 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs rounded"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={5} className="text-white/40 text-sm text-center py-6">No users found.</td></tr>
                )}
              </tbody>
            </table>
          )}
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="glass-panel rounded-xl p-6">
          <h3 className="text-white font-semibold mb-4">Recent Activity</h3>
          {activityLoading && !activity && <p className="text-white/40 text-sm">Loading activity…</p>}
          {activityErr && <p className="text-red-300 text-sm">{activityErr}</p>}
          {activity && (
            <div className="space-y-3">
              {activity.length === 0 && <p className="text-white/40 text-sm">No recent activity.</p>}
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
        <div className="glass-panel rounded-xl p-6 font-mono text-xs">
          <h3 className="text-white font-semibold mb-4 font-sans">System Logs</h3>
          {logsLoading && !logs && <p className="text-white/40 text-sm font-sans">Loading logs…</p>}
          {logsErr && <p className="text-red-300 text-sm font-sans">{logsErr}</p>}
          {logs && (
            <div className="space-y-1 max-h-[500px] overflow-y-auto">
              {logs.length === 0 && <p className="text-white/40 text-sm font-sans">No log entries.</p>}
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
      {tab === 'server' && <AdminServerSettingsTab />}
      {tab === 'sessions' && <AdminSessionsTab />}
      {tab === 'flagged' && <AdminFlaggedTab onSelect={(_id) => { /* handled via parent? Not wired */ }} />}
      {tab === 'llm' && <AdminLLMTab />}
      {tab === 'oauth' && <AdminOAuthTab />}
      {tab === 'backup' && <AdminBackupRestore downloadBackup={downloadBackup} />}
    </div>
  )
}


/* ─────────────────────── SERVER PANEL ─────────────────────── */
// ServerPanel fetches /api/admin/dashboard and polls every 5s while
// open. Non-admins see a "admin-only" message.
function ServerPanel({ open, isAdmin, onClose }: { open: boolean; isAdmin: boolean; onClose: () => void }) {
  const [stats, setStats] = useState<ServerStats | null>(null)
  useEffect(() => {
    if (!open || !isAdmin) return
    let cancelled = false
    const tick = async () => {
      try {
        const s = await getAdminDashboard()
        if (!cancelled) setStats(s)
      } catch { /* non-fatal — panel just stays blank */ }
    }
    void tick()
    const id = window.setInterval(tick, 5000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [open, isAdmin])
  if (!open) return null
  const fmtBytes = (n: number): string => {
    if (n <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
    return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
  }
  type StatTile = { label: string; value: string; icon: string; tone: string; hint?: string }
  const tiles: StatTile[] = stats && isAdmin
    ? [
      { label: 'Active Streams', value: String(stats.active_streams), icon: 'monitor', tone: 'ok' },
      { label: 'Disk Free', value: `${stats.disk_free_gb.toFixed(1)} GB`, icon: 'hardDrive', tone: stats.disk_free_gb < 10 ? 'warn' : 'ok' },
      // QA 2026-05-25 — Memory shows the Go process's RSS, which on
      // a 65 TB media server reads suspiciously small (~10 MB) until
      // you know FFmpeg + PostgreSQL aren't counted. The hint surfaces
      // that context on hover instead of requiring the user to dig
      // into the metric definition.
      { label: 'Memory', value: `${stats.memory_alloc_mb} MB`, icon: 'zap', tone: 'ok',
        hint: "Aurora's Go process RSS after the last GC. FFmpeg transcoders run as separate subprocesses and aren't counted here. PostgreSQL runs in its own container with its own memory budget." },
      { label: 'Library Size', value: fmtBytes(stats.total_file_size_bytes), icon: 'film', tone: 'ok' },
      // QA BUG-002 — label as "Files" not "Titles" so users
      // don't read this as conflicting with the Movies/Shows
      // browse header (deduped library titles). Raw count
      // includes cross-library duplicates (e.g. a film present
      // in BOTH "Movies" and "4K Movies" libraries is counted
      // twice here, once on the browse page).
      { label: 'Files: Movies · Shows', value: `${stats.movie_count.toLocaleString()} · ${stats.show_count.toLocaleString()}`, icon: 'film', tone: 'ok' },
      { label: 'Users', value: String(stats.user_count), icon: 'users', tone: 'ok' },
      { label: 'Active Parties', value: String(stats.active_parties), icon: 'users', tone: 'ok' },
      { label: 'Uptime', value: stats.uptime, icon: 'activity', tone: 'ok' },
    ]
    : []
  // QA BUG-005 — anchor near the Server Status trigger in the sidebar
  // footer (bottom-left) instead of spanning the entire top of the
  // content area. The previous `top-0 left-[240px] right-0` covered
  // the global header (search, watch-party button, account avatar),
  // making them unreachable while the panel was open. Mirroring the
  // NotificationPanel layout (also a sidebar-footer trigger) but at
  // ~480px wide to fit a 2-column tile grid.
  //
  // z-[45] sits above the sticky top-bar stack (40) and below
  // ContextMenu (100) / modals (60s).
  return (
    <div className="fixed bottom-4 left-2 right-2 md:left-[252px] md:right-auto md:w-[480px] max-h-[70vh] bg-[#0a0a0f]/95 backdrop-blur-xl border border-white/[0.06] rounded-xl shadow-2xl p-5 z-[45] animate-fade-in overflow-y-auto">
      {/* No "Server Status" heading — the trigger button in the
          sidebar (line ~960) already shows that label, and the panel
          opens directly under it. Matching the NotificationPanel
          pattern, we DO offer a close affordance for symmetry. */}
      <button
        onClick={onClose}
        className="absolute top-3 right-3 text-white/40 hover:text-white transition-colors"
        aria-label="Close server status"
      >
        <Icon name="x" size={16} />
      </button>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pr-6">
        {!isAdmin && <p className="text-white/40 text-sm col-span-full">Server status is admin-only.</p>}
        {isAdmin && !stats && <p className="text-white/40 text-sm col-span-full">Loading stats…</p>}
        {tiles.map(stat => (
          <div
            key={stat.label}
            title={stat.hint}
            className={`glass-panel rounded-xl p-3 ${stat.hint ? 'cursor-help' : ''}`}
          >
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
                stat.tone === 'warn' ? 'bg-amber-500/10 text-amber-400' :
                stat.tone === 'idle' ? 'bg-white/[0.04] text-white/40' :
                'bg-emerald-500/10 text-emerald-400'
              }`}>
                <Icon name={stat.icon} size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-white/50 text-xs flex items-center gap-1">
                  {stat.label}
                  {stat.hint && <span className="text-white/30 text-[10px]">ⓘ</span>}
                </p>
                <p className="text-white text-base font-bold truncate">{stat.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────── NOTIFICATION PANEL ─────────────────────── */
// NotificationPanel surfaces recent admin activity log entries.
// Real-time WS-driven notifications are TODO; non-admins see an
// empty state.
function NotificationPanel({ open, isAdmin, onClose }: {
  open: boolean
  isAdmin: boolean
  onClose: () => void
}) {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open || !isAdmin) return
    let cancelled = false
    setLoading(true)
    listAdminActivity(20).then(a => { if (!cancelled) setEntries(a) })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, isAdmin])
  const fmtRel = (iso: string): string => {
    const t = new Date(iso).getTime()
    if (!t) return ''
    const diff = Date.now() - t
    if (diff < 60_000) return 'just now'
    // Mirror the AdminView.fmtRelative shape above so future edits
    // touch both consistently. "min" / "hr" / "d" are abbreviations
    // that already read OK at n === 1 (no grammar issue like the
    // "1 days ago" QA bug in the unabbreviated form), but the
    // singular branch on "hr" keeps the two formatters aligned.
    const mins = Math.floor(diff / 60_000)
    if (diff < 3_600_000) return `${mins} min ago`
    const hrs = Math.floor(diff / 3_600_000)
    if (diff < 86_400_000) return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'} ago`
    return `${Math.floor(diff / 86_400_000)} d ago`
  }
  if (!open) return null
  // QA BUG-006 — anchor near the Notifications trigger in the sidebar
  // footer (bottom-left) instead of the top-left of the content area.
  // The previous `top-0 left-[240px]` covered the page heading and
  // looked unrelated to the button that opened it. `bottom-4` plus a
  // bounded max-height keeps the panel reachable on short viewports
  // (content scrolls inside).
  //
  // z-[45] — same layering rationale as ServerPanel above.
  return (
    <div className="fixed bottom-4 left-2 right-2 md:left-[252px] md:right-auto md:w-[360px] max-h-[70vh] bg-[#0a0a0f]/95 backdrop-blur-xl border border-white/[0.06] rounded-xl shadow-2xl z-[45] animate-fade-in overflow-y-auto">
      <div className="p-4 border-b border-white/[0.06] flex items-center justify-between">
        <h3 className="text-white font-semibold">{isAdmin ? 'Recent Activity' : 'Notifications'}</h3>
        <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div>
        {!isAdmin && (
          <div className="p-8 text-center">
            <p className="text-white/40 text-sm">No notifications</p>
            <p className="text-white/30 text-xs mt-2">Real-time alerts arrive in Phase 5.3.</p>
          </div>
        )}
        {isAdmin && loading && entries.length === 0 && (
          <p className="p-4 text-white/40 text-sm">Loading…</p>
        )}
        {isAdmin && !loading && entries.length === 0 && (
          <div className="p-8 text-center"><p className="text-white/40 text-sm">No recent activity.</p></div>
        )}
        {isAdmin && entries.map(e => (
          <div key={e.id} className="p-4 border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
            <h4 className="text-white/90 text-sm font-medium">{e.event_type.replace(/_/g, ' ')}</h4>
            {e.username && <p className="text-white/50 text-xs mt-0.5">{e.username}</p>}
            <p className="text-white/30 text-xs mt-1">{fmtRel(e.created_at)}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────── TOAST CONTAINER ─────────────────────── */
function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  useEffect(() => {
    toasts.forEach(t => {
      setTimeout(() => onRemove(t.id), 3000)
    })
  }, [toasts, onRemove])

  return (
    // 2026-05-27 (holistic deep-debug H1) — opt out of html2canvas
    // bug-report captures. Toasts are transient meta-UI, not the
    // page content the user is trying to demo, so they shouldn't
    // leak into bug evidence. Matches the launcher + modal opt-out.
    //
    // 2026-05-27 polish pass — `bottom-[5.5rem]` (was `bottom-6`)
    // so the toast column stacks ABOVE the bug-report launcher pill
    // (which sits at `bottom-5` = 1.25rem in BugReportButton).
    // Previously the launcher was at `bottom: 5rem` to clear the
    // toast column; that flipped the natural "launcher in corner,
    // toasts stack above" pattern users expect. Now the launcher
    // owns the corner and toasts respect it.
    <div className="fixed bottom-[5.5rem] right-6 z-[200] flex flex-col gap-3" data-screenshot-exclude="true">
      {toasts.map(t => (
        <div key={t.id} className="toast">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
            t.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' :
            t.type === 'error' ? 'bg-red-500/10 text-red-400' :
            'bg-purple-500/10 text-purple-400'
          }`}>
            <Icon name={t.type === 'success' ? 'check' : t.type === 'error' ? 'x' : 'info'} size={16} />
          </div>
          <p className="text-white/80 text-sm">{t.message}</p>
        </div>
      ))}
    </div>
  )
}

// Quiet placeholder while a browse list is in flight.
function BrowseLoadingState({ title }: { title: string }) {
  return (
    <div className="animate-fade-in">
      <div className="mb-8">
        <h1 className="text-white text-4xl font-bold font-display">{title}</h1>
        <p className="text-white/40 text-sm mt-2">Loading your library…</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="aspect-[2/3] rounded-xl bg-white/[0.02] border border-white/[0.04] animate-pulse" />
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────── MAIN APP ─────────────────────── */

// QA BUG-001 — URL → view mapping for direct loads / browser
// back-forward / bookmarks. The BrowserRouter basename is "/v2"
// (set in main.tsx), so useLocation().pathname returns the path
// WITHOUT that prefix — "/movies" rather than "/v2/movies".
//
// 'detail' is intentionally absent: it's a selectedMedia-scoped
// transient view with no URL representation. Clicking a card sets
// view='detail' but leaves the URL on the prior top-level path,
// so a refresh re-renders that top-level view (movies/shows/etc.)
// rather than a dangling detail page with no selectedMedia.
const VIEW_BY_PATH: Record<string, string> = {
  '': 'home',
  '/': 'home',
  '/home': 'home',
  '/movies': 'movies',
  '/shows': 'shows',
  '/library': 'library',
  '/calendar': 'calendar',
  '/collections': 'collections',
  '/requests': 'requests',
  '/admin': 'admin',
  '/settings': 'settings',
  '/search': 'search',
}

function pathToView(pathname: string): string {
  // Exact match first.
  if (VIEW_BY_PATH[pathname] !== undefined) return VIEW_BY_PATH[pathname]
  // First-segment fallback so future subroutes (e.g. /movies/genre/action)
  // still resolve to the top-level view that contains them.
  const first = pathname.split('/').filter(Boolean)[0]
  return VIEW_BY_PATH['/' + (first ?? '')] ?? 'home'
}

/* ─────────────────────── USER MENU (avatar dropdown) ─────────────────────── */
// Top-bar avatar opens a small menu instead of deep-scrolling to the
// Settings → Account section. Standard expectation (Plex / Netflix /
// Jellyfin all expose Profile / Settings / Sign Out via the avatar).
//
// Closes on: outside click, Escape, route change (any setView via
// onNavigate also flips `open` shut). The trigger toggles open state
// so re-clicking the avatar dismisses without needing to outside-click.
function UserMenu({
  user,
  onNavigate,
  onSignOut,
}: {
  user: ApiUser
  onNavigate: (v: string) => void
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const go = (view: string) => {
    setOpen(false)
    onNavigate(view)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        title={`Signed in as ${user.username}${user.role === 'admin' ? ' (admin)' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center text-white font-bold text-sm focus:outline-none focus:ring-2 focus:ring-purple-400/60"
      >
        {user.username[0]?.toUpperCase() || 'U'}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 rounded-xl bg-[#0a0a0f]/95 backdrop-blur-xl border border-white/[0.06] shadow-2xl z-[50] overflow-hidden animate-fade-in"
        >
          {/* Header — show identity so users with multiple accounts
              know which one is signed in. role=admin gets a small
              chip; non-admin users get a clean header. */}
          <div className="px-4 py-3 border-b border-white/[0.06]">
            <p className="text-white text-sm font-medium truncate">{user.username}</p>
            <p className="text-white/40 text-xs mt-0.5 flex items-center gap-1.5">
              {user.role === 'admin' ? (
                <>
                  <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[10px] font-semibold uppercase tracking-wide">Admin</span>
                  Account
                </>
              ) : 'Account'}
            </p>
          </div>
          <button
            role="menuitem"
            onClick={() => go('settings')}
            className="w-full text-left px-4 py-2.5 text-sm text-white/85 hover:bg-white/[0.06] flex items-center gap-2"
          >
            <Icon name="settings" size={14} className="text-white/50" />
            Settings
          </button>
          {user.role === 'admin' && (
            <button
              role="menuitem"
              onClick={() => go('admin')}
              className="w-full text-left px-4 py-2.5 text-sm text-white/85 hover:bg-white/[0.06] flex items-center gap-2"
            >
              <Icon name="shield" size={14} className="text-white/50" />
              Admin
            </button>
          )}
          <div className="border-t border-white/[0.06] mt-1" />
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onSignOut() }}
            className="w-full text-left px-4 py-2.5 text-sm text-red-300/85 hover:bg-red-500/10 flex items-center gap-2"
          >
            <Icon name="log-out" size={14} className="text-red-400/60" />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [view, setView] = useState('home')
  const [prevView, setPrevView] = useState('home')
  // Bumped every time the user clicks the current view's nav item.
  // Views with internal drill-down state (CollectionsView's selected
  // collection, future views) can subscribe via useEffect deps and
  // reset back to their index. See handleNavigate's same-view branch.
  const [navRewindNonce, setNavRewindNonce] = useState(0)
  // Tri-valued auth state: `null` = checking via /api/auth/me,
  // `false` = no session, ApiUser = logged in. The intermediate
  // null prevents flashing the login screen on reload.
  const [user, setUser] = useState<ApiUser | null | false>(null)
  const [selectedMedia, setSelectedMedia] = useState<Media | null>(null)
  // The player needs server-side identifiers (fileId, fileType,
  // episodeId) that aren't on the UI Media type. Play resolves these
  // via /api/media/{id}/files (movie) or seasons/episodes (show)
  // before constructing the target; playerLoading covers the
  // resolution window so the UI shows "Resolving…" instead of a
  // blank player.
  const [playerTarget, setPlayerTarget] = useState<PlayTarget | null>(null)
  const [playerLoading, setPlayerLoading] = useState(false)

  // M10 Phase 4 — watch party state.
  // 2026-05-25 — pass user.id so the hook can scope its last-party
  // localStorage cache (lib/lastParty.ts) per signed-in user. Without
  // this, logging out and back in as a different user would surface
  // the prior user's "Recently in" pill.
  // user is tri-valued (null | false | ApiUser); narrow to id only
  // when actually logged in so the hook's cache key isn't keyed on
  // undefined-but-truthy values.
  const party = useParty(user && typeof user === 'object' ? user.id : undefined)
  const [partyPanelOpen, setPartyPanelOpen] = useState(false)
  const [partyJoinPrompt, setPartyJoinPrompt] = useState(false)
  // Phase 5 — add-to-watchlist dialog. Opened from DetailView. The
  // dialog fetches the active profile's watchlists on open + lets
  // the user pick one or create a new list inline.
  // Phase 5 — active profile (moved up so all effects below can use it).
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [activeProfileId, setActiveProfileId] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('aurora_active_profile_id')
      return raw ? parseInt(raw, 10) || null : null
    } catch { return null }
  })
  useEffect(() => {
    try {
      if (activeProfileId) localStorage.setItem('aurora_active_profile_id', String(activeProfileId))
      else localStorage.removeItem('aurora_active_profile_id')
    } catch { /* ignore */ }
  }, [activeProfileId])

  // Phase 5.2 parity — right-click context menu state.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: MediaContextItem[] } | null>(null)
  const openCardContextMenu = useCallback((e: React.MouseEvent, m: Media) => {
    e.preventDefault()
    const items: MediaContextItem[] = [
      { label: 'Mark as Watched', onClick: () => {
        void markWatched(m.id).then((res) => {
          const id = nextToastId()
          setToasts(prev => [...prev, { id, message: `Marked "${m.title}" as watched`, type: 'success' }])
          // Surface achievement unlocks from the server's gamification
          // engine. One toast per unlock so they sequence cleanly.
          if (res?.achievements_unlocked && res.achievements_unlocked.length > 0) {
            for (const def of res.achievements_unlocked) {
              const tid = nextToastId()
              setToasts(prev => [...prev, { id: tid, message: `${def.icon} Achievement unlocked: ${def.title} (+${def.xp_reward} XP)`, type: 'success' }])
            }
          }
          // Refresh continue rail so the now-watched item drops off.
          setRetryNonce(n => n + 1)
        }).catch(err => {
          window.alert('Failed: ' + (err instanceof Error ? err.message : 'unknown'))
        })
      }},
      { label: 'Clear Progress', tone: 'danger', onClick: () => {
        void clearProgress(m.id).then(() => {
          const id = nextToastId()
          setToasts(prev => [...prev, { id, message: `Cleared progress for "${m.title}"`, type: 'info' }])
          setRetryNonce(n => n + 1)
        }).catch(err => {
          window.alert('Failed: ' + (err instanceof Error ? err.message : 'unknown'))
        })
      }},
    ]
    if (profiles.length > 0) {
      items.push({ label: 'Add to Watchlist…', onClick: () => setAddToListMedia(m) })
    }
    if (user && user.role === 'admin') {
      items.push({ label: 'Refresh Metadata', onClick: () => { void handleRefreshMetadata(m) } })
    }
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  // user is a discriminated union; the casts above narrow it. setToasts etc. are stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, user])

  const [addToListMedia, setAddToListMedia] = useState<Media | null>(null)
  // Phase 6 — Collections modal open state. Triggered by the
  // "+ New Collection" button in CollectionsView OR by future
  // global-action shortcuts (Ctrl+Shift+N).
  const [collectionsModalOpen, setCollectionsModalOpen] = useState(false)
  const [addToListLists, setAddToListLists] = useState<Watchlist[] | null>(null)
  const [addToListBusy, setAddToListBusy] = useState(false)
  useEffect(() => {
    if (!addToListMedia || !activeProfileId) { setAddToListLists(null); return }
    let cancelled = false
    listWatchlists(activeProfileId).then(ls => { if (!cancelled) setAddToListLists(ls) }).catch(() => { if (!cancelled) setAddToListLists([]) })
    return () => { cancelled = true }
  }, [addToListMedia, activeProfileId])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  // Ref to the search input so Cmd+K / Ctrl+K can move focus to it.
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  // Cmd+K opens a full-screen Spotlight-style palette (the top-bar
  // input stays for click-to-search flows).
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [serverOpen, setServerOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  // QA 2026-05-25 — popovers were sticking around after route
  // changes. The Notifications + Server Status drawers are anchored
  // to the sidebar trigger, but their state lived independent of
  // `view`, so navigating away from Home left the popover floating
  // over the new page until the user manually closed it. Auto-close
  // both when `view` changes. Same effect mounts once and runs on
  // every view transition — cheap, no extra deps needed.
  // QA BUG-012 — mobile sidebar drawer state. Below md (768px) the
  // sidebar is hidden by default and toggles in over content.
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false)
  // My Library — user-saved titles. Persisted to localStorage so the
  // collection survives refreshes. Items are snapshots (full Media
  // objects) so the card poster / title / year stays accessible even
  // when the network is down. Stale entries (e.g. media deleted on
  // the server) gracefully degrade: the card still renders, opening
  // the detail will fetch fresh data and may 404 — handled there.
  const [library, setLibrary] = useState<Media[]>(() => {
    try {
      const raw = localStorage.getItem('aurora_my_library')
      return raw ? (JSON.parse(raw) as Media[]) : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    try { localStorage.setItem('aurora_my_library', JSON.stringify(library)) }
    catch { /* quota / private mode — non-fatal */ }
  }, [library])
  // Memoized ID set so MediaRail / BrowseView / LibraryView can do
  // O(1) membership checks without re-creating the Set on every
  // render. Rebuilt only when the library array reference changes.
  const libraryIds = useMemo(() => new Set(library.map(m => m.id)), [library])
  const [toasts, setToasts] = useState<Toast[]>([])

  // Monotonic counter for toast IDs. Date.now()-based IDs can collide
  // under fast double-clicks and duplicate React keys corrupt the
  // toast list.
  const toastIdCounter = useRef(0)
  const nextToastId = useCallback(() => {
    toastIdCounter.current += 1
    return `t${toastIdCounter.current}`
  }, [])

  // M10 Phase 2 — Browse views. Lists fetch lazily on first visit
  // to the tab and stay cached for the session. The null sentinel
  // doubles as the loading indicator (rendered as a skeleton grid
  // via BrowseLoadingState).
  const [moviesList, setMoviesList] = useState<Media[] | null>(null)
  const [showsList, setShowsList] = useState<Media[] | null>(null)
  // Real server-side catalog total for the "Showing N of M" header.
  // /api/media caps per_page at 100, so without this the header
  // would read "100 titles" on a multi-thousand-item library.
  const [moviesTotal, setMoviesTotal] = useState<number | null>(null)
  const [showsTotal, setShowsTotal] = useState<number | null>(null)
  // Sort lives here (not in BrowseView) because changing sort
  // triggers a re-fetch from page 1, and the parent owns the cache.
  type MediaSort = 'rating' | 'title' | 'year' | 'recent'
  const [moviesSort, setMoviesSort] = useState<MediaSort>('rating')
  const [showsSort, setShowsSort] = useState<MediaSort>('rating')
  // Genre filter — QA BUG-003 fix. Previously this lived inside
  // BrowseView, but changing Sort sets moviesList=null which
  // unmounts BrowseView and resets its local state. Lifting to
  // the parent keeps the user's genre selection across sort
  // changes (and across the loading-skeleton intermediate state).
  const [moviesGenre, setMoviesGenre] = useState('')
  const [showsGenre, setShowsGenre] = useState('')
  // Canonical genre catalogs from /api/media/genres — populated once
  // per browse view, used to render the dropdown so it doesn't shift
  // as the user paginates. Null while in flight; BrowseView falls
  // back to deriving from items so first paint isn't blocked.
  const [moviesGenres, setMoviesGenres] = useState<string[] | null>(null)
  const [showsGenres, setShowsGenres] = useState<string[] | null>(null)
  const [moviesLoadingMore, setMoviesLoadingMore] = useState(false)
  const [showsLoadingMore, setShowsLoadingMore] = useState(false)
  // Track next-page-to-fetch in state rather than deriving from
  // list.length: if catalog items are deleted between fetches the
  // server returns a short page, the length math misaligns, and the
  // next click re-fetches the same page (duplicate items + key
  // warnings). Trust the server's returned page number instead.
  const [moviesNextPage, setMoviesNextPage] = useState(1)
  const [showsNextPage, setShowsNextPage] = useState(1)
  // AbortController refs let handleSortChange + handleLoadMore
  // coordinate cancellation across renders so a sort change can
  // cancel an in-flight Load More (which would otherwise append a
  // stale-sort response onto the new list).
  const moviesLoadMoreAcRef = useRef<AbortController | null>(null)
  const showsLoadMoreAcRef = useRef<AbortController | null>(null)
  // Per-page size constant. Server caps at 100; we ride at the cap
  // to minimize round-trips. Centralized so Load More can compute
  // `nextPage` consistently with the initial fetch.
  const BROWSE_PER_PAGE = 100

  // On card click we set selectedMedia (lightweight, immediate) and
  // also fetch the full detail + episodes in the background.
  const [detailItem, setDetailItem] = useState<MediaDetail | null>(null)
  const [detailEpisodes, setDetailEpisodes] = useState<ApiEpisode[]>([])
  const [detailFiles, setDetailFiles] = useState<MediaFile[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  // M10 Phase 4.5 — multi-season support.
  const [detailSeasons, setDetailSeasons] = useState<{ season_number: number; episode_count?: number }[]>([])
  const [detailSelectedSeason, setDetailSelectedSeason] = useState<number | null>(null)
  // Continue Watching rail data. Kept as ContinueWatchingItem (not
  // mapped to UIMedia) because handlePlay needs position_ms to
  // seed resume.
  const [continueItems, setContinueItems] = useState<ContinueWatchingItem[]>([])
  // 2026-05-27 — Bug-report config. Holds the full server response so
  // the BugReportButton + modal can both gate on `enabled` AND surface
  // admin-only token-health diagnostics (added 2026-05-27 PAT health
  // check). The BugReportButton renders only when `enabled` is true.
  const [bugReportConfig, setBugReportConfig] = useState<BugReportConfig | null>(null)
  // M10 Phase 4.5 — Requests view real data.
  const [requestsList, setRequestsList] = useState<MediaRequest[] | null>(null)

  // Load profiles once the user is logged in.
  useEffect(() => {
    if (!user) { setProfiles([]); return }
    const ac = new AbortController()
    listProfiles(ac.signal).then(ps => {
      setProfiles(ps)
      // Validate the stored active profile against the loaded list.
      // If it no longer exists (deleted from another tab), fall back
      // to the default so we don't keep sending a stale profile_id.
      const validCurrent = activeProfileId && ps.some(p => p.id === activeProfileId)
      if (!validCurrent && ps.length > 0) {
        const def = ps.find(p => p.is_default) || ps[0]
        setActiveProfileId(def.id)
      } else if (ps.length === 0 && activeProfileId !== null) {
        setActiveProfileId(null)
      }
    }).catch(() => { /* non-fatal — profile features just stay disabled */ })
    return () => ac.abort()
  // activeProfileId intentionally excluded — we set it inside the
  // effect and don't want to re-run on that change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])
  // `null` rails = not yet fetched. Empty arrays inside rails are
  // filtered out by HomeView so a fresh install with no media
  // doesn't render ghost rails.
  const [homeHero, setHomeHero] = useState<Media | null>(null)
  // Phase 5.3 — personalized hero pool. Server returns 4-8 picks
  // with reason blurbs; client rotates every 9s with crossfade.
  // Falls back to listRecent[0] when /api/me/hero 503s (no LLM).
  const [heroPool, setHeroPool] = useState<HeroPick[]>([])
  const [heroIndex, setHeroIndex] = useState(0)
  const [heroPaused, setHeroPaused] = useState(false)
  // Personalization status from /api/me/hero. When `coldStart` is true,
  // we're below the watch-history threshold and Hero is serving the
  // popular-unwatched fallback with no LLM blurbs — drives a UI hint
  // explaining why nothing's curated yet.
  const [heroPersonalization, setHeroPersonalization] = useState<HeroPersonalization | null>(null)
  // Ref to read latest heroPool from the home-rails effect without
  // adding it to deps (which would re-fetch rails on every rotate).
  const heroPoolRef = useRef<HeroPick[]>([])
  // Throttle the "no file available" toast (episode_id → last-shown
  // ms). 2s cooldown dedupes accidental double-clicks while still
  // letting a genuine later click re-fire.
  const unavailableToastRef = useRef<Map<number, number>>(new Map())
  const [homeRails, setHomeRails] = useState<HomeViewProps['rails']>(undefined)
  const [homeLoading, setHomeLoading] = useState(false)
  const [homeError, setHomeError] = useState<string | null>(null)

  const navigate = useNavigate()
  const location = useLocation()

  // QA BUG-001 — sync URL → view on mount and on every pathname
  // change (browser back/forward, bookmarks, direct loads). Without
  // this, `view = useState('home')` always wins on cold load even
  // if the URL says `/v2/calendar`. The setView call is idempotent;
  // when in-app handleNavigate triggers a pathname change, this
  // effect just confirms the same view we already set.
  useEffect(() => {
    const target = pathToView(location.pathname)
    if (target !== view) {
      setView(target)
    }
    // Intentionally NOT including `view` in deps — we only want
    // this to fire on URL changes. Including view would cause it
    // to reconcile back to the URL after any setView('detail')
    // call (which IS desired sometimes, but we have explicit
    // navigation back from detail via handleBack).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = nextToastId()
    setToasts(prev => [...prev, { id, message, type }])
  }, [nextToastId])

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const handleNavigate = useCallback((v: string) => {
    // QA 2026-05-25 — clicking the *current* view's nav item should
    // act as "reset to list" for views with internal drill-down
    // state. Bump a per-view nonce so child components can listen
    // and clear their selection (e.g. CollectionsView popping back
    // from a collection detail to the index). Other views ignore
    // the nonce and the click is a no-op as before.
    //
    // The nonce only fires from in-app nav clicks. Browser back/
    // forward and URL-driven navigation use the popstate-synced
    // view effect (~L5279) which compares against the current view
    // and short-circuits if equal — so a browser-back from
    // /collections detail back to /collections won't bump the
    // nonce. The pathname doesn't actually encode drill-down state
    // (it's internal to CollectionsView), so this is consistent;
    // calling out so future maintainers don't get surprised.
    if (v === view) {
      setNavRewindNonce(n => n + 1)
      // Also close popovers — without this, the popover-close
      // effect (keyed on `view`) wouldn't fire because `view`
      // didn't change. Inconsistent UX otherwise: re-clicking
      // Home with Notifications open would scroll-to-top but
      // leave the popover floating.
      setNotifOpen(false)
      setServerOpen(false)
      // Still scroll-to-top so a long Movies grid resets to the
      // header — same UX as desktop apps re-clicking a tab.
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setPrevView(view)
    setView(v)
    setSelectedMedia(null)
    setSearchOpen(false)
    // Clear the search input on navigate. It's a controlled input on
    // `searchQuery`, so this prevents the text from sticking after
    // leaving the search view.
    setSearchQuery('')
    // Close the player on nav so the URL and rendered state stay in
    // sync (matters for programmatic history.replaceState calls).
    setPlayerTarget(null)
    navigate(`/${v}`)
  }, [view, navigate])

  const handleSelect = useCallback((m: Media) => {
    setSelectedMedia(m)
    setPrevView(view)
    setView('detail')
  }, [view])

  // Play resolution. The UI Media type doesn't carry server file
  // IDs, so we resolve them here:
  //   - Movies: GET /api/media/{id}/files, pick a file.
  //   - Shows: play the first episode of season 1 (TODO: port the
  //     V1 next-episode smart-resume).
  const handlePlay = useCallback(async (m: Media) => {
    setPlayerLoading(true)
    try {
      // Phase 5 — quality preference. Read from the same aurora_prefs
      // bucket Settings writes to. Default 'auto' = 1080p preferred.
      let preferQuality: 'auto' | '1080p' | '4k' = 'auto'
      try {
        // Guard against null / non-object shapes that JSON.parse can
        // return when localStorage was tampered with.
        const raw: unknown = JSON.parse(localStorage.getItem('aurora_prefs') || '{}')
        if (raw && typeof raw === 'object') {
          const prefs = raw as Record<string, unknown>
          if (prefs.preferred_quality === '4k') preferQuality = '4k'
          else if (prefs.preferred_quality === '1080p') preferQuality = '1080p'
        }
      } catch { /* ignore */ }
      if (m.type === 'show') {
        // Show → first episode of first season. Audit H3 (2026-05-16):
        // sort by season_number explicitly. The API doesn't guarantee
        // ordering; insertion-order (which equals season-creation
        // order on disk) is NOT necessarily season_number-order for
        // shows that had a later season added before an earlier one,
        // or for shows starting at season 0 (specials). Same sort
        // applied to episodes for the same reason.
        const seasonsRaw = await getSeasons(m.id)
        if (seasonsRaw.length === 0) throw new Error('No seasons available')
        const seasons = [...seasonsRaw].sort((a, b) => a.season_number - b.season_number)
        const firstSeason = seasons[0]
        const episodesRaw = await getEpisodes(m.id, firstSeason.season_number)
        if (episodesRaw.length === 0) throw new Error('No episodes available')
        const episodes = [...episodesRaw].sort((a, b) => a.episode_number - b.episode_number)
        const ep = episodes[0]
        // ep.files is already typed `EpisodeFile[] | undefined` in
        // api.ts — the previous redundant `as` cast suggested a type
        // mismatch that doesn't exist. Same cleanup applied to all
        // four remaining sites in this file.
        const file = pickFile(ep.files, preferQuality)
        if (!file) throw new Error('Episode has no files')
        setPlayerTarget({
          mediaItemId: m.id,
          fileId: file.id,
          fileType: 'episode',
          episodeId: ep.id,
          title: m.title,
          subtitle: `S${firstSeason.season_number}E${ep.episode_number}${ep.title ? ' — ' + ep.title : ''}`,
        })
      } else {
        // Movie → quality-preferred file.
        const files = await getMediaFiles(m.id)
        const file = pickFile(files, preferQuality)
        if (!file) throw new Error('No file available to play')
        setPlayerTarget({
          mediaItemId: m.id,
          fileId: file.id,
          fileType: 'media',
          title: m.title,
          subtitle: m.year ? String(m.year) : undefined,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start playback'
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: msg, type: 'error' }])
    } finally {
      setPlayerLoading(false)
    }
  }, [nextToastId])

  const handleToggleLib = useCallback((m: Media) => {
    setLibrary(prev => {
      const exists = prev.find(i => i.id === m.id)
      if (exists) {
        addToast(`Removed "${m.title}" from library`, 'info')
        return prev.filter(i => i.id !== m.id)
      } else {
        addToast(`Added "${m.title}" to library`, 'success')
        return [...prev, m]
      }
    })
  }, [addToast])

  const handleBack = useCallback(() => {
    setView(prevView)
    setSelectedMedia(null)
  }, [prevView])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Palette has its own Escape handler — let it close the
        // palette without ALSO triggering the page-level back/etc.
        // navigation here.
        if (paletteOpen) return
        if (playerTarget) setPlayerTarget(null)
        else if (searchOpen) setSearchOpen(false)
        else if (view === 'detail') handleBack()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // Cmd+K opens the SearchPalette overlay. Guard against:
        //   - unauthenticated (no user)
        //   - typing in another editable element
        //   - any modal already open
        if (!user) return
        const target = e.target as HTMLElement | null
        const inEditable = !!target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        )
        // Allow Cmd+K from inside our own top-bar search input
        // (acts as "upgrade to palette" affordance).
        if (inEditable && target !== searchInputRef.current) return
        if (playerTarget || partyJoinPrompt || contextMenu || addToListMedia) return
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // Modal-state deps so the Cmd+K guard re-binds when a modal
    // opens/closes (avoids a stale closure reading "no modal" while
    // one is actually open).
  }, [playerTarget, searchOpen, view, handleBack, partyJoinPrompt, contextMenu, addToListMedia, user, paletteOpen])

  // Auth boot. If we have a stored token + cached user, optimistically
  // render with the cached user while validating via /api/auth/me in
  // the background. The cancelled flag + the re-check of
  // getAccessToken() guard against a late /me settling onto stale
  // state if the user logged out (or as a different user) mid-flight.
  useEffect(() => {
    const cached = getStoredUser()
    const token = getAccessToken()
    if (!token) {
      setUser(false)
      return
    }
    if (cached) {
      // Show the app immediately. Validate in the background so token
      // expiry or password-change-revocation eventually kicks us out.
      setUser(cached)
    }
    const ac = new AbortController()
    let cancelled = false
    fetchMe(ac.signal)
      .then(u => {
        if (cancelled) return
        // If a logout happened between when we fired and when we
        // landed, getAccessToken() is now null and we must NOT call
        // setUser(u) — that would silently re-authenticate the user
        // as whoever the stale response describes.
        if (!getAccessToken()) return
        setUser(u)
      })
      .catch(err => {
        if (cancelled) return
        if (err && (err as Error).name === 'AbortError') return
        setUser(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  // Resolve the new media's first file when the host changes the
  // party's media. The generation counter prevents a slow earlier
  // resolve (e.g. ep5 in season 12 → many sequential getEpisodes
  // calls) from overwriting a fast later resolve.
  const mediaChangeGenRef = useRef(0)
  useEffect(() => {
    return party.onMediaChange((p) => {
      const myGen = ++mediaChangeGenRef.current
      void (async () => {
        try {
          if (p.episode_id) {
            // We don't know which season; lift from getMedia +
            // search. handlePlayEpisode needs the Episode object;
            // we don't have it here. Cheapest path: fetch seasons
            // for this media, scan episodes for episode_id, pick
            // its file.
            const seasonsRaw = await getSeasons(p.media_item_id)
            const seasons = [...seasonsRaw].sort((a, b) => a.season_number - b.season_number)
            let foundEp: ApiEpisode | null = null
            let foundSeasonNum = 0
            for (const s of seasons) {
              const eps = await getEpisodes(p.media_item_id, s.season_number)
              const ep = eps.find(e => e.id === p.episode_id)
              if (ep) { foundEp = ep; foundSeasonNum = s.season_number; break }
            }
            if (!foundEp) return
            if (myGen !== mediaChangeGenRef.current) return // stale
            const file = pickFile(foundEp.files)
            if (!file) return
            const titleDetail = await getMedia(p.media_item_id).catch(() => null)
            if (myGen !== mediaChangeGenRef.current) return // stale
            setPlayerTarget({
              mediaItemId: p.media_item_id,
              fileId: file.id,
              fileType: 'episode',
              episodeId: foundEp.id,
              title: titleDetail?.title ?? party.state.mediaTitle ?? 'Untitled',
              subtitle: `S${foundSeasonNum}E${foundEp.episode_number}${foundEp.title ? ' — ' + foundEp.title : ''}`,
            })
          } else {
            // Movie — fetch files + play first.
            const files = await getMediaFiles(p.media_item_id)
            if (myGen !== mediaChangeGenRef.current) return // stale
            const file = pickFile(files)
            if (!file) return
            const titleDetail = await getMedia(p.media_item_id).catch(() => null)
            if (myGen !== mediaChangeGenRef.current) return // stale
            setPlayerTarget({
              mediaItemId: p.media_item_id,
              fileId: file.id,
              fileType: 'media',
              title: titleDetail?.title ?? 'Untitled',
            })
          }
        } catch (err) {
          console.warn('[Aurora] media-change auto-resolve failed', err)
        }
      })()
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party.onMediaChange])

  // 2026-05-25 — Guest auto-open-player. Symptom: in the EEJ7DB live test,
  // the host clicked Play but nothing opened on the guest's end. Root
  // cause: onMediaChange above only fires when the host SWITCHES media
  // mid-party (server emits a `media-change` event), but the initial
  // play case (guest already joined, host hits Play in their already-
  // open player) only flows tick/play events on the sync socket —
  // there's no media-change to subscribe to, so nothing in App.tsx ever
  // opens the player for the guest, and the sync events go nowhere.
  //
  // Fix: watch (state.code, state.mediaItemId, state.isPlaying, user.id,
  // state.hostUserId, playerTarget) and auto-open the guest's player
  // when all of: in a party, we're not the host, media is set, host
  // is playing, and we don't already have a player open. This also
  // covers the "guest joined a party that was ALREADY playing" case —
  // party-state arrives with isPlaying=true and the effect fires
  // immediately.
  //
  // We deliberately do NOT auto-open if isPlaying is false — the
  // lobby (with the I'm Ready button, chat, reactions) should remain
  // visible until the host actually starts. Closing the player
  // manually mid-party will allow this to re-fire on the next tick
  // (state.isPlaying is sampled live), which is the desired "pop me
  // back into the player" UX.
  const guestAutoOpenGenRef = useRef(0)
  useEffect(() => {
    if (!user) return
    if (!party.state.code) return
    if (!party.state.mediaItemId) return
    if (!party.state.isPlaying) return
    // 2026-05-25 — require hostUserId to actually be set before
    // making the host vs guest decision. Without this null-check,
    // a transient render where state.code/mediaItemId/isPlaying are
    // populated but state.hostUserId is briefly undefined would
    // evaluate `undefined === user.id` as false, slip past the host
    // guard, and auto-open the host's player as if they were a
    // guest. Fix: bail if hostUserId hasn't arrived yet.
    if (party.state.hostUserId == null) return
    if (party.state.hostUserId === user.id) return // we ARE the host
    if (playerTarget) return // already has player open
    const myGen = ++guestAutoOpenGenRef.current
    const mediaItemId = party.state.mediaItemId
    const episodeId = party.state.episodeId
    void (async () => {
      try {
        if (episodeId) {
          const seasonsRaw = await getSeasons(mediaItemId)
          const seasons = [...seasonsRaw].sort((a, b) => a.season_number - b.season_number)
          let foundEp: ApiEpisode | null = null
          let foundSeasonNum = 0
          for (const s of seasons) {
            const eps = await getEpisodes(mediaItemId, s.season_number)
            const ep = eps.find(e => e.id === episodeId)
            if (ep) { foundEp = ep; foundSeasonNum = s.season_number; break }
          }
          if (!foundEp) return
          if (myGen !== guestAutoOpenGenRef.current) return // stale
          const file = pickFile(foundEp.files)
          if (!file) return
          const titleDetail = await getMedia(mediaItemId).catch(() => null)
          if (myGen !== guestAutoOpenGenRef.current) return // stale
          setPlayerTarget({
            mediaItemId,
            fileId: file.id,
            fileType: 'episode',
            episodeId: foundEp.id,
            title: titleDetail?.title ?? party.state.mediaTitle ?? 'Untitled',
            subtitle: `S${foundSeasonNum}E${foundEp.episode_number}${foundEp.title ? ' — ' + foundEp.title : ''}`,
          })
        } else {
          const files = await getMediaFiles(mediaItemId)
          if (myGen !== guestAutoOpenGenRef.current) return // stale
          const file = pickFile(files)
          if (!file) return
          const titleDetail = await getMedia(mediaItemId).catch(() => null)
          if (myGen !== guestAutoOpenGenRef.current) return // stale
          setPlayerTarget({
            mediaItemId,
            fileId: file.id,
            fileType: 'media',
            title: titleDetail?.title ?? party.state.mediaTitle ?? 'Untitled',
          })
        }
      } catch (err) {
        console.warn('[Aurora] guest auto-open resolve failed', err)
      }
    })()
  }, [
    user,
    party.state.code,
    party.state.mediaItemId,
    party.state.episodeId,
    party.state.isPlaying,
    party.state.hostUserId,
    party.state.mediaTitle,
    playerTarget,
  ])

  // Magic-link auto-join. The server redirects /p/{code} and
  // /r/{code} to {BASE}p/{code}; we extract the code and trigger
  // party.join. We strip the dynamic Vite base before regex-matching
  // so the lookup survives a future change to Vite's `base`.
  useEffect(() => {
    if (!user) return
    const base = import.meta.env.BASE_URL.replace(/\/$/, '') // '' or '/v2'
    const pathAfterBase = window.location.pathname.startsWith(base)
      ? window.location.pathname.slice(base.length)
      : window.location.pathname
    const m = pathAfterBase.match(/^\/(p|r)\/([A-Za-z0-9]{6})$/)
    if (!m) return
    const code = m[2].toUpperCase()
    const linkKind = m[1] // 'p' or 'r' — preflight clarifies anyway
    // Strip the code from the URL so a refresh doesn't re-trigger
    // the join (which would error "already in party" if still
    // active, or no-op if not).
    window.history.replaceState({}, '', import.meta.env.BASE_URL)
    void (async () => {
      // If already in a party, confirm before clobbering — otherwise
      // an accidental magic-link click silently disconnects the user
      // and notifies everyone else with participant-left.
      if (party.state.code && party.state.code !== code) {
        const ok = window.confirm(
          `You're in party ${party.state.code}. Leave it and join ${code}?`
        )
        if (!ok) return
      }
      const result = await party.join(code)
      if (result.ok) {
        setPartyPanelOpen(true)
      } else {
        // Persistent rooms surface a friendly "offline" toast (vs
        // a generic error) so the user understands what they clicked.
        const id = nextToastId()
        const isOfflineRoom = linkKind === 'r' || (result.error || '').toLowerCase().includes('persistent room')
        setToasts(prev => [...prev, {
          id,
          message: isOfflineRoom
            ? `Room ${code} is offline — no live session right now. Ask the host to start a watch party.`
            : (result.error || `Couldn't join party ${code}.`),
          type: isOfflineRoom ? 'info' : 'error',
        }])
      }
    })()
  // We intentionally run once when user becomes available, not on
  // every party state change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Full state reset on logout. Must clear every per-user cache
  // (rails, library, detail, player, …) — on a shared browser, a
  // missed field briefly leaks the previous user's data to the next
  // login. Hoisted above the storage useEffect so both the explicit
  // logout and the cross-tab path can share it.
  const resetUserState = useCallback(() => {
    setHomeRails(undefined)
    setHomeHero(null)
    // Clear hero pool too — without this, user A's personalized
    // blurb is briefly visible to user B after a cross-tab logout.
    setHeroPool([])
    setHeroIndex(0)
    setHeroPaused(false)
    heroPoolRef.current = []
    setContinueItems([])
    setMoviesList(null)
    setShowsList(null)
    setMoviesTotal(null)
    setShowsTotal(null)
    // Pagination state reset on logout. Sort preference is per-user
    // so default it back; loading flags are per-session.
    setMoviesSort('rating')
    setShowsSort('rating')
    setMoviesLoadingMore(false)
    setShowsLoadingMore(false)
    setMoviesNextPage(1)
    setShowsNextPage(1)
    // Abort any in-flight Load More so a stale response doesn't
    // leak into the next user's session.
    moviesLoadMoreAcRef.current?.abort()
    moviesLoadMoreAcRef.current = null
    showsLoadMoreAcRef.current?.abort()
    showsLoadMoreAcRef.current = null
    setRequestsList(null)
    setLibrary([])
    setSelectedMedia(null)
    setDetailItem(null)
    setDetailEpisodes([])
    setDetailSeasons([])
    setDetailSelectedSeason(null)
    currentEpisodesSeasonRef.current = null
    setPlayerTarget(null)
    setPartyPanelOpen(false)
    setView('home')
    // QA BUG-001 follow-up — also drop the URL back to root.
    // Without this, the URL stayed at /v2/admin (or wherever)
    // through logout. Combined with the new URL→view sync effect,
    // the next user to log in on this device would land directly
    // on the previous user's last view (and admin tab if they
    // were admin) before our auth checks fired. Server-side guards
    // prevent data leakage, but the UX reads as a permissions bug.
    navigate('/')
  }, [navigate])

  // Cross-tab logout. A logout in another tab clears aurora_token
  // and fires a `storage` event here; we tear down the watch party
  // (its sockets now hold a revoked token), drop auth state, and
  // clear cached state so a re-login as a different user doesn't
  // briefly see the previous user's content.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'aurora_token' && !e.newValue) {
        // leave() sends a best-effort leave-party then closes both
        // sockets. Sending on a revoked token may silently fail
        // server-side, but the socket-close handler will GC the
        // participant entry anyway.
        party.leave()
        setUser(false)
        // Full state reset to match handleLogout — cross-tab logout
        // must clear rails/continueItems/etc. too.
        resetUserState()
        return
      }
      // Propagate aurora_user changes (profile edits, avatar updates)
      // from another tab so we don't show stale user data.
      if (e.key === 'aurora_user' && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue)
          if (parsed && typeof parsed === 'object') {
            setUser(parsed)
          }
        } catch {
          // Corrupted aurora_user — ignore; existing state is
          // better than half-parsed garbage.
        }
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [party, resetUserState])

  // Home rails fetch — pulls Recent / Top Rated Movies / Top Rated
  // Shows in parallel, with Discover + Anchor rails wrapped in
  // catch() so the base rails always render if the recommender is
  // down. retryNonce lets the Retry button re-run the effect with a
  // fresh AbortController.
  const [retryNonce, setRetryNonce] = useState(0)
  const requestHomeReload = useCallback(() => setRetryNonce(n => n + 1), [])
  // 2026-05-27 (PR #97 H2) — scoped nonce for refreshing ONLY the
  // Continue Watching list. Bumped on player close so the Resume CTA
  // on detail picks up the updated position_ms without triggering a
  // wasteful full home-rails refetch.
  const [cwReloadNonce, setCwReloadNonce] = useState(0)

  useEffect(() => {
    if (!user) return
    const ac = new AbortController()
    let cancelled = false
    ;(async () => {
      setHomeLoading(true)
      setHomeError(null)
      try {
        // QA 2026-05-25 — the original effect awaited all five fetches
        // (core + discover + anchor) in one Promise.all. discover/
        // anchor were wrapped in `.catch(() => [])` so individual
        // failures were tolerated, BUT a HANGING discover (production
        // observed: /api/me/discover stuck pending after a cold-load
        // 503 retry) kept Promise.all from settling — even though
        // .catch only catches REJECTIONS, not stalls. Result: rails
        // array never set, Home page showed only Continue Watching
        // until the user navigated away and back.
        //
        // New shape:
        //   1. Await ONLY the three core rails. These must succeed for
        //      the home to be useful.
        //   2. Render rails immediately with the core trio.
        //   3. Fire discover + anchor with their own timeouts, race
        //      against a deadline, and splice into rails when they
        //      land. If they never land, the user keeps the core
        //      experience instead of staring at Continue Watching.
        const [recent, movies, shows] = await Promise.all([
          listRecent(12, ac.signal),
          listMedia({ type: 'movie', perPage: 20, sortBy: 'rating', signal: ac.signal }),
          listMedia({ type: 'show', perPage: 20, sortBy: 'rating', signal: ac.signal }),
        ])
        if (cancelled) return

        // Only set the rails-derived hero when the personalized pool
        // hasn't supplied one. Read via ref to avoid closure
        // staleness reporting the pool as empty after the hero fetch
        // already populated it.
        if (heroPoolRef.current.length === 0) {
          const hero = (recent[0] || movies[0] || null) as Media | null
          if (hero) setHomeHero(hero)
        }

        // Build the core rail set (no personalized yet). Order is the
        // same as the final shape so the personalized splice below
        // can insert between Recently Added and Top Rated Movies
        // without re-ordering.
        const coreRails: NonNullable<HomeViewProps['rails']> = [
          // Recently Added blends movies + shows so the See All
          // can't honestly map to a single browse page — leave the
          // affordance off rather than pick one arbitrarily.
          { title: 'Recently Added', items: recent as Media[], aspect: 'poster' as const },
          // Top Rated rails map cleanly to /movies and /shows with
          // sortBy=rating (the default), so the See All button takes
          // the user to the full Top Rated catalog.
          { title: 'Top Rated Movies', items: movies as Media[], aspect: 'poster' as const,
            seeAllTarget: { view: 'movies' as const, sortBy: 'rating' as const } },
          { title: 'Top Rated Shows', items: shows as Media[], aspect: 'poster' as const,
            seeAllTarget: { view: 'shows' as const, sortBy: 'rating' as const } },
        ]
        setHomeRails(coreRails)
        // Core rails are visible. Clear the loading state now so the
        // spinner doesn't linger waiting on the personalized rails.
        setHomeLoading(false)

        // Phase 2: personalized rails. Race against a 12s deadline so
        // a hung discover endpoint doesn't permanently leave the home
        // page personalization-less from the user's perspective
        // (timeout simply yields an empty result, same code path as
        // the existing .catch). The fetches themselves still honor
        // the AbortController, so navigating away cancels them.
        const personalizedDeadline = new Promise<{ discover: never[]; anchor: never[] }>(resolve =>
          setTimeout(() => resolve({ discover: [], anchor: [] }), 12000),
        )
        const personalizedFetch = Promise.all([
          getDiscoverRails(activeProfileId ?? undefined, ac.signal).catch(() => []),
          getAnchorRails(activeProfileId ?? undefined, ac.signal).catch(() => []),
        ]).then(([d, a]) => ({ discover: d, anchor: a }))

        const { discover, anchor } = await Promise.race([
          personalizedFetch,
          personalizedDeadline,
        ])
        if (cancelled) return

        const personalizedRails = [
          ...(discover.length > 0
            ? discover
                .filter(r => r.items.length > 0)
                .map(r => ({ title: r.title, items: r.items as Media[], aspect: 'poster' as const }))
            : []),
          ...(anchor.length > 0
            ? anchor
                .filter(r => r.items.length > 0)
                .map(r => ({ title: r.title, items: r.items as Media[], aspect: 'poster' as const }))
            : []),
        ]

        if (personalizedRails.length === 0) {
          // Nothing to splice in — keep the core rails as-is. This is
          // the path the 12s timeout took, or recommender returned
          // empty (cold-start, LLM disabled).
          return
        }

        // Splice the personalized rails between Recently Added (index
        // 0) and Top Rated Movies (index 1 in the core set). Same
        // visual order the old code produced.
        setHomeRails([
          coreRails[0],
          ...personalizedRails,
          ...coreRails.slice(1),
        ])
      } catch (err) {
        if (cancelled) return
        if (err && (err as Error).name === 'AbortError') return
        setHomeError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        // Note: setHomeLoading(false) for the success path now runs
        // earlier, right after the core rails land. This finally
        // block still covers the error path (catch above sets
        // homeError; we want the spinner off).
        if (!cancelled) setHomeLoading(false)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [user, retryNonce, activeProfileId])

  // Movies list — fetch on first visit, cache for the session.
  // Shows uses the same pattern below.
  // QA Batch B 2026-05-25 — popovers auto-close on route change.
  // Both Notifications + Server Status drawers anchor to the sidebar
  // trigger but their open state was independent of `view`, so they
  // floated over new pages until the user manually clicked them shut.
  useEffect(() => {
    setNotifOpen(false)
    setServerOpen(false)
  }, [view])

  useEffect(() => {
    if (!user || view !== 'movies' || moviesList !== null) return
    let cancelled = false
    const ac = new AbortController()
    // Server-side sort + genre — single source of truth. Client-side
    // sort can't cope with pagination (items 101+ arrive in server
    // order and concat after a re-sorted page 1). Genre is now also
    // server-side so the (genre, sort) combo paginates correctly and
    // total counts reflect the real catalog, not the loaded page.
    listMediaWithTotal({
      type: 'movie', perPage: BROWSE_PER_PAGE, sortBy: moviesSort,
      genre: moviesGenre || undefined, signal: ac.signal,
    })
      .then(({ items, total, page }) => {
        if (cancelled) return
        setMoviesList(items as Media[])
        setMoviesTotal(total)
        // Trust the server's returned page number, then advance.
        setMoviesNextPage(page + 1)
      })
      .catch(err => {
        if (cancelled || (err && err.name === 'AbortError')) return
        const id = nextToastId()
        setToasts(prev => [...prev, { id, message: 'Failed to load movies', type: 'error' }])
      })
    return () => { cancelled = true; ac.abort() }
    // moviesSort + moviesGenre included in deps so changes (which
    // clear moviesList to null via the handlers below) re-run this
    // effect with the new filter set.
  }, [user, view, moviesList, moviesSort, moviesGenre, nextToastId])

  // One-time fetch of the canonical genre catalog per browse view.
  // Doesn't need to re-fire on sort/page changes — genre set doesn't
  // shift with pagination. Only re-fetches when the user navigates
  // back into the view fresh (moviesGenres === null reset).
  useEffect(() => {
    if (!user || view !== 'movies' || moviesGenres !== null) return
    let cancelled = false
    const ac = new AbortController()
    listGenres('movie', ac.signal)
      .then(gs => { if (!cancelled) setMoviesGenres(gs) })
      .catch(() => { /* dropdown falls back to deriving from items */ })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, moviesGenres])

  useEffect(() => {
    if (!user || view !== 'shows' || showsList !== null) return
    let cancelled = false
    const ac = new AbortController()
    listMediaWithTotal({
      type: 'show', perPage: BROWSE_PER_PAGE, sortBy: showsSort,
      genre: showsGenre || undefined, signal: ac.signal,
    })
      .then(({ items, total, page }) => {
        if (cancelled) return
        setShowsList(items as Media[])
        setShowsTotal(total)
        setShowsNextPage(page + 1)
      })
      .catch(err => {
        if (cancelled || (err && err.name === 'AbortError')) return
        const id = nextToastId()
        setToasts(prev => [...prev, { id, message: 'Failed to load shows', type: 'error' }])
      })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, showsList, showsSort, showsGenre, nextToastId])

  useEffect(() => {
    if (!user || view !== 'shows' || showsGenres !== null) return
    let cancelled = false
    const ac = new AbortController()
    listGenres('show', ac.signal)
      .then(gs => { if (!cancelled) setShowsGenres(gs) })
      .catch(() => { /* fallback path */ })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, showsGenres])

  // Load More handlers — append the next page. Page state lives at
  // App level so the math survives navigating away and back mid-
  // pagination.
  const handleLoadMoreMovies = useCallback(async () => {
    if (!moviesList || moviesTotal == null || moviesLoadingMore) return
    if (moviesList.length >= moviesTotal) return
    // Defensive: abort any prior in-flight Load More.
    moviesLoadMoreAcRef.current?.abort()
    const ac = new AbortController()
    moviesLoadMoreAcRef.current = ac
    // Capture the sort at request time. If sort changes mid-flight,
    // this generation will be aborted before the response can write.
    const sortAtFetch = moviesSort
    const genreAtFetch = moviesGenre
    const pageToFetch = moviesNextPage
    setMoviesLoadingMore(true)
    try {
      const { items, page } = await listMediaWithTotal({
        type: 'movie', perPage: BROWSE_PER_PAGE, page: pageToFetch, sortBy: sortAtFetch,
        genre: genreAtFetch || undefined, signal: ac.signal,
      })
      // Audit HIGH-2 — second guard: if the controller has been
      // swapped (sort change replaced the ref), discard the result
      // even though the request itself wasn't aborted in time.
      if (moviesLoadMoreAcRef.current !== ac) return
      setMoviesList(prev => [...(prev ?? []), ...(items as Media[])])
      // Audit HIGH-1 — advance the cursor from server's page field,
      // not derived from list length. Survives variable page sizes.
      setMoviesNextPage(page + 1)
    } catch (err) {
      // Don't surface a toast for aborted requests — the user
      // changed sort or navigated away, the error is expected.
      if ((err as Error)?.name === 'AbortError') return
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Failed to load more movies', type: 'error' }])
    } finally {
      // Only clear the loading flag if THIS callback still owns
      // the controller. Otherwise a later sort change has already
      // resumed and we'd flip its flag prematurely.
      if (moviesLoadMoreAcRef.current === ac) {
        setMoviesLoadingMore(false)
        moviesLoadMoreAcRef.current = null
      }
    }
  }, [moviesList, moviesTotal, moviesLoadingMore, moviesSort, moviesGenre, moviesNextPage, nextToastId])

  const handleLoadMoreShows = useCallback(async () => {
    if (!showsList || showsTotal == null || showsLoadingMore) return
    if (showsList.length >= showsTotal) return
    showsLoadMoreAcRef.current?.abort()
    const ac = new AbortController()
    showsLoadMoreAcRef.current = ac
    const sortAtFetch = showsSort
    const genreAtFetch = showsGenre
    const pageToFetch = showsNextPage
    setShowsLoadingMore(true)
    try {
      const { items, page } = await listMediaWithTotal({
        type: 'show', perPage: BROWSE_PER_PAGE, page: pageToFetch, sortBy: sortAtFetch,
        genre: genreAtFetch || undefined, signal: ac.signal,
      })
      if (showsLoadMoreAcRef.current !== ac) return
      setShowsList(prev => [...(prev ?? []), ...(items as Media[])])
      setShowsNextPage(page + 1)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Failed to load more shows', type: 'error' }])
    } finally {
      if (showsLoadMoreAcRef.current === ac) {
        setShowsLoadingMore(false)
        showsLoadMoreAcRef.current = null
      }
    }
  }, [showsList, showsTotal, showsLoadingMore, showsSort, showsGenre, showsNextPage, nextToastId])

  // Sort-change handlers. Setting null on the items list triggers
  // the fetch effect above to re-run with the new sort, fetching
  // page 1. The total is also cleared so the "Showing N of TOTAL"
  // banner doesn't show a mismatched stale count during the
  // refetch window. Audit HIGH-2 — also abort any in-flight Load
  // More + reset the nextPage cursor so a fresh sort always starts
  // at page 1.
  const handleMoviesSortChange = useCallback((s: MediaSort) => {
    if (s === moviesSort) return
    moviesLoadMoreAcRef.current?.abort()
    moviesLoadMoreAcRef.current = null
    setMoviesSort(s)
    setMoviesList(null)
    setMoviesTotal(null)
    setMoviesNextPage(1)
    setMoviesLoadingMore(false)
  }, [moviesSort])

  const handleShowsSortChange = useCallback((s: MediaSort) => {
    if (s === showsSort) return
    showsLoadMoreAcRef.current?.abort()
    showsLoadMoreAcRef.current = null
    setShowsSort(s)
    setShowsList(null)
    setShowsTotal(null)
    setShowsNextPage(1)
    setShowsLoadingMore(false)
  }, [showsSort])

  // Genre-change handlers — mirror sort handlers because genre is
  // now also a server-side filter. Setting moviesList=null triggers
  // the fetch effect to re-run with the new (sort, genre) tuple,
  // starting at page 1, and the in-flight Load More is aborted so
  // its response can't append a stale-genre page onto the new list.
  const handleMoviesGenreChange = useCallback((g: string) => {
    if (g === moviesGenre) return
    moviesLoadMoreAcRef.current?.abort()
    moviesLoadMoreAcRef.current = null
    setMoviesGenre(g)
    setMoviesList(null)
    setMoviesTotal(null)
    setMoviesNextPage(1)
    setMoviesLoadingMore(false)
  }, [moviesGenre])

  const handleShowsGenreChange = useCallback((g: string) => {
    if (g === showsGenre) return
    showsLoadMoreAcRef.current?.abort()
    showsLoadMoreAcRef.current = null
    setShowsGenre(g)
    setShowsList(null)
    setShowsTotal(null)
    setShowsNextPage(1)
    setShowsLoadingMore(false)
  }, [showsGenre])

  // Detail fetch. Triggered when handleSelect flips view to 'detail'.
  //   - Movies: /api/media/{id}/files
  //   - Shows: /api/media/{id}/seasons + episodes of the first season
  // Episodes of other seasons load on demand via the season picker.
  useEffect(() => {
    if (!user || view !== 'detail' || !selectedMedia) {
      setDetailItem(null)
      setDetailEpisodes([])
      setDetailFiles([])
      setDetailSeasons([])
      setDetailSelectedSeason(null)
      setDetailError(null)
      // Clear the ref so navigate-away-and-back doesn't see a stale
      // (mediaId, season) and skip the re-fetch.
      currentEpisodesSeasonRef.current = null
      return
    }
    let cancelled = false
    const ac = new AbortController()
    setDetailLoading(true)
    setDetailError(null)
    // Reset on each new media so the previous show's seasons don't
    // leak into the new render frame.
    setDetailSeasons([])
    setDetailSelectedSeason(null)
    ;(async () => {
      try {
        const detail = await getMedia(selectedMedia.id, ac.signal)
        if (cancelled) return
        setDetailItem(detail)
        if (detail.type === 'show') {
          const seasonsRaw = await getSeasons(selectedMedia.id, ac.signal)
          if (cancelled) return
          // Sort by season_number so Detail doesn't show the wrong
          // season at the top.
          const seasons = [...seasonsRaw].sort((a, b) => a.season_number - b.season_number)
          setDetailSeasons(seasons)
          if (seasons.length > 0) {
            // Auto-select the first season so the user lands on
            // something; they can switch via the picker.
            setDetailSelectedSeason(seasons[0].season_number)
            const epsRaw = await getEpisodes(selectedMedia.id, seasons[0].season_number, ac.signal)
            if (cancelled) return
            const eps = [...epsRaw].sort((a, b) => a.episode_number - b.episode_number)
            setDetailEpisodes(eps)
            // Stamp the ref so the season-switch effect knows
            // what's currently loaded.
            currentEpisodesSeasonRef.current = { mediaId: selectedMedia.id, season: seasons[0].season_number }
          }
        } else {
          // Capture the files list so DetailView can render the
          // version picker for multi-file movies. handlePlay still
          // re-fetches in its own flow for resilience.
          try {
            const files = await getMediaFiles(selectedMedia.id, ac.signal)
            if (!cancelled) setDetailFiles(files)
          } catch { /* non-fatal — picker just doesn't appear */ }
        }
      } catch (err) {
        if (cancelled || (err && (err as Error).name === 'AbortError')) return
        setDetailError(err instanceof Error ? err.message : 'Failed to load details')
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()
    return () => { cancelled = true; ac.abort() }
  }, [user, view, selectedMedia])

  // 2026-05-27 — Continue Watching resume handler. Restored after the
  // PR #95 cleanup pass deleted it (see git blame on PR #95 for the
  // tombstone that lived here). PR #97 deep-debug hardening added
  // abort support, defensive null-episode-id guard, stale-entry
  // recovery, and a friendlier error-message map.
  //
  // The wiring is detail-view-driven: when the user opens detail for a
  // partially-watched title, App-level `continueItems` is scanned for
  // a match and the result is threaded into DetailView as `resume`.
  // DetailView renders a "Resume at MM:SS" CTA that calls this handler
  // with the matched record, so the server-side position_ms /
  // episode_id flow into setPlayerTarget the same way handlePlay does
  // for a fresh start. Movies and shows share the same code path; the
  // episode_id branch fetches the episode's file (the CW response
  // doesn't carry it inline).
  //
  // continueRequestRef holds the latest in-flight AbortController so a
  // second click (or a route change) aborts the previous request before
  // it can call setPlayerTarget on a stale promise. Without this, a
  // slow getEpisodes / getMediaFiles can pop the player AFTER the user
  // navigated away.
  const continueRequestRef = useRef<AbortController | null>(null)
  const handlePlayContinue = useCallback(async (c: ContinueWatchingItem) => {
    // Cancel any previous in-flight resume request (rapid double-click
    // or route change mid-load).
    continueRequestRef.current?.abort()
    const ac = new AbortController()
    continueRequestRef.current = ac
    setPlayerLoading(true)
    try {
      let preferQuality: 'auto' | '1080p' | '4k' = 'auto'
      try {
        // Guard against null / non-object shapes that JSON.parse can
        // return when localStorage was tampered with.
        const raw: unknown = JSON.parse(localStorage.getItem('aurora_prefs') || '{}')
        if (raw && typeof raw === 'object') {
          const prefs = raw as Record<string, unknown>
          if (prefs.preferred_quality === '4k') preferQuality = '4k'
          else if (prefs.preferred_quality === '1080p') preferQuality = '1080p'
        }
      } catch { /* ignore */ }
      if (c.type === 'show') {
        // Defensive: server invariant says show CW rows always have
        // episode_id + season_number (enforced by SQL WHERE clause in
        // GetContinueWatching). Don't trust it silently — a missing
        // episode_id would otherwise fall through to the movie branch
        // below and corrupt progress against the show's media_item_id
        // with fileType='media'.
        if (!c.episode_id || c.season_number === undefined) {
          throw new Error('SHOW_MISSING_EPISODE_INFO')
        }
        const eps = await getEpisodes(c.media_item_id, c.season_number, ac.signal)
        if (ac.signal.aborted) return
        const ep = eps.find(e => e.id === c.episode_id)
        if (!ep) {
          // Episode was deleted between the CW snapshot and now. Clear
          // the stale entry so the Resume CTA disappears on the next
          // render, then surface a friendly toast pointing the user
          // back to the from-start path.
          setContinueItems(prev => prev.filter(x => !(
            x.media_item_id === c.media_item_id && x.episode_id === c.episode_id
          )))
          throw new Error('EPISODE_NOT_FOUND')
        }
        const file = pickFile(ep.files, preferQuality)
        if (!file) throw new Error('EPISODE_NO_FILES')
        setPlayerTarget({
          mediaItemId: c.media_item_id,
          fileId: file.id,
          fileType: 'episode',
          episodeId: ep.id,
          title: c.title,
          subtitle: `S${c.season_number}E${c.episode_number ?? ep.episode_number}${ep.title ? ' — ' + ep.title : ''}`,
          resumePositionMs: c.position_ms,
        })
      } else {
        // Movie — same path as handlePlay but with resume position.
        const files = await getMediaFiles(c.media_item_id, ac.signal)
        if (ac.signal.aborted) return
        const file = pickFile(files, preferQuality)
        if (!file) throw new Error('NO_FILE_AVAILABLE')
        setPlayerTarget({
          mediaItemId: c.media_item_id,
          fileId: file.id,
          fileType: 'media',
          title: c.title,
          subtitle: c.year ? String(c.year) : undefined,
          resumePositionMs: c.position_ms,
        })
      }
    } catch (err) {
      // Aborts are expected when a second click supersedes the first;
      // don't toast them.
      if (err && (err as Error).name === 'AbortError') return
      // Map known error codes to friendly user-facing strings. Raw
      // err.message could leak server response bodies otherwise.
      const code = err instanceof Error ? err.message : ''
      const msg =
        code === 'SHOW_MISSING_EPISODE_INFO' ? 'Resume info is missing. Try playing from the beginning.' :
        code === 'EPISODE_NOT_FOUND'         ? 'This episode is no longer in your library. Try playing from the beginning.' :
        code === 'EPISODE_NO_FILES'          ? 'This episode has no playable file.' :
        code === 'NO_FILE_AVAILABLE'         ? 'No playable file found for this title.' :
        'Failed to resume. Please try again.'
      if (code && !['SHOW_MISSING_EPISODE_INFO', 'EPISODE_NOT_FOUND', 'EPISODE_NO_FILES', 'NO_FILE_AVAILABLE'].includes(code)) {
        // Unknown error — log the raw value for admin debugging while
        // still showing the user the generic friendly message.
        console.warn('[Aurora] handlePlayContinue unknown error', err)
      }
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: msg, type: 'error' }])
    } finally {
      // Only clear loading if this is still the active request — a
      // newer click may have superseded us, in which case the newer
      // call owns the loading state.
      if (continueRequestRef.current === ac) {
        setPlayerLoading(false)
        continueRequestRef.current = null
      }
    }
  }, [nextToastId])

  // Deep-debug M2 — memoized bundle for HomeView's CW rail. Stable
  // identity unless continueItems OR handlePlayContinue changes (both
  // already memoized upstream). Without this, the inline object
  // literal at the HomeView render would create a fresh reference
  // every App render, defeating any future React.memo on the
  // HomeView/MediaRail/MediaCardCinema tree.
  const homeCwResumeBundle = useMemo(
    () => ({ items: continueItems, onPlay: handlePlayContinue }),
    [continueItems, handlePlayContinue],
  )

  // Play a specific file from the version picker — bypasses
  // pickFile's quality preference since the user picked explicitly.
  const handlePlayFile = useCallback((m: Media, fileId: number) => {
    setPlayerTarget({
      mediaItemId: m.id,
      fileId,
      fileType: 'media',
      title: m.title,
      subtitle: m.year ? String(m.year) : undefined,
    })
  }, [])

  // Admin refresh-metadata — re-fetches detail after the server
  // starts the refresh so the UI shows updated fields.
  const handleRefreshMetadata = useCallback(async (m: Media) => {
    try {
      await refreshMetadata(m.id)
      const id = nextToastId()
      setToasts(prev => [...prev, {
        id,
        message: 'Metadata refresh triggered — may take a moment.',
        type: 'info',
      }])
      try {
        const detail = await getMedia(m.id)
        setDetailItem(detail)
      } catch { /* non-fatal */ }
    } catch (err) {
      const id = nextToastId()
      const msg = err instanceof Error ? err.message : 'Failed to refresh'
      setToasts(prev => [...prev, { id, message: msg, type: 'error' }])
    }
  }, [nextToastId])

  // Admin "Identify" flow — opens ManualMatchModal from the detail
  // screen. The modal expects a ServerMediaItem but only reads
  // id/title/type/file_path; we synthesize one from the UI Media to
  // skip a round-trip.
  const [identifyTarget, setIdentifyTarget] = useState<ServerMediaItem | null>(null)
  const handleIdentify = useCallback((m: Media) => {
    setIdentifyTarget({
      id: m.id,
      library_id: 0, // not used by the modal
      type: m.type === 'show' || m.type === 'anime' ? 'show' : 'movie',
      title: m.title,
      year: m.year,
      added_at: '',
      updated_at: '',
    } as ServerMediaItem)
  }, [])
  const handleIdentifyClose = useCallback(() => setIdentifyTarget(null), [])
  const handleIdentifyMatched = useCallback(async () => {
    const id = identifyTarget?.id
    setIdentifyTarget(null)
    if (!id) return
    // Re-fetch detail so the new metadata (poster, overview, etc.)
    // shows up immediately in the open detail view. Non-fatal: a
    // failed re-fetch just leaves the old data on screen until the
    // user navigates away and back.
    try {
      const detail = await getMedia(id)
      setDetailItem(detail)
    } catch { /* non-fatal */ }
    const tid = nextToastId()
    setToasts(prev => [...prev, {
      id: tid,
      message: 'Match saved — metadata is re-enriching in the background.',
      type: 'info',
    }])
  }, [identifyTarget, nextToastId])

  // Start a watch party with this media. Creates a quick-party
  // server-side, joins it, and opens the panel.
  //
  // QA 2026-05-25 — production observed: detail-page Watch Party
  // click → POST /api/parties → 201 → silent failure (no panel, no
  // toast, no error, no WebSocket attempt). Root cause: party.join's
  // preflight (GET /api/code/{code}/info) silently failed for a
  // just-created party — possibly a race where the manager's
  // in-memory state hadn't propagated to the GetCodeInfo path yet,
  // or apiFetch's error swallow. The fix is two-pronged:
  //   1. Pass skipPreflight=true here. We just created the party,
  //      we don't need to verify it exists via a separate GET.
  //   2. Log + toast on EVERY exit path (success, join-fail, throw)
  //      so the user always sees something — no more silent state.
  const handleStartParty = useCallback(async (m: Media) => {
    if (party.state.code) {
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'Leave the current party first.', type: 'info' }])
      return
    }
    let createdCode: string | null = null
    try {
      const resp = await createQuickParty({
        media_item_id: m.id,
        media_title: m.title,
        // Strip ANY image-proxy size variant prefix to avoid
        // double-proxying (e.g. `/api/images/w500//api/images/...`).
        media_poster: String(m.poster || '').replace(/^\/api\/images\/[^/]+\//, ''),
      })
      createdCode = resp.code
      const joinResult = await party.join(resp.code, { skipPreflight: true })
      if (joinResult.ok) {
        setPartyPanelOpen(true)
        const id = nextToastId()
        setToasts(prev => [...prev, {
          id,
          message: `Party started — share code ${resp.code}`,
          type: 'success',
        }])
      } else {
        // Server created the party but we couldn't join it. Surface
        // the error so the admin knows the party exists. Used to be
        // possible to silently end up here with `joinResult.error`
        // empty string — guard with a non-empty fallback.
        const id = nextToastId()
        setToasts(prev => [...prev, {
          id,
          message: `Party ${resp.code} created but join failed: ${joinResult.error || 'no error message returned (check console)'}`,
          type: 'error',
        }])
        // eslint-disable-next-line no-console
        console.error('[Aurora WatchParty] join failed after create', { code: resp.code, joinResult })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start party'
      const id = nextToastId()
      setToasts(prev => [...prev, {
        id,
        message: createdCode
          ? `Party ${createdCode} created but couldn't join: ${msg}`
          : msg,
        type: 'error',
      }])
      // eslint-disable-next-line no-console
      console.error('[Aurora WatchParty] handleStartParty threw', { createdCode, err })
    }
  }, [party, nextToastId])

  // M10 Phase 2 — play a specific episode (vs handlePlay which
  // plays a parent show's "first available" episode). Used by the
  // detail-view episode list. mediaItemId is the parent show's id
  // for progress tracking; episodeId is on the episode itself.
  const handlePlayEpisode = useCallback((ep: ApiEpisode) => {
    if (!selectedMedia) return
    const file = pickFile(ep.files)
    if (!file) {
      const id = nextToastId()
      setToasts(prev => [...prev, { id, message: 'This episode has no playable file.', type: 'error' }])
      return
    }
    setPlayerTarget({
      mediaItemId: selectedMedia.id,
      fileId: file.id,
      fileType: 'episode',
      episodeId: ep.id,
      title: selectedMedia.title,
      subtitle: `E${ep.episode_number}${ep.title ? ' — ' + ep.title : ''}`,
    })
  }, [selectedMedia, nextToastId])

  // M10 Phase 4.5 — episode list refetches when the user switches
  // season via the picker. The initial-load case is handled inside
  // the main detail effect above.
  //
  // We track which (mediaId, season) the current `detailEpisodes`
  // came from via a ref — comparing by episode count instead would
  // false-skip the refetch on equal-sized seasons.
  const currentEpisodesSeasonRef = useRef<{ mediaId: number; season: number } | null>(null)
  useEffect(() => {
    if (!selectedMedia || !detailSelectedSeason) return
    if (view !== 'detail') return
    if (detailItem?.type !== 'show') return
    // Skip only when the episodes in state are KNOWN to be from
    // this exact (media, season). The ref is set on every successful
    // fetch — both in the main detail effect's initial load and in
    // this effect — so we never skip incorrectly.
    const cur = currentEpisodesSeasonRef.current
    if (cur && cur.mediaId === selectedMedia.id && cur.season === detailSelectedSeason) return

    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      try {
        const epsRaw = await getEpisodes(selectedMedia.id, detailSelectedSeason, ac.signal)
        if (cancelled) return
        const eps = [...epsRaw].sort((a, b) => a.episode_number - b.episode_number)
        setDetailEpisodes(eps)
        currentEpisodesSeasonRef.current = { mediaId: selectedMedia.id, season: detailSelectedSeason }
      } catch (err) {
        if (cancelled || (err && (err as Error).name === 'AbortError')) return
        // Non-fatal — keep showing previous episodes. The picker
        // visibly stays on the failed season so the user can retry.
      }
    })()
    return () => { cancelled = true; ac.abort() }
  }, [selectedMedia, detailSelectedSeason, view, detailItem?.type])

  // Personalized hero from /api/me/hero. 503 = no recommender; we
  // fall back to listRecent[0] (set in the home-rails effect).
  const reloadHeroPool = useCallback(async (refresh: boolean) => {
    if (!user) return
    try {
      const resp = await getHeroPool(refresh, activeProfileId ?? undefined)
      heroPoolRef.current = resp.picks
      setHeroPool(resp.picks)
      setHeroPersonalization(resp.personalization)
      setHeroIndex(0)
      if (resp.picks.length > 0) setHomeHero(resp.picks[0].media)
    } catch {
      // Non-fatal — keep whatever hero we had (listRecent fallback
      // from home-rails effect).
      heroPoolRef.current = []
      setHeroPool([])
      setHeroPersonalization(null)
    }
  }, [user, activeProfileId])
  useEffect(() => {
    void reloadHeroPool(false)
  }, [reloadHeroPool])

  // Hero rotation. Cycles every 9s; pauses on hover via heroPaused.
  // CSS in HeroSection handles the crossfade.
  useEffect(() => {
    if (heroPool.length < 2 || heroPaused) return
    // Compute `next` outside the setState updater — React updaters
    // must be pure, and calling setHomeHero inside setHeroIndex
    // double-fires under StrictMode.
    let cur = heroIndex
    const id = window.setInterval(() => {
      const next = (cur + 1) % heroPool.length
      cur = next
      setHeroIndex(next)
      setHomeHero(heroPool[next].media)
    }, 9000)
    return () => window.clearInterval(id)
  // heroIndex intentionally NOT in deps — including it would clear
  // and re-create the interval every tick, drifting the cadence.
  // Using `cur` locally inside the closure keeps timing stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroPool, heroPaused])

  // Continue Watching rail. Its own fetch (independent of home
  // rails) so retry/failure paths don't couple. Re-fetches on
  // activeProfileId change.
  //
  // 2026-05-27 (PR #97 H3) — limit bumped from 12 to 50 (server cap)
  // so heavy users with many in-progress titles still get the Resume
  // CTA on the detail view. The rail itself only shows the top ~12
  // by recency, but the detail-view resume lookup needs the FULL
  // list to find a match for any title the user might open. Without
  // this, opening detail for the 13th+ most-recent in-progress title
  // silently lost the Resume affordance and Play restarted at 0:00.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const ac = new AbortController()
    listContinueWatching(50, activeProfileId ?? undefined, ac.signal)
      .then(items => { if (!cancelled) setContinueItems(items) })
      .catch(err => {
        // Non-fatal — continue rail just stays empty.
        if (!cancelled && err && (err as Error).name !== 'AbortError') {
          console.warn('[Aurora] continue-watching fetch failed', err)
        }
      })
    return () => { cancelled = true; ac.abort() }
    // 2026-05-27 — Re-runs on retryNonce (Retry button bumps both
    // home + CW) AND on cwReloadNonce (player-close bumps only CW so
    // the Resume label freshens without re-fetching home rails).
  }, [user, retryNonce, cwReloadNonce, activeProfileId])

  // 2026-05-27 — Bug-report feature-flag probe. Single fetch on user
  // login; the flag is server-config-driven (env var only) so it
  // doesn't change while the SPA is mounted. Failures leave the flag
  // off so a broken /api/feedback/config doesn't dangle a non-
  // functional UI element.
  //
  // Dep keys off the logged-in user's numeric id (deep-debug #9) so
  // cross-tab token-refresh events that recreate the user object
  // identity for the same logged-in account don't trigger a redundant
  // refetch. The user state union is `User | null | false`, so we
  // can't safely use `user?.id` (TS rightly rejects it because
  // `false.id` is nonsense). Pulling the id out via a guard keeps
  // the dep clean.
  //
  // Single cancellation mechanism: AbortController only (deep-debug
  // #20 — dropped the manual `cancelled` flag that was redundant
  // with `signal.aborted` checks).
  // TS already narrows `user && ...` to the User branch (the union
  // is User | null | false; null and false are both falsy), so the
  // truthy check alone gives us `user.id` safely.
  const userIdForBugReport = user ? user.id : undefined
  // Deep-debug M1 — on-demand refresh callable so the launcher can
  // re-fetch when the user opens the modal. The server's PAT
  // health check updates every 6h on its own ticker; without the
  // on-demand refresh an admin who stays logged in past a token
  // expiry never sees the banner until next login. Stable identity
  // via useCallback so the BugReportButton's `onRefreshConfig`
  // prop reference doesn't churn.
  const refreshBugReportConfig = useCallback(() => {
    if (!userIdForBugReport) return
    getBugReportConfig()
      .then(cfg => setBugReportConfig(cfg))
      .catch(err => {
        if (err && (err as Error).name === 'AbortError') return
        console.warn('[Aurora] bug-report config refresh failed', err)
      })
  }, [userIdForBugReport])
  useEffect(() => {
    if (!userIdForBugReport) return
    const ac = new AbortController()
    getBugReportConfig(ac.signal)
      .then(cfg => {
        if (ac.signal.aborted) return
        setBugReportConfig(cfg)
      })
      .catch(err => {
        if (err && (err as Error).name === 'AbortError') return
        // Non-fatal — the launcher just stays hidden.
        console.warn('[Aurora] bug-report config fetch failed', err)
      })
    return () => { ac.abort() }
  }, [userIdForBugReport])

  // Requests list — lazy-fetch on first visit to the tab.
  useEffect(() => {
    if (!user || view !== 'requests' || requestsList !== null) return
    let cancelled = false
    const ac = new AbortController()
    listRequests(ac.signal)
      .then(items => { if (!cancelled) setRequestsList(items) })
      .catch(err => {
        if (cancelled || (err && (err as Error).name === 'AbortError')) return
        // 404 means requests disabled server-side; show empty list.
        setRequestsList([])
      })
    return () => { cancelled = true; ac.abort() }
  }, [user, view, requestsList])

  // Logout — shares resetUserState with the cross-tab logout path.
  const handleLogout = useCallback(async () => {
    party.leave()
    await apiLogout()
    setUser(false)
    resetUserState()
  }, [party, resetUserState])

  if (user === null) {
    // Auth check in flight on a fresh tab with a stored token. Render
    // a minimal splash so we don't flash the login screen for users
    // who are already authenticated. Sub-100ms in the typical case.
    return (
      <div className="min-h-screen flex items-center justify-center aurora-bg">
        <div className="text-white/40 text-sm">Loading Aurora…</div>
      </div>
    )
  }
  if (user === false) {
    return <AuthView onLogin={(u) => setUser(u)} />
  }

  return (
    <div className="min-h-screen bg-[#050505] aurora-bg">
      {/* Sidebar */}
      <Sidebar
        user={user}
        currentView={view}
        onNavigate={handleNavigate}
        serverOpen={serverOpen}
        setServerOpen={setServerOpen}
        notifOpen={notifOpen}
        setNotifOpen={setNotifOpen}
        notifCount={0 /* Real unread-count needs the global WS + server unread-state; show 0 until that lands rather than a permanently-wrong badge. */}
        mobileOpen={sidebarMobileOpen}
        onMobileClose={() => setSidebarMobileOpen(false)}
      />

      {/* QA BUG-012 — mobile sidebar backdrop + hamburger trigger.
          Both are md:hidden so the desktop layout (sidebar always
          present at 240px) is unchanged. The backdrop dismisses
          on tap. The hamburger sits at the top-left in the space
          the sidebar would normally occupy. z-40 for backdrop puts
          it above content (10-30) but below sidebar (50). */}
      {sidebarMobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
          onClick={() => setSidebarMobileOpen(false)}
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        className={`fixed top-3 z-[55] md:hidden w-10 h-10 rounded-lg bg-[#0a0a0f]/80 backdrop-blur-sm border border-white/[0.08] flex items-center justify-center text-white/80 hover:text-white hover:bg-[#0a0a0f] ${
          // QA BUG-012 follow-up — when the sidebar drawer is open
          // the hamburger sits ABOVE the AURORA brand button (also
          // top-left of the sidebar). Tapping the upper-left would
          // close the drawer instead of triggering the documented
          // brand-as-home affordance. Swap to top-right while open.
          sidebarMobileOpen ? 'right-3' : 'left-3'
        }`}
        onClick={() => setSidebarMobileOpen(o => !o)}
        aria-label={sidebarMobileOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={sidebarMobileOpen}
      >
        <Icon name={sidebarMobileOpen ? 'x' : 'menu'} size={18} />
      </button>

      <ServerPanel
        open={serverOpen}
        isAdmin={user.role === 'admin'}
        onClose={() => setServerOpen(false)}
      />

      <NotificationPanel
        open={notifOpen}
        isAdmin={user.role === 'admin'}
        onClose={() => setNotifOpen(false)}
      />

      {/* Cmd+K Spotlight palette. Overlays everything at z-200. */}
      <SearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={(m) => {
          setPaletteOpen(false)
          // Reuse handleSelect to route to detail view + remember
          // prevView for the back button to land correctly.
          handleSelect(m as Media)
        }}
      />

      {/* Main Content */}
      <main className="md:ml-[240px] min-h-screen">
        {/* Sticky stack: scan bar + header in one sticky container
            so the scan bar contributes its height to flow and both
            pin together on scroll. */}
        <div className="sticky top-0 z-40">
          {/* Global scan progress bar (admin-only). Returns null when
              no scan is active. */}
          <ScanProgressBar isAdmin={user.role === 'admin'} />
          {/* Top Bar */}
          <header className="bg-[#050505]/80 backdrop-blur-xl border-b border-white/[0.04] px-8 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4 flex-1">
            {/* Search */}
            <div className="relative max-w-md w-full">
              <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search titles... (⌘K)"
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-white/[0.03] border-white/[0.06] focus:bg-white/[0.05]"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  if (e.target.value) {
                    setView('search')
                  } else if (view === 'search') {
                    setView('home')
                  }
                }}
                onFocus={() => setSearchOpen(true)}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Party — M10 Phase 4. Click opens the panel if already
                in a party, otherwise prompts for a code to join. */}
            <button
              onClick={() => {
                if (party.state.code) {
                  setPartyPanelOpen(o => !o)
                } else {
                  setPartyJoinPrompt(true)
                }
              }}
              title={party.state.code ? `In party ${party.state.code}` : 'Join a watch party'}
              className="relative w-10 h-10 rounded-xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] flex items-center justify-center text-white/60 hover:text-white transition-all"
            >
              <Icon name="users" size={18} />
              {party.state.code && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full border-2 border-[#050505]" />
              )}
            </button>
            {/* Phase 5 — profile picker. Shows when the user has at
                least one profile defined. Hidden in single-profile
                deployments to keep the top bar clean. */}
            {profiles.length > 0 && (
              <select
                value={activeProfileId ?? ''}
                onChange={e => setActiveProfileId(e.target.value ? parseInt(e.target.value, 10) : null)}
                title="Active profile (filters Continue Watching + recommendations)"
                className="text-xs py-2 px-3 bg-white/[0.05] border border-white/[0.06] rounded-lg text-white/80 hover:bg-white/[0.08] focus:outline-none"
              >
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' ★' : ''}</option>
                ))}
              </select>
            )}
            {/* User — QA 2026-05-25: avatar now opens a dropdown menu
                instead of deep-scrolling to the Account section of
                Settings. The previous behavior surprised users who
                expected a Plex/Netflix-style profile menu (Profile /
                Settings / Sign Out). */}
            <UserMenu
              user={user}
              onNavigate={(v) => handleNavigate(v)}
              onSignOut={() => { void handleLogout() }}
            />
          </div>
        </header>
        </div>{/* /sticky stack */}

        {/* Page Content */}
        <div className="p-8">
          {view === 'home' && (
            <HomeView
              onSelect={handleSelect}
              onPlay={handlePlay}
              hero={homeHero ?? undefined}
              // Prepend the Continue Watching rail. Dedupe by
              // media_item_id at the rail level so a show with
              // progress on multiple episodes only surfaces one card
              // (most-recently-watched) — avoids duplicate-key
              // warnings and the "click the old card, play the new
              // episode" confusion. LibraryView keeps every row.
              rails={(() => {
                if (!homeRails && continueItems.length === 0) return undefined
                const base = homeRails ?? []
                if (continueItems.length === 0) return base
                const seen = new Set<number>()
                const deduped = continueItems.filter(c => {
                  if (seen.has(c.media_item_id)) return false
                  seen.add(c.media_item_id)
                  return true
                })
                return [
                  {
                    title: 'Continue Watching',
                    items: deduped.map(c => mapContinueToMedia(c)) as Media[],
                    // 'poster' (not 'landscape') so the full 2:3
                    // frame shows — landscape cropped to a 16:9
                    // slice that hid title art.
                    aspect: 'poster' as const,
                    // Stable identifier for HomeView's resume-play
                    // interceptor (title is for display only).
                    kind: 'continue-watching' as const,
                  },
                  ...base,
                ]
              })()}
              loading={homeLoading}
              error={homeError}
              onRetry={requestHomeReload}
              onCardContext={openCardContextMenu}
              heroReason={heroPool[heroIndex]?.reason}
              onRefreshHero={() => void reloadHeroPool(true)}
              onHeroPauseChange={setHeroPaused}
              heroPersonalization={heroPersonalization}
              libraryIds={libraryIds}
              onToggleLib={handleToggleLib}
              // 2026-05-27 — Hero resume bundle. Same lookup as
              // DetailView's `resume`: find the user's CW record for
              // the current hero (movie OR show) with position_ms > 0.
              // When present, HeroSection swaps its primary CTA from
              // "Play" to "Resume at MM:SS" (or "Resume S2E5 · MM:SS"
              // for shows) and dispatches handlePlayContinue with the
              // matched record. Resolved via an IIFE so the lookup
              // sits inline at the call site and re-runs naturally
              // when continueItems or homeHero changes.
              heroResume={(() => {
                if (!homeHero) return undefined
                // isResumable replaces the bare `position_ms > 0` check
                // so the Hero matches every other surface's threshold
                // (deep-debug H2: was an asymmetry — Hero was the only
                // site already using the 5s gate; detail/CW lookups
                // were on > 0).
                const item = continueItems.find(c =>
                  c.media_item_id === homeHero.id && isResumable(c),
                )
                return item ? { item, onPlay: handlePlayContinue } : undefined
              })()}
              // 2026-05-27 — Continue Watching one-click resume on
              // the home CW rail. HomeView scopes the resume pill
              // to rail.kind === 'continue-watching'; this prop
              // just supplies the lookup data + handler.
              // Deep-debug M2 — memoized so HomeView / MediaRail can
              // benefit from React.memo in the future without the
              // bundle re-creating fresh references every render.
              cwResume={homeCwResumeBundle}
              onNavigate={(v, opts) => {
                // QA 2026-05-25 — "See All" deep-link to a browse
                // page with an explicit sort. If the destination's
                // current sort doesn't match, route through the
                // sort-change handler so the page resets list/total
                // /cursor and refetches with the rail's sort. If it
                // already matches, the cached list is correct and
                // we skip the refetch.
                if (opts?.sortBy && v === 'movies' && opts.sortBy !== moviesSort) {
                  handleMoviesSortChange(opts.sortBy as MediaSort)
                }
                if (opts?.sortBy && v === 'shows' && opts.sortBy !== showsSort) {
                  handleShowsSortChange(opts.sortBy as MediaSort)
                }
                handleNavigate(v)
              }}
            />
          )}
          {/* M10 Phase 2 — Browse views use real API data when loaded.
              While loading, show a brief loading state instead of
              flashing the prototype's mock library to the user. */}
          {view === 'movies' && (
            moviesList === null
              ? <BrowseLoadingState title="Movies" />
              : <BrowseView
                  items={moviesList}
                  total={moviesTotal}
                  title="Movies"
                  subtitle="Browse your movie collection"
                  sortBy={moviesSort}
                  onSortChange={handleMoviesSortChange}
                  genreFilter={moviesGenre}
                  onGenreChange={handleMoviesGenreChange}
                  availableGenres={moviesGenres}
                  onLoadMore={handleLoadMoreMovies}
                  isLoadingMore={moviesLoadingMore}
                  onSelect={handleSelect}
                  onCardContext={openCardContextMenu}
                  libraryIds={libraryIds}
                  onToggleLib={handleToggleLib}
                />
          )}
          {view === 'shows' && (
            showsList === null
              ? <BrowseLoadingState title="TV Shows" />
              : <BrowseView
                  items={showsList}
                  total={showsTotal}
                  title="TV Shows"
                  subtitle="Browse your series collection"
                  sortBy={showsSort}
                  onSortChange={handleShowsSortChange}
                  genreFilter={showsGenre}
                  onGenreChange={handleShowsGenreChange}
                  availableGenres={showsGenres}
                  onLoadMore={handleLoadMoreShows}
                  isLoadingMore={showsLoadingMore}
                  onSelect={handleSelect}
                  onCardContext={openCardContextMenu}
                  libraryIds={libraryIds}
                  onToggleLib={handleToggleLib}
                />
          )}
          {view === 'library' && (
            <LibraryView
              library={library}
              continueItems={continueItems}
              onSelect={handleSelect}
              onToggleLib={handleToggleLib}
              // 2026-05-27 — Continue Watching one-click resume on
              // the LibraryView CW grid (mirrors home CW rail).
              onPlayContinue={handlePlayContinue}
            />
          )}
          {view === 'detail' && selectedMedia && (
            <DetailView
              media={selectedMedia}
              onBack={handleBack}
              onPlay={handlePlay}
              onToggleLib={handleToggleLib}
              inLibrary={library.some(l => l.id === selectedMedia.id)}
              detail={detailItem ?? undefined}
              apiEpisodes={detailEpisodes}
              onPlayEpisode={handlePlayEpisode}
              onEpisodeUnavailable={(ep) => {
                // Dedupe identical toasts per episode within a 2s
                // window — mash-protected without losing later
                // legitimate re-clicks.
                const now = Date.now()
                const last = unavailableToastRef.current.get(ep.id) || 0
                if (now - last < 2000) return
                unavailableToastRef.current.set(ep.id, now)
                addToast(`No file available for episode E${ep.episode_number}${ep.title ? ' — ' + ep.title : ''}`, 'info')
              }}
              loading={detailLoading}
              error={detailError}
              onStartParty={handleStartParty}
              inParty={!!party.state.code}
              seasons={detailSeasons}
              selectedSeason={detailSelectedSeason}
              onSelectSeason={setDetailSelectedSeason}
              onAddToWatchlist={profiles.length > 0 ? (m) => setAddToListMedia(m) : undefined}
              onRefreshMetadata={user.role === 'admin' ? handleRefreshMetadata : undefined}
              onIdentify={user.role === 'admin' ? handleIdentify : undefined}
              files={detailFiles}
              onPlayFile={handlePlayFile}
              // 2026-05-27 — Continue Watching resume. If the user has
              // partial progress on this media (movie OR a specific
              // episode of a show), find the matching CW record and
              // thread it into DetailView so the Resume CTA renders.
              //
              // Correctness note: `continueItems` is already deduped
              // server-side via `DISTINCT ON (wp.media_item_id) ...
              // ORDER BY wp.media_item_id, wp.updated_at DESC` (see
              // GetContinueWatching in internal/db/queries_phase2.go),
              // so for a show with progress on multiple episodes the
              // returned row is always the most-recently-watched
              // episode — which is exactly the right "Resume" target.
              // `find` therefore returns either the single matching
              // row or undefined; no merge/sort/dedup needed here.
              //
              // isResumable replaces the bare `position_ms > 0` check
              // for parity with Hero / home CW rail / Library CW grid
              // (deep-debug H2 — was the only call site still on > 0,
              // which surfaced "Resume" on detail for sub-5s progress
              // even though no other surface offered the affordance).
              resume={(() => {
                const item = continueItems.find(c =>
                  c.media_item_id === selectedMedia.id && isResumable(c),
                )
                return item ? { item, onPlay: handlePlayContinue } : undefined
              })()}
            />
          )}
          {view === 'search' && <SearchView query={searchQuery} onSelect={handleSelect} libraryIds={libraryIds} onToggleLib={handleToggleLib} />}
          {view === 'settings' && <SettingsView user={user} onLogout={handleLogout} />}
          {view === 'collections' && (
            <CollectionsView
              isAdmin={user.role === 'admin'}
              rewindNonce={navRewindNonce}
              onOpenCreate={() => setCollectionsModalOpen(true)}
              onOpenMedia={(id) => {
                // Synthesize a minimal Media shape for handleSelect;
                // the detail fetch hydrates full data.
                handleSelect({
                  id,
                  title: '',
                  year: 0,
                  rating: 0,
                  duration: '',
                  genre: '',
                  type: 'movie',
                  poster: '',
                  description: '',
                })
              }}
              // QA BUG-007 — pass the same library affordance other
              // surfaces (Movies/Shows/Search) already have. Map the
              // ServerMediaItem to UIMedia carrying real poster/year/
              // rating/genre so toggling into My Library persists the
              // full record to localStorage (otherwise the stored
              // entry shows up as a posterless year-0 placeholder
              // until the next /api/media refresh re-hydrates it).
              libraryIds={libraryIds}
              onToggleLib={(m) => handleToggleLib({
                id: m.id,
                title: m.title,
                year: m.year ?? 0,
                rating: m.rating ?? 0,
                duration: '',
                genre: (m.genres && m.genres[0]) || '',
                type: m.type,
                poster: posterURL(m.poster_path),
                backdrop: backdropURL(m.backdrop_path),
                description: m.overview ?? '',
              })}
            />
          )}
          {/* Phase 6 — Calendar view (upcoming TV episodes). */}
          {view === 'calendar' && (
            <CalendarView
              onOpenMedia={(id) => {
                handleSelect({
                  id,
                  title: '',
                  year: 0,
                  rating: 0,
                  duration: '',
                  genre: '',
                  type: 'show',
                  poster: '',
                  description: '',
                })
              }}
            />
          )}
          {view === 'requests' && (
            <RequestsView
              requests={requestsList}
              onRequestSubmitted={(r) => {
                setRequestsList(prev => prev ? [r, ...prev] : [r])
                const id = nextToastId()
                setToasts(prev => [...prev, {
                  id,
                  message: `Requested "${r.title}"`,
                  type: 'success',
                }])
              }}
              onRequestDeleted={(id) => {
                setRequestsList(prev => prev ? prev.filter(r => r.id !== id) : prev)
                const tId = nextToastId()
                setToasts(prev => [...prev, { id: tId, message: 'Request deleted', type: 'info' }])
              }}
            />
          )}
          {view === 'admin' && <AdminView currentAdminId={user.id} />}
        </div>
      </main>

      {/* Video Player */}
      {/* M10 Phase 2 — real HLS player. The mock VideoPlayer that
          animated a fake currentTime is now unused (still defined
          for reference); future cleanup will remove it. */}
      {playerLoading && !playerTarget && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center">
          <div className="text-white/70 text-sm">Resolving stream…</div>
        </div>
      )}
      <VideoPlayer
        target={playerTarget}
        onClose={() => {
          setPlayerTarget(null)
          // 2026-05-27 (PR #97 H2) — refetch Continue Watching after
          // the player closes so the Resume CTA on detail picks up the
          // new position_ms. Without this, after the user watches for
          // 10 minutes and re-opens detail in the same session, the
          // Resume label still shows the OLD position and clicking it
          // jumps back. Dedicated cwReloadNonce (not the broader
          // retryNonce) keeps this scoped to the CW fetch — no wasted
          // home-rails refetch on every player close.
          setCwReloadNonce(n => n + 1)
        }}
        onChangeAudioTrack={(index, resumeMs) => {
          // Re-emit target with the new audio index. The player
          // tears down + recreates the HLS session; thread the live
          // position through resumePositionMs so playback resumes
          // where the user actually was.
          setPlayerTarget(prev => prev ? {
            ...prev,
            audioTrackIndex: index,
            resumePositionMs: resumeMs,
          } : prev)
        }}
        onSendReaction={party.state.code && party.state.roomConnected ? party.sendReaction : undefined}
        onFallbackToTranscode={() => {
          // Re-emit current target with forceTranscode=true. The
          // player's mediaErrorFallbackTriedRef prevents an infinite
          // loop if transcode also fails.
          setPlayerTarget(prev => prev ? { ...prev, forceTranscode: true } : prev)
        }}
        onSeekRebuild={(newStartSec) => {
          // 2026-05-27 — Forward-seek past buffer. Same teardown +
          // re-init pattern as onChangeAudioTrack: mutate the target
          // with a fresh resumePositionMs, which retriggers the play
          // effect inside VideoPlayer and creates a new HLS session
          // anchored at the new position.
          //
          // This handler is a pure target-mutator — the player has
          // already gated invocation on the party-sync check
          // (refined in deep-debug M1 to "is this exact media being
          // party-synced"). Any future caller that invokes this
          // handler outside the player must apply its own gate.
          setPlayerTarget(prev => prev ? {
            ...prev,
            resumePositionMs: Math.max(0, Math.floor(newStartSec * 1000)),
          } : prev)
        }}
        party={party.state.code ? {
          isHost: party.state.hostUserId === user.id,
          tickRef: party.tickRef,
          helloAbsMsRef: party.helloAbsMsRef,
          hlsStartSec: party.state.hlsStartSec,
          isPlaying: party.state.isPlaying,
          // Thread the party's mediaItemId so the player can refuse
          // to mirror when local content doesn't match.
          partyMediaItemId: party.state.mediaItemId,
          requestPlay: party.requestPlay,
          requestPause: party.requestPause,
          requestSeek: party.requestSeek,
          // 2026-05-25 — NTP-style clock offset for drift extrapolation.
          // Filled by repeated time-syncs on the sync socket.
          clockOffsetRef: party.clockOffsetRef,
        } : undefined}
      />

      {/* Floating reaction overlay — renders independently of the
          player so panel-only users still see reactions. */}
      {party.state.code && <ReactionOverlay events={party.state.recentReactions} />}

      {partyPanelOpen && party.state.code && (
        <PartyPanel
          state={party.state}
          currentUserId={user.id}
          onSendChat={party.sendChat}
          onSendReaction={party.sendReaction}
          onLeave={() => { party.leave(); setPartyPanelOpen(false) }}
          onClose={() => setPartyPanelOpen(false)}
          voice={party.voice}
          onJoinVoice={() => {
            party.joinVoice().catch(err => {
              const id = nextToastId()
              // 2026-05-26 — copy now distinguishes real-world failure modes
              // using the `reason` tag the voice controller attaches via the
              // Permissions API. The original "Microphone blocked — allow
              // access in your browser" was misleading for users who HAD
              // granted browser permission but were blocked at the OS level
              // (macOS Privacy & Security → Microphone → Browser unchecked):
              // they kept toggling the browser prompt while the real fix
              // was in System Settings.
              const reason = (err as { reason?: string })?.reason
              let message = 'Microphone unavailable. Check that no other app is using it.'
              if (err instanceof Error && err.name === 'NotAllowedError') {
                if (reason === 'denied') {
                  // Browser-API state is "denied" — could be browser-level
                  // (site-blocked) OR OS-level (browser-not-in-allowlist).
                  // The OS one is the surprise; spell it out so the user
                  // doesn't bounce off the browser prompt.
                  message = 'Microphone blocked. Allow it in your browser AND in System Settings → Privacy → Microphone (your browser must be checked).'
                } else if (reason === 'prompt') {
                  message = 'Microphone permission needed — click Allow in the browser prompt to join voice.'
                } else if (reason === 'device') {
                  // 2026-05-27 (deep-debug Bug 12) — the browser reports
                  // "granted" but getUserMedia still threw NotAllowedError.
                  // Most likely (a) macOS/Windows mic privacy blocking the
                  // browser at the OS level (Permissions API can't see
                  // this), or (b) another app holds the mic exclusively.
                  // Mention BOTH so the user can troubleshoot either path
                  // — the original "device unavailable" copy missed the OS
                  // case entirely.
                  message = 'Microphone permission OK in the browser, but the audio stream was blocked. Check your operating system privacy settings, or close any other app that may have the microphone open.'
                } else {
                  // Permissions API not supported (older Safari) or query
                  // failed — fall back to the original wording.
                  message = 'Microphone blocked — allow access in your browser to join voice.'
                }
              }
              setToasts(prev => [...prev, { id, message, type: 'error' }])
              // Also surface to console for users / support to inspect.
              // The err here is a DOMException from getUserMedia, which
              // carries only {name, message, code} — no tokens, no
              // internal URLs. Safe to log. If anyone wraps this err with
              // extra context in the future (e.g. iceServers URL, session
              // token), audit that the new fields are safe to log here
              // before merging.
              // eslint-disable-next-line no-console
              console.warn('[Aurora Voice] join failed', { name: (err as Error)?.name, reason, err })
            })
          }}
          onLeaveVoice={party.leaveVoice}
          onToggleVoiceMute={party.toggleVoiceMute}
          onSendReady={party.sendReady}
        />
      )}

      {collectionsModalOpen && (
        <CollectionsModal
          isAdmin={user.role === 'admin'}
          onClose={() => setCollectionsModalOpen(false)}
          onCreated={(c) => {
            const id = nextToastId()
            setToasts(prev => [...prev, {
              id,
              message: `Created "${c.name}"${c.kind === 'ai' && c.item_count ? ` with ${c.item_count} AI picks` : ''}`,
              type: 'success',
            }])
          }}
        />
      )}

      {addToListMedia && activeProfileId && (
        <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setAddToListMedia(null)}>
          <div className="w-full max-w-sm bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-5" onClick={e => e.stopPropagation()}>
            <h2 className="text-white text-lg font-semibold mb-2">Add "{addToListMedia.title}" to…</h2>
            <p className="text-white/40 text-xs mb-4">Profile: {profiles.find(p => p.id === activeProfileId)?.name}</p>
            {addToListLists === null && <p className="text-white/40 text-sm">Loading…</p>}
            {addToListLists && addToListLists.length === 0 && (
              <div className="text-white/50 text-sm mb-3">
                No watchlists yet. Create one in Settings → Profiles &amp; Watchlists first.
              </div>
            )}
            {addToListLists && addToListLists.map(l => (
              <button
                key={l.id}
                disabled={addToListBusy}
                onClick={async () => {
                  setAddToListBusy(true)
                  try {
                    await addToWatchlist(activeProfileId, l.id, addToListMedia.id)
                    const tId = nextToastId()
                    setToasts(prev => [...prev, { id: tId, message: `Added to "${l.name}"`, type: 'success' }])
                    setAddToListMedia(null)
                  } catch (err) {
                    window.alert('Failed: ' + (err instanceof Error ? err.message : 'unknown'))
                  } finally {
                    setAddToListBusy(false)
                  }
                }}
                className="w-full text-left px-4 py-2.5 mb-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/85 text-sm transition-colors disabled:opacity-50"
              >
                {l.name}
              </button>
            ))}
            <button
              onClick={() => setAddToListMedia(null)}
              className="w-full mt-3 py-2 text-white/60 hover:text-white text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Watch Party hub — replaces the old "type a 6-character code"
          modal. Three sections: Recently in (localStorage cache), My
          Rooms (persistent rooms via /api/rooms), Enter a code. See
          PartyHubModal.tsx for the rationale. */}
      {partyJoinPrompt && user && typeof user === 'object' && (
        <PartyHubModal
          currentUserId={user.id}
          onClose={() => setPartyJoinPrompt(false)}
          onJoin={async (joinCode) => {
            const r = await party.join(joinCode)
            if (r.ok) {
              setPartyJoinPrompt(false)
              setPartyPanelOpen(true)
            }
            return r
          }}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Manual identify modal (admin-only). Rendered at App level so
          it overlays any screen. Same modal as Admin → Flagged. */}
      {identifyTarget && (
        <ManualMatchModal
          target={identifyTarget}
          onClose={handleIdentifyClose}
          onMatched={handleIdentifyMatched}
        />
      )}

      {/* 2026-05-27 — Bug-report launcher. Gated on the server-side
          BUG_REPORT_ENABLED env var so a misconfigured deploy doesn't
          dangle a non-functional button.
          - prefillName uses the user's display username, NOT email,
            so a public-repo deploy doesn't leak emails into issue
            bodies that anyone with repo read access can see (deep-
            debug #7).
          - `hidden` props (was: gate on `!playerTarget`) — moved
            INTO the component so the modal stays mounted across
            player open/close events. This keeps an in-flight screen
            recording or capture from being silently aborted if a
            watch-party teleports the user into the host's player
            mid-recording (holistic deep-debug M1).
          - Component itself also hides when admin panels open
            (Server / Notifications at z-[45] cover the launcher
            on mobile — holistic deep-debug H2). */}
      {bugReportConfig?.enabled && (
        <BugReportButton
          prefillName={user.username}
          onToast={addToast}
          // 2026-05-27 (PR #107 follow-up — deep-debug H1/M1):
          // Restored serverOpen / notifOpen and added partyPanelOpen.
          // The previous PR's reasoning "panels anchor LEFT" is only
          // true on desktop — at the md breakpoint both panels span
          // `left-2 right-2` (full viewport width), covering the
          // bottom-right launcher at z-45 > z-40. PartyPanel is a
          // right-edge drawer at z-70 that covers the launcher on
          // every viewport when open. Hiding the launcher in these
          // cases is the cheap, correct fix — the admin can close
          // the panel and reopen the bug-report flow.
          hidden={!!playerTarget || serverOpen || notifOpen || partyPanelOpen}
          // 2026-05-27 — PAT health diagnostics. Server populates
          // these fields only for admin requesters; the modal shows
          // a warning banner when token_healthy === false.
          tokenHealthy={bugReportConfig.token_healthy}
          tokenHealthReason={bugReportConfig.token_health_reason}
          onRefreshConfig={refreshBugReportConfig}
        />
      )}

      {/* Toast */}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  )
}
