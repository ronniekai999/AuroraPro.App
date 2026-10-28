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
// now. The id is a hash of what the build emits, not the commit: the same
// source builds the same id, and the page discloses nothing a client could not
// already compute from the files it is sent.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

export const BUILD_ID_META_NAME = 'aurora-build'

interface BundleEntry {
  type: 'chunk' | 'asset'
  fileName: string
  code?: string
  source?: string | Uint8Array
}

/** Every file under dir, as [path relative to dir, contents], in a stable order. */
export function readTree(dir: string): Array<[string, Uint8Array]> {
  const out: Array<[string, Uint8Array]> = []
  const walk = (rel: string) => {
    let entries
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) out.push([child, readFileSync(path.join(dir, child))])
    }
  }
  walk('')
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * A stable id for a build: the emitted bundle (whose file names already carry
 * content hashes), the files copied from public/ (sw.js, the manifest, icons,
 * which Rollup never sees), and the page itself before the id goes into it.
 * Bundle .html entries are left out: the page is passed in as `html`.
 */
export function buildIdFromBundle(
  bundle: Record<string, BundleEntry>,
  html = '',
  publicFiles: Array<[string, Uint8Array]> = [],
): string {
  const hash = createHash('sha256')
  const entries = Object.values(bundle)
    .filter(entry => !entry.fileName.endsWith('.html'))
    .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
  for (const entry of entries) {
    const content = entry.type === 'chunk' ? entry.code ?? '' : entry.source ?? ''
    hash.update('bundle\0').update(entry.fileName).update('\0').update(content).update('\0')
  }
  for (const [name, content] of publicFiles) {
    hash.update('public\0').update(name).update('\0').update(content).update('\0')
  }
  hash.update('html\0').update(html)
  return hash.digest('hex').slice(0, 20)
}

export function auroraBuildId(): Plugin {
  let publicDir = ''
  return {
    name: 'aurora-build-id',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir
    },
    transformIndexHtml: {
      // 'post' runs in generateBundle, once every chunk and asset is final.
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return
        const id = buildIdFromBundle(ctx.bundle, html, publicDir ? readTree(publicDir) : [])
        return [{ tag: 'meta', attrs: { name: BUILD_ID_META_NAME, content: id }, injectTo: 'head' }]
      },
    },
  }
}
