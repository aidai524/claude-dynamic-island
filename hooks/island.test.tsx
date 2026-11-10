import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const band = (isWorking: boolean) =>
  ({
    plugin: 'dynamic-island',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking,
      maxRows: 30,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const SURFACES = ['terminal', 'desktop'] as const

const PLAN = [
  { content: '加载插件编写技能', status: 'completed' },
  { content: '实现灵动岛插件', status: 'in_progress' },
  { content: '验证实时更新', status: 'pending' },
]

/** The capsule in the client starts folded away: `/island on` shows it. */
async function showCapsule($: { command: { run: (e: never) => Promise<unknown> } }) {
  await $.command.run({ command: 'island', args: 'on' } as never)
}

/** Stands for the engine's own band, drawn when the island passes. */
function engineBand(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

test('the capsule in the client is folded away until /island on', async ($, on) => {
  engineBand(on)
  mock.store(on)
  const folded = await $.ui.mount({ ...band(false), surface: 'desktop' })
  expect(await folded.find({ type: 'Text', text: /就绪/ })).toBeUndefined()
  expect(await folded.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await folded.unmount()

  await showCapsule($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(false), surface })
    expect((await ui.find({ type: 'Text', text: /就绪/ }))?.text).toBe('就绪')
    await ui.unmount()
  }

  const hidden = await $.command.run({ command: 'island', args: 'off' } as never)
  expect(String((hidden as { text?: string }).text)).toContain('已收起')
  const again = await $.ui.mount({ ...band(false), surface: 'desktop' })
  expect(await again.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await again.unmount()
})

test('the Code tab plan drives the title and the count', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: {} }))

  await showCapsule($)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: PLAN } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(true), surface })
    expect(await ui.find({ type: 'Text', text: '实现灵动岛插件' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '1/3' }))?.text).toBe('1/3')
    await ui.unmount()
  }

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)

  const ui = await $.ui.mount({ ...band(true), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '验证实时更新' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '2/3' }))?.text).toBe('2/3')
  await ui.unmount()
})

test('pressing 展开 lists every step, and 收起 folds it', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: {} }))
  await showCapsule($)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: PLAN } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(true), surface })
    expect(await ui.find({ type: 'Text', text: '验证实时更新' })).toBeUndefined()

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: '加载插件编写技能' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '验证实时更新' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'toggle' }))?.text).toBe('收起')

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: '验证实时更新' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a running tool shows in the chip until it ends', async ($, on) => {
  mock.store(on)
  let enter = () => {}
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') {
      enter()
      await gate
    }

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await showCapsule($)
  const running = $.tool.call({ tool: 'Bash', command: 'npm test', description: '跑测试' })
  await entered

  const ui = await $.ui.mount({ ...band(true), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Bash · 跑测试/ })).toBeDefined()

  release()
  await running
  expect(await ui.find({ type: 'Text', text: /Bash · 跑测试/ })).toBeUndefined()
  await ui.unmount()
})

test('a TodoWrite list counts as well, and a finished list reads all done', async ($, on) => {
  mock.store(on)
  on('tool.call', () => ({ result: {} }))
  await showCapsule($)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Run tests', status: 'completed', activeForm: 'Running tests' },
      { content: 'Fix lint', status: 'completed', activeForm: 'Fixing lint' },
    ],
  })

  const ui = await $.ui.mount({ ...band(false), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '全部完成' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '2/2' }))?.text).toBe('2/2')
  await ui.unmount()
})

test('a turn runs a live clock, then reads done with its time', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await showCapsule($)
  await $.turn.start({ text: '做个灵动岛', turnId: 't1' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: PLAN } as never)
  await clock.advance(65_000)

  const live = await $.ui.mount({ ...band(true), surface: 'desktop' })
  expect(await live.find({ type: 'Text', text: '01:05' })).toBeDefined()
  await live.unmount()

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [2, 3] } as never)
  await $.turn.complete({
    answer: '好了',
    durationMs: 65_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  } as never)

  const after = await $.ui.mount({ ...band(false), surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: '全部完成' })).toBeDefined()
  expect(await after.find({ type: 'Text', text: '用时 01:05' })).toBeDefined()
  await after.unmount()
})

test('loaded mid-session, the island replays the list the conversation built', async ($, on) => {
  mock.store(on)
  on('command.register', () => ({ value: { command: 'island' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({
    value: [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'a', tool: 'mcp__ccd_turn__update_plan', input: { items: PLAN }, text: 'ok' },
          { tool_use_id: 'b', tool: 'Bash', input: { command: 'ls' }, text: '' },
          { tool_use_id: 'c', tool: 'mcp__ccd_turn__update_plan', input: { advance: true }, text: 'ok' },
        ],
      },
    ],
  }))

  await showCapsule($)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(true), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '验证实时更新' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '2/3' }))?.text).toBe('2/3')
  await ui.unmount()
})

test('each session publishes its progress for the screen island, and starts it', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/Users/test' })
  const writes: { path: string; text: string }[] = []
  const runs: (readonly string[])[] = []
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  // The app is there; the 退出 flag is not.
  on('fs.exists', (_, e) => ({ value: !e.path.endsWith('/off') }))
  on('process.run', (_, e) => {
    runs.push(e.argv)

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'island' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/Users/test/proj', surface: 'desktop', isInteractive: true })
  const path = '/Users/test/.claude/dynamic-island/sessions/sess-1.json'
  expect(writes[0]?.path).toBe(path)
  expect(runs[0]).toEqual(['/usr/bin/open', '-g', '/Users/test/Applications/ClaudeIsland.app'])

  await $.turn.start({ text: '做个灵动岛', turnId: 't1' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: PLAN } as never)
  await clock.advance(400)
  const working = JSON.parse(writes[writes.length - 1]?.text ?? '{}')
  expect(working.phase).toBe('working')
  expect(working.cwd).toBe('/Users/test/proj')
  expect(working.plan.length).toBe(3)
  expect(working.plan[1].status).toBe('in_progress')

  await clock.advance(20_000)
  await $.turn.complete({
    answer: '好了',
    durationMs: 20_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  } as never)
  const done = JSON.parse(writes[writes.length - 1]?.text ?? '{}')
  expect(done.phase).toBe('done')
  expect(done.endedAt).toBe(clock.now())
  expect(done.lastDurationMs).toBe(20_400)

  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  const closed = JSON.parse(writes[writes.length - 1]?.text ?? '{}')
  expect(closed.closed).toBe(true)
})

const RAN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('/island app builds the screen island from the plugin and opens it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/Users/test' })
  const runs: (readonly string[])[] = []
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    runs.push(e.argv)

    return { value: RAN }
  })

  // The old copy gets a moment to quit before the new one opens.
  const running = $.command.run({ command: 'island', args: 'app' } as never)
  await clock.advance(1_000)
  const ran = (await running) as { text?: string }

  expect(String(ran.text)).toContain('已编译并打开')
  expect(runs[0]).toEqual(['/usr/bin/xcode-select', '-p'])
  expect(runs[1]?.[0]).toBe('/bin/sh')
  expect(String(runs[1]?.[1])).toMatch(/\/island\/build\.sh$/)
  expect(runs[1]?.[2]).toBe('/Users/test/Applications/ClaudeIsland.app')
  expect(runs[2]).toEqual(['/usr/bin/pkill', '-x', 'ClaudeIsland'])
  expect(runs[3]).toEqual(['/usr/bin/open', '/Users/test/Applications/ClaudeIsland.app'])
})

test('/island app says what to install when Xcode tools are missing', async ($, on) => {
  mock.env(on, { HOME: '/Users/test' })
  const runs: (readonly string[])[] = []
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    runs.push(e.argv)

    return { value: { ...RAN, exitCode: 2 } }
  })

  const ran = (await $.command.run({ command: 'island', args: 'app' } as never)) as { text?: string }

  expect(String(ran.text)).toContain('xcode-select --install')
  expect(runs.length).toBe(1)
})
