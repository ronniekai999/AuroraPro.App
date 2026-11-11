// Which episode a show's watch party opens on.
//
// A party created for a show with no episode has episode_id=null, and a
// guest who joins it once it is playing cannot open the right episode: they
// get an empty /api/media/{id}/files answer and bail silently. So every
// place that starts a party for a show makes this choice, and makes the same
// one: the title page's Party action and a card's "Watch together".
import { getEpisodes, getSeasons } from '@/lib/api'

interface ResumeLike { type?: string; episode_id?: number | null }
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

/** The same choice for a caller with no episode list at hand (a card's menu,
 *  which opens over a rail): when the resume record names no episode, the
 *  show's seasons are read in order and the first episode with a file is
 *  taken. Rejects when the show's episodes cannot be read, so the caller can
 *  say so instead of starting a party nobody can join. */
export async function resolvePartyEpisodeId(
  media: { id: number; type?: string },
  resume: ResumeLike | null | undefined,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const known = partyEpisodeId(media, resume, null)
  if (known !== undefined || media.type !== 'show') return known
  const seasons = [...await getSeasons(media.id, signal)].sort((a, b) => a.season_number - b.season_number)
  for (const season of seasons) {
    const episodes = [...await getEpisodes(media.id, season.season_number, signal)]
      .sort((a, b) => a.episode_number - b.episode_number)
    const id = partyEpisodeId(media, null, episodes)
    if (id !== undefined) return id
  }
  return undefined
}
