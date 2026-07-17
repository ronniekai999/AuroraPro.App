// appearance.ts — pure-validator + option-list invariants.
//
// The normalize* helpers are the single source of truth for "is this
// stored value a real choice?" — shared by the getters AND main.tsx's
// pre-paint applyStoredAppearance. These tests pin the invariant that
// made the 2026-07-16 refactor worth doing: every id present in an
// option list MUST round-trip through its validator, so adding an
// option in one place but not the other fails CI instead of silently
// rendering the default for users who picked the new style.
//
// Node-environment only (no DOM/localStorage): the apply* functions are
// deliberately untested here.

import { describe, expect, it } from 'vitest'
import {
  FONT_OPTIONS,
  GLOW_OPTIONS,
  normalizeFont,
  normalizeGlow,
  normalizeGrain,
} from './appearance'

describe('normalizeFont', () => {
  it('accepts every option id, including velvet', () => {
    for (const opt of FONT_OPTIONS) {
      expect(normalizeFont(opt.id)).toBe(opt.id)
    }
  })

  it('falls back to nova for unknown / missing values', () => {
    expect(normalizeFont(undefined)).toBe('nova')
    expect(normalizeFont(null)).toBe('nova')
    expect(normalizeFont('')).toBe('nova')
    expect(normalizeFont('comic-sans')).toBe('nova')
    expect(normalizeFont(42)).toBe('nova')
  })
})

describe('normalizeGlow', () => {
  it('accepts every option id', () => {
    for (const opt of GLOW_OPTIONS) {
      expect(normalizeGlow(opt.id)).toBe(opt.id)
    }
  })

  it('falls back to aurora for unknown / missing values', () => {
    expect(normalizeGlow(undefined)).toBe('aurora')
    expect(normalizeGlow('neon')).toBe('aurora')
  })
})

describe('normalizeGrain', () => {
  it('accepts film and defaults everything else to off', () => {
    expect(normalizeGrain('film')).toBe('film')
    expect(normalizeGrain('off')).toBe('off')
    expect(normalizeGrain(undefined)).toBe('off')
    expect(normalizeGrain('heavy')).toBe('off')
    expect(normalizeGrain(true)).toBe('off')
  })
})

describe('FONT_OPTIONS', () => {
  it('has unique ids and non-empty preview stacks', () => {
    const ids = FONT_OPTIONS.map(o => o.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const opt of FONT_OPTIONS) {
      expect(opt.font.length).toBeGreaterThan(0)
      expect(opt.label.length).toBeGreaterThan(0)
    }
  })

  it('keeps nova first (the attribute-less default the UI leans on)', () => {
    expect(FONT_OPTIONS[0].id).toBe('nova')
  })

  it('offers velvet as an italic serif', () => {
    const velvet = FONT_OPTIONS.find(o => o.id === 'velvet')
    expect(velvet).toBeDefined()
    expect(velvet?.italic).toBe(true)
    expect(velvet?.font).toContain('Fraunces')
  })
})
