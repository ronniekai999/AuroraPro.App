// Where "Report a bug" opens its dialog.
//
// The dialog describes the page it is opened over: "Capture this page"
// draws the document behind it, and a report carries the address the tab is
// at when it is sent. From the identity panel that is the page under the
// panel, so the dialog simply opens. The Me page is a page of its own: a
// report opened over it would be a report about Me. So from Me the app
// first goes back to the page the person came from, and opens the dialog
// there.
//
// "The page the person came from" is the last address shown that was not Me,
// nor Settings opened from Me (on a phone Settings is reached through Me,
// and is part of the same corner of the app). It is one session's: it is
// kept with the user and the profile it was shown to, and is nobody else's.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** How long the app waits for the page it went back to before it opens the
 *  dialog where the person is instead. */
export const RETURN_GIVE_UP_MS = 1500
/** How long the dialog waits for a page that is still drawn as a skeleton.
 *  After that it opens anyway: the person can wait before they capture. */
export const SKELETON_WAIT_MS = 4000

export interface BugReportEntryInput {
  /** The signed-in user, or null when nobody is. */
  userId: number | null
  /** The profile the session acts as, or null when that is not known. */
  profileId: number | null
  /** The address on screen and its history entry (react-router's location). */
  location: { pathname: string; search: string; key: string }
  /** How the app arrived at this entry: react-router's navigation type,
   *  "PUSH" for a step forward. */
  arrivedBy: string
  /** The page an address shows: "me", "settings", "movies"… */
  viewOf: (pathname: string) => string
  /** The page that is drawn. It follows the address by a render. */
  shownView: string
  /** Whether this session may be sent to an address now: the gate the
   *  routes themselves use. */
  mayShow: (pathname: string) => boolean
  /** Go to an address, as a step forward; and one step back in history. */
  goTo: (path: string) => void
  goBack: () => void
  /** Called each time the dialog is asked for. */
  onAsk?: () => void
}

export interface BugReportEntry {
  /** The dialog is open. */
  open: boolean
  /** Open the dialog over the page on screen. */
  openHere: () => void
  /** From the Me page: go back to the page the person came from and open
   *  the dialog there, or here when there is no such page. */
  openFromMe: () => void
  close: () => void
}

interface Remembered { owner: string; pathname: string; search: string; key: string }

/** True while the page still shows the app's loading shapes. */
function stillLoading(): boolean {
  return typeof document !== 'undefined' && document.querySelector('main .stage-skel') !== null
}

export function useBugReportEntry(input: BugReportEntryInput): BugReportEntry {
  const { userId, profileId, location, arrivedBy, viewOf, shownView, mayShow, goTo, goBack, onAsk } = input
  const owner = `${userId}:${profileId}`
  const [open, setOpen] = useState(false)
  // The address the app is on its way back to, before the dialog opens.
  const [returning, setReturning] = useState<string | null>(null)

  // Nothing of one person's visit outlives it: a sign-out closes the dialog
  // (the app stays mounted through it, so this state would otherwise greet
  // the next person to sign in), and a change of profile drops a return
  // that has not arrived. Reset in the render that sees the change.
  const [forUser, setForUser] = useState(userId)
  const [forOwner, setForOwner] = useState(owner)
  if (forUser !== userId) {
    setForUser(userId)
    setOpen(false)
  }
  if (forOwner !== owner) {
    setForOwner(owner)
    setReturning(null)
  }

  // The last page shown that was not Me, with whom it was shown to.
  const last = useRef<Remembered | null>(null)
  // A Me entry that was reached by a step forward, and the entry (`back`)
  // one step behind it. When that is the page above, one step back is that
  // page as the person left it, scrolled to where they were.
  const meEntry = useRef<{ key: string; back: string } | null>(null)
  // The entry before this one.
  const before = useRef<{ key: string; view: string; fromMe: boolean } | null>(null)

  useEffect(() => {
    if (last.current && last.current.owner !== owner) {
      last.current = null
      meEntry.current = null
    }
    if (userId === null) { before.current = null; return }
    const view = viewOf(location.pathname)
    const prev = before.current
    const moved = prev?.key !== location.key
    // Settings opened from Me, and any of Settings opened from there.
    const fromMe = view === 'settings' && (moved
      ? !!prev && (prev.view === 'me' || (prev.view === 'settings' && prev.fromMe))
      : !!prev?.fromMe)
    if (view === 'me') {
      // Only a step forward leaves the entry it came from one step behind:
      // a replacement leaves whatever was before the page it replaced.
      if (moved && arrivedBy === 'PUSH' && prev) meEntry.current = { key: location.key, back: prev.key }
    } else if (!fromMe) {
      last.current = { owner, pathname: location.pathname, search: location.search, key: location.key }
    }
    before.current = { key: location.key, view, fromMe }
  }, [owner, userId, location.pathname, location.search, location.key, arrivedBy, viewOf])

  // What the openers read, as of the last render: they are handed to
  // memoised children and must not change with every address.
  const now = useRef({ owner, key: location.key, mayShow, goTo, goBack, onAsk })
  useLayoutEffect(() => { now.current = { owner, key: location.key, mayShow, goTo, goBack, onAsk } })
  // Set as the app sets off, not at the next render: two presses in one
  // moment must not go back twice.
  const going = useRef(false)
  useEffect(() => { if (returning === null) going.current = false }, [returning])

  const openHere = useCallback(() => {
    now.current.onAsk?.()
    setReturning(null)
    setOpen(true)
  }, [])

  const openFromMe = useCallback(() => {
    const at = now.current
    // A second press while the first is on its way changes nothing.
    if (going.current) return
    at.onAsk?.()
    const to = last.current
    if (!to || to.owner !== at.owner || !at.mayShow(to.pathname)) {
      setOpen(true)
      return
    }
    going.current = true
    setReturning(to.pathname + to.search)
    const me = meEntry.current
    if (me && me.key === at.key && me.back === to.key) at.goBack()
    else at.goTo(to.pathname + to.search)
  }, [])

  // The dialog opens once the page gone back to is the one drawn.
  const onMe = viewOf(location.pathname) === 'me'
  const arrived = returning !== null && !onMe && shownView === viewOf(location.pathname)
  useEffect(() => {
    if (returning === null) return
    if (!arrived) {
      // Nothing came of going back: the dialog opens where the person is.
      const t = window.setTimeout(() => { setReturning(null); setOpen(true) }, RETURN_GIVE_UP_MS)
      return () => window.clearTimeout(t)
    }
    // Two frames, so the page has been painted where it was scrolled to;
    // then for as long as it is still loading shapes, within reason.
    let frame = 0
    let frames = 0
    const since = Date.now()
    const look = () => {
      frames++
      if ((frames >= 2 && !stillLoading()) || Date.now() - since >= SKELETON_WAIT_MS) {
        setReturning(null)
        setOpen(true)
        return
      }
      frame = requestAnimationFrame(look)
    }
    frame = requestAnimationFrame(look)
    return () => cancelAnimationFrame(frame)
  }, [returning, arrived])

  const close = useCallback(() => setOpen(false), [])
  return { open, openHere, openFromMe, close }
}
