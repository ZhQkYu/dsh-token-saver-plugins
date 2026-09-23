/**
 * The workflow canvas main panel: a graph list, an @xyflow/react canvas, a
 * node inspector, and a top bar with save/run controls. All data goes through
 * the Connection fetch routes (document-relative `api/...` paths).
 *
 * @module @dsh-plugins/token-saver-ui/client/canvas-page
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, addEdge, type Node, type Edge } from '@xyflow/react'
import type { CanvasGraph, CanvasNode, CanvasRun } from '@dsh-plugins/token-saver/protocol'

type Translate = (key: string) => string

/** Props the main slot passes to the page. */
export interface CanvasPageProps {
  t: Translate
}

const api = {
  async graphs() {
    return (await fetch('api/token-saver/canvas.graphs')).json()
  },
  async graph(id: string) {
    return (await fetch(`api/token-saver/canvas.graph?id=${encodeURIComponent(id)}`)).json()
  },
  async save(graph: CanvasGraph) {
    return (await fetch('api/token-saver/canvas.graph', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(graph),
    })).json()
  },
  async remove(id: string) {
    return (await fetch('api/token-saver/canvas.delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })).json()
  },
  async runs(graphId: string) {
    return (await fetch(`api/token-saver/canvas.runs?graphId=${encodeURIComponent(graphId)}`)).json()
  },
  async run(graphId: string, workspaceId: string) {
    return (await fetch('api/token-saver/canvas.run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ graphId, workspaceId }),
    })).json()
  },
  async workspaces() {
    return (await fetch('api/token-saver/canvas.workspaces')).json()
  },
}

const KIND_COLOR: Record<CanvasNode['kind'], string> = {
  input: '#7c5cff',
  task: '#4c8bf5',
  'web-ai': '#2f9e6e',
  subagent: '#c47c1f',
  tool: '#b0475e',
  review: '#8a6d3b',
  output: '#4a4a4a',
}

export function CanvasPage({ t }: CanvasPageProps): ReactNode {
  const [graphs, setGraphs] = useState<{ id: string; name: string; description: string; nodeCount: number }[]>([])
  const [current, setCurrent] = useState<CanvasGraph | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<{ id: string; title: string; path: string }[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [run, setRun] = useState<CanvasRun | null>(null)
  const [message, setMessage] = useState('')

  const refreshGraphs = async () => {
    const res = await api.graphs()
    setGraphs(res.graphs ?? [])
  }

  useEffect(() => {
    void refreshGraphs()
    void api.workspaces().then((res) => {
      const ws = res.workspaces ?? []
      setWorkspaces(ws)
      if (ws[0] !== undefined) setWorkspaceId(ws[0].id)
    })
  }, [])

  useEffect(() => {
    if (current === null) return
    setNodes(current.nodes.map(node => ({
      id: node.id,
      type: 'default',
      position: node.position,
      data: { label: node.title, kind: node.kind },
      style: { borderColor: KIND_COLOR[node.kind] ?? '#888' },
    })))
    setEdges(current.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, label: edge.label })))
  }, [current, setNodes, setEdges])

  const selectedNode = useMemo(() => {
    if (current === null || selectedNodeId === null) return undefined
    return current.nodes.find(node => node.id === selectedNodeId)
  }, [current, selectedNodeId])

  const newGraph = () => {
    const graph: CanvasGraph = {
      version: 1,
      id: `graph-${Date.now().toString(36)}`,
      name: 'New workflow',
      description: '',
      nodes: [],
      edges: [],
      updatedAt: Date.now(),
    }
    setCurrent(graph)
    setSelectedNodeId(null)
  }

  const openGraph = async (id: string) => {
    const res = await api.graph(id)
    if (res.graph !== undefined) {
      setCurrent(res.graph)
      setSelectedNodeId(null)
      void pollRuns(res.graph.id)
    }
  }

  const save = async () => {
    if (current === null) return
    const res = await api.save(current)
    if (res.ok === true) {
      setMessage('Saved')
      await refreshGraphs()
    } else {
      setMessage(typeof res === 'string' ? res : 'Save failed')
    }
  }

  const deleteGraph = async (id: string) => {
    await api.remove(id)
    if (current?.id === id) setCurrent(null)
    await refreshGraphs()
  }

  const pollRuns = async (graphId: string) => {
    const res = await api.runs(graphId)
    const runs = res.runs ?? []
    if (runs[0] !== undefined) setRun(runs[0])
  }

  const runGraph = async () => {
    if (current === null || workspaceId === '') return
    const res = await api.run(current.id, workspaceId)
    setMessage(`Started run: ${res.sessionId ?? ''}`)
    void pollRuns(current.id)
  }

  const onConnect = (connection: { source: string; target: string }) => {
    if (current === null) return
    setEdges(eds => addEdge({ ...connection, id: `e-${Date.now().toString(36)}` }, eds))
    setCurrent({ ...current, edges: [{ id: `e-${Date.now().toString(36)}`, source: connection.source, target: connection.target }] })
  }

  const updateSelected = (patch: Partial<CanvasNode>) => {
    if (current === null || selectedNodeId === null) return
    const next = current.nodes.map(node => node.id === selectedNodeId ? { ...node, ...patch } : node)
    setCurrent({ ...current, nodes: next })
    setNodes(next.map(node => ({ id: node.id, position: node.position, data: { label: node.title, kind: node.kind }, style: { borderColor: KIND_COLOR[node.kind] ?? '#888' } })))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, padding: 8, alignItems: 'center', borderBottom: '1px solid var(--vscode-panel-border, #333)' }}>
        <button type="button" onClick={newGraph}>{t('newGraph')}</button>
        <button type="button" onClick={save}>{t('save')}</button>
        <select value={workspaceId} onChange={e => setWorkspaceId(e.target.value)}>
          {workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.title}</option>)}
        </select>
        <button type="button" onClick={runGraph}>{t('run')}</button>
        {message !== '' && <span>{message}</span>}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside style={{ width: 180, overflow: 'auto', borderRight: '1px solid var(--vscode-panel-border, #333)', padding: 8 }}>
          {graphs.map(graph => (
            <div key={graph.id} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <button type="button" style={{ flex: 1, textAlign: 'left' }} onClick={() => openGraph(graph.id)}>{graph.name}</button>
              <button type="button" onClick={() => deleteGraph(graph.id)}>{t('delete')}</button>
            </div>
          ))}
        </aside>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>
        <aside style={{ width: 240, overflow: 'auto', borderLeft: '1px solid var(--vscode-panel-border, #333)', padding: 8 }}>
          {selectedNode === undefined ? (
            <div>
              <label>{t('graphName')}</label>
              <input value={current?.name ?? ''} onChange={e => setCurrent(current ? { ...current, name: e.target.value } : current)} />
              <label>{t('graphDescription')}</label>
              <input value={current?.description ?? ''} onChange={e => setCurrent(current ? { ...current, description: e.target.value } : current)} />
            </div>
          ) : (
            <div>
              <label>{t('nodeTitle')}</label>
              <input value={selectedNode.title} onChange={e => updateSelected({ title: e.target.value })} />
              <label>{t('nodeKind')}</label>
              <select value={selectedNode.kind} onChange={e => updateSelected({ kind: e.target.value as CanvasNode['kind'] })}>
                {Object.keys(KIND_COLOR).map(kind => <option key={kind} value={kind}>{kind}</option>)}
              </select>
              <label>{t('instruction')}</label>
              <textarea value={selectedNode.instruction} onChange={e => updateSelected({ instruction: e.target.value })} />
              {(selectedNode.kind === 'web-ai') && (
                <>
                  <label>{t('provider')}</label>
                  <input value={selectedNode.config.provider ?? ''} onChange={e => updateSelected({ config: { ...selectedNode.config, provider: e.target.value } })} />
                </>
              )}
              {(selectedNode.kind === 'tool') && (
                <>
                  <label>{t('tool')}</label>
                  <input value={selectedNode.config.tool ?? ''} onChange={e => updateSelected({ config: { ...selectedNode.config, tool: e.target.value } })} />
                </>
              )}
            </div>
          )}
        </aside>
      </div>
      {run !== null && (
        <div style={{ padding: 8, borderTop: '1px solid var(--vscode-panel-border, #333)' }}>
          {t('progress')}: {Object.values(run.nodes).filter(n => n.status === 'done').length}/{Object.keys(run.nodes).length}
        </div>
      )}
    </div>
  )
}
