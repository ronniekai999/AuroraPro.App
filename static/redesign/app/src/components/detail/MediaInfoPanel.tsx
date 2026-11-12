// The technical side of a title: the versions on disk, its audio tracks and
// its subtitles. Lives inside a closed disclosure at the foot of the title
// page; nothing here is needed to press Play.

export interface AudioRowVM {
  language: string // uppercased, e.g. "ENG"
  codec: string // e.g. "DTS"
  detail?: string // e.g. "5.1 · 6ch"
  isDefault?: boolean
}

export interface SubtitleVM {
  language: string // uppercased language code
  forced?: boolean
  default?: boolean
}

export interface VersionVM {
  id: number
  name: string // "4K HDR", "1080p"
  detail?: string // "hevc/truehd · 55.0 GB"
  note?: string // the library it is in
}

interface MediaInfoPanelProps {
  versions?: VersionVM[]
  audio: AudioRowVM[]
  subtitles: SubtitleVM[]
  subtitleFormat?: string // e.g. "PGS / image-based" | "SRT / text"
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</h3>
      <ul>{children}</ul>
    </div>
  )
}

function Row({ name, detail, note }: { name: string; detail?: string; note?: string }) {
  return (
    <li className="min-h-[40px] py-2 flex items-center gap-2.5 border-t border-line text-[14px]">
      <span className="font-semibold text-ink flex-none">{name}</span>
      <span className="flex-1 min-w-0 truncate text-ink-2">{detail}</span>
      {note && <span className="text-[12px] text-ink-3 flex-none">{note}</span>}
    </li>
  )
}

export function mediaInfoSummary(versions: number, audio: number, subtitles: number): string {
  const parts: string[] = []
  if (versions > 1) parts.push(`${versions} versions`)
  if (audio > 0) parts.push(`${audio} audio track${audio === 1 ? '' : 's'}`)
  if (subtitles > 0) parts.push(`${subtitles} subtitle${subtitles === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export function MediaInfoPanel({ versions = [], audio, subtitles, subtitleFormat }: MediaInfoPanelProps) {
  if (versions.length === 0 && audio.length === 0 && subtitles.length === 0) return null
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-x-10 gap-y-6">
      {versions.length > 0 && (
        <Group title="Versions">
          {versions.map(v => <Row key={v.id} name={v.name} detail={v.detail} note={v.note} />)}
        </Group>
      )}
      {audio.length > 0 && (
        <Group title="Audio">
          {audio.map((a, i) => (
            <Row key={i} name={a.language} detail={[a.codec, a.detail].filter(Boolean).join(' · ')} note={a.isDefault ? 'Default' : undefined} />
          ))}
        </Group>
      )}
      {subtitles.length > 0 && (
        <Group title={subtitleFormat ? `Subtitles · ${subtitleFormat}` : 'Subtitles'}>
          {subtitles.map((s, i) => (
            <Row
              key={i}
              name={s.language}
              note={[s.forced && 'Forced', s.default && 'Default'].filter(Boolean).join(' · ') || undefined}
            />
          ))}
        </Group>
      )}
    </div>
  )
}
