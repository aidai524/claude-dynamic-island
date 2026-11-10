// What the island knows, as plain functions: no `$`, so the tests and the
// hooks module read the same rules.
import type {
  IslandActivity,
  IslandCall,
  IslandItem,
  IslandJob,
  IslandPhase,
  IslandPlan,
  IslandSnapshot,
  IslandStatus,
} from '../types'

type Raw = Record<string, unknown>

export const EMPTY_PLAN: IslandPlan = { source: 'none', items: [] }

export const IDLE: IslandActivity = { phase: 'idle', toolCount: 0 }

export const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : ''

export function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `01:42`, or `1:02:03` past an hour. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
}

export function normStatus(value: unknown): IslandStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'pending'
}

function setStatus(items: IslandItem[], index: number, status: IslandStatus): void {
  const item = items[index]
  if (item) items[index] = { ...item, status }
}

/**
 * The Code tab's own list, `mcp__ccd_turn__update_plan`: `items` replaces the
 * list, `advance` finishes the step in progress and starts the next pending
 * one, `done` (1-based) finishes steps and `start` starts one.
 */
export function applyUpdatePlan(plan: IslandPlan, input: Raw): IslandPlan {
  let items: IslandItem[] = plan.source === 'plan' ? [...plan.items] : []

  if (Array.isArray(input.items)) {
    items = input.items.filter(isRecord).map((item, index) => ({
      id: String(index + 1),
      title: clip(textOf(item.content) || textOf(item.title), 200),
      status: normStatus(item.status),
    }))
  }

  if (input.advance === true) {
    const current = items.findIndex(item => item.status === 'in_progress')
    setStatus(items, current, 'completed')
    const next = items.findIndex(
      (item, index) => index > current && item.status === 'pending',
    )
    setStatus(items, next, 'in_progress')
  }

  if (Array.isArray(input.done)) {
    for (const step of input.done) setStatus(items, Number(step) - 1, 'completed')
  }

  if (typeof input.start === 'number') setStatus(items, input.start - 1, 'in_progress')

  return { source: 'plan', items }
}

/** `mcp__ccd_turn__wrap_up` checks off the step in progress. */
export function finishPlan(plan: IslandPlan): IslandPlan {
  if (plan.source !== 'plan') return plan

  return {
    ...plan,
    items: plan.items.map(item =>
      item.status === 'in_progress' ? { ...item, status: 'completed' } : item,
    ),
  }
}

/** The terminal's TodoWrite: the whole list, every time. */
export function applyTodoWrite(input: Raw): IslandPlan {
  const todos = Array.isArray(input.todos) ? input.todos.filter(isRecord) : []

  return {
    source: 'todo',
    items: todos.map((todo, index) => {
      const active = textOf(todo.activeForm)

      return {
        id: String(index + 1),
        title: clip(textOf(todo.content), 200),
        status: normStatus(todo.status),
        ...(active ? { active: clip(active, 200) } : {}),
      }
    }),
  }
}

/** TaskCreate adds a step under the id its result names. */
export function applyTaskCreate(plan: IslandPlan, input: Raw, result: unknown): IslandPlan {
  const task = isRecord(result) && isRecord(result.task) ? result.task : undefined
  const rawId = task?.id
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : ''
  if (!id) return plan

  const kept = plan.source === 'tasks' ? plan.items.filter(item => item.id !== id) : []
  const active = textOf(input.activeForm)
  const item: IslandItem = {
    id,
    title: clip(textOf(task?.subject) || textOf(input.subject), 200),
    status: 'pending',
    ...(active ? { active: clip(active, 200) } : {}),
  }

  return { source: 'tasks', items: [...kept, item] }
}

/** TaskUpdate changes one step; `deleted` drops it. */
export function applyTaskUpdate(plan: IslandPlan, input: Raw): IslandPlan {
  if (plan.source !== 'tasks') return plan

  const id = String(input.taskId ?? '')
  if (input.status === 'deleted') {
    return { ...plan, items: plan.items.filter(item => item.id !== id) }
  }

  const subject = textOf(input.subject)
  const active = textOf(input.activeForm)

  return {
    ...plan,
    items: plan.items.map(item =>
      item.id !== id
        ? item
        : {
            ...item,
            ...(subject ? { title: clip(subject, 200) } : {}),
            ...(input.status !== undefined ? { status: normStatus(input.status) } : {}),
            ...(active ? { active: clip(active, 200) } : {}),
          },
    ),
  }
}

/** One task-list tool call applied to the list, as `tool.call` saw it end. */
export function applyPlanTool(
  plan: IslandPlan,
  tool: string,
  input: Raw,
  result: unknown,
): IslandPlan {
  switch (tool) {
    case 'mcp__ccd_turn__update_plan':
      return applyUpdatePlan(plan, input)
    case 'mcp__ccd_turn__wrap_up':
      return finishPlan(plan)
    case 'TodoWrite':
      return applyTodoWrite(input)
    case 'TaskCreate':
      return applyTaskCreate(plan, input, result)
    case 'TaskUpdate':
      return applyTaskUpdate(plan, input)
    default:
      return plan
  }
}

export const PLAN_TOOLS: readonly string[] = [
  'mcp__ccd_turn__update_plan',
  'mcp__ccd_turn__wrap_up',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
]

type ToolUseLike = { tool: string; input: Raw; result?: unknown; isError?: true }

/**
 * The list as the conversation built it so far: what a mod loaded mid-session
 * (or a resumed session) shows before its first event.
 */
export function replayPlan(messages: readonly { toolUses: readonly ToolUseLike[] }[]): IslandPlan {
  let plan = EMPTY_PLAN
  for (const message of messages) {
    for (const use of message.toolUses) {
      if (use.isError !== true && PLAN_TOOLS.includes(use.tool)) {
        plan = applyPlanTool(plan, use.tool, use.input, use.result)
      }
    }
  }

  return plan
}

export type PlanStats = { done: number; total: number; current?: IslandItem }

export function planStats(plan: IslandPlan): PlanStats {
  const total = plan.items.length
  const done = plan.items.filter(item => item.status === 'completed').length
  const current = plan.items.find(item => item.status === 'in_progress')

  return current ? { done, total, current } : { done, total }
}

const baseName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return clip(url, 40)
  }
}

const MCP_NAME = /^mcp__(.+?)__(.+)$/

/** A tool call in a few words: what kind of work, and on what. */
export function describeTool(tool: string, input: Raw): { label: string; detail: string } {
  switch (tool) {
    case 'Bash':
      return { label: 'Bash', detail: clip(textOf(input.description) || textOf(input.command), 48) }
    case 'Read':
      return { label: '读取', detail: baseName(textOf(input.file_path)) }
    case 'Edit':
    case 'MultiEdit':
      return { label: '编辑', detail: baseName(textOf(input.file_path)) }
    case 'Write':
      return { label: '写入', detail: baseName(textOf(input.file_path)) }
    case 'NotebookEdit':
      return { label: '编辑', detail: baseName(textOf(input.notebook_path)) }
    case 'Grep':
      return { label: '搜索', detail: clip(textOf(input.pattern), 40) }
    case 'Glob':
      return { label: '找文件', detail: clip(textOf(input.pattern), 40) }
    case 'WebFetch':
      return { label: '读网页', detail: hostOf(textOf(input.url)) }
    case 'WebSearch':
      return { label: '搜网页', detail: clip(textOf(input.query), 40) }
    case 'Agent':
    case 'Task':
      return {
        label: '子代理',
        detail: clip(textOf(input.description) || textOf(input.subagent_type), 40),
      }
    case 'Skill':
      return { label: '技能', detail: clip(textOf(input.skill), 40) }
    case 'AskUserQuestion':
      return { label: '提问', detail: '' }
    case 'ExitPlanMode':
      return { label: '提交计划', detail: '' }
    case 'ToolSearch':
      return { label: '加载工具', detail: '' }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'mcp__ccd_turn__update_plan':
      return { label: '更新任务', detail: '' }
    case 'mcp__ccd_turn__wrap_up':
      return { label: '收尾', detail: '' }
    default: {
      const mcp = MCP_NAME.exec(tool)
      if (mcp?.[1] !== undefined && mcp[2] !== undefined) {
        return {
          label: clip(mcp[2].replace(/_/g, ' '), 28),
          detail: clip(mcp[1].replace(/^plugin_[^_]+_/, ''), 28),
        }
      }

      return { label: clip(tool, 28), detail: '' }
    }
  }
}

/** The id a backgrounded Bash call's record carries. */
export function backgroundIdOf(result: unknown): string | undefined {
  const id = isRecord(result) ? result.backgroundTaskId : undefined

  return typeof id === 'string' && id !== '' ? id : undefined
}

/** A background task's notification: which task, and how it ended. */
export function parseTaskNotification(value: string): { id: string; status: string } | undefined {
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(value)?.[1]
  if (id === undefined) return undefined

  return { id, status: /<status>\s*([^<]*?)\s*<\/status>/.exec(value)?.[1] ?? '' }
}

/** A notification arrives once a task has ended: failed, or else done. */
export function endedStatusOf(status: string): IslandJob['status'] {
  return /fail|error|kill|stop|cancel/i.test(status) ? 'failed' : 'done'
}

function agentStatusOf(status: string): IslandJob['status'] {
  if (status === 'failed' || status === 'killed') return 'failed'

  return status === 'completed' || status === 'idle' ? 'done' : 'running'
}

/** Every running job, and the last six that ended. */
export function trimJobs(jobs: IslandJob[]): IslandJob[] {
  const ended = jobs.filter(job => job.status !== 'running').slice(-6)

  return jobs.filter(job => job.status === 'running' || ended.includes(job))
}

type AgentLike = { id: string; description: string; type: string; status: string }

/** Folds `$.agent.list()` into the jobs: an agent the list dropped has ended. */
export function mergeAgents(jobs: IslandJob[], agents: readonly AgentLike[]): IslandJob[] {
  const listed = new Map(agents.map(agent => [agent.id, agent]))
  const merged = jobs.map((job): IslandJob => {
    if (job.kind !== 'agent') return job
    const agent = listed.get(job.id)
    if (agent === undefined) return job.status === 'running' ? { ...job, status: 'done' } : job
    listed.delete(job.id)

    return { ...job, status: agentStatusOf(agent.status) }
  })

  for (const agent of listed.values()) {
    merged.push({
      id: agent.id,
      kind: 'agent',
      label: clip(agent.description || agent.type, 40),
      status: agentStatusOf(agent.status),
    })
  }

  return trimJobs(merged)
}

export type Tone = 'work' | 'wait' | 'done' | 'error' | 'idle'

/** What the capsule says, one row: a tone, a title and the side facts. */
export type IslandView = {
  tone: Tone
  title: string
  done: number
  total: number
  /** The running tool, or the jobs still running; '' for none. */
  chip: string
  /** The running turn's clock, or how long the last one took; '' for none. */
  time: string
  running: IslandCall[]
  ended: IslandCall[]
}

const WAITING_TITLE = { question: '等你回答问题', plan: '等你审阅计划' } as const

export function viewOf(
  plan: IslandPlan,
  activity: IslandActivity,
  jobs: IslandJob[],
  calls: IslandCall[],
  now: number,
  isWorking: boolean,
): IslandView {
  const stats = planStats(plan)
  const running = calls.filter(call => call.status === 'running')
  const ended = calls.filter(call => call.status !== 'running').slice(-4)
  const tool = running[running.length - 1]
  const jobsRunning = jobs.filter(job => job.status === 'running').length
  const ending: IslandPhase = activity.phase === 'working' ? 'idle' : activity.phase

  let tone: Tone = 'idle'
  if (activity.waiting !== undefined && isWorking) tone = 'wait'
  else if (isWorking) tone = 'work'
  else if (ending === 'done') tone = 'done'
  else if (ending === 'error') tone = 'error'

  let title: string
  if (tone === 'wait' && activity.waiting === 'permission') {
    title = `等你授权${activity.waitingTool ? ` ${activity.waitingTool}` : ''}`
  } else if (tone === 'wait' && activity.waiting !== undefined && activity.waiting !== 'permission') {
    title = WAITING_TITLE[activity.waiting]
  } else if (stats.current) {
    title = isWorking && stats.current.active ? stats.current.active : stats.current.title
  } else if (isWorking) {
    title = tool ? '正在干活' : '思考中…'
  } else if (stats.total > 0 && stats.done === stats.total) {
    title = '全部完成'
  } else if (ending === 'done') {
    title = '已完成'
  } else if (ending === 'error') {
    title = '本轮出错了'
  } else if (ending === 'aborted') {
    title = '已中断'
  } else {
    title = '就绪'
  }

  let chip = ''
  if (tool) chip = tool.detail ? `${tool.label} · ${tool.detail}` : tool.label
  else if (jobsRunning > 0) chip = `子任务 ${jobsRunning} 个运行中`

  let time = ''
  if (isWorking && activity.turnStartedAt !== undefined && now >= activity.turnStartedAt) {
    time = clock(now - activity.turnStartedAt)
  } else if (!isWorking && activity.lastDurationMs !== undefined && ending !== 'idle') {
    time = `用时 ${clock(activity.lastDurationMs)}`
  }

  return { tone, title, done: stats.done, total: stats.total, chip, time, running, ended }
}

/** The toast a finished turn raises, if it is worth one. */
export function turnToast(
  phase: IslandPhase,
  stats: PlanStats,
  durationMs: number,
  toolCount: number,
): string | undefined {
  const took = `用时 ${clock(durationMs)}`
  if (phase === 'error') return `✗ 本轮出错结束 · ${took}`
  if (phase !== 'done') return undefined
  if (stats.total === 0 && durationMs < 15_000 && toolCount < 3) return undefined

  return stats.total > 0
    ? `✓ 任务完成 ${stats.done}/${stats.total} · ${took}`
    : `✓ 完成 · ${took}`
}

/** Prompts no person typed: a woken task, another session, a channel. */
const MACHINE_ORIGINS: readonly string[] = [
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'projects-relay',
  'channel',
]

export const isMachineOrigin = (kind: string): boolean => MACHINE_ORIGINS.includes(kind)

/** The file a session publishes for the screen island. */
export function snapshotOf(args: {
  sessionId: string
  cwd: string
  prompt: string
  plan: IslandPlan
  activity: IslandActivity
  jobs: IslandJob[]
  calls: IslandCall[]
  closed: boolean
  updatedAt: number
}): IslandSnapshot {
  const { activity } = args
  const running = args.calls.filter(call => call.status === 'running')
  const tool = running[running.length - 1]

  return {
    v: 1,
    sessionId: args.sessionId,
    cwd: args.cwd,
    prompt: args.prompt,
    phase: activity.phase,
    waiting: activity.waiting ?? null,
    waitingTool: activity.waitingTool ?? null,
    turnStartedAt: activity.turnStartedAt ?? null,
    lastDurationMs: activity.lastDurationMs ?? null,
    endedAt: activity.endedAt ?? null,
    plan: args.plan.items.map(item => ({
      title: item.title,
      status: item.status,
      active: item.active ?? null,
    })),
    tool: tool ? { label: tool.label, detail: tool.detail } : null,
    jobs: args.jobs.map(job => ({ label: job.label, status: job.status, kind: job.kind })),
    closed: args.closed,
    updatedAt: args.updatedAt,
  }
}

/** The `[on|off]` of `/island`, or a flip of what stands. */
export function hiddenFrom(args: string, isHidden: boolean): boolean {
  const arg = args.trim().toLowerCase()
  if (/^(off|hide|关|关闭|隐藏)$/.test(arg)) return true
  if (/^(on|show|开|打开|显示)$/.test(arg)) return false

  return !isHidden
}
