import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'
import { mainRowGeometry } from '../hooks/main-row'
import { pct, textWidth } from '../hooks/shared'

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

// The desktop's row geometry, as register.tsx estimates it: the widths the
// pictures' geometry is designed at, never their drawn widths (they fill
// their slots, px tall, the bars in percentages of the real width).
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
  props?: {
    key?: string
    width?: unknown
    height?: unknown
    source?: unknown
    label?: unknown
    alt?: unknown
    flexGrow?: unknown
    flexShrink?: unknown
    flexWrap?: unknown
    flexDirection?: unknown
  }
  children?: unknown[]
}
const kids = (n: unknown): Node[] => ((n as Node)?.children ?? []).filter((c): c is Node => !!c && typeof c === 'object')
const firstRow = (tree: unknown): Node[] => kids(kids(tree)[0])
const keyOf = (k: Node | undefined): string => k?.props?.key ?? k?.type ?? '?'
// A slot Box holding one Svg stands for that Svg.
const unwrap = (n: Node | undefined): Node | undefined => {
  const inner = n?.type === 'Box' ? kids(n) : []
  return inner.length === 1 && inner[0]?.type === 'Svg' ? inner[0] : n
}
// The desktop band: [left column] [right zone Box > Svg].
const desktopCols = (tree: unknown): { left: Node[]; right: Node | undefined; rightBox: Node | undefined } => {
  const [left, right] = kids(tree)
  return { left: kids(left), right: unwrap(right), rightBox: right }
}
// The desktop band flattened: the top row (main bar, agents?), then the right zone.
const desktopParts = (tree: unknown): Node[] => {
  const { left, right } = desktopCols(tree)
  return [...kids(left[0]).map(n => unwrap(n) ?? n), ...(right ? [right] : [])]
}
// The root <svg …> tag of a picture.
const rootTag = (n: Node | undefined): string => String(n?.props?.source ?? '').match(/^<svg[^>]*>/)?.[0] ?? ''
// As wide as its slot and `h` px tall, one unit to the pixel: the root says
// width="100%" and its px height, no viewBox; the Svg element carries `height` alone.
function expectPx(n: Node | undefined, h: number): void {
  expect(n?.type).toBe('Svg')
  expect(n?.props?.width).toBeUndefined()
  expect(n?.props?.height).toBe(h)
  const root = rootTag(n)
  expect(root.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${h}"`)).toBe(true)
  expect(root).not.toContain('viewBox')
  expect(root).not.toContain('preserveAspectRatio')
}
// The main row designed at `w`: its track spans the shares mainRowGeometry(w) lays out.
function expectMainDesign(n: Node | undefined, w: number): void {
  const g = mainRowGeometry(w)
  expect(String(n?.props?.source)).toContain(
    `<rect class="pbm-k" x="${pct(g.barX / g.W)}" y="4" width="${pct(g.barW / g.W)}" height="22" rx="11"/>`,
  )
}
const unxml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
// An agent row designed at `w`: its right text 4px in from the real right
// edge, its bar ending GAP (10) left of the right slot (at least as wide as
// `ctx 100% · 999k tok · 00:00`), as a share of `w`.
function expectRowDesign(n: Node | undefined, w: number): void {
  const r = String(n?.props?.source)
  expect(r).not.toContain('pba-sep')
  expect(r).toMatch(/class="pba-s" x="100%" y="13" transform="translate\(-4,0\)" text-anchor="end"/)
  const right = unxml(r.match(/class="pba-s"[^>]*>([^<]*)<\/text>/)?.[1] ?? '')
  const rightW = Math.ceil(Math.max(textWidth('ctx 100% · 999k tok · 00:00', 11), textWidth(right, 11)))
  const b = r.match(/class="pba-k" x="([\d.]+)%" y="[^"]*" width="([\d.]+)%"/)
  expect(b).not.toBeNull()
  const end = Number(b?.[1]) + Number(b?.[2])
  expect(Math.abs(end - ((w - 4 - rightW - 10) / w) * 100)).toBeLessThanOrEqual(0.011)
}
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
// The right zone at `cols` body columns and `height`: one Svg, designed at
// ~20% of the row, a visible divider down its left edge, the RAM card
// centered right of it.
function expectZone(n: Node | undefined, cols: number, height: number): void {
  const w = rightWOf(cols)
  expect(Math.abs(w - rowWOf(cols) * 0.2)).toBeLessThanOrEqual(GAP_PX + 1)
  // As tall as the left column, drawn at the zone's real width.
  expectPx(n, height)
  const src = String(n?.props?.source)
  expect(src).toContain(`<line id="pbz-line" class="pbz-l" x1="0.5" y1="2" x2="0.5" y2="${height - 2}"`)
  expect(src).toContain('#c8c7c2')
  expect(src).toContain('#5c5b57')
  expect(src).toContain('pbram-card')
  expect(src).toMatch(/RAM|%</)
  const area = w - 8
  const cardW = Math.min(160, area - 8)
  // The card in px around a zero-width <svg> at 50%: its middle at 50% + 4px,
  // the middle of the area right of the divider at any real width.
  expect(src.match(/<svg/g)?.length).toBe(2)
  expect(src).toContain('<svg x="50%" y="0" width="1" height="30" overflow="visible"><g id="pbz-card"')
  const x = src.match(/<g id="pbz-card" transform="translate\((-?\d+),0\)">/)
  const m = src.match(/<rect id="pbram-card" class="k" x="0" y="0" width="(\d+)" height="30"/)
  expect(Number(m?.[1])).toBe(cardW)
  expect(Math.abs(Number(x?.[1]) + cardW / 2 - 4)).toBeLessThanOrEqual(0.5)
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
  expect(parts.some(n => /\swidth="1"/.test(rootTag(n)))).toBe(false)
  expect(JSON.stringify(tree)).not.toContain('pbs-l')
  const rowW = rowWOf(100)
  expect(rowW).toBeGreaterThanOrEqual(500)
  // The columns are shares of the real row, never numbers (a Box's numbers are not px).
  expect((kids(tree)[0]?.props as { width?: unknown })?.width).toBe('80%')
  expect(desktopCols(tree).rightBox?.props?.width).toBe('20%')
  // No agents: the main bar is designed as the whole left column, and fills its slot.
  expectPx(parts[0], 30)
  expectMainDesign(parts[0], leftWOf(100))
  expectZone(parts[1], 100, 30)
  // left + gap + right: exactly the (conservative) row the pictures are designed at.
  expect(leftWOf(100) + GAP_PX + rightWOf(100)).toBe(rowW)
})

test('desktop band: every Svg as wide as its column slot and px tall, in percentage slots that never wrap', IT, async ($, on) => {
  world(on, true)
  await start($)
  const ui = await mount($, 'desktop', { bodyColumns: 150 })
  for (const i of [1, 2])
    await $.agent.spawn({
      prompt: 'Look around.',
      description: `Scout ${i}`,
      subagentType: i === 1 ? 'savvy-flow:savvy-light' : 'Explore',
      tool_use_id: `toolu_${i}`,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
    })
  await ui.redraw()
  await ui.press({ key: 'agents' })
  const tree = await ui.drawn()
  const root = tree as Node
  // The row and the top row say nowrap: 80% + gap + 20% must not push the right zone down.
  expect(root.props?.flexWrap).toBe('nowrap')
  expect(root.props?.width).toBe('100%')
  const [leftBox, rightBox] = kids(tree)
  expect(leftBox?.props?.width).toBe('80%')
  expect(leftBox?.props?.flexShrink).toBe(0)
  expect(rightBox?.props?.width).toBe('20%')
  expect(rightBox?.props?.flexShrink).toBe(1)
  // A column: it stretches the right zone's Svg to its width.
  expect(rightBox?.props?.flexDirection).toBe('column')
  const top = kids(leftBox)[0]
  expect(top?.props?.width).toBe('100%')
  expect(top?.props?.flexWrap).toBe('nowrap')
  // The main bar's slot grows into what the agents button leaves, a column
  // that stretches its Svg across; the agent rows sit in the left column.
  expect(leftBox?.props?.flexDirection).toBe('column')
  const [mainSlot, agents] = kids(top)
  expect(mainSlot?.type).toBe('Box')
  expect(mainSlot?.props?.flexGrow).toBe(1)
  expect(mainSlot?.props?.flexShrink).toBe(1)
  expect(mainSlot?.props?.flexDirection).toBe('column')
  expect(roleOf(agents)).toBe('agents')

  // Every picture: width="100%" and its px height on its root, no viewBox; the height prop alone.
  const svgs: Node[] = []
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    if ((n as Node).type === 'Svg') svgs.push(n as Node)
    for (const c of (n as Node).children ?? []) walk(c)
  }
  walk(tree)
  expect(svgs.length).toBe(4)
  const leftW = leftWOf(150)
  const label = String(agents?.props?.label)
  expectPx(svgs[0], 30)
  expectMainDesign(svgs[0], leftW - agentsPxOf(label) - GAP_PX)
  expectPx(svgs[1], 18)
  expectRowDesign(svgs[1], leftW)
  expectPx(svgs[2], 18)
  expectRowDesign(svgs[2], leftW)
  expectZone(svgs[3], 150, 30 + 18 * 2)
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
    expectPx(parts[0], 30)
    expectMainDesign(parts[0], leftWOf(cols) - GAP_PX - agentsPxOf('●▾1 · 0'))
    expect(leftWOf(cols) + GAP_PX + rightWOf(cols)).toBe(rowW)
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
  expectMainDesign(parts[0], leftWOf(cols) - GAP_PX - agentsPxOf('●▾1 · 0'))
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
  // PowerShell hangs: that poll stops there (no other probe), the last reading stays.
  expect(asked.slice(1)).toEqual(['powershell.exe -NoProfile'])
  expect(String((await ramOf(ui))?.props?.source)).toContain('8/16 GB')
  // Backed off 20 s; the next poll starts from the following probe.
  await c.advance(10_000)
  expect(asked).toHaveLength(2)
  await c.advance(20_000)
  const ram = await ramOf(ui)
  // 16 GB known from PowerShell, 4 GB available: 12 GB in use.
  expect(String(ram?.props?.source)).toContain('12/16 GB')
  expect(String(ram?.props?.alt)).toBe('RAM 12/16 GB')
  expect(asked.slice(2, 4)).toEqual(['typeperf.exe \\Memory\\Available MBytes', 'typeperf.exe \\Memoria\\MByte disponibili'])
  // The probe that worked is tried first from then on.
  const before = asked.length
  await c.advance(10_000)
  expect(asked.slice(before)).toEqual(['typeperf.exe \\Memoria\\MByte disponibili'])
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
  // Nothing goes to the transcript: a missed reading is not the person's problem.
  expect(ramLogs).toHaveLength(0)

  // A success clears it, at the first poll after the back-off (at most 5 min).
  isOk = true
  await c.advance(300_000)
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
  expect(ramLogs).toHaveLength(0)
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
    expect(kids(left[0]).map(n => roleOf(unwrap(n)))).toEqual(['main', 'agents'])
    const rows = left.slice(1)
    expect(rows.length).toBe(count)
    // The right zone: one Svg spanning the main bar and every agent row, divider + RAM inside.
    expect(roleOf(right)).toBe('ram')
    expectZone(right, 150, 30 + 18 * count)
    // Agent rows designed at the left column's width, filling it; no divider of their own; right text ends 4px short.
    const leftW = leftWOf(150)
    for (const n of rows) {
      expectPx(n, 18)
      expectRowDesign(n, leftW)
    }
    // The main bar: designed at the left column less the agents estimate and its gap.
    expectMainDesign(unwrap(kids(left[0])[0]), leftW - agentsPxOf(String(kids(left[0])[1]?.props?.label)) - GAP_PX)
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
