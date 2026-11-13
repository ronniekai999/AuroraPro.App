// Whether "Back" stays inside the app.
//
// The in-app Back controls (the title page's arrow, Escape on a title, and
// Escape on the search page with nothing typed) step the browser's history
// back one entry. That is only right when the entry behind is one this app
// pushed in this tab. Otherwise the step would leave the app for whatever
// page the tab was on before it, and the caller goes to Tonight instead.
//
// Two signs that nothing of the app is behind:
//   - the router's key for this entry is 'default': the entry the tab
//     loaded the app on (a typed address, a bookmark, a link from outside);
//   - the router's own index for this entry is 0. It writes an index into
//     every history entry's state, and 0 is the first one it saw in the
//     tab. This catches the first entry after the app has REPLACED it (a
//     redirect off a page the session is not shown, the fallback to
//     Tonight itself), which gives it a real key with still nothing behind.
// Where the state carries no index (a router that does not use the
// browser's history, as in tests), the key alone decides.

/** True when stepping back one history entry lands on an entry of this app. */
export function hasInAppEntryBehind(locationKey: string, historyState: unknown): boolean {
  if (locationKey === 'default') return false
  const idx = (historyState as { idx?: unknown } | null | undefined)?.idx
  return idx !== 0
}
