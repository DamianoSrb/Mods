// The RAM card beside the main bar: one small SVG on the desktop, one short
// line on the terminal. savvy-progress look (track card, muted label, load
// colored mini bar, tabular figures). No `$` here.
import { fmtRamPair, ramColor, ramRatio, type RamInfo } from './ram'
import { fitText, fluidSvgOpen, textWidth, xml, type TerminalUi } from './shared'

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
 * What a reader is told of the RAM figures (an Svg's alt, an aria-label):
 * always short, never the reason a reading failed. `RAM 9.8/16 GB`, `RAM ?`
 * after a failure, `RAM` before any reading.
 */
export function ramAltText(r: RamInfo | null, error: string | null = null): string {
  return r ? `RAM ${fmtRamPair(r)}` : error ? 'RAM ?' : 'RAM'
}

// The card's elements, without an <svg> wrapper or its <style>: drawn at the
// origin, `w` × `h`. Shared by the standalone card and the right zone.
function ramCardBody(r: RamInfo | null, w: number, h: number, isPercentOnly: boolean, error: string | null): string {
  const cy = h / 2
  const baseline = (cy + 4).toFixed(1)
  const hasIcon = w >= ICON_MIN_W && !isPercentOnly
  const barX = hasIcon ? PAD + GLYPH_W + 6 : PAD
  const textR = w - PAD
  const head =
    `<rect id="pbram-card" class="k" x="0" y="0" width="${w}" height="${h}" rx="6"/>` + (hasIcon ? glyph(cy) : '')
  if (!r) return `${head}<text id="pbram-label" class="s" x="${barX}" y="${baseline}">${error ? 'RAM ?' : 'RAM –'}</text>`

  const ratio = ramRatio(r)
  if (w < PAIR_MIN_W || isPercentOnly) {
    // Only the percent, centred and colored by load.
    const pct = `${Math.round(ratio * 100)}%`
    return (
      head +
      `<text id="pbram-text" x="${(w / 2).toFixed(1)}" y="${baseline}" text-anchor="middle" fill="${ramColor(ratio)}">${xml(pct)}</text>`
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
    `<text id="pbram-text" class="t" x="${textR}" y="${baseline}" text-anchor="end">${xml(label)}</text>`
  )
}

/**
 * The desktop card, `width` × `height` (RAM_CARD_W × RAM_CARD_H by default):
 * chip icon, a load bar taking the free space, `9.8/16 GB`. Under ~110px it
 * drops the icon, under ~80px (or with `isPercentOnly`) it shows only the
 * percent; "RAM –" with no reading yet, "RAM ?" when `error` is set and there
 * is no reading (its aria-label stays short: ramAltText).
 */
export function ramCardSvg(
  r: RamInfo | null,
  width = RAM_CARD_W,
  height = RAM_CARD_H,
  isPercentOnly = false,
  error: string | null = null,
): string {
  const w = Math.max(24, Math.round(width))
  const h = Math.max(14, Math.round(height))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${w} ${h}" role="img" aria-label="${xml(ramAltText(r, error))}">` +
    STYLE +
    ramCardBody(r, w, h, isPercentOnly, error) +
    '</svg>'
  )
}

const TERM_BAR = 5

/** The terminal line: `RAM ▕███░░▏ 9.8/16 GB`, the bar colored by load; `RAM ?` after a failed probe, `RAM –` before any. */
export function ramCardTerminal(ui: TerminalUi, r: RamInfo | null, error: string | null = null): JSX.Element {
  const { Text } = ui
  if (!r) return <Text dimColor>{error ? 'RAM ?' : 'RAM –'}</Text>
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

// The right zone's divider: light/dark colors that stay visible on either band background.
const ZONE_STYLE =
  '<style>.pbz-l{stroke:#c8c7c2}@media (prefers-color-scheme: dark){.pbz-l{stroke:#5c5b57}}</style>'
// Where the card's area starts, right of the divider.
const ZONE_LEFT = 8
const ZONE_CARD_MAX = 160

/**
 * The desktop band's right zone, designed at `width` × `height` (a viewBox
 * only: the surface scales it to the zone's real width, the height following):
 * a 1px divider down its left edge (the whole band tall) and the RAM card,
 * centered in the area right of the divider and top-aligned with the main bar
 * (RAM_CARD_H tall).
 *
 * One <svg> only: the card's elements sit in a translated <g>, its style at
 * the root (a nested <svg> is not drawn by every surface).
 */
export function rightZoneSvg(r: RamInfo | null, error: string | null, width: number, height: number): string {
  const w = Math.max(ZONE_LEFT + 24, Math.round(width))
  const h = Math.max(RAM_CARD_H, Math.round(height))
  const area = w - ZONE_LEFT
  const cardW = Math.max(24, Math.min(ZONE_CARD_MAX, area - 8))
  const cardX = ZONE_LEFT + Math.round((area - cardW) / 2)
  return (
    fluidSvgOpen(w, h, ` role="img" aria-label="${xml(ramAltText(r, error))}"`) +
    ZONE_STYLE +
    STYLE +
    `<line id="pbz-line" class="pbz-l" x1="0.5" y1="2" x2="0.5" y2="${h - 2}" stroke-width="1"/>` +
    `<g id="pbz-card" transform="translate(${cardX},0)">` +
    ramCardBody(r, cardW, RAM_CARD_H, false, error) +
    '</g>' +
    '</svg>'
  )
}
