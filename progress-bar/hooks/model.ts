// Pure view models for the band: no `$`, no drawing. The drawing modules
// (main-row.tsx, agent-rows.tsx) draw exactly what these say.
import type {
  ProgressBarAgentRun,
  ProgressBarFlow,
  ProgressBarPlan,
  ProgressBarPlanItem,
  ProgressBarPlanStatus,
} from '../types'
import { fmtElapsed, fmtTime, fmtTokens, tierOf, type Strings, type TimeStyle } from './shared'

// This plugin's own types, from its contract.
export type Flow = ProgressBarFlow
export type AgentRun = ProgressBarAgentRun
export type Plan = ProgressBarPlan
export type PlanItem = ProgressBarPlanItem
export type PlanStatus = ProgressBarPlanStatus

export type MainMode = 'flow' | 'working' | 'idle'

export type MainModel = {
  mode: MainMode
  /** flow title | working: the plan's in-progress item, else s.working | s.idle */
  title: string
  /**
   * 0..1 fill. flow: the estimate (accepted tasks plus the share of the
   * unaccepted tasks' runs, in [acceptedRatio, 0.99]; 1 if finished or
   * completed by its runs, see flowCompletion); working with a plan:
   * (completed + ½ in progress) / items; 0 otherwise.
   */
  ratio: number
  /**
   * 0..1 confirmed part, never above ratio. flow: done/total (1 if
   * finished or completed); working with a plan: completed / items; 0 otherwise.
   */
  acceptedRatio: number
  /** True when ratio is an estimate: flow with ratio > acceptedRatio; working with a plan always. */
  isEstimate: boolean
  /** 0..1 including running agents (flow faint layer), 0 otherwise */
  runRatio: number
  /** flow total (tick marks), 0 otherwise */
  ticks: number
  /**
   * flow: phase label ("Attività s/n" once completed by its runs, s the tasks
   * whose run succeeded); working: "Passo k/n" with a plan, else the elapsed
   * time (m:ss, or "<1m"/"3m" with timeStyle 'minutes'); idle: '' (the title says it)
   */
  pill: string
  /**
   * flow: "NN%", "~NN%" when estimated (at most "~99%"); working: "~NN%" with
   * a plan, else "N tool"; idle: "[✓ <flow> · ]ultimo turno m:ss · N tool", or
   * "" before any turn
   */
  right: string
  /** A finished flow: idle after one, or (mode flow) one completed by its runs (flowCompletion). */
  isDone: boolean
  /** flow: round(ratio*100) (100 once completed); idle with isDone: 100; otherwise null */
  ringPercent: number | null
  /** true only in working mode */
  isAnimating: boolean
}

export type AgentRowModel = {
  id: string
  /** fable|heavy|careful|medium|light|other */
  tier: string
  /** description || type */
  title: string
  status: 'running' | 'done' | 'failed'
  /** 0..1: done → 1; stepTotal → stepDone/stepTotal; else contextTokens/contextMax */
  progress: number
  /** true when progress is the context fallback (drawn grey while running) */
  isContext: boolean
  /** "3/5" or "ctx 12%" */
  stat: string
  /** fmtTokens(tokens) */
  tokens: string
  /**
   * Running: now - startedAt, m:ss (or "<1m"/"3m" with timeStyle 'minutes');
   * finished: endedAt - startedAt, m:ss (frozen, so it never ticks).
   */
  time: string
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)

const toolsText = (n: number, s: Strings): string => `${n} ${n === 1 ? s.tool : s.tools}`

const phaseLabel = (f: Flow, s: Strings): string => {
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const name = f.phase === 'review' ? s.review : s.tasks
  return f.total ? `${name} ${f.done}/${f.total}` : name
}

/**
 * A percentage, with a leading `~` when it is an estimate: "45%", "~45%". An
 * estimate never reads 100: it stops at "~99%".
 */
export const percentText = (ratio: number, isEstimate: boolean): string => {
  const pct = Math.round(clamp01(ratio) * 100)
  return isEstimate ? `~${Math.min(99, pct)}%` : `${pct}%`
}

// ---------------------------------------------------------------------------
// The flow estimate: accepted tasks count whole, a planned task not yet
// accepted counts by its latest run.

// A run reporting steps: stepDone/stepTotal of this share.
const STEP_SHARE = 0.9
// A run finished but not yet accepted.
const DONE_SHARE = 0.9
// A run without steps: CURVE_SHARE × (1 − e^(−elapsed / CURVE_TAU_MS)).
const CURVE_SHARE = 0.8
const CURVE_TAU_MS = 240_000
// The estimate never reaches 100% before the flow is finished.
const ESTIMATE_CAP = 0.99

/** Letters and digits only, lower case: how a run's description meets a task's title. */
export const normTitle = (s: string): string =>
  String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** How far one run has taken its task, 0..0.9: steps, else a time curve; finished 0.9, failed 0. */
export function runShare(a: AgentRun, now: number): number {
  if (a.status === 'failed') return 0
  if (a.status === 'done') return DONE_SHARE
  if (a.stepTotal && a.stepTotal > 0) return clamp01((a.stepDone ?? 0) / a.stepTotal) * STEP_SHARE
  const elapsed = Math.max(0, now - a.startedAt)
  return Number.isFinite(elapsed) ? CURVE_SHARE * (1 - Math.exp(-elapsed / CURVE_TAU_MS)) : 0
}

/**
 * The shares of the planned tasks not yet accepted, one per task with a run,
 * at most total − done of them. Runs meet tasks by title (the `progress`
 * tool asks for task titles equal to the Agent descriptions); when none
 * does, every run counts as one task (the savvy workers only, when there are
 * any). A retried task counts by its latest run. The `done` accepted tasks
 * are taken to be the earliest finished runs, so those are left out.
 */
/** Each task's latest run, keyed by its normalized description (a run without one stands alone). */
function latestRuns(pool: readonly AgentRun[]): Map<string, AgentRun> {
  const latest = new Map<string, AgentRun>()
  for (const a of pool) {
    const key = normTitle(a.description) || `#${a.id}`
    const prev = latest.get(key)
    if (!prev || a.startedAt >= prev.startedAt) latest.set(key, a)
  }
  return latest
}

/** The savvy workers' runs when there are any, else every run: the runs that stand for tasks without titles. */
const workerPool = (agents: readonly AgentRun[]): readonly AgentRun[] => {
  const workers = agents.filter(a => tierOf(a.type) !== 'other')
  return workers.length ? workers : agents
}

function unacceptedShares(f: Flow, agents: readonly AgentRun[], now: number): number[] {
  const open = Math.max(0, f.total - f.done)
  if (!open) return []
  const titles = new Set(f.tasks.map(t => normTitle(t.title)).filter(Boolean))
  const matched = agents.filter(a => titles.has(normTitle(a.description)))
  const pool = matched.length ? matched : workerPool(agents)

  const runs = [...latestRuns(pool).values()]
  const accepted = new Set(
    runs
      .filter(a => a.status === 'done')
      .sort((x, y) => (x.endedAt ?? x.startedAt) - (y.endedAt ?? y.startedAt))
      .slice(0, Math.max(0, f.done))
      .map(a => a.id),
  )
  return runs
    .filter(a => !accepted.has(a.id))
    .map(a => runShare(a, now))
    .sort((x, y) => y - x)
    .slice(0, open)
}

/**
 * The flow's fill: `acceptedRatio` = done/total, `ratio` = (done + the
 * unaccepted tasks' shares)/total, in [acceptedRatio, 0.99]; both 1 once
 * finished, both 0 without a total.
 */
export function flowEstimate(f: Flow, agents: readonly AgentRun[], now: number): { ratio: number; acceptedRatio: number } {
  if (f.isFinished) return { ratio: 1, acceptedRatio: 1 }
  if (!(f.total > 0)) return { ratio: 0, acceptedRatio: 0 }
  const acceptedRatio = clamp01(f.done / f.total)
  const sum = unacceptedShares(f, agents, now).reduce((n, x) => n + x, 0)
  const estimate = clamp01((Math.min(f.done, f.total) + sum) / f.total)
  return { ratio: Math.max(acceptedRatio, Math.min(ESTIMATE_CAP, estimate)), acceptedRatio }
}

/**
 * Whether a flow's planned work is over though no `done`/`finished` report
 * said so: every planned task has a run that ended (each of `f.tasks` by its
 * title, its latest run; without titles, `f.total` runs, the savvy workers'
 * when there are any), no agent runs, and the main turn is not working. A
 * failed run counts as ended. `planned`: the tasks (titles, else total);
 * `succeeded`: those whose run ended done, never below the reported `done`.
 * Derived on every draw: the stored flow is never changed.
 */
export function flowCompletion(
  f: Flow,
  agents: readonly AgentRun[],
  isWorking: boolean,
): { isComplete: boolean; planned: number; succeeded: number } {
  const titles = f.tasks.map(t => normTitle(t.title)).filter(Boolean)
  const planned = titles.length || Math.max(0, Math.floor(Number.isFinite(f.total) ? f.total : 0))
  const accepted = Math.min(planned, Math.max(0, Number.isFinite(f.done) ? Math.floor(f.done) : 0))
  const no = { isComplete: false, planned, succeeded: accepted }
  if (isWorking || planned === 0 || agents.some(a => a.status === 'running')) return no

  let ended: AgentRun[] = []
  if (titles.length) {
    const wanted = new Set(titles)
    const latest = latestRuns(agents.filter(a => wanted.has(normTitle(a.description))))
    const runs = titles.map(t => latest.get(t))
    if (runs.every(Boolean)) ended = runs as AgentRun[]
  }
  // No titles, or titles the Agent descriptions did not repeat: count the worker runs instead.
  if (!ended.length) {
    ended = [...latestRuns(workerPool(agents)).values()]
    if (ended.length < planned) return no
  }
  // Nothing runs (checked above): every run left here ended, done or failed.
  const ok = Math.min(planned, ended.filter(a => a.status === 'done').length)
  return { isComplete: true, planned, succeeded: Math.max(accepted, ok) }
}

// ---------------------------------------------------------------------------
// The main loop's task list, from its tool calls.

/** The desktop app's task list tool. Matched by pattern: the laid MCP types name it only while connected. */
export const UPDATE_PLAN_TOOL = /^mcp__ccd_turn__update_plan$/
/** The CLI's and VS Code's task list tool. */
export const TODO_TOOL = 'TodoWrite'

const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed']

const statusOf = (v: unknown): PlanStatus => (STATUSES.includes(v as PlanStatus) ? (v as PlanStatus) : 'pending')

/** A list from tool input (`[{ content, status }]`), or null when it holds no item. Every entry keeps its place. */
const listOf = (raw: unknown, at: number): Plan | null => {
  if (!Array.isArray(raw)) return null
  const items = raw.map((it: unknown): PlanItem => {
    const o = (it && typeof it === 'object' ? it : {}) as { content?: unknown; status?: unknown }
    return { title: typeof o.content === 'string' ? o.content.trim() : '', status: statusOf(o.status) }
  })
  return items.length ? { items, at } : null
}

/** A 1-based item number of a list of `n`, or -1. */
const toIndex = (v: unknown, n: number): number => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= n ? (v as number) - 1 : -1)

/** One tool call of a loop, as `tool.call` carries it: the tool, the loop, the arguments beside them. */
export type PlanCall = { tool: string; agentId?: string } & Record<string, unknown>

/**
 * The task list after one tool call, or undefined when the call leaves it
 * as it is (another tool, a subagent's call, an update with no list yet).
 *
 * update_plan: `items` replaces the list; then `advance` completes the
 * in-progress item and starts the next pending one after it (the first
 * pending one when none is in progress); then `done` completes and `start`
 * starts those items (1-based). TodoWrite: `todos` replaces the list.
 */
export function planAfterCall(prev: Plan | null, call: PlanCall, at: number): Plan | null | undefined {
  if (call.agentId) return undefined
  if (call.tool === TODO_TOOL) return Array.isArray(call.todos) ? listOf(call.todos, at) : undefined
  if (!UPDATE_PLAN_TOOL.test(call.tool)) return undefined

  const hasItems = Array.isArray(call.items)
  if (!hasItems && !prev) return undefined
  const base = hasItems ? listOf(call.items, at) : prev
  if (!base) return null
  const items = base.items.map(it => ({ ...it }))

  if (call.advance === true) {
    const current = items.findIndex(it => it.status === 'in_progress')
    const cur = items[current]
    if (cur) cur.status = 'completed'
    const nextPending = items.find((it, i) => i > current && it.status === 'pending')
    if (nextPending) nextPending.status = 'in_progress'
  }
  if (Array.isArray(call.done)) {
    for (const n of call.done) {
      const it = items[toIndex(n, items.length)]
      if (it) it.status = 'completed'
    }
  }
  const started = items[toIndex(call.start, items.length)]
  if (started) started.status = 'in_progress'

  return { items, at }
}

/** Every item completed (an empty list counts as completed). */
export const isPlanComplete = (p: Plan): boolean => p.items.every(it => it.status === 'completed')

/**
 * Where a list stands: ratio = (completed + ½ in progress) / items,
 * acceptedRatio = completed / items, step = the in-progress item's number
 * (else the completed count), current = the in-progress item's text.
 */
export function planProgress(p: Plan): { ratio: number; acceptedRatio: number; step: number; total: number; current: string } {
  const total = p.items.length
  if (!total) return { ratio: 0, acceptedRatio: 0, step: 0, total: 0, current: '' }
  const completed = p.items.filter(it => it.status === 'completed').length
  const inProgress = p.items.filter(it => it.status === 'in_progress').length
  const at = p.items.findIndex(it => it.status === 'in_progress')
  return {
    ratio: clamp01((completed + 0.5 * inProgress) / total),
    acceptedRatio: clamp01(completed / total),
    step: at >= 0 ? at + 1 : completed,
    total,
    current: at >= 0 ? (p.items[at]?.title ?? '') : '',
  }
}

export function buildMainModel(
  input: {
    flow: Flow | null
    isWorking: boolean
    startedAt: number | null
    endedAt: number | null
    tools: number
    now: number
    /** The subagent runs, for the flow estimate. */
    agents?: readonly AgentRun[]
    /** The main loop's task list, for the working estimate. */
    plan?: Plan | null
    /** How the running turn's elapsed time reads; 'clock' (m:ss) when left out. */
    timeStyle?: TimeStyle
  },
  s: Strings,
): MainModel {
  const { flow, isWorking, startedAt, endedAt, tools, now } = input

  if (flow && !flow.isFinished) {
    // Every planned task's run ended and all is quiet: drawn finished (green,
    // 100%), the stored flow left as it is.
    const end = flowCompletion(flow, input.agents ?? [], isWorking)
    if (end.isComplete) {
      return {
        mode: 'flow',
        title: flow.title,
        ratio: 1,
        acceptedRatio: 1,
        isEstimate: false,
        runRatio: 1,
        ticks: Math.max(0, flow.total),
        pill: `${s.tasks} ${end.succeeded}/${end.planned}`,
        right: percentText(1, false),
        isAnimating: false,
        isDone: true,
        ringPercent: 100,
      }
    }
    const { ratio, acceptedRatio } = flowEstimate(flow, input.agents ?? [], now)
    const isEstimate = ratio > acceptedRatio
    return {
      mode: 'flow',
      title: flow.title,
      ratio,
      acceptedRatio,
      isEstimate,
      runRatio: flow.total ? Math.max(ratio, clamp01((flow.done + flow.running) / flow.total)) : ratio,
      ticks: Math.max(0, flow.total),
      pill: phaseLabel(flow, s),
      right: percentText(ratio, isEstimate),
      isAnimating: false,
      isDone: false,
      ringPercent: Math.round(ratio * 100),
    }
  }

  if (isWorking) {
    const plan = input.plan && input.plan.items.length ? input.plan : null
    if (plan) {
      const p = planProgress(plan)
      return {
        mode: 'working',
        title: p.current || s.working,
        ratio: p.ratio,
        acceptedRatio: p.acceptedRatio,
        isEstimate: true,
        runRatio: p.ratio,
        ticks: 0,
        pill: `${s.step} ${p.step}/${p.total}`,
        right: percentText(p.ratio, true),
        isAnimating: true,
        isDone: false,
        ringPercent: null,
      }
    }
    const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt)
    return {
      mode: 'working',
      title: s.working,
      ratio: 0,
      acceptedRatio: 0,
      isEstimate: false,
      runRatio: 0,
      ticks: 0,
      pill: fmtElapsed(elapsed, input.timeStyle),
      right: toolsText(tools, s),
      isAnimating: true,
      isDone: false,
      ringPercent: null,
    }
  }

  const hasLast = startedAt !== null && endedAt !== null && endedAt >= startedAt
  const last = hasLast ? `${s.lastTurn} ${fmtTime(endedAt - startedAt)} · ${toolsText(tools, s)}` : ''
  const isDone = !!flow && flow.isFinished
  const lead = isDone && flow ? `✓ ${flow.title}` : ''
  return {
    mode: 'idle',
    title: s.idle,
    ratio: 0,
    acceptedRatio: 0,
    isEstimate: false,
    runRatio: 0,
    ticks: 0,
    pill: '',
    right: lead && last ? `${lead} · ${last}` : lead || last,
    isAnimating: false,
    isDone,
    ringPercent: isDone ? 100 : null,
  }
}

const rowOf = (a: AgentRun, now: number, timeStyle: TimeStyle): AgentRowModel => {
  const hasSteps = !!a.stepTotal && a.stepTotal > 0
  const ctx = a.contextMax > 0 ? clamp01((a.contextTokens || 0) / a.contextMax) : 0
  const isContext = a.status !== 'done' && !hasSteps
  const progress = a.status === 'done' ? 1 : hasSteps ? clamp01((a.stepDone ?? 0) / (a.stepTotal ?? 1)) : ctx
  return {
    id: a.id,
    tier: tierOf(a.type),
    title: a.description || a.type,
    status: a.status,
    progress,
    isContext,
    stat: hasSteps ? `${a.stepDone ?? 0}/${a.stepTotal}` : `ctx ${Math.round(ctx * 100)}%`,
    tokens: fmtTokens(a.tokens),
    time: a.endedAt !== undefined ? fmtTime(a.endedAt - a.startedAt) : fmtElapsed(now - a.startedAt, timeStyle),
  }
}

/** Running first (most recent first), then finished, most recent first; a running row's time reads as `timeStyle` says. */
export function buildAgentRows(agents: AgentRun[], now: number, timeStyle: TimeStyle = 'clock'): AgentRowModel[] {
  const running = agents.filter(a => a.status === 'running').sort((x, y) => y.startedAt - x.startedAt)
  const finished = agents
    .filter(a => a.status !== 'running')
    .sort((x, y) => (y.endedAt ?? y.startedAt) - (x.endedAt ?? x.startedAt))
  return [...running, ...finished].map(a => rowOf(a, now, timeStyle))
}

/** Agent count, how many still run, and their summed tokens. */
export function agentsSummary(agents: AgentRun[]): { count: number; running: number; tokens: number } {
  return {
    count: agents.length,
    running: agents.filter(a => a.status === 'running').length,
    tokens: agents.reduce((n, a) => n + (Number.isFinite(a.tokens) ? a.tokens : 0), 0),
  }
}
