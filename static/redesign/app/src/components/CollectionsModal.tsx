// Phase 6 — Collections create modal.
//
// Centered overlay with two modes:
//   Manual — name + description, creates an empty collection.
//   AI     — name + prompt; server runs semantic search and
//            pre-fills the collection with the top hits.
//
// Admins additionally see an "Make public" toggle (admin-only;
// server enforces).

import { useState } from 'react'
import { createCollection, type Collection } from '@/lib/api'

interface Props {
  isAdmin: boolean
  onClose: () => void
  onCreated: (c: Collection) => void
}

export function CollectionsModal({ isAdmin, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<'manual' | 'ai'>('manual')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [makePublic, setMakePublic] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    if (mode === 'ai' && !prompt.trim()) {
      setError('Prompt is required for AI-curated collections.')
      return
    }
    setSubmitting(true)
    try {
      const c = await createCollection({
        name: name.trim(),
        description: description.trim() || undefined,
        kind: mode,
        prompt: mode === 'ai' ? prompt.trim() : undefined,
        is_public: makePublic && isAdmin,
      })
      onCreated(c)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 stage-scrim-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] bg-[color:var(--surface-1)] rounded-2xl border border-white/[0.08] shadow-[shadow:var(--shadow-modal)] overflow-hidden stage-dialog-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-white/[0.04]">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 mb-3">
            <span className="text-purple-200 text-xs font-medium uppercase tracking-wider">
              New Collection
            </span>
          </div>
          <h2 className="text-white text-2xl font-bold font-display">
            Curate Something
          </h2>
          <p className="text-white/50 text-sm mt-1">
            Group your media manually or let Aurora's AI build it from a vibe.
          </p>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-white/[0.04]">
          <button
            type="button"
            onClick={() => setMode('manual')}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              mode === 'manual'
                ? 'text-purple-300 border-b-2 border-purple-500'
                : 'text-white/50 hover:text-white/80'
            }`}
          >
            Manual
          </button>
          <button
            type="button"
            onClick={() => setMode('ai')}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              mode === 'ai'
                ? 'text-purple-300 border-b-2 border-purple-500'
                : 'text-white/50 hover:text-white/80'
            }`}
          >
            ✨ AI-Curated
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-white/70 text-sm mb-2">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                mode === 'ai'
                  ? 'Slow-burn 90s sci-fi'
                  : 'Marvel Cinematic Universe'
              }
              autoFocus
              disabled={submitting}
              className="w-full"
            />
          </div>

          {mode === 'manual' ? (
            <div>
              <label className="block text-white/70 text-sm mb-2">
                Description <span className="text-white/50">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A short note about what ties these together..."
                disabled={submitting}
                rows={3}
                className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded text-white text-sm resize-none"
              />
            </div>
          ) : (
            <div>
              <label className="block text-white/70 text-sm mb-2">
                What kind of collection?
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. moody A24 thrillers, feel-good 90s sci-fi, dark comedy with great soundtracks..."
                disabled={submitting}
                rows={3}
                className="w-full px-3 py-2 bg-white/[0.04] border border-purple-500/30 rounded text-white text-sm resize-none focus:border-purple-500/60"
              />
              <p className="text-white/50 text-xs mt-2">
                Aurora's AI will scan your library and pick 10–12 titles that
                match the vibe.
              </p>
            </div>
          )}

          {isAdmin && (
            <label className="flex items-start gap-2 text-sm text-white/70">
              <input
                type="checkbox"
                checked={makePublic}
                onChange={(e) => setMakePublic(e.target.checked)}
                disabled={submitting}
                className="mt-0.5"
              />
              <span>
                <span className="text-white/90">Make public</span>
                <span className="block text-white/50 text-xs">
                  Shown on every user's home view. Admins only.
                </span>
              </span>
            </label>
          )}

          {error && (
            <div className="px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm text-white/70 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-lg transition-ui disabled:opacity-50 disabled:cursor-not-allowed glow-purple"
            >
              {submitting
                ? mode === 'ai'
                  ? 'Asking AI…'
                  : 'Creating…'
                : mode === 'ai'
                  ? '✨ Build with AI'
                  : 'Create Collection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
