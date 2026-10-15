// One row per agent under the main row: one SVG on the desktop, one line on the terminal.
// savvy-progress's agents-pane colors: the tier colors the running dot and the
// bar, a green check / red cross marks the end, the context fallback is grey.
import type { AgentRowModel } from './model'
import { BRANCH_COLOR, BRANCH_OPACITY, BRANCH_W, DOT_X } from './main-row'
import { FONT, colorOf, fitText, savvyClasses, textWidth, xml, type TerminalUi } from './shared'

/** Where a row hangs on the tree: 'mid' (├─, the trunk goes on) or 'last' (└─). */
export type Branch = 'mid' | 'last'

export const AGENT_ROW_H = 18

const ROW_CSS =
  `<style>${savvyClasses('pba', 'pane')}` +
  '.pba-live{animation:pba-pulse 1s ease-in-out infinite}@keyframes pba-pulse{50%{opacity:.3}}' +
  '@media (prefers-reduced-motion: reduce){.pba-live{animation:none}}</style>'

const OK = '#3B9C5F'
const KO = '#D0453F'

// Geometry of a row, left to right: the trunk under the main dot, the elbow
// out to ELBOW_X, then the status mark, title, bar and right text.
const INDENT = 16
const ELBOW_X = 16
const CORNER_R = 4
const MARK_X = 22
const TITLE_X = 31
const GAP = 10
const BAR_MIN = 60
const BAR_H = 4
const MID_Y = AGENT_ROW_H / 2
const TEXT_Y = 13

// The right slot is at least this wide so bars line up from row to row.
const RIGHT_MIN = textWidth('ctx 100% · 999k tok · 00:00', 11)

const statusMark = (status: AgentRowModel['status'], color: string): string => {
  const x = MARK_X
  const y = MID_Y
  if (status === 'running') return `<circle class="pba-live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done')
    return `<path d="M${x - 4.5} ${y}l3 3 6-6.5" fill="none" stroke="${OK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  return `<path d="M${x - 3.5} ${y - 3.5}l7 7M${x + 3.5} ${y - 3.5}l-7 7" fill="none" stroke="${KO}" stroke-width="1.8" stroke-linecap="round"/>`
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)

const rightText = (r: AgentRowModel): string => `${r.stat} · ${r.tokens} tok · ${r.time}`

const ELBOW_COLOR: Record<AgentRowModel['status'], string> = { running: BRANCH_COLOR, done: '#5fbf8f', failed: KO }

/**
 * The tree connector: the trunk (accent) at the main dot's x, spanning the
 * full row for 'mid' so consecutive rows join, down to the corner for 'last';
 * the elbow out to ELBOW_X in the status color.
 */
const branchSvg = (branch: Branch, status: AgentRowModel['status']): string => {
  const line = (d: string, color: string): string =>
    `<path class="pba-br" d="${d}" fill="none" stroke="${color}" stroke-opacity="${BRANCH_OPACITY}" stroke-width="${BRANCH_W}" stroke-linecap="round" stroke-linejoin="round"/>`
  const elbow = ELBOW_COLOR[status]
  if (branch === 'mid') return line(`M${DOT_X} 0V${AGENT_ROW_H}`, BRANCH_COLOR) + line(`M${DOT_X} ${MID_Y}H${ELBOW_X}`, elbow)
  const cy = MID_Y - CORNER_R
  return (
    line(`M${DOT_X} 0V${cy}`, BRANCH_COLOR) +
    line(`M${DOT_X} ${cy}Q${DOT_X} ${MID_Y} ${DOT_X + CORNER_R} ${MID_Y}H${ELBOW_X}`, elbow)
  )
}

/**
 * One agent row, `width` × AGENT_ROW_H; the right text ends 4px short of the
 * row's right edge. On the desktop the rows sit in the column left of the divider.
 */
export function agentRowSvg(r: AgentRowModel, width: number, branch: Branch = 'last'): string {
  const W = Math.max(INDENT + 40, Math.round(width))
  const color = colorOf(r.tier)
  const right = rightText(r)
  const rightW = Math.ceil(Math.max(RIGHT_MIN, textWidth(right, 11)))
  const rightX = W - 4
  // Title slot: ~35% of the content, shrunk when the bar would fall under its minimum.
  const room = rightX - rightW - GAP - TITLE_X - GAP
  const titleSlot = Math.max(0, Math.min(Math.round((rightX + 2) * 0.35), room - BAR_MIN))
  const barX = TITLE_X + titleSlot + GAP
  const barW = Math.max(0, rightX - rightW - GAP - barX)
  const fillW = Math.round(barW * clamp01(r.progress))
  const barY = MID_Y - BAR_H / 2
  const title = titleSlot > 12 ? fitText(r.title, 12, titleSlot) : ''
  // Without reported steps the bar falls back to the context, drawn grey.
  const fillPaint = r.isContext ? 'class="pba-m"' : `fill="${color}"`
  const fill = fillW > 0 ? `<rect ${fillPaint} x="${barX}" y="${barY}" width="${fillW}" height="${BAR_H}" rx="2"/>` : ''
  const body =
    branchSvg(branch, r.status) +
    statusMark(r.status, color) +
    (title
      ? `<text class="pba-t" x="${TITLE_X}" y="${TEXT_Y}" font-family="${FONT}" font-size="12">${xml(title)}</text>`
      : '') +
    (barW > 0 ? `<rect class="pba-k" x="${barX}" y="${barY}" width="${barW}" height="${BAR_H}" rx="2"/>${fill}` : '') +
    `<text class="pba-s" x="${rightX}" y="${TEXT_Y}" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums" style="font-variant-numeric:tabular-nums">${xml(right)}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${AGENT_ROW_H}" viewBox="0 0 ${W} ${AGENT_ROW_H}">${ROW_CSS}${body}</svg>`
}

const GLYPH: Record<AgentRowModel['status'], string> = { running: '●', done: '✓', failed: '✗' }

const cut = (s: string, max: number): string => {
  const chars = [...s]
  if (chars.length <= max) return s
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

export function agentRowTerminal(ui: TerminalUi, r: AgentRowModel, cols: number, branch: Branch = 'last'): JSX.Element {
  const { Text } = ui
  const color = colorOf(r.tier)
  const glyphColor = r.status === 'failed' ? 'red' : r.status === 'done' ? 'green' : color
  const right = rightText(r)
  // Fixed title and bar widths, so the bars line up from row to row.
  const titleW = Math.max(4, Math.floor(cols * 0.4))
  const title = cut(r.title, titleW).padEnd(titleW)
  const barW = Math.max(6, Math.min(20, cols - titleW - 34))
  const filled = Math.round(barW * clamp01(r.progress))
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barW - filled))
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{branch === 'mid' ? '├─ ' : '└─ '}</Text>
      <Text color={glyphColor}>{GLYPH[r.status]}</Text> {title}{' '}
      {r.isContext ? <Text dimColor>{bar}</Text> : <Text color={color}>{bar}</Text>} <Text dimColor>{right}</Text>
    </Text>
  )
}
