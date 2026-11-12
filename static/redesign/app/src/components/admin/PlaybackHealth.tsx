// Admin, "Playback health": how playback has gone over a recent period.
// How often a title went to the screen as it is, how long the first picture
// took, how much time was spent buffering, how often playback failed, and
// why titles had to be repackaged or converted.
//
// It reads the server's summary and shows it. The summary is counts and
// timings of playback sessions: it holds no title and no name.

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
  compatible: 'No reason recorded',
  unspecified: 'No reason recorded',
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

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="text-[15px] text-ink" role="status">
          {error ? '' : loading ? 'Loading…' : s && s.sessions > 0
            ? `${count(s.sessions, 'playback session', 'playback sessions')} in ${period.phrase}.`
            : `No playback was recorded in ${period.phrase}.`}
        </p>
        <div role="group" aria-label="Period" className="flex gap-1 rounded-control bg-surface-raised p-1">
          {PERIODS.map(p => (
            <button
              key={p.hours}
              type="button"
              aria-pressed={hours === p.hours}
              onClick={() => setHours(p.hours)}
              className={`h-11 rounded-art px-3.5 text-[13px] font-semibold transition-colors ${
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
                ? `${count(converted, 'session was', 'sessions were')} repackaged or converted, which is work for the server.`
                : 'Nothing had to be repackaged or converted.'}
            />
            <Tile
              label="Wait for the first picture"
              value={typical ?? 'Not measured'}
              note={typical === null
                ? 'No session in this period reported it.'
                : slowest ? `The usual wait after pressing play. One start in twenty took ${slowest} or longer.` : 'The usual wait after pressing play.'}
            />
            <Tile
              label="Time spent buffering"
              value={percent(s.rebuffer_ratio)}
              note="Of the time spent watching, the share that was spent waiting for the picture to come back."
            />
            <Tile
              label="Playback that failed"
              value={percent(s.error_rate)}
              note="Of the sessions that reported how they ended."
            />
            <Tile
              label="Never reported an ending"
              value={s.settled_sessions > 0 ? percent(s.abandoned_ratio) : 'Too soon to say'}
              note={s.settled_sessions > 0
                ? `Of the ${count(s.settled_sessions, 'session', 'sessions')} old enough to have ended. When this is high the player’s last report is not arriving, and the two numbers before it are less sure.`
                : 'No session in this period is old enough to have ended yet.'}
            />
          </dl>

          <h3 id={`${ids}-delivery`} className="mb-3 mt-8 font-display text-[17px] font-semibold text-ink">How each was delivered</h3>
          {/* Four columns that fit a phone: the numbers are short, and the
              first column's words wrap. A table that scrolled sideways hid
              the waits, which are the point of it. */}
          <div className="rounded-control bg-surface-raised">
            <table aria-labelledby={`${ids}-delivery`} className="w-full table-fixed text-left text-[14px]">
              <colgroup>
                <col />
                <col className="w-[4.75rem] sm:w-28" />
                <col className="w-[4.25rem] sm:w-28" />
                <col className="w-[5.25rem] sm:w-44" />
              </colgroup>
              <thead>
                <tr className="align-bottom text-[13px] text-ink-2">
                  <th scope="col" className="py-3 pl-4 pr-2 font-semibold sm:pl-5">Delivery</th>
                  <th scope="col" className="px-2 py-3 text-right font-semibold">Sessions</th>
                  <th scope="col" className="px-2 py-3 text-right font-semibold">Usual wait</th>
                  <th scope="col" className="py-3 pl-2 pr-4 text-right font-semibold sm:pr-5">One in twenty waited</th>
                </tr>
              </thead>
              <tbody>
                {s.by_decision.map(d => {
                  const words = DELIVERY[d.decision] ?? { name: d.decision, note: '' }
                  return (
                    <tr key={d.decision} className="border-t border-line align-top">
                      <th scope="row" className="py-3 pl-4 pr-2 font-normal sm:pl-5">
                        <span className="block font-semibold text-ink">{words.name}</span>
                        {words.note && <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">{words.note}</span>}
                      </th>
                      <td className="px-2 py-3 text-right tabular-nums text-ink">{d.count.toLocaleString()}</td>
                      <td className="px-2 py-3 text-right tabular-nums text-ink">{seconds(d.p50_first_frame_ms) ?? 'Not measured'}</td>
                      <td className="py-3 pl-2 pr-4 text-right tabular-nums text-ink sm:pr-5">{seconds(d.p95_first_frame_ms) ?? 'Not measured'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {s.top_reasons.length > 0 && (
            <>
              <h3 id={`${ids}-why`} className="mb-3 mt-8 font-display text-[17px] font-semibold text-ink">
                Why {count(converted, 'session was', 'sessions were')} not played as {converted === 1 ? 'it is' : 'they are'}
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
              {count(s.burn_in_sessions, 'session', 'sessions')} had subtitles drawn into the picture. That keeps the converter off its
              fastest path, so it is the first thing to look at when converted titles start slowly.
            </p>
          )}
        </>
      )}

      <p className="mt-8 max-w-[68ch] text-[13px] leading-snug text-ink-2">
        These are counts and timings of playback sessions, kept for 30 days. They hold no title and no name: nothing here says
        who watched what.
      </p>
    </div>
  )
}
