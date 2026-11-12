// Where things live in the app, and which of them a session may be shown.
//
// Three destinations (Tonight, Library, Together) plus search and one
// identity control. Movies, TV Shows, Collections, My Library and Upcoming
// are scopes of Library; each keeps the view id and URL it always had.
//
// A session acting as a restricted profile (one with a content limit) is
// shown only Tonight, Movies and Shows: no Together, no requests, no admin.
// That is presentation, not enforcement (the server enforces the limit), but
// it must follow the profile the SERVER has confirmed for the session, never
// a remembered choice: `activeId` here is App's activeProfileId, which only
// changes once the server's binding is read or an activation resolves.

import type { Profile } from './api'
import { isRestrictedProfile } from './profileSession'

/**
 * - 'full': the session is known to act as an unrestricted profile, or the
 *   account is known to have no profile at all (it then acts as the server's
 *   unrestricted stand-in).
 * - 'restricted': the session is known to act as a profile with a limit.
 * - 'unknown': the binding has not been read, the profile list failed to
 *   load, or the bound profile is not in the list. Nothing a restricted
 *   profile must not see is offered, and nothing is restyled for children.
 */
export type NavScope = 'full' | 'restricted' | 'unknown'

export function navScopeFor(profiles: Profile[], profilesLoaded: boolean, activeId: number | null): NavScope {
  if (activeId === null) return profilesLoaded && profiles.length === 0 ? 'full' : 'unknown'
  const acting = profiles.find(p => p.id === activeId)
  if (!acting) return 'unknown'
  return isRestrictedProfile(acting) ? 'restricted' : 'full'
}

/** The Library destination's id. Deliberately NOT a view id: My Library's
 *  view is 'library', and a destination that shared the id made the My
 *  Library scope unreachable (a click on it read as "go to Library, where
 *  you already are"). */
export const LIBRARY_DESTINATION = 'catalog'

export interface NavDestination {
  /** A view id, or LIBRARY_DESTINATION for the Library group. */
  id: string
  label: string
  icon: string
}

export interface LibraryScope {
  /** The view id (and URL segment) the scope renders. */
  id: 'movies' | 'shows' | 'collections' | 'library' | 'calendar'
  label: string
}

const ALL_LIBRARY_SCOPES: readonly LibraryScope[] = [
  { id: 'movies', label: 'Movies' },
  { id: 'shows', label: 'TV Shows' },
  { id: 'collections', label: 'Collections' },
  { id: 'library', label: 'My Library' },
  { id: 'calendar', label: 'Upcoming' },
]

/** The Library scopes a session is offered. Only Movies and TV Shows until
 *  the session is known to be unrestricted. */
export function libraryScopesFor(scope: NavScope): LibraryScope[] {
  return scope === 'full' ? [...ALL_LIBRARY_SCOPES] : ALL_LIBRARY_SCOPES.filter(s => s.id === 'movies' || s.id === 'shows')
}

/** Every view that is a scope of Library, whatever the session may be offered:
 *  a restricted session that opens /collections by URL is still in Library. */
export function isLibraryView(view: string): boolean {
  return ALL_LIBRARY_SCOPES.some(s => s.id === view)
}

/** The top-level destinations, in order. A restricted session gets Movies and
 *  Shows as destinations of their own in place of the Library group. */
export function navDestinationsFor(scope: NavScope): NavDestination[] {
  const tonight: NavDestination = { id: 'home', label: 'Tonight', icon: 'home' }
  if (scope === 'restricted') {
    return [tonight, { id: 'movies', label: 'Movies', icon: 'movie' }, { id: 'shows', label: 'Shows', icon: 'tv' }]
  }
  const library: NavDestination = { id: LIBRARY_DESTINATION, label: 'Library', icon: 'library' }
  if (scope === 'unknown') return [tonight, library]
  return [tonight, library, { id: 'together', label: 'Together', icon: 'users' }]
}

/** Which destination a view belongs to, or null for a page outside the three
 *  (settings, admin, a title, search…). */
export function destinationForView(view: string, scope: NavScope): string | null {
  if (view === 'home') return 'home'
  if (scope === 'restricted') return view === 'movies' || view === 'shows' ? view : null
  if (isLibraryView(view)) return LIBRARY_DESTINATION
  if (view === 'together' || view === 'members' || view === 'member') return scope === 'full' ? 'together' : null
  return null
}

/** Pages a restricted session is not shown: Together and the member pages,
 *  requests, the profile page, and every Library scope but Movies and Shows
 *  (Collections, My Library, Upcoming). A restricted session sees Tonight,
 *  Movies and Shows, with search, a title's own page, Settings and the
 *  account page; saving a title to My Library still works from a card. */
export function hiddenFromRestricted(view: string): boolean {
  return view === 'together' || view === 'requests' || view === 'members' || view === 'member' || view === 'profile'
    || view === 'collections' || view === 'library' || view === 'calendar'
}

/**
 * Whether a page hiddenFromRestricted may be RENDERED for this session, on
 * this commit. The redirect that sends a restricted session to Tonight runs
 * in an effect, after the commit, so the page itself must not render either:
 *
 * - 'full': yes.
 * - 'restricted': never. The commit that switches into a restricted profile
 *   already has this scope, so the page is gone on that very commit.
 * - 'unknown', before the startup profile load has settled: no. The session
 *   may turn out to be a restricted one, and its bookmarked /together must
 *   not show and then bounce. It settles in moments.
 * - 'unknown', after startup has settled: it could not be learned which
 *   profile this session acts as. If the app is ASKING (the picker is up,
 *   because the binding could not be read): no, the pick will answer it.
 *   Otherwise (the profile list itself failed to load, or the bound profile
 *   is not in it) nothing on screen can answer it, and an unrestricted
 *   user must not be locked out of these pages for the life of the tab, so:
 *   yes. The server still answers every request for the profile it has
 *   bound; the bar still offers no way in.
 */
export function mayRenderHidden(scope: NavScope, startup: { settled: boolean; askingForProfile: boolean }): boolean {
  if (scope === 'full') return true
  if (scope === 'restricted') return false
  return startup.settled && !startup.askingForProfile
}

/** One line of facts about a profile, for a switcher row: "Default · locked
 *  with a PIN", "Up to PG", "No limit". Only what the profile record holds. */
export function profileSummary(p: Pick<Profile, 'is_default' | 'has_pin' | 'max_age_rating'>): string {
  const limit = p.max_age_rating?.trim()
  // The limit is always stated, "no limit" included: it is the fact a
  // person choosing a profile most needs, and a line that left it out for a
  // default or locked profile read as if nothing were known about it.
  const facts = [p.is_default ? 'default' : null, p.has_pin ? 'locked with a PIN' : null, limit ? `up to ${limit}` : 'no limit']
    .filter((f): f is string => f !== null)
  const line = facts.join(' · ')
  return line[0].toUpperCase() + line.slice(1)
}
