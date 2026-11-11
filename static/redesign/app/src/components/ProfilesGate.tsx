// "Who's watching?": the full-page profile picker.
//
// A self-gating overlay, the same shape as TasteOnboardingGate: the host
// renders it unconditionally and it decides whether to appear. That keeps the
// policy (lib/profileGate) in one place instead of spread across the host's
// render conditions.
//
// Policy: first visit per device, then remembered; skipped entirely when
// there is only one profile; openable on demand from the identity menu.
//
// NOT a route. It is an overlay, so it composites over whatever page you were
// on and needs no router change, no history entry, and no answer to "what
// happens if someone bookmarks /profiles while signed out".
//
// Each profile says what it is: its own colour or chosen avatar, a lock when
// it needs a PIN, and its rating limit, so a child's profile is never
// mistaken for a parent's.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Profile } from '@/lib/api'
import { Lock, Plus } from 'lucide-react'
import { ProfileAvatar } from './ProfileAvatar'
import { AuroraWordmark } from './AuroraWordmark'
import { profileSummary } from '@/lib/navScope'
import { setAccountProfileIds } from '@/lib/profileColors'
import { hasSeenProfileGate, markProfileGateSeen, shouldShowProfileGate } from '@/lib/profileGate'
import { nextRadioIndex } from '@/lib/radiogroup'
import { lockBodyScroll } from '@/lib/scrollLock'

interface ProfilesGateProps {
  profiles: Profile[]
  activeProfileId: number | null
  /**
   * Switches to a profile. Resolve false when the switch did not happen (a
   * cancelled PIN prompt, a refused activation); the gate then stays up. It
   * is called only on a pick, never while arrowing: a locked profile prompts
   * for its PIN, and arrowing past one must not.
   */
  onSelect: (id: number) => boolean | Promise<boolean>
  /** Routes to where profiles are created (Settings). */
  onAddProfile?: () => void
  /** True once the signed-in user and their profile list have loaded. */
  ready: boolean
  /** Set by the switcher's "Who's watching?" item to open the gate on demand. */
  forced?: boolean
  /** Called on any dismissal, so the host can clear `forced`. */
  onDismiss?: () => void
  /**
   * Reports whether the gate is currently up. The gate self-gates, so the host
   * cannot otherwise know — and it needs to: App's Cmd+K handler guards on
   * every other blocking surface (`playerTarget`, `partyJoinPrompt`,
   * `contextMenu`, `addToListMedia`) and the gate was missing from the list,
   * while SearchPalette renders at z-200 over it. So Cmd+K opened the palette
   * on top of the gate and selecting a result navigated the app behind a gate
   * that stayed up — the same family as the Escape-bubbling bug above.
   */
  onOpenChange?: (open: boolean) => void
}

// One size at every width. A 390px phone fits two 148px tiles to a row; a
// 320px one fits one.
const PICKER_AVATAR = 120

/** The line under a profile's name. The limit is always part of it, "No
 *  limit" included: whether a profile is restricted is the fact a parent
 *  reads this screen for, so a default or locked profile without a limit
 *  says so too. (The tone lean the line once carried is a preference, not a
 *  limit, and is not shown here.) */
function pickerSummary(p: Pick<Profile, 'is_default' | 'has_pin' | 'max_age_rating'>): string {
  const line = profileSummary(p)
  return p.max_age_rating?.trim() || line === 'No limit' ? line : `${line} · no limit`
}

export function ProfilesGate({
  profiles, activeProfileId, onSelect, onAddProfile, ready, forced = false, onDismiss,
  onOpenChange,
}: ProfilesGateProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // `seen` is LATCHED IN STATE, not read from localStorage on every render.
  //
  // It used to be `seen: hasSeenProfileGate()` inline, and that made the gate's
  // primary path dead on arrival: markProfileGateSeen() writes localStorage,
  // which React cannot see, so closing depended on one of the two setState
  // calls beside it actually scheduling a render. On a first visit neither does
  // — onDismiss sets `forced` false when it is already false, and onSelect sets
  // activeProfileId to the id it already holds, because the pre-selected orb is
  // both the ring-highlighted one and the one that receives focus on open.
  // React bails out eagerly when Object.is(next, current) and the fiber has no
  // pending work, so clicking the highlighted profile did nothing at all.
  //
  // Keyboard was strictly worse: arrows now select as they move (WCAG 2.1.1),
  // so by the time Enter fires, activeProfileId ALWAYS already equals the
  // focused orb — a keyboard-only user could never dismiss a first-visit gate
  // by picking anyone. The only exits were Add-Profile and a reload.
  //
  // On Home an unrelated 9s hero-rotation interval re-rendered the tree and the
  // gate closed "eventually", which is exactly why this survived a manual pass.
  // The account's profile ids, for the avatars' colours: every avatar in the
  // app reads its colour from this set (lib/profileColors), so no two of the
  // account's profiles share one. This component is mounted whenever someone
  // is signed in, whether or not the picker shows. Before paint, so no avatar
  // is drawn in a colour it is about to lose.
  const profileIdsKey = profiles.map(p => p.id).join(',')
  useLayoutEffect(() => {
    setAccountProfileIds(profileIdsKey ? profileIdsKey.split(',').map(Number) : [])
  }, [profileIdsKey])
  const [seen, setSeen] = useState(() => hasSeenProfileGate())
  // The radio the keyboard has moved to. Arrowing used to call onSelect on
  // every press, which made it a real profile switch; switches now go through
  // the server and can need a PIN, so arrows move this and a pick commits it.
  const [highlightId, setHighlightId] = useState<number | null>(activeProfileId)
  const [picking, setPicking] = useState(false)
  const open = shouldShowProfileGate({
    profileCount: profiles.length,
    seen,
    forced,
    ready,
  })

  // Focus the active profile's orb (or the first) on open, so a keyboard user
  // starts inside the gate rather than at the top of a document they can't see.
  // Captures the opener first and restores it on close — every dismissal path
  // (pick, Add-Profile, Escape, the keep-watching button) unmounts the gate
  // along with the focused element, and React does not relocate focus, so all
  // four used to drop it to <body> (WCAG 2.4.3).
  useEffect(() => {
    if (!open) return
    setHighlightId(activeProfileId)
    const opener = document.activeElement as HTMLElement | null
    const i = Math.max(0, profiles.findIndex(p => p.id === activeProfileId))
    const t = window.setTimeout(() => itemRefs.current[i]?.focus(), 0)
    return () => {
      window.clearTimeout(t)
      // Only if the opener is still in the document — it may have unmounted
      // (e.g. the identity menu that launched us closed behind the gate).
      if (opener && opener.isConnected) opener.focus()
    }
    // Deliberately keyed on `open` only: re-running when activeProfileId
    // changes would yank focus mid-interaction — and arrow-key selection now
    // changes activeProfileId on every press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])
  // Unmount is a close, whatever `open` last said.
  useEffect(() => () => onOpenChange?.(false), [onOpenChange])

  // Scroll lock — the gate covers the viewport, and unlike the theater the page
  // behind it is NOT inert (nothing applies inert or .stage-dim-app for the
  // gate; aria-modal is a hint to AT and the Tab trap above handles the tab
  // ring, but pointer and programmatic reach into the page remain). So the lock
  // is what stops the content scrolling under an opaque overlay.
  //
  // Shared ref-counted lock: playback can start while the gate is open, and
  // then the theater holds the same lock. Local save/restore only composes if
  // the two release in LIFO order. See lib/scrollLock.
  useEffect(() => {
    if (!open) return
    return lockBodyScroll()
  }, [open])

  if (!open) return null

  const dismiss = () => {
    markProfileGateSeen()
    setSeen(true)
    onDismiss?.()
  }

  const pick = async (id: number) => {
    if (picking) return
    setHighlightId(id)
    setPicking(true)
    let switched = false
    try {
      switched = await onSelect(id)
    } finally {
      setPicking(false)
    }
    if (switched) dismiss()
    // Not switched (a cancelled PIN prompt, a refused activation): the checked
    // radio goes back to the profile that is actually active.
    else setHighlightId(activeProfileId)
  }

  // Escape dismisses only when the gate was opened BY HAND. On a first visit it
  // is a genuine gate — dismissing it without a choice would leave the app
  // running as whichever profile happened to be stored, which is the ambiguity
  // the gate exists to remove. Nor when no profile is active: the host forces
  // the gate open when it could not read the session's binding, and there is
  // no current profile to keep watching as.
  const dismissable = forced && activeProfileId !== null

  return (
    <div
      ref={rootRef}
      // z-85, not z-70. TasteOnboardingGate renders OnboardingFlow at z-[80]
      // with an opaque fill, and both gates self-gate independently —
      // so on a first visit where the STORED active profile hasn't onboarded
      // (the "existing users get prompted once at next login" cohort, on a
      // >=2-profile server) both mounted and the taste flow covered the picker.
      // Render order had this right and z-index inverted it; the comment at the
      // call site claimed the outcome the z-index was preventing. Pick who you
      // are first, then onboard that profile.
      className="fixed inset-0 z-[85] bg-surface-page"
      role="dialog"
      aria-modal="true"
      aria-label="Who's watching?"
      onKeyDown={e => {
        // stopPropagation UNCONDITIONALLY for Escape. It used to be inside the
        // `dismissable` branch, so on a genuine first-visit gate Escape bubbled
        // past React's root to App's window-level keydown handler — which on a
        // detail page calls handleBack(). The gate stayed up and the route
        // underneath changed silently, so a user who hit Escape reflexively then
        // picked a profile and landed somewhere else entirely.
        if (e.key === 'Escape') {
          e.stopPropagation()
          if (dismissable) dismiss()
        }
        // H2's Tab trap. aria-modal is a hint to AT's virtual cursor and does
        // nothing to the browser's tab ring, so without this Tab walked out of
        // an opaque full-viewport overlay into TopNav and the search field
        // behind it — focus ring painted behind the gate (WCAG 2.4.3, and 2.4.11
        // Focus Not Obscured). Same first/last wrap TopNav's mobile sheet uses.
        if (e.key === 'Tab') {
          const root = rootRef.current
          if (!root) return
          const focusables = root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])',
          )
          if (focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        }
      }}
    >
      <div className="absolute inset-0 overflow-y-auto">
      <div className="min-h-full flex flex-col px-4 sm:px-12 pb-10">
        <div className="h-16 flex-none flex items-center gap-2.5" aria-hidden="true">
          <AuroraWordmark decorative ink="#F4F4F5" className="h-[15px] w-auto" />
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-10 sm:gap-14 py-6">
        <h1 className="font-display font-extrabold text-ink text-[36px] sm:text-[56px] leading-none tracking-[-0.02em] text-center">
          Who&rsquo;s watching?
        </h1>

        {/* role="radiogroup": exactly one profile ends up active, and the
            keyboard contract is the radiogroup one (arrows move and select, the
            set is one tab stop), the same helper Settings' choices use. */}
        <div
          role="radiogroup"
          aria-label="Profiles"
          className="flex flex-wrap items-start justify-center gap-x-4 gap-y-8 sm:gap-10"
          // Arrows MOVE AND CHECK: they advance highlightId, the checked radio,
          // and focus follows. The first version only called .focus(), and
          // that was a real keyboard-reachability failure (WCAG 2.1.1): with
          // nothing advancing the checked index, ArrowRight from the first of
          // five profiles focused the second and then the second again, and the
          // rest were unreachable, since the roving tabIndex gives the set one
          // tab stop.
          //
          // Arrows used to check by switching profiles outright (onSelect on
          // every press). Switches now go through the server and can need a
          // PIN, so arrows check locally and a pick (click, Enter, Space)
          // commits; a pick that does not switch puts the check back.
          onKeyDown={e => {
            const n = nextRadioIndex(
              e.key,
              Math.max(0, profiles.findIndex(p => p.id === highlightId)),
              profiles.length,
            )
            if (n === null) return
            e.preventDefault()
            // Selection only, NOT pick(), which switches profiles, marks the
            // gate seen and dismisses it. Arrowing must not commit and close.
            setHighlightId(profiles[n].id)
            itemRefs.current[n]?.focus()
          }}
        >
          {profiles.map((p, i) => {
            const sel = p.id === highlightId
            const limit = p.max_age_rating?.trim()
            return (
              <button
                key={p.id}
                ref={el => { itemRefs.current[i] = el }}
                type="button"
                role="radio"
                aria-checked={sel}
                tabIndex={sel ? 0 : -1}
                // Not disabled while a pick is pending: disabling the focused
                // tile would blur it, and focus would return to <body>, outside
                // the gate's Tab trap, when a PIN prompt over it is cancelled.
                // pick() ignores a second click instead.
                onClick={() => { void pick(p.id) }}
                // The lift is `.stage-orb`, not scale utilities: a primitive
                // that owns the transform can own the reduced-motion opt-out.
                className="stage-orb group flex w-[148px] sm:w-[168px] flex-col items-center gap-4 rounded-sheet p-2 text-center"
              >
                <span className="relative">
                  {/* The ring is the selected cue: white on graphite, so it
                      survives a monochrome display and does not depend on the
                      avatar's own colour. */}
                  <ProfileAvatar
                    avatarUrl={p.avatar_url}
                    name={p.name}
                    colorKey={p.id}
                    size={PICKER_AVATAR}
                    className={
                      sel
                        ? 'ring-2 ring-ink ring-offset-[3px] ring-offset-surface-page'
                        : 'ring-0 group-hover:ring-2 group-hover:ring-ink-2 group-hover:ring-offset-[3px] group-hover:ring-offset-surface-page'
                    }
                  />
                  {/* Decorative: the line under the name says both in words. */}
                  {limit && (
                    <span
                      aria-hidden="true"
                      data-profile-limit=""
                      className="absolute -right-1.5 -bottom-1.5 h-8 px-2.5 rounded-full bg-ink text-action-on text-[13px] font-bold leading-[26px] border-[3px] border-surface-page"
                    >
                      {limit}
                    </span>
                  )}
                  {p.has_pin && (
                    <span
                      aria-hidden="true"
                      data-profile-lock=""
                      className={`absolute bottom-0.5 h-9 w-9 rounded-full bg-ink text-action-on grid place-items-center border-[3px] border-surface-page ${limit ? 'left-0.5' : 'right-0.5'}`}
                    >
                      <Lock size={16} strokeWidth={2.25} />
                    </span>
                  )}
                </span>
                <span className="min-w-0 w-full flex flex-col gap-0.5">
                  <span className="block truncate text-[20px] font-semibold text-ink">{p.name}</span>
                  <span className="block text-[13px] leading-snug text-ink-2">{pickerSummary(p)}</span>
                </span>
              </button>
            )
          })}

        </div>

        {/* Add profile is an ACTION, not a choice, so it is a plain button and
            it lives OUTSIDE the radiogroup element: ARIA takes the DOM at its
            word, a `radiogroup` owns only `radio` children, and a plain button
            inside one is both an invalid child and a second tab stop in a set
            documented as having exactly one. */}
        <div className="flex flex-wrap items-center justify-center gap-3">
          {/* Not while no profile is active: leaving for Settings would
              leave the gate without a pick (see dismissable). */}
          {onAddProfile && activeProfileId !== null && (
            <button
              type="button"
              onClick={() => { onAddProfile(); dismiss() }}
              className="h-11 px-4 inline-flex items-center gap-2 rounded-control bg-action-soft text-ink text-[15px] font-semibold hover:brightness-125 transition-[filter]"
            >
              <Plus size={18} aria-hidden="true" />
              Add profile
            </button>
          )}
          {dismissable && (
            <button
              type="button"
              onClick={dismiss}
              className="h-11 px-4 rounded-control text-ink-2 hover:text-ink text-[15px] font-semibold transition-colors"
            >
              Keep watching as {profiles.find(p => p.id === activeProfileId)?.name ?? 'current profile'}
            </button>
          )}
        </div>
        </div>
      </div>
      </div>
    </div>
  )
}
