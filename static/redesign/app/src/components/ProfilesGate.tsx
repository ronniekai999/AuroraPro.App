// "Who's watching?" — the full-page profile stage (Aurora Stage Phase 7b, D7).
//
// Mockup screen 02. A self-gating overlay, the same shape as TasteOnboardingGate:
// the host renders it unconditionally and it decides whether to appear. That
// keeps the policy (lib/profileGate) in one place instead of spread across the
// host's render conditions.
//
// D7 policy: first visit per device, then remembered; skipped entirely when
// there is only one profile; openable on demand from the switcher.
//
// NOT a route. It is an overlay, so it composites over whatever page you were on
// and needs no router change, no history entry, and no answer to "what happens
// if someone bookmarks /profiles while signed out". The mockup draws it at a URL;
// the behaviour it depicts is a gate, and a gate is what this is.

import { useEffect, useRef, useState } from 'react'
import type { Profile } from '@/lib/api'
import { ProfileAvatar } from './ProfileAvatar'
import { Icon } from './Icon'
import { maturityLeanLabel } from '@/lib/maturity'
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
  // four used to drop it to <body> (WCAG 2.4.3). ProfileSwitcher was fixed for
  // exactly this last phase and hands focus over correctly; the gate was
  // dropping it on the floor.
  useEffect(() => {
    if (!open) return
    setHighlightId(activeProfileId)
    const opener = document.activeElement as HTMLElement | null
    const i = Math.max(0, profiles.findIndex(p => p.id === activeProfileId))
    const t = window.setTimeout(() => itemRefs.current[i]?.focus(), 0)
    return () => {
      window.clearTimeout(t)
      // Only if the opener is still in the document — it may have unmounted
      // (e.g. the switcher menu that launched us closed behind the gate).
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
  }

  // Escape dismisses only when the gate was opened BY HAND. On a first visit it
  // is a genuine gate — dismissing it without a choice would leave the app
  // running as whichever profile happened to be stored, which is the ambiguity
  // the gate exists to remove.
  const dismissable = forced

  return (
    <div
      ref={rootRef}
      // z-85, not z-70. TasteOnboardingGate renders OnboardingFlow at z-[80]
      // with an opaque `bg-[#07060c]`, and both gates self-gate independently —
      // so on a first visit where the STORED active profile hasn't onboarded
      // (the "existing users get prompted once at next login" cohort, on a
      // >=2-profile server) both mounted and the taste flow covered the picker.
      // Render order had this right and z-index inverted it; the comment at the
      // call site claimed the outcome the z-index was preventing. Pick who you
      // are first, then onboard that profile.
      className="fixed inset-0 z-[85] aurora-bg"
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
      {/* Same starfield + wash the sign-in screen uses; this is the other
          "before you're in the app" surface and they should read as a pair.

          These sit OUTSIDE the scroller, and that placement is load-bearing.
          Both are `position: absolute; inset: 0` primitives, so their containing
          block is the nearest positioned ancestor's PADDING box — when that was
          the scroller itself, they were sized to one viewport and scrolled away
          with the content. On a 375px screen with 8 profiles the picker is
          ~1260px tall, so ~600px of tail rendered on bare `aurora-bg`: no stars,
          no wash, visibly a different surface from the top of the same page.
          Making the root the positioned box and the scroller a child fixes it
          without touching either primitive (both set `position`, so a call-site
          `fixed` utility could not win against them anyway — see the CASCADE
          HAZARD note in index.css). */}
      <div className="stage-stars" aria-hidden="true" />
      <div className="page-tint" aria-hidden="true" />

      <div className="absolute inset-0 z-[1] overflow-y-auto">
      <div className="min-h-full flex flex-col items-center justify-center px-6 py-16">
        <h1 className="font-display font-extrabold text-white text-3xl md:type-browse text-center">
          Who&rsquo;s watching?
        </h1>
        <p className="text-white/65 text-sm md:text-base mt-3 text-center max-w-[46ch]">
          Pick a profile — your taste, watchlists and progress travel with you.
        </p>

        {/* role="radiogroup": exactly one profile ends up active, and the
            keyboard contract is the radiogroup one (arrows move and select, the
            set is one tab stop) — the same helper Settings' dials use. */}
        <div
          role="radiogroup"
          aria-label="Profiles"
          className="mt-10 flex flex-wrap items-start justify-center gap-6 md:gap-9"
          // Arrows MOVE AND SELECT. The first version only called .focus(), and
          // that was a real keyboard-reachability failure (WCAG 2.1.1), not a
          // nicety: `current` was derived from activeProfileId, so with nothing
          // selecting, `current` never advanced. ArrowRight from the first of
          // five profiles focused the second, and pressing it again focused the
          // second again — the third and fourth were unreachable by keyboard at
          // all, since the roving tabIndex gives the set one tab stop. A pointer
          // user could pick them; a keyboard user could not.
          //
          // Settings' dials call their apply+setState before focusing, which is
          // why `current` advances there. This copied the focus line and dropped
          // the state change — while a comment claimed it was "the same keyboard
          // contract Settings' dials use".
          onKeyDown={e => {
            const n = nextRadioIndex(
              e.key,
              Math.max(0, profiles.findIndex(p => p.id === highlightId)),
              profiles.length,
            )
            if (n === null) return
            e.preventDefault()
            // Selection only — NOT pick(), which switches profiles, marks the
            // gate seen and dismisses it. Arrowing must not commit and close.
            setHighlightId(profiles[n].id)
            itemRefs.current[n]?.focus()
          }}
        >
          {profiles.map((p, i) => {
            const sel = p.id === highlightId
            const sub = [p.is_default ? 'Default' : null, p.has_pin ? 'Locked' : null, maturityLeanLabel(p.maturity_pref)]
              .filter(Boolean).join(' · ')
            return (
              <button
                key={p.id}
                ref={el => { itemRefs.current[i] = el }}
                type="button"
                role="radio"
                aria-checked={sel}
                tabIndex={sel ? 0 : -1}
                // Not disabled while a pick is pending: disabling the focused
                // orb would blur it, and focus would return to <body>, outside
                // the gate's Tab trap, when a PIN prompt over it is cancelled.
                // pick() ignores a second click instead.
                onClick={() => { void pick(p.id) }}
                // The lift is `.stage-orb`, not `hover:scale-[1.04]
                // focus-visible:scale-[1.04]`: those two sat outside every one
                // of the file's prefers-reduced-motion blocks (WCAG 2.3.3), and
                // a primitive that owns the transform can own the opt-out too.
                className="stage-orb group flex w-[132px] flex-col items-center gap-3 rounded-2xl p-2 text-center"
              >
                {/* 118px orbs, the mockup's size. The ring is the selected cue
                    and it survives a monochrome display, unlike a colour shift
                    on a radial-gradient orb. */}
                <ProfileAvatar
                  avatarUrl={p.avatar_url}
                  name={p.name}
                  size={118}
                  className={
                    sel
                      ? 'ring-[3px] ring-purple-300/90 ring-offset-4 ring-offset-[#050505]'
                      : 'ring-2 ring-white/10 group-hover:ring-white/30'
                  }
                />
                <span className="min-w-0 w-full">
                  <span className="block truncate font-display text-[15px] font-bold text-white">{p.name}</span>
                  <span className="block truncate text-[11.5px] text-white/60">{sub || 'Profile'}</span>
                </span>
              </button>
            )
          })}

        </div>

        {/* Dashed Add-Profile tile — the mockup's `.orb.add`. It is an ACTION,
            not a choice, so it is a plain button and it lives OUTSIDE the
            radiogroup element. It used to be a DOM child of it while a comment
            claimed it was "outside the radiogroup semantically" — but ARIA takes
            the DOM at its word: a `radiogroup` owns only `radio` children, and a
            plain button inside one is both an invalid child and a second tab
            stop in a set documented as having exactly one. Wrapped so it keeps
            flowing on the same visual line as the orbs. */}
        <div className="mt-6 flex flex-wrap items-start justify-center gap-6 md:gap-9">
          {onAddProfile && (
            <button
              type="button"
              onClick={() => { onAddProfile(); dismiss() }}
              className="flex w-[132px] flex-col items-center gap-3 rounded-2xl p-2 text-center text-white/55 transition-colors hover:text-white/85"
            >
              <span className="grid h-[118px] w-[118px] place-items-center rounded-full border-2 border-dashed border-white/25 bg-white/[0.04]">
                <Icon name="plus" size={34} />
              </span>
              <span>
                <span className="block font-display text-[15px] font-bold">Add profile</span>
                <span className="block text-[11.5px] text-white/45">Taste onboarding in Settings</span>
              </span>
            </button>
          )}
        </div>

        {dismissable && (
          <button
            type="button"
            onClick={dismiss}
            className="stage-btn stage-btn-sm stage-btn-quiet mt-10"
          >
            Keep watching as {profiles.find(p => p.id === activeProfileId)?.name ?? 'current profile'}
          </button>
        )}
      </div>
      </div>
    </div>
  )
}
