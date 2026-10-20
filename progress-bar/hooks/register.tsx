import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { ProgressBarPhase, ProgressBarPlannedTask } from '../types'
import {
  agentsSummary,
  buildAgentRows,
  buildMainModel,
  isPlanComplete,
  normTitle,
  planAfterCall,
  type AgentRowModel,
  type AgentRun,
  type Flow,
  type Plan,
  type PlanCall,
} from './model'
import { STRINGS, fmtTokens, pickLang, type Lang, type TerminalUi, type TimeStyle } from './shared'
import { MAIN_H, mainRowSvg, mainRowTerminal, turnSeed } from './main-row'
import { AGENT_ROW_H, agentRowSvg, agentRowTerminal, type Branch } from './agent-rows'
import { RAM_GRACE_MS, RAM_POLL_MS, fmtRamPair, parseRam, ramProbes, type RamInfo, type RamProbe } from './ram'
import { ramAltText, ramCardTerminal, rightZoneSvg } from './ram-card'

// This mod's own values; it tracks everything itself.
const flow = atom({ plugin: 'progress-bar', key: 'flow' } as const, null as Flow | null)
const agents = atom({ plugin: 'progress-bar', key: 'agents' } as const, [] as AgentRun[])
// The main loop's task list (update_plan / TodoWrite), for the working estimate.
const plan = atom({ plugin: 'progress-bar', key: 'plan' } as const, null as Plan | null)
const startedAt = atom({ plugin: 'progress-bar', key: 'startedAt' } as const, null)
const endedAt = atom({ plugin: 'progress-bar', key: 'endedAt' } as const, null)
const tools = atom({ plugin: 'progress-bar', key: 'tools' } as const, 0)
const now = atom({ plugin: 'progress-bar', key: 'now' } as const, 0)
const isExpanded = atom({ plugin: 'progress-bar', key: 'isExpanded' } as const, false)
// System RAM in use, polled every RAM_POLL_MS; null until the first reading.
const ram = atom({ plugin: 'progress-bar', key: 'ram' } as const, null as RamInfo | null)
// A short code ('timeout' | 'unavailable') once no reading succeeded for
// RAM_GRACE_MS (or none ever), or null: the card then shows `RAM ?`.
const ramError = atom({ plugin: 'progress-bar', key: 'ramError' } as const, null as string | null)

// ---------------------------------------------------------------------------
// System RAM: the platform found once per load, then a poll that never overlaps.

// Module scope is fine: none is drawn, and session.start sets them again on (re)load.
let ramPlatform: string | null = null
let isRamPolling = false
// The probe that last worked: tried first on the next poll.
let ramProbeIndex = 0
// The total of the last reading that had one (PowerShell's): typeperf reads only the available memory.
let ramKnownTotal: number | null = null
// When the last reading succeeded ($.clock time), or null before any.
let ramLastOkAt: number | null = null
// The full failure reason goes to the transcript once per load, never to the card.
let isRamErrorLogged = false

function logRamErrorOnce($: EngineInterface, reason: string): void {
  if (isRamErrorLogged) return
  isRamErrorLogged = true
  try {
    // Declared on every surface in the d.ts; the validator forbids probing `$.ui` as a value.
    $.ui.log(`progress-bar: RAM unavailable: ${reason}`)
  } catch {
    // No transcript here: the card still shows RAM ?.
  }
}

// The short code a failed poll's reasons come to.
const ramErrorCode = (reason: string): string =>
  /still running after|timed? ?out/i.test(reason) ? 'timeout' : 'unavailable'

/**
 * A poll failed for `reason` (every probe's, joined). While the last good
 * reading is younger than RAM_GRACE_MS nothing changes: the card keeps it.
 * Past that, or with no reading ever, ramError takes a short code (the card
 * shows `RAM ?`) and the full reason is logged, once per load.
 */
async function ramPollFailed($: EngineInterface, reason: string): Promise<void> {
  if (ramLastOkAt !== null) {
    let at: number | null = null
    try {
      at = await $.clock.now()
    } catch {
      // No clock: treat the reading as stale.
    }
    if (at !== null && at - ramLastOkAt < RAM_GRACE_MS) return
  }
  const text = reason.trim() || 'failed'
  const code = ramErrorCode(text)
  if ((await read($, ramError)) !== code) await update($, ramError, () => code)
  logRamErrorOnce($, text)
}

async function detectPlatform($: EngineInterface): Promise<string | null> {
  try {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'win32'
  } catch {
    // No environment: try the others.
  }
  try {
    if ((await $.fs.read('/proc/meminfo')).includes('MemTotal')) return 'linux'
  } catch {
    // No /proc: not Linux, or no fs.
  }
  try {
    const { stdout } = await $.process.run(['uname', '-s'], { timeoutMs: 4000 })
    if (stdout.trim() === 'Darwin') return 'darwin'
  } catch {
    // No process: no RAM card figures.
  }
  return null
}

// Worth a redraw: the first reading, a new total, or a move of at least 1% of the total.
const isRamChanged = (prev: RamInfo | null, next: RamInfo): boolean =>
  !prev ||
  prev.totalBytes !== next.totalBytes ||
  Math.abs(prev.usedBytes - next.usedBytes) >= next.totalBytes * 0.01

/** One probe's reading, or why it gave none. */
async function readProbe($: EngineInterface, probe: RamProbe): Promise<RamInfo | string> {
  // typeperf gives the available memory only: no total yet, no reading (and nothing run).
  if (probe.format === 'typeperf' && ramKnownTotal === null) return 'no total yet (typeperf)'
  let output: string
  if (probe.kind === 'run') {
    let res: { exitCode: number; stdout: string; stderr: string }
    try {
      res = await $.process.run(probe.argv, { timeoutMs: probe.timeoutMs })
    } catch (err) {
      return `process.run refused: ${errorText(err)} (${probe.argv[0]})`
    }
    if (res.exitCode !== 0) {
      const why = (res.stderr || res.stdout || '').trim().split(/\r?\n/)[0]?.slice(0, 80) ?? ''
      return `${probe.argv[0]} exit ${res.exitCode}${why ? `: ${why}` : ''}`
    }
    output = res.stdout
  } else {
    try {
      output = await $.fs.read(probe.path)
    } catch (err) {
      return `fs.read refused: ${errorText(err)} (${probe.path})`
    }
  }
  return parseRam(probe.format, output, ramKnownTotal) ?? `parse failed (${probe.format})`
}

async function pollRam($: EngineInterface): Promise<void> {
  // Never two polls at once: a slow probe (up to its timeout) makes the next ticks skip.
  if (isRamPolling) return
  if (!ramPlatform) {
    await ramPollFailed($, 'platform not detected')
    return
  }
  const probes = ramProbes(ramPlatform)
  if (probes.length === 0) {
    await ramPollFailed($, `no probe for ${ramPlatform}`)
    return
  }
  isRamPolling = true
  try {
    // The probe that worked last time first, then the rest in their order.
    const first = Math.min(ramProbeIndex, probes.length - 1)
    const order = [first, ...probes.map((_, i) => i).filter(i => i !== first)]
    const reasons: string[] = []
    for (const i of order) {
      const probe = probes[i]
      if (!probe) continue
      const got = await readProbe($, probe)
      if (typeof got === 'string') {
        reasons.push(got)
        continue
      }
      ramProbeIndex = i
      if (probe.format !== 'typeperf') ramKnownTotal = got.totalBytes
      try {
        ramLastOkAt = await $.clock.now()
      } catch {
        ramLastOkAt = null
      }
      if ((await read($, ramError)) !== null) await update($, ramError, () => null)
      const prev = (await read($, ram)) ?? null
      if (isRamChanged(prev, got)) await update($, ram, () => got)
      return
    }
    // Every probe failed: the last value stays, silently within the grace time.
    await ramPollFailed($, reasons.join('; '))
  } catch (err) {
    await ramPollFailed($, errorText(err)).catch(() => {})
  } finally {
    isRamPolling = false
  }
}

// The "+N altri" text line under the agent rows, as tall as a row.
const MORE_H = 18

// The desktop band: [left column: main bar + agents?, agent rows] [right zone:
// divider + RAM card], the left column LEFT_SHARE of the row and the right zone
// the rest. The desktop puts ~GAP_PX between siblings.
//
// The pictures are drawn at their slot's real width and a fixed px height:
// each root says width="100%" and its height in px, no viewBox, and each Svg
// gets `height` alone, in a column Box that stretches it across (VS Code draws
// an Svg as an <img> of that height, as wide as the Box stretches it). Text
// and marks keep their px; the bars span in percentages of the real width.
// Their geometry (title slots, the bars' shares, the card's width) is
// DESIGNED at widths estimated from bodyColumns; the slots themselves are
// percentages of the real row. A cell is not 8px everywhere (VS Code's are
// narrower), so the estimate only sets those shares, never the drawn size.
const GAP_PX = 8
// The row width is estimated from bodyColumns; ROW_SAFETY_PX more is held back
// (a design margin, kept so the pictures' proportions stay as they were).
const ROW_SAFETY_PX = 24
const LEFT_SHARE = 0.8
const MAIN_MIN = 40

type RowGeometry = { rowW: number; leftW: number; mainW: number; rightW: number; agentsPx: number }

/**
 * Design widths of the desktop band for `cols` body columns and an agents
 * label of `agentsLen` characters (0: none): what the pictures' geometry is
 * laid out at, not the drawn widths. leftW is the left column (the agent rows' width), rightW the right
 * zone (divider + RAM card); the agents estimate only sizes the main bar,
 * never the divider's x.
 */
function desktopRowGeometry(cols: number, agentsLen: number): RowGeometry {
  const rowW = Math.max(180, Math.min(1600, cols * 8 - 96 - ROW_SAFETY_PX))
  const agentsPx = agentsLen > 0 ? Math.ceil(agentsLen * 7.5) + 24 : 0
  const leftW = Math.round(rowW * LEFT_SHARE)
  const rightW = rowW - leftW - GAP_PX
  const mainW = Math.max(MAIN_MIN, leftW - (agentsPx ? agentsPx + GAP_PX : 0))
  return { rowW, leftW, mainW, rightW, agentsPx }
}

/** The agents control's label: `▾3 · 45k`, `▴` when open, a `●` first while any runs. */
const agentsLabelOf = (sum: { count: number; tokens: number; running: number }, isOpen: boolean): string =>
  `${sum.running > 0 ? '●' : ''}${isOpen ? '▴' : '▾'}${sum.count} · ${fmtTokens(sum.tokens)}`

// The tools this mod registers and serves.
const TOOL = 'mcp__progress-bar__progress'
const STEP_TOOL = 'mcp__progress-bar__step'
// Compatibility, not dependency: the same reports sent to savvy-progress's tools
// (which /savvy-flow calls) are observed too, and savvy-progress still answers them.
// Matched by pattern, not by name: the laid MCP types name these tools only while
// savvy-progress is installed, and the hooks must type-check either way.
const COMPAT_TOOL = /^mcp__savvy-progress__progress$/
const COMPAT_STEP_TOOL = /^mcp__savvy-progress__step$/
// The main loop's task list: the desktop app's update_plan (by pattern, for the same reason) and the CLI's TodoWrite.
// Literal here, not imported: the validator reads each hook's matcher from this file.
const PLAN_TOOL = /^mcp__ccd_turn__update_plan$/
const TODO_TOOL = 'TodoWrite'

const errorText = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err ?? '')
  return text.trim().slice(0, 120) || 'failed'
}

const PHASES: readonly ProgressBarPhase[] = ['plan', 'design', 'delegate', 'review', 'close']

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: ProgressBarPhase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
}

type StepInput = { done?: number; total?: number; note?: string }

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'

// Lives here, not in shared.ts: the engine follows `$` only into functions of
// the hooks module's own file, never across an import.
async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'it' || option === 'en') return option
  let setting: unknown
  try {
    setting = (await $.settings.read()).language
  } catch {
    // No settings: fall through to the locale.
  }
  let locale: string | undefined
  try {
    locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  } catch {
    // No environment: English.
  }
  return pickLang(option, setting, locale)
}

const isTurnRunning = (start: number | null, end: number | null): boolean => start !== null && (end === null || end < start)

// ---------------------------------------------------------------------------
// The flow, merged from `progress` reports (same rules as savvy-progress).

const blank = (): Flow => ({
  title: 'savvy-flow',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && input.title.trim() !== prev.title)

const cleanTasks = (tasks: ProgressInput['tasks']): ProgressBarPlannedTask[] | undefined =>
  Array.isArray(tasks)
    ? tasks
        .filter(t => typeof t?.title === 'string' && t.title.trim())
        .map(t => ({
          title: (t.title ?? '').trim(),
          tier: String(t.tier ?? '').replace(/^savvy-/, '').trim().toLowerCase(),
          after: (Array.isArray(t.after) ? t.after : []).filter(n => Number.isInteger(n) && n > 0),
        }))
    : undefined

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total)))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: (typeof input.title === 'string' && input.title.trim()) || base.title,
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const flowLabel = (f: Flow): string =>
  f.isFinished ? `${f.title}: finished` : `${f.title}: ${f.phase}${f.total ? ` ${f.done}/${f.total}` : ''}`

// ---------------------------------------------------------------------------
// Subagent usage: context, tokens and an estimated cost (same table as savvy-progress).

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 5]

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = priceOf(model)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const tokensOf = (u: Usage): number =>
  (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

// ---------------------------------------------------------------------------
// Updates shared by this mod's own tools and the observed savvy-progress ones.

async function applyProgress($: EngineInterface, input: ProgressInput): Promise<Flow> {
  const prev = await read($, flow)
  if (isNewFlow(prev ?? null, input) && input.title !== undefined) {
    // A new flow starts with a clean list; agents still running stay.
    await update($, agents, list => (Array.isArray(list) ? list : []).filter(a => a.status === 'running'))
  }
  const next = await update($, flow, p => merge(p ?? null, input))
  return next ?? blank()
}

/** A main-loop task list call (update_plan / TodoWrite) folded into `plan`; a subagent's is ignored. */
async function observePlan($: EngineInterface, call: PlanCall): Promise<void> {
  if (call.agentId) return
  const at = await $.clock.now()
  // Folded inside the update, so two calls in a row never lose one another.
  await update($, plan, p => {
    const next = planAfterCall(p ?? null, call, at)
    return next === undefined ? (p ?? null) : next
  })
}

async function applyStep($: EngineInterface, agentId: string, input: StepInput): Promise<void> {
  await update($, agents, list =>
    (Array.isArray(list) ? list : []).map(a => {
      if (a.agentId !== agentId) return a
      const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
      const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
      const note = typeof input.note === 'string' ? input.note.trim() : ''
      return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: note || undefined }
    }),
  )
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)

    await $.tool.register({
      name: 'progress',
      description:
        'Report the progress of a planned multi-step task (e.g. a /savvy-flow run) to the progress bar above the prompt: ' +
        'after presenting the plan (title, total, tasks, phase), each time a task is accepted (done), when switching phase, ' +
        'and once at the end with finished: true. Fields left out keep their previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so runs can be matched to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string', enum: ['fable', 'heavy', 'careful', 'medium', 'light'] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the progress bar above the prompt. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
    })

    // Ticks the elapsed times; quiet unless a main turn or a subagent runs.
    $.clock.every(1000, () => {
      void (async () => {
        const start = await read($, startedAt)
        const end = await read($, endedAt)
        const list = await read($, agents)
        const isAgentRunning = Array.isArray(list) && list.some(a => a.status === 'running')
        if (!isTurnRunning(start, end) && !isAgentRunning) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })().catch(() => {})
    })

    // The RAM card: the platform found once, then a reading now and every
    // RAM_POLL_MS. Unawaited, so a slow probe never holds the session's start.
    // With no platform or no probe for it, the first poll records why and no interval starts.
    isRamPolling = false
    ramProbeIndex = 0
    ramKnownTotal = null
    ramLastOkAt = null
    void (async () => {
      ramPlatform = await detectPlatform($)
      await pollRam($)
      if (!ramPlatform || ramProbes(ramPlatform).length === 0) return
      $.clock.every(RAM_POLL_MS, () => {
        void pollRam($).catch(() => {})
      })
    })().catch(() => {})
    return started
  })

  // This mod's own tools: they answer the call.
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const f = await applyProgress($, e as unknown as ProgressInput)
    return { result: `ok: ${flowLabel(f)}` }
  }).catch(($, e, next) => ({ result: `error: ${errorText(next.error.message)}` }))

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    await applyStep($, agentId, e as unknown as StepInput)
    return { result: 'ok' }
  }).catch(($, e, next) => ({ result: `error: ${errorText(next.error.message)}` }))

  // The same reports sent to savvy-progress's tools: observed only, never
  // answered. Each always continues with `e` unchanged so savvy-progress answers.
  on('tool.call', { tool: COMPAT_TOOL }, async ($, e, next) => {
    await applyProgress($, e as unknown as ProgressInput)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: COMPAT_STEP_TOOL }, async ($, e, next) => {
    if (e.agentId) await applyStep($, e.agentId, e as unknown as StepInput)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The main loop's task list, for the working estimate: observed only, never
  // answered. Each always continues with `e` unchanged, its `.catch` too.
  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    await observePlan($, e as unknown as PlanCall)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TODO_TOOL }, async ($, e, next) => {
    await observePlan($, e as unknown as PlanCall)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!type.replace(/^[^:]*:/, '').startsWith('savvy-')) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  }).catch(($, e, next) => next(e))

  // Every subagent gets a row.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, prev => {
      const list = Array.isArray(prev) ? prev : []
      const round = 1 + list.filter(a => e.description && normTitle(a.description) === normTitle(e.description)).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    return started
  }).catch(($, e, next) => next(e))

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    try {
      const model = usage.model || e.model
      await update($, agents, list =>
        (Array.isArray(list) ? list : []).map(a =>
          a.agentId !== agentId
            ? a
            : {
                ...a,
                model,
                effort: typeof e.effort === 'string' ? e.effort : a.effort,
                status: 'running' as const,
                endedAt: undefined,
                contextTokens: tokensOf(usage),
                contextMax: windowOf(model),
                tokens: a.tokens + tokensOf(usage),
                costUsd: a.costUsd + costOf(model, usage),
                steps: a.steps + 1,
              },
        ),
      )
    } catch {
      // Watching only: a failed update never touches the response.
    }
    return result
  })

  // Turn activity. These hooks only watch: each always continues the chain
  // with `e` unchanged, and their `.catch` continues it too (replaying the
  // settled `next` when it was already called), so a failure never refuses.
  on('prompt.submit', async ($, e, next) => {
    // A prompt typed over a running turn, or delivered into it, carries that
    // turn's id: the turn keeps its clock and its tool count.
    if (e.turnId === undefined) {
      const at = await $.clock.now()
      await update($, startedAt, () => at)
      await update($, endedAt, () => null)
      await update($, tools, () => 0)
      await update($, now, () => at)
      // A completed task list ends with its turn; one left open carries on until replaced.
      const p = (await read($, plan)) ?? null
      if (p && isPlanComplete(p)) await update($, plan, () => null)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) await update($, tools, n => (n ?? 0) + 1)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const at = await $.clock.now()
    const agentId = e.agentId
    if (agentId) {
      await update($, agents, list =>
        (Array.isArray(list) ? list : []).map(a => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 ? e.usage : undefined
          return {
            ...a,
            status: e.reason === 'answer' ? ('done' as const) : ('failed' as const),
            endedAt: at,
            ...(fallback
              ? {
                  model: fallback.model || a.model,
                  tokens: tokensOf(fallback),
                  costUsd: costOf(fallback.model || a.model, fallback),
                }
              : {}),
          }
        }),
      )
    } else {
      await update($, endedAt, () => at)
    }
    await update($, now, () => at)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The band. Returns its own tree without calling `next`, so the bands of the
  // plugins beneath it (savvy-progress's, when installed) are not drawn; the survey keeps its place.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const s = STRINGS[lang]
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui

    const f = (await read($, flow)) ?? null
    const rawList = await read($, agents)
    const list: AgentRun[] = Array.isArray(rawList) ? rawList : []
    const start = await read($, startedAt)
    const end = await read($, endedAt)
    const toolCount = await read($, tools)
    const expanded = await read($, isExpanded)
    const at = Math.max(await read($, now), start ?? 0)
    const taskList = (await read($, plan)) ?? null

    // Pictures (every surface but the terminal) are redrawn about once a second
    // while something runs, and a surface loads each new source as a new image,
    // showing the alt until it is drawn (VS Code gives it 1 s). So a time drawn
    // inside an Svg reads in whole minutes, and its alt with it; the terminal's
    // text keeps m:ss.
    const timeStyle: TimeStyle = e.surface !== 'terminal' && 'Svg' in ui ? 'minutes' : 'clock'

    const m = buildMainModel(
      {
        flow: f,
        isWorking: e.props.isWorking,
        startedAt: start,
        endedAt: end,
        tools: toolCount,
        now: at,
        agents: list,
        plan: taskList,
        timeStyle,
      },
      s,
    )
    const alt = [m.title, m.pill, m.right].filter(Boolean).join(' · ')

    const ramErr = (await read($, ramError)) ?? null
    // Once ramError is set the last reading is stale: the card shows RAM ?.
    const ramInfo = ramErr ? null : ((await read($, ram)) ?? null)

    const rowsAt = Math.max(at, ...list.map(a => a.startedAt))
    const rows = expanded ? buildAgentRows(list, rowsAt, timeStyle) : []

    // The agents toggle, compact: "▾3 · 45k", "●▾3 · 45k" while any runs.
    const agentsLabel = agentsLabelOf(agentsSummary(list), expanded === true)
    const agentsButton =
      list.length > 0 ? <Button key="agents" label={agentsLabel} plain onPress={() => update($, isExpanded, v => !v)} /> : null

    // Main row plus agent rows fit in maxRows; when cut, the last line says how many more.
    const avail = Math.max(0, (e.props.maxRows || 0) - 1)
    const isCut = rows.length > avail
    const shown = isCut ? rows.slice(0, Math.max(0, avail - 1)) : rows
    const moreLine = isCut && avail >= 1 ? `+${rows.length - shown.length} ${s.more}` : ''
    // Tree: each shown row is a middle branch (├─) but the last (└─), unless the "+N" line follows it.
    const branchOf = (i: number): Branch => (i < shown.length - 1 || moreLine ? 'mid' : 'last')
    const hasBranch = shown.length > 0

    const rowAlt = (r: AgentRowModel): string => `${r.title}: ${r.status}, ${r.stat}, ${r.tokens} ${s.tok}, ${r.time}`
    // Short: `RAM 9.8/16 GB` or `RAM ?`, never a failure's reason (a surface may draw the alt as text).
    const ramAlt = ramAltText(ramInfo, ramErr)

    // By surface, not by table: the terminal draws text even where a table lists Svg.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const cols = e.props.bodyColumns || 100
      const g = desktopRowGeometry(cols, agentsButton ? agentsLabel.length : 0)
      // The right zone (and its divider) spans the left column: it is drawn
      // as tall as the main row plus the rows below (px, whatever the width).
      const totalH = MAIN_H + shown.length * AGENT_ROW_H + (moreLine ? MORE_H : 0)
      // Every source below is a pure function of what it shows (seed from the
      // turn, never the clock; whole percents; whole minutes), so a tick that
      // changes nothing visible hands back the same bytes and no image reloads.
      // Each Svg keeps its key and its place: VS Code matches them by position.
      // Each Svg gets its height alone and sits in a column Box, which
      // stretches it to the slot's width. The rows say nowrap: a row Box wraps
      // by default on the desktop surfaces, and 80% + gap + 20% would push the
      // right zone under the left column.
      return (
        <Box flexDirection="row" flexWrap="nowrap" alignItems="flex-start" justifyContent="flex-start" width="100%" gap={1}>
          {/* Percentages, not px: a Box's numeric width is not pixels, so 80% of the real row it is. */}
          <Box key="left" flexDirection="column" gap={0} flexShrink={0} width="80%">
            <Box key="top" flexDirection="row" flexWrap="nowrap" alignItems="center" width="100%" gap={1}>
              <Box key="main-slot" flexDirection="column" flexGrow={1} flexShrink={1}>
                <Svg key="main" source={mainRowSvg(m, g.mainW, turnSeed(start, m), hasBranch)} alt={alt} height={MAIN_H} />
              </Box>
              {agentsButton}
            </Box>
            {shown.map((r, i) => (
              <Svg key={r.id} source={agentRowSvg(r, g.leftW, branchOf(i))} alt={rowAlt(r)} height={AGENT_ROW_H} />
            ))}
            {moreLine ? (
              <Box paddingLeft={2}>
                <Text dimColor>{moreLine}</Text>
              </Box>
            ) : null}
          </Box>
          {/* 20% of the row, giving up the gap (it may shrink): the divider and the RAM card. */}
          <Box key="right" flexDirection="column" flexShrink={1} width="20%">
            <Svg key="ram" source={rightZoneSvg(ramInfo, ramErr, g.rightW, totalH)} alt={ramAlt} height={totalH} />
          </Box>
        </Box>
      )
    }

    // Terminal: the same structure in text.
    const tui = ui as TerminalUi
    const cols = Math.max(24, e.props.bodyColumns || 80)
    // "RAM ▕█████▏ 9.8/16 GB", or "RAM –" / "RAM ?".
    const ramCols = ramInfo ? 'RAM ▕█████▏ '.length + fmtRamPair(ramInfo).length : 'RAM –'.length
    const mainCols = Math.max(12, cols - (agentsButton ? agentsLabel.length + 1 : 0) - 2 - (ramCols + 1))
    // [main] [agents?] │ [RAM], as on the desktop.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            {mainRowTerminal(tui, m, mainCols)}
          </Box>
          {agentsButton}
          <Text key="sep" dimColor>
            │
          </Text>
          {ramCardTerminal(tui, ramInfo, ramErr)}
        </Box>
        {shown.map((r, i) => (
          <Box key={r.id}>{agentRowTerminal(tui, r, cols, branchOf(i))}</Box>
        ))}
        {moreLine ? <Text dimColor>{`└─ ${moreLine}`}</Text> : null}
      </Box>
    )
  })
}
