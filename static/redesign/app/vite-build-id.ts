// Build identity for the SPA — lets an open tab notice that the server now
// serves a newer bundle (src/lib/buildUpdate.ts).
//
// Every deploy replaces static/v2 wholesale and deletes the previous build's
// hashed chunks (scripts/aurora-update.sh; there is deliberately no service
// worker cache, see public/sw.js). A tab opened before that keeps running the
// old JavaScript against the new API, and its first visit to a not-yet-loaded
// view fails to fetch a chunk that no longer exists. Nothing told the user.
//
// The fix needs both sides to name a build the same way: the running page reads
// the <meta> it was loaded with, and polls /v2/ for the one the server serves
// now. The id is a hash of the emitted bundle (file names, which already carry
// content hashes, plus contents), not the commit: the same source builds the
// same id, and the page discloses nothing a client could not already compute
// from the asset URLs it was sent.

import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'

export const BUILD_ID_META_NAME = 'aurora-build'

interface BundleEntry {
  type: 'chunk' | 'asset'
  fileName: string
  code?: string
  source?: string | Uint8Array
}

/** A stable id for an emitted bundle. HTML is left out: it is what carries the id. */
export function buildIdFromBundle(bundle: Record<string, BundleEntry>): string {
  const hash = createHash('sha256')
  const entries = Object.values(bundle)
    .filter(entry => !entry.fileName.endsWith('.html'))
    .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
  for (const entry of entries) {
    const content = entry.type === 'chunk' ? entry.code ?? '' : entry.source ?? ''
    hash.update(entry.fileName).update('\0').update(content).update('\0')
  }
  return hash.digest('hex').slice(0, 20)
}

export function auroraBuildId(): Plugin {
  return {
    name: 'aurora-build-id',
    apply: 'build',
    transformIndexHtml: {
      // 'post' runs in generateBundle, once every chunk and asset is final.
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return
        return [{
          tag: 'meta',
          attrs: { name: BUILD_ID_META_NAME, content: buildIdFromBundle(ctx.bundle) },
          injectTo: 'head',
        }]
      },
    },
  }
}
