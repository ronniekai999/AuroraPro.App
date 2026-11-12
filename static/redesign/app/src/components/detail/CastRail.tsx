// The cast as one horizontal rail: a face (or initials), a name, the part
// they play. It scrolls sideways; it never pushes the page taller than one
// row however large the cast is.

import { useState } from 'react'

export interface CastVM {
  id: number
  name: string
  character?: string
  profileUrl?: string // pre-built image URL (the caller uses posterURL)
}

interface CastRailProps {
  cast: CastVM[]
  className?: string
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function CastMember({ member }: { member: CastVM }) {
  const [failed, setFailed] = useState(false)
  const showImg = !!member.profileUrl && !failed
  return (
    <li className="flex-none w-[120px] sm:w-[132px] flex flex-col gap-2.5">
      {showImg ? (
        <img
          src={member.profileUrl}
          // The name is printed underneath; announcing it twice is noise.
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="w-[72px] h-[72px] rounded-full object-cover bg-surface-raised-2"
        />
      ) : (
        <span aria-hidden="true" className="w-[72px] h-[72px] rounded-full bg-surface-raised-2 text-ink-2 text-[22px] font-semibold flex items-center justify-center">
          {initials(member.name)}
        </span>
      )}
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[14px] leading-[1.4] font-semibold text-ink">{member.name}</span>
        {member.character && <span className="text-[12px] leading-[1.35] text-ink-3">{member.character}</span>}
      </span>
    </li>
  )
}

export function CastRail({ cast, className }: CastRailProps) {
  if (cast.length === 0) return null
  return (
    <section className={className} aria-labelledby="detail-cast-heading">
      <h2 id="detail-cast-heading" className="font-display text-[22px] leading-tight font-semibold tracking-[-0.01em]">Cast</h2>
      {/* The rail bleeds to the page edge so a face is cut off at the edge
          of the window, not at an invisible margin; its padding puts the
          first face back on the page's left edge. tabIndex: a scroll
          container with no focusable child cannot otherwise be scrolled
          from the keyboard. */}
      <ul
        tabIndex={0}
        aria-label={`Cast, ${cast.length} people`}
        className="stage-detail-rail mt-4 flex gap-5 sm:gap-6 overflow-x-auto"
      >
        {cast.map(c => <CastMember key={c.id} member={c} />)}
      </ul>
    </section>
  )
}
