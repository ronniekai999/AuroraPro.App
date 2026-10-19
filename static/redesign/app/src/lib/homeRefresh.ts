// When Home refetches, and what it may throw away when it does.
//
// Home loads once and keeps its rails in App's state; App never unmounts, so
// without something forcing a re-run, a library scan's new titles stayed
// invisible until a hard refresh. The two decisions below are what drive that
// re-run, extracted here because both were got wrong in review and neither is
// testable inside a 5,000-line component.

/** How long Home's data may sit before returning to it refetches. */
export const HOME_STALE_MS = 30_000

/**
 * Whether landing on Home should trigger a refetch.
 *
 * `lastAttemptAt` must be stamped when a load STARTS, not when it succeeds.
 * Stamping on success leaves this armed for the whole load, so every return to
 * Home during a slow one aborts and restarts it — measured at zero completions
 * across six navigations during an 8s load, leaving Home silently rail-less.
 * That is worse than the staleness it exists to fix.
 */
export function shouldRefreshHome(opts: {
  view: string
  signedIn: boolean
  lastAttemptAt: number
  now: number
  staleMs?: number
}): boolean {
  const { view, signedIn, lastAttemptAt, now, staleMs = HOME_STALE_MS } = opts
  if (!signedIn || view !== 'home') return false
  return now - lastAttemptAt > staleMs
}

/**
 * Whether a load may discard the personalized rails (Discover, anchor,
 * engagement) already on screen.
 *
 * Only when they belong to a DIFFERENT profile — which is the entire reason
 * the reset exists: stopping a profile switch from splicing the previous
 * profile's picks. Doing it on a same-profile refresh tears every AI rail off
 * the page for a round-trip and collapses the layout, a bigger flicker than
 * the loading skeleton that is deliberately suppressed for the same reason.
 *
 * `railsProfile` is `undefined` before the first load, which counts as a
 * change — nothing is on screen to preserve. `null` is a real value meaning
 * "the session's acting profile", so it must not be conflated with undefined.
 */
export function shouldResetPersonalizedRails(
  railsProfile: number | null | undefined,
  activeProfile: number | null,
): boolean {
  return railsProfile !== activeProfile
}
