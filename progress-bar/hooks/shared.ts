// Shared strings, language detection and drawing helpers. The helpers below
// `xml` are copied from savvy-progress's band so the two look alike.
import type { Elements } from 'claude-code'

/** The element table `$.ui.resolve(e)` returns on the terminal surface. */
export type TerminalUi = Elements['terminal']

export type Lang = 'it' | 'en'

export const STRINGS = {
  it: {
    working: 'In lavoro',
    idle: 'Pronto',
    plan: 'Piano',
    design: 'Design',
    tasks: 'Attività',
    review: 'Revisione',
    lastTurn: 'ultimo turno',
    tool: 'tool',
    tools: 'tool',
    agent: 'agente',
    agents: 'agenti',
    activeOne: 'attivo',
    active: 'attivi',
    more: 'altri',
    tok: 'tok',
  },
  en: {
    working: 'Working',
    idle: 'Ready',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    lastTurn: 'last turn',
    tool: 'tool',
    tools: 'tools',
    agent: 'agent',
    agents: 'agents',
    activeOne: 'active',
    active: 'active',
    more: 'more',
    tok: 'tok',
  },
} as const

export type Strings = { readonly [K in keyof (typeof STRINGS)['it']]: string }

const isItalian = (v: unknown): boolean => typeof v === 'string' && /^(it|ital)/i.test(v.trim())

/**
 * The language from what `detectLang` (register.tsx) gathered: the `language`
 * option when it is `it` or `en`; on `auto`, Claude Code's `language` setting,
 * then the locale (LC_ALL / LC_MESSAGES / LANG). Italian when the value starts
 * with "it" or "ital", English otherwise. Pure: `$` never crosses an import.
 */
export function pickLang(option: unknown, setting: unknown, locale: unknown): Lang {
  if (option === 'it' || option === 'en') return option
  if (typeof setting === 'string' && setting.trim()) return isItalian(setting) ? 'it' : 'en'
  return isItalian(locale) ? 'it' : 'en'
}

// ---------------------------------------------------------------------------
// MyDesign (minimal) tokens.

export const MD_FONT = '"Museo Sans","Nunito Sans",Verdana,sans-serif'
export const MD_NUM_FONT = 'Industry,Barlow,Verdana,sans-serif'

// [name, light, dark]
const MD_COLORS: [string, string, string][] = [
  ['page', '#F5F5F5', '#111314'],
  ['surface', '#FFFFFF', '#1A1D1F'],
  ['muted', '#F2F5F5', '#2C3236'],
  ['ink', '#0A0A0A', '#F2F2F2'],
  ['ink-2', '#525252', '#B3B3B3'],
  ['ink-3', '#A3A3A3', '#8A8A8A'],
  ['line', '#D4D4D4', '#3A3F42'],
  ['line-soft', '#E5E5E5', '#2C3033'],
  ['primary', '#4B5458', '#9CAAB0'],
  ['on-primary', '#FFFFFF', '#0A0A0A'],
  ['status-online', '#5B852B', '#76A83A'],
  ['ok-ink', '#476625', '#93C255'],
  ['ko-ink', '#E22D20', '#FC776D'],
  ['timeline-fill', '#D5DBDD', '#3A4246'],
]

const MD_CLASSES =
  '.md-ink{fill:var(--ink)}.md-ink2{fill:var(--ink-2)}.md-ink3{fill:var(--ink-3)}' +
  '.md-track{fill:var(--line-soft)}.md-primary{fill:var(--primary)}.md-done{fill:var(--status-online)}' +
  '.md-ko{fill:var(--ko-ink)}.md-time{fill:var(--timeline-fill)}' +
  '.md-s-track{stroke:var(--line-soft)}.md-s-primary{stroke:var(--primary)}.md-s-done{stroke:var(--status-online)}' +
  '.md-s-ko{stroke:var(--ko-ink)}.md-s-ink3{stroke:var(--ink-3)}'

/**
 * One `<style>` for every SVG of the band: the MyDesign color tokens as CSS
 * custom properties on the svg root (light values, dark overrides under
 * `prefers-color-scheme: dark`), the md-* utility classes, reduced motion,
 * then `extra` appended.
 */
export function mdStyle(extra?: string): string {
  const light = MD_COLORS.map(([n, l]) => `--${n}:${l}`).join(';')
  const dark = MD_COLORS.map(([n, , d]) => `--${n}:${d}`).join(';')
  return (
    `<style>svg{${light}}` +
    `@media (prefers-color-scheme: dark){svg{${dark}}}` +
    MD_CLASSES +
    '@media (prefers-reduced-motion: reduce){*{animation:none!important}}' +
    (extra ?? '') +
    '</style>'
  )
}

/** 950 → "950", 12_400 → "12k", 1_250_000 → "1.3M". */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0
  if (v < 1000) return String(Math.round(v))
  if (v < 999_500) return `${Math.round(v / 1000)}k`
  const m = v / 1_000_000
  return m < 9.95 ? `${m.toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(m)}M`
}

export const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Rough advance of system UI text, in em; good enough to size a slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZÀ-ÝmwМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

export const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

/** Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut. */
export const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

/** m:ss, or h:mm:ss past an hour; negative counts as zero. */
export const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const TIERS = new Set(['fable', 'heavy', 'careful', 'medium', 'light'])

/** `savvy-careful`, or `savvy-flow:savvy-careful` when the agents ship in a plugin. */
export const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^savvy-/, '').toLowerCase()
  return TIERS.has(t) &&bare.startsWith('savvy-') ? t : 'other'
}

// ---------------------------------------------------------------------------
// savvy-progress palette and font, the band's current look.

export const ACCENT = '#8f8cf4'
export const DONE = '#5fbf8f'
export const IDLE = '#9a9a96'
export const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

export const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

export const colorOf = (tier: string): string => TIER_COLOR[tier] ?? "#888780"

// savvy-progress's text / track colors: [class, light, dark]. The band's set
// (main row, ring) and the agents pane's set (agent rows) differ slightly.
const K_BAND = ["#e4e4e2", "#2c2c2c"] as const
const K_PANE = ["#ecebe8", "#2c2c2b"] as const
const BAND_TONES: [string, string, string][] = [
  ['t', '#1f1f1f', '#ececec'],
  ['s', '#6b6b68', '#a8a8a4'],
  ['m', '#8a8a8a', '#9a9a9a'],
  ['k', '#e4e4e2', '#2c2c2c'],
  ['tk', '#b4b4b0', '#5a5a5a'],
]
const PANE_TONES: [string, string, string][] = [
  ['t', '#1f1f1f', '#ececec'],
  ['s', '#6b6b68', '#a8a8a4'],
  ['m', '#9a9a96', '#7d7d79'],
  ['k', '#ecebe8', '#2c2c2b'],
  ['tk', '#b4b4b0', '#5a5a5a'],
]

/**
 * savvy's .t .s .m .k .tk fill classes, prefixed (`pbm-t`, ...) so SVGs of
 * different modules never clash, plus `<prefix>-ks`: a stroke in the .k color.
 * Light values, dark overrides under prefers-color-scheme.
 */
export function savvyClasses(prefix: string, set: 'band' | 'pane' = 'band'): string {
  const tones = set === 'pane' ? PANE_TONES : BAND_TONES
  const k = set === 'pane' ? K_PANE : K_BAND
  const rules = (dark: boolean): string =>
    tones.map(([n, l, d]) => `.${prefix}-${n}{fill:${dark ? d : l}}`).join('') +
    `.${prefix}-ks{stroke:${dark ? k[1] : k[0]}}`
  return rules(false) + `@media (prefers-color-scheme: dark){${rules(true)}}`
}

/** Deterministic noise so the dither does not shimmer between redraws. */
export const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

/** Small seeded PRNG (mulberry32): returns a function yielding floats in [0, 1). */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a hash of a string, as an unsigned 32-bit integer. */
export const strHash = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h >>> 0
}
