import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type {
  IslandActivity,
  IslandCall,
  IslandItem,
  IslandJob,
  IslandPlan,
  IslandWaiting,
} from '../types'
import {
  EMPTY_PLAN,
  IDLE,
  PLAN_TOOLS,
  applyPlanTool,
  backgroundIdOf,
  describeTool,
  endedStatusOf,
  hiddenFrom,
  isMachineOrigin,
  isRecord,
  mergeAgents,
  parseTaskNotification,
  planStats,
  replayPlan,
  snapshotOf,
  textOf,
  trimJobs,
  turnToast,
  viewOf,
} from './logic'
import type { IslandView, Tone } from './logic'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const plan = atom({ plugin: 'dynamic-island', key: 'plan' } as const, EMPTY_PLAN, {
  shape: 'plan-1',
})
const activity = atom({ plugin: 'dynamic-island', key: 'activity' } as const, IDLE, {
  shape: 'activity-1',
})
const jobs = atom({ plugin: 'dynamic-island', key: 'jobs' } as const, [] as IslandJob[], {
  shape: 'jobs-1',
})
const recent = atom({ plugin: 'dynamic-island', key: 'recent' } as const, [] as IslandCall[], {
  shape: 'recent-1',
})
const now = atom({ plugin: 'dynamic-island', key: 'now' } as const, 0)
const prompt = atom({ plugin: 'dynamic-island', key: 'prompt' } as const, '')
const isExpanded = atom({ plugin: 'dynamic-island', key: 'isExpanded' } as const, false)
// The screen island is the main view: the capsule in the client stays folded
// away until `/island on`.
const isHidden = atom({ plugin: 'dynamic-island', key: 'isHidden' } as const, true)

/** Where every session publishes itself for the screen island. */
const SESSIONS_DIR = '.claude/dynamic-island/sessions'
/** The screen island app the plugin starts with each session. */
const ISLAND_APP = 'Applications/ClaudeIsland.app'
/** Left by the island's 退出: no automatic start until the app is opened by hand. */
const OFF_FLAG = '.claude/dynamic-island/off'

/** The black capsule's palette: one look on light and dark themes alike. */
const INK = {
  bg: '#161615',
  text: '#F5F4ED',
  dim: '#A3A29B',
  chipBg: '#2C2C2A',
  chipText: '#D3D1C7',
  track: '#3D3D3A',
} as const

const TONE: Record<Tone, string> = {
  work: '#5DCAA5',
  wait: '#EF9F27',
  done: '#97C459',
  error: '#F09595',
  idle: '#888780',
}

const TONE_WORD: Record<Tone, string> = {
  work: '运行中',
  wait: '等你处理',
  done: '已完成',
  error: '出错',
  idle: '空闲',
}

/** The breathing light: a halo that swells and fades while work goes on. */
function dotSvg(tone: Tone): string {
  const color = TONE[tone]
  const dur = tone === 'wait' ? '0.9s' : '1.6s'
  const halo =
    tone === 'work' || tone === 'wait'
      ? `<circle cx="8" cy="8" r="4" fill="${color}"><animate attributeName="r" values="3.5;7.5;3.5" dur="${dur}" repeatCount="indefinite"/><animate attributeName="opacity" values="0.55;0;0.55" dur="${dur}" repeatCount="indefinite"/></circle>`
      : ''
  let core = `<circle cx="8" cy="8" r="3.6" fill="${color}"/>`
  if (tone === 'done') {
    core = `<circle cx="8" cy="8" r="6" fill="${color}"/><path d="M5.2 8.2l1.9 1.9 3.7-3.9" fill="none" stroke="${INK.bg}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
  } else if (tone === 'error') {
    core = `<circle cx="8" cy="8" r="6" fill="${color}"/><path d="M8 4.8v3.8M8 11v.2" stroke="${INK.bg}" stroke-width="1.8" stroke-linecap="round"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${halo}${core}</svg>`
}

/** A thin progress track, filled to the steps done. */
function barSvg(done: number, total: number, color: string): string {
  const width = 48
  const fill = total > 0 ? Math.round((done / total) * width) : 0
  const bar = fill > 0 ? `<rect width="${Math.max(fill, 6)}" height="6" rx="3" fill="${color}"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6"><rect width="${width}" height="6" rx="3" fill="${INK.track}"/>${bar}</svg>`
}

function barText(done: number, total: number): string {
  const cells = 6
  const full = total > 0 ? Math.round((done / total) * cells) : 0

  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

const MARK: Record<IslandItem['status'], string> = {
  completed: '✓',
  in_progress: '●',
  pending: '○',
}

const JOB_WORD: Record<IslandJob['status'], string> = {
  running: '运行中',
  done: '已结束',
  failed: '失败',
}

const callText = (call: IslandCall): string =>
  call.detail ? `${call.label} ${call.detail}` : call.label

// Timers live in the module: a reload drops them, and session.start starts
// the clock again when a turn is still running.
let ticker: Timer | undefined
let ticks = 0

async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // The island is a display: a failed write waits for the next event.
  }
}

async function refreshAgents($: EngineInterface): Promise<void> {
  const agents = await $.agent.list()
  const current = await read($, jobs)
  const merged = mergeAgents(current, agents)
  if (JSON.stringify(merged) !== JSON.stringify(current)) {
    await update($, jobs, () => merged)
  }
}

// Who this session is, for the file it publishes; set at session.start.
let home: string | undefined
let sessionId: string | undefined
let sessionCwd = ''
let publishTimer: Timer | undefined

/** Writes this session's file for the screen island, now. */
async function publish($: EngineInterface, closed = false): Promise<void> {
  if (home === undefined || sessionId === undefined) return
  const [currentPlan, currentActivity, currentJobs, calls, latestPrompt, at] = await Promise.all([
    read($, plan),
    read($, activity),
    read($, jobs),
    read($, recent),
    read($, prompt),
    $.clock.now(),
  ])
  const snapshot = snapshotOf({
    sessionId,
    cwd: sessionCwd,
    prompt: latestPrompt,
    plan: currentPlan,
    activity: currentActivity,
    jobs: currentJobs,
    calls,
    closed,
    updatedAt: at,
  })
  await $.fs.write(`${home}/${SESSIONS_DIR}/${sessionId}.json`, JSON.stringify(snapshot))
}

/** Publishes once the burst of changes settles: a tool call makes several. */
function publishSoon($: EngineInterface): void {
  if (publishTimer !== undefined || home === undefined) return
  publishTimer = $.clock.after(250, () => {
    publishTimer = undefined
    void quietly(() => publish($))
  })
}

/** A toast in the client, only while its capsule shows: else the screen island tells. */
async function toast($: EngineInterface, text: string, timeoutMs?: number): Promise<void> {
  if (await read($, isHidden)) return
  $.ui.toast(text, timeoutMs === undefined ? undefined : { timeoutMs })
}

function startTicker($: EngineInterface): void {
  if (ticker !== undefined) return
  ticker = $.clock.every(1000, () => {
    ticks += 1
    void quietly(async () => {
      const at = await $.clock.now()
      await update($, now, () => at)
      if (ticks % 3 === 0) await refreshAgents($)
      // A heartbeat: a working session that stops writing has gone away.
      if (ticks % 5 === 0) publishSoon($)
    })
  })
}

function stopTicker(): void {
  ticker?.cancel()
  ticker = undefined
}

function withoutWaiting(current: IslandActivity): IslandActivity {
  const { waiting: _waiting, waitingTool: _tool, ...rest } = current

  return rest
}

async function beforeCall(
  $: EngineInterface,
  tool: string,
  id: string,
  input: Record<string, unknown>,
): Promise<void> {
  const { label, detail } = describeTool(tool, input)
  const call: IslandCall = { id, label, detail, status: 'running' }
  await update($, recent, list => [...list.filter(one => one.id !== id), call].slice(-12))

  const waiting: IslandWaiting | undefined =
    tool === 'AskUserQuestion' ? 'question' : tool === 'ExitPlanMode' ? 'plan' : undefined
  await update($, activity, (current): IslandActivity => ({
    ...current,
    toolCount: current.toolCount + 1,
    ...(waiting ? { waiting } : {}),
  }))
  publishSoon($)
  if (waiting === 'question') await toast($, 'Claude 在等你回答问题')
  if (waiting === 'plan') await toast($, 'Claude 在等你审阅计划')
}

async function afterCall(
  $: EngineInterface,
  tool: string,
  id: string,
  input: Record<string, unknown>,
  isMain: boolean,
  isOk: boolean,
  result: unknown,
): Promise<void> {
  if (isMain) {
    await update($, recent, list =>
      list.map((one): IslandCall => (one.id === id ? { ...one, status: isOk ? 'done' : 'error' } : one)),
    )
    await update($, activity, current => {
      const isAnswered =
        current.waiting === 'permission' ||
        (current.waiting === 'question' && tool === 'AskUserQuestion') ||
        (current.waiting === 'plan' && tool === 'ExitPlanMode')

      return isAnswered ? withoutWaiting(current) : current
    })
  }
  if (!isOk) return

  if (isMain && PLAN_TOOLS.includes(tool)) {
    await update($, plan, (current): IslandPlan => applyPlanTool(current, tool, input, result))
  }

  if (tool === 'Bash') {
    const jobId = backgroundIdOf(result)
    if (jobId !== undefined) {
      const job: IslandJob = {
        id: jobId,
        kind: 'shell',
        label: describeTool(tool, input).detail || 'Bash',
        status: 'running',
      }
      await update($, jobs, list => trimJobs([...list.filter(one => one.id !== jobId), job]))
    }
  }
  if (tool === 'TaskStop') {
    const stopped = textOf(input.task_id) || textOf(input.shell_id)
    if (stopped) {
      await update($, jobs, list =>
        list.map((one): IslandJob => (one.id === stopped ? { ...one, status: 'failed' } : one)),
      )
    }
  }
  if (tool === 'Agent' || tool === 'Task') await refreshAgents($)
  publishSoon($)
}

/** Starts the screen island with the session; `open` leaves a running one be. */
async function launchIsland($: EngineInterface, homeDir: string): Promise<void> {
  const app = `${homeDir}/${ISLAND_APP}`
  if (!(await $.fs.exists(app)) || (await $.fs.exists(`${homeDir}/${OFF_FLAG}`))) return
  await $.process.run(['/usr/bin/open', '-g', app], { timeoutMs: 15_000 })
}

/**
 * `/island app`: builds the screen island from the plugin's own source into
 * ~/Applications and opens it, a running copy replaced. One command after
 * installing the plugin; again after an update.
 */
async function installIsland($: EngineInterface): Promise<string> {
  const homeDir = await $.env.get('HOME')
  if (!homeDir) return '找不到 HOME 目录，没法安装屏幕灵动岛。'
  const script = `${$.plugin.root}/island/build.sh`
  if (!(await $.fs.exists(script))) return `插件里没有找到 ${script}。`

  // Asked first: a missing toolchain otherwise pops the system's install dialog.
  const tools = await $.process
    .run(['/usr/bin/xcode-select', '-p'], { timeoutMs: 15_000 })
    .catch(() => undefined)
  if (tools === undefined || tools.exitCode !== 0) {
    return '编译屏幕灵动岛需要 Xcode 命令行工具：先在终端运行 xcode-select --install，装好后再输入 /island app。'
  }

  const app = `${homeDir}/${ISLAND_APP}`
  const built = await $.process.run(['/bin/sh', script, app], { timeoutMs: 300_000 })
  if (built.exitCode !== 0) {
    const why = (built.stderr || built.stdout).trim().split('\n').slice(-8).join('\n')
    return `屏幕灵动岛编译失败：\n${why}`
  }

  // The running copy still holds the old build: replace it.
  await $.process.run(['/usr/bin/pkill', '-x', 'ClaudeIsland'], { timeoutMs: 15_000 }).catch(() => undefined)
  await $.clock.sleep(800)
  const opened = await $.process.run(['/usr/bin/open', app], { timeoutMs: 15_000 })
  if (opened.exitCode !== 0) return `屏幕灵动岛已编译到 ${app}，但没能打开：${opened.stderr.trim()}`

  return `屏幕灵动岛已编译并打开（${app}）。有会话在运行时它出现在屏幕顶部正中，点一下或悬停展开所有会话；以后每个会话开始时会自动打开它。`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await quietly(async () => {
      await $.command.register({
        name: 'island',
        description: '灵动岛：on/off 显示或收起输入框上方的胶囊，app 编译并打开屏幕顶部的灵动岛',
        argumentHint: '[on|off|app]',
      })
      // Hidden unless the person turned the capsule on with /island on.
      const hidden = (await $.store.get('hidden')) !== false
      if (hidden !== (await read($, isHidden))) await update($, isHidden, () => hidden)
      if ((await read($, activity)).phase === 'working') startTicker($)
    })
    // Loaded mid-session or into a resumed one: the list the conversation
    // already built, so the island starts where the work stands.
    await quietly(async () => {
      if ((await read($, plan)).source !== 'none') return
      const replayed = replayPlan(await $.session.messages())
      if (replayed.source !== 'none') await update($, plan, () => replayed)
    })
    // Who publishes: this session, under its id, for the screen island.
    await quietly(async () => {
      const homeDir = await $.env.get('HOME')
      if (!homeDir) return
      sessionId = await $.session.id()
      sessionCwd = e.cwd
      home = homeDir
      await publish($)
      await launchIsland($, homeDir)
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopTicker()
    publishTimer?.cancel()
    publishTimer = undefined
    await quietly(() => publish($, true))

    return next(e)
  })

  on('command.run', { command: 'island' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'app') {
      const text = await installIsland($).catch(
        (error: unknown) => `屏幕灵动岛没装上：${error instanceof Error ? error.message : String(error)}`,
      )

      return { text }
    }

    const hide = hiddenFrom(e.args, await read($, isHidden))
    await update($, isHidden, () => hide)
    await $.store.set('hidden', hide)

    return {
      text: hide
        ? '输入框上方的灵动岛胶囊已收起（屏幕顶部的灵动岛照常显示），输入 /island on 可以找回。'
        : '输入框上方的灵动岛胶囊已显示，点「展开」看完整任务列表。',
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await quietly(async () => {
        const at = await $.clock.now()
        await update($, now, () => at)
        await update($, activity, (): IslandActivity => ({
          phase: 'working',
          turnStartedAt: at,
          toolCount: 0,
        }))
        await update($, recent, list => list.filter(one => one.status !== 'running').slice(-6))
        startTicker($)
        publishSoon($)
      })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId === undefined) {
      await quietly(async () => {
        stopTicker()
        const at = await $.clock.now()
        const before = await read($, activity)
        const durationMs =
          before.turnStartedAt !== undefined ? Math.max(0, at - before.turnStartedAt) : 0
        const phase = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error'
        await update($, activity, (current): IslandActivity => ({
          phase,
          toolCount: current.toolCount,
          lastDurationMs: durationMs,
          endedAt: at,
        }))
        await update($, recent, list =>
          list.map((one): IslandCall => (one.status === 'running' ? { ...one, status: 'done' } : one)),
        )
        await update($, now, () => at)
        await refreshAgents($)
        // The end goes out at once: the screen island tells the person.
        publishTimer?.cancel()
        publishTimer = undefined
        await publish($)
        const message = turnToast(phase, planStats(await read($, plan)), durationMs, before.toolCount)
        if (message !== undefined) await toast($, message, 6000)
      })
    }

    return answer
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input: Record<string, unknown> = { ...e }
    const isMain = e.agentId === undefined
    const id = e.tool_use_id
    if (isMain) await quietly(() => beforeCall($, tool, id, input))

    const ran = await next(e)
    const isOk = ran.deny === undefined && ran.isError !== true
    await quietly(() => afterCall($, tool, id, input, isMain, isOk, ran.result))

    return ran
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    if (answer.decision === undefined) {
      await quietly(async () => {
        const label = describeTool(e.tool_name, isRecord(e.tool_input) ? e.tool_input : {}).label
        await update($, activity, (current): IslandActivity => ({
          ...current,
          waiting: 'permission',
          waitingTool: label,
        }))
        publishSoon($)
        await toast($, `Claude 需要你授权：${label}`)
      })
    }

    return answer
  }).catch(($, e, next) => next(e))

  on('classic.PermissionDenied', async ($, e, next) => {
    const answer = await next(e)
    await quietly(async () => {
      await update($, activity, withoutWaiting)
      publishSoon($)
    })

    return answer
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const answer = await next(e)
    const inFlight = e.background_tasks
    if (Array.isArray(inFlight)) {
      await quietly(async () => {
        const live = new Set(inFlight.map(task => task.id))
        await update($, jobs, list =>
          list.map((one): IslandJob =>
            one.kind === 'shell' && one.status === 'running' && !live.has(one.id)
              ? { ...one, status: 'done' }
              : one,
          ),
        )
        publishSoon($)
      })
    }

    return answer
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const note = parseTaskNotification(e.text)
      if (note !== undefined) {
        await quietly(async () => {
          await update($, jobs, list =>
            list.map((one): IslandJob =>
              one.id === note.id ? { ...one, status: endedStatusOf(note.status) } : one,
            ),
          )
          publishSoon($)
        })
      }
    } else if (e.isMeta !== true && e.command === undefined && !isMachineOrigin(e.origin.kind)) {
      // What the person last asked: the screen island's title where the
      // client keeps none for the session.
      const said = e.text.replace(/\s+/g, ' ').trim().slice(0, 120)
      if (said !== '') await quietly(() => update($, prompt, () => said))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const [currentPlan, currentActivity, currentJobs, calls, at, isOpen] = await Promise.all([
      read($, plan),
      read($, activity),
      read($, jobs),
      read($, recent),
      read($, now),
      read($, isExpanded),
    ])
    const view: IslandView = viewOf(
      currentPlan,
      currentActivity,
      currentJobs,
      calls,
      at,
      e.props.isWorking,
    )
    const color = TONE[view.tone]
    const isTerminal = e.surface === 'terminal'
    const { Box, Text, Button } = $.ui.resolve(e)

    let icon: RenderChildren
    let bar: RenderChildren = null
    const surface = e.surface
    if (surface === 'terminal') {
      icon = <Text color={color}>{view.tone === 'done' ? '✓' : view.tone === 'error' ? '!' : '●'}</Text>
      if (view.total > 0) bar = <Text color={color}>{barText(view.done, view.total)}</Text>
    } else {
      const { Svg } = $.ui.resolve({ ...e, surface })
      const isAlive = view.tone === 'work' || view.tone === 'wait'
      icon = (
        <Svg
          source={dotSvg(view.tone)}
          alt={TONE_WORD[view.tone]}
          width={16}
          height={16}
          {...(isAlive ? { isInteractive: true } : {})}
        />
      )
      if (view.total > 0) {
        bar = <Svg source={barSvg(view.done, view.total, color)} alt={`进度 ${view.done}/${view.total}`} width={48} height={6} />
      }
    }

    const header = (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {icon}
        <Box flexShrink={1} minWidth={0} overflow="hidden">
          <Text color={INK.text} weight="semibold" wrap="truncate-end">
            {view.title}
          </Text>
        </Box>
        {view.total > 0 && (
          <Text color={INK.dim} tabular>
            {`${view.done}/${view.total}`}
          </Text>
        )}
        {bar}
        <Box flexGrow={1} />
        {view.chip !== '' && (
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text color={INK.chipText} backgroundColor={INK.chipBg} size="footnote" wrap="truncate-end">
              {` ${view.chip} `}
            </Text>
          </Box>
        )}
        {view.time !== '' && (
          <Text color={INK.dim} size="footnote" tabular>
            {view.time}
          </Text>
        )}
      </Box>
    )

    const detailRows: RenderChildren[] = []
    if (currentPlan.items.length === 0) {
      detailRows.push(
        <Text color={INK.dim} size="footnote">
          这一轮还没有任务清单
        </Text>,
      )
    }
    for (const item of currentPlan.items) {
      const markColor =
        item.status === 'completed' ? TONE.done : item.status === 'in_progress' ? color : INK.dim
      detailRows.push(
        <Box flexDirection="row" gap={1}>
          <Text color={markColor}>{MARK[item.status]}</Text>
          <Text
            color={item.status === 'completed' ? INK.dim : INK.text}
            weight={item.status === 'in_progress' ? 'semibold' : 'regular'}
            wrap="truncate-end"
          >
            {item.title}
          </Text>
        </Box>,
      )
    }
    if (view.running.length > 0) {
      detailRows.push(
        <Text color={INK.dim} size="footnote" wrap="truncate-end">
          {`正在运行：${view.running.map(callText).join(' · ')}`}
        </Text>,
      )
    }
    if (currentJobs.length > 0) {
      detailRows.push(
        <Text color={INK.dim} size="footnote" wrap="truncate-end">
          {`子任务：${currentJobs.map(job => `${job.label}（${JOB_WORD[job.status]}）`).join(' · ')}`}
        </Text>,
      )
    }
    if (view.ended.length > 0) {
      detailRows.push(
        <Text color={INK.dim} size="footnote" wrap="truncate-end">
          {`最近：${view.ended.map(call => `${call.status === 'error' ? '✗' : '✓'} ${callText(call)}`).join(' · ')}`}
        </Text>,
      )
    }

    const capsule = isTerminal
      ? { backgroundColor: INK.bg, paddingX: 1 }
      : { backgroundColor: INK.bg, borderStyle: 'round', borderColor: INK.bg, paddingX: 1 }

    return (
      <Box flexDirection="row" alignItems="flex-start" gap={1}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} {...capsule}>
          {header}
          {isOpen && (
            <Box flexDirection="column" paddingTop={1}>
              {detailRows}
            </Box>
          )}
        </Box>
        <Button
          key="toggle"
          plain
          dimColor
          label={isOpen ? '收起' : '展开'}
          onPress={() => update($, isExpanded, value => !value)}
        />
      </Box>
    )
  })
}
