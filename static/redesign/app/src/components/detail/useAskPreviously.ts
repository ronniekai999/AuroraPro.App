import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  APIError,
  askPreviously,
  clearRecapConversation,
  clearUnsafeRecapTurns,
  getRecapConversation,
  markWatched,
  type RecapConversationResponse,
  type RecapConversationTurn,
  type RecapUpTo,
} from '@/lib/api'

export type ConfirmAction = 'clear-history' | 'clear-hidden' | 'restore-progress'

interface AskPreviouslyOptions {
  active: boolean
  mediaId: number
  profileId?: number
  fallbackBoundary?: RecapUpTo
  onRefreshRecap?: () => Promise<void>
  onHistoryChanged?: (hasHistory: boolean) => void
}

function makeRequestID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function sameBoundary(a?: RecapUpTo, b?: RecapUpTo): boolean {
  return (!a && !b) || (!!a && !!b && a.season === b.season && a.episode === b.episode)
}

export function compareBoundaries(a?: RecapUpTo, b?: RecapUpTo): number {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.season !== b.season) return a.season - b.season
  return a.episode - b.episode
}

function turnIsSafe(turn: RecapConversationTurn, boundary?: RecapUpTo): boolean {
  return !!boundary && compareBoundaries(turn.up_to, boundary) <= 0
}

function mergeTurns(older: RecapConversationTurn[], newer: RecapConversationTurn[]): RecapConversationTurn[] {
  const seen = new Set<number>()
  return [...older, ...newer].filter(turn => {
    if (seen.has(turn.id)) return false
    seen.add(turn.id)
    return true
  })
}

function safeResponse(data: RecapConversationResponse): RecapConversationResponse {
  return {
    ...data,
    turns: data.turns.filter(turn => turnIsSafe(turn, data.current_up_to)),
  }
}

export function useAskPreviously({
  active,
  mediaId,
  profileId,
  fallbackBoundary,
  onRefreshRecap,
  onHistoryChanged,
}: AskPreviouslyOptions) {
  const [conversation, setConversation] = useState<RecapConversationResponse>()
  const [conversationLoading, setConversationLoading] = useState(false)
  const [conversationError, setConversationError] = useState<string>()
  const [composer, setComposer] = useState('')
  const [pending, setPending] = useState(false)
  const [pendingDraft, setPendingDraft] = useState<{ requestId: string; question: string }>()
  const [sendError, setSendError] = useState<string>()
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>()
  const [actionBusy, setActionBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState<string>()

  const identity = `${mediaId}:${profileId ?? 'default'}`
  const identityRef = useRef(identity)
  useLayoutEffect(() => {
    identityRef.current = identity
  }, [identity])
  const conversationRef = useRef(conversation)
  useLayoutEffect(() => {
    conversationRef.current = conversation
  }, [conversation])
  const loadController = useRef<AbortController | undefined>(undefined)
  const sendController = useRef<AbortController | undefined>(undefined)
  const actionController = useRef<AbortController | undefined>(undefined)

  const isCurrent = useCallback((capturedIdentity: string, controller?: AbortController) => (
    identityRef.current === capturedIdentity && !controller?.signal.aborted
  ), [])

  const loadConversation = useCallback(async (beforeTurnId?: number): Promise<RecapConversationResponse | undefined> => {
    const capturedIdentity = identity
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    setConversationLoading(true)
    setConversationError(undefined)
    try {
      let data = safeResponse(await getRecapConversation(mediaId, profileId, beforeTurnId, controller.signal))
      if (!isCurrent(capturedIdentity, controller)) return undefined

      const previous = conversationRef.current
      // A cursor belongs to one spoiler boundary. If progress changed while an
      // earlier page was loading, discard that cursor response and reload the
      // newest page at the new server boundary.
      if (beforeTurnId && previous && !sameBoundary(previous.current_up_to, data.current_up_to)) {
        data = safeResponse(await getRecapConversation(mediaId, profileId, undefined, controller.signal))
        if (!isCurrent(capturedIdentity, controller)) return undefined
        beforeTurnId = undefined
      }

      setConversation(current => {
        if (!beforeTurnId || !current || !sameBoundary(current.current_up_to, data.current_up_to)) return data
        const retained = current.turns.filter(turn => turnIsSafe(turn, data.current_up_to))
        return { ...data, turns: mergeTurns(data.turns, retained) }
      })
      onHistoryChanged?.(data.turns.length > 0 || data.hidden_turn_count > 0)
      return data
    } catch (caught) {
      if (isCurrent(capturedIdentity, controller)) {
        setConversationError(caught instanceof Error ? caught.message : 'Couldn’t load your questions')
      }
      return undefined
    } finally {
      if (isCurrent(capturedIdentity, controller)) setConversationLoading(false)
    }
  }, [identity, isCurrent, mediaId, onHistoryChanged, profileId])

  useEffect(() => {
    loadController.current?.abort()
    sendController.current?.abort()
    actionController.current?.abort()
    loadController.current = undefined
    sendController.current = undefined
    actionController.current = undefined
    setConversation(undefined)
    setConversationLoading(false)
    setConversationError(undefined)
    setComposer('')
    setPending(false)
    setPendingDraft(undefined)
    setSendError(undefined)
    setConfirmAction(undefined)
    setActionBusy(false)
    setActionMessage(undefined)
  }, [identity])

  useEffect(() => () => {
    loadController.current?.abort()
    sendController.current?.abort()
    actionController.current?.abort()
  }, [])

  useEffect(() => {
    if (!active) return
    void loadConversation()
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible' && !sendController.current && !actionController.current) {
        void loadConversation()
      }
    }
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    const timer = window.setInterval(refreshIfVisible, 30_000)
    return () => {
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
      window.clearInterval(timer)
    }
  }, [active, loadConversation])

  const submitQuestion = useCallback(async (rawQuestion: string, retryDraft?: { requestId: string; question: string }) => {
    const question = rawQuestion.trim()
    if (!question || Array.from(question).length > 500 || pending || sendController.current) return
    const capturedIdentity = identity
    const draft = retryDraft || { requestId: makeRequestID(), question }
    const controller = new AbortController()
    sendController.current = controller
    setPendingDraft(draft)
    setPending(true)
    setSendError(undefined)
    setComposer('')
    try {
      const data = await askPreviously(mediaId, draft.requestId, draft.question, profileId, controller.signal)
      if (!isCurrent(capturedIdentity, controller)) return
      const previousBoundary = conversationRef.current?.current_up_to || fallbackBoundary
      setConversation(previous => {
        const retained = (previous?.turns || []).filter(turn => turnIsSafe(turn, data.current_up_to))
        return {
          available: true,
          can_ask: true,
          turns: mergeTurns(retained, [data.turn]),
          current_up_to: data.current_up_to,
          hidden_turn_count: previous?.hidden_turn_count || 0,
          highest_hidden_up_to: previous?.highest_hidden_up_to,
          next_before_turn_id: previous?.next_before_turn_id,
        }
      })
      setPendingDraft(undefined)
      onHistoryChanged?.(true)
      if (!sameBoundary(previousBoundary, data.current_up_to)) {
        await loadConversation()
        if (isCurrent(capturedIdentity, controller)) void onRefreshRecap?.()
      }
    } catch (caught) {
      if (!isCurrent(capturedIdentity, controller)) return
      // A 409 commonly means progress or another identical request moved while
      // the model was running. Reload first so no stale unsafe turn remains.
      if (caught instanceof APIError && caught.status === 409) await loadConversation()
      if (isCurrent(capturedIdentity, controller)) {
        setSendError(caught instanceof Error ? caught.message : 'Couldn’t answer that right now')
      }
    } finally {
      if (isCurrent(capturedIdentity, controller)) {
        setPending(false)
        sendController.current = undefined
      }
    }
  }, [fallbackBoundary, identity, isCurrent, loadConversation, mediaId, onHistoryChanged, onRefreshRecap, pending, profileId])

  const runConfirmedAction = useCallback(async () => {
    if (!confirmAction || actionBusy || actionController.current) return
    const capturedIdentity = identity
    loadController.current?.abort()
    const controller = new AbortController()
    actionController.current = controller
    setActionBusy(true)
    setConversationError(undefined)
    setActionMessage(confirmAction === 'restore-progress' ? 'Restoring your spoiler guard…' : 'Updating conversation…')
    try {
      if (confirmAction === 'clear-history') {
        await clearRecapConversation(mediaId, profileId, controller.signal)
        if (!isCurrent(capturedIdentity, controller)) return
        // The destructive operation already succeeded. Reflect that locally
        // before reconciliation so a failed GET can never leave deleted private
        // history visible as though it still exists.
        setConversation(previous => previous ? {
          ...previous,
          turns: [],
          hidden_turn_count: 0,
          highest_hidden_up_to: undefined,
          next_before_turn_id: undefined,
        } : previous)
        onHistoryChanged?.(false)
        setPendingDraft(undefined)
        setSendError(undefined)
        const data = await loadConversation()
        if (!isCurrent(capturedIdentity, controller)) return
        onHistoryChanged?.(!!data && (data.turns.length > 0 || data.hidden_turn_count > 0))
      } else if (confirmAction === 'clear-hidden') {
        await clearUnsafeRecapTurns(mediaId, profileId, controller.signal)
        if (!isCurrent(capturedIdentity, controller)) return
        const retainedSafeTurns = conversationRef.current?.turns || []
        setConversation(previous => previous ? {
          ...previous,
          hidden_turn_count: 0,
          highest_hidden_up_to: undefined,
        } : previous)
        onHistoryChanged?.(retainedSafeTurns.length > 0)
        await loadConversation()
      } else {
        const restore = conversationRef.current?.highest_hidden_up_to
        if (!restore?.episode_id) throw new Error('That episode is no longer in this library.')
        await markWatched(mediaId, { episode_id: restore.episode_id, profile_id: profileId }, controller.signal)
        if (!isCurrent(capturedIdentity, controller)) return
        await Promise.all([loadConversation(), onRefreshRecap?.()])
      }
    } catch (caught) {
      if (isCurrent(capturedIdentity, controller)) {
        setConversationError(caught instanceof Error ? caught.message : 'That change couldn’t be completed')
      }
    } finally {
      if (isCurrent(capturedIdentity, controller)) {
        setActionBusy(false)
        setActionMessage(undefined)
        setConfirmAction(undefined)
        actionController.current = undefined
      }
    }
  }, [actionBusy, confirmAction, identity, isCurrent, loadConversation, mediaId, onHistoryChanged, onRefreshRecap, profileId])

  return {
    actionBusy,
    actionMessage,
    composer,
    confirmAction,
    conversation,
    conversationError,
    conversationLoading,
    // Once the server conversation has loaded, an absent boundary is
    // meaningful (the profile rewound to zero). Do not resurrect the recap's
    // older fallback guard in that state.
    currentUpTo: conversation ? conversation.current_up_to : fallbackBoundary,
    loadConversation,
    pending,
    pendingDraft,
    runConfirmedAction,
    sendError,
    setComposer,
    setConfirmAction,
    submitQuestion,
    turns: conversation?.turns || [],
  }
}
