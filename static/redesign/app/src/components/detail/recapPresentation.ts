import type { RecapUpTo } from '@/lib/api'

export function recapReasonCopy(reason: string): { head: string; body: string } {
  switch (reason) {
    case 'no_history':
      return {
        head: 'Nothing to recap yet',
        body: 'Finish an episode and Aurora will catch you up next time — spoiler-free.',
      }
    case 'insufficient_overviews':
      return {
        head: 'Not enough to go on',
        body: 'This series is missing episode synopses, so there’s nothing safe to summarize yet.',
      }
    case 'ai_unavailable':
      return {
        head: 'Previously is off',
        body: 'AI isn’t configured on this server, so recaps and new questions aren’t available.',
      }
    default:
      return { head: 'Previously is unavailable', body: 'There’s nothing to show for this title right now.' }
  }
}

export function boundaryLabel(upTo?: RecapUpTo): string {
  return upTo ? `S${upTo.season} · E${upTo.episode}` : ''
}

export function limitCharacters(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('')
}
