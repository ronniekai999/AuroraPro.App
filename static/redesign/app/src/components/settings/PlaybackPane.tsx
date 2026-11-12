// Settings, "Playback" (/settings/playback): what happens when an episode
// ends, which audio language is picked, and how much picture this browser
// asks for. Every choice here is kept in this browser (the `aurora_prefs`
// blob, lib/appearance.ts) and read when a title starts, so a change applies
// to the next play.

import { useId, useState } from 'react'
import {
  AUDIO_LANGUAGE_OPTIONS,
  MAX_STREAM_BITRATE_OPTIONS,
  applyMaxStreamBps,
  applyPreferredAudioLanguage,
  applyPreferredQuality,
  currentMaxStreamBps,
  currentPreferredAudioLanguage,
  currentPreferredQuality,
  readPrefsSnapshot,
  writePrefKey,
  type AudioLanguageChoice,
  type QualityChoice,
} from '@/lib/appearance'
import { PaneSection, SettingRow, SettingSelect, SettingSwitch, type SelectOption } from './controls'

const QUALITY_OPTIONS: readonly SelectOption[] = [
  { value: 'auto', label: 'Auto (1080p preferred)' },
  { value: '1080p', label: '1080p' },
  { value: '4k', label: '4K when a title has it' },
]

export function PlaybackPane() {
  const ids = useId()
  // Anything but an explicit `false` is on: the player and the app read it
  // the same way.
  const [autoplay, setAutoplay] = useState(() => readPrefsSnapshot().autoplay !== false)
  const [quality, setQuality] = useState<QualityChoice>(currentPreferredQuality)
  const [audioLang, setAudioLang] = useState<AudioLanguageChoice>(currentPreferredAudioLanguage)
  const [maxBps, setMaxBps] = useState<number>(currentMaxStreamBps)

  const bitrateOptions: SelectOption[] = MAX_STREAM_BITRATE_OPTIONS.map(o => ({ value: String(o.bps), label: o.label }))
  // A stored value outside the list (only reachable by editing the stored
  // preferences) is still shown: otherwise the control would read "No limit"
  // while every request carried the limit.
  if (!MAX_STREAM_BITRATE_OPTIONS.some(o => o.bps === maxBps)) {
    bitrateOptions.push({ value: String(maxBps), label: `Custom (${(maxBps / 1_000_000).toFixed(1)} Mbps)` })
  }

  return (
    <>
      <PaneSection title="Playback" note="Kept in this browser, and used from the next title you start.">
        <SettingRow
          labelId={`${ids}-autoplay`}
          descId={`${ids}-autoplay-desc`}
          label="Play the next episode automatically"
          desc="At the credits, the Up next card counts down and starts the next episode unless you cancel. Off, it waits for you. In a watch party it always waits for the host."
        >
          <SettingSwitch
            checked={autoplay}
            labelledBy={`${ids}-autoplay`}
            describedBy={`${ids}-autoplay-desc`}
            onChange={next => {
              // One key, over a fresh read: the player keeps its volume in
              // the same stored object while this page is open under it.
              writePrefKey('autoplay', next)
              setAutoplay(next)
            }}
          />
        </SettingRow>
      </PaneSection>

      <PaneSection title="Language" note="The track menu in the player still overrides this for one title.">
        <SettingRow
          htmlFor={`${ids}-audio`}
          descId={`${ids}-audio-desc`}
          label="Audio language"
          desc="Picked by default when a file has a track in this language."
        >
          <SettingSelect
            id={`${ids}-audio`}
            aria-describedby={`${ids}-audio-desc`}
            value={audioLang}
            options={AUDIO_LANGUAGE_OPTIONS.map(o => ({ value: o.id, label: o.label }))}
            onChange={v => {
              const l = v as AudioLanguageChoice
              applyPreferredAudioLanguage(l)
              setAudioLang(l)
            }}
          />
        </SettingRow>
      </PaneSection>

      <PaneSection title="Quality">
        <SettingRow
          htmlFor={`${ids}-quality`}
          descId={`${ids}-quality-desc`}
          label="Preferred resolution"
          desc="When a title has several files, play this one if it exists."
        >
          <SettingSelect
            id={`${ids}-quality`}
            aria-describedby={`${ids}-quality-desc`}
            value={quality}
            options={QUALITY_OPTIONS}
            onChange={v => {
              const q = v as QualityChoice
              applyPreferredQuality(q)
              setQuality(q)
            }}
          />
        </SettingRow>
        <SettingRow
          htmlFor={`${ids}-bitrate`}
          descId={`${ids}-bitrate-desc`}
          label="Streaming bitrate limit"
          desc="For a slow connection. A file above the limit is converted down instead of left to buffer."
        >
          <SettingSelect
            id={`${ids}-bitrate`}
            aria-describedby={`${ids}-bitrate-desc`}
            value={String(maxBps)}
            options={bitrateOptions}
            onChange={v => {
              const bps = Number(v)
              applyMaxStreamBps(bps)
              setMaxBps(bps)
            }}
          />
        </SettingRow>
      </PaneSection>
    </>
  )
}
