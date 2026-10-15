// The main row of the band: one SVG on the desktop, one line on the terminal.
// savvy-progress's look (dot, title, rounded dithered track, pill at the fill
// head, muted right text), made livelier: the fill's violet → blue → teal
// gradient flows through the dithered cells, white shimmers and sparks sweep
// over it, and "working" sweeps a violet → pink → amber dithered segment.
// Every redraw (about once a second) gets a new seed, so twinkle phases,
// dither pattern, shimmer and sparks vary while every animation period
// divides 1s (the redraw never shows a jump). The title and the right text
// sit in fixed slots, so the bar width depends only on the row width.
// No `$` here.
import type { MainModel } from './model'
import { ACCENT, DONE, FONT, IDLE, fitText, mulberry32, noise, savvyClasses, strHash, textWidth, xml, type TerminalUi } from './shared'

export const MAIN_H = 30
/** The main dot's center x: the agent rows' tree trunk runs down from it. */
export const DOT_X = 5
const DOT_R = 3
/** Tree connectors: the accent at 0.55, 1.5px, round caps. */
export const BRANCH_COLOR = ACCENT
export const BRANCH_OPACITY = 0.55
export const BRANCH_W = 1.5

const BAR_H = 22
const BAR_R = BAR_H / 2
const CELL = 3
const ROWS = Math.floor(BAR_H / CELL)
const CELL_Y0 = (BAR_H - ROWS * CELL) / 2 + 0.5
const TITLE_X = 10
// Larger than the agent rows' 12/11px, so the main bar reads first.
const TITLE_SIZE = 15
const PILL_SIZE = 12
const RIGHT_SIZE = 13
const RIGHT_SLOT = 52
const BAR_GAP_L = 8
const BAR_GAP_R = 6
const BAR_MIN = 24

/** Flow fill: violet → blue → teal, spread over the full bar width. */
const FLOW_STOPS: [number, string][] = [
  [0, ACCENT],
  [0.5, '#378ADD'],
  [1, '#1D9E75'],
]
/** The same colors, cyclic, for the flowing (repeating) gradient. */
const FLOW_CYCLE: [number, string][] = [
  [0, ACCENT],
  [0.33, '#378ADD'],
  [0.66, '#1D9E75'],
  [1, ACCENT],
]
/** Working segment: violet → pink → amber. */
const WORK_STOPS: [number, string][] = [
  [0, ACCENT],
  [0.55, '#E36FB0'],
  [1, '#F5B731'],
]

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

const unit = (n: number): number => (Number.isFinite(n) ? clamp(n, 0, 1) : 0)

const hex = (c: string): number[] => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))

/** Two decimals, no trailing zeros, so the SVG stays short. */
const f2 = (n: number): string => String(Math.round(n * 100) / 100)

/** The gradient's color at `t` (0..1), so the pill matches the fill under it. */
const colorAt = (stops: [number, string][], t: number): string => {
  const u = unit(t)
  let lo: [number, string] = stops[0] ?? [0, ACCENT]
  let hi: [number, string] = lo
  for (const st of stops) {
    hi = st
    if (st[0] >= u) break
    lo = st
  }
  const k = hi[0] > lo[0] ? clamp((u - lo[0]) / (hi[0] - lo[0]), 0, 1) : 0
  const A = hex(lo[1])
  const B = hex(hi[1])
  return '#' + A.map((v, j) => Math.round(v + ((B[j] ?? v) - v) * k).toString(16).padStart(2, '0')).join('')
}

const gradient = (id: string, stops: [number, string][], x2: number, repeat = false): string =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${x2}" y2="0"${repeat ? ' spreadMethod="repeat"' : ''}>` +
  stops.map(([o, c]) => `<stop offset="${f2(o)}" stop-color="${c}"/>`).join('') +
  '</linearGradient>'

type Rand = () => number

/** Per-redraw random look: twinkle groups, dither offset. */
type Look = { groups: number; ox: number; oy: number }

/**
 * Dithered cells over columns [from, to), each kept when noise < density(c);
 * the noise is offset by the redraw's seed, so the pattern changes each
 * second. One `<path>` per twinkle group, cells written with relative moves
 * (`m3 0h2v2h-2z`) so the SVG stays small even on a wide bar.
 */
const cells = (from: number, to: number, cls: string, density: (c: number) => number, look: Look, size = 2, attrs = ''): string => {
  const G = look.groups
  const d: string[][] = Array.from({ length: G }, () => [])
  const last: (number[] | null)[] = Array.from({ length: G }, () => null)
  for (let r = 0; r < ROWS; r++) {
    for (let c = from; c < to; c++) {
      if (noise(c + look.ox, r + look.oy) >= density(c)) continue
      const g = Math.floor(noise(r + look.oy * 0.37, c + look.ox * 0.61) * G) % G
      const x = c * CELL + 1
      const y = f2(CELL_Y0 + r * CELL)
      const p = last[g]
      const box = `h${size}v${size}h-${size}z`
      if (p && p[1] === r) d[g]?.push(`m${x - (p[0] ?? 0)} 0${box}`)
      else d[g]?.push(`M${x} ${y}${box}`)
      last[g] = [x, r]
    }
  }
  return d.map((g, i) => (g.length ? `<path class="${cls}${i} pbm-an"${attrs} d="${g.join('')}"/>` : '')).join('')
}

/** Twinkle keyframes for each group: random period (.5s/1s), phase and floor. */
const twinkleCss = (cls: string, look: Look, rnd: Rand, lo: number, hi: number): string => {
  let css = ''
  for (let i = 0; i < look.groups; i++) {
    const per = rnd() < 0.35 ? 0.5 : 1
    const min = f2(lo + rnd() * (hi - lo))
    const delay = f2(-rnd() * per)
    css +=
      `.${cls}${i}{animation:${cls}${i}k ${per}s ease-in-out ${delay}s infinite}` +
      `@keyframes ${cls}${i}k{0%,100%{opacity:1}50%{opacity:${min}}}`
  }
  return css
}

/** Sparse at the start, dense toward the head. */
const ramp = (cols: number) => (c: number): number => 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)

/** Bright 2×2 cells near `headX` (in [lo, headX]), fading in and out at random. */
const sparks = (rnd: Rand, lo: number, headX: number, idx: { n: number }): { svg: string; css: string } => {
  const count = 3 + Math.floor(rnd() * 4)
  let svg = ''
  let css = ''
  const cLo = Math.max(0, Math.floor(lo / CELL))
  const cHi = Math.max(cLo, Math.floor(headX / CELL) - 1)
  for (let i = 0; i < count; i++) {
    const c = cLo + Math.floor(rnd() * (cHi - cLo + 1))
    const r = Math.floor(rnd() * ROWS)
    const per = rnd() < 0.5 ? 0.5 : 1
    const n = idx.n++
    const fill = rnd() < 0.6 ? '#ffffff' : '#e8e6ff'
    svg += `<rect class="pbm-sp${n} pbm-an" x="${c * CELL + 1}" y="${f2(CELL_Y0 + r * CELL)}" width="2" height="2" fill="${fill}"/>`
    css += `.pbm-sp${n}{animation:pbm-spk ${per}s ease-in-out ${f2(-rnd() * per)}s infinite}`
  }
  return { svg, css }
}

const SPARK_KF = '@keyframes pbm-spk{0%,100%{opacity:0}50%{opacity:1}}'

const REDUCED = '@media (prefers-reduced-motion: reduce){.pbm-an{animation:none!important}}'

const dotColor = (m: MainModel): string => (m.mode === 'idle' ? (m.isDone ? DONE : IDLE) : ACCENT)

/**
 * Fixed geometry for a row `width` px wide: the bar width depends only on
 * `width`, never on the texts.
 */
export const mainRowGeometry = (width: number): { W: number; titleSlot: number; barX: number; barW: number } => {
  const W = Math.max(1, Math.round(Number.isFinite(width) ? width : 180))
  const titleSlot = Math.round(clamp(W * 0.14, 70, 140))
  const barX = TITLE_X + titleSlot + BAR_GAP_L
  const barW = Math.max(BAR_MIN, W - barX - RIGHT_SLOT - BAR_GAP_R)
  return { W, titleSlot, barX, barW }
}

/**
 * The row's SVG, `width` × MAIN_H. With `hasBranch` (agent rows shown below)
 * a trunk runs from just below the dot down to the row's bottom edge.
 */
export function mainRowSvg(m: MainModel, width: number, seed = 0, hasBranch = false): string {
  const { W, titleSlot, barX: BAR_X, barW: BAR_W } = mainRowGeometry(width)
  const H = MAIN_H
  const y0 = (H - BAR_H) / 2
  const seedN = Number.isFinite(seed) ? Math.floor(seed) : 0
  const rnd = mulberry32((seedN ^ strHash(m.title)) >>> 0)
  const look: Look = { groups: 4 + Math.floor(rnd() * 3), ox: Math.floor(rnd() * 997), oy: Math.floor(rnd() * 991) }

  const title = fitText(m.title, TITLE_SIZE, titleSlot)
  const right = m.right ? fitText(m.right, RIGHT_SIZE, RIGHT_SLOT - 2) : ''

  // Pill: the label in a capsule inside the bar, at the fill head (flow) or
  // at the left (working); cut only when it would not fit the bar.
  const pillRoom = BAR_W * 0.7 - 16
  const pillText = m.pill && m.mode !== 'idle' && pillRoom >= 12 ? fitText(m.pill, PILL_SIZE, pillRoom / 1.08) : ''
  const pillW = pillText ? Math.min(BAR_W, Math.round(16 + textWidth(pillText, PILL_SIZE) * 1.08)) : 0

  let defs = ''
  let body = ''
  let pill = ''
  let css = ''
  const spIdx = { n: 0 }

  const pillSvg = (x: number, color: string): string =>
    `<rect x="${x}" width="${pillW}" height="${BAR_H}" rx="${BAR_R}" fill="${color}"/>` +
    `<text x="${f2(x + pillW / 2)}" y="${f2(BAR_H / 2 + 3.6)}" text-anchor="middle" font-family="${FONT}" font-size="${PILL_SIZE}" font-weight="600" fill="#ffffff">${xml(pillText)}</text>`

  if (m.mode === 'flow') {
    const ratio = unit(m.ratio)
    const fillW = Math.round(BAR_W * ratio)
    const runW = Math.round(BAR_W * Math.max(ratio, unit(m.runRatio)))
    const cols = Math.floor(fillW / CELL)
    // Flowing colors: a repeating gradient rect, one period wider than the
    // bar, slides left by one period in 1s, seen through the dithered cells (a mask).
    const P = Math.max(90, Math.round(BAR_W * (0.45 + rnd() * 0.3)))
    defs +=
      gradient('pbm-grad', FLOW_STOPS, BAR_W) +
      gradient('pbm-rep', FLOW_CYCLE, P, true) +
      '<linearGradient id="pbm-shine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity="0"/>' +
      '<stop offset="0.5" stop-color="#ffffff" stop-opacity="1"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>' +
      `<clipPath id="pbm-fclip"><rect width="${fillW}" height="${BAR_H}" rx="${BAR_R}"/></clipPath>` +
      `<mask id="pbm-cm" maskUnits="userSpaceOnUse" x="0" y="0" width="${BAR_W}" height="${BAR_H}"><g fill="#ffffff">${cells(0, cols, 'pbm-w', ramp(cols), look)}</g></mask>`
    css += twinkleCss('pbm-w', look, rnd, 0.15, 0.5)
    if (cols > 0) {
      body += `<g mask="url(#pbm-cm)"><rect class="pbm-fl pbm-an" width="${BAR_W + P}" height="${BAR_H}" fill="url(#pbm-rep)"/></g>`
      css += `.pbm-fl{animation:pbm-flow 1s linear infinite}@keyframes pbm-flow{from{transform:translateX(0px)}to{transform:translateX(${-P}px)}}`
    }
    // Handed to workers, not yet accepted: a faint second layer.
    const runCols = Math.floor(runW / CELL)
    if (runCols > cols) {
      body += `<g fill="url(#pbm-grad)" opacity="0.45">${cells(cols, runCols, 'pbm-w', () => 0.2, { ...look, ox: look.ox + 7 }, 1.7)}</g>`
    }
    if (fillW > 0) {
      // Shimmer: 1-2 soft white bands of random width, phase and strength,
      // sweeping over the filled part only, in 1s or 0.5s.
      const n = rnd() < 0.5 ? 1 : 2
      let sh = ''
      for (let i = 0; i < n; i++) {
        const w = Math.round(24 + rnd() * 36)
        const per = rnd() < 0.6 ? 1 : 0.5
        const op = f2(0.35 + rnd() * 0.35)
        sh += `<rect class="pbm-sh${i} pbm-an" x="${-w}" width="${w}" height="${BAR_H}" fill="url(#pbm-shine)" opacity="${op}"/>`
        css +=
          `.pbm-sh${i}{animation:pbm-sh${i}k ${per}s linear ${f2(-rnd() * per)}s infinite}` +
          `@keyframes pbm-sh${i}k{from{transform:translateX(0px)}to{transform:translateX(${fillW + w}px)}}`
      }
      body += `<g clip-path="url(#pbm-fclip)">${sh}</g>`
      // Sparks near the fill head (left of the pill).
      const headX = pillText ? Math.max(CELL * 2, fillW - pillW) : fillW
      const sp = sparks(rnd, headX - 48, headX, spIdx)
      body += sp.svg
      css += sp.css + SPARK_KF
    }
    // Tick marks between tasks, only past the fill, only when they fit.
    const total = Number.isFinite(m.ticks) ? Math.floor(m.ticks) : 0
    if (total > 1 && total * 6 <= BAR_W) {
      const d: string[] = []
      for (let i = 1; i < total; i++) {
        const x = Math.round((BAR_W * i) / total)
        if (x > fillW + 4) d.push(`M${x} ${BAR_H / 2 - 5}h1.5v10h-1.5z`)
      }
      if (d.length) body += `<path class="pbm-tk" d="${d.join('')}"/>`
    }
    if (pillText) {
      const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
      pill = pillSvg(pillX, colorAt(FLOW_STOPS, (pillX + pillW / 2) / BAR_W))
    }
  } else if (m.mode === 'working') {
    // Indeterminate: a dithered segment (22-38% of the bar) with a faint ghost
    // trailing it sweeps across in exactly 1s; the direction alternates with
    // the seed's parity, so consecutive redraws ping-pong. The gradient lives
    // in the segment's own space (stops jittered), so its colors travel with it.
    const segW = Math.max(12, Math.round(BAR_W * (0.22 + rnd() * 0.16)))
    const cols = Math.floor(segW / CELL)
    const ghostW = Math.max(CELL * 3, Math.round(segW * (0.35 + rnd() * 0.25)))
    const ghostCols = Math.floor(ghostW / CELL)
    const gap = CELL * (1 + Math.floor(rnd() * 3))
    const j = (): number => (rnd() * 2 - 1) * 0.08
    const stops: [number, string][] = [
      [clamp(0.04 + j() / 2, 0, 0.12), ACCENT],
      [clamp(0.55 + j(), 0.3, 0.8), '#E36FB0'],
      [clamp(0.96 + j() / 2, 0.88, 1), '#F5B731'],
    ]
    defs += gradient('pbm-wgrad', stops, segW) + gradient('pbm-ggrad', [[0, ACCENT], [1, '#E36FB0']], ghostW)
    css += twinkleCss('pbm-w', look, rnd, 0.15, 0.5)
    const ghostLook: Look = { ...look, ox: look.ox + 13 }
    const seg =
      `<g transform="translate(${-ghostW - gap},0)" fill="url(#pbm-ggrad)" opacity="0.32">${cells(0, ghostCols, 'pbm-w', c => 0.15 + 0.4 * (c / Math.max(1, ghostCols)), ghostLook)}</g>` +
      `<g fill="url(#pbm-wgrad)">${cells(0, cols, 'pbm-w', c => 0.3 + 0.65 * Math.pow(c / Math.max(1, cols), 1.2), look)}</g>`
    const sp = sparks(rnd, segW - 30, segW, spIdx)
    const travel = segW + ghostW + gap
    const reverse = (seedN & 1) === 1
    const inner = `<g class="pbm-sw pbm-an">${seg}${sp.svg}</g>`
    body += reverse ? `<g transform="translate(${BAR_W},0) scale(-1,1)">${inner}</g>` : inner
    css +=
      sp.css +
      SPARK_KF +
      '.pbm-sw{animation:pbm-sweep 1s linear infinite}' +
      `@keyframes pbm-sweep{from{transform:translateX(${-segW}px)}to{transform:translateX(${BAR_W + travel - segW}px)}}`
    if (pillText) pill = pillSvg(0, ACCENT)
  } else if (m.isDone) {
    // Idle after a finished flow: green dither with a slow, faint glow at a random phase.
    const cols = Math.floor(BAR_W / CELL)
    body += `<g fill="${DONE}">${cells(0, cols, 'pbm-g', ramp(cols), look)}</g>`
    for (let i = 0; i < look.groups; i++) {
      css += `.pbm-g${i}{animation:pbm-glow 4s ease-in-out ${f2(-rnd() * 4)}s infinite}`
    }
    css += '@keyframes pbm-glow{0%,100%{opacity:1}50%{opacity:.82}}'
  }

  const textY = f2(H / 2 + TITLE_SIZE * 0.36)
  const rightY = f2(H / 2 + RIGHT_SIZE * 0.36)
  const rightText = right
    ? `<text class="pbm-m" x="${W - 1}" y="${rightY}" text-anchor="end" font-family="${FONT}" font-size="${RIGHT_SIZE}" font-variant-numeric="tabular-nums" style="font-variant-numeric:tabular-nums">${xml(right)}</text>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>${savvyClasses('pbm')}${css}${REDUCED}</style>
<defs><clipPath id="pbm-clip"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_R}"/></clipPath>${defs}</defs>
<circle cx="${DOT_X}" cy="${H / 2}" r="${DOT_R}" fill="${dotColor(m)}"/>
${hasBranch ? `<path class="pbm-br" d="M${DOT_X} ${H / 2 + DOT_R + 2}V${H}" fill="none" stroke="${BRANCH_COLOR}" stroke-opacity="${BRANCH_OPACITY}" stroke-width="${BRANCH_W}" stroke-linecap="round"/>` : ''}
<text class="pbm-t" x="${TITLE_X}" y="${textY}" font-family="${FONT}" font-size="${TITLE_SIZE}" font-weight="600">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="pbm-k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_R}"/>
<g clip-path="url(#pbm-clip)">${body}</g>
${pill}
</g>
${rightText}
</svg>`
}

const len = (s: string): number => [...s].length

/** The terminal bar, savvy's `█░` band. */
const barText = (m: MainModel, width: number): string => {
  if (m.mode === 'working') {
    const seg = Math.min(3, width)
    return '█'.repeat(seg) + '░'.repeat(width - seg)
  }
  const ratio = m.mode === 'flow' ? unit(m.ratio) : m.isDone ? 1 : 0
  const filled = clamp(Math.round(width * ratio), 0, width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const TERM_TITLE = 14
const TERM_RIGHT = 6

export function mainRowTerminal(ui: TerminalUi, m: MainModel, cols: number): JSX.Element {
  const { Box, Text } = ui
  const done = m.mode === 'idle' && m.isDone
  const idle = m.mode === 'idle' && !m.isDone
  const color = done ? DONE : idle ? undefined : ACCENT
  const total = Math.max(12, Math.floor(Number.isFinite(cols) ? cols : 80))
  // Fixed slots, as on the desktop: title up to 14 cols, right text up to 6,
  // so the bar width does not follow the texts' length.
  const pillW = m.pill ? len(m.pill) : 0
  // Dot (2) plus the gaps between title, bar, label (when shown) and right text, plus one spare.
  const fixed = m.pill ? 6 + pillW : 5
  const rightW = m.right ? TERM_RIGHT : 0
  const titleW = Math.max(Math.min(4, TERM_TITLE), Math.min(TERM_TITLE, total - fixed - 6 - rightW))
  const barW = clamp(total - fixed - titleW - rightW, 6, 40)

  return (
    <Box flexDirection="row" gap={1}>
      <Box flexDirection="row" flexShrink={0}>
        <Text color={color} dimColor={idle}>
          ●{' '}
        </Text>
        <Box width={titleW}>
          <Text wrap="truncate-end">{m.title}</Text>
        </Box>
      </Box>
      <Box flexShrink={0}>
        <Text color={color} dimColor={idle}>
          {barText(m, barW)}
        </Text>
      </Box>
      {m.pill ? (
        <Box flexShrink={0}>
          <Text bold>{m.pill}</Text>
        </Box>
      ) : null}
      {rightW > 0 ? (
        <Box width={rightW} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {m.right}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
