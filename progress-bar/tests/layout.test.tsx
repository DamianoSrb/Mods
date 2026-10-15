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
const GAP_PX = 8
const RAM_W = 120
// 24px of safety under the bodyColumns estimate, so the row never wraps.
const rowWOf = (cols: number): number => Math.max(180, Math.min(1600, cols * 8 - 96 - 24))
const agentsPxOf = (label: string): number => Math.ceil(label.length * 7.5) + 24

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
  props?: { key?: string; width?: unknown; height?: unknown; source?: unknown; label?: unknown; alt?: unknown }
  children?: unknown[]
}
const kids = (n: unknown): Node[] => ((n as Node)?.children ?? []).filter((c): c is Node => !!c && typeof c === 'object')
const firstRow = (tree: unknown): Node[] => kids(kids(tree)[0])
const keyOf = (k: Node | undefined): string => k?.props?.key ?? k?.type ?? '?'
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
  const text = JSON.stringify(n ?? {})
  if (text.includes('│')) return 'sep'
  if (text.includes('"RAM')) return 'ram'
  return keyOf(n)
}
const ramOf = async (ui: Mounted<Surface, 'AbovePrompt'>): Promise<Node | undefined> =>
  desktopParts(await ui.drawn()).find(n => roleOf(n) === 'ram')

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

// Nothing of the removed collapse feature is drawn on any surface.
const COLLAPSE_KEYS = ['collapse', 'collapsed', 'collapse-box', 'expand']

for (const surface of SURFACES) {
  test(`no collapse control or collapsed view, RAM ends the row (${surface})`, IT, async ($, on) => {
    world(on)
    await start($)
    const ui = await mount($, surface)
    await spawn($)
    await ui.redraw()
    for (const key of COLLAPSE_KEYS) expect(await ui.find({ key })).toBeUndefined()
    const text = await drawn(ui)
    expect(text).not.toContain('"type":"Client"')
    expect(text).not.toContain('‹')
    expect(text).not.toContain('pbc-ch')
    expect(text).not.toContain('pbr-ks')
    expect(text).not.toContain('pba-x')
    const tree = await ui.drawn()
    const row = surface === 'desktop' ? desktopParts(tree) : firstRow(tree)
    expect(roleOf(row[row.length - 1])).toBe('ram')
  })
}

test('terminal row: [main] [agents] │ [RAM], compact agents label', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'terminal')
  await spawn($)
  await ui.redraw()
  const row = firstRow(await ui.drawn())
  const keys = row.map(roleOf)
  expect(keys.indexOf('agents')).toBeGreaterThan(0)
  expect(keys.indexOf('sep')).toBe(keys.indexOf('agents') + 1)
  expect(keys.length).toBe(keys.indexOf('sep') + 2)
  expect(keys[keys.length - 1]).toBe('ram')
  expect(JSON.stringify(row[keys.indexOf('sep')])).toContain('│')
  expect((await ui.find({ key: 'agents' }))?.props.label).toBe('●▾1 · 0')
})

test('desktop row without agents: [main] [sep] [RAM 120px], main takes the rest', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'desktop')
  const tree = await ui.drawn()
  const outer = kids(tree)[0]
  expect((outer?.props as { justifyContent?: string })?.justifyContent).toBe('flex-start')
  const parts = desktopParts(tree)
  expect(parts.map(roleOf)).toEqual(['main', 'sep', 'ram'])
  const rowW = rowWOf(100)
  expect(rowW).toBeGreaterThanOrEqual(500)
  const [main, sep, ram] = parts
  expect(widthOf(sep)).toBe(1)
  expect(Number(sep?.props?.height)).toBe(30)
  expect(String(sep?.props?.source)).toContain('#e4e4e1')
  expect(String(sep?.props?.source)).toContain('#333331')
  expect(widthOf(ram)).toBe(RAM_W)
  expect(String(ram?.props?.source)).toContain(`width="${RAM_W}" height="30"`)
  // main + gap + sep + gap + RAM: exactly the (conservative) row.
  expect(widthOf(main) + GAP_PX + 1 + GAP_PX + RAM_W).toBe(rowW)
})

for (const cols of [100, 150, 200]) {
  test(`desktop row with agents at ${cols} cols: RAM keeps 120px at the far right`, IT, async ($, on) => {
    world(on)
    await start($)
    const ui = await mount($, 'desktop', { bodyColumns: cols })
    await spawn($)
    await ui.redraw()
    const parts = desktopParts(await ui.drawn())
    expect(parts.map(roleOf)).toEqual(['main', 'agents', 'sep', 'ram'])
    expect(parts[1]?.props?.label).toBe('●▾1 · 0')
    const rowW = rowWOf(cols)
    expect(rowW).toBeGreaterThanOrEqual(500)
    expect(widthOf(parts[3])).toBe(RAM_W)
    expect(String(parts[3]?.props?.source)).toContain('pbram-card')
    // main + gap + agents + gap + sep + gap + RAM = row.
    expect(widthOf(parts[0]) + GAP_PX + agentsPxOf('●▾1 · 0') + GAP_PX + 1 + GAP_PX + RAM_W).toBe(rowW)
  })
}

test('desktop row under 500px: a 72px percent-only RAM card, still present', IT, async ($, on) => {
  const c = world(on)
  winRam(on, () => 8 * 1024 * 1024)
  await start($)
  await c.settle()
  const cols = 60
  const ui = await mount($, 'desktop', { bodyColumns: cols })
  await spawn($)
  await ui.redraw()
  const parts = desktopParts(await ui.drawn())
  expect(parts.map(roleOf)).toEqual(['main', 'agents', 'sep', 'ram'])
  const rowW = rowWOf(cols)
  expect(rowW).toBeLessThan(500)
  expect(widthOf(parts[3])).toBe(72)
  const src = String(parts[3]?.props?.source)
  expect(src).toContain('>50%</text>')
  expect(src).not.toContain('pbram-track')
  expect(widthOf(parts[0]) + GAP_PX + agentsPxOf('●▾1 · 0') + GAP_PX + 1 + GAP_PX + 72).toBe(rowW)
})

test('the RAM poll writes the ram atom (Windows probe mocked)', IT, async ($, on) => {
  const c = world(on)
  let free = 8 * 1024 * 1024
  winRam(on, () => free)
  await start($)
  await c.settle()
  const ui = await mount($, 'desktop', { bodyColumns: 200 })
  expect(await drawn(ui)).toContain('8/16 GB')
  const t = await mount($, 'terminal')
  expect(await drawn(t)).toContain('8/16 GB')

  free = 4 * 1024 * 1024
  await c.advance(5_000)
  expect(await drawn(ui)).toContain('12/16 GB')
})

test('PowerShell refused: the wmic fallback reads the RAM', IT, async ($, on) => {
  const c = world(on)
  mock.env(on, { OS: 'Windows_NT' })
  const asked: string[] = []
  on('process.run', async (_, e) => {
    asked.push(e.argv[0] ?? '')
    if (e.argv[0] === 'powershell.exe') return { deny: 'not on this surface' }
    return {
      value: {
        exitCode: 0,
        stdout: '\r\r\nFreePhysicalMemory=4194304\r\r\nTotalVisibleMemorySize=16777216\r\r\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  await start($)
  await c.settle()
  const ui = await mount($, 'desktop')
  const text = await drawn(ui)
  expect(text).toContain('12/16 GB')
  expect(text).not.toContain('RAM ?')
  expect(asked).toEqual(['powershell.exe', 'cmd.exe'])
  // The probe that worked is tried first from then on.
  await c.advance(5_000)
  expect(asked.slice(2)).toEqual(['cmd.exe'])
})

test('every probe failing: RAM ? with the reason in alt, logged once', IT, async ($, on) => {
  const c = world(on)
  mock.env(on, { OS: 'Windows_NT' })
  const logs: string[] = []
  on('ui.log', async (_, e, next) => {
    logs.push(e.text)
    return next(e)
  })
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'powershell.exe') return { deny: 'blocked' }
    return {
      value: { exitCode: 1, stdout: '', stderr: 'wmic: not found', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  await start($)
  await c.settle()
  const ui = await mount($, 'desktop')
  const ram = await ramOf(ui)
  expect(widthOf(ram)).toBe(RAM_W)
  expect(String(ram?.props?.source)).toContain('>RAM ?</text>')
  const alt = String(ram?.props?.alt)
  expect(alt).toContain('RAM ?')
  expect(alt).toContain('process.run refused')
  expect(alt).toContain('cmd.exe exit 1: wmic: not found')
  const t = await mount($, 'terminal')
  expect(await drawn(t)).toContain('RAM ?')

  await c.advance(15_000)
  const ramLogs = logs.filter(l => l.includes('RAM unavailable'))
  expect(ramLogs).toHaveLength(1)
  expect(ramLogs[0]).toContain('process.run refused')
})

test('linux: /proc/meminfo through fs.read; a later parse failure keeps the value', IT, async ($, on) => {
  const c = world(on)
  let text = 'MemTotal:       16777216 kB\nMemAvailable:    8388608 kB\n'
  on('fs.read', async () => ({ value: text }))
  await start($)
  await c.settle()
  const ui = await mount($, 'desktop')
  expect(await drawn(ui)).toContain('8/16 GB')
  text = 'nonsense'
  await c.advance(5_000)
  const ram = await ramOf(ui)
  expect(String(ram?.props?.source)).toContain('8/16 GB')
  expect(String(ram?.props?.alt)).toContain('parse failed (linux)')
})

test('desktop divider: the top-row separator x carries on down through the agent rows', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'desktop', { bodyColumns: 150 })
  await spawn($)
  await ui.redraw()
  await ui.press({ key: 'agents' })
  const tree = await ui.drawn()
  const parts = desktopParts(tree)
  expect(parts.map(roleOf)).toEqual(['main', 'agents', 'sep', 'ram'])
  const sep = parts[2]
  expect(Number(sep?.props?.height)).toBe(30)
  expect(String(sep?.props?.source)).toContain('height="30"')
  // The separator's x: main + gap + agents + gap (the RAM card follows after sep + gap).
  const label = String(parts[1]?.props?.label)
  const sepX = widthOf(parts[0]) + GAP_PX + agentsPxOf(label) + GAP_PX
  expect(sepX + 1 + GAP_PX + RAM_W).toBe(rowWOf(150))
  const rows = (JSON.stringify(tree).match(/"source":"<svg.*?<\/svg>/g) ?? [])
    .map(s => s.replace(/\\"/g, '"'))
    .filter(s => s.includes('pba-'))
  expect(rows.length).toBe(1)
  for (const r of rows) {
    expect(r).toContain(`width="${rowWOf(150)}" height="18"`)
    expect(r).toContain(`<rect class="pba-sep" x="${sepX}" y="0" width="1" height="18"/>`)
    expect(r).toContain('#e4e4e1')
    expect(r).toContain('#333331')
    // The right text (anchored at its end) and the bar end before the divider.
    const m = r.match(/class="pba-s" x="(\d+(?:\.\d+)?)"[^>]*text-anchor="end"/)
    expect(Number(m?.[1])).toBe(sepX - 10)
    for (const b of r.matchAll(/class="pba-k" x="(\d+(?:\.\d+)?)" y="[^"]*" width="(\d+(?:\.\d+)?)"/g))
      expect(Number(b[1]) + Number(b[2])).toBeLessThan(sepX - 10)
  }
})
