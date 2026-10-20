import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'
import { agentRowSvg } from '../hooks/agent-rows'
import { mainRowSvg } from '../hooks/main-row'
import type { AgentRowModel, MainModel } from '../hooks/model'

const IT = { options: { language: 'it' } }

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

// Each spawn gets its own agent id, so the band shows one row per agent.
function world(on: On): void {
  mock.clock(on, { now: 1_000 })
  let n = 0
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_, e) => ({ value: { tool: `mcp__progress-bar__${e.name}` } }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: `agent-${++n}` }))
}

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

const spawn = ($: Engine, i: number) =>
  $.agent.spawn({
    prompt: 'Look around.',
    description: `Agent ${i}`,
    subagentType: 'savvy-flow:savvy-light',
    tool_use_id: `toolu_${i}`,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })

type Surface = 'terminal' | 'desktop'
const expandedBand = async ($: Engine, surface: Surface, props: Partial<typeof PROPS> = {}): Promise<Mounted<Surface, 'AbovePrompt'>> => {
  await start($)
  const ui = await $.ui.mount({ plugin: 'progress-bar', surface, component: 'AbovePrompt', props: { ...PROPS, ...props } })
  for (const i of [1, 2, 3]) await spawn($, i)
  await ui.redraw()
  await ui.press({ key: 'agents' })
  return ui
}

const svgSources = (text: string): string[] =>
  (text.match(/"source":"<svg.*?<\/svg>/g) ?? []).map(s => s.replace(/\\"/g, '"'))

const TRUNK = /class="pbm-br" d="M5 \d+(\.\d+)?V30"/
const MID = /class="pba-br" d="M5 0V18"/
const LAST = /class="pba-br" d="M5 0V5"/
const CURVE = /d="M5 5Q5 9 9 9H16"/

test('expanded desktop band: main trunk, mid rows then a last row', IT, async ($, on) => {
  world(on)
  const ui = await expandedBand($, 'desktop')
  const srcs = svgSources(JSON.stringify(await ui.drawn()))
  const main = srcs.find(s => s.includes('pbm-k'))
  expect(main).toMatch(TRUNK)
  const rows = srcs.filter(s => s.includes('pba-'))
  expect(rows.length).toBe(3)
  expect(rows[0]).toMatch(MID)
  expect(rows[1]).toMatch(MID)
  expect(rows[2]).toMatch(LAST)
  expect(rows[2]).toMatch(CURVE)
  expect(rows[2]).not.toMatch(MID)

  // Collapsed: no rows, no trunk.
  await ui.press({ key: 'agents' })
  const collapsed = svgSources(JSON.stringify(await ui.drawn())).find(s => s.includes('pbm-k'))
  expect(collapsed).not.toMatch(TRUNK)
})

test('cut rows: the last shown row stays mid, the trunk goes on to +N', IT, async ($, on) => {
  world(on)
  const ui = await expandedBand($, 'desktop', { maxRows: 3 })
  const text = JSON.stringify(await ui.drawn())
  const rows = svgSources(text).filter(s => s.includes('pba-'))
  expect(rows.length).toBe(1)
  expect(rows[0]).toMatch(MID)
  expect(text).toContain('+2')
})

test('terminal rows start with ├─ and the last with └─', IT, async ($, on) => {
  world(on)
  const ui = await expandedBand($, 'terminal')
  const text = JSON.stringify(await ui.drawn())
  const marks = text.match(/[├└]─ /g) ?? []
  expect(marks).toEqual(['├─ ', '├─ ', '└─ '])
})

const row = (status: AgentRowModel['status']): AgentRowModel =>
  ({ id: status, title: 'T', tier: 'medium', status, stat: '1/2', progress: 0.5, isContext: false, tokens: '1k', time: '0:01' }) as AgentRowModel

test('elbow colors follow the status', () => {
  expect(agentRowSvg(row('running'), 600, 'mid')).toMatch(/d="M5 9H16" fill="none" stroke="#8f8cf4"/)
  expect(agentRowSvg(row('done'), 600, 'mid')).toMatch(/d="M5 9H16" fill="none" stroke="#5fbf8f"/)
  expect(agentRowSvg(row('failed'), 600, 'last')).toMatch(/H16" fill="none" stroke="#D0453F"/)
})

test('mainRowSvg draws the trunk only with hasBranch', () => {
  const m = { mode: 'idle', title: 'Pronto', pill: '', right: '', ratio: 0, runRatio: 0, ticks: 0, isDone: false } as unknown as MainModel
  expect(mainRowSvg(m, 600)).not.toContain('pbm-br')
  expect(mainRowSvg(m, 600, 0, true)).toMatch(TRUNK)
})

test('agentRowSvg draws no divider; its right text ends 4px short of the row', () => {
  const s = agentRowSvg(row('running'), 600, 'mid')
  expect(s).not.toContain('pba-sep')
  // Fluid: designed at 600 × 18, no width/height on the root.
  const root = s.match(/^<svg[^>]*>/)?.[0] ?? ''
  expect(root).toContain('viewBox="0 0 600 18"')
  expect(root).toContain('preserveAspectRatio="xMinYMin meet"')
  expect(root).not.toMatch(/\s(width|height)=/)
  expect(s).toMatch(/class="pba-s" x="596"/)
})

// The bar's fill: the colored rect drawn over the track (pba-k).
const barFill = (svg: string): string | undefined => svg.match(/class="pba-k"[^>]*\/><rect ([^>]*)\/>/)?.[1]

test('bar colors: done full green and failed red whatever the tier; running the tier, the accent for a non-savvy agent', () => {
  for (const tier of ['medium', 'other', 'heavy']) {
    const done = agentRowSvg({ ...row('done'), tier, progress: 1 }, 600, 'last')
    expect(barFill(done)).toContain('fill="#5fbf8f"')
    expect(done).not.toContain('#888780')
    // Full: the fill spans the whole track.
    const track = done.match(/class="pba-k" x="[^"]*" y="[^"]*" width="([^"]*)"/)?.[1]
    expect(barFill(done)).toContain(`width="${track}"`)
    const failed = agentRowSvg({ ...row('failed'), tier }, 600, 'last')
    expect(barFill(failed)).toContain('fill="#D0453F"')
    // A finished row's context fallback takes its status color, never grey.
    expect(barFill(agentRowSvg({ ...row('failed'), tier, isContext: true, stat: 'ctx 50%' }, 600, 'last'))).toContain('fill="#D0453F"')
  }
  expect(barFill(agentRowSvg(row('running'), 600, 'mid'))).toContain('fill="#378ADD"')
  const other = agentRowSvg({ ...row('running'), tier: 'other' }, 600, 'mid')
  expect(barFill(other)).toContain('fill="#8f8cf4"')
  expect(other).toMatch(/<circle class="pba-live" [^>]*fill="#8f8cf4"/)
  expect(other).not.toContain('#888780')
  // A running row's context fallback stays grey.
  expect(barFill(agentRowSvg({ ...row('running'), isContext: true }, 600, 'mid'))).toMatch(/^class="pba-m" /)
})

type TNode = { type?: unknown; props?: { color?: unknown; dimColor?: unknown }; children?: unknown[] }

// The terminal's bar: the Text whose only child is a run of █ (and ░), with its props.
const termBars = (n: unknown, out: TNode[] = []): TNode[] => {
  if (!n || typeof n !== 'object') return out
  const node = n as TNode
  const own = (node.children ?? []).filter(c => typeof c === 'string').join('')
  if (node.type === 'Text' && /^█+░*$|^░+$/.test(own)) out.push(node)
  for (const c of node.children ?? []) termBars(c, out)
  return out
}

test('a finished non-savvy agent: green bar on the desktop and on the terminal', IT, async ($, on) => {
  world(on)
  on('turn.complete', async (_, e) => ({ text: e.answer, usage: e.usage }))
  await start($)
  const desk = await $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const term = await $.ui.mount({ plugin: 'progress-bar', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await $.agent.spawn({
    prompt: 'Look around.',
    description: 'Explore the repo',
    subagentType: 'Explore',
    tool_use_id: 'toolu_1',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  await $.turn.complete({
    answer: 'done',
    durationMs: 1_000,
    isAborted: false,
    turnId: 'turn-1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  await desk.redraw()
  // One press opens the rows on every surface: the toggle is the plugin's shared state.
  await desk.press({ key: 'agents' })
  await desk.redraw()
  await term.redraw()
  const rowSvg = svgSources(JSON.stringify(await desk.drawn())).find(s => s.includes('pba-'))
  expect(barFill(rowSvg ?? '')).toContain('fill="#5fbf8f"')
  expect(rowSvg).not.toContain('#888780')
  const tree = await term.drawn()
  const text = JSON.stringify(tree)
  expect(text).toContain('Explore the repo')
  expect(text).not.toContain('#888780')
  // The main bar first, then the row's: full, in green.
  const bar = termBars(tree).at(-1)
  expect((bar?.children ?? []).join('')).not.toContain('░')
  expect(bar?.props?.color).toBe('#5fbf8f')
})
