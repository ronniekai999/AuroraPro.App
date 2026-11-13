// Admin, "Playback health": how playback has gone over a recent period.
// How often a title went to the screen as it is, how long the first picture
// took, how much time was spent buffering, how often playback failed, and
// why titles had to be repackaged or converted.
//
// It reads the server's summary and shows it. The summary is counts and
// timings of playback sessions: it holds no title and no name.
//
// What the summary cannot say, the page does not make up:
// - A session is recorded when its first picture appears. A playback that
//   never showed one is not in any number here.
// - How a playback went after that (whether it failed, how long it
//   buffered) arrives with the player's last report. The summary gives those
//   two shares as 0 when no report has arrived, with nothing to tell that 0
//   from a measured one. The page can tell in one case, and says "Not
//   measured yet" in every other: see `ended`.
// - Two things it cannot tell at all, and so says in the tiles' own words:
//   a page that went into the browser's back/forward cache writes a
//   provisional last report with its ending unknown, which counts as a
//   report and as not failed; and reports whose playbacks watched nothing
//   leave the buffering share at 0 like a measured one.

import { useEffect, useId, useState } from 'react'
import { getPlaybackHealth, type PlaybackHealthSummary } from '@/lib/api'

const PERIODS = [
  { hours: 24, label: 'Last 24 hours', phrase: 'the last 24 hours' },
  { hours: 7 * 24, label: 'Last 7 days', phrase: 'the last 7 days' },
  { hours: 30 * 24, label: 'Last 30 days', phrase: 'the last 30 days' },
] as const

/** What the server calls each way of delivering a title, in plain words. */
const DELIVERY: Record<string, { name: string; note: string }> = {
  direct_play: { name: 'Played as it is', note: 'The file went to the screen untouched.' },
  direct_stream: { name: 'Repackaged', note: 'The picture and sound were copied into a form the device can open. Nothing was re-encoded.' },
  transcode: { name: 'Converted', note: 'The picture, the sound or both were re-encoded for the device.' },
}

/** Why a title was not played as it is. */
const REASON: Record<string, string> = {
  container: 'The file’s container is one the device cannot open',
  video_codec: 'The device cannot play the video format',
  audio_codec: 'The device cannot play the audio format',
  bit_depth: 'The video is 10-bit or deeper, which the device does not take',
  audio_track: 'The sound the device can play is not the file’s first audio track',
  bitrate: 'The file’s bitrate is above the viewer’s limit',
  // The player found nothing the device could not take, and the title was
  // repackaged or converted all the same (a picked quality does that).
  compatible: 'The device could have played the file as it is',
  unspecified: 'No reason recorded',
}

/** Fewer starts than this, and "one in twenty" describes no start at all:
 *  the slowest of a handful is one playback, not a pattern. */
const ENOUGH_FOR_ONE_IN_TWENTY = 20

/** What the slow-start figure of one delivery is, by that delivery's own
 *  count of playbacks, however many there were in all. With few it is about
 *  the slowest one: "about", since the figure is taken over the playbacks
 *  whose wait was measured, which can be fewer than the count, and sits a
 *  little under the slowest. */
const slowOf = (n: number) => (n < ENOUGH_FOR_ONE_IN_TWENTY ? 'about the slowest' : 'one in twenty')

/** A delivery's slow-start figure with what it is, or that there is none. */
function SlowStart({ ms, of }: { ms: number | null | undefined; of: number }) {
  const wait = seconds(ms)
  if (wait === null) return <>Not measured</>
  return <>{wait}<span className="block text-xs font-normal text-ink-2">{slowOf(of)}</span></>
}

/** A wait in seconds: one decimal under ten, whole above. */
export function seconds(ms: number | null | undefined): string | null {
  if (ms == null) return null
  const s = ms / 1000
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
}

/** A share as a percentage. A share that is not zero never reads "0%". */
export function percent(ratio: number): string {
  if (!(ratio > 0)) return '0%'
  const pct = ratio * 100
  if (pct < 1) return 'under 1%'
  if (pct > 99 && pct < 100) return 'over 99%'
  return `${Math.round(pct)}%`
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-control bg-surface-raised p-5">
      <dt className="text-[13px] font-semibold text-ink-2">{label}</dt>
      <dd className="mt-1">
        <span className="block font-display text-[28px] font-bold leading-tight tabular-nums text-ink">{value}</span>
        <span className="mt-1.5 block text-[13px] leading-snug text-ink-2">{note}</span>
      </dd>
    </div>
  )
}

export function PlaybackHealth() {
  const ids = useId()
  const [hours, setHours] = useState<number>(PERIODS[1].hours)
  const [summary, setSummary] = useState<PlaybackHealthSummary | null>(null)
  // The period the numbers on screen are for. While another is loading the
  // old numbers stay up, marked as such.
  const [shownHours, setShownHours] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const ac = new AbortController()
    setError(null)
    getPlaybackHealth(hours, ac.signal)
      .then(s => { setSummary(s); setShownHours(hours) })
      .catch((err: unknown) => {
        if (ac.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return
        setError('The playback numbers could not be loaded.')
      })
    return () => ac.abort()
  }, [hours, attempt])

  const period = PERIODS.find(p => p.hours === hours) ?? PERIODS[1]
  const loading = shownHours !== hours && !error
  const s = shownHours === hours ? summary : null
  const typical = seconds(s?.p50_first_frame_ms)
  const slowest = seconds(s?.p95_first_frame_ms)
  const converted = s ? s.by_decision.filter(d => d.decision !== 'direct_play').reduce((n, d) => n + d.count, 0) : 0
  const mostReasons = s ? Math.max(1, ...s.top_reasons.map(r => r.count)) : 1
  // Whether any playback is known to have reported how it ended. The failed
  // and buffering shares are measured over those reports alone, and the
  // summary does not say how many there were. It does say how many sessions
  // are old enough to have ended and what share of THOSE never reported:
  // when some are, and not all of them stayed silent, a report exists. A
  // share above zero is also proof of one.
  const ended = !!s && s.settled_sessions > 0 && s.abandoned_ratio < 1
  const failedMeasured = !!s && (ended || s.error_rate > 0)
  const bufferingMeasured = !!s && (ended || s.rebuffer_ratio > 0)
  // By the count of all playbacks: the summary does not say how many of
  // them had their wait measured.
  const fewStarts = !!s && s.sessions < ENOUGH_FOR_ONE_IN_TWENTY

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="text-[15px] text-ink" role="status">
          {error ? '' : loading ? 'Loading…' : s && s.sessions > 0
            ? `${count(s.sessions, 'playback', 'playbacks')} reached a picture in ${period.phrase}.`
            : `No playback reached a picture in ${period.phrase}.`}
        </p>
        {/* The three share the row's width when it is too narrow for their
            words on one line each, and their labels wrap inside them. */}
        <div role="group" aria-label="Period" className="flex max-w-full gap-1 rounded-control bg-surface-raised p-1">
          {PERIODS.map(p => (
            <button
              key={p.hours}
              type="button"
              aria-pressed={hours === p.hours}
              onClick={() => setHours(p.hours)}
              className={`min-h-[44px] min-w-0 flex-1 rounded-art px-3 py-1 text-[13px] font-semibold leading-tight transition-colors sm:flex-none sm:px-3.5 ${
                hours === p.hours ? 'bg-action text-action-on' : 'text-ink-2 hover:text-ink'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-control bg-surface-raised px-5 py-4">
          <p className="min-w-0 flex-1 basis-[16rem] text-[14px] text-danger-ink">{error}</p>
          <button type="button" className="stage-btn stage-btn-ghost" onClick={() => setAttempt(n => n + 1)}>Try again</button>
        </div>
      )}

      {s && s.sessions > 0 && (
        <>
          <h3 id={`${ids}-how`} className="mb-3 mt-8 font-display text-[17px] font-semibold text-ink">How things played</h3>
          <dl aria-labelledby={`${ids}-how`} className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
            <Tile
              label="Played as they are"
              value={percent(s.direct_play_ratio)}
              note={converted > 0
                ? `Of the playbacks that reached a picture. ${count(converted, 'was', 'were')} repackaged or converted, which is work for the server.`
                : 'Of the playbacks that reached a picture. Nothing had to be repackaged or converted.'}
            />
            <Tile
              label="Wait for the first picture"
              value={typical ?? 'Not measured'}
              note={typical === null
                ? 'No playback in this period reported it.'
                : !slowest ? 'The usual wait after pressing play.'
                : fewStarts ? `The usual wait after pressing play. The slowest start took about ${slowest}; with ${count(s.sessions, 'playback', 'playbacks')} that is one start, not a pattern.`
                : `The usual wait after pressing play. One start in twenty took ${slowest} or longer.`}
            />
            <Tile
              label="Time spent buffering"
              value={bufferingMeasured ? percent(s.rebuffer_ratio) : 'Not measured yet'}
              note={bufferingMeasured
                ? 'Of the time watched, the share spent waiting for the picture to come back, in the playbacks that sent a last report. It also reads 0% when those playbacks watched nothing.'
                : 'This comes with a playback’s last report, and none has arrived for this period as far as these numbers show.'}
            />
            <Tile
              label="Playback that failed"
              value={failedMeasured ? percent(s.error_rate) : 'Not measured yet'}
              note={failedMeasured
                ? 'Of the playbacks that reached a picture and sent a last report. A page the browser set aside sends one with its ending unknown, and is counted as not failed.'
                : 'This comes with a playback’s last report, and none has arrived for this period as far as these numbers show.'}
            />
            <Tile
              label="Never reported an ending"
              value={s.settled_sessions > 0 ? percent(s.abandoned_ratio) : 'Too soon to say'}
              note={s.settled_sessions > 0
                ? `Of the ${count(s.settled_sessions, 'playback', 'playbacks')} old enough to have ended. When this is high the player’s last report is not arriving, and the two numbers before it are less sure.`
                : 'No playback in this period is old enough to have ended yet.'}
            />
          </dl>

          <h3 id={`${ids}-delivery`} className="mb-3 mt-8 font-display text-[17px] font-semibold text-ink">How each was delivered</h3>
          {/* A table needs its four columns side by side, and a phone has room
              for the words or for the numbers, not both: at 320 wide the
              first column was one word to a line. Below the table's width
              each delivery is a block instead: its name and what it means,
              then its three figures, each under its label. One of the two
              is displayed at a time. */}
          <ul aria-labelledby={`${ids}-delivery`} className="rounded-control bg-surface-raised px-4 sm:hidden">
            {s.by_decision.map(d => {
              const words = DELIVERY[d.decision] ?? { name: d.decision, note: '' }
              return (
                <li key={d.decision} className="border-t border-line py-3.5 first:border-t-0">
                  <p className="text-[15px] font-semibold text-ink">{words.name}</p>
                  {words.note && <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{words.note}</p>}
                  <dl className="mt-2.5 grid grid-cols-3 gap-x-3 text-[13px] leading-snug">
                    <div>
                      <dt className="text-ink-2">Playbacks</dt>
                      <dd className="mt-0.5 text-[15px] tabular-nums text-ink">{d.count.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-2">Usual wait</dt>
                      <dd className="mt-0.5 text-[15px] tabular-nums text-ink">{seconds(d.p50_first_frame_ms) ?? 'Not measured'}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-2">Slowest starts</dt>
                      <dd className="mt-0.5 text-[15px] tabular-nums text-ink"><SlowStart ms={d.p95_first_frame_ms} of={d.count} /></dd>
                    </div>
                  </dl>
                </li>
              )
            })}
          </ul>
          <div className="hidden rounded-control bg-surface-raised sm:block">
            <table aria-labelledby={`${ids}-delivery`} className="w-full table-fixed text-left text-[14px]">
              <colgroup>
                <col />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-44" />
              </colgroup>
              <thead>
                <tr className="align-bottom text-[13px] text-ink-2">
                  <th scope="col" className="py-3 pl-5 pr-2 font-semibold">Delivery</th>
                  <th scope="col" className="px-2 py-3 text-right font-semibold">Playbacks</th>
                  <th scope="col" className="px-2 py-3 text-right font-semibold">Usual wait</th>
                  <th scope="col" className="py-3 pl-2 pr-5 text-right font-semibold">Slowest starts</th>
                </tr>
              </thead>
              <tbody>
                {s.by_decision.map(d => {
                  const words = DELIVERY[d.decision] ?? { name: d.decision, note: '' }
                  return (
                    <tr key={d.decision} className="border-t border-line align-top">
                      <th scope="row" className="py-3 pl-5 pr-2 font-normal">
                        <span className="block font-semibold text-ink">{words.name}</span>
                        {words.note && <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">{words.note}</span>}
                      </th>
                      <td className="px-2 py-3 text-right tabular-nums text-ink">{d.count.toLocaleString()}</td>
                      <td className="px-2 py-3 text-right tabular-nums text-ink">{seconds(d.p50_first_frame_ms) ?? 'Not measured'}</td>
                      <td className="py-3 pl-2 pr-5 text-right tabular-nums text-ink"><SlowStart ms={d.p95_first_frame_ms} of={d.count} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {s.top_reasons.length > 0 && (
            <>
              <h3 id={`${ids}-why`} className="mb-3 mt-8 font-display text-[17px] font-semibold text-ink">
                Why {count(converted, 'playback was', 'playbacks were')} not played as {converted === 1 ? 'it is' : 'they are'}
              </h3>
              <ul aria-labelledby={`${ids}-why`} className="rounded-control bg-surface-raised px-5 py-2">
                {s.top_reasons.map(r => (
                  <li key={r.reason} className="border-t border-line py-3 first:border-t-0">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="min-w-0 text-[14px] text-ink">{REASON[r.reason] ?? r.reason}</span>
                      <span className="flex-none text-[14px] font-semibold tabular-nums text-ink">{r.count.toLocaleString()}</span>
                    </div>
                    {/* The count again, as a length: drawn, not read out. */}
                    <div aria-hidden="true" className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--track)]">
                      <div className="h-full rounded-full bg-action" style={{ width: `${Math.max(2, (r.count / mostReasons) * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {s.burn_in_sessions > 0 && (
            <p className="mt-5 max-w-[68ch] text-[14px] leading-snug text-ink-2">
              {count(s.burn_in_sessions, 'playback', 'playbacks')} had subtitles drawn into the picture. That keeps the converter off its
              fastest path, so it is the first thing to look at when converted titles start slowly.
            </p>
          )}
        </>
      )}

      <p className="mt-8 max-w-[68ch] text-[13px] leading-snug text-ink-2">
        A playback is counted from its first picture. One that never showed a picture, because it failed or was given up on
        before that, is not in any number on this page.
      </p>
      <p className="mt-3 max-w-[68ch] text-[13px] leading-snug text-ink-2">
        These are counts and timings of playbacks, kept for 30 days. They hold no title and no name: nothing here says
        who watched what.
      </p>
    </div>
  )
}
