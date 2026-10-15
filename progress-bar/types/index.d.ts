/** A moment in ms on `$.clock`, or null before the first one. */
export type ProgressBarMoment = number | null

/** The phase of a planned multi-step task (a /savvy-flow run). */
export type ProgressBarPhase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

/** One planned worker task, numbered from 1 in the plan's order. */
export type ProgressBarPlannedTask = {
  title: string
  tier: string
  /** Numbers of the tasks this one waits for. */
  after: number[]
}

/** The planned multi-step task, as reported through the `progress` tool. */
export type ProgressBarFlow = {
  title: string
  total: number
  done: number
  /** Workers launched and not yet returned. */
  running: number
  phase: ProgressBarPhase
  isFinished: boolean
  tasks: ProgressBarPlannedTask[]
}

export type ProgressBarAgentStatus = 'running' | 'done' | 'failed'

/** One subagent run of this session. */
export type ProgressBarAgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: ProgressBarAgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

/** System RAM in use, in bytes, as the RAM card reads it. */
export type ProgressBarRam = { usedBytes: number; totalBytes: number }

/** The band's transient collapse / expand motion; `token` grows with every new phase. */
export type ProgressBarAnim = { phase: 'collapsing' | 'expanding' | null; token: number }

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': {
      /** The planned multi-step task, or null before the first report. */
      flow: ProgressBarFlow | null
      /** The subagent runs of this session, oldest first. */
      agents: ProgressBarAgentRun[]
      /** When the last main-loop prompt was submitted. */
      startedAt: ProgressBarMoment
      /** When the last main-loop turn completed. */
      endedAt: ProgressBarMoment
      /** Main-loop tool calls since the last prompt. */
      tools: number
      /** Clock for elapsed times, ticked once a second only while something runs. */
      now: number
      /** Whether the per-agent rows are shown under the main row. */
      isExpanded: boolean
      /** Whether the band is collapsed to the ring; persisted in `$.store` under `isCollapsed`. */
      isCollapsed: boolean
      /** System RAM in use, polled every few seconds; null until the first reading or where none can be taken. */
      ram: ProgressBarRam | null
      /** The desktop's collapse / expand motion, set for 360ms then cleared. */
      anim: ProgressBarAnim
    }
  }
}
