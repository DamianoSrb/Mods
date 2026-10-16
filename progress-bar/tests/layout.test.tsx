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
// 24px of safety under the bodyColumns estimate, so the row never wraps.
const rowWOf = (cols: number): number => Math.max(180, Math.min(1600, cols * 8 - 96 - 24))
// The left column takes 80% of the row, the right zone (divider + RAM) the rest less a gap.
const leftWOf = (cols: number): number => Math.round(rowWOf(cols) * 0.8)
const rightWOf = (cols: number): number => rowWOf(cols) - leftWOf(cols) - GAP_PX
const agentsPxOf = (label: string): number => Math.ceil(label.length * 7.5) + 24

// With `isMulti`, each spawn gets its own agent id (one row per agent).
function world(on: On, isMulti = false): MockClock {
  const clock = mock.clock(on, { now: 1_000 })
  let n = 0
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_, e) => ({ value: { tool: `mcp__progress-bar__${e.name}` } }))
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: isMulti ? `agent-${++n}` : 'agent-1' }))
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
// The desktop band: [left column] [right zone Svg].
const desktopCols = (tree: unknown): { left: Node[]; right: Node | undefined } => {
  const [left, right] = kids(tree)
  return { left: kids(left), right }
}
// The desktop band flattened: the top row (main bar, agents?), then the right zone.
const desktopParts = (tree: unknown): Node[] => {
  const { left, right } = desktopCols(tree)
  return [...kids(left[0]), ...(right ? [right] : [])]
}
const widthOf = (n: Node | undefined): number => Number(n?.props?.width ?? 0)
// What a row part is: by key where the drawing keeps one, else by what it draws.
const roleOf = (n: Node | undefined): string => {
  if (n?.props?.key) return n.props.key
  const src = String(n?.props?.source ?? '')
  if (n?.type === 'Svg' && src.includes('pbram-card')) return 'ram'
  if (n?.type === 'Svg' && src.includes('pbm-k')) return 'main'
  const text = JSON.stringify(n ?? {})
  if (text.includes('│')) return 'sep'
  if (text.includes('"RAM')) return 'ram'
  return keyOf(n)
}
// The right zone at `cols` body columns and `height`: one Svg, ~20% of the row,
// a visible divider down its left edge, the RAM card centered right of it.
function expectZone(n: Node | undefined, cols: number, height: number): void {
  const w = rightWOf(cols)
  expect(n?.type).toBe('Svg')
  expect(Math.abs(widthOf(n) - rowWOf(cols) * 0.2)).toBeLessThanOrEqual(GAP_PX + 1)
  expect(widthOf(n)).toBe(w)
  expect(Number(n?.props?.height)).toBe(height)
  const src = String(n?.props?.source)
  expect(src).toContain(`width="${w}" height="${height}"`)
  expect(src).toContain(`<line id="pbz-line" class="pbz-l" x1="0.5" y1="2" x2="0.5" y2="${height - 2}"`)
  expect(src).toContain('#c8c7c2')
  expect(src).toContain('#5c5b57')
  expect(src).toContain('pbram-card')
  expect(src).toMatch(/RAM|%</)
  const area = w - 8
  const cardW = Math.min(160, area - 8)
  // One <svg>: the card is inlined in a translated group, never nested.
  expect(src.match(/<svg/g)?.length).toBe(1)
  const x = src.match(/<g id="pbz-card" transform="translate\((\d+),0\)">/)
  const m = src.match(/<rect id="pbram-card" class="k" x="0" y="0" width="(\d+)" height="30"/)
  expect(Number(m?.[1])).toBe(cardW)
  expect(Math.abs(Number(x?.[1]) - ((area - cardW) / 2 + 8))).toBeLessThanOrEqual(1)
  // The alt is short: never a failure's reason.
  const alt = String(n?.props?.alt)
  expect(alt).toMatch(/^RAM( \?| \d+(\.\d)?\/\d+(\.\d)? [KMGT]?B)?$/)
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

test('desktop row without agents: [main] [right zone 20%], no 1px divider Svg', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'desktop')
  const tree = await ui.drawn()
  expect(((tree as Node)?.props as { justifyContent?: string; alignItems?: string })?.justifyContent).toBe('flex-start')
  expect(((tree as Node)?.props as { alignItems?: string })?.alignItems).toBe('flex-start')
  expect(kids(tree).length).toBe(2)
  const parts = desktopParts(tree)
  expect(parts.map(roleOf)).toEqual(['main', 'ram'])
  expect(parts.some(n => widthOf(n) === 1)).toBe(false)
  expect(JSON.stringify(tree)).not.toContain('pbs-l')
  const rowW = rowWOf(100)
  expect(rowW).toBeGreaterThanOrEqual(500)
  // The left column is sized as a share of the real row, never as a number (a Box's numbers are not px).
  expect((kids(tree)[0]?.props as { width?: unknown })?.width).toBe('80%')
  // No agents: the main bar is the whole left column.
  expect(widthOf(parts[0])).toBe(leftWOf(100))
  expectZone(parts[1], 100, 30)
  // left + gap + right: exactly the (conservative) row.
  expect(leftWOf(100) + GAP_PX + widthOf(parts[1])).toBe(rowW)
})

for (const cols of [100, 150, 200]) {
  test(`desktop row with agents at ${cols} cols: the right zone keeps 20% at the far right`, IT, async ($, on) => {
    world(on)
    await start($)
    const ui = await mount($, 'desktop', { bodyColumns: cols })
    await spawn($)
    await ui.redraw()
    const parts = desktopParts(await ui.drawn())
    expect(parts.map(roleOf)).toEqual(['main', 'agents', 'ram'])
    expect(parts[1]?.props?.label).toBe('●▾1 · 0')
    const rowW = rowWOf(cols)
    expect(rowW).toBeGreaterThanOrEqual(500)
    expectZone(parts[2], cols, 30)
    // main + gap + agents = left column; + gap + right zone = row.
    expect(widthOf(parts[0]) + GAP_PX + agentsPxOf('●▾1 · 0')).toBe(leftWOf(cols))
    expect(leftWOf(cols) + GAP_PX + widthOf(parts[2])).toBe(rowW)
  })
}

test('desktop row under 500px: the narrow card shows the percent only, still present', IT, async ($, on) => {
  const c = world(on)
  winRam(on, () => 8 * 1024 * 1024)
  await start($)
  await c.settle()
  const cols = 60
  const ui = await mount($, 'desktop', { bodyColumns: cols })
  await spawn($)
  await ui.redraw()
  const parts = desktopParts(await ui.drawn())
  expect(parts.map(roleOf)).toEqual(['main', 'agents', 'ram'])
  const rowW = rowWOf(cols)
  expect(rowW).toBeLessThan(500)
  expectZone(parts[2], cols, 30)
  const src = String(parts[2]?.props?.source)
  expect(src).toContain('>50%</text>')
  expect(src).not.toContain('pbram-track')
  expect(widthOf(parts[0]) + GAP_PX + agentsPxOf('●▾1 · 0')).toBe(leftWOf(cols))
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
  await c.advance(10_000)
  expect(await drawn(ui)).toContain('12/16 GB')
})

// What `$.process.run` resolves with.
const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
// typeperf's CSV, Italian Windows: `mb` MB available.
const typeperfOut = (mb: number): string =>
  '\r\n"(PDH-CSV 4.0)","\\\\PC\\Memoria\\MByte disponibili"\r\n' +
  `"10/16/2026 13:40:49.703","${mb}.000000"\r\nUscita in corso. Attendere...\r\nEsecuzione comando riuscita.\r\n\r\n`
const PS_OK = `${16 * 1024 * 1024} ${8 * 1024 * 1024}\r\n`
const TIMEOUT = 'progress-bar: $.process.run(powershell.exe) aborted: still running after 15000ms'

test('PowerShell probe: 15 s timeout', IT, async ($, on) => {
  const c = world(on)
  mock.env(on, { OS: 'Windows_NT' })
  const timeouts: (number | undefined)[] = []
  on('process.run', async (_, e) => {
    timeouts.push(e.init?.timeoutMs)
    return ran(PS_OK)
  })
  await start($)
  await c.settle()
  expect(timeouts).toEqual([15000])
})

test('PowerShell timing out: typeperf (English, then Italian) reads RAM with the cached total', IT, async ($, on) => {
  const c = world(on)
  mock.env(on, { OS: 'Windows_NT' })
  let isPsOk = true
  const asked: string[] = []
  on('process.run', async (_, e) => {
    asked.push(e.argv.slice(0, 2).join(' '))
    if (e.argv[0] === 'powershell.exe') return isPsOk ? ran(PS_OK) : { deny: TIMEOUT }
    if (e.argv[1] === '\\Memory\\Available MBytes') return ran('\r\nErrore: nessun contatore valido.\r\n', 1)
    return ran(typeperfOut(4096))
  })
  await start($)
  await c.settle()
  const ui = await mount($, 'desktop')
  expect(await drawn(ui)).toContain('8/16 GB')
  expect(asked).toEqual(['powershell.exe -NoProfile'])

  isPsOk = false
  await c.advance(10_000)
  const ram = await ramOf(ui)
  // 16 GB known from PowerShell, 4 GB available: 12 GB in use.
  expect(String(ram?.props?.source)).toContain('12/16 GB')
  expect(String(ram?.props?.alt)).toBe('RAM 12/16 GB')
  expect(asked.slice(1)).toEqual([
    'powershell.exe -NoProfile',
    'typeperf.exe \\Memory\\Available MBytes',
    'typeperf.exe \\Memoria\\MByte disponibili',
  ])
  // The probe that worked is tried first from then on.
  await c.advance(10_000)
  expect(asked.slice(4)).toEqual(['typeperf.exe \\Memoria\\MByte disponibili'])
})

test('no total known yet: typeperf is not run and the card shows RAM ?', IT, async ($, on) => {
  const c = world(on)
  mock.env(on, { OS: 'Windows_NT' })
  const asked: string[] = []
  on('process.run', async (_, e) => {
    asked.push(e.argv[0] ?? '')
    if (e.argv[0] === 'powershell.exe') return { deny: TIMEOUT }
    return ran(typeperfOut(4096))
  })
  await start($)
  await c.settle()
  const ui = await mount($, 'desktop')
  const ram = await ramOf(ui)
  expect(String(ram?.props?.source)).toContain('>RAM ?</text>')
  expect(String(ram?.props?.alt)).toBe('RAM ?')
  expect(asked).toEqual(['powershell.exe'])
})

test('a failed poll within 60 s keeps the last reading; past 60 s RAM ?, logged once', IT, async ($, on) => {
  const c = world(on)
  mock.env(on, { OS: 'Windows_NT' })
  const logs: string[] = []
  on('ui.log', async (_, e, next) => {
    logs.push(e.text)
    return next(e)
  })
  let isOk = true
  on('process.run', async (_, e) => {
    if (isOk) return ran(PS_OK)
    if (e.argv[0] === 'powershell.exe') return { deny: TIMEOUT }
    return ran('\r\nErrore: nessun contatore valido.\r\n', 1)
  })
  await start($)
  await c.settle()
  const ui = await mount($, 'desktop')
  const t = await mount($, 'terminal')
  expect(await drawn(ui)).toContain('8/16 GB')

  isOk = false
  // t+10 s: failed, the reading stays, nothing said.
  await c.advance(10_000)
  let ram = await ramOf(ui)
  expect(String(ram?.props?.source)).toContain('8/16 GB')
  expect(String(ram?.props?.source)).not.toContain('RAM ?')
  expect(String(ram?.props?.alt)).toBe('RAM 8/16 GB')
  expect(await drawn(t)).toContain('8/16 GB')
  expect(await drawn(t)).not.toContain('RAM ?')
  // t+50 s: still within the grace time.
  await c.advance(40_000)
  expect(String((await ramOf(ui))?.props?.source)).toContain('8/16 GB')
  expect(logs.filter(l => l.includes('RAM unavailable'))).toHaveLength(0)

  // t+70 s: no success for over 60 s.
  await c.advance(20_000)
  ram = await ramOf(ui)
  expectZone(ram, 100, 30)
  expect(String(ram?.props?.source)).toContain('>RAM ?</text>')
  expect(String(ram?.props?.source)).not.toContain('8/16 GB')
  const alt = String(ram?.props?.alt)
  expect(alt).toBe('RAM ?')
  expect(alt).not.toContain('process.run')
  expect(await drawn(t)).toContain('RAM ?')
  expect(await drawn(t)).not.toContain('process.run')

  await c.advance(30_000)
  const ramLogs = logs.filter(l => l.includes('RAM unavailable'))
  expect(ramLogs).toHaveLength(1)
  // The full reason chain goes to the log only.
  expect(ramLogs[0]).toContain('still running after 15000ms')
  expect(ramLogs[0]).toContain('typeperf.exe exit 1')

  // A success clears it.
  isOk = true
  await c.advance(10_000)
  expect(String((await ramOf(ui))?.props?.source)).toContain('8/16 GB')
})

test('polls never overlap: a slow probe makes the next ticks skip', IT, async ($, on) => {
  const c = world(on)
  mock.env(on, { OS: 'Windows_NT' })
  let calls = 0
  on('process.run', async () => {
    calls++
    // Every call after the first takes 25 s.
    if (calls > 1) await c.sleep(25_000)
    return ran(PS_OK)
  })
  await start($)
  await c.settle()
  expect(calls).toBe(1)
  // t+10 s starts a 25 s probe; the ticks at t+20 s and t+30 s find it running.
  await c.advance(34_000)
  expect(calls).toBe(2)
  // It ended at t+35 s: the tick at t+40 s polls again.
  await c.advance(6_000)
  expect(calls).toBe(3)
})

test('every probe failing from the start: RAM ? with a short alt, the reason logged once', IT, async ($, on) => {
  const c = world(on)
  mock.env(on, { OS: 'Windows_NT' })
  const logs: string[] = []
  on('ui.log', async (_, e, next) => {
    logs.push(e.text)
    return next(e)
  })
  on('process.run', async () => ({ deny: 'blocked' }))
  await start($)
  await c.settle()
  const ui = await mount($, 'desktop')
  const ram = await ramOf(ui)
  expectZone(ram, 100, 30)
  expect(String(ram?.props?.source)).toContain('>RAM ?</text>')
  expect(String(ram?.props?.alt)).toBe('RAM ?')
  expect(String(ram?.props?.source)).not.toContain('process.run')
  const t = await mount($, 'terminal')
  expect(await drawn(t)).toContain('RAM ?')
  expect(await drawn(t)).not.toContain('process.run')

  await c.advance(30_000)
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
  await c.advance(10_000)
  const ram = await ramOf(ui)
  expect(String(ram?.props?.source)).toContain('8/16 GB')
  expect(String(ram?.props?.alt)).toBe('RAM 8/16 GB')
})

for (const count of [1, 3]) {
  test(`desktop band with ${count} agent row(s): [left column 80%] [right zone 20% × (30+18n)]`, IT, async ($, on) => {
    world(on, true)
    await start($)
    const ui = await mount($, 'desktop', { bodyColumns: 150 })
    for (let i = 0; i < count; i++)
      await $.agent.spawn({
        prompt: 'Look around.',
        description: `Scout ${i}`,
        subagentType: 'savvy-flow:savvy-light',
        tool_use_id: `toolu_${i + 1}`,
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-opus-5-5',
        background: true,
        fork: false,
      })
    await ui.redraw()
    await ui.press({ key: 'agents' })
    const tree = await ui.drawn()
    const { left, right } = desktopCols(tree)
    expect(kids(tree).length).toBe(2)
    // Left column: the top row [main, agents], then the agent rows.
    expect(kids(left[0]).map(roleOf)).toEqual(['main', 'agents'])
    const rows = left.slice(1)
    expect(rows.length).toBe(count)
    // The right zone: one Svg spanning the main bar and every agent row, divider + RAM inside.
    expect(roleOf(right)).toBe('ram')
    expectZone(right, 150, 30 + 18 * count)
    // Agent rows at the left column's width; no divider of their own; right text ends 4px short.
    const leftW = leftWOf(150)
    for (const n of rows) {
      expect(widthOf(n)).toBe(leftW)
      const r = String(n.props?.source)
      expect(r).toContain(`width="${leftW}" height="18"`)
      expect(r).not.toContain('pba-sep')
      const m = r.match(/class="pba-s" x="(\d+(?:\.\d+)?)"[^>]*text-anchor="end"/)
      expect(Number(m?.[1])).toBe(leftW - 4)
      for (const b of r.matchAll(/class="pba-k" x="(\d+(?:\.\d+)?)" y="[^"]*" width="(\d+(?:\.\d+)?)"/g))
        expect(Number(b[1]) + Number(b[2])).toBeLessThan(leftW - 4)
    }
    // The main bar: the left column less the agents estimate and its gap.
    expect(widthOf(kids(left[0])[0])).toBe(leftW - agentsPxOf(String(kids(left[0])[1]?.props?.label)) - GAP_PX)
  })
}

test('desktop band, agents closed: the right zone is the main bar tall', IT, async ($, on) => {
  world(on)
  await start($)
  const ui = await mount($, 'desktop', { bodyColumns: 150 })
  await spawn($)
  await ui.redraw()
  const { left, right } = desktopCols(await ui.drawn())
  expect(left.length).toBe(1)
  expectZone(right, 150, 30)
})

test('desktop band cut by maxRows: the right zone includes the +N line', IT, async ($, on) => {
  world(on, true)
  await start($)
  const ui = await mount($, 'desktop', { bodyColumns: 150, maxRows: 3 })
  for (let i = 0; i < 4; i++)
    await $.agent.spawn({
      prompt: 'Look around.',
      description: `Scout ${i}`,
      subagentType: 'savvy-flow:savvy-light',
      tool_use_id: `toolu_${i + 1}`,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
    })
  await ui.redraw()
  await ui.press({ key: 'agents' })
  const tree = await ui.drawn()
  const { left, right } = desktopCols(tree)
  // maxRows 3: main + 1 row + the "+N" line.
  const svgRows = left.slice(1).filter(n => n.type === 'Svg')
  expect(svgRows.length).toBe(1)
  expect(JSON.stringify(left)).toContain('+3')
  expectZone(right, 150, 30 + 18 + 18)
})
