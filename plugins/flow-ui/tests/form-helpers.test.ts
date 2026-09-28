import { describe, expect, it } from 'vitest'
import type { FlowDocument, FlowNode, Issue } from '@dsh-plugins/flow/spec'
import { addNodeAfter, addNodeInside, autoLayout, createNode, removeNodeAndReconnect, seedNode } from '../src/client/editor/convert.ts'
import { issueField, issueText } from '../src/client/editor/issues.ts'
import { nodeSummary } from '../src/client/editor/summary.ts'
import { bindingForOption, bodyOutputOptions, insertText, syncSubflowInputs, syncToolArgs, toolParams, variableOptions } from '../src/client/editor/variables.ts'

const t = (key: string): string => key
const lookup = (): undefined => undefined
const node = (value: Record<string, unknown>): FlowNode => ({ position: { x: 0, y: 0 }, title: String(value['id']), ...value }) as never

function flow(): FlowDocument {
  return {
    schemaVersion: 1, id: 'f', name: 'f', description: '', revision: 1, updatedAt: 0,
    nodes: [
      node({ id: 'start', type: 'start', data: { fields: [{ name: 'topic', schema: { type: 'string' }, required: true }] } }),
      node({ id: 'llm', type: 'llm', position: { x: 300, y: 0 }, data: { inputs: [], system: '', prompt: 'p', output: { format: 'json', fields: [{ name: 'user', schema: { type: 'object', properties: [{ name: 'name', schema: { type: 'string' } }] } }] } } }),
      node({ id: 'loop', type: 'loop', position: { x: 600, y: 0 }, size: { width: 420, height: 280 }, data: { mode: 'array', maxIterations: 3, variables: [], outputs: [] } }),
      node({ id: 'inner', type: 'message', parentId: 'loop', position: { x: 40, y: 70 }, data: { inputs: [], template: 'x' } }),
      node({ id: 'end', type: 'end', position: { x: 900, y: 0 }, data: { mode: 'variables', inputs: [] } }),
    ],
    edges: [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'llm' },
      { id: 'e2', source: 'llm', sourceHandle: 'next', target: 'loop' },
      { id: 'e3', source: 'loop', sourceHandle: 'body', target: 'inner' },
      { id: 'e4', source: 'loop', sourceHandle: 'next', target: 'end' },
    ],
  }
}

describe('variable options', () => {
  it('lists upstream outputs with nested fields and container inner variables', () => {
    const keys = variableOptions(flow(), 'inner', lookup).map(option => `${option.group}:${option.label}`)
    expect(keys).toEqual(expect.arrayContaining(['start:topic', 'llm:user', 'llm:user.name', 'loop:item', 'loop:index']))
    expect(keys).not.toContain('end:text')
  })

  it('lists body node outputs for container collected outputs', () => {
    expect(bodyOutputOptions(flow(), 'loop', lookup).map(option => option.label)).toEqual(['text'])
  })

  it('reuses a binding for the same variable and names new ones after the field', () => {
    const [topic] = variableOptions(flow(), 'llm', lookup)
    if (topic === undefined) throw new Error('missing option')
    const first = bindingForOption([], topic)
    expect(first).toMatchObject({ added: true, binding: { name: 'topic', value: topic.source } })
    expect(bindingForOption([first.binding], topic).added).toBe(false)
    const clash = bindingForOption([{ name: 'topic', schema: { type: 'string' }, value: { kind: 'literal', value: '' } }], topic)
    expect(clash.binding.name).toBe('topic_2')
  })

  it('inserts at the selection', () => {
    expect(insertText('ab', 1, 1, '{{x}}')).toEqual({ text: 'a{{x}}b', cursor: 6 })
    expect(insertText('abc', 0, 3, 'z')).toEqual({ text: 'z', cursor: 1 })
  })
})

describe('tool and subflow parameters', () => {
  const schema = { type: 'object', properties: { file_path: { type: 'string', description: 'path' }, offset: { type: 'number' } }, required: ['file_path'] }

  it('adds required parameters and keeps chosen optional ones with their values', () => {
    const params = toolParams(schema)
    expect(params.map(param => [param.name, param.required])).toEqual([['file_path', true], ['offset', false]])
    expect(syncToolArgs(params, []).map(arg => arg.name)).toEqual(['file_path'])
    const kept = syncToolArgs(params, [{ name: 'offset', schema: { type: 'number' }, value: { kind: 'literal', value: 5 } }])
    expect(kept.map(arg => [arg.name, arg.value])).toEqual([['file_path', { kind: 'literal', value: '' }], ['offset', { kind: 'literal', value: 5 }]])
  })

  it('follows the subflow start fields', () => {
    const synced = syncSubflowInputs([{ name: 'a', schema: { type: 'integer' }, required: true }], [{ name: 'gone', schema: { type: 'string' }, value: { kind: 'literal', value: 'x' } }])
    expect(synced).toEqual([{ name: 'a', schema: { type: 'integer' }, value: { kind: 'literal', value: null }, required: true }])
  })
})

describe('adding nodes', () => {
  const edgeIds = (): (() => string) => { let n = 0; return () => `n${++n}` }

  it('inserts between a node and its only successor and shifts later nodes right', () => {
    const doc = flow()
    const fresh = createNode('message', 'm', { x: 0, y: 0 }, 'm')
    const start = doc.nodes.find(candidate => candidate.id === 'start') as FlowNode
    const next = addNodeAfter(doc, start, fresh, edgeIds())
    expect(next.edges.filter(edge => edge.source === 'start' || edge.source === 'm').map(edge => `${edge.source}->${edge.target}`)).toEqual(['start->m', 'm->llm'])
    expect(next.nodes.find(candidate => candidate.id === 'llm')?.position.x).toBe(600)
    expect(next.nodes.find(candidate => candidate.id === 'm')?.position).toEqual({ x: 300, y: 0 })
  })

  it('makes room for a container by its width', () => {
    const doc = flow()
    const start = doc.nodes.find(candidate => candidate.id === 'start') as FlowNode
    const next = addNodeAfter(doc, start, createNode('batch', 'b', { x: 0, y: 0 }, 'b'), edgeIds())
    expect(next.nodes.find(candidate => candidate.id === 'llm')?.position.x).toBe(300 + 420 + 80)
  })

  it('connects from a free port and places clear of other nodes', () => {
    const doc = flow()
    const end = doc.nodes.find(candidate => candidate.id === 'end') as FlowNode
    const withoutEdge = { ...doc, edges: doc.edges.filter(edge => edge.id !== 'e2') }
    const llm = withoutEdge.nodes.find(candidate => candidate.id === 'llm') as FlowNode
    const next = addNodeAfter(withoutEdge, llm, createNode('message', 'm', { x: 0, y: 0 }, 'm'), edgeIds())
    expect(next.edges.some(edge => edge.source === 'llm' && edge.target === 'm')).toBe(true)
    expect(next.nodes.find(candidate => candidate.id === 'm')?.position).toEqual({ x: 600, y: 360 })
    expect(addNodeAfter(doc, end, createNode('message', 'z', { x: 0, y: 0 }, 'z'), edgeIds()).edges).toHaveLength(doc.edges.length)
  })

  it('adds inside a container after its last child and grows the container', () => {
    const doc = flow()
    const loop = doc.nodes.find(candidate => candidate.id === 'loop') as FlowNode
    const next = addNodeInside(doc, loop, createNode('message', 'm', { x: 0, y: 0 }, 'm'), edgeIds())
    const added = next.nodes.find(candidate => candidate.id === 'm')
    expect(added?.parentId).toBe('loop')
    expect(next.edges.some(edge => edge.source === 'inner' && edge.target === 'm')).toBe(true)
    expect(next.nodes.find(candidate => candidate.id === 'loop')?.size?.width).toBeGreaterThanOrEqual(340 + 260)
    const empty = { ...doc, nodes: doc.nodes.filter(candidate => candidate.id !== 'inner'), edges: doc.edges.filter(edge => edge.id !== 'e3') }
    const first = addNodeInside(empty, loop, createNode('message', 'm', { x: 0, y: 0 }, 'm'), edgeIds())
    expect(first.edges.some(edge => edge.source === 'loop' && edge.sourceHandle === 'body' && edge.target === 'm')).toBe(true)
  })

  it('tidies scopes into columns by execution order and fits containers to their bodies', () => {
    const doc = flow()
    const messy = { ...doc, nodes: doc.nodes.map(candidate => candidate.id === 'end' ? { ...candidate, position: { x: 5000, y: 900 } } : candidate) }
    const tidy = autoLayout(messy)
    const x = (id: string): number | undefined => tidy.nodes.find(candidate => candidate.id === id)?.position.x
    expect([x('start'), x('llm'), x('loop')]).toEqual([0, 300, 600])
    const loop = tidy.nodes.find(candidate => candidate.id === 'loop')
    expect(x('end')).toBe(600 + (loop?.size?.width ?? 0) + 80)
    expect(tidy.nodes.find(candidate => candidate.id === 'inner')?.position).toEqual({ x: 40, y: 70 })
  })

  it('reconnects the neighbors of a deleted chain node', () => {
    const next = removeNodeAndReconnect(flow(), 'llm', 'heal')
    expect(next.edges.find(edge => edge.id === 'heal')).toEqual({ id: 'heal', source: 'start', sourceHandle: 'next', target: 'loop' })
    const branchy = removeNodeAndReconnect(flow(), 'loop', 'heal')
    expect(branchy.edges.some(edge => edge.id === 'heal' && edge.source === 'llm' && edge.target === 'end')).toBe(true)
  })

  it('seeds nodes whose defaults would be invalid', () => {
    const condition = seedNode(createNode('condition', 'c', { x: 0, y: 0 }, 'c'), t)
    expect(condition.type === 'condition' && condition.data.branches).toHaveLength(1)
    const intent = seedNode(createNode('intent', 'i', { x: 0, y: 0 }, 'i'), t)
    expect(intent.type === 'intent' && intent.data.intents).toHaveLength(1)
  })
})

describe('summaries and issue text', () => {
  it('summarizes nodes on the canvas', () => {
    const doc = flow()
    expect(nodeSummary(doc.nodes[0] as FlowNode, t, () => undefined)).toEqual(['summary.inputs: topic'])
    expect(nodeSummary(doc.nodes[1] as FlowNode, t, () => undefined)).toEqual(['p', 'summary.outputs: user'])
    expect(nodeSummary(node({ id: 's', type: 'subflow', data: { flowId: 'x', version: 'draft', inputs: [] } }), t, id => id === 'x' ? 'Other' : undefined)).toEqual(['Other'])
  })

  it('gives reused issue codes specific text and localizes the field', () => {
    const issue = (code: Issue['code'], field?: string): Issue => ({ severity: 'error', code, message: '', ...(field === undefined ? {} : { field }) })
    expect(issueText(issue('BAD_NAME', 'branches'), t)).toBe('issueHint.needBranch')
    expect(issueText(issue('BAD_NAME', 'branches.0.conditions'), t)).toBe('issueHint.needCondition')
    expect(issueText(issue('BAD_NAME', 'inputs.x'), t)).toBe('issue.BAD_NAME')
    expect(issueField(issue('REQUIRED_INPUT', 'inputs.topic'), t)).toBe('fieldName.inputs topic')
    expect(issueField(issue('REQUIRED_INPUT', 'weird.path'), t)).toBe('weird.path')
  })
})
