import type { KeyboardEventHandler, RefObject } from 'react'
import {
  ArrowLeft,
  CircleHelp,
  LoaderCircle,
  Play,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { RecapConversationResponse, RecapConversationTurn, RecapUpTo } from '@/lib/api'
import { compareBoundaries, type ConfirmAction } from '@/components/detail/useAskPreviously'
import { boundaryLabel, limitCharacters, recapReasonCopy } from '@/components/detail/recapPresentation'

interface Props {
  actionBusy: boolean
  actionMessage?: string
  composer: string
  composerRef: RefObject<HTMLTextAreaElement | null>
  conversation?: RecapConversationResponse
  conversationError?: string
  conversationLoading: boolean
  currentUpTo?: RecapUpTo
  headingRef: RefObject<HTMLHeadingElement | null>
  onBack: () => void
  onComposerChange: (value: string) => void
  onComposerKeyDown: KeyboardEventHandler<HTMLTextAreaElement>
  onConfirm: (action: ConfirmAction, trigger: HTMLButtonElement) => void
  onLoadConversation: (beforeTurnId?: number) => Promise<RecapConversationResponse | undefined>
  onStart?: () => void
  onSubmit: (question: string, retryDraft?: { requestId: string; question: string }) => Promise<void>
  pending: boolean
  pendingDraft?: { requestId: string; question: string }
  resumeLabel?: string
  scrollRef: RefObject<HTMLDivElement | null>
  sendError?: string
  suggestedQuestions: string[]
  title: string
  turns: RecapConversationTurn[]
}

export function AskPreviouslyPanel({
  actionBusy,
  actionMessage,
  composer,
  composerRef,
  conversation,
  conversationError,
  conversationLoading,
  currentUpTo,
  headingRef,
  onBack,
  onComposerChange,
  onComposerKeyDown,
  onConfirm,
  onLoadConversation,
  onStart,
  onSubmit,
  pending,
  pendingDraft,
  resumeLabel,
  scrollRef,
  sendError,
  suggestedQuestions,
  title,
  turns,
}: Props) {
  return (
    <>
      <header className="border-b border-white/10 px-6 pb-6 pt-6 sm:px-11 sm:pt-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-purple-300">
              <Sparkles aria-hidden="true" size={14} /> Previously
            </div>
            <DialogTitle ref={headingRef} tabIndex={-1} className="mt-2 rounded-md font-display text-[1.65rem] font-bold leading-tight outline-none focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#15131f] sm:text-[2rem]">
              Ask about what you’ve watched
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-[15px] text-white/[0.68] sm:text-[18px]">
              Get a quick answer without learning what happens next.
            </DialogDescription>
          </div>
          {(turns.length > 0 || (conversation?.hidden_turn_count || 0) > 0) && (
            <button type="button" disabled={pending || conversationLoading || actionBusy} onClick={event => onConfirm('clear-history', event.currentTarget)} className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-white/50 transition-colors hover:bg-white/[0.06] hover:text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 disabled:cursor-not-allowed disabled:opacity-40">
              <Trash2 aria-hidden="true" size={13} /> Clear history
            </button>
          )}
        </div>
        {currentUpTo && (
          <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/35 bg-emerald-500/10 px-3.5 py-2 text-sm font-semibold text-emerald-200">
            <ShieldCheck aria-hidden="true" size={14} /> Spoiler guard · through {boundaryLabel(currentUpTo)}
          </div>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:max-h-[460px] sm:px-11">
        {actionMessage && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl border border-purple-300/20 bg-purple-400/[0.07] p-3 text-sm text-purple-100" role="status" aria-live="polite">
            <LoaderCircle aria-hidden="true" className="animate-spin" size={15} /> {actionMessage}
          </div>
        )}
        {conversationLoading && turns.length === 0 && (
          <div className="flex min-h-[220px] items-center justify-center gap-2 text-sm text-white/50" role="status">
            <LoaderCircle aria-hidden="true" className="animate-spin" size={18} /> Loading your conversation…
          </div>
        )}
        {!conversationLoading && conversationError && turns.length === 0 && (
          <div className="flex min-h-[220px] flex-col items-center justify-center text-center">
            <p className="font-medium text-red-200">Couldn’t load Ask Previously</p>
            <p className="mt-1 max-w-sm text-sm text-white/50">{conversationError}</p>
            <button type="button" onClick={() => void onLoadConversation()} className="mt-4 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm text-white/80 hover:bg-white/[0.1]">Try again</button>
          </div>
        )}
        {!conversationLoading && conversation && !conversation.available && (
          <div className="flex min-h-[220px] flex-col items-center justify-center text-center">
            <p className="font-medium text-white/90">{recapReasonCopy(conversation.reason || '').head}</p>
            <p className="mt-1 max-w-sm text-sm text-white/50">{recapReasonCopy(conversation.reason || '').body}</p>
          </div>
        )}

        {conversation?.available && (
          <>
            {!conversation.can_ask && conversation.reason && (
              <div className="mb-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="text-sm font-semibold text-white/85">{recapReasonCopy(conversation.reason).head}</p>
                <p className="mt-1 text-xs leading-relaxed text-white/50">Your saved history is still available to review or clear.</p>
              </div>
            )}
            {conversationError && turns.length > 0 && (
              <div className="mb-5 rounded-2xl border border-red-300/20 bg-red-300/[0.06] p-3 text-sm text-red-100" role="alert">{conversationError}</div>
            )}
            {conversation.next_before_turn_id && (
              <div className="mb-5 text-center">
                <button type="button" disabled={conversationLoading} onClick={() => void onLoadConversation(conversation.next_before_turn_id)} className="rounded-full px-4 py-2 text-xs font-medium text-purple-200 hover:bg-purple-500/10 disabled:opacity-50">
                  {conversationLoading ? 'Loading…' : 'Load earlier questions'}
                </button>
              </div>
            )}

            {conversation.hidden_turn_count > 0 && (
              <div className="mb-5 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] p-4">
                <p className="text-sm font-semibold text-amber-100">
                  {conversation.hidden_turn_count} later {conversation.hidden_turn_count === 1 ? 'answer is' : 'answers are'} hidden
                </p>
                <p className="mt-1 text-xs leading-relaxed text-white/55">Your spoiler guard moved back. Those answers stay out of sight until they’re safe again.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {conversation.highest_hidden_up_to?.episode_id && (
                    <button type="button" disabled={actionBusy || pending} onClick={event => onConfirm('restore-progress', event.currentTarget)} className="inline-flex items-center gap-1.5 rounded-full border border-amber-200/25 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-200/10 disabled:cursor-not-allowed disabled:opacity-40">
                      <RotateCcw aria-hidden="true" size={13} /> Restore to {boundaryLabel(conversation.highest_hidden_up_to)}
                    </button>
                  )}
                  <button type="button" disabled={actionBusy || pending} onClick={event => onConfirm('clear-hidden', event.currentTarget)} className="rounded-full px-3 py-1.5 text-xs font-medium text-white/55 hover:bg-white/[0.06] hover:text-white/80 disabled:cursor-not-allowed disabled:opacity-40">Clear hidden answers</button>
                </div>
              </div>
            )}

            {conversation.can_ask && turns.length === 0 && !pendingDraft && !conversationLoading && (
              <div className="pb-2 pt-1">
                <p className="text-sm leading-relaxed text-white/60">Ask about a character, relationship, mystery, or anything you’ve already seen in {title}.</p>
                {suggestedQuestions.length > 0 && (
                  <div className="mt-6">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-purple-200/75">You might also ask</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {suggestedQuestions.slice(0, 3).map(question => (
                        <button key={question} type="button" onClick={() => void onSubmit(question)} className="inline-flex items-center gap-2 rounded-full border border-purple-400/35 bg-purple-500/[0.04] px-3.5 py-2.5 text-left text-sm text-white/85 transition-colors hover:border-purple-300/60 hover:bg-purple-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300">
                          <Search aria-hidden="true" size={15} className="text-purple-300" /> {question}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div role="list" aria-label="Ask Previously conversation">
              {turns.map((turn, index) => {
                const previous = turns[index - 1]
                const boundaryChange = previous ? compareBoundaries(turn.up_to, previous.up_to) : 0
                return (
                  <div key={turn.id} role="listitem">
                    {boundaryChange !== 0 && (
                      <div className="my-5 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-200/60">
                        <span className="h-px flex-1 bg-white/10" /> Spoiler guard {boundaryChange > 0 ? 'advanced' : 'moved back'} to {boundaryLabel(turn.up_to)} <span className="h-px flex-1 bg-white/10" />
                      </div>
                    )}
                    <div className="border-b border-white/10 py-5 first:pt-0">
                      <div className="flex gap-4">
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-purple-500/30 text-purple-100"><CircleHelp aria-hidden="true" size={20} /></span>
                        <p className="pt-1.5 text-[16px] font-semibold text-white/95">{turn.question}</p>
                      </div>
                      <div className="mt-4 flex gap-4">
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-purple-500/15 text-purple-300"><Sparkles aria-hidden="true" size={19} /></span>
                        <p className="pt-1 text-[15.5px] leading-[1.65] text-white/[0.82]">{turn.answer}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {pendingDraft && (
              <div className="border-b border-white/10 py-5" aria-live="polite">
                <div className="flex gap-4">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-purple-500/30 text-purple-100"><CircleHelp aria-hidden="true" size={20} /></span>
                  <p className="pt-1.5 text-[16px] font-semibold text-white/95">{pendingDraft.question}</p>
                </div>
                <div className="mt-4 flex gap-4">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-purple-500/15 text-purple-300"><Sparkles aria-hidden="true" size={19} /></span>
                  {pending ? (
                    <p className="flex items-center gap-2 pt-1.5 text-sm text-white/50"><LoaderCircle aria-hidden="true" className="animate-spin" size={15} /> Thinking spoiler-safely…</p>
                  ) : sendError ? (
                    <div>
                      <p className="pt-0.5 text-sm text-red-200/85">{sendError}</p>
                      <button type="button" onClick={() => void onSubmit(pendingDraft.question, pendingDraft)} className="mt-2 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/75 hover:bg-white/[0.06]">Retry</button>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {conversation?.available === true && conversation.can_ask && (
        <div className="border-t border-white/10 px-6 pb-4 pt-4 sm:px-11">
          <div className="flex items-end gap-2 rounded-full border border-white/15 bg-black/20 py-2 pl-5 pr-2 focus-within:border-purple-400/55 focus-within:ring-2 focus-within:ring-purple-500/15">
            <textarea
              ref={composerRef}
              value={composer}
              onChange={event => onComposerChange(limitCharacters(event.target.value, 500))}
              onKeyDown={onComposerKeyDown}
              rows={1}
              disabled={pending || conversationLoading || actionBusy}
              aria-label="Ask about what you’ve watched"
              placeholder="Ask about what you’ve watched…"
              className="max-h-28 min-h-11 flex-1 resize-none bg-transparent py-2.5 text-[15px] text-white outline-none placeholder:text-white/50 disabled:opacity-50"
            />
            <button type="button" onClick={() => void onSubmit(composer)} disabled={pending || conversationLoading || actionBusy || !composer.trim()} aria-label="Send question" className="flex size-[52px] shrink-0 items-center justify-center rounded-full bg-purple-600 text-white shadow-[0_0_18px_rgba(168,85,247,0.42)] transition-colors hover:bg-purple-500 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/25 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-200">
              {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={18} /> : <Send aria-hidden="true" size={18} />}
            </button>
          </div>
          <p className="mt-2.5 px-2 text-xs text-white/50">Answers stop at your latest completed episode.</p>
        </div>
      )}

      <footer className="flex flex-col-reverse gap-3 border-t border-white/10 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-11">
        <button type="button" onClick={onBack} className="inline-flex items-center justify-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.06] px-5 py-3 text-sm font-semibold text-white/85 transition-colors hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300">
          <ArrowLeft aria-hidden="true" size={16} /> Back to recap
        </button>
        {onStart && (
          <button type="button" onClick={onStart} className="inline-flex items-center justify-center gap-2 rounded-full bg-purple-600 px-6 py-3 text-sm font-semibold shadow-[0_0_20px_rgba(168,85,247,0.45)] transition-colors hover:bg-purple-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-200">
            <Play aria-hidden="true" fill="currentColor" size={15} /> {resumeLabel || 'Resume'}
          </button>
        )}
      </footer>
      <p className="sr-only" aria-live="polite">{pending ? 'Generating an answer' : sendError ? `Answer failed: ${sendError}` : turns.length ? 'Answer added' : ''}</p>
    </>
  )
}
