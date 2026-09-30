import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentAbortError, parseAction, parseTurn, redact, runAgent, workspaceTools, type AgentConfig } from '../src/web-ai-bridge/agent.ts'

const config: AgentConfig = { enabled: true, maxSteps: 3, observationMaxChars: 1000, formatRetries: 1, contextResetChars: 100_000, pageRetries: 1 }
const signal = (): AbortSignal => new AbortController().signal

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'web-agent-'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'lib'))
  await writeFile(join(root, 'src', 'a.ts'), 'export const answer = 42\nconst key = "sk-abcdefghijklmnopqrstuvwx"\n')
  await writeFile(join(root, 'src', 'b.test.ts'), 'answer test\n')
  await writeFile(join(root, 'src', 'bin.dat'), Buffer.from([0, 1, 2, 97, 110, 115, 119, 101, 114]))
  await writeFile(join(root, 'lib', 'a.js'), 'answer built\n')
  await writeFile(join(root, '.env'), 'SECRET=1\n')
  await writeFile(join(root, '.env.example'), 'API_URL=\n')
  return root
}

/** Scripted web AI: returns replies in order and records messages. */
function script(replies: (string | Error)[]): { ask: (message: string, conversation: 'new' | 'continue') => Promise<string>; sent: { message: string; conversation: string }[] } {
  const sent: { message: string; conversation: string }[] = []
  return {
    sent,
    ask: async (message, conversation) => {
      sent.push({ message, conversation })
      const next = replies.shift()
      if (next === undefined) return '<final>out of script</final>'
      if (next instanceof Error) throw next
      return next
    },
  }
}

describe('parseTurn', () => {
  it('prefers a final block that follows the actions', () => {
    expect(parseTurn('<action>{"tool":"a"}</action><final>x</final>')).toEqual({ type: 'final', answer: 'x' })
    expect(parseTurn('thinking… <final>done</final>')).toEqual({ type: 'final', answer: 'done' })
  })

  it('runs actions when a final block comes first (the model is not done)', () => {
    expect(parseTurn('<final>draft</final><action>{"tool":"a"}</action>')).toEqual({ type: 'actions', actions: [{ tool: 'a', args: {} }] })
  })

  it('batches several actions and parses fenced, loose, and aliased JSON', () => {
    expect(parseTurn('<action>```json\n{"tool":"grep","args":{"pattern":"a"}}\n```</action>'))
      .toEqual({ type: 'actions', actions: [{ tool: 'grep', args: { pattern: 'a' } }] })
    expect(parseTurn('<action>{"tool":"a"}</action> and <action>{"name":"b","arguments":{"x":1,},}</action>'))
      .toEqual({ type: 'actions', actions: [{ tool: 'a', args: {} }, { tool: 'b', args: { x: 1 } }] })
    expect(parseTurn('&lt;action&gt;{"tool":"a"}&lt;/action&gt;')).toEqual({ type: 'actions', actions: [{ tool: 'a', args: {} }] })
    expect(parseTurn('<ACTION>call {"tool": "a", "args": {"q": "}"}} now</ACTION>'))
      .toEqual({ type: 'actions', actions: [{ tool: 'a', args: { q: '}' } }] })
  })

  it('accepts an unclosed final or action cut off at the end of the reply', () => {
    expect(parseTurn('<final>partial answer')).toEqual({ type: 'final', answer: 'partial answer' })
    expect(parseTurn('<action>{"tool":"a"}')).toEqual({ type: 'actions', actions: [{ tool: 'a', args: {} }] })
  })

  it('reports invalid replies with a reason', () => {
    expect(parseTurn('no blocks')).toMatchObject({ type: 'invalid' })
    expect(parseTurn('<final>  </final>')).toMatchObject({ type: 'invalid', reason: 'the <final> block is empty' })
    expect(parseTurn('<action>{bad}</action>')).toMatchObject({ type: 'invalid' })
    expect(parseAction('[1]')).toEqual({ invalid: 'action must be a JSON object' })
    expect(parseAction('{"tool": 3}')).toEqual({ invalid: 'action.tool must be a non-empty string' })
    expect(parseAction('{"tool": "a", "args": [1]}')).toEqual({ invalid: 'action.args must be a JSON object' })
  })
})

describe('workspaceTools', () => {
  it('confines paths, denies secrets, and treats a leading slash as the workspace root', async () => {
    const root = await workspace()
    const tools = workspaceTools(root)
    const run = (name: string, args: Record<string, unknown>): Promise<string> => tools[name]!.run(args, signal())
    expect(await run('list_dir', {})).toBe('lib/\nsrc/\n.env.example')
    expect(await run('list_dir', { path: '/src' })).toContain('a.ts')
    await expect(run('read_file', { path: '../x' })).rejects.toThrow('outside')
    await expect(run('read_file', { path: '.env' })).rejects.toThrow('denied')
    await expect(run('read_file', { path: 'src/missing.ts' })).rejects.toThrow('does not exist')
    await expect(run('read_file', { path: 'src' })).rejects.toThrow('directory')
    await expect(run('read_file', {})).rejects.toThrow('path is required')
    expect(await run('read_file', { path: '.env.example' })).toContain('API_URL')
  })

  it('reads line ranges, clamps bad ranges, and skips binary files', async () => {
    const tools = workspaceTools(await workspace())
    const read = (args: Record<string, unknown>): Promise<string> => tools.read_file!.run(args, signal())
    expect(await read({ path: 'src/a.ts', startLine: 2, endLine: 2 })).toMatch(/^2: const key/)
    expect(await read({ path: 'src/a.ts', startLine: 99, endLine: -5 })).toContain('lines 2-2 of 2')
    expect(await read({ path: 'src/a.ts', startLine: 'x' })).toContain('1: export const answer')
    expect(await read({ path: 'src/bin.dat' })).toContain('binary file')
  })

  it('greps text files only, skips build output, and survives invalid regexes', async () => {
    const tools = workspaceTools(await workspace())
    const grep = (args: Record<string, unknown>): Promise<string> => tools.grep!.run(args, signal())
    const hits = await grep({ pattern: 'answer' })
    expect(hits).toContain('src/a.ts:1')
    expect(hits).toContain('src/b.test.ts:1')
    expect(hits).not.toContain('lib/a.js')
    expect(hits).not.toContain('bin.dat')
    expect(await grep({ pattern: 'answer', include: '*.test.ts' })).not.toContain('src/a.ts')
    expect(await grep({ pattern: 'answer', path: 'src/a.ts' })).toContain('src/a.ts:1')
    expect(await grep({ pattern: '(' })).toContain('invalid regex')
    expect(await grep({ pattern: 'zzz-nothing' })).toBe('(no matches)')
    await expect(grep({})).rejects.toThrow('pattern is required')
  })

  it('finds files by glob', async () => {
    const tools = workspaceTools(await workspace())
    expect(await tools.find_files!.run({ pattern: '*.test.ts' }, signal())).toBe('src/b.test.ts')
    expect(await tools.find_files!.run({ pattern: 'src/**/*.ts' }, signal())).toBe('src/a.ts\nsrc/b.test.ts')
    expect(await tools.find_files!.run({ pattern: '*.none' }, signal())).toBe('(no files matched)')
  })

  it('refuses symlinks that point outside the workspace', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'web-agent-out-'))
    await writeFile(join(outside, 'private.txt'), 'nope\n')
    try {
      await symlink(outside, join(root, 'escape'), 'junction')
    } catch (unsupported: unknown) {
      // Symlink creation needs privileges on some systems; nothing to test then.
      void unsupported
      return
    }
    await expect(workspaceTools(root).read_file!.run({ path: 'escape/private.txt' }, signal())).rejects.toThrow('outside')
  })
})

describe('redact', () => {
  it('redacts common secret patterns and assignments', () => {
    expect(redact('ghp_abcdefghijklmnopqrstu1234')).toBe('[REDACTED]')
    expect(redact('AKIAABCDEFGHIJKLMNOP')).toBe('[REDACTED]')
    expect(redact('password = "hunter2hunter2"')).toBe('password = "[REDACTED]"')
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe('[REDACTED]')
    expect(redact('plain text')).toBe('plain text')
  })
})

describe('runAgent', () => {
  it('runs tools, redacts observations, recovers from format errors, and returns the final answer', async () => {
    const root = await workspace()
    const web = script([
      'bad format',
      '<action>{"tool":"read_file","args":{"path":"src/a.ts"}}</action>',
      '<action>{"tool":"nope"}</action>',
      '<final>answer is 42</final>',
    ])
    const result = await runAgent(web.ask, workspaceTools(root), 'find answer', config, signal())
    expect(result).toMatchObject({ status: 'completed', answer: 'answer is 42', conversations: 1 })
    expect(result.steps.map(step => step.tool)).toEqual(['read_file', 'nope'])
    expect(web.sent[0]!.conversation).toBe('new')
    expect(web.sent[1]!.message).toContain('Format error')
    expect(web.sent[2]!.message).toContain('[REDACTED]')
    expect(web.sent[2]!.message).not.toContain('sk-abc')
    expect(web.sent[3]!.message).toContain('unknown tool')
  })

  it('stops at the budget, skips extra batched actions, and asks for a final answer', async () => {
    const root = await workspace()
    const web = script([
      '<action>{"tool":"list_dir"}</action><action>{"tool":"find_files","args":{"pattern":"*.ts"}}</action>',
      '<action>{"tool":"grep","args":{"pattern":"a"}}</action><action>{"tool":"list_dir","args":{"path":"src"}}</action>',
      '<final>partial</final>',
    ])
    const result = await runAgent(web.ask, workspaceTools(root), 't', config, signal())
    expect(result).toMatchObject({ status: 'step-limit', answer: 'partial' })
    expect(result.steps).toHaveLength(3)
    expect(web.sent.at(-1)!.message).toContain('1 action(s) skipped')
    expect(web.sent.at(-1)!.message).toContain('budget is exhausted')
  })

  it('does not re-run identical calls', async () => {
    const root = await workspace()
    const web = script(['<action>{"tool":"list_dir"}</action>', '<action>{"tool":"list_dir"}</action>', '<final>ok</final>'])
    const result = await runAgent(web.ask, workspaceTools(root), 't', config, signal())
    expect(result.steps[1]!.observation).toContain('identical call')
  })

  it('returns the raw reply when the web AI never follows the protocol', async () => {
    const web = script(['plain answer one', 'plain answer two'])
    const result = await runAgent(web.ask, {}, 't', config, signal())
    expect(result).toMatchObject({ status: 'format-error', answer: 'plain answer two' })
  })

  it('fails with a report instead of throwing when replies stay empty', async () => {
    const web = script(['', '', ''])
    const result = await runAgent(web.ask, {}, 't', config, signal())
    expect(result.status).toBe('failed')
  })

  it('retries a failed page in a fresh conversation, then reports failure without throwing', async () => {
    const root = await workspace()
    const timeout = Object.assign(new Error('TIMEOUT: slow'), { code: 'TIMEOUT' })
    const recovered = script(['<action>{"tool":"list_dir"}</action>', timeout, '<final>recovered</final>'])
    const ok = await runAgent(recovered.ask, workspaceTools(root), 't', config, signal())
    expect(ok).toMatchObject({ status: 'completed', answer: 'recovered', conversations: 2 })
    expect(recovered.sent[2]!.conversation).toBe('new')
    expect(recovered.sent[2]!.message).toContain('What was already done')

    const failing = script([timeout, timeout, timeout])
    const failed = await runAgent(failing.ask, {}, 't', config, signal())
    expect(failed.status).toBe('failed')
    expect(failed.answer).toContain('TIMEOUT')
  })

  it('stops at once when the web AI is signed out', async () => {
    const web = script([Object.assign(new Error('NOT_LOGGED_IN: sign in'), { code: 'NOT_LOGGED_IN' })])
    const result = await runAgent(web.ask, {}, 't', config, signal())
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.answer).toContain('not signed in')
    expect(web.sent).toHaveLength(1)
  })

  it('resets the conversation with a compact history when the context grows too large', async () => {
    const root = await workspace()
    const web = script(['<action>{"tool":"read_file","args":{"path":"src/a.ts"}}</action>', '<final>done</final>'])
    const result = await runAgent(web.ask, workspaceTools(root), 't', { ...config, contextResetChars: 500 }, signal())
    expect(result).toMatchObject({ status: 'completed', conversations: 2 })
    expect(web.sent[1]!.conversation).toBe('new')
    expect(web.sent[1]!.message).toContain('What was already done')
  })

  it('throws only AgentAbortError on cancellation, and ignores failing progress sinks', async () => {
    const controller = new AbortController()
    const web = script(['<action>{"tool":"list_dir"}</action>'])
    const tools = { list_dir: { description: '', run: async () => { controller.abort(); return 'x' } } }
    await expect(runAgent(web.ask, tools, 't', config, controller.signal, { progress: () => { throw new Error('sink') } }))
      .rejects.toBeInstanceOf(AgentAbortError)
    const aborted = new AbortController()
    aborted.abort()
    await expect(runAgent(web.ask, {}, 't', config, aborted.signal)).rejects.toBeInstanceOf(AgentAbortError)
  })

  it('turns tool exceptions into observations', async () => {
    const web = script(['<action>{"tool":"boom"}</action>', '<final>ok</final>'])
    const tools = { boom: { description: '', run: async () => { throw new Error('kaput') } } }
    const result = await runAgent(web.ask, tools, 't', config, signal())
    expect(result.steps[0]!.observation).toBe('ERROR: kaput')
    expect(result.status).toBe('completed')
  })

  it('never resolves prototype keys as tools', async () => {
    const web = script(['<action>{"tool":"constructor"}</action>', '<final>ok</final>'])
    const result = await runAgent(web.ask, {}, 't', config, signal())
    expect(result.steps[0]!.observation).toContain('unknown tool')
  })
})
