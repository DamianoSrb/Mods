import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { ProgressBarAnim, ProgressBarPhase, ProgressBarPlannedTask } from '../types'
import {
  agentsSummary,
  buildAgentRows,
  buildMainModel,
  type AgentRowModel,
  type AgentRun,
  type Flow,
  type MainModel,
} from './model'
import { ACCENT, DONE, STRINGS, fmtTokens, pickLang, withAnim, type Lang, type RowAnim, type TerminalUi } from './shared'
import { MAIN_H, mainRowSvg, mainRowTerminal } from './main-row'
import { AGENT_ROW_H, agentRowSvg, agentRowTerminal } from './agent-rows'
import { RING_SIZE, ringSvg } from './ring'
import { RAM_POLL_MS, fmtRamPair, parseRam, ramProbe, type RamInfo } from './ram'
import { ramCardSvg, ramCardTerminal } from './ram-card'

// This mod's own values; it tracks everything itself.
const flow = atom({ plugin: 'progress-bar', key: 'flow' } as const, null as Flow | null)
const agents = atom({ plugin: 'progress-bar', key: 'agents' } as const, [] as AgentRun[])
const startedAt = atom({ plugin: 'progress-bar', key: 'startedAt' } as const, null)
const endedAt = atom({ plugin: 'progress-bar', key: 'endedAt' } as const, null)
const tools = atom({ plugin: 'progress-bar', key: 'tools' } as const, 0)
const now = atom({ plugin: 'progress-bar', key: 'now' } as const, 0)
const isExpanded = atom({ plugin: 'progress-bar', key: 'isExpanded' } as const, false)
// Mirrors the `isCollapsed` preference in `$.store`, which keeps it between sessions.
const isCollapsed = atom({ plugin: 'progress-bar', key: 'isCollapsed' } as const, false)
const COLLAPSED_KEY = 'isCollapsed'
// System RAM in use, polled every RAM_POLL_MS; null until the first reading.
const ram = atom({ plugin: 'progress-bar', key: 'ram' } as const, null as RamInfo | null)

// The desktop's collapse / expand motion: a transient phase lasting ANIM_MS.
// `token` grows on every new phase, so a stale timer never ends a newer one.
const anim = atom({ plugin: 'progress-bar', key: 'anim' } as const, { phase: null, token: 0 } as ProgressBarAnim)
const ANIM_MS = 360

async function setCollapsed($: EngineInterface, value: boolean): Promise<void> {
  await update($, isCollapsed, () => value)
  try {
    await $.store.set(COLLAPSED_KEY, value)
  } catch {
    // No store: the preference lasts for this session only.
  }
}

/** Starts `phase`, then after ANIM_MS runs `end` and clears it, unless a newer phase began. */
async function startPhase($: EngineInterface, phase: 'collapsing' | 'expanding', end: () => Promise<void>): Promise<void> {
  const st = await update($, anim, p => ({ phase, token: (p?.token ?? 0) + 1 }))
  const token = st?.token ?? 0
  $.clock.after(ANIM_MS, () => {
    void (async () => {
      if ((await read($, anim))?.token !== token) return
      await end()
      await update($, anim, p => (p?.token === token ? { phase: null, token } : p))
    })().catch(() => {})
  })
}

/** Desktop collapse: the row animates out leftwards for ANIM_MS, then the band collapses. */
async function requestCollapse($: EngineInterface): Promise<void> {
  if ((await read($, isCollapsed)) === true) return
  if ((await read($, anim))?.phase === 'collapsing') return
  await startPhase($, 'collapsing', () => setCollapsed($, true))
}

/** Desktop expand: the band reopens at once and the row animates in for ANIM_MS. */
async function requestExpand($: EngineInterface): Promise<void> {
  const ph = (await read($, anim))?.phase ?? null
  if ((await read($, isCollapsed)) !== true && ph !== 'collapsing') return
  await setCollapsed($, false)
  await startPhase($, 'expanding', async () => {})
}

// ---------------------------------------------------------------------------
// System RAM: the platform found once per load, then a poll that never overlaps.

// Module scope is fine: neither is drawn, and session.start sets them again on (re)load.
let ramPlatform: string | null = null
let isRamPolling = false

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

async function pollRam($: EngineInterface): Promise<void> {
  const probe = ramPlatform ? ramProbe(ramPlatform) : null
  if (!ramPlatform || !probe || isRamPolling) return
  isRamPolling = true
  try {
    const output =
      probe.kind === 'run'
        ? (await $.process.run(probe.argv, { timeoutMs: 4000 })).stdout
        : await $.fs.read(probe.path)
    const next = parseRam(ramPlatform, output)
    if (!next) return
    const prev = (await read($, ram)) ?? null
    if (isRamChanged(prev, next)) await update($, ram, () => next)
  } catch {
    // A failed reading keeps the last value.
  } finally {
    isRamPolling = false
  }
}

// ---------------------------------------------------------------------------
// The collapsed band.

const quarter = (p: number): string => (p <= 12 ? '○' : p < 38 ? '◔' : p < 63 ? '◑' : p < 88 ? '◕' : '●')

/** The ring as one line of text (the terminal's collapsed control): glyph, percent, color. */
function ringGlyph(m: MainModel): { text: string; color: string | null } {
  if (m.isDone) return { text: `● ${m.ringPercent ?? 100}%`, color: DONE }
  if (m.mode === 'flow' && m.ringPercent !== null)
    return { text: `${quarter(m.ringPercent)} ${m.ringPercent}%`, color: ACCENT }
  if (m.mode === 'working') return { text: '◌ …', color: ACCENT }
  return { text: '○', color: null }
}

// The desktop's collapsed band is the ring alone, MAIN_H square (its 32px
// viewBox scaled to fit), no card behind it; a transparent `Client` over it takes the click.

// The expanded row's collapse control on the desktop: a MAIN_H square with a
// large `‹` chevron, bigger than a Button can draw; a `Client` laid over it takes the click.
const CHEVRON = MAIN_H

function collapseSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CHEVRON}" height="${CHEVRON}" viewBox="0 0 ${CHEVRON} ${CHEVRON}">` +
    '<style>.pbc-bg{fill:#f4f3f0;stroke:#e4e4e1}.pbc-ch{stroke:#6b6b68}' +
    '@media (prefers-color-scheme: dark){.pbc-bg{fill:#262625;stroke:#333331}.pbc-ch{stroke:#a8a8a4}}</style>' +
    `<rect class="pbc-bg" x="0.5" y="0.5" width="${CHEVRON - 1}" height="${CHEVRON - 1}" rx="8" stroke-width="1"/>` +
    '<path class="pbc-ch" d="M17.5 8.5L11 15l6.5 6.5" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>'
  )
}

// The thin vertical line between the agents control and the RAM card.
const SEP_W = 1
const SEP_H = 18

function separatorSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SEP_W}" height="${SEP_H}" viewBox="0 0 ${SEP_W} ${SEP_H}">` +
    '<style>.pbs-l{fill:#e4e4e1}@media (prefers-color-scheme: dark){.pbs-l{fill:#333331}}</style>' +
    `<rect class="pbs-l" x="0" y="0" width="${SEP_W}" height="${SEP_H}"/>` +
    '</svg>'
  )
}

/** The agents control's label: `▾3 · 45k`, `▴` when open, a `●` first while any runs. */
const agentsLabelOf = (sum: { count: number; tokens: number; running: number }, isOpen: boolean): string =>
  `${sum.running > 0 ? '●' : ''}${isOpen ? '▴' : '▾'}${sum.count} · ${fmtTokens(sum.tokens)}`

// Set when the desktop reports a `Client` of this band (the collapsed square's
// or the collapse control's) failed: the band then falls back to Buttons
// (the ring and `›`, or `‹`). Per load.
let isClientFailed = false

// The tools this mod registers and serves.
const TOOL = 'mcp__progress-bar__progress'
const STEP_TOOL = 'mcp__progress-bar__step'
// Compatibility, not dependency: the same reports sent to savvy-progress's tools
// (which /savvy-flow calls) are observed too, and savvy-progress still answers them.
// Matched by pattern, not by name: the laid MCP types name these tools only while
// savvy-progress is installed, and the hooks must type-check either way.
const COMPAT_TOOL = /^mcp__savvy-progress__progress$/
const COMPAT_STEP_TOOL = /^mcp__savvy-progress__step$/

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

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

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
    try {
      const stored = await $.store.get(COLLAPSED_KEY)
      await update($, isCollapsed, () => stored === true)
    } catch {
      // No store: start expanded.
    }
    // A (re)load cancels pending timers: never leave a motion phase hanging.
    await update($, anim, p => ({ phase: null, token: (p?.token ?? 0) + 1 }))

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
    isRamPolling = false
    void (async () => {
      ramPlatform = await detectPlatform($)
      if (!ramPlatform || !ramProbe(ramPlatform)) return
      await pollRam($)
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
      const round = 1 + list.filter(a => e.description && norm(a.description) === norm(e.description)).length
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
    const collapsed = (await read($, isCollapsed)) === true
    const at = Math.max(await read($, now), start ?? 0)

    const m = buildMainModel({ flow: f, isWorking: e.props.isWorking, startedAt: start, endedAt: end, tools: toolCount, now: at }, s)
    const alt = [m.title, m.pill, m.right].filter(Boolean).join(' · ')

    const ramInfo = (await read($, ram)) ?? null
    const phase = (await read($, anim))?.phase ?? null
    const isTerminal = e.surface === 'terminal'

    // Collapsed: the band is one control holding the ring; pressing it reopens the bar.
    if (collapsed) {
      const reopen = () => (isTerminal ? setCollapsed($, false) : requestExpand($))
      // Desktop: the ring alone (Svg), right-aligned, with a transparent
      // `Client` laid over it that takes the click (a Svg has no press, a Button holds only text).
      if (!isTerminal && 'Svg' in ui && 'Client' in ui && !isClientFailed) {
        const { Svg, Client } = ui
        return (
          <Box flexDirection="row" alignItems="center" justifyContent="flex-end" width="100%">
            <Box key="collapsed-square" position="relative">
              <Svg source={ringSvg(m, MAIN_H)} width={MAIN_H} height={MAIN_H} alt={alt} />
              <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                <Client key="collapsed" module="./collapsed-client.tsx" props={{ alt }} width="100%" height="100%" />
              </Box>
            </Box>
          </Box>
        )
      }
      // Other remote surfaces (no Client), or a Client that failed: the ring and a `›` Button.
      if (e.surface !== 'terminal' && 'Svg' in ui) {
        const { Svg } = ui
        return (
          <Box flexDirection="row" alignItems="center" justifyContent="flex-end" width="100%" gap={1}>
            <Svg source={ringSvg(m)} width={RING_SIZE} height={RING_SIZE} alt={alt} />
            <Button key="expand" label="›" plain onPress={reopen} />
          </Box>
        )
      }
      // Terminal: one Button whose label is the ring glyph.
      const g = ringGlyph(m)
      return (
        <Box flexDirection="row" justifyContent="flex-end" width="100%">
          <Button key="expand" label={g.text} plain onPress={reopen}>
            {g.color ? <Text color={g.color}>{g.text}</Text> : <Text dimColor>{g.text}</Text>}
          </Button>
        </Box>
      )
    }

    const rowsAt = Math.max(at, ...list.map(a => a.startedAt))
    const rows = expanded ? buildAgentRows(list, rowsAt) : []

    // The agents toggle, compact: "▾3 · 45k", "●▾3 · 45k" while any runs.
    const agentsLabel = agentsLabelOf(agentsSummary(list), expanded === true)
    const agentsButton =
      list.length > 0 ? <Button key="agents" label={agentsLabel} plain onPress={() => update($, isExpanded, v => !v)} /> : null
    // The collapse control ends the row. Terminal (and desktop fallback): a `‹` Button.
    const COLLAPSE_LABEL = '‹'
    const collapseButton = (
      <Button
        key="collapse"
        label={COLLAPSE_LABEL}
        plain
        onPress={() => (isTerminal ? setCollapsed($, true) : requestCollapse($))}
      >
        <Text bold>{COLLAPSE_LABEL}</Text>
      </Button>
    )

    // Main row plus agent rows fit in maxRows; when cut, the last line says how many more.
    const avail = Math.max(0, (e.props.maxRows || 0) - 1)
    const isCut = rows.length > avail
    const shown = isCut ? rows.slice(0, Math.max(0, avail - 1)) : rows
    const moreLine = isCut && avail >= 1 ? `+${rows.length - shown.length} ${s.more}` : ''

    const rowAlt = (r: AgentRowModel): string => `${r.title}: ${r.status}, ${r.stat}, ${r.tokens} ${s.tok}, ${r.time}`
    const ramAlt = ramInfo ? `RAM ${fmtRamPair(ramInfo)}` : 'RAM'

    // By surface, not by table: the terminal draws text even where a table lists Svg.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const cols = e.props.bodyColumns || 100
      // [main bar: 80% of the row] [right zone: agents? · │ · RAM · collapse],
      // the zone flush right. The desktop puts ~GAP_PX between siblings; the
      // zone's parts are sized to fill exactly what the main bar and the gaps leave.
      const GAP_PX = 8
      const RAM_MIN = 32
      const ZONE_PCT_ONLY = 150
      const rowW = Math.max(180, Math.min(1600, cols * 8 - 96))
      const agentsPx = agentsButton ? Math.ceil(agentsLabel.length * 7.5) + 24 : 0
      const mainW0 = Math.round(rowW * 0.8)
      // The zone's fixed parts and the gaps among them (sep and collapse, agents when shown).
      const fixedParts = agentsPx + SEP_W + CHEVRON
      const fixedCount = (agentsButton ? 1 : 0) + 2
      // With the RAM card: one more part and one more gap; the main–zone gap counts too.
      const ramW0 = rowW - mainW0 - GAP_PX - fixedParts - fixedCount * GAP_PX
      const hasRam = ramW0 >= RAM_MIN
      const used = fixedParts + (fixedCount - 1 + (hasRam ? 1 : 0)) * GAP_PX + (hasRam ? RAM_MIN : 0)
      // The main bar keeps 80% unless the zone's fixed parts would not fit, never wrapping.
      const mainW = Math.max(60, Math.min(mainW0, rowW - GAP_PX - used))
      const ramW = hasRam ? rowW - mainW - GAP_PX - fixedParts - fixedCount * GAP_PX : 0
      const isRamPctOnly = rowW - mainW < ZONE_PCT_ONLY
      const rowAnim: RowAnim | undefined =
        phase === 'collapsing' ? 'collapse' : phase === 'expanding' ? 'expand' : undefined
      // Desktop with Client: the drawn chevron square, a transparent Client over it takes the press.
      const collapseControl =
        'Client' in ui && !isClientFailed ? (
          (() => {
            const { Client } = ui
            const collapseAlt = lang === 'it' ? 'Riduci' : 'Collapse'
            return (
              <Box key="collapse-box" position="relative">
                <Svg source={withAnim(collapseSvg(), rowAnim)} width={CHEVRON} height={CHEVRON} alt={collapseAlt} />
                <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                  <Client
                    key="collapse"
                    module="./collapsed-client.tsx"
                    props={{ action: 'collapse', alt: collapseAlt }}
                    width="100%"
                    height="100%"
                  />
                </Box>
              </Box>
            )
          })()
        ) : (
          collapseButton
        )
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" width="100%" gap={1}>
            <Svg
              key="main"
              source={mainRowSvg(m, mainW, Math.floor(at / 1000), rowAnim)}
              alt={alt}
              width={mainW}
              height={MAIN_H}
            />
            <Box key="zone" flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
              {agentsButton}
              <Svg key="sep" source={withAnim(separatorSvg(), rowAnim)} alt="" width={SEP_W} height={SEP_H} />
              {hasRam ? (
                <Svg
                  key="ram"
                  source={withAnim(ramCardSvg(ramInfo, ramW, MAIN_H, isRamPctOnly), rowAnim)}
                  alt={ramAlt}
                  width={ramW}
                  height={MAIN_H}
                />
              ) : null}
              {collapseControl}
            </Box>
          </Box>
          {shown.length > 0 || moreLine ? (
            <Box flexDirection="column">
              {shown.map(r => (
                <Svg key={r.id} source={agentRowSvg(r, rowW)} alt={rowAlt(r)} width={rowW} height={AGENT_ROW_H} />
              ))}
              {moreLine ? <Text dimColor>{moreLine}</Text> : null}
            </Box>
          ) : null}
        </Box>
      )
    }

    // Terminal: the same structure in text.
    const tui = ui as TerminalUi
    const cols = Math.max(24, e.props.bodyColumns || 80)
    // "RAM ▕█████▏ 9.8/16 GB", or "RAM –".
    const ramCols = ramInfo ? 'RAM ▕█████▏ '.length + fmtRamPair(ramInfo).length : 'RAM –'.length
    const mainCols = Math.max(
      12,
      cols - (agentsButton ? agentsLabel.length + 1 : 0) - 2 - (COLLAPSE_LABEL.length + 1) - (ramCols + 1),
    )
    // [main] [agents?] │ [RAM] [‹], as on the desktop.
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
          {ramCardTerminal(tui, ramInfo)}
          {collapseButton}
        </Box>
        {shown.map(r => (
          <Box key={r.id}>{agentRowTerminal(tui, r, cols)}</Box>
        ))}
        {moreLine ? <Text dimColor>{moreLine}</Text> : null}
      </Box>
    )
  })

  // A press on the desktop's drawn controls: the collapsed square's `Client`
  // posts `{ action: 'expand' }`, the collapse control's `{ action: 'collapse' }`.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { action?: unknown } | null
    const action = data && typeof data === 'object' ? data.action : undefined
    if (e.element === 'collapsed' || e.element === 'collapse') {
      if (action === 'expand') await requestExpand($)
      else if (action === 'collapse') await requestCollapse($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A `Client` of the band failed on a surface: fall back to Buttons for this load.
  on('ui.fault', async ($, e, next) => {
    if (e.element === 'collapsed' || e.element === 'collapse') isClientFailed = true
    return next(e)
  }).catch(($, e, next) => next(e))
}
