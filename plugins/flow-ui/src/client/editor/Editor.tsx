/**
 * The canvas editor: React Flow canvas, a node palette, an inspector for the
 * selected node, a problems panel, and a run panel. The FlowDocument is the
 * source of truth; the canvas is re-derived from it on every change.
 *
 * @module @dsh-plugins/flow-ui/client/editor/Editor
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useEdgesState, useNodesState,
  type Connection, type Edge, type Node as RfNodeBase,
} from '@xyflow/react'
import type { FlowDocument, FlowNode, Issue } from '@dsh-plugins/flow/spec'
import { NODE_TYPES } from '@dsh-plugins/flow/spec'
import { api, errorText } from '../api.ts'
import { createNode, fromRf, newId, toRfEdges, toRfNodes } from './convert.ts'
import { FlowNodeView, CommentNodeView } from './NodeView.tsx'
import { NodeForm } from './forms.tsx'
import { openRunStream } from '../run/run-stream.ts'

/** The node categories shown in the palette. */
const PALETTE_CATEGORIES: { label: string; types: string[] }[] = [
  { label: 'Basic', types: ['start', 'end', 'comment'] },
  { label: 'AI', types: ['llm', 'intent', 'agent'] },
  { label: 'Logic', types: ['condition', 'loop', 'batch', 'break', 'continue', 'assign', 'aggregate', 'subflow'] },
  { label: 'Data', types: ['code', 'text', 'json', 'http'] },
  { label: 'Tool', types: ['tool'] },
  { label: 'Interaction', types: ['question', 'message'] },
]

/** Props for the editor. */
export interface EditorProps {
  flow: FlowDocument
  onSaved(flow: FlowDocument): void
  t(key: string): string
}

/** The canvas editor. */
export function Editor({ flow, onSaved, t }: EditorProps): JSX.Element {
  const initialNodes = useMemo(() => toRfNodes(flow), [])
  const initialEdges = useMemo(() => toRfEdges(flow), [])
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [issues, setIssues] = useState<Issue[]>([])
  const [running, setRunning] = useState(false)
  const [runStatus, setRunStatus] = useState<string>('')
  const [runOutputs, setRunOutputs] = useState<string>('')
  const [message, setMessage] = useState<string>('')
  const [dirty, setDirty] = useState(false)
  const [revision, setRevision] = useState(flow.revision)
  const [doc, setDoc] = useState(flow)
  const [runId, setRunId] = useState<string | undefined>(undefined)
  const [inputs, setInputs] = useState<string>('{}')
  const abortRef = useRef<AbortController | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const selectedNode = useMemo(() => doc.nodes.find(n => n.id === selectedId), [doc.nodes, selectedId])

  // Sync doc changes to the canvas.
  const syncDoc = useCallback((next: FlowDocument): void => {
    setDoc(next)
    setNodes(toRfNodes(next))
    setEdges(toRfEdges(next))
    setDirty(true)
    void validate(next).then(setIssues)
  }, [])

  const validate = async (candidate: FlowDocument): Promise<Issue[]> => {
    try {
      return await api.validate(candidate)
    } catch {
      return []
    }
  }

  const commitDoc = (next: FlowDocument): void => {
    syncDoc(next)
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void save(next) }, 1500)
  }

  const save = async (next: FlowDocument): Promise<void> => {
    try {
      const saved = await api.save(next, revision)
      setRevision(saved.revision)
      setDoc(saved)
      setDirty(false)
      setMessage(t('saved'))
      onSaved(saved)
    } catch (error: unknown) {
      setMessage(errorText(error))
    }
  }

  const onConnect = useCallback((connection: Connection): void => {
    setEdges(eds => addEdge({ ...connection, id: newId('edge'), type: 'flow' }, eds))
  }, [setEdges])

  const onDrop = useCallback((event: React.DragEvent): void => {
    event.preventDefault()
    const type = event.dataTransfer.getData('application/dsflow-node')
    if (type === '') return
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    const node = createNode(type as FlowNode['type'], newId(type), position)
    commitDoc({ ...doc, nodes: [...doc.nodes, node] })
    setSelectedId(node.id)
  }, [doc, commitDoc])

  const onNodeClick = useCallback((_: unknown, node: RfNodeBase): void => {
    setSelectedId(node.id)
  }, [])

  const deleteSelected = useCallback((): void => {
    if (selectedId === undefined) return
    const next = {
      ...doc,
      nodes: doc.nodes.filter(n => n.id !== selectedId),
      edges: doc.edges.filter(e => e.source !== selectedId && e.target !== selectedId),
    }
    commitDoc(next)
    setSelectedId(undefined)
  }, [doc, selectedId, commitDoc])

  const startRun = useCallback(async (): Promise<void> => {
    const start = doc.nodes.find(n => n.type === 'start')
    const inputMap = safeParse(inputs)
    const payload = { ...inputMap }
    for (const field of start?.type === 'start' ? start.data.fields : []) {
      if (payload[field.name] === undefined && (field as { default?: unknown }).default !== undefined) {
        payload[field.name] = (field as { default?: unknown }).default
      }
    }
    setRunning(true)
    setRunStatus(t('running'))
    setRunOutputs('')
    setMessage('')
    try {
      const rid = await api.startRun(doc.id, 'draft', payload)
      setRunId(rid)
      const controller = new AbortController()
      abortRef.current = controller
      let lastSeq = 0
      const lines: string[] = []
      void openRunStream(rid, 0, (event) => {
        if (typeof event.seq === 'number') lastSeq = event.seq
        if (event.type === 'node.finished') lines.push(`${String(event.nodeId)}: ${String(event.status)}`)
        if (event.type === 'run.finished') {
          setRunStatus(String(event.status))
          setRunOutputs(JSON.stringify(event.outputs ?? null, null, 2))
          setRunning(false)
        }
        void lastSeq
      }, controller.signal).catch(() => {
        setRunning(false)
      })
    } catch (error: unknown) {
      setRunStatus(t('runFailed'))
      setMessage(errorText(error))
      setRunning(false)
    }
  }, [doc, inputs, t])

  const stopRun = useCallback(async (): Promise<void> => {
    if (runId !== undefined) await api.cancelRun(runId).catch(() => {})
    abortRef.current?.abort()
    setRunning(false)
  }, [runId])

  const publish = useCallback(async (): Promise<void> => {
    setMessage('')
    try {
      const meta = await api.publish(doc.id, revision, '', { enabled: true, name: doc.name.toLowerCase().replace(/[^a-z0-9_]/g, '_') })
      setRevision(revision + 1)
      setMessage(`${t('published')} v${meta.publishedVersion}`)
    } catch (error: unknown) {
      setMessage(errorText(error))
    }
  }, [doc.id, doc.name, revision, t])

  return (
    <div className="dsflow-editor" onDrop={onDrop} onDragOver={e => e.preventDefault()}>
      <div className="dsflow-editor__toolbar">
        <span className="dsflow-editor__name">{doc.name}</span>
        <span className="dsflow-editor__status">{dirty ? t('unsaved') : message || t('saved')}</span>
        <button className="dsflow-button" onClick={() => { void save(doc) }}>{t('save')}</button>
        <button className="dsflow-button" onClick={() => { void publish() }}>{t('publish')}</button>
        <button className="dsflow-button" onClick={() => { void startRun() }} disabled={running}>{t('run')}</button>
        {running ? <button className="dsflow-button dsflow-button--ghost" onClick={() => { void stopRun() }}>{t('stop')}</button> : null}
        <span className="dsflow-editor__issues">{issues.length} {t('issues')}</span>
      </div>
      <div className="dsflow-editor__body">
        <Palette onAdd={type => {
          const node = createNode(type as FlowNode['type'], newId(type), { x: 120 + doc.nodes.length * 24, y: 120 + doc.nodes.length * 24 })
          commitDoc({ ...doc, nodes: [...doc.nodes, node] })
          setSelectedId(node.id)
        }} />
        <div className="dsflow-editor__canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            nodeTypes={{ flow: FlowNodeView, comment: CommentNodeView }}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>
        <div className="dsflow-editor__side">
          {selectedNode === undefined
            ? <div className="dsflow-editor__empty">{t('selectNode')}</div>
            : (
              <>
                <div className="dsflow-editor__side-head">
                  <span>{selectedNode.title}</span>
                  <button className="dsflow-button dsflow-button--ghost" onClick={deleteSelected}>{t('delete')}</button>
                </div>
                <NodeForm node={selectedNode} onChange={data => {
                  const updated = { ...selectedNode, data: data as never }
                  commitDoc({ ...doc, nodes: doc.nodes.map(n => n.id === selectedNode.id ? updated : n) })
                }} />
              </>
            )}
        </div>
      </div>
      <div className="dsflow-editor__problems">
        {issues.map((issue, index) => (
          <div key={index} className={`dsflow-problem dsflow-problem--${issue.severity}`}>
            <span className="dsflow-problem__code">{issue.code}</span>
            <span>{issue.message}</span>
            {issue.nodeId !== undefined
              ? <button className="dsflow-button dsflow-button--ghost" onClick={() => setSelectedId(issue.nodeId)}>{issue.nodeId}</button>
              : null}
          </div>
        ))}
      </div>
      <div className="dsflow-editor__run">
        <div className="dsflow-editor__run-head">
          <span>{t('runPanel')}</span>
          {running ? <span className="dsflow-editor__run-status">{runStatus}</span> : null}
        </div>
        <textarea className="dsflow-textarea dsflow-textarea--mono" value={inputs} onChange={e => setInputs(e.target.value)} />
        <pre className="dsflow-editor__run-output">{runOutputs}</pre>
      </div>
    </div>
  )
}

/** The node palette. */
function Palette({ onAdd }: { onAdd(type: string): void }): JSX.Element {
  return (
    <div className="dsflow-palette">
      {PALETTE_CATEGORIES.map(category => (
        <div key={category.label} className="dsflow-palette__category">
          <div className="dsflow-palette__category-label">{category.label}</div>
          {category.types.map(type => (
            <button
              key={type}
              className="dsflow-palette__item"
              draggable
              onDragStart={e => e.dataTransfer.setData('application/dsflow-node', type)}
              onClick={() => onAdd(type)}
            >
              {type}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Parse JSON inputs safely. */
function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // fall through
  }
  return {}
}

void NODE_TYPES
