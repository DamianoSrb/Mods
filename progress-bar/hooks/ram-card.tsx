// The RAM card beside the main bar: one small SVG on the desktop, one short
// line on the terminal. savvy-progress look (track card, muted label, load
// colored mini bar, tabular figures). No `$` here.
import { fmtRamPair, ramColor, ramRatio, type RamInfo } from './ram'
import { fitText, textWidth, xml, type TerminalUi } from './shared'

export const RAM_CARD_W = 128
export const RAM_CARD_H = 30

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const PAD = 8
const GLYPH_W = 11
const GLYPH_H = 7
const MIN_BAR = 12
// Below these widths the card sheds the chip icon, then everything but the percent.
const ICON_MIN_W = 110
const PAIR_MIN_W = 80

const STYLE =
  '<style>' +
  '.k{fill:#ecebe8}.s{fill:#6b6b68}.ss{stroke:#6b6b68}.t{fill:#1f1f1f}.bt{fill:#dad8d3}' +
  '@media (prefers-color-scheme: dark){.k{fill:#2c2c2b}.s{fill:#a8a8a4}.ss{stroke:#a8a8a4}.t{fill:#ececec}.bt{fill:#3d3d3b}}' +
  `text{font-family:${FONT};font-size:11px;font-variant-numeric:tabular-nums}` +
  '</style>'

// A memory chip: a small outline with three pins above and below, its body centred on `cy`.
const glyph = (cy: number): string => {
  const x = PAD
  const y = Math.round((cy - GLYPH_H / 2) * 2) / 2
  const pins = [2.5, 5.5, 8.5]
    .map(dx => `M${x + dx} ${y - 2}v2M${x + dx} ${y + GLYPH_H + 1}v2`)
    .join('')
  return (
    `<rect class="ss" x="${x + 0.5}" y="${y + 0.5}" width="${GLYPH_W - 1}" height="${GLYPH_H}" rx="1.5" fill="none" stroke-width="1"/>` +
    `<path class="ss" d="${pins}" stroke-width="1" fill="none"/>`
  )
}

/**
 * The desktop card, `width` × `height` (RAM_CARD_W × RAM_CARD_H by default):
 * chip icon, a load bar taking the free space, `9.8/16 GB`. Under ~110px it
 * drops the icon, under ~80px (or with `isPercentOnly`) it shows only the
 * percent; "RAM –" with no reading.
 */
export function ramCardSvg(r: RamInfo | null, width = RAM_CARD_W, height = RAM_CARD_H, isPercentOnly = false): string {
  const w = Math.max(24, Math.round(width))
  const h = Math.max(14, Math.round(height))
  const cy = h / 2
  const baseline = (cy + 4).toFixed(1)
  const hasIcon = w >= ICON_MIN_W && !isPercentOnly
  const barX = hasIcon ? PAD + GLYPH_W + 6 : PAD
  const textR = w - PAD
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${w} ${h}" role="img" aria-label="${xml(r ? `RAM ${fmtRamPair(r)}` : 'RAM')}">` +
    STYLE +
    `<rect id="pbram-card" class="k" x="0" y="0" width="${w}" height="${h}" rx="6"/>` +
    (hasIcon ? glyph(cy) : '')
  if (!r) return `${head}<text id="pbram-label" class="s" x="${barX}" y="${baseline}">RAM –</text></svg>`

  const ratio = ramRatio(r)
  if (w < PAIR_MIN_W || isPercentOnly) {
    // Only the percent, centred and colored by load.
    const pct = `${Math.round(ratio * 100)}%`
    return (
      head +
      `<text id="pbram-text" x="${(w / 2).toFixed(1)}" y="${baseline}" text-anchor="middle" fill="${ramColor(ratio)}">${xml(pct)}</text>` +
      '</svg>'
    )
  }
  const maxText = textR - barX - MIN_BAR - 6
  const label = fitText(fmtRamPair(r), 11, maxText)
  const barW = Math.max(MIN_BAR, textR - textWidth(label, 11) - 6 - barX)
  const fillW = Math.round(barW * ratio * 10) / 10
  const barY = (cy - 2).toFixed(1)
  return (
    head +
    `<rect id="pbram-track" class="bt" x="${barX}" y="${barY}" width="${barW.toFixed(1)}" height="4" rx="2"/>` +
    (fillW > 0
      ? `<rect id="pbram-fill" x="${barX}" y="${barY}" width="${Math.max(2, fillW).toFixed(1)}" height="4" rx="2" fill="${ramColor(ratio)}"/>`
      : '') +
    `<text id="pbram-text" class="t" x="${textR}" y="${baseline}" text-anchor="end">${xml(label)}</text>` +
    '</svg>'
  )
}

const TERM_BAR = 5

/** The terminal line: `RAM ▕███░░▏ 9.8/16 GB`, the bar colored by load. */
export function ramCardTerminal(ui: TerminalUi, r: RamInfo | null): JSX.Element {
  const { Text } = ui
  if (!r) return <Text dimColor>RAM –</Text>
  const ratio = ramRatio(r)
  const n = Math.min(TERM_BAR, Math.max(0, Math.round(ratio * TERM_BAR)))
  const color = ramColor(ratio)
  return (
    <Text>
      <Text dimColor>RAM ▕</Text>
      {n ? <Text color={color}>{'█'.repeat(n)}</Text> : null}
      {n < TERM_BAR ? <Text dimColor>{'░'.repeat(TERM_BAR - n)}</Text> : null}
      <Text dimColor>▏ </Text>
      <Text color={color}>{fmtRamPair(r)}</Text>
    </Text>
  )
}
