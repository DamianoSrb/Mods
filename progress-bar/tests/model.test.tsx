import { expect, test } from 'claude-code/testing'
import { agentsSummary, buildAgentRows, buildMainModel, type AgentRun, type Flow } from '../hooks/model'
import { STRINGS, fmtTokens, mdStyle } from '../hooks/shared'
import { mainRowSvg } from '../hooks/main-row'

const s = STRINGS.it

const FLOW: Flow = {
  title: 'Demo',
  total: 4,
  done: 1,
  running: 1,
  phase: 'delegate',
  isFinished: false,
  tasks: [],
}

const base = { flow: null, isWorking: false, startedAt: null, endedAt: null, tools: 0, now: 0 }

test('idle: title only, no pill, nothing on the right before any turn', () => {
  const m = buildMainModel(base, s)
  expect(m).toMatchObject({ mode: 'idle', title: 'Pronto', pill: '', right: '' })
})

test('idle after a turn and a finished flow', () => {
  const m = buildMainModel(
    { ...base, flow: { ...FLOW, isFinished: true }, startedAt: 0, endedAt: 65_000, tools: 3 },
    s,
  )
  expect(m.pill).toBe('')
  expect(m.right).toBe('✓ Demo · ultimo turno 1:05 · 3 tool')
})

test('working: elapsed time and tool count', () => {
  const m = buildMainModel({ ...base, isWorking: true, startedAt: 1_000, now: 6_000, tools: 2 }, s)
  expect(m).toMatchObject({ mode: 'working', title: 'In lavoro', pill: '0:05', right: '2 tool', isAnimating: true })
})

test('flow: phase pill, accepted and running fill', () => {
  const m = buildMainModel({ ...base, flow: FLOW, isWorking: true }, s)
  expect(m).toMatchObject({ mode: 'flow', title: 'Demo', pill: 'Attività 1/4', right: '25%', ticks: 4 })
  expect(m.ratio).toBe(0.25)
  expect(m.runRatio).toBe(0.5)
})

const run = (over: Partial<AgentRun>): AgentRun => ({
  id: 'a',
  agentId: 'a',
  type: 'savvy-flow:savvy-medium',
  description: 'Task',
  model: 'claude-opus-5-5',
  status: 'running',
  startedAt: 0,
  contextTokens: 100_000,
  contextMax: 1_000_000,
  tokens: 0,
  costUsd: 0,
  steps: 0,
  round: 1,
  ...over,
})

test('agent rows: running first, steps over context, done full', () => {
  const rows = buildAgentRows(
    [
      run({ id: 'old', status: 'done', endedAt: 5_000 }),
      run({ id: 'ctx', startedAt: 1_000 }),
      run({ id: 'steps', startedAt: 2_000, stepDone: 1, stepTotal: 4 }),
    ],
    10_000,
  )
  expect(rows.map(r => r.id)).toEqual(['steps', 'ctx', 'old'])
  expect(rows[0]).toMatchObject({ tier: 'medium', stat: '1/4', progress: 0.25, isContext: false, time: '0:08' })
  expect(rows[1]).toMatchObject({ stat: 'ctx 10%', isContext: true })
  expect(rows[2]).toMatchObject({ status: 'done', progress: 1, time: '0:05' })
})

test('ring percent and done flag', () => {
  expect(buildMainModel({ ...base, flow: FLOW }, s)).toMatchObject({ isDone: false, ringPercent: 25 })
  expect(buildMainModel({ ...base, isWorking: true }, s)).toMatchObject({ isDone: false, ringPercent: null })
  expect(buildMainModel(base, s)).toMatchObject({ isDone: false, ringPercent: null })
  expect(buildMainModel({ ...base, flow: { ...FLOW, isFinished: true } }, s)).toMatchObject({ isDone: true, ringPercent: 100 })
})

test('fmtTokens, agentsSummary and row tokens', () => {
  expect([950, 12_400, 1_250_000].map(fmtTokens)).toEqual(['950', '12k', '1.3M'])
  const list = [run({ id: 'x', tokens: 30_000 }), run({ id: 'y', status: 'done', tokens: 15_000 })]
  expect(agentsSummary(list)).toEqual({ count: 2, running: 1, tokens: 45_000 })
  expect(buildAgentRows(list, 0)[0]?.tokens).toBe('30k')
})

test('mdStyle carries light and dark tokens and extra css', () => {
  const css = mdStyle('.x{fill:red}')
  expect(css).toContain('--ink:#0A0A0A')
  expect(css).toContain('prefers-color-scheme: dark')
  expect(css).toContain('--ink:#F2F2F2')
  expect(css).toContain('.md-s-done{stroke:var(--status-online)}')
  expect(css).toContain('.x{fill:red}</style>')
})

test('main row keeps the full label from 300px; title and right text give way', () => {
  const m = buildMainModel(
    { ...base, flow: { ...FLOW, title: 'A rather long flow title for a narrow band', total: 9, done: 4 } },
    s,
  )
  expect(m.pill).toBe('Attività 4/9')
  for (const w of [300, 340, 420, 640]) {
    const svg = mainRowSvg({ ...m, right: '44% · and some long trailing text' }, w)
    expect(svg).toContain('>Attività 4/9</text>')
  }
})
