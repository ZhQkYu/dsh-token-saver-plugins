/**
 * The workflow canvas main panel: a graph list, an @xyflow/react canvas with a
 * node palette, a node inspector, and save/run controls with live run status.
 * `graph` owns the saved content; the React Flow node state owns positions and
 * measurements, which are merged back into the graph on save.
 *
 * @module @dsh-plugins/token-saver-ui/client/canvas-page
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useEdgesState, useNodesState,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange,
} from '@xyflow/react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { NODE_KINDS, type CanvasEdge, type CanvasGraph, type CanvasNode, type CanvasRun, type NodeKind, type NodeStatus } from '@dsh-plugins/token-saver/protocol'
import { api, errorText, type GraphSummary, type WorkspaceSummary } from './api.ts'
import type { LocaleKey } from './locales.ts'

/** Props the `main` slot passes to the page. */
export interface CanvasPageProps {
  t: (key: string) => string
}

type FlowData = { kind: NodeKind; title: string; label?: ReactNode }
type FlowNode = Node<FlowData>
type Notice = { kind: 'info' | 'error'; text: string }

/** Kind accent colors; artwork, so they stay fixed across themes. */
const KIND_COLOR: Record<NodeKind, string> = {
  input: '#7c5cff',
  task: '#4c8bf5',
  'web-ai': '#2f9e6e',
  subagent: '#c47c1f',
  tool: '#b0475e',
  review: '#8a6d3b',
  output: '#6b7280',
}

const TERMINAL: ReadonlySet<NodeStatus> = new Set(['done', 'failed', 'skipped'])
const POLL_MS = 2000
/** How long to keep polling after "Run" before the new session has created its run. */
const RUN_START_GRACE_MS = 90_000
/** A run untouched this long counts as abandoned and stops the polling. */
const RUN_STALE_MS = 10 * 60_000

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

function toFlowNode(node: CanvasNode): FlowNode {
  return { id: node.id, position: node.position, data: { kind: node.kind, title: node.title } }
}

function toFlowEdge(edge: CanvasEdge): Edge {
  return { id: edge.id, source: edge.source, target: edge.target, label: edge.label }
}

function hasCycle(graph: CanvasGraph): boolean {
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]))
  for (const edge of graph.edges) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id)
  let visited = 0
  while (ready.length > 0) {
    const id = ready.pop()!
    visited++
    for (const edge of graph.edges) {
      if (edge.source !== id) continue
      const degree = (indegree.get(edge.target) ?? 0) - 1
      indegree.set(edge.target, degree)
      if (degree === 0) ready.push(edge.target)
    }
  }
  return visited !== graph.nodes.length
}

function isActive(run: CanvasRun): boolean {
  return Date.now() - run.updatedAt < RUN_STALE_MS && Object.values(run.nodes).some(node => !TERMINAL.has(node.status))
}

/**
 * Render the canvas page.
 * @param props - the slot's bound translator.
 * @returns the page element.
 */
export function CanvasPage(props: CanvasPageProps): ReactNode {
  const t = props.t as (key: LocaleKey) => string
  const [graphs, setGraphs] = useState<GraphSummary[]>([])
  const [graph, setGraph] = useState<CanvasGraph | null>(null)
  const [dirty, setDirty] = useState(false)
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newKind, setNewKind] = useState<NodeKind>('task')
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [run, setRun] = useState<CanvasRun | null>(null)
  const [pollUntil, setPollUntil] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const fail = (prefix: LocaleKey) => (error: unknown): void => {
    setNotice({ kind: 'error', text: `${t(prefix)}${errorText(error)}` })
  }

  const refreshGraphs = (): Promise<void> => api.graphs().then(setGraphs, fail('loadFailed'))

  useEffect(() => {
    void refreshGraphs()
    api.workspaces().then((list) => {
      setWorkspaces(list)
      setWorkspaceId(current => current !== '' ? current : list[0]?.id ?? '')
    }, fail('loadFailed'))
    // Load once per page mount; later refreshes are explicit.
  }, [])

  const graphId = graph?.id
  useEffect(() => {
    if (graphId === undefined) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      let latest: CanvasRun | undefined
      try {
        latest = (await api.runs(graphId))[0]
      } catch (transient: unknown) {
        // A failed poll keeps the last status; the next tick retries.
      }
      if (cancelled) return
      if (latest !== undefined) setRun(latest)
      if ((latest !== undefined && isActive(latest)) || Date.now() < pollUntil) {
        timer = setTimeout(() => { void tick() }, POLL_MS)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [graphId, pollUntil])

  const edit = (change: (current: CanvasGraph) => CanvasGraph): void => {
    setGraph(current => current === null ? current : change(current))
    setDirty(true)
  }

  const load = (next: CanvasGraph, unsaved: boolean): void => {
    setGraph(next)
    setDirty(unsaved)
    setSelectedId(null)
    setPendingDelete(null)
    setRun(null)
    setNodes(next.nodes.map(toFlowNode))
    setEdges(next.edges.map(toFlowEdge))
  }

  const openGraph = (id: string): void => {
    api.graph(id).then(next => { load(next, false) }, fail('loadFailed'))
  }

  const newGraph = (): void => {
    load({ version: 1, id: newId('g'), name: t('newGraphName'), description: '', nodes: [], edges: [], updatedAt: 0 }, true)
  }

  const removeNodes = (removed: ReadonlySet<string>): void => {
    edit(current => ({
      ...current,
      nodes: current.nodes.filter(node => !removed.has(node.id)),
      edges: current.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)),
    }))
    setEdges(current => current.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)))
    if (selectedId !== null && removed.has(selectedId)) setSelectedId(null)
  }

  const onNodesChange = (changes: NodeChange<FlowNode>[]): void => {
    onNodesChangeBase(changes)
    const removed = new Set(changes.flatMap(change => change.type === 'remove' ? [change.id] : []))
    if (removed.size > 0) removeNodes(removed)
    if (changes.some(change => change.type === 'position' && change.dragging === false)) setDirty(true)
  }

  const onEdgesChange = (changes: EdgeChange<Edge>[]): void => {
    onEdgesChangeBase(changes)
    const removed = new Set(changes.flatMap(change => change.type === 'remove' ? [change.id] : []))
    if (removed.size > 0) edit(current => ({ ...current, edges: current.edges.filter(edge => !removed.has(edge.id)) }))
  }

  const onConnect = (connection: Connection): void => {
    if (graph === null || connection.source === connection.target) return
    if (graph.edges.some(edge => edge.source === connection.source && edge.target === connection.target)) return
    const edge: CanvasEdge = { id: newId('e'), source: connection.source, target: connection.target }
    edit(current => ({ ...current, edges: [...current.edges, edge] }))
    setEdges(current => addEdge(toFlowEdge(edge), current))
  }

  const addNode = (): void => {
    if (graph === null) return
    const index = graph.nodes.length
    const node: CanvasNode = {
      id: newId('n'),
      kind: newKind,
      title: t(`kind.${newKind}`),
      instruction: '',
      config: {},
      position: { x: 80 + (index % 4) * 220, y: 80 + Math.floor(index / 4) * 140 },
    }
    edit(current => ({ ...current, nodes: [...current.nodes, node] }))
    setNodes(current => [...current, toFlowNode(node)])
    setSelectedId(node.id)
  }

  const updateNode = (id: string, patch: Partial<Pick<CanvasNode, 'kind' | 'title' | 'instruction' | 'config'>>): void => {
    edit(current => ({ ...current, nodes: current.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }))
    const { kind, title } = patch
    if (kind === undefined && title === undefined) return
    setNodes(current => current.map(node => node.id !== id ? node : {
      ...node,
      data: { ...node.data, ...(kind === undefined ? {} : { kind }), ...(title === undefined ? {} : { title }) },
    }))
  }

  const save = async (): Promise<boolean> => {
    if (graph === null) return false
    if (graph.name.trim() === '') {
      setNotice({ kind: 'error', text: t('nameRequired') })
      return false
    }
    const positions = new Map(nodes.map(node => [node.id, node.position]))
    const payload: CanvasGraph = {
      ...graph,
      nodes: graph.nodes.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })),
    }
    if (hasCycle(payload)) {
      setNotice({ kind: 'error', text: t('cycle') })
      return false
    }
    try {
      setGraph(await api.save(payload))
      setDirty(false)
      setNotice({ kind: 'info', text: t('saved') })
      await refreshGraphs()
      return true
    } catch (error: unknown) {
      fail('saveFailed')(error)
      return false
    }
  }

  const runGraph = async (): Promise<void> => {
    if (graph === null || workspaceId === '') return
    if (dirty && !await save()) return
    try {
      const sessionId = await api.run(graph.id, workspaceId)
      setNotice({ kind: 'info', text: `${t('runStarted')}${sessionId}` })
      setPollUntil(Date.now() + RUN_START_GRACE_MS)
    } catch (error: unknown) {
      fail('runFailed')(error)
    }
  }

  const deleteGraph = (id: string): void => {
    if (pendingDelete !== id) {
      setPendingDelete(id)
      return
    }
    setPendingDelete(null)
    api.remove(id).then(() => {
      if (graph?.id === id) {
        setGraph(null)
        setNodes([])
        setEdges([])
      }
      return refreshGraphs()
    }, fail('loadFailed'))
  }

  const statusOf = (id: string): NodeStatus | undefined =>
    run !== null && graph !== null && run.graphId === graph.id ? run.nodes[id]?.status : undefined

  const displayNodes = useMemo(() => nodes.map((node): FlowNode => {
    const status = statusOf(node.id)
    return {
      ...node,
      selected: node.id === selectedId,
      className: status === undefined ? '' : `ts-status-${status}`,
      style: { borderColor: KIND_COLOR[node.data.kind], borderWidth: 2 },
      data: {
        ...node.data,
        label: (
          <div className="ts-node">
            <span className="ts-node-kind">{t(`kind.${node.data.kind}`)}</span>
            <span className="ts-node-title">{node.data.title === '' ? '—' : node.data.title}</span>
            {status !== undefined && <span className="ts-node-status">{t(`status.${status}`)}</span>}
          </div>
        ),
      },
    }
  }), [nodes, run, selectedId, graph, t])

  const selected = graph?.nodes.find(node => node.id === selectedId)
  const runNodes = run !== null && graph !== null && run.graphId === graph.id ? Object.values(run.nodes) : []
  const finished = runNodes.filter(node => TERMINAL.has(node.status)).length

  return (
    <div className="ts-canvas">
      <div className="ts-canvas-bar">
        <Button variant="outline" onClick={newGraph}>{t('newGraph')}</Button>
        <Button variant="primary" disabled={graph === null} onClick={() => { void save() }}>{t('save')}</Button>
        {dirty && <span className="ts-canvas-notice">{t('unsaved')}</span>}
        <select value={newKind} aria-label={t('newNodeKind')} onChange={event => { setNewKind(event.target.value as NodeKind) }}>
          {NODE_KINDS.map(kind => <option key={kind} value={kind}>{t(`kind.${kind}`)}</option>)}
        </select>
        <Button variant="outline" disabled={graph === null} onClick={addNode}>{t('addNode')}</Button>
        <span className="ts-spacer" />
        {workspaces.length === 0
          ? <span className="ts-canvas-notice">{t('noWorkspace')}</span>
          : (
            <select value={workspaceId} aria-label={t('selectWorkspace')} onChange={event => { setWorkspaceId(event.target.value) }}>
              {workspaces.map(workspace => <option key={workspace.id} value={workspace.id} title={workspace.path}>{workspace.title}</option>)}
            </select>
          )}
        <Button variant="primary" disabled={graph === null || workspaceId === '' || graph.nodes.length === 0} onClick={() => { void runGraph() }}>{t('run')}</Button>
        {notice !== null && <span className="ts-canvas-notice" data-kind={notice.kind}>{notice.text}</span>}
      </div>
      <div className="ts-canvas-body">
        <aside className="ts-canvas-list">
          <h3>{t('graphs')}</h3>
          {graphs.length === 0 && <div className="ts-canvas-notice">{t('emptyGraphs')}</div>}
          {graphs.map(item => (
            <div key={item.id} className="ts-canvas-list-item" data-active={item.id === graph?.id}>
              <Button className="ts-graph" title={item.description} onClick={() => { openGraph(item.id) }}>{item.name}</Button>
              <Button onClick={() => { deleteGraph(item.id) }}>{pendingDelete === item.id ? t('confirmDelete') : t('delete')}</Button>
            </div>
          ))}
        </aside>
        <div className="ts-canvas-flow">
          {graph === null
            ? <div className="ts-canvas-empty">{t('noGraph')}</div>
            : (
              <ReactFlow
                nodes={displayNodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_event, node) => { setSelectedId(node.id) }}
                onPaneClick={() => { setSelectedId(null) }}
                deleteKeyCode={['Backspace', 'Delete']}
                fitView
              >
                <Background />
                <Controls />
                <MiniMap pannable zoomable />
              </ReactFlow>
            )}
        </div>
        {graph !== null && (
          <aside className="ts-canvas-inspector">
            {selected === undefined
              ? (
                <>
                  <label htmlFor="ts-graph-name">{t('graphName')}</label>
                  <input id="ts-graph-name" value={graph.name} onChange={event => { const value = event.target.value; edit(current => ({ ...current, name: value })) }} />
                  <label htmlFor="ts-graph-description">{t('graphDescription')}</label>
                  <textarea id="ts-graph-description" value={graph.description} onChange={event => { const value = event.target.value; edit(current => ({ ...current, description: value })) }} />
                </>
              )
              : (
                <>
                  <label htmlFor="ts-node-kind">{t('nodeKind')}</label>
                  <select id="ts-node-kind" value={selected.kind} onChange={event => { updateNode(selected.id, { kind: event.target.value as NodeKind }) }}>
                    {NODE_KINDS.map(kind => <option key={kind} value={kind}>{t(`kind.${kind}`)}</option>)}
                  </select>
                  <label htmlFor="ts-node-title">{t('nodeTitle')}</label>
                  <input id="ts-node-title" value={selected.title} onChange={event => { updateNode(selected.id, { title: event.target.value }) }} />
                  <label htmlFor="ts-node-instruction">{t('instruction')}</label>
                  <textarea id="ts-node-instruction" value={selected.instruction} onChange={event => { updateNode(selected.id, { instruction: event.target.value }) }} />
                  {selected.kind === 'web-ai' && (
                    <>
                      <label htmlFor="ts-node-provider">{t('provider')}</label>
                      <input id="ts-node-provider" value={selected.config.provider ?? ''} onChange={event => { updateNode(selected.id, { config: { ...selected.config, provider: event.target.value } }) }} />
                    </>
                  )}
                  {selected.kind === 'tool' && (
                    <>
                      <label htmlFor="ts-node-tool">{t('tool')}</label>
                      <input id="ts-node-tool" value={selected.config.tool ?? ''} onChange={event => { updateNode(selected.id, { config: { ...selected.config, tool: event.target.value } }) }} />
                    </>
                  )}
                  {run?.nodes[selected.id]?.summary !== undefined && (
                    <>
                      <label>{t('result')}</label>
                      <div className="ts-canvas-summary">{run.nodes[selected.id]?.summary}</div>
                    </>
                  )}
                  <Button variant="outline" onClick={() => { onNodesChange([{ type: 'remove', id: selected.id }]) }}>{t('deleteNode')}</Button>
                </>
              )}
          </aside>
        )}
      </div>
      {runNodes.length > 0 && (
        <div className="ts-canvas-progress">{t('progress')}: {finished}/{runNodes.length}</div>
      )}
    </div>
  )
}
