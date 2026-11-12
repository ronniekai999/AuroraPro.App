import type { KeyboardEventHandler, RefObject } from 'react'
import {
  ArrowLeft,
  LoaderCircle,
  Play,
  RotateCcw,
  Send,
  Trash2,
  X,
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
  onClose: () => void
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
  onClose,
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
      <header className="flex items-start gap-3 pl-6 pr-3 pt-5 sm:pl-7">
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
            <i aria-hidden="true" className="w-2 h-2 rounded-full [background:var(--aurora)]" /> Answered by Aurora
          </p>
          <DialogTitle ref={headingRef} tabIndex={-1} className="rounded-chip font-display text-[24px] sm:text-[26px] font-bold leading-[1.15] tracking-[-0.015em] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
            Ask about what you’ve watched
          </DialogTitle>
          <DialogDescription className="text-[13px] text-ink-2">
            Get a quick answer without learning what happens next.
          </DialogDescription>
          {currentUpTo && (
            <p className="text-[13px] text-ink-2">
              Spoiler guard · through {boundaryLabel(currentUpTo)}
            </p>
          )}
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-7">
        {actionMessage && (
          <div className="mb-4 flex items-center gap-2 rounded-control bg-surface-raised p-3 text-[14px] text-ink" role="status" aria-live="polite">
            <LoaderCircle aria-hidden="true" className="animate-spin" size={15} /> {actionMessage}
          </div>
        )}
        {conversationLoading && turns.length === 0 && (
          <div className="flex min-h-[220px] items-center justify-center gap-2 text-[14px] text-ink-2" role="status">
            <LoaderCircle aria-hidden="true" className="animate-spin" size={18} /> Loading your conversation…
          </div>
        )}
        {!conversationLoading && conversationError && turns.length === 0 && (
          <div className="flex min-h-[220px] flex-col items-center justify-center text-center">
            <p className="font-semibold text-danger-ink">Couldn’t load Ask Previously</p>
            <p className="mt-1 max-w-sm text-[14px] text-ink-2">{conversationError}</p>
            <button type="button" onClick={() => void onLoadConversation()} className="mt-4 stage-btn stage-btn-sm stage-hit44 stage-btn-ghost">Try again</button>
          </div>
        )}
        {!conversationLoading && conversation && !conversation.available && (
          <div className="flex min-h-[220px] flex-col items-center justify-center text-center">
            <p className="font-semibold text-ink">{recapReasonCopy(conversation.reason || '').head}</p>
            <p className="mt-1 max-w-sm text-[14px] text-ink-2">{recapReasonCopy(conversation.reason || '').body}</p>
          </div>
        )}

        {conversation?.available && (
          <>
            {!conversation.can_ask && conversation.reason && (
              <div className="mb-5 rounded-control bg-surface-raised p-4">
                <p className="text-[14px] font-semibold text-ink">{recapReasonCopy(conversation.reason).head}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">Your saved history is still available to review or clear.</p>
              </div>
            )}
            {conversationError && turns.length > 0 && (
              <div className="mb-5 rounded-control bg-surface-raised p-3 text-[14px] text-danger-ink" role="alert">{conversationError}</div>
            )}
            {conversation.next_before_turn_id && (
              <div className="mb-5 text-center">
                <button type="button" disabled={conversationLoading} onClick={() => void onLoadConversation(conversation.next_before_turn_id)} className="stage-btn stage-btn-sm stage-hit44 stage-btn-quiet">
                  {conversationLoading ? 'Loading…' : 'Load earlier questions'}
                </button>
              </div>
            )}

            {conversation.hidden_turn_count > 0 && (
              <div className="mb-5 rounded-control bg-surface-raised p-4">
                <p className="text-[14px] font-semibold text-warn">
                  {conversation.hidden_turn_count} later {conversation.hidden_turn_count === 1 ? 'answer is' : 'answers are'} hidden
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">Your spoiler guard moved back. Those answers stay out of sight until they’re safe again.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {conversation.highest_hidden_up_to?.episode_id && (
                    <button type="button" disabled={actionBusy || pending} onClick={event => onConfirm('restore-progress', event.currentTarget)} className="stage-btn stage-btn-sm stage-hit44 stage-btn-ghost">
                      <RotateCcw aria-hidden="true" size={14} /> Restore to {boundaryLabel(conversation.highest_hidden_up_to)}
                    </button>
                  )}
                  <button type="button" disabled={actionBusy || pending} onClick={event => onConfirm('clear-hidden', event.currentTarget)} className="stage-btn stage-btn-sm stage-hit44 stage-btn-quiet">Clear hidden answers</button>
                </div>
              </div>
            )}

            {conversation.can_ask && turns.length === 0 && !pendingDraft && !conversationLoading && (
              <div className="pb-2 pt-1">
                <p className="text-[15px] leading-relaxed text-ink-2">Ask about a character, relationship, mystery, or anything you’ve already seen in {title}.</p>
                {suggestedQuestions.length > 0 && (
                  <div className="mt-5">
                    <p className="text-[12px] text-ink-3">You might also ask</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {suggestedQuestions.slice(0, 3).map(question => (
                        <button key={question} type="button" onClick={() => void onSubmit(question)} className="stage-hit44 min-h-9 px-3.5 py-2 rounded-full bg-surface-raised text-left text-[13px] text-ink hover:bg-white/[0.12] transition-colors">
                          {question}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* A question is the viewer's own bubble, on the right; an answer
                is Aurora's, on the left. */}
            <div role="list" aria-label="Ask Previously conversation" className="flex flex-col gap-3.5">
              {turns.map((turn, index) => {
                const previous = turns[index - 1]
                const boundaryChange = previous ? compareBoundaries(turn.up_to, previous.up_to) : 0
                return (
                  <div key={turn.id} role="listitem" className="flex flex-col gap-3.5">
                    {boundaryChange !== 0 && (
                      <div className="my-1 flex items-center gap-3 text-[12px] font-semibold text-ink-3">
                        <span className="h-px flex-1 bg-line-strong" /> Spoiler guard {boundaryChange > 0 ? 'advanced' : 'moved back'} to {boundaryLabel(turn.up_to)} <span className="h-px flex-1 bg-line-strong" />
                      </div>
                    )}
                    <p className="self-end max-w-[80%] px-3.5 py-2.5 rounded-control bg-ink text-action-on text-[15px]">
                      <span className="sr-only">You asked: </span>{turn.question}
                    </p>
                    <p className="self-start max-w-[88%] px-3.5 py-2.5 rounded-control bg-surface-raised text-ink text-[15px] leading-normal">
                      <span className="sr-only">Aurora answered: </span>{turn.answer}
                    </p>
                  </div>
                )
              })}
            </div>

            {pendingDraft && (
              <div className="mt-3.5 flex flex-col gap-3.5" aria-live="polite">
                <p className="self-end max-w-[80%] px-3.5 py-2.5 rounded-control bg-ink text-action-on text-[15px]">{pendingDraft.question}</p>
                {pending ? (
                  <p className="self-start flex items-center gap-2 px-3.5 py-2.5 rounded-control bg-surface-raised text-[14px] text-ink-2"><LoaderCircle aria-hidden="true" className="animate-spin" size={15} /> Thinking spoiler-safely…</p>
                ) : sendError ? (
                  <div className="self-start max-w-[88%] px-3.5 py-2.5 rounded-control bg-surface-raised">
                    <p className="text-[14px] text-danger-ink">{sendError}</p>
                    <button type="button" onClick={() => void onSubmit(pendingDraft.question, pendingDraft)} className="mt-2 stage-btn stage-btn-sm stage-hit44 stage-btn-ghost">Retry</button>
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {conversation?.available === true && conversation.can_ask && (
        <div className="px-6 pt-3 sm:px-7">
          <div className="flex items-end gap-2">
            <textarea
              ref={composerRef}
              value={composer}
              onChange={event => onComposerChange(limitCharacters(event.target.value, 500))}
              onKeyDown={onComposerKeyDown}
              rows={1}
              disabled={pending || conversationLoading || actionBusy}
              aria-label="Ask about what you’ve watched"
              placeholder="Ask about what you’ve watched"
              className="max-h-28 min-h-12 flex-1 min-w-0 resize-none rounded-control border border-line-strong bg-surface-page px-3.5 py-3 text-[15px] text-ink outline-none placeholder:text-ink-3 focus-visible:border-ink disabled:opacity-50"
            />
            <button type="button" onClick={() => void onSubmit(composer)} disabled={pending || conversationLoading || actionBusy || !composer.trim()} aria-label="Send question" className="flex size-12 shrink-0 items-center justify-center rounded-control bg-action text-action-on transition-[filter] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40">
              {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" size={18} /> : <Send aria-hidden="true" size={18} />}
            </button>
          </div>
        </div>
      )}

      <footer className="flex flex-col gap-3 px-6 pb-5 pt-3 sm:px-7">
        <div className="flex items-center gap-3 text-[12px] text-ink-3">
          <span className="flex-1">Answers stop at your latest completed episode.</span>
          {(turns.length > 0 || (conversation?.hidden_turn_count || 0) > 0) && (
            <button type="button" disabled={pending || conversationLoading || actionBusy} onClick={event => onConfirm('clear-history', event.currentTarget)} className="stage-hit44 inline-flex items-center gap-1.5 min-h-9 px-2 rounded-control text-[12px] font-semibold text-ink-2 hover:text-ink hover:bg-action-soft transition-colors disabled:cursor-not-allowed disabled:opacity-40">
              <Trash2 aria-hidden="true" size={13} /> Clear history
            </button>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" onClick={onBack} className="stage-btn stage-btn-ghost">
            <ArrowLeft aria-hidden="true" size={16} /> Back to recap
          </button>
          {onStart && (
            <button type="button" onClick={onStart} className="stage-btn stage-btn-primary">
              <Play aria-hidden="true" fill="currentColor" strokeWidth={0} size={16} /> {resumeLabel || 'Resume'}
            </button>
          )}
        </div>
      </footer>
      <p className="sr-only" aria-live="polite">{pending ? 'Generating an answer' : sendError ? `Answer failed: ${sendError}` : turns.length ? 'Answer added' : ''}</p>
    </>
  )
}
