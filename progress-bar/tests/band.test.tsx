import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const IT = { options: { language: 'it' } }

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

// The world beneath the plugin: a clock, the session, the tool registry and subagents.
function world(on: On): MockClock {
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_, e) => ({ value: { tool: `mcp__progress-bar__${e.name}` } }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
  return clock
}

// A session starting, as the engine raises it: the plugin picks its language
// and registers its tools here.
const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

const mount = (
  $: Engine,
  surface: Surface,
  props: Partial<typeof PROPS> = {},
): Promise<Mounted<Surface, 'AbovePrompt'>> =>
  $.ui.mount({ plugin: 'progress-bar', surface, component: 'AbovePrompt', props: { ...PROPS, ...props } })

// Everything the band hands the surface, as text: Text children on the
// terminal, the Svg source and alt on the desktop.
const shown = async (ui: Mounted<Surface, 'AbovePrompt'>): Promise<string> => JSON.stringify(await ui.drawn())

for (const surface of SURFACES) {
  test(`idle shows Pronto and no agents button (${surface})`, IT, async ($, on) => {
    world(on)
    await start($)
    const ui = await mount($, surface)
    const text = await shown(ui)
    expect(text).toContain('Pronto')
    expect(await ui.find({ key: 'agents' })).toBeUndefined()
  })

  test(`a survey keeps the band's place (${surface})`, IT, async ($, on) => {
    world(on)
    // Beneath the plugin: what the engine draws for the survey.
    on('ui.render', { component: 'AbovePrompt' }, async (eng, e) => {
      const { Text } = eng.ui.resolve(e)
      return <Text>survey</Text>
    })
    await start($)
    const ui = await mount($, surface, { hasSurvey: true })
    const text = await shown(ui)
    expect(text).toContain('survey')
    expect(text).not.toContain('Pronto')
    expect(text).not.toContain('In lavoro')
  })

  test(`working shows In lavoro (${surface})`, IT, async ($, on) => {
    world(on)
    await start($)
    const ui = await mount($, surface, { isWorking: true })
    expect(await shown(ui)).toContain('In lavoro')
  })

  test(`the progress tool drives the flow (${surface})`, IT, async ($, on) => {
    world(on)
    await start($)
    const ui = await mount($, surface)
    const res = await $.tool.call({
      tool: 'mcp__progress-bar__progress',
      title: 'Demo',
      total: 2,
      done: 1,
      phase: 'delegate',
      tasks: [
        { title: 'First task', tier: 'medium' },
        { title: 'Second task', tier: 'light', after: [1] },
      ],
    })
    expect(res).toMatchObject({ result: expect.stringContaining('ok: Demo') })
    await ui.redraw()
    let text = await shown(ui)
    expect(text).toContain('Demo')
    expect(text).toContain('Attività 1/2')

    await $.tool.call({ tool: 'mcp__progress-bar__progress', done: 2, finished: true })
    await ui.redraw()
    text = await shown(ui)
    expect(text).toContain('Pronto')
    expect(text).toContain('✓ Demo')
    expect(text).not.toContain('Attività')
  })

  test(`the agents button shows and hides agent rows (${surface})`, IT, async ($, on) => {
    world(on)
    await start($)
    const ui = await mount($, surface)
    const spawned = await $.agent.spawn({
      prompt: 'Look around.',
      description: 'Scout the repo',
      subagentType: 'savvy-flow:savvy-light',
      tool_use_id: 'toolu_1',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
    })
    expect(spawned).toMatchObject({ agentId: 'agent-1' })
    await ui.redraw()

    const button = await ui.find({ key: 'agents' })
    // Compact: the running mark, the arrow and count, the tokens.
    expect(button?.props.label).toBe('●▾1 · 0')
    expect(await shown(ui)).not.toContain('Scout the repo')

    await ui.press({ key: 'agents' })
    expect(await shown(ui)).toContain('Scout the repo')
    expect((await ui.find({ key: 'agents' }))?.props.label).toBe('●▴1 · 0')

    await ui.press({ key: 'agents' })
    expect(await shown(ui)).not.toContain('Scout the repo')
  })
}

// The Svg sources: each `"source":"<svg …</svg>"` in the drawn tree, up to the
// `</svg>` that ends the string (a picture nests <svg>s of its own).
const svgSources = (text: string): string[] => text.match(/"source":"<svg.*?<\/svg>(?=")/g) ?? []

for (const surface of SURFACES) {
  test(`a flow at 4/9 shows the full label Attività 4/9 (${surface})`, IT, async ($, on) => {
    world(on)
    await start($)
    const ui = await mount($, surface)
    await $.tool.call({ tool: 'mcp__progress-bar__progress', title: 'Demo', total: 9, done: 4, phase: 'delegate' })
    await ui.redraw()
    const text = await shown(ui)
    expect(text).toContain('Attività 4/9')
    if (surface === 'desktop') expect(svgSources(text).some(s => s.includes('>Attività 4/9</text>'))).toBe(true)
  })

  test(`agent rows and the agents button show tokens (${surface})`, IT, async ($, on) => {
    world(on)
    // Beneath the plugin: the engine settling the subagent's turn.
    on('turn.complete', async (_, e) => ({ text: e.answer, usage: e.usage }))
    await start($)
    const ui = await mount($, surface)
    await $.agent.spawn({
      prompt: 'Look around.',
      description: 'Scout the repo',
      subagentType: 'savvy-flow:savvy-light',
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
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 30_000,
        output_tokens: 15_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })
    await ui.redraw()
    expect((await ui.find({ key: 'agents' }))?.props.label).toBe('▾1 · 45k')

    await ui.press({ key: 'agents' })
    const text = await shown(ui)
    expect(text).toContain('Scout the repo')
    expect(text).toContain('45k tok · ')
    if (surface === 'desktop') expect(svgSources(text).some(s => s.includes('45k tok'))).toBe(true)
  })
}

test('the flow main row Svg carries the violet to teal gradient', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'desktop')
  await $.tool.call({ tool: 'mcp__progress-bar__progress', title: 'Demo', total: 2, done: 1, phase: 'delegate' })
  await ui.redraw()
  const main = svgSources(await shown(ui)).find(s => s.includes('Attività 1/2</text>'))
  expect(main).toBeDefined()
  const grads = main?.match(/<linearGradient[\s\S]*?<\/linearGradient>/gi) ?? []
  expect(grads.some(g => /#8f8cf4/i.test(g) && /#1d9e75/i.test(g))).toBe(true)
})

test('English by option: Ready', { options: { language: 'en' } }, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'terminal')
  const text = await shown(ui)
  expect(text).toContain('Ready')
  expect(text).not.toContain('Pronto')
})

test('the step tool answers outside a subagent', IT, async ($, on) => {
  world(on)
  await start($)
  const res = await $.tool.call({ tool: 'mcp__progress-bar__step', done: 1, total: 3 })
  expect(res).toMatchObject({ result: expect.stringContaining('ignored') })
})
