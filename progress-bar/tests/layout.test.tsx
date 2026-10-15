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

// The desktop's row geometry, as register.tsx estimates it.
const MAIN_H = 30
const GAP_PX = 8
const rowWOf = (cols: number): number => Math.max(180, Math.min(1600, cols * 8 - 96))

function world(on: On): MockClock {
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_, e) => ({ value: { tool: `mcp__progress-bar__${e.name}` } }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
  return clock
}

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

const mount = (
  $: Engine,
  surface: Surface,
  props: Partial<typeof PROPS> = {},
): Promise<Mounted<Surface, 'AbovePrompt'>> =>
  $.ui.mount({ plugin: 'progress-bar', surface, component: 'AbovePrompt', props: { ...PROPS, ...props } })

const drawn = async (ui: Mounted<Surface, 'AbovePrompt'>): Promise<string> => JSON.stringify(await ui.drawn())

const spawn = ($: Engine) =>
  $.agent.spawn({
    prompt: 'Look around.',
    description: 'Scout the repo',
    subagentType: 'savvy-flow:savvy-light',
    tool_use_id: 'toolu_1',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })

// The first row's children, as drawn.
type Node = {
  type?: string
  props?: { key?: string; width?: unknown; height?: unknown; source?: unknown; label?: unknown }
  children?: unknown[]
}
const kids = (n: unknown): Node[] => ((n as Node)?.children ?? []).filter((c): c is Node => !!c && typeof c === 'object')
const firstRow = (tree: unknown): Node[] => kids(kids(tree)[0])
const keyOf = (k: Node | undefined): string => k?.props?.key ?? k?.type ?? '?'
// Every element under `n` (itself included), depth first.
const walk = (n: Node | undefined): Node[] => (n ? [n, ...kids(n).flatMap(walk)] : [])
// The desktop row flattened: the main bar, then the right zone's parts in order.
const desktopParts = (tree: unknown): Node[] => {
  const [main, zone] = firstRow(tree)
  return [...(main ? [main] : []), ...kids(zone)]
}
const widthOf = (n: Node | undefined): number => Number(n?.props?.width ?? 0)
// What a row part is: by key where the drawing keeps one, else by what it draws.
const roleOf = (n: Node | undefined): string => {
  if (n?.props?.key) return n.props.key
  const src = String(n?.props?.source ?? '')
  if (n?.type === 'Svg' && src.includes('pbs-l')) return 'sep'
  if (n?.type === 'Svg' && src.includes('pbram-card')) return 'ram'
  if (n?.type === 'Svg' && src.includes('pbm-k')) return 'main'
  if (JSON.stringify(n ?? {}).includes('│')) return 'sep'
  return keyOf(n)
}

test('the collapse control ends the row (terminal): the Button keyed collapse', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'terminal')
  expect((await ui.find({ key: 'collapse' }))?.type).toBe('Button')
  const row = firstRow(await ui.drawn())
  expect(keyOf(row[row.length - 1])).toBe('collapse')
})

test('terminal row: [main] [agents] │ [RAM] [‹], compact agents label', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'terminal')
  await spawn($)
  await ui.redraw()
  const row = firstRow(await ui.drawn())
  const keys = row.map(roleOf)
  expect(keys.indexOf('agents')).toBeGreaterThan(0)
  expect(keys.indexOf('sep')).toBe(keys.indexOf('agents') + 1)
  expect(keys[keys.length - 1]).toBe('collapse')
  expect(JSON.stringify(row[keys.indexOf('sep')])).toContain('│')
  expect((await ui.find({ key: 'agents' }))?.props.label).toBe('●▾1 · 0')
})

test('the collapse control ends the row (desktop): a MAIN_H square under the collapse Client', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'desktop')
  expect((await ui.find({ key: 'collapse' }))?.type).toBe('Client')
  const parts = desktopParts(await ui.drawn())
  const last = parts[parts.length - 1]
  expect(keyOf(last)).toBe('collapse-box')
  expect(walk(last).some(n => n.type === 'Client' && n.props?.key === 'collapse')).toBe(true)
  const svg = walk(last).find(n => n.type === 'Svg')
  expect(widthOf(svg)).toBe(MAIN_H)
  expect(Number(svg?.props?.height)).toBe(MAIN_H)
  expect(String(svg?.props?.source)).toContain('pbc-ch')
  expect(String(svg?.props?.source)).toContain(`width="${MAIN_H}" height="${MAIN_H}"`)
})

test('desktop row without agents: [main] [sep] [RAM] [collapse], main 80% of the row', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'desktop')
  const tree = await ui.drawn()
  const outer = kids(tree)[0]
  expect((outer?.props as { justifyContent?: string })?.justifyContent).toBe('space-between')
  const parts = desktopParts(tree)
  expect(parts.map(roleOf)).toEqual(['main', 'sep', 'ram', 'collapse-box'])
  const rowW = rowWOf(100)
  const [main, sep, ram] = parts
  expect(Math.abs(widthOf(main) - Math.round(rowW * 0.8))).toBeLessThanOrEqual(2)
  expect(widthOf(sep)).toBe(1)
  expect(Number(sep?.props?.height)).toBe(18)
  expect(String(sep?.props?.source)).toContain('#e4e4e1')
  expect(String(sep?.props?.source)).toContain('#333331')
  // The parts and the gaps fill the row exactly: main + gap + sep + gap + RAM + gap + collapse.
  expect(widthOf(main) + widthOf(sep) + widthOf(ram) + MAIN_H + 3 * GAP_PX).toBe(rowW)
  expect(String(ram?.props?.source)).toContain(`width="${widthOf(ram)}" height="30"`)
  // A zone under 150px shows the RAM as a percent only.
  expect(rowW - widthOf(main)).toBeLessThan(150)
  expect(String(ram?.props?.source)).not.toContain('pbram-track')
})

test('desktop row with agents: [main] [agents] [sep] [RAM] [collapse], fitting the row', IT, async ($, on) => {
  world(on)
  await start($)
  const cols = 150
  const ui = await mount($, 'desktop', { bodyColumns: cols })
  await spawn($)
  await ui.redraw()
  const parts = desktopParts(await ui.drawn())
  expect(parts.map(roleOf)).toEqual(['main', 'agents', 'sep', 'ram', 'collapse-box'])
  expect(parts[1]?.props?.label).toBe('●▾1 · 0')
  const rowW = rowWOf(cols)
  expect(Math.abs(widthOf(parts[0]) - Math.round(rowW * 0.8))).toBeLessThanOrEqual(2)
  const agentsPx = Math.ceil('●▾1 · 0'.length * 7.5) + 24
  expect(widthOf(parts[0]) + agentsPx + 1 + widthOf(parts[3]) + MAIN_H + 4 * GAP_PX).toBe(rowW)
})

test('desktop: collapsing plays the motion for 360ms, then the band collapses', IT, async ($, on) => {
  const clock = world(on)
  mock.store(on)
  await start($)
  const ui = await mount($, 'desktop')
  expect(await drawn(ui)).not.toContain('pbm-collapse')
  await ui.post({ action: 'collapse' }, { in: 'collapse' })
  // Still the row, every Svg of it scaling out toward the left.
  let text = await drawn(ui)
  expect(await ui.find({ key: 'collapse' })).toBeDefined()
  expect(await ui.find({ key: 'collapsed' })).toBeUndefined()
  for (const p of desktopParts(await ui.drawn()).flatMap(walk).filter(n => n.type === 'Svg')) {
    expect(String(p.props?.source)).toContain('animation:pbm-collapse .36s ease-in forwards')
  }
  expect(text).toContain('transform-origin:left center')
  expect(text).toContain('prefers-reduced-motion')

  await clock.advance(359)
  expect(await ui.find({ key: 'collapsed' })).toBeUndefined()
  await clock.advance(1)
  expect(await ui.find({ key: 'collapsed' })).toBeDefined()
  expect(await ui.find({ key: 'collapse' })).toBeUndefined()
  text = await drawn(ui)
  expect(text).not.toContain('pbm-collapse')
})

test('desktop: expanding reopens at once with the motion, cleared after 360ms', IT, async ($, on) => {
  const clock = world(on)
  mock.store(on, { isCollapsed: true })
  await start($)
  const ui = await mount($, 'desktop')
  await ui.post({ action: 'expand' }, { in: 'collapsed' })
  expect(await ui.find({ key: 'collapse' })).toBeDefined()
  expect(await ui.find({ key: 'collapsed' })).toBeUndefined()
  expect(await drawn(ui)).toContain('animation:pbm-expand .36s ease-out forwards')
  await clock.advance(360)
  const text = await drawn(ui)
  expect(text).not.toContain('pbm-expand')
  expect(text).not.toContain('pba-x')
  // A later redraw does not replay it.
  await clock.advance(2_000)
  await ui.redraw()
  expect(await drawn(ui)).not.toContain('pbm-expand')
})

test('desktop: a stale collapse timer never ends a newer phase', IT, async ($, on) => {
  const clock = world(on)
  mock.store(on)
  await start($)
  const ui = await mount($, 'desktop')
  await ui.post({ action: 'collapse' }, { in: 'collapse' })
  await clock.advance(200)
  // Reopened mid-collapse: the expand motion takes over.
  await ui.post({ action: 'expand' }, { in: 'collapse' })
  expect(await drawn(ui)).toContain('pbm-expand')
  await clock.advance(200)
  // The collapse timer came due at 360ms: ignored.
  expect(await ui.find({ key: 'collapsed' })).toBeUndefined()
  expect(await drawn(ui)).toContain('pbm-expand')
  await clock.advance(160)
  expect(await ui.find({ key: 'collapse' })).toBeDefined()
  expect(await drawn(ui)).not.toContain('pbm-expand')
})

test('desktop: a press on the collapse Client collapses the band', IT, async ($, on) => {
  const clock = world(on)
  mock.store(on)
  await start($)
  const ui = await mount($, 'desktop')
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'collapse' })
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'collapse' })
  await clock.advance(360)
  expect(await ui.find({ key: 'collapsed' })).toBeDefined()
})

test('collapsed desktop: only the ring, MAIN_H square, right-aligned, no card', IT, async ($, on) => {
  world(on)
  mock.store(on, { isCollapsed: true })
  await start($)
  const ui = await mount($, 'desktop')
  expect(await ui.find({ key: 'collapsed' })).toBeDefined()
  expect(await ui.find({ key: 'expand' })).toBeUndefined()
  expect(await ui.find({ key: 'collapse' })).toBeUndefined()
  const tree = await ui.drawn()
  const outer = kids(tree)[0] ?? (tree as Node)
  const text = JSON.stringify(tree)
  expect(text).not.toContain('pbq-bg')
  expect(text).not.toContain('<rect')
  expect(text).toContain('pbr-ks')
  expect(JSON.stringify((tree as Node).props ?? outer.props)).toContain('flex-end')
  const svgs = walk(tree as Node).filter(n => n.type === 'Svg')
  expect(svgs).toHaveLength(1)
  expect(widthOf(svgs[0])).toBe(MAIN_H)
  expect(Number(svgs[0]?.props?.height)).toBe(MAIN_H)
  expect(String(svgs[0]?.props?.source)).toContain('viewBox="0 0 32 32"')
})

test('collapsed desktop: a press on the ring reopens the bar with the expand motion', IT, async ($, on) => {
  world(on)
  mock.store(on, { isCollapsed: true })
  await start($)
  const ui = await mount($, 'desktop')
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'collapsed' })
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'collapsed' })
  expect(await ui.find({ key: 'collapse' })).toBeDefined()
  expect(await ui.find({ key: 'collapsed' })).toBeUndefined()
  expect(await drawn(ui)).toContain('pbm-expand')
})

test('collapsed desktop: a direct ui.message from the square expands', IT, async ($, on) => {
  world(on)
  mock.store(on, { isCollapsed: true })
  await start($)
  const ui = await mount($, 'desktop')
  await ui.post({ action: 'something-else' }, { in: 'collapsed' })
  expect(await ui.find({ key: 'collapsed' })).toBeDefined()
  await ui.post({ action: 'expand' }, { in: 'collapsed' })
  expect(await ui.find({ key: 'collapse' })).toBeDefined()
})

test('collapsed terminal: one expand Button labelled with the ring glyph', IT, async ($, on) => {
  world(on)
  mock.store(on, { isCollapsed: true })
  await start($)
  await $.tool.call({ tool: 'mcp__progress-bar__progress', title: 'Demo', total: 2, done: 1, phase: 'delegate' })
  const ui = await mount($, 'terminal')
  expect((await ui.find({ key: 'expand' }))?.props.label).toBe('◑ 50%')
  await ui.press({ key: 'expand' })
  expect(await ui.find({ key: 'collapse' })).toBeDefined()
})

test('the RAM poll writes the ram atom (Windows probe mocked)', IT, async ($, on) => {
  const c = world(on)
  mock.env(on, { OS: 'Windows_NT' })
  let free = 8 * 1024 * 1024
  on('process.run', async () => ({
    value: {
      exitCode: 0,
      stdout: `${16 * 1024 * 1024} ${free}\r\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  await start($)
  await c.settle()
  // A wide row, so the RAM card has room for the pair.
  const ui = await mount($, 'desktop', { bodyColumns: 200 })
  expect(await drawn(ui)).toContain('8/16 GB')
  const t = await mount($, 'terminal')
  expect(await drawn(t)).toContain('8/16 GB')

  free = 4 * 1024 * 1024
  await c.advance(5_000)
  expect(await drawn(ui)).toContain('12/16 GB')
})
