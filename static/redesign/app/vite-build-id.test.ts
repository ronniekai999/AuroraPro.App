import { describe, expect, it } from 'vitest'
import { BUILD_ID_META_NAME, auroraBuildId, buildIdFromBundle } from './vite-build-id'
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

  it('ignores the HTML, which is what carries the id', () => {
    expect(buildIdFromBundle({ ...bundle, c: asset('index.html', '<html lang="en">') })).toBe(buildIdFromBundle(bundle))
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
