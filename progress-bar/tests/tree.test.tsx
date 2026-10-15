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

test('agentRowSvg without sepX draws no divider; with sepX it ends content before it', () => {
  expect(agentRowSvg(row('running'), 600, 'mid')).not.toContain('pba-sep')
  const s = agentRowSvg(row('running'), 600, 'mid', 450)
  expect(s).toContain('width="600" height="18"')
  expect(s).toContain('<rect class="pba-sep" x="450" y="0" width="1" height="18"/>')
  expect(s).toMatch(/class="pba-s" x="440"/)
})
