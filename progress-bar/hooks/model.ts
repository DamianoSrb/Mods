// Pure view models for the band: no `$`, no drawing. The drawing modules
// (main-row.tsx, agent-rows.tsx) draw exactly what these say.
import type { ProgressBarAgentRun, ProgressBarFlow } from '../types'
import { fmtTime, fmtTokens, tierOf, type Strings } from './shared'

// This plugin's own types, from its contract.
export type Flow = ProgressBarFlow
export type AgentRun = ProgressBarAgentRun

export type MainMode = 'flow' | 'working' | 'idle'

export type MainModel = {
  mode: MainMode
  /** flow title | s.working | s.idle */
  title: string
  /** 0..1 accepted fill (flow; 1 if finished), 0 otherwise */
  ratio: number
  /** 0..1 including running agents (flow faint layer), 0 otherwise */
  runRatio: number
  /** flow total (tick marks), 0 otherwise */
  ticks: number
  /** flow: phase label; working: elapsed m:ss; idle: '' (the title says it) */
  pill: string
  /** flow: "NN%"; working: "N tool"; idle: "[✓ <flow> · ]ultimo turno m:ss · N tool", or "" before any turn */
  right: string
  /** idle after a finished flow */
  isDone: boolean
  /** flow: round(ratio*100); idle with isDone: 100; otherwise null */
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
  /** true when progress is the context fallback (drawn grey) */
  isContext: boolean
  /** "3/5" or "ctx 12%" */
  stat: string
  /** fmtTokens(tokens) */
  tokens: string
  /** m:ss of (endedAt ?? now) - startedAt */
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

const flowRatio = (f: Flow): number => (f.isFinished ? 1 : f.total ? clamp01(f.done / f.total) : 0)

export function buildMainModel(
  input: { flow: Flow | null; isWorking: boolean; startedAt: number | null; endedAt: number | null; tools: number; now: number },
  s: Strings,
): MainModel {
  const { flow, isWorking, startedAt, endedAt, tools, now } = input

  if (flow && !flow.isFinished) {
    const ratio = flowRatio(flow)
    return {
      mode: 'flow',
      title: flow.title,
      ratio,
      runRatio: flow.total ? Math.max(ratio, clamp01((flow.done + flow.running) / flow.total)) : ratio,
      ticks: Math.max(0, flow.total),
      pill: phaseLabel(flow, s),
      right: `${Math.round(ratio * 100)}%`,
      isAnimating: false,
      isDone: false,
      ringPercent: Math.round(ratio * 100),
    }
  }

  if (isWorking) {
    const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt)
    return {
      mode: 'working',
      title: s.working,
      ratio: 0,
      runRatio: 0,
      ticks: 0,
      pill: fmtTime(elapsed),
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
    runRatio: 0,
    ticks: 0,
    pill: '',
    right: lead && last ? `${lead} · ${last}` : lead || last,
    isAnimating: false,
    isDone,
    ringPercent: isDone ? 100 : null,
  }
}

const rowOf = (a: AgentRun, now: number): AgentRowModel => {
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
    time: fmtTime((a.endedAt ?? now) - a.startedAt),
  }
}

/** Running first (most recent first), then finished, most recent first. */
export function buildAgentRows(agents: AgentRun[], now: number): AgentRowModel[] {
  const running = agents.filter(a => a.status === 'running').sort((x, y) => y.startedAt - x.startedAt)
  const finished = agents
    .filter(a => a.status !== 'running')
    .sort((x, y) => (y.endedAt ?? y.startedAt) - (x.endedAt ?? x.startedAt))
  return [...running, ...finished].map(a => rowOf(a, now))
}

/** Agent count, how many still run, and their summed tokens. */
export function agentsSummary(agents: AgentRun[]): { count: number; running: number; tokens: number } {
  return {
    count: agents.length,
    running: agents.filter(a => a.status === 'running').length,
    tokens: agents.reduce((n, a) => n + (Number.isFinite(a.tokens) ? a.tokens : 0), 0),
  }
}
