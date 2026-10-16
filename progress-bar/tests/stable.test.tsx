// A redraw that changes nothing visible hands every surface the same Svg
// sources, byte for byte: the band redraws about once a second while a turn or
// an agent runs, and the desktop and VS Code load each new source as a new
// image (VS Code shows the alt until it is drawn). A real change still does.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'
import { mainRowSvg, turnSeed } from '../hooks/main-row'
import { buildAgentRows, buildMainModel, type AgentRun, type Flow } from '../hooks/model'
import { STRINGS, fmtMinutes, wholePercent } from '../hooks/shared'

const PICTURES = ['desktop', 'vscode'] as const
type Picture = (typeof PICTURES)[number]

const IT = { options: { language: 'it' } }

const PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

// Beneath the plugin: a clock, the session, the tool registry, subagents (one
// id each), prompts, turns, and every other tool answered here.
function world(on: On): MockClock {
  const clock = mock.clock(on, { now: 1_000 })
  let n = 0
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_, e) => ({ value: { tool: `mcp__progress-bar__${e.name}` } }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: `agent-${++n}` }))
  on('prompt.submit', async (_, e) => ({ text: e.text }))
  on('turn.complete', async (_, e) => ({ text: e.answer, usage: e.usage }))
  on('tool.call', async (_, e) => ({ result: `beneath ${e.tool}` }))
  return clock
}

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

const mount = <P extends Picture | 'terminal'>(
  $: Engine,
  surface: P,
  props: Partial<typeof PROPS> = {},
): Promise<Mounted<P, 'AbovePrompt'>> =>
  $.ui.mount({ plugin: 'progress-bar', surface, component: 'AbovePrompt', props: { ...PROPS, ...props } })

const newTurn = ($: Engine) => $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })

const spawn = ($: Engine, description: string, i = 1) =>
  $.agent.spawn({
    prompt: 'Do it.',
    description,
    subagentType: 'savvy-flow:savvy-medium',
    tool_use_id: `toolu_${i}`,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })

const finish = ($: Engine, agentId: string) =>
  $.turn.complete({
    answer: 'done',
    durationMs: 1_000,
    isAborted: false,
    turnId: `turn-${agentId}`,
    agentId,
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })

const progress = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__progress-bar__progress', ...input } as unknown as Parameters<Engine['tool']['call']>[0])

// A tool the laid types may not name (update_plan): called loosely.
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const updatePlan = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: UPDATE_PLAN, ...input } as unknown as Parameters<Engine['tool']['call']>[0])

type Pic = { key: string; source: string; alt: string }
type Node = { type?: unknown; props?: { key?: unknown; source?: unknown; alt?: unknown }; children?: unknown[] }

// What a picture is. The drawn tree keeps no key on an Svg (VS Code places
// them by position anyway), so by what it draws: main, ram, or an agent row
// by its title (the alt's text before the colon).
const roleOf = (source: string, alt: string): string => {
  if (source.includes('pbm-k')) return 'main'
  if (source.includes('pbram-card')) return 'ram'
  if (source.includes('pba-')) return `row:${alt.split(':')[0]}`
  return '?'
}

// Every Svg of the drawn tree, depth first: main, agent rows, then the right zone.
const picturesOf = (n: unknown, out: Pic[] = []): Pic[] => {
  if (!n || typeof n !== 'object') return out
  const node = n as Node
  if (node.type === 'Svg') {
    const source = String(node.props?.source ?? '')
    const alt = String(node.props?.alt ?? '')
    out.push({ key: roleOf(source, alt), source, alt })
  }
  for (const c of node.children ?? []) picturesOf(c, out)
  return out
}

const pictures = async (ui: Mounted<Picture, 'AbovePrompt'>): Promise<Pic[]> => {
  await ui.redraw()
  return picturesOf(await ui.drawn())
}

const mainOf = (pics: Pic[]): Pic | undefined => pics.find(p => p.key === 'main')

/**
 * The band drawn at t, t+1 s and t+3 s with nothing else happening: every Svg
 * (source, alt, key) the same. Each step forces a redraw after the clock tick.
 */
async function expectSteady(clock: MockClock, ui: Mounted<Picture, 'AbovePrompt'>): Promise<Pic[]> {
  const t0 = await pictures(ui)
  expect(t0.length).toBeGreaterThanOrEqual(2)
  expect(t0.map(p => p.key)).toContain('main')
  expect(t0.map(p => p.key)).toContain('ram')
  await clock.advance(1_000)
  const t1 = await pictures(ui)
  await clock.advance(2_000)
  const t3 = await pictures(ui)
  expect(t1).toEqual(t0)
  expect(t3).toEqual(t0)
  return t0
}

for (const surface of PICTURES) {
  test(`working without a list: the same pictures at t, t+1 s, t+3 s; a minute or a tool changes them (${surface})`, IT, async ($, on) => {
    const clock = world(on)
    await start($)
    await newTurn($)
    const ui = await mount($, surface)
    // The terminal draws text: its clock ticks each second (the ticks do reach the band).
    const term = await mount($, 'terminal')
    expect(JSON.stringify(await term.drawn())).toContain('0:00')

    const before = await expectSteady(clock, ui)
    expect(mainOf(before)?.alt).toBe('In lavoro · <1m · 0 tool')
    expect(mainOf(before)?.source).toContain('>&lt;1m</text>')
    await term.redraw()
    expect(JSON.stringify(await term.drawn())).toContain('0:03')

    // One minute in: the pill reads 1m, a new picture.
    await clock.set(61_000)
    const minute = await pictures(ui)
    expect(mainOf(minute)?.alt).toBe('In lavoro · 1m · 0 tool')
    expect(mainOf(minute)?.source).not.toBe(mainOf(before)?.source)

    // A tool call: the count changes, a new picture.
    await $.tool.call({ tool: 'Bash', command: 'ls' } as unknown as Parameters<Engine['tool']['call']>[0])
    const tool = await pictures(ui)
    expect(mainOf(tool)?.alt).toBe('In lavoro · 1m · 1 tool')
    expect(mainOf(tool)?.source).not.toBe(mainOf(minute)?.source)
  })

  test(`working with a task list: steady across ticks; the list advancing changes it (${surface})`, IT, async ($, on) => {
    const clock = world(on)
    await start($)
    await newTurn($)
    const ui = await mount($, surface)
    await updatePlan($, {
      items: [
        { content: 'Read the code', status: 'in_progress' },
        { content: 'Write the fix', status: 'pending' },
      ],
    })
    const before = await expectSteady(clock, ui)
    expect(mainOf(before)?.alt).toBe('Read the code · Passo 1/2 · ~25%')

    await updatePlan($, { advance: true })
    const after = await pictures(ui)
    expect(mainOf(after)?.alt).toBe('Write the fix · Passo 2/2 · ~75%')
    expect(mainOf(after)?.source).not.toBe(mainOf(before)?.source)
  })

  test(`flow 0/2 with no worker during a turn: steady; done 1/2 changes it (${surface})`, IT, async ($, on) => {
    const clock = world(on)
    await start($)
    await newTurn($)
    const ui = await mount($, surface)
    await progress($, { title: '3D: correzioni e menu dx', total: 2, done: 0, phase: 'delegate' })
    const before = await expectSteady(clock, ui)
    expect(mainOf(before)?.alt).toBe('3D: correzioni e menu dx · Attività 0/2 · 0%')
    // Nothing moves in an empty bar: a still picture (no CSS animation in it).
    expect(mainOf(before)?.source).not.toMatch(/animation\s*:(?!\s*none\b)/)

    await progress($, { done: 1 })
    const after = await pictures(ui)
    expect(mainOf(after)?.alt).toBe('3D: correzioni e menu dx · Attività 1/2 · 50%')
    expect(mainOf(after)?.source).not.toBe(mainOf(before)?.source)
  })

  // Mounted after the 240 s advance, so its ticks redraw nothing; time to spare on a busy machine.
  test(`flow with a worker on the time curve: sub-percent drift draws nothing new, the next percent does (${surface})`, { ...IT, timeoutMs: 20_000 }, async ($, on) => {
    const clock = world(on)
    await start($)
    await progress($, {
      title: 'Demo',
      total: 2,
      done: 0,
      phase: 'delegate',
      tasks: [
        { title: 'First task', tier: 'medium' },
        { title: 'Second task', tier: 'light', after: [1] },
      ],
    })
    await spawn($, 'First task')
    // 240 s in: 0.8 × (1 − e^(−1)) / 2 = 25.3%, then 25.3%, 25.5% at +1 s, +3 s.
    await clock.advance(240_000)
    const ui = await mount($, surface, { isWorking: false })
    const before = await expectSteady(clock, ui)
    expect(mainOf(before)?.alt).toBe('Demo · Attività 0/2 · ~25%')

    // 244 s in: 25.5% → ~26%, a new picture.
    await clock.advance(1_000)
    const after = await pictures(ui)
    expect(mainOf(after)?.alt).toBe('Demo · Attività 0/2 · ~26%')
    expect(mainOf(after)?.source).not.toBe(mainOf(before)?.source)
  })

  test(`agent rows open: running rows keep their sources; a finish changes the row (${surface})`, IT, async ($, on) => {
    const clock = world(on)
    await start($)
    const ui = await mount($, surface, { isWorking: false })
    await spawn($, 'Scout the repo', 1)
    await spawn($, 'Write the fix', 2)
    await ui.redraw()
    await ui.press({ key: 'agents' })
    const before = await expectSteady(clock, ui)
    const rows = before.filter(p => p.key.startsWith('row:'))
    expect(rows.map(r => r.key).sort()).toEqual(['row:Scout the repo', 'row:Write the fix'])
    for (const r of rows) {
      expect(r.alt).toMatch(/: running, .*, <1m$/)
      expect(r.source).toContain('tok · &lt;1m</text>')
    }

    await finish($, 'agent-1')
    const after = await pictures(ui)
    const done = after.find(p => p.key === 'row:Scout the repo')
    // Finished: the frozen m:ss, a new picture.
    expect(done?.alt).toMatch(/: done, .*, 0:03$/)
    expect(done?.source).not.toBe(before.find(p => p.key === 'row:Scout the repo')?.source)
    // The finished row is a still picture; the running one still pulses.
    expect(done?.source).not.toMatch(/animation\s*:(?!\s*none\b)/)
    expect(after.find(p => p.key === 'row:Write the fix')?.source).toMatch(/\.pba-live\{animation:/)
  })

  test(`idle after a finished flow while a worker runs in the background: steady (${surface})`, IT, async ($, on) => {
    const clock = world(on)
    await start($)
    const ui = await mount($, surface, { isWorking: false })
    await progress($, { title: 'Demo', total: 1, done: 0, phase: 'delegate' })
    await spawn($, 'Background job')
    await progress($, { done: 1, finished: true })
    const before = await expectSteady(clock, ui)
    expect(mainOf(before)?.alt).toContain('✓ Demo')
  })
}

// A Windows host whose PowerShell answers with `read()` KB free of 16 GiB.
function winRam(on: On, read: () => number): void {
  mock.env(on, { OS: 'Windows_NT' })
  on('process.run', async () => ({
    value: {
      exitCode: 0,
      stdout: `${16 * 1024 * 1024} ${read()}\r\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
}

for (const surface of PICTURES) {
  test(`RAM: a reading moving under 1% keeps the right zone's source, 1% or more changes it (${surface})`, IT, async ($, on) => {
    const clock = world(on)
    let free = 8 * 1024 * 1024
    winRam(on, () => free)
    await start($)
    await clock.settle()
    const ui = await mount($, surface, { isWorking: false })
    const ramOf = async (): Promise<Pic | undefined> => (await pictures(ui)).find(p => p.key === 'ram')
    const first = await ramOf()
    expect(first?.alt).toBe('RAM 8/16 GB')

    // 0.48% of 16 GiB more in use: the next poll keeps the reading.
    free -= 80_000
    await clock.advance(10_000)
    expect(await ramOf()).toEqual(first)

    // 2.4% more: a new reading, a new picture.
    free -= 400_000
    await clock.advance(10_000)
    const moved = await ramOf()
    expect(moved?.source).not.toBe(first?.source)
    expect(moved?.alt).not.toBe(first?.alt)
  })
}

// ---------------------------------------------------------------------------
// Pure: the pieces the stability rests on.

test('fmtMinutes: floored whole minutes', () => {
  expect([0, 59_999, 60_000, 119_999, 3_599_999, 3_600_000, 3_900_000].map(fmtMinutes)).toEqual([
    '<1m',
    '<1m',
    '1m',
    '1m',
    '59m',
    '1h00m',
    '1h05m',
  ])
})

test('wholePercent rounds as the percentage text does', () => {
  expect([0, 0.004, 0.005, 0.2528, 0.2546, 0.2553, 0.99, 1, 2, Number.NaN].map(wholePercent)).toEqual([
    0, 0, 0.01, 0.25, 0.25, 0.26, 0.99, 1, 1, 0,
  ])
})

const FLOW: Flow = { title: 'Demo', total: 2, done: 0, running: 0, phase: 'delegate', isFinished: false, tasks: [] }

test('main row: the same source for the same view, whatever the clock', () => {
  const s = STRINGS.it
  const at = (now: number) => buildMainModel({ flow: null, isWorking: true, startedAt: 1_000, endedAt: null, tools: 2, now, timeStyle: 'minutes' }, s)
  const a = at(2_000)
  const b = at(4_000)
  expect(a.pill).toBe('<1m')
  expect(mainRowSvg(a, 640, turnSeed(1_000, a))).toBe(mainRowSvg(b, 640, turnSeed(1_000, b)))
  // A new turn reshuffles the look.
  expect(mainRowSvg(a, 640, turnSeed(1_000, a))).not.toBe(mainRowSvg(a, 640, turnSeed(90_000, a)))
  // The terminal's clock style keeps m:ss.
  expect(buildMainModel({ flow: null, isWorking: true, startedAt: 1_000, endedAt: null, tools: 2, now: 4_000 }, s).pill).toBe('0:03')
})

test('main row: a flow estimate drifting within one percent draws the same fill', () => {
  const s = STRINGS.it
  const m = buildMainModel({ flow: FLOW, isWorking: false, startedAt: null, endedAt: null, tools: 0, now: 0 }, s)
  const seed = turnSeed(null, m)
  const draw = (ratio: number) => mainRowSvg({ ...m, ratio, runRatio: ratio, isEstimate: true, right: '~25%' }, 640, seed)
  expect(draw(0.2528)).toBe(draw(0.2546))
  expect(draw(0.2528)).not.toBe(draw(0.2553))
})

test('agent rows: a running time in whole minutes, a finished one frozen m:ss', () => {
  const run: AgentRun = {
    id: 'a',
    agentId: 'a',
    type: 'savvy-flow:savvy-medium',
    description: 'Task',
    model: 'claude-opus-5-5',
    status: 'running',
    startedAt: 0,
    contextTokens: 0,
    contextMax: 1_000_000,
    tokens: 0,
    costUsd: 0,
    steps: 0,
    round: 1,
  }
  expect(buildAgentRows([run], 125_000, 'minutes')[0]?.time).toBe('2m')
  expect(buildAgentRows([run], 125_000)[0]?.time).toBe('2:05')
  expect(buildAgentRows([{ ...run, status: 'done', endedAt: 65_000 }], 125_000, 'minutes')[0]?.time).toBe('1:05')
})
