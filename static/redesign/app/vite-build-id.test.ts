import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILD_ID_META_NAME, auroraBuildId, buildIdFromBundle, readTree } from './vite-build-id'
import { BUILD_ID_META_NAME as RUNTIME_META_NAME } from './src/lib/buildUpdate'
import viteConfig from './vite.config'

type Entry = Parameters<typeof buildIdFromBundle>[0][string]
const chunk = (fileName: string, code: string): Entry => ({ type: 'chunk', fileName, code })
const asset = (fileName: string, source: string): Entry => ({ type: 'asset', fileName, source })

describe('buildIdFromBundle', () => {
  const bundle = {
    a: chunk('assets/index-1.js', 'main'),
    b: asset('assets/index-1.css', 'body{}'),
    c: asset('index.html', '<html>'),
  }

  it('is the same for the same output, whatever order the bundle lists it in', () => {
    expect(buildIdFromBundle(bundle)).toBe(buildIdFromBundle({ c: bundle.c, b: bundle.b, a: bundle.a }))
  })

  it('changes when any emitted file does, even under the same name', () => {
    const id = buildIdFromBundle(bundle)
    expect(buildIdFromBundle({ ...bundle, b: asset('assets/index-1.css', 'body{color:red}') })).not.toBe(id)
    expect(buildIdFromBundle({ ...bundle, d: chunk('assets/AdminView-2.js', 'admin') })).not.toBe(id)
  })

  // The page counts through `html` (taken before the id goes into it), not as
  // a bundle entry, which would be the page WITH the id.
  it('takes the page as passed, not its bundle entry', () => {
    expect(buildIdFromBundle({ ...bundle, c: asset('index.html', '<html lang="en">') })).toBe(buildIdFromBundle(bundle))
    expect(buildIdFromBundle(bundle, '<html lang="en">')).not.toBe(buildIdFromBundle(bundle, '<html>'))
  })

  // public/ is copied verbatim and Rollup never sees it: a deploy that only
  // changes sw.js or the manifest must still read as a new build.
  it('changes when a public/ file does', () => {
    const before = buildIdFromBundle(bundle, '', [['sw.js', new TextEncoder().encode('a')]])
    expect(buildIdFromBundle(bundle, '', [['sw.js', new TextEncoder().encode('b')]])).not.toBe(before)
  })
})

describe('readTree', () => {
  it('lists every file under a directory in a stable order', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'build-id-'))
    mkdirSync(path.join(dir, 'icons'))
    writeFileSync(path.join(dir, 'sw.js'), 'worker')
    writeFileSync(path.join(dir, 'icons', 'a.png'), 'png')
    expect(readTree(dir).map(([name, data]) => [name, Buffer.from(data).toString()]))
      .toEqual([['icons/a.png', 'png'], ['sw.js', 'worker']])
    expect(readTree(path.join(dir, 'absent'))).toEqual([])
  })
})

describe('auroraBuildId', () => {
  it('stamps the id into the page the runtime reads it from', () => {
    expect(BUILD_ID_META_NAME).toBe(RUNTIME_META_NAME)
    const hook = auroraBuildId().transformIndexHtml as {
      order: string
      handler: (html: string, ctx: { bundle?: Record<string, Entry> }) => unknown
    }
    expect(hook.order).toBe('post')
    expect(hook.handler('', { bundle: { a: chunk('assets/i.js', 'x') } })).toEqual([{
      tag: 'meta',
      attrs: { name: 'aurora-build', content: buildIdFromBundle({ a: chunk('assets/i.js', 'x') }) },
      injectTo: 'head',
    }])
    expect(hook.handler('', {})).toBeUndefined()
  })

  it('is part of the real build', () => {
    const names = (viteConfig.plugins ?? []).flat().map(p => (p && typeof p === 'object' && 'name' in p ? p.name : ''))
    expect(names).toContain('aurora-build-id')
  })
})
