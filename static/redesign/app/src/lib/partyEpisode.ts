// Which episode a show starts on, and so which one its watch party opens on.
//
// A party created for a show with no episode has episode_id=null, and a
// guest who joins it once it is playing cannot open the right episode: they
// get an empty /api/media/{id}/files answer and bail silently. So every
// place that starts a party for a show makes this choice, and makes the same
// one: the title page's Party action and a card's "Watch together".
//
// "Where a show starts" has one definition, used by all of them and by Play
// and its prewarm: the viewer's resume episode when there is one, else the
// earliest episode with a file, looking through the regular seasons in
// order and the Specials (season 0) last. The title page opens on the same
// season (App makes the same walk, keeping the episodes it reads), so what
// it lists, what its Play starts and what its party opens on are one
// season, also when the first regular season has nothing to play.
import { getEpisodes, getSeasons, type Episode } from '@/lib/api'

interface ResumeLike { type?: string; episode_id?: number | null }
interface SeasonLike { season_number: number }

/** A show's seasons in the order to look for its first episode: season 1
 *  upward, and season 0 last. Season 0 is Specials (shorts, recaps, a
 *  behind-the-scenes hour): the lowest number, and not where a show starts.
 *  It is still tried when no regular season has anything to play. */
export function regularSeasonsFirst<T extends SeasonLike>(seasons: T[]): T[] {
  const byNumber = [...seasons].sort((a, b) => a.season_number - b.season_number)
  return [...byNumber.filter(s => s.season_number > 0), ...byNumber.filter(s => s.season_number <= 0)]
}
interface EpisodeLike { id: number; files?: unknown[] | null }

/** The viewer's resume episode, else the first of `episodes` that has a
 *  file. Undefined for a movie, and for a show with neither. */
export function partyEpisodeId(
  media: { type?: string },
  resume: ResumeLike | null | undefined,
  episodes: EpisodeLike[] | null | undefined,
): number | undefined {
  if (media.type !== 'show') return undefined
  if (resume?.type === 'show' && resume.episode_id) return resume.episode_id
  return episodes?.find(e => e.files && e.files.length > 0)?.id
}

/** An episode that was passed over on the way to the one a show starts on:
 *  it comes earlier and has no file. */
export interface SkippedEpisode { seasonNumber: number; episodeNumber: number }

/** The episode an unstarted show begins on: the earliest with a file, the
 *  regular seasons in order and Specials last, with the earlier episodes
 *  that were passed over for having none (`skipped`, so the viewer can be
 *  told the show is not starting at its beginning). Null when nothing can be
 *  played. `seasons` saves the request when the caller has the list. Rejects
 *  when the episodes cannot be read, and with the abort when `signal` fires. */
export async function firstEpisodeToPlay(
  mediaId: number,
  signal?: AbortSignal,
  seasons?: SeasonLike[],
): Promise<{ seasonNumber: number; episode: Episode; skipped: SkippedEpisode[] } | null> {
  const skipped: SkippedEpisode[] = []
  for (const season of regularSeasonsFirst(seasons ?? await getSeasons(mediaId, signal))) {
    const episodes = [...await getEpisodes(mediaId, season.season_number, signal)]
      .sort((a, b) => a.episode_number - b.episode_number)
    for (const episode of episodes) {
      if (episode.files && episode.files.length > 0) return { seasonNumber: season.season_number, episode, skipped }
      skipped.push({ seasonNumber: season.season_number, episodeNumber: episode.episode_number })
    }
  }
  return null
}

/** What to tell a viewer whose show is not starting at its first episode,
 *  or '' when it is. Season 0 is named as what it is. */
export function startsLaterNotice(title: string, start: { seasonNumber: number; episode: { episode_number: number }; skipped: SkippedEpisode[] }): string {
  const { skipped } = start
  if (skipped.length === 0) return ''
  const at = start.episode.episode_number
  if (skipped.length === 1 && skipped[0].seasonNumber === start.seasonNumber) {
    return `Episode ${skipped[0].episodeNumber} of "${title}" is not available. Starting at episode ${at}.`
  }
  const where = start.seasonNumber <= 0 ? `the Specials, episode ${at}` : `season ${start.seasonNumber}, episode ${at}`
  return `Earlier episodes of "${title}" are not available. Starting at ${where}.`
}

/** The party's episode for a caller with no episode list at hand (a card's
 *  menu, which opens over a rail): the resume record's episode, else where
 *  the show starts (firstEpisodeToPlay). The title page makes the same
 *  choice from the season it is showing, which App opens on the season the
 *  show starts in; when the viewer has moved the page to a season with
 *  nothing to play, App sends the page's party through this too, so a party
 *  is never created with no episode while the show has one.
 *  Rejects when the show's episodes cannot be read, so the caller can say so
 *  instead of starting a party nobody can join. */
export async function resolvePartyEpisodeId(
  media: { id: number; type?: string },
  resume: ResumeLike | null | undefined,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const known = partyEpisodeId(media, resume, null)
  if (known !== undefined || media.type !== 'show') return known
  return (await firstEpisodeToPlay(media.id, signal))?.episode.id
}
