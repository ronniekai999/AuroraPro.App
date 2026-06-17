// Small pure date/format helpers shared across views. Extracted from
// App.tsx (2026-06-17 app split) so view modules can import them
// without reaching into App. Pure (no @/lib/api dependency) — no cycle.

export function formatRequestDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!t) return ''
  const diff = Date.now() - t
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(iso).toLocaleDateString()
}