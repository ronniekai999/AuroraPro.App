// Aurora V2 — "Previously" recap + spoiler-safe conversational Q&A.

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MessageCircleQuestion, Play, ShieldCheck, Sparkles } from 'lucide-react'
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
          overlayClassName="z-[80] bg-black/85 backdrop-blur-md"
          className="z-[81] !flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[760px] flex-col gap-0 overflow-hidden rounded-[28px] border border-purple-400/30 bg-[#15131f] p-0 text-white shadow-[0_28px_90px_rgba(0,0,0,0.65)]"
          aria-label={view === 'ask' ? `Ask Previously about ${title}` : `Previously, on ${title}`}
        >
          {view === 'recap' ? (
            <>
              <header className="border-b border-white/10 px-6 pb-4 pt-6 sm:px-7">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-purple-300">
                  <Sparkles aria-hidden="true" size={14} /> Previously
                </div>
                <DialogTitle className="mt-1.5 font-display text-2xl font-bold leading-tight sm:text-[1.7rem]">
                  Previously, on <span className="text-purple-200">{title}</span>
                </DialogTitle>
                <DialogDescription className="sr-only">A spoiler-safe recap based on episodes completed by this profile.</DialogDescription>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="badge-glass inline-flex items-center gap-1.5 border border-emerald-400/30 bg-emerald-500/10 text-emerald-200">
                    <ShieldCheck aria-hidden="true" size={13} /> Spoiler-safe
                  </span>
                  {upTo && <span className="badge-glass border border-white/10 bg-white/5 text-white/60">Caught up to {boundaryLabel(upTo)}</span>}
                  <span className="badge-glass inline-flex items-center gap-1.5 border border-purple-500/25 bg-purple-500/10 text-purple-200">
                    <Sparkles aria-hidden="true" size={13} /> Aurora AI
                  </span>
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-7">
                {loading && (
                  <div className="space-y-3 animate-pulse" aria-label="Generating recap">
                    <div className="h-4 w-[92%] rounded bg-white/10" />
                    <div className="h-4 w-[97%] rounded bg-white/10" />
                    <div className="h-4 w-[85%] rounded bg-white/10" />
                    <div className="h-4 w-[60%] rounded bg-white/10" />
                    <p className="pt-1 text-xs text-white/40">Catching you up…</p>
                  </div>
                )}
                {!loading && error && (
                  <div className="py-7 text-center">
                    <p className="font-medium text-red-300/90">Couldn’t build the recap</p>
                    <p className="mt-1 text-sm text-white/50">{error}</p>
                  </div>
                )}
                {!loading && !error && unavailableReason && (
                  <div className="py-7 text-center">
                    <p className="font-medium text-white/90">{recapReasonCopy(unavailableReason).head}</p>
                    <p className="mx-auto mt-1.5 max-w-sm text-sm text-white/55">{recapReasonCopy(unavailableReason).body}</p>
                  </div>
                )}
                {!loading && !error && recap && (
                  <p className="text-[16px] leading-[1.7] text-white/90">
                    {shown}
                    {shown.length < recap.length && <span className="ml-0.5 inline-block w-2 animate-pulse bg-purple-400">&nbsp;</span>}
                  </p>
                )}
              </div>

              <footer className="flex flex-col gap-3 border-t border-white/10 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
                <p className="max-w-[290px] text-[11.5px] text-white/40">Based on what you’ve watched — never reveals anything past your spot.</p>
                <div className="flex flex-wrap items-center justify-end gap-2.5">
                  <button type="button" onClick={onClose} className="rounded-full border border-white/[0.08] bg-white/[0.06] px-4 py-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300">Close</button>
                  {canOpenAsk && (
                    <button ref={askButtonRef} type="button" onClick={() => setView('ask')} className="inline-flex items-center gap-2 rounded-full border border-purple-400/45 bg-purple-500/10 px-4 py-2 text-sm font-semibold text-purple-100 transition-colors hover:bg-purple-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300">
                      <MessageCircleQuestion aria-hidden="true" size={15} /> {canAsk ? 'Ask Previously' : 'Ask history'}
                    </button>
                  )}
                  {onStart && (
                    <button type="button" onClick={onStart} className="inline-flex items-center gap-2 rounded-full bg-purple-600 px-4 py-2 text-sm font-semibold shadow-[0_0_20px_rgba(168,85,247,0.45)] transition-colors hover:bg-purple-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-200">
                      <Play aria-hidden="true" fill="currentColor" size={15} /> {resumeLabel || 'Resume'}
                    </button>
                  )}
                </div>
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
          overlayClassName="z-[90] bg-black/70 backdrop-blur-sm"
          className="z-[91] border-white/10 bg-[#17141f] text-white shadow-2xl"
          onCloseAutoFocus={event => {
            event.preventDefault()
            confirmReturnFocusRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-white/55">{confirmation.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ask.actionBusy} className="border-white/10 bg-white/[0.04] text-white hover:bg-white/[0.08]">Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={ask.actionBusy} onClick={() => void ask.runConfirmedAction()} className={ask.confirmAction === 'restore-progress' ? 'bg-purple-600 text-white hover:bg-purple-500' : 'bg-red-600 text-white hover:bg-red-500'}>
              {ask.actionBusy ? 'Working…' : confirmation.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
