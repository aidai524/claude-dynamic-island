/** Where a step stands, as the task list tools spell it. */
export type IslandStatus = 'pending' | 'in_progress' | 'completed'

/** One step of the session's task list. */
export type IslandItem = {
  id: string
  title: string
  status: IslandStatus
  /** The present-continuous form a TodoWrite or TaskCreate step carries. */
  active?: string
}

/** The session's task list and the tool it came from. */
export type IslandPlan = {
  source: 'none' | 'plan' | 'todo' | 'tasks'
  items: IslandItem[]
}

/** Whether the main loop is working, and how its last turn ended. */
export type IslandPhase = 'idle' | 'working' | 'done' | 'error' | 'aborted'

/** What the session waits on the person for. */
export type IslandWaiting = 'permission' | 'question' | 'plan'

/** The main loop's turn: when it started, what it waits on, how it ended. */
export type IslandActivity = {
  phase: IslandPhase
  waiting?: IslandWaiting
  /** The tool a permission prompt is for. */
  waitingTool?: string
  /** Epoch ms the running turn started. */
  turnStartedAt?: number
  /** How long the last finished turn took, in ms. */
  lastDurationMs?: number
  /** Epoch ms the last turn ended. */
  endedAt?: number
  /** Tool calls the running (or last) turn made on the main loop. */
  toolCount: number
}

/** A background shell or a subagent. */
export type IslandJob = {
  id: string
  kind: 'shell' | 'agent'
  label: string
  status: 'running' | 'done' | 'failed'
}

/** One main-loop tool call, running or finished. */
export type IslandCall = {
  id: string
  label: string
  detail: string
  status: 'running' | 'done' | 'error'
}

/**
 * What a session publishes for the screen island, as
 * `~/.claude/dynamic-island/sessions/<session id>.json`: the ClaudeIsland app
 * reads every session's file and draws them together at the top of the screen.
 */
export type IslandSnapshot = {
  v: 1
  sessionId: string
  cwd: string
  /** The person's latest prompt, a fallback title. */
  prompt: string
  phase: IslandPhase
  waiting: IslandWaiting | null
  waitingTool: string | null
  turnStartedAt: number | null
  lastDurationMs: number | null
  endedAt: number | null
  plan: { title: string; status: IslandStatus; active: string | null }[]
  tool: { label: string; detail: string } | null
  jobs: { label: string; status: IslandJob['status']; kind: IslandJob['kind'] }[]
  /** The session ended: the island drops it. */
  closed: boolean
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'dynamic-island': {
      plan: Shaped<IslandPlan>
      activity: Shaped<IslandActivity>
      jobs: Shaped<IslandJob[]>
      recent: Shaped<IslandCall[]>
      now: number
      prompt: string
      isExpanded: boolean
      isHidden: boolean
    }
  }
}
