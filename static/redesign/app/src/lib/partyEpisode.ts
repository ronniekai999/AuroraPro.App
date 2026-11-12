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
// season (App picks it with regularSeasonsFirst), so what it lists, what its
// Play starts and what its party opens on are one season.
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

/** The episode an unstarted show begins on: the earliest with a file, the
 *  regular seasons in order and Specials last. Null when nothing can be
 *  played. `seasons` saves the request when the caller has the list. Rejects
 *  when the episodes cannot be read, and with the abort when `signal` fires. */
export async function firstEpisodeToPlay(
  mediaId: number,
  signal?: AbortSignal,
  seasons?: SeasonLike[],
): Promise<{ seasonNumber: number; episode: Episode } | null> {
  for (const season of regularSeasonsFirst(seasons ?? await getSeasons(mediaId, signal))) {
    const episodes = [...await getEpisodes(mediaId, season.season_number, signal)]
      .sort((a, b) => a.episode_number - b.episode_number)
    const episode = episodes.find(e => e.files && e.files.length > 0)
    if (episode) return { seasonNumber: season.season_number, episode }
  }
  return null
}

/** The party's episode for a caller with no episode list at hand (a card's
 *  menu, which opens over a rail): the resume record's episode, else where
 *  the show starts (firstEpisodeToPlay). The title page makes the same
 *  choice from the season it is showing, which App opens on the first
 *  regular season; the two differ only when that season has nothing to
 *  play, where the page has no episode to offer and this looks further.
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
