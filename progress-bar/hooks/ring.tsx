// The collapsed band: one ring, like a loader, with the percentage inside, in
// the main row's colors (violet → blue → teal progress, violet → pink → amber
// while working, green when done). Pure drawing, no `$`.
import type { MainModel } from './model'
import { ACCENT, DONE, FONT, savvyClasses, xml, type TerminalUi } from './shared'

export const RING_SIZE = 32

const C = RING_SIZE / 2 // center
const R = 14 // radius: 14 + 3/2 stroke fits in 16
const SW = 3 // stroke width
const CIRC = 2 * Math.PI * R

// Rotates a <g> around the ring's center, one full turn per second: the band
// redraws every second, so a 1s period keeps the motion seamless.
const RING_CSS =
  `<style>${savvyClasses('pbr')}` +
  `.pbr-spin{transform-box:view-box;transform-origin:${C}px ${C}px;animation:pbr-rot 1s linear infinite}` +
  '@keyframes pbr-rot{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
  '@media (prefers-reduced-motion: reduce){.pbr-spin{animation:none}}</style>'

// Gradients in the arc's own (pre-rotation) space, where the arc starts at
// (C+R, C) and runs clockwise: the colors follow the arc from its start.
const grad = (id: string, stops: [number, string][], x2: number, y2: number): string =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${C + R}" y1="${C}" x2="${x2}" y2="${y2}">` +
  stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('') +
  '</linearGradient>'

const FLOW_GRAD = grad('pbr-grad', [[0, ACCENT], [0.5, '#378ADD'], [1, '#1D9E75']], C - R, C)
const WORK_GRAD = grad('pbr-wgrad', [[0, ACCENT], [0.55, '#E36FB0'], [1, '#F5B731']], C, C + R)

const circle = (attrs: string): string =>
  `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke-width="${SW}" ${attrs}/>`

/** An arc from 12 o'clock clockwise covering `frac` (0..1) of the circle. */
const arc = (frac: number, stroke: string, extra = ''): string => {
  const f = Math.max(0, Math.min(1, frac))
  if (f <= 0) return ''
  const dash = f >= 1 ? '' : ` stroke-dasharray="${(CIRC * f).toFixed(2)} ${CIRC.toFixed(2)}"`
  return circle(`stroke="${stroke}" stroke-linecap="round"${dash} transform="rotate(-90 ${C} ${C})"${extra}`)
}

const spin = (inner: string): string => `<g class="pbr-spin">${inner}</g>`

const label = (text: string, cls: string): string =>
  `<text x="${C}" y="${C}" text-anchor="middle" dominant-baseline="central" font-size="${text.length > 2 ? 9 : 11}" font-weight="700"` +
  ` font-family="${FONT}" class="${cls}">${xml(text)}</text>`

/** The ring, drawn `size` px square (its viewBox stays RING_SIZE). */
export function ringSvg(m: MainModel, size = RING_SIZE): string {
  let defs = ''
  let body = circle('class="pbr-ks"')
  let text: string
  let textCls: string

  if (m.isDone) {
    body += arc(1, DONE)
    text = `${m.ringPercent ?? 100}`
    textCls = 'pbr-t'
  } else if (m.mode === 'flow' && m.ringPercent !== null) {
    defs = FLOW_GRAD
    body += arc(m.ringPercent / 100, 'url(#pbr-grad)')
    body += spin(arc(0.08, ACCENT, ' stroke-opacity="0.35"'))
    text = `${m.ringPercent}`
    textCls = 'pbr-t'
  } else if (m.mode === 'working') {
    defs = WORK_GRAD
    body += spin(arc(0.25, 'url(#pbr-wgrad)'))
    text = '–'
    textCls = 'pbr-m'
  } else {
    text = '–'
    textCls = 'pbr-m'
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">` +
    RING_CSS +
    (defs ? `<defs>${defs}</defs>` : '') +
    body +
    label(text, textCls) +
    `</svg>`
  )
}

const quarter = (p: number): string => (p <= 12 ? '○' : p < 38 ? '◔' : p < 63 ? '◑' : p < 88 ? '◕' : '●')

export function ringTerminal(ui: TerminalUi, m: MainModel): JSX.Element {
  const { Text } = ui
  if (m.isDone) return <Text color={DONE}>{`● ${m.ringPercent ?? 100}%`}</Text>
  if (m.mode === 'flow' && m.ringPercent !== null)
    return <Text color={ACCENT}>{`${quarter(m.ringPercent)} ${m.ringPercent}%`}</Text>
  if (m.mode === 'working') return <Text color={ACCENT}>{'◌ …'}</Text>
  return <Text dimColor>{'○'}</Text>
}
