import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'
import { mainRowSvg, turnSeed } from '../hooks/main-row'
import {
  buildMainModel,
  flowCompletion,
  flowEstimate,
  percentText,
  planAfterCall,
  planProgress,
  runShare,
  type AgentRun,
  type Flow,
  type Plan,
  type PlanCall,
} from '../hooks/model'
import { STRINGS } from '../hooks/shared'

const s = STRINGS.it

// ---------------------------------------------------------------------------
// The flow estimate, pure.

const FLOW: Flow = {
  title: 'Demo',
  total: 4,
  done: 1,
  running: 0,
  phase: 'delegate',
  isFinished: false,
  tasks: [
    { title: 'First task', tier: 'medium', after: [] },
    { title: 'Second task', tier: 'light', after: [] },
    { title: 'Third task', tier: 'light', after: [] },
    { title: 'Fourth task', tier: 'light', after: [] },
  ],
}

const run = (over: Partial<AgentRun>): AgentRun => ({
  id: 'a',
  agentId: 'a',
  type: 'savvy-flow:savvy-medium',
  description: 'First task',
  model: 'claude-opus-5-5',
  status: 'running',
  startedAt: 0,
  contextTokens: 0,
  contextMax: 1_000_000,
  tokens: 0,
  costUsd: 0,
  steps: 0,
  round: 1,
  ...over,
})

const base = { flow: null, isWorking: false, startedAt: null, endedAt: null, tools: 0, now: 0 }

// 0.8 × (1 − e^(−1)): a run without steps after 240 s.
const CURVE_AT_240S = 0.8 * (1 - Math.exp(-1))

// Six decimals: equal enough for ratios built from floats.
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6

test('percent text: a tilde only when estimated; an estimate stops at ~99%', () => {
  expect(percentText(0.45, true)).toBe('~45%')
  expect(percentText(0.45, false)).toBe('45%')
  expect(percentText(1, false)).toBe('100%')
  expect(percentText(0.996, true)).toBe('~99%')
  expect(percentText(1, true)).toBe('~99%')
})

test('run share: steps, time curve, finished, failed', () => {
  expect(r6(runShare(run({ stepDone: 2, stepTotal: 4 }), 0))).toBe(r6(0.45))
  expect(runShare(run({ startedAt: 1_000 }), 1_000)).toBe(0)
  expect(r6(runShare(run({ startedAt: 1_000 }), 241_000))).toBe(r6(CURVE_AT_240S))
  expect(runShare(run({ status: 'done', endedAt: 5_000 }), 0)).toBe(0.9)
  expect(runShare(run({ status: 'failed', endedAt: 5_000 }), 0)).toBe(0)
})

test('flow estimate with steps: accepted plus the running share, with a tilde', () => {
  const agents = [
    run({ id: 'r1', description: 'First task', status: 'done', endedAt: 5_000 }),
    run({ id: 'r2', description: 'Second task', startedAt: 6_000, stepDone: 3, stepTotal: 6 }),
  ]
  // done 1 (the finished First task) + 0.45 of Second task, over 4.
  expect(r6(flowEstimate(FLOW, agents, 10_000).ratio)).toBe(r6(0.3625))
  const m = buildMainModel({ ...base, flow: FLOW, agents, now: 10_000 }, s)
  expect(m).toMatchObject({ mode: 'flow', acceptedRatio: 0.25, isEstimate: true, right: '~36%', ringPercent: 36 })
  expect(r6(m.ratio)).toBe(r6(0.3625))
})

test('flow estimate without steps follows the time curve (mock clock)', () => {
  const flow = { ...FLOW, total: 2, done: 0 }
  const agents = [run({ id: 'r1', description: 'First task', startedAt: 1_000 })]
  const at0 = buildMainModel({ ...base, flow, agents, now: 1_000 }, s)
  expect(at0).toMatchObject({ ratio: 0, acceptedRatio: 0, isEstimate: false, right: '0%' })
  const at240 = buildMainModel({ ...base, flow, agents, now: 241_000 }, s)
  expect(r6(at240.ratio)).toBe(r6(CURVE_AT_240S / 2))
  expect(at240).toMatchObject({ isEstimate: true, right: '~25%' })
})

test('flow estimate: a finished run not yet accepted counts 0.9, then whole once accepted', () => {
  const flow = { ...FLOW, total: 2, done: 0 }
  const agents = [run({ id: 'r1', status: 'done', endedAt: 5_000 })]
  const pending = buildMainModel({ ...base, flow, agents, now: 6_000 }, s)
  expect(r6(pending.ratio)).toBe(r6(0.45))
  expect(pending).toMatchObject({ acceptedRatio: 0, isEstimate: true, right: '~45%' })
  const accepted = buildMainModel({ ...base, flow: { ...flow, done: 1 }, agents, now: 6_000 }, s)
  expect(accepted).toMatchObject({ ratio: 0.5, acceptedRatio: 0.5, isEstimate: false, right: '50%', ringPercent: 50 })
})

test('flow estimate: failed runs add nothing; a retry counts by its latest run', () => {
  const flow = { ...FLOW, total: 2, done: 0 }
  const failed = [run({ id: 'r1', status: 'failed', endedAt: 5_000 })]
  expect(flowEstimate(flow, failed, 6_000)).toEqual({ ratio: 0, acceptedRatio: 0 })
  const retried = [...failed, run({ id: 'r2', startedAt: 6_000, stepDone: 1, stepTotal: 3, round: 2 })]
  expect(r6(flowEstimate(flow, retried, 7_000).ratio)).toBe(r6(0.15))
})

test('flow estimate: matched runs only, else every worker run, at most total − done', () => {
  const flow = { ...FLOW, total: 2, done: 0 }
  // One run meets a task title: the unmatched one is left out.
  const mixed = [
    run({ id: 'r1', status: 'done', endedAt: 5_000 }),
    run({ id: 'x', description: 'Explore the repo', type: 'Explore', status: 'done', endedAt: 4_000 }),
  ]
  expect(r6(flowEstimate(flow, mixed, 6_000).ratio)).toBe(r6(0.45))
  // None meets a title: every worker run counts, at most the 2 open tasks.
  const noTitles = { ...flow, tasks: [] }
  const three = ['a', 'b', 'c'].map(id => run({ id, description: `Job ${id}`, status: 'done', endedAt: 5_000 }))
  expect(r6(flowEstimate(noTitles, three, 6_000).ratio)).toBe(r6(0.9))
  // Workers first: a non-savvy run is not counted while savvy runs exist.
  const withExplore = [three[0] as AgentRun, run({ id: 'x', description: 'Explore', type: 'Explore', status: 'done', endedAt: 4_000 })]
  expect(r6(flowEstimate(noTitles, withExplore, 6_000).ratio)).toBe(r6(0.45))
})

test('flow estimate stays in [done/total, 0.99] and is 1 when finished', () => {
  const flow: Flow = { ...FLOW, total: 20, done: 19, tasks: [] }
  const agents = [run({ id: 'r1', description: 'Last one', stepDone: 9, stepTotal: 9 })]
  // 19 accepted + 0.9 of the last would be 0.995: capped.
  expect(flowEstimate(flow, agents, 6_000)).toEqual({ ratio: 0.99, acceptedRatio: 0.95 })
  expect(flowEstimate({ ...flow, done: 20 }, agents, 6_000)).toEqual({ ratio: 1, acceptedRatio: 1 })
  expect(flowEstimate({ ...flow, isFinished: true }, [], 0)).toEqual({ ratio: 1, acceptedRatio: 1 })
  expect(flowEstimate({ ...flow, total: 0, done: 0 }, agents, 0)).toEqual({ ratio: 0, acceptedRatio: 0 })
})

// ---------------------------------------------------------------------------
// A flow completed by its runs (no done/finished report), pure.

// Two planned tasks, nothing accepted: as when the orchestrator never reports `done`.
const PAIR: Flow = { ...FLOW, total: 2, done: 0, tasks: (FLOW.tasks ?? []).slice(0, 2) }
const bothDone = [
  run({ id: 'r1', description: 'First task', status: 'done', endedAt: 5_000 }),
  run({ id: 'r2', description: 'Second task', status: 'done', startedAt: 6_000, endedAt: 9_000 }),
]

test('titles the Agent descriptions did not repeat: the finished runs are counted instead', () => {
  const renamed = bothDone.map((a, i) => ({ ...a, description: `Renamed ${i}` }))
  expect(flowCompletion(PAIR, renamed, false)).toEqual({ isComplete: true, planned: 2, succeeded: 2 })
  // Fewer finished runs than planned tasks: not complete.
  expect(flowCompletion(PAIR, renamed.slice(0, 1), false).isComplete).toBe(false)
})

test('every planned task done, nothing running, turn idle: drawn finished (100%, green), the flow untouched', () => {
  const flow = { ...PAIR, tasks: PAIR.tasks.map(t => ({ ...t })) }
  const before = JSON.stringify(flow)
  const m = buildMainModel({ ...base, flow, agents: bothDone, now: 10_000 }, s)
  expect(m).toMatchObject({
    mode: 'flow',
    title: 'Demo',
    ratio: 1,
    acceptedRatio: 1,
    isEstimate: false,
    pill: 'Attività 2/2',
    right: '100%',
    ringPercent: 100,
    isDone: true,
    isAnimating: false,
  })
  expect(JSON.stringify(flow)).toBe(before)
  expect(flowCompletion(flow, bothDone, false)).toEqual({ isComplete: true, planned: 2, succeeded: 2 })
  // Drawn green: the done dither and a green pill, not the flow gradient.
  const svg = mainRowSvg(m, 640, turnSeed(null, m))
  expect(svg).toContain('<g fill="#5fbf8f">')
  expect(svg).toContain('>Attività 2/2</text>')
  // The green pill, in px left of its anchor at the full bar's head.
  expect(svg).toMatch(/<rect x="-\d+" width="\d+" height="22" rx="11" fill="#5fbf8f"\/>/)
  expect(svg).not.toContain('pbm-grad')
  expect(svg).toContain('<circle cx="5" cy="15" r="3" fill="#5fbf8f"/>')
})

test('every planned task done but the turn still working: still the estimate, under 100%', () => {
  const m = buildMainModel({ ...base, flow: PAIR, agents: bothDone, isWorking: true, now: 10_000 }, s)
  expect(m).toMatchObject({ mode: 'flow', isDone: false, isEstimate: true, pill: 'Attività 0/2', right: '~90%' })
  expect(m.ratio).toBeLessThan(1)
  expect(m.ringPercent).toBeLessThan(100)
})

test('one task still running, or one without a run: still the estimate', () => {
  const running = [bothDone[0] as AgentRun, run({ id: 'r2', description: 'Second task', startedAt: 6_000, stepDone: 1, stepTotal: 4 })]
  const m = buildMainModel({ ...base, flow: PAIR, agents: running, now: 10_000 }, s)
  // (0.9 + 0.25 × 0.9) / 2
  expect(m).toMatchObject({ mode: 'flow', isDone: false, isEstimate: true, right: '~56%' })
  // Any agent running holds it, a task's or not.
  const other = [...bothDone, run({ id: 'x', description: 'Look around', type: 'Explore', startedAt: 7_000 })]
  expect(buildMainModel({ ...base, flow: PAIR, agents: other, now: 10_000 }, s)).toMatchObject({ isDone: false, right: '~90%' })
  // Second task never ran.
  const one = [bothDone[0] as AgentRun]
  expect(buildMainModel({ ...base, flow: PAIR, agents: one, now: 10_000 }, s)).toMatchObject({ isDone: false, right: '~45%' })
})

test('a failed task counts as ended: finished, the pill counting the successful ones', () => {
  const agents = [bothDone[0] as AgentRun, run({ id: 'r2', description: 'Second task', status: 'failed', startedAt: 6_000, endedAt: 9_000 })]
  const m = buildMainModel({ ...base, flow: PAIR, agents, now: 10_000 }, s)
  expect(m).toMatchObject({ mode: 'flow', isDone: true, ratio: 1, right: '100%', ringPercent: 100, pill: 'Attività 1/2' })
  // A failed run retried and done: its latest run counts.
  const retried = [...agents, run({ id: 'r3', description: 'Second task', status: 'done', startedAt: 9_500, endedAt: 9_900, round: 2 })]
  expect(buildMainModel({ ...base, flow: PAIR, agents: retried, now: 10_000 }, s)).toMatchObject({ isDone: true, pill: 'Attività 2/2' })
})

test('no task titles: `total` ended worker runs complete it', () => {
  const flow: Flow = { ...PAIR, tasks: [] }
  const jobs = ['a', 'b'].map((id, i) => run({ id, description: `Job ${id}`, status: 'done', startedAt: i, endedAt: 5_000 }))
  expect(buildMainModel({ ...base, flow, agents: jobs, now: 10_000 }, s)).toMatchObject({ isDone: true, pill: 'Attività 2/2', right: '100%' })
  // One run short of the total: the estimate.
  expect(buildMainModel({ ...base, flow, agents: jobs.slice(0, 1), now: 10_000 }, s)).toMatchObject({ isDone: false, right: '~45%' })
  // Nothing planned: never complete.
  expect(flowCompletion({ ...flow, total: 0 }, jobs, false).isComplete).toBe(false)
})

// ---------------------------------------------------------------------------
// The task list, pure.

const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const call = (input: Record<string, unknown>): PlanCall => ({ tool: UPDATE_PLAN, ...input })
const working = (plan: Plan | null, lang: 'it' | 'en' = 'it') =>
  buildMainModel({ ...base, isWorking: true, startedAt: 1_000, now: 61_000, tools: 4, plan }, STRINGS[lang])

test('update_plan: items, advance, done/start give the expected ratio, pill and title', () => {
  let p = planAfterCall(
    null,
    call({
      items: [
        { content: 'Read the code', status: 'in_progress' },
        { content: 'Write the fix', status: 'pending' },
        { content: 'Run the tests', status: 'pending' },
      ],
    }),
    10,
  )
  expect(p).toEqual({
    items: [
      { title: 'Read the code', status: 'in_progress' },
      { title: 'Write the fix', status: 'pending' },
      { title: 'Run the tests', status: 'pending' },
    ],
    at: 10,
  })
  let m = working(p ?? null)
  expect(m).toMatchObject({ mode: 'working', title: 'Read the code', pill: 'Passo 1/3', right: '~17%', isEstimate: true, acceptedRatio: 0 })
  expect(r6(m.ratio)).toBe(r6(0.5 / 3))

  p = planAfterCall(p ?? null, call({ advance: true }), 20)
  expect(p?.items.map(i => i.status)).toEqual(['completed', 'in_progress', 'pending'])
  m = working(p ?? null)
  expect(m).toMatchObject({ title: 'Write the fix', pill: 'Passo 2/3', right: '~50%', ratio: 0.5 })
  expect(r6(m.acceptedRatio)).toBe(r6(1 / 3))

  p = planAfterCall(p ?? null, call({ done: [2], start: 3 }), 30)
  expect(p?.items.map(i => i.status)).toEqual(['completed', 'completed', 'in_progress'])
  m = working(p ?? null)
  expect(m).toMatchObject({ title: 'Run the tests', pill: 'Passo 3/3', right: '~83%' })

  p = planAfterCall(p ?? null, call({ advance: true }), 40)
  expect(p?.items.map(i => i.status)).toEqual(['completed', 'completed', 'completed'])
  expect(working(p ?? null)).toMatchObject({ title: 'In lavoro', pill: 'Passo 3/3', right: '~99%', ratio: 1 })
  expect(working(p ?? null, 'en')).toMatchObject({ title: 'Working', pill: 'Step 3/3' })
})

test('update_plan: advance with nothing in progress starts the first pending; bad numbers are ignored', () => {
  const p0 = planAfterCall(null, call({ items: [{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }] }), 1)
  expect(planProgress(p0 as Plan)).toMatchObject({ step: 0, total: 2, ratio: 0 })
  const p1 = planAfterCall(p0 ?? null, call({ advance: true }), 2)
  expect(p1?.items.map(i => i.status)).toEqual(['in_progress', 'pending'])
  const p2 = planAfterCall(p1 ?? null, call({ done: [0, 3, 1.5, 'x'], start: 9 }), 3)
  expect(p2?.items.map(i => i.status)).toEqual(['in_progress', 'pending'])
  // An update with no list yet changes nothing; an empty list clears it.
  expect(planAfterCall(null, call({ advance: true }), 4)).toBeUndefined()
  expect(planAfterCall(p2 ?? null, call({ items: [] }), 5)).toBeNull()
})

test('TodoWrite: todos replace the list', () => {
  const p = planAfterCall(
    { items: [{ title: 'old', status: 'pending' }], at: 0 },
    {
      tool: 'TodoWrite',
      todos: [
        { content: 'Plan', status: 'completed', activeForm: 'Planning' },
        { content: 'Build', status: 'in_progress', activeForm: 'Building' },
        { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
      ],
    },
    7,
  )
  expect(p?.items).toEqual([
    { title: 'Plan', status: 'completed' },
    { title: 'Build', status: 'in_progress' },
    { title: 'Ship', status: 'pending' },
  ])
  expect(working(p ?? null)).toMatchObject({ title: 'Build', pill: 'Passo 2/3', right: '~50%', ratio: 0.5 })
})

test('subagent calls and other tools leave the list as it is', () => {
  const prev: Plan = { items: [{ title: 'Mine', status: 'in_progress' }], at: 0 }
  const todos = [{ content: 'Theirs', status: 'pending', activeForm: 'x' }]
  expect(planAfterCall(prev, { tool: 'TodoWrite', agentId: 'agent-1', todos }, 1)).toBeUndefined()
  expect(planAfterCall(prev, call({ agentId: 'agent-1', items: [{ content: 'Theirs', status: 'pending' }] }), 1)).toBeUndefined()
  expect(planAfterCall(prev, { tool: 'Bash', command: 'ls' }, 1)).toBeUndefined()
})

test('working without a list stays indeterminate', () => {
  for (const plan of [null, { items: [], at: 0 }]) {
    expect(working(plan)).toMatchObject({ mode: 'working', title: 'In lavoro', ratio: 0, acceptedRatio: 0, isEstimate: false, pill: '1:00', right: '4 tool' })
  }
})

test('a flow outranks the task list', () => {
  const plan: Plan = { items: [{ title: 'A', status: 'in_progress' }], at: 0 }
  const m = buildMainModel({ ...base, flow: { ...FLOW, tasks: [] }, isWorking: true, plan }, s)
  expect(m).toMatchObject({ mode: 'flow', title: 'Demo', pill: 'Attività 1/4', right: '25%', isEstimate: false })
})

// ---------------------------------------------------------------------------
// Through the engine: the hooks observe and always pass the call on.

const IT = { options: { language: 'it' } }

const PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

type Seen = { tool: string; [k: string]: unknown }

// Beneath the plugin: a clock, the session, the tool registry, subagents, and
// every other tool answered here, its input recorded as it arrived.
function world(on: On, seen: Seen[] = []): MockClock {
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_, e) => ({ value: { tool: `mcp__progress-bar__${e.name}` } }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
  on('prompt.submit', async (_, e) => ({ text: e.text }))
  on('turn.complete', async (_, e) => ({ text: e.answer, usage: e.usage }))
  on('tool.call', async (_, e) => {
    seen.push({ ...(e as unknown as Seen) })
    return { result: `beneath ${e.tool}` }
  })
  return clock
}

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

const mountDesktop = (
  $: Engine,
  props: Partial<typeof PROPS> = {},
): Promise<Mounted<'desktop', 'AbovePrompt'>> =>
  $.ui.mount({ plugin: 'progress-bar', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, ...props } })

type Node = { type?: unknown; props?: { alt?: unknown }; children?: unknown[] }

// The first Svg of a drawn tree, depth first: on the desktop, the main row.
const firstSvg = (n: unknown): Node | undefined => {
  if (!n || typeof n !== 'object') return undefined
  const node = n as Node
  if (node.type === 'Svg') return node
  for (const c of node.children ?? []) {
    const hit = firstSvg(c)
    if (hit) return hit
  }
  return undefined
}

// The main row's alt: "title · pill · right".
const mainAlt = async (ui: Mounted<'desktop', 'AbovePrompt'>): Promise<string> => {
  await ui.redraw()
  return String(firstSvg(await ui.drawn())?.props?.alt ?? '')
}

// A tool the laid types may not name (update_plan): called loosely.
const callTool = ($: Engine, input: Seen) => $.tool.call(input as unknown as Parameters<Engine['tool']['call']>[0])

const newTurn = ($: Engine, turnId?: string) =>
  $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' }, ...(turnId ? { turnId } : {}) })

test('update_plan calls drive the working bar and reach the tool unchanged', IT, async ($, on) => {
  const seen: Seen[] = []
  world(on, seen)
  await start($)
  const ui = await mountDesktop($)
  // A picture's elapsed time (and its alt) reads in whole minutes: stable.test.tsx.
  expect(await mainAlt(ui)).toBe('In lavoro · <1m · 0 tool')

  const items = [
    { content: 'Read the code', status: 'in_progress' },
    { content: 'Write the fix', status: 'pending' },
  ]
  const first = { tool: UPDATE_PLAN, items }
  expect(await callTool($, first)).toMatchObject({ result: `beneath ${UPDATE_PLAN}` })
  expect(await mainAlt(ui)).toBe('Read the code · Passo 1/2 · ~25%')

  await callTool($, { tool: UPDATE_PLAN, advance: true })
  expect(await mainAlt(ui)).toBe('Write the fix · Passo 2/2 · ~75%')

  await callTool($, { tool: UPDATE_PLAN, done: [2] })
  expect(await mainAlt(ui)).toBe('In lavoro · Passo 2/2 · ~99%')

  // Each call arrived beneath exactly as sent.
  const plans = seen.filter(e => e.tool === UPDATE_PLAN)
  expect(plans.length).toBe(3)
  expect(plans[0]).toMatchObject(first)
  expect(plans[1]).toMatchObject({ tool: UPDATE_PLAN, advance: true })
  expect(plans[2]).toMatchObject({ tool: UPDATE_PLAN, done: [2] })
})

test('TodoWrite calls drive the working bar and reach the tool unchanged', IT, async ($, on) => {
  const seen: Seen[] = []
  world(on, seen)
  await start($)
  const ui = await mountDesktop($)
  const todos = [
    { content: 'Plan', status: 'completed', activeForm: 'Planning' },
    { content: 'Build', status: 'in_progress', activeForm: 'Building' },
    { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
    { content: 'Tell', status: 'pending', activeForm: 'Telling' },
  ]
  const res = await $.tool.call({ tool: 'TodoWrite', todos: todos as { content: string; status: 'completed' | 'in_progress' | 'pending'; activeForm: string }[] })
  expect(res).toMatchObject({ result: 'beneath TodoWrite' })
  expect(seen.find(e => e.tool === 'TodoWrite')).toMatchObject({ tool: 'TodoWrite', todos })
  expect(await mainAlt(ui)).toBe('Build · Passo 2/4 · ~38%')
})

test('a malformed list call still reaches the tool and changes nothing', IT, async ($, on) => {
  const seen: Seen[] = []
  world(on, seen)
  await start($)
  const ui = await mountDesktop($)
  const res = await callTool($, { tool: UPDATE_PLAN, items: 'not a list', advance: 'yes' })
  expect(res).toMatchObject({ result: `beneath ${UPDATE_PLAN}` })
  expect(seen.at(-1)).toMatchObject({ tool: UPDATE_PLAN, items: 'not a list', advance: 'yes' })
  expect(await mainAlt(ui)).toBe('In lavoro · <1m · 1 tool')
})

test('a completed list is cleared when a new turn starts; an open one carries on', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mountDesktop($)

  await callTool($, { tool: UPDATE_PLAN, items: [{ content: 'Only step', status: 'in_progress' }, { content: 'Next', status: 'pending' }] })
  await newTurn($)
  expect(await mainAlt(ui)).toBe('Only step · Passo 1/2 · ~25%')

  await callTool($, { tool: UPDATE_PLAN, done: [1, 2] })
  // A prompt typed over the running turn is not a new turn.
  await newTurn($, 'turn-1')
  expect(await mainAlt(ui)).toBe('In lavoro · Passo 2/2 · ~99%')

  await newTurn($)
  expect(await mainAlt(ui)).toBe('In lavoro · <1m · 0 tool')
})

test('the flow estimate moves with a running worker, then its finish, then its acceptance', IT, async ($, on) => {
  const clock = world(on)
  await start($)
  const ui = await mountDesktop($, { isWorking: false })
  await $.tool.call({
    tool: 'mcp__progress-bar__progress',
    title: 'Demo',
    total: 2,
    done: 0,
    phase: 'delegate',
    tasks: [
      { title: 'First task', tier: 'medium' },
      { title: 'Second task', tier: 'light', after: [1] },
    ],
  })
  expect(await mainAlt(ui)).toBe('Demo · Attività 0/2 · 0%')

  await $.agent.spawn({
    prompt: 'Do it.',
    description: 'First task',
    subagentType: 'savvy-flow:savvy-medium',
    tool_use_id: 'toolu_1',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  await clock.advance(240_000)
  // 0.8 × (1 − e^(−1)) of one task out of two.
  expect(await mainAlt(ui)).toBe('Demo · Attività 0/2 · ~25%')

  await $.turn.complete({
    answer: 'done',
    durationMs: 1_000,
    isAborted: false,
    turnId: 'turn-1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  expect(await mainAlt(ui)).toBe('Demo · Attività 0/2 · ~45%')

  await $.tool.call({ tool: 'mcp__progress-bar__progress', done: 1 })
  expect(await mainAlt(ui)).toBe('Demo · Attività 1/2 · 50%')
})

test('through the engine: both tasks ended and the turn idle draw the flow finished; a working turn draws the estimate', IT, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  let n = 0
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_, e) => ({ value: { tool: `mcp__progress-bar__${e.name}` } }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: `agent-${++n}` }))
  on('turn.complete', async (_, e) => ({ text: e.answer, usage: e.usage }))
  await start($)
  const idle = await mountDesktop($, { isWorking: false })
  const busy = await mountDesktop($, { isWorking: true })
  await $.tool.call({
    tool: 'mcp__progress-bar__progress',
    title: 'Demo',
    total: 2,
    done: 0,
    phase: 'delegate',
    tasks: [
      { title: 'First task', tier: 'medium' },
      { title: 'Second task', tier: 'light', after: [1] },
    ],
  })
  for (const [i, description] of ['First task', 'Second task'].entries()) {
    await $.agent.spawn({
      prompt: 'Do it.',
      description,
      subagentType: 'savvy-flow:savvy-medium',
      tool_use_id: `toolu_${i + 1}`,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
    })
  }
  expect(await mainAlt(idle)).toBe('Demo · Attività 0/2 · 0%')
  for (const agentId of ['agent-1', 'agent-2'])
    await $.turn.complete({
      answer: 'done',
      durationMs: 1_000,
      isAborted: false,
      turnId: `turn-${agentId}`,
      agentId,
      reason: 'answer',
      usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
  expect(await mainAlt(idle)).toBe('Demo · Attività 2/2 · 100%')
  expect(String((firstSvg(await idle.drawn())?.props as { source?: unknown })?.source)).toContain('<g fill="#5fbf8f">')
  expect(await mainAlt(busy)).toBe('Demo · Attività 0/2 · ~90%')
  // Derived on the draw: the stored flow still says 0/2.
  expect(await $.tool.call({ tool: 'mcp__progress-bar__progress' })).toMatchObject({ result: 'ok: Demo: delegate 0/2' })
})
