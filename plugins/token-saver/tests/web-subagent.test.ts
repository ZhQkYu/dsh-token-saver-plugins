import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Scripted replies for the fake `ask`, keyed by call order. */
const replies: (string | (() => Promise<string>))[] = []
vi.mock('../src/web-ai-bridge/driver.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/web-ai-bridge/driver.ts')>()
  return {
    ...real,
    ask: vi.fn(async (_page: unknown, _provider: unknown, _prompt: string, _conversation: string, _timings: unknown, signal: AbortSignal) => {
      if (signal.aborted) throw new real.WebAiError('ABORTED', 'ask cancelled')
      const next = replies.shift() ?? '<final>default</final>'
      const text = typeof next === 'string' ? next : await next()
      return { text, truncated: false, timedOut: false, elapsedMs: 1 }
    }),
  }
})
vi.mock('../src/web-ai-bridge/browser.ts', () => ({
  BrowserManager: class {
    pageFor = vi.fn(async () => ({}))
    close = vi.fn(async () => undefined)
  },
}))

const { apply, Config } = await import('../src/web-ai-bridge/index.ts')

interface RegisteredTool {
  name: string
  timeoutMs?: number
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output?: { render: (args: unknown, value: never) => { text: string }[] }
}

function fakeContext(jobs?: unknown): { ctx: unknown; tools: Map<string, RegisteredTool>; sections: string[] } {
  const tools = new Map<string, RegisteredTool>()
  const sections: string[] = []
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    effect: () => undefined,
    tools: { register: (tool: RegisteredTool) => { tools.set(tool.name, tool) } },
    systemPrompt: { section: (section: { text: () => string }) => { sections.push(section.text()) } },
    get: (name: string) => name === 'jobs' ? jobs : undefined,
  }
  return { ctx, tools, sections }
}

const provider = (agent: boolean): Record<string, unknown> => ({
  id: 'ds',
  displayName: 'DS',
  url: 'https://ds.example/',
  strengths: 'x',
  enabled: true,
  minIntervalMs: 0,
  selectors: { input: 'i', message: 'm' },
  agent: { enabled: agent },
})

const config = (agent = true) => new Config({ browser: { mode: 'launch', channel: 'msedge', headless: false }, providers: [provider(agent)] })

async function exec(cwd: string, signal = new AbortController().signal): Promise<unknown> {
  return { signal, agent: { id: 'session-1', session: { header: { cwd } } } }
}

let cwd: string
beforeEach(async () => {
  replies.length = 0
  cwd = await mkdtemp(join(tmpdir(), 'web-sub-'))
  await writeFile(join(cwd, 'a.ts'), 'export function target() {}\n')
})

describe('web_subagent registration', () => {
  it('is registered only for providers with agent.enabled, without a tool deadline', () => {
    const off = fakeContext()
    apply(off.ctx as never, config(false))
    expect(off.tools.has('web_subagent')).toBe(false)
    expect(off.tools.get('web_ai_ask')!.timeoutMs).toBeGreaterThan(0)

    const on = fakeContext()
    apply(on.ctx as never, config(true))
    expect(on.tools.get('web_subagent')!.timeoutMs).toBeUndefined()
    expect(on.tools.get('web_ai_ask')!.timeoutMs).toBeGreaterThan(0)
    expect(on.sections.join('\n')).toContain('web_subagent')
  })

  it('runs in the foreground and returns only the final answer', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx as never, config())
    replies.push('<action>{"tool":"grep","args":{"pattern":"target"}}</action>', '<final>target is in a.ts:1</final>')
    const tool = tools.get('web_subagent')!
    const value = await tool.execute({ description: 'find target', prompt: 'where is target?' }, await exec(cwd)) as Record<string, unknown>
    expect(value).toMatchObject({ kind: 'foreground', status: 'completed', answer: 'target is in a.ts:1', toolCalls: 1, provider: 'ds' })
    const text = tool.output!.render({}, value as never)[0]!.text
    expect(text).toContain('target is in a.ts:1')
    expect(text).not.toContain('grep')
  })

  it('falls back to the foreground with a note when no job registry is loaded', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx as never, config())
    const value = await tools.get('web_subagent')!.execute({ description: 'd', prompt: 'p', run_in_background: true }, await exec(cwd)) as Record<string, unknown>
    expect(value).toMatchObject({ kind: 'foreground', note: expect.stringContaining('not loaded') })
  })

  it('falls back to the foreground when the job registry refuses the job', async () => {
    const { ctx, tools } = fakeContext({ start: () => { throw new Error('no job controller') } })
    apply(ctx as never, config())
    const value = await tools.get('web_subagent')!.execute({ description: 'd', prompt: 'p', run_in_background: true }, await exec(cwd)) as Record<string, unknown>
    expect(value).toMatchObject({ kind: 'foreground', note: expect.stringContaining('no job controller') })
  })

  it('runs as a background job and reports completion and kill outcomes', async () => {
    let spec: { kind: string; owner?: string; run: (job: unknown) => { cancel: (reason?: string) => void; done: Promise<unknown> } } | undefined
    const { ctx, tools } = fakeContext({ start: (value: typeof spec) => { spec = value; return 'web-subagent-1' } })
    apply(ctx as never, config())
    const tool = tools.get('web_subagent')!
    const value = await tool.execute({ description: 'd', prompt: 'p', run_in_background: true }, await exec(cwd))
    expect(value).toEqual({ kind: 'background', jobId: 'web-subagent-1' })
    expect(spec).toMatchObject({ kind: 'web-subagent', owner: 'session-1' })

    replies.push('<final>bg answer</final>')
    const progress: string[] = []
    const completed = spec!.run({ updateProgress: (line: string) => { progress.push(line) }, append: () => undefined })
    expect(await completed.done).toMatchObject({ status: 'completed', result: expect.stringContaining('bg answer') })

    let release: (text: string) => void = () => undefined
    replies.push(() => new Promise<string>(resolve => { release = resolve }))
    const killed = spec!.run({ updateProgress: () => undefined, append: () => undefined })
    await new Promise(resolve => setTimeout(resolve, 10))
    killed.cancel('user')
    release('<action>{"tool":"list_dir"}</action>')
    expect(await killed.done).toEqual({ status: 'killed' })
  })

  it('rejects an empty prompt and an unknown provider', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx as never, config())
    const tool = tools.get('web_subagent')!
    await expect(tool.execute({ description: 'd', prompt: '  ' }, await exec(cwd))).rejects.toThrow('non-empty')
    await expect(tool.execute({ description: 'd', prompt: 'p', provider: 'zz' }, await exec(cwd))).rejects.toThrow('provider')
  })

  it('propagates cancellation of a foreground run', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx as never, config())
    const controller = new AbortController()
    controller.abort()
    await expect(tools.get('web_subagent')!.execute({ description: 'd', prompt: 'p' }, await exec(cwd, controller.signal))).rejects.toThrow()
  })
})
