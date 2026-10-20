// The band's pictures are drawn in CSS px at their slot's real width: text
// and marks at their design size, only the bars' spans in percentages.
import { expect, test } from 'claude-code/testing'
import { agentRowSvg } from '../hooks/agent-rows'
import { mainRowSvg, turnSeed } from '../hooks/main-row'
import type { AgentRowModel, MainModel } from '../hooks/model'
import { rightZoneSvg } from '../hooks/ram-card'

const GiB = 1024 ** 3

const MAIN: MainModel = {
  mode: 'flow',
  title: 'Demo',
  ratio: 0.5,
  acceptedRatio: 0.5,
  isEstimate: false,
  runRatio: 0.75,
  ticks: 4,
  pill: 'Attività 2/4',
  right: '50%',
  ringPercent: 50,
  isDone: false,
  isAnimating: true,
} as unknown as MainModel

// Every look of the main row: flow (empty, small fill under the pill, half,
// estimate), working (indeterminate, estimated), finished, idle.
const LOOKS: [string, MainModel][] = [
  ['flow 0', { ...MAIN, ratio: 0, acceptedRatio: 0, runRatio: 0, right: '0%' }],
  ['flow under the pill', { ...MAIN, ratio: 0.08, acceptedRatio: 0, runRatio: 0.25, right: '~8%', isEstimate: true }],
  ['flow half', MAIN],
  ['flow estimate', { ...MAIN, ratio: 0.83, acceptedRatio: 0.75, runRatio: 1, right: '~83%', isEstimate: true }],
  ['flow complete', { ...MAIN, ratio: 1, acceptedRatio: 1, runRatio: 1, right: '100%', isDone: true }],
  ['working', { ...MAIN, mode: 'working', title: 'In lavoro', ratio: 0, acceptedRatio: 0, runRatio: 0, ticks: 0, pill: '2m', right: '5 tool' }],
  ['working estimated', { ...MAIN, mode: 'working', title: 'Read the code', ratio: 0.25, acceptedRatio: 0, runRatio: 0, ticks: 0, pill: 'Passo 1/2', right: '~25%', isEstimate: true }],
  ['idle done', { ...MAIN, mode: 'idle', title: 'Pronto', pill: '', ratio: 0, runRatio: 0, ticks: 0, right: '✓ Demo · ultimo turno 0:03 · 2 tool', isDone: true }],
  ['idle', { ...MAIN, mode: 'idle', title: 'Pronto', pill: '', ratio: 0, runRatio: 0, ticks: 0, right: '', isDone: false }],
]

const rootOf = (svg: string): string => svg.match(/^<svg[^>]*>/)?.[0] ?? ''

// Each nested <svg …preserveAspectRatio="none"> up to its own </svg> (none nests another).
const stretched = (svg: string): string[] => svg.match(/<svg [^>]*preserveAspectRatio="none"[^>]*>[\s\S]*?<\/svg>/g) ?? []

test('main row: width 100%, 30px tall, no root viewBox; no text in a stretched group; under 60k', () => {
  for (const [, m] of LOOKS) {
    for (const w of [300, 640, 1200, 1600]) {
      const svg = mainRowSvg(m, w, turnSeed(1_000, m), true)
      expect(rootOf(svg)).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="30">')
      // The only viewBoxes are the stretched insides', never the root's.
      expect(svg.match(/viewBox=/g)?.length ?? 0).toBe(stretched(svg).length)
      expect(svg.match(/preserveAspectRatio=/g)?.length ?? 0).toBe(stretched(svg).length)
      for (const s of stretched(svg)) {
        expect(s).not.toContain('<text')
        expect(s.slice(4)).not.toContain('<svg')
      }
      // Every text outside the stretched insides.
      const outside = stretched(svg).reduce((rest, s) => rest.replace(s, ''), svg)
      expect(outside.match(/<text/g)?.length ?? 0).toBe(svg.match(/<text/g)?.length ?? 0)
      // Text at its design size, in px: the title 15px/600, the right text 13px, the pill 12px.
      expect(svg).toContain('class="pbm-t" x="10" y="20.4" font-family=')
      expect(svg).toMatch(/class="pbm-t"[^>]*font-size="15" font-weight="600"/)
      if (m.right) expect(svg).toMatch(/class="pbm-m" x="100%" [^>]*font-size="13"/)
      if (m.mode !== 'idle') expect(svg).toMatch(/text-anchor="middle" [^>]*font-size="12" font-weight="600"/)
      expect(svg.length).toBeLessThan(60_000)
    }
  }
})

test('main row: the pill, cap and sparks sit in px around a zero-width anchor on the bar', () => {
  // Half: the pill ends at the fill head, 50% along the bar.
  const svg = mainRowSvg(MAIN, 640, 7)
  const anchors = svg.match(/<svg x="[\d.]+%" y="4" width="1" height="22" overflow="visible">/g) ?? []
  // The head (cap and sparks) and the pill.
  expect(anchors.length).toBe(2)
  expect(svg).toMatch(/overflow="visible"><rect x="-\d+" width="\d+" height="22" rx="11" fill="#[0-9a-f]{6}"\/><text /)
  // Working: the pill at the bar's left edge, the same share as the track's x.
  const work = mainRowSvg(LOOKS[5]![1], 640, 7)
  const trackX = work.match(/<rect class="pbm-k" x="([\d.]+%)"/)?.[1]
  expect(work).toContain(`<svg x="${trackX}" y="4" width="1" height="22" overflow="visible"><rect x="0" width=`)
})

const ROW = {
  id: 'a',
  title: 'Scout the repo',
  tier: 'medium',
  status: 'running',
  stat: '1/2',
  progress: 0.5,
  isContext: false,
  tokens: '12k',
  time: '2m',
} as unknown as AgentRowModel

test('agent row: width 100%, 18px tall, no viewBox; texts in px, the bar in percent', () => {
  for (const w of [200, 544, 1200]) {
    const svg = agentRowSvg(ROW, w, 'mid')
    expect(rootOf(svg)).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="18">')
    expect(svg).not.toContain('viewBox')
    expect(svg).not.toContain('preserveAspectRatio')
    expect(svg).toMatch(/class="pba-s" x="100%" [^>]*font-size="11"/)
    // A narrow row sheds its title and bar, as before.
    if (w > 200) {
      expect(svg).toMatch(/class="pba-t" x="31" y="13" font-family="[^"]*" font-size="12">/)
      expect(svg).toMatch(/class="pba-k" x="[\d.]+%" y="7" width="[\d.]+%" height="4" rx="2"\/>/)
    }
  }
})

test('right zone: width 100%, as tall as the column, no viewBox; the card in px at 50%', () => {
  for (const [w, h] of [[60, 30], [128, 48], [208, 66]] as const) {
    const svg = rightZoneSvg({ usedBytes: 8 * GiB, totalBytes: 16 * GiB }, null, w, h)
    expect(rootOf(svg)).toBe(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${h}" role="img" aria-label="RAM 8/16 GB">`)
    expect(svg).not.toContain('viewBox')
    expect(svg).not.toContain('preserveAspectRatio')
    expect(svg).toContain('font-size:11px')
    expect(svg).toContain('<svg x="50%" y="0" width="1" height="30" overflow="visible">')
  }
  // A narrow zone: the percent only, as before.
  expect(rightZoneSvg({ usedBytes: 8 * GiB, totalBytes: 16 * GiB }, null, 60, 30)).toContain('>50%</text>')
})
