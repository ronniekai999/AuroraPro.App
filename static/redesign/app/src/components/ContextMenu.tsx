// Aurora V2 — right-click context menu on media cards.
// Phase 5.2 parity port of V1's `showContextMenu`. Anchors at the
// cursor, closes on Escape / outside-click. Caller decides which
// items to expose (admin gates the Refresh-Metadata item).

import { useEffect, useRef } from 'react'

export interface MediaContextItem {
  label: string
  // 'danger' tints red (e.g. Clear Progress). 'admin' is just a hint
  // for the caller — not rendered differently here.
  tone?: 'default' | 'danger'
  onClick: () => void
}

interface Props {
  x: number
  y: number
  items: MediaContextItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // Bind on next tick so the same right-click that opened us
    // doesn't immediately close us via this listener.
    const t = window.setTimeout(() => window.addEventListener('mousedown', onClick), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
      window.clearTimeout(t)
    }
  }, [onClose])

  // Clamp to viewport so the menu never overflows the right/bottom edge.
  const maxX = typeof window !== 'undefined' ? window.innerWidth - 220 : x
  const maxY = typeof window !== 'undefined' ? window.innerHeight - items.length * 36 - 16 : y
  const clampedX = Math.min(x, Math.max(0, maxX))
  const clampedY = Math.min(y, Math.max(0, maxY))

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[200px] bg-[#1a1a22] border border-white/[0.08] rounded-lg shadow-2xl py-1"
      style={{ left: clampedX, top: clampedY }}
    >
      {items.map((it, i) => (
        <button
          key={i}
          onClick={() => { it.onClick(); onClose() }}
          className={`w-full text-left px-3 py-2 text-sm transition-colors ${
            it.tone === 'danger'
              ? 'text-red-300 hover:bg-red-500/10'
              : 'text-white/85 hover:bg-white/[0.06]'
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
