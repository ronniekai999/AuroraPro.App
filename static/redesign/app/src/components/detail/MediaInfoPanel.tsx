// Aurora V2 — Media Info panel (audio tracks + subtitle languages).
//
// Two glass cards. Hides itself entirely when there's nothing to show
// (preserves the old graceful-hide behavior).

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

interface MediaInfoPanelProps {
  audio: AudioRowVM[]
  subtitles: SubtitleVM[]
  subtitleFormat?: string // e.g. "PGS / image-based" | "SRT / text"
  className?: string
}

function LangChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex px-2.5 py-1 rounded-lg text-[11.5px] font-semibold bg-white/5 border border-white/10 text-white/80">
      {children}
    </span>
  )
}

export function MediaInfoPanel({ audio, subtitles, subtitleFormat, className }: MediaInfoPanelProps) {
  if (audio.length === 0 && subtitles.length === 0) return null
  return (
    <section className={className}>
      <h3 className="text-lg font-semibold font-display mb-5">Media Info</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {audio.length > 0 && (
          <div className="glass-card rounded-2xl p-5">
            <div className="text-[11px] uppercase tracking-[.16em] text-white/40 mb-3 font-semibold">
              Audio Tracks
            </div>
            {audio.map((a, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2 border-b border-white/[0.05] last:border-0"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <LangChip>{a.language}</LangChip>
                  <span className="text-[14px] text-white/85 font-medium">{a.codec}</span>
                  {a.detail && <span className="text-[13px] text-white/45 truncate">{a.detail}</span>}
                </div>
                {a.isDefault && (
                  <span className="text-[10px] px-2 py-0.5 bg-purple-500/15 text-purple-300 rounded font-semibold flex-shrink-0 ml-2">
                    Default
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {subtitles.length > 0 && (
          <div className="glass-card rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] uppercase tracking-[.16em] text-white/40 font-semibold">
                Subtitles · {subtitles.length}
              </div>
              {subtitleFormat && <span className="text-[11px] text-white/45">{subtitleFormat}</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {subtitles.map((s, i) => (
                <span
                  key={i}
                  title={[s.forced && 'Forced', s.default && 'Default'].filter(Boolean).join(' · ') || undefined}
                  className={
                    'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold border ' +
                    (s.forced
                      ? 'bg-amber-500/[0.12] border-amber-400/25 text-amber-200'
                      : s.default
                        ? 'bg-purple-500/[0.12] border-purple-400/25 text-purple-200'
                        : 'bg-white/5 border-white/10 text-white/80')
                  }
                >
                  {s.language}
                  {s.forced && <span className="text-[9px] uppercase opacity-80">F</span>}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
