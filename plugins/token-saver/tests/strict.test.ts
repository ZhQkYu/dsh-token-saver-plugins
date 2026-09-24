import { describe, expect, it } from 'vitest'
import type { CanvasEdge, CanvasGraph, CanvasNode } from '../src/protocol.ts'
import { CanvasError, compileGraph } from '../src/workflow-canvas/compile.ts'
import { interpretPlan, interpreterScript, type InterpreterHooks, type ProgressEvent, type StrictPlan } from '../src/workflow-canvas/interpreter.ts'
import { buildStrictPlan, PROGRESS_TAG, type PlanLimits } from '../src/workflow-canvas/plan.ts'

const LIMITS: PlanLimits = { maxDepth: 4, maxLoopIterations: 10, maxOutputChars: 2000 }

function node(id: string, kind: CanvasNode['kind'], config: CanvasNode['config'] = {}, instruction = `do ${id}`): CanvasNode {
  return { id, kind, title: id, instruction, config, position: { x: 0, y: 0 } }
}

function edge(source: string, target: string, sourceHandle?: string): CanvasEdge {
  return { id: `${source}-${target}`, source, target, ...(sourceHandle === undefined ? {} : { sourceHandle }) }
}

function graph(id: string, nodes: CanvasNode[], edges: CanvasEdge[], mode: CanvasGraph['mode'] = 'strict'): CanvasGraph {
  return { version: 1, id, name: id, description: '', mode, nodes, edges, updatedAt: 0 }
}

function planFor(root: CanvasGraph, others: CanvasGraph[] = [], input = ''): StrictPlan {
  const all = new Map([root, ...others].map(item => [item.id, item]))
  return buildStrictPlan(root, id => all.get(id), LIMITS, input)
}

/** A fake engine: `respond` answers each agent call; progress lines are collected. */
function fakeHooks(respond: (prompt: string, options: { label: string; schema?: object }) => unknown | Promise<unknown>) {
  const events: ProgressEvent[] = []
  const calls: string[] = []
  let active = 0
  let peak = 0
  const hooks: InterpreterHooks = {
    agent: async (prompt, options) => {
      calls.push(options.label)
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      try {
        return await respond(prompt, options)
      } finally {
        active--
      }
    },
    log: (message) => { events.push(JSON.parse(message) as ProgressEvent) },
  }
  return { hooks, events, calls, peak: () => peak }
}

const statusOf = (events: ProgressEvent[], id: string, path: string[] = []): string | undefined =>
  events.filter(event => event.node === id && event.path.join('/') === path.join('/')).at(-1)?.status

describe('strict interpreter', () => {
  it('runs independent branches in parallel and joins their outputs', async () => {
    const root = graph('g', [node('a', 'task'), node('b', 'task'), node('c', 'task'), node('d', 'output')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')])
    const fake = fakeHooks((_prompt, { label }) => `result of ${label}`)
    const result = await interpretPlan(planFor(root), fake.hooks)
    expect(fake.peak()).toBe(2)
    expect(fake.calls.indexOf('d')).toBe(3)
    expect(result).toEqual({ output: 'result of d', failed: false })
    expect(fake.events.every(event => event.tag === PROGRESS_TAG)).toBe(true)
  })

  it('passes upstream outputs into the downstream prompt', async () => {
    const root = graph('g', [node('a', 'task'), node('b', 'task')], [edge('a', 'b')])
    const prompts: string[] = []
    const fake = fakeHooks((prompt, { label }) => {
      prompts.push(prompt)
      return label === 'a' ? 'ALPHA-OUTPUT' : 'done'
    })
    await interpretPlan(planFor(root), fake.hooks)
    expect(prompts[1]).toContain('ALPHA-OUTPUT')
    expect(prompts[1]).toContain('Instruction: do b')
  })

  it('routes a model-decided condition and skips the branch not taken', async () => {
    const root = graph('g', [
      node('review', 'task'),
      node('gate', 'condition', { decide: 'model', branches: [{ id: 'pass', label: 'approved' }, { id: 'fail', label: 'rejected' }] }, 'Is the draft approved?'),
      node('publish', 'task'),
      node('fix', 'task'),
      node('report', 'output'),
    ], [edge('review', 'gate'), edge('gate', 'publish', 'pass'), edge('gate', 'fix', 'fail'), edge('publish', 'report'), edge('fix', 'report')])
    const fake = fakeHooks((_prompt, { label, schema }) => schema === undefined ? `out ${label}` : { choice: 'approved', reason: 'fine' })
    const result = await interpretPlan(planFor(root), fake.hooks)
    expect(statusOf(fake.events, 'publish')).toBe('done')
    expect(statusOf(fake.events, 'fix')).toBe('skipped')
    expect(fake.events.find(event => event.node === 'gate' && event.status === 'done')?.branch).toBe('pass')
    expect(statusOf(fake.events, 'report')).toBe('done')
    expect(result.failed).toBe(false)
  })

  it('routes a rule-decided condition without a model call, falling back to else', async () => {
    const branches = [{ id: 'yes', label: 'urgent', rule: { op: 'regex' as const, value: '\\burgent\\b' } }]
    const root = graph('g', [
      node('in', 'input', {}, ''),
      node('gate', 'condition', { decide: 'rule', branches }),
      node('fast', 'task'),
      node('slow', 'task'),
    ], [edge('in', 'gate'), edge('gate', 'fast', 'yes'), edge('gate', 'slow', 'else')])
    const fake = fakeHooks((_prompt, { label }) => `out ${label}`)
    await interpretPlan(planFor(root, [], 'nothing special here'), fake.hooks)
    expect(fake.calls).toEqual(['slow'])
    expect(statusOf(fake.events, 'fast')).toBe('skipped')
  })

  it('marks a failed step and skips everything downstream of it', async () => {
    const root = graph('g', [node('a', 'task'), node('b', 'task'), node('c', 'task')], [edge('a', 'b'), edge('b', 'c')])
    const fake = fakeHooks((_prompt, { label }) => label === 'b' ? null : `out ${label}`)
    const result = await interpretPlan(planFor(root), fake.hooks)
    expect(statusOf(fake.events, 'b')).toBe('failed')
    expect(statusOf(fake.events, 'c')).toBe('skipped')
    expect(result.failed).toBe(true)
  })

  it('repeats a loop body, carrying each round into the next, until the exit check stops it', async () => {
    const body = graph('body', [node('draft', 'task')], [])
    const root = graph('g', [node('loop', 'loop', { graphId: 'body', maxIterations: 5, decide: 'model' }, 'The draft has no typos')], [])
    let round = 0
    const prompts: string[] = []
    const fake = fakeHooks((prompt, { schema }) => {
      if (schema !== undefined) return { stop: round >= 2, reason: 'checked' }
      prompts.push(prompt)
      round++
      return `draft v${round}`
    })
    const result = await interpretPlan(planFor(root, [body], 'topic'), fake.hooks)
    expect(round).toBe(2)
    expect(prompts[1]).toContain('draft v1')
    expect(result.output).toBe('draft v2')
    expect(fake.events.find(event => event.node === 'loop' && event.status === 'done')?.iteration).toBe(2)
    expect(fake.events.some(event => event.path.join('/') === 'loop' && event.node === 'draft')).toBe(true)
  })

  it('runs a guided sub-workflow as one model step with its step list', async () => {
    const guided = graph('guided', [node('x', 'task'), node('y', 'task')], [edge('x', 'y')], 'guided')
    const root = graph('g', [node('sub', 'subflow', { graphId: 'guided' })], [])
    const prompts: string[] = []
    const fake = fakeHooks((prompt) => {
      prompts.push(prompt)
      return 'guided result'
    })
    const result = await interpretPlan(planFor(root, [guided]), fake.hooks)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('[x] task: x')
    expect(prompts[0]).toContain('[y] task: y (after x)')
    expect(result.output).toBe('guided result')
  })

  it('lets engine errors end the run instead of failing one step', async () => {
    const root = graph('g', [node('a', 'task')], [])
    const fake = fakeHooks(() => { throw new Error('cancelled') })
    await expect(interpretPlan(planFor(root), fake.hooks)).rejects.toThrow('cancelled')
  })

  it('ships as a self-contained script body', async () => {
    const root = graph('g', [node('a', 'task'), node('b', 'task')], [edge('a', 'b')])
    const fake = fakeHooks((_prompt, { label }) => `out ${label}`)
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...params: string[]) => (...args: unknown[]) => Promise<unknown>
    const script = new AsyncFunction('args', 'agent', 'log', interpreterScript())
    await expect(script(planFor(root), fake.hooks.agent, fake.hooks.log)).resolves.toEqual({ output: 'out b', failed: false })
  })
})

describe('strict plan', () => {
  it('rejects workflows that reference each other', () => {
    const a = graph('a', [node('s', 'subflow', { graphId: 'b' })], [])
    const b = graph('b', [node('s', 'subflow', { graphId: 'a' })], [])
    expect(() => planFor(a, [b])).toThrow(/references itself/)
  })

  it('rejects missing references and nesting beyond the limit', () => {
    expect(() => planFor(graph('a', [node('s', 'subflow', { graphId: 'gone' })], []))).toThrow(/no longer exists/)
    const chain = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'].map((id, index, ids) =>
      graph(id, index === ids.length - 1 ? [node('t', 'task')] : [node('s', 'subflow', { graphId: ids[index + 1]! })], []))
    expect(() => planFor(chain[0]!, chain.slice(1))).toThrow(/deeper than 4/)
  })

  it('rejects a loop round limit above the configured ceiling', () => {
    const body = graph('body', [node('t', 'task')], [])
    expect(() => planFor(graph('g', [node('l', 'loop', { graphId: 'body', maxIterations: 50 })], []), [body])).toThrow(/limit is 10/)
  })

  it('passes an empty input node through without a prompt', () => {
    const plan = planFor(graph('g', [node('in', 'input', {}, '')], []), [], 'start text')
    expect(plan.graphs.g?.nodes[0]?.prompt).toBe('')
    expect(plan.input).toBe('start text')
  })
})

describe('control-flow validation', () => {
  it('requires branches, branch handles, and loop fields', () => {
    expect(() => compileGraph(graph('g', [node('c', 'condition', { branches: [] })], []))).toThrow(/at least one branch/)
    const gate = node('c', 'condition', { branches: [{ id: 'y', label: 'yes' }] })
    expect(() => compileGraph(graph('g', [gate, node('t', 'task')], [edge('c', 't')]))).toThrow(/without a valid branch/)
    expect(() => compileGraph(graph('g', [node('a', 'task'), node('t', 'task')], [edge('a', 't', 'y')]))).toThrow(/not a condition node/)
    expect(() => compileGraph(graph('g', [node('l', 'loop', { graphId: 'x' })], []))).toThrow(CanvasError)
    expect(() => compileGraph(graph('g', [node('s', 'subflow', { graphId: 'g' })], []))).toThrow(/its own workflow/)
  })

  it('tells a guided model which branch gates a step', () => {
    const gate = node('c', 'condition', { branches: [{ id: 'y', label: 'yes' }] })
    const { steps } = compileGraph(graph('g', [gate, node('t', 'task')], [edge('c', 't', 'y')], 'guided'))
    expect(steps.find(step => step.nodeId === 't')?.hint).toContain('Only if [c] chose "yes"')
    expect(steps.find(step => step.nodeId === 'c')?.hint).toContain('"yes"')
  })
})
