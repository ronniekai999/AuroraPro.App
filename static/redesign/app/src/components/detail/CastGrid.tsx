// Aurora V2 — cast grid (round avatars, 2/3 columns, initials fallback).
//
// The editorial layout replaces the old horizontal CastCard scroll (removed
// from App.tsx) with this scannable grid.

import { useState } from 'react'

export interface CastVM {
  id: number
  name: string
  character?: string
  profileUrl?: string // pre-built image URL (caller uses posterURL)
}

interface CastGridProps {
  cast: CastVM[]
  totalCount?: number
  onViewAll?: () => void
  className?: string
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function CastMemberRow({ member }: { member: CastVM }) {
  const [failed, setFailed] = useState(false)
  const showImg = !!member.profileUrl && !failed
  return (
    <div className="flex items-center gap-3">
      {showImg ? (
        <img
          src={member.profileUrl}
          alt={member.name}
          loading="lazy"
          onError={() => setFailed(true)}
          className="w-14 h-14 rounded-full object-cover ring-1 ring-white/10 flex-shrink-0"
        />
      ) : (
        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-purple-500/30 to-fuchsia-500/10 ring-1 ring-white/10 flex items-center justify-center font-semibold flex-shrink-0">
          {initials(member.name)}
        </div>
      )}
      <div className="min-w-0">
        <div className="text-[14px] font-semibold truncate">{member.name}</div>
        {member.character && <div className="text-[12px] text-white/50 truncate">{member.character}</div>}
      </div>
    </div>
  )
}

export function CastGrid({ cast, totalCount, onViewAll, className }: CastGridProps) {
  if (cast.length === 0) return null
  return (
    <section className={className}>
      <div className="flex items-baseline justify-between mb-5">
        <h3 className="text-lg font-semibold font-display">Top Cast</h3>
        {onViewAll && totalCount && totalCount > cast.length && (
          <button
            type="button"
            onClick={onViewAll}
            className="text-sm text-white/50 hover:text-white/80 transition-colors"
          >
            View all {totalCount} →
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-4">
        {cast.map((c) => (
          <CastMemberRow key={c.id} member={c} />
        ))}
      </div>
    </section>
  )
}
