// "Previously on": the recap Aurora writes of what a profile has finished,
// and the spoiler-safe questions a viewer can ask about it. A sheet on the
// right edge of the title page; full screen on a phone.

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MessageCircleQuestion, Play, X } from 'lucide-react'
import type { RecapUpTo } from '@/lib/api'
import { AskPreviouslyPanel } from '@/components/detail/AskPreviouslyPanel'
import { boundaryLabel, recapReasonCopy } from '@/components/detail/recapPresentation'
import { useAskPreviously, type ConfirmAction } from '@/components/detail/useAskPreviously'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export type { RecapUpTo }

interface Props {
  mediaId: number
  profileId?: number
  title: string
  loading: boolean
  recap?: string
  suggestedQuestions?: string[]
  upTo?: RecapUpTo
  unavailableReason?: string
  hasAskHistory?: boolean
  error?: string | null
  onClose: () => void
  onStart?: () => void
  resumeLabel?: string
  onRefreshRecap?: () => Promise<void>
  onHistoryChanged?: (hasHistory: boolean) => void
}

type View = 'recap' | 'ask'

// Remount the entire modal session when its privacy identity changes. This
// synchronously removes the prior profile/show's conversation and draft in the
// same commit; a passive cleanup effect would leave them visible for one frame.
export function RecapModal(props: Props) {
  const identity = `${props.mediaId}:${props.profileId ?? 'default'}`
  return <RecapModalSession key={identity} {...props} />
}

function RecapModalSession({
  mediaId,
  profileId,
  title,
  loading,
  recap,
  suggestedQuestions = [],
  upTo,
  unavailableReason,
  hasAskHistory = false,
  error,
  onClose,
  onStart,
  resumeLabel,
  onRefreshRecap,
  onHistoryChanged,
}: Props) {
  const [view, setView] = useState<View>('recap')
  const [shown, setShown] = useState('')
  const typeTimer = useRef<number | undefined>(undefined)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const askButtonRef = useRef<HTMLButtonElement>(null)
  const askHeadingRef = useRef<HTMLHeadingElement>(null)
  const confirmReturnFocusRef = useRef<HTMLButtonElement | null>(null)
  const ask = useAskPreviously({
    active: view === 'ask',
    mediaId,
    profileId,
    fallbackBoundary: upTo,
    onRefreshRecap,
    onHistoryChanged,
  })

  useEffect(() => {
    window.clearInterval(typeTimer.current)
    if (!recap) {
      setShown('')
      return
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      setShown(recap)
      return
    }
    let index = 0
    typeTimer.current = window.setInterval(() => {
      index = Math.min(recap.length, index + 2)
      setShown(recap.slice(0, index))
      if (index >= recap.length) window.clearInterval(typeTimer.current)
    }, 16)
    return () => window.clearInterval(typeTimer.current)
  }, [recap])

  useEffect(() => {
    if (view !== 'ask') return
    window.setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }, 0)
  }, [ask.pending, ask.sendError, ask.turns.length, view])

  useEffect(() => {
    if (view !== 'ask') return
    window.setTimeout(() => askHeadingRef.current?.focus(), 0)
  }, [view])

  useEffect(() => {
    if (view !== 'ask' || ask.conversation?.can_ask !== true || ask.conversationLoading) return
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }, [ask.conversation?.can_ask, ask.conversationLoading, view])

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void ask.submitQuestion(ask.composer)
    }
  }

  const requestConfirmation = (action: ConfirmAction, trigger: HTMLButtonElement) => {
    confirmReturnFocusRef.current = trigger
    ask.setConfirmAction(action)
  }

  const backToRecap = () => {
    setView('recap')
    window.setTimeout(() => askButtonRef.current?.focus(), 0)
  }

  const confirmation = (() => {
    switch (ask.confirmAction) {
      case 'clear-history':
        return {
          title: 'Clear this conversation?',
          body: 'Every Ask Previously answer for this profile and show will be permanently removed.',
          action: 'Clear history',
        }
      case 'clear-hidden':
        return {
          title: 'Clear hidden answers?',
          body: 'Only answers beyond your current spoiler guard will be permanently removed.',
          action: 'Clear hidden answers',
        }
      case 'restore-progress':
        return {
          title: `Restore progress to ${boundaryLabel(ask.conversation?.highest_hidden_up_to)}?`,
          body: 'Aurora will mark that episode watched so the hidden answers become spoiler-safe again.',
          action: 'Restore progress',
        }
      default:
        return { title: '', body: '', action: '' }
    }
  })()

  const canAsk = !loading && !error && !!recap && !unavailableReason
  const canOpenAsk = canAsk || hasAskHistory

  return (
    <>
      <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <DialogContent
          showCloseButton={false}
          overlayClassName="z-[80]"
          // A sheet on the right edge rather than a centred box: the title
          // page stays in view beside it, and on a phone it fills the screen.
          className="recap-sheet z-[81] !flex flex-col gap-0 overflow-hidden rounded-sheet border-0 p-0"
          // Escape closes the sheet and only the sheet: the app's own Escape
          // handler, on window, would otherwise also leave the title page.
          onEscapeKeyDown={event => event.stopPropagation()}
          aria-label={view === 'ask' ? `Ask Previously about ${title}` : `Previously, on ${title}`}
        >
          {view === 'recap' ? (
            <>
              <header className="flex items-start gap-3 pl-6 pr-3 pt-5 sm:pl-7">
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  {/* The aurora dot is the app's mark for "Aurora wrote this". */}
                  <p className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
                    <i aria-hidden="true" className="w-2 h-2 rounded-full [background:var(--aurora)]" /> Written by Aurora
                  </p>
                  <DialogTitle className="font-display text-[26px] sm:text-[28px] font-bold leading-[1.15] tracking-[-0.015em]">
                    Previously, on {title}
                  </DialogTitle>
                  <DialogDescription className="text-[13px] text-ink-2">
                    {upTo
                      ? `Covers what this profile has finished: up to ${boundaryLabel(upTo)}. Nothing past that.`
                      : 'A spoiler-safe recap of the episodes this profile has finished.'}
                  </DialogDescription>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="w-11 h-11 grid place-items-center rounded-control text-ink-2 hover:text-ink hover:bg-action-soft transition-colors flex-none"
                >
                  <X aria-hidden="true" size={20} />
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-7">
                {loading && (
                  <div className="space-y-3 animate-pulse" aria-label="Generating recap">
                    <div className="h-4 w-[92%] rounded bg-action-soft" />
                    <div className="h-4 w-[97%] rounded bg-action-soft" />
                    <div className="h-4 w-[85%] rounded bg-action-soft" />
                    <div className="h-4 w-[60%] rounded bg-action-soft" />
                    <p className="pt-1 text-[13px] text-ink-2">Catching you up…</p>
                  </div>
                )}
                {!loading && error && (
                  <div className="py-7 text-center">
                    <p className="font-semibold text-danger-ink">Couldn’t build the recap</p>
                    <p className="mt-1 text-[14px] text-ink-2">{error}</p>
                  </div>
                )}
                {!loading && !error && unavailableReason && (
                  <div className="py-7 text-center">
                    <p className="font-semibold text-ink">{recapReasonCopy(unavailableReason).head}</p>
                    <p className="mx-auto mt-1.5 max-w-sm text-[14px] text-ink-2">{recapReasonCopy(unavailableReason).body}</p>
                  </div>
                )}
                {!loading && !error && recap && (
                  <p className="text-[16px] leading-[1.6] text-ink whitespace-pre-line">
                    {shown}
                    {shown.length < recap.length && <span className="ml-0.5 inline-block w-2 animate-pulse bg-ink">&nbsp;</span>}
                  </p>
                )}
              </div>

              <footer className="flex flex-col gap-3 border-t border-line-strong px-6 py-4 sm:px-7">
                <div className="flex flex-wrap items-center justify-end gap-2.5">
                  {canOpenAsk && (
                    <button ref={askButtonRef} type="button" onClick={() => setView('ask')} className="stage-btn stage-btn-ghost">
                      <MessageCircleQuestion aria-hidden="true" size={17} /> {canAsk ? 'Ask Previously' : 'Ask history'}
                    </button>
                  )}
                  {onStart && (
                    <button type="button" onClick={onStart} className="stage-btn stage-btn-primary">
                      <Play aria-hidden="true" fill="currentColor" strokeWidth={0} size={16} /> {resumeLabel || 'Resume'}
                    </button>
                  )}
                </div>
                <p className="text-[12px] text-ink-3">Based on what you’ve watched. It never reveals anything past your spot.</p>
              </footer>
            </>
          ) : (
            <AskPreviouslyPanel
              actionBusy={ask.actionBusy}
              actionMessage={ask.actionMessage}
              composer={ask.composer}
              composerRef={composerRef}
              conversation={ask.conversation}
              conversationError={ask.conversationError}
              conversationLoading={ask.conversationLoading}
              currentUpTo={ask.currentUpTo}
              headingRef={askHeadingRef}
              onBack={backToRecap}
              onClose={onClose}
              onComposerChange={ask.setComposer}
              onComposerKeyDown={handleComposerKeyDown}
              onConfirm={requestConfirmation}
              onLoadConversation={ask.loadConversation}
              onStart={onStart}
              onSubmit={ask.submitQuestion}
              pending={ask.pending}
              pendingDraft={ask.pendingDraft}
              resumeLabel={resumeLabel}
              scrollRef={scrollRef}
              sendError={ask.sendError}
              suggestedQuestions={suggestedQuestions}
              title={title}
              turns={ask.turns}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!ask.confirmAction} onOpenChange={open => { if (!open && !ask.actionBusy) ask.setConfirmAction(undefined) }}>
        <AlertDialogContent
          overlayClassName="z-[90]"
          className="z-[91]"
          onEscapeKeyDown={event => event.stopPropagation()}
          onCloseAutoFocus={event => {
            event.preventDefault()
            confirmReturnFocusRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-ink-2">{confirmation.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ask.actionBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={ask.actionBusy}
              onClick={() => void ask.runConfirmedAction()}
              // Restoring progress is the constructive choice; the other two
              // delete answers for good.
              className={ask.confirmAction === 'restore-progress' ? 'bg-action text-action-on hover:brightness-95' : 'bg-danger text-white hover:brightness-110'}
            >
              {ask.actionBusy ? 'Working…' : confirmation.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
