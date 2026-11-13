// The last answer to a search by description, kept for the ask it answered.
//
// The search page unmounts when a result is opened, and Back mounts it again
// with the same ask still standing. Asked again, the server makes a model
// call per Back. So the answer is kept, once, under the ask's own key (who
// asked, which ask, which words), and shown again for that ask and no other.
// One entry: this is a way back to a page, not a cache of searches.
import { type Media } from '@/lib/types'

export interface DescribedAnswer {
  items: Media[]
  /** What the server says it ran: 'semantic' when the description search
   *  produced these, 'literal' when it gave title matches instead. */
  mode: 'literal' | 'semantic'
}

let kept: { key: string; answer: DescribedAnswer } | null = null

export function keepDescribedAnswer(key: string, answer: DescribedAnswer): void {
  kept = { key, answer }
}

export function describedAnswerFor(key: string): DescribedAnswer | null {
  return kept && kept.key === key ? kept.answer : null
}

/** On sign-out and on a change of profile: nothing of one session's stays. */
export function forgetDescribedAnswer(): void {
  kept = null
}
