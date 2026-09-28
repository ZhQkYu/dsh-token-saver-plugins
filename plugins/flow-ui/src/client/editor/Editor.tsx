/**
 * The canvas editor. The {@link FlowDocument} is the single source of truth:
 * React Flow nodes and edges are derived from it, and every move, resize,
 * connection, deletion, and inspector edit is written back to it and
 * autosaved. Validation runs locally with the shared spec.
 *
 * @module @dsh-plugins/flow-ui/client/editor/Editor
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, applyNodeChanges, useNodesState, useReactFlow,
  type Connection, type EdgeChange, type NodeChange,
} from '@xyflow/react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FlowDocument, FlowLookup, FlowNode, Issue, NodeType, RunView, ValidateLimits } from '@dsh-plugins/flow/spec'
import { NODE_SPECS, validateFlow } from '@dsh-plugins/flow/spec'
import { api, errorText, ApiError, type CatalogFlow, type FlowMeta } from '../api.ts'
import { canConnect, connect, createNode, moveNode, newId, removeEdges, removeNodes, replaceNode, resizeNode, toRfEdges, toRfNodes, type NodeOverlay, type RfNode } from './convert.ts'
import { CommentNodeView, ContainerNodeView, FlowNodeView, NodeViewContext } from './NodeView.tsx'
import { NodeInspector } from './forms.tsx'
import { PublishDialog, type PublishRequest } from './PublishDialog.tsx'
import { RunPanel } from '../run/RunPanel.tsx'
import type { LocaleKey, Translate } from '../locales.ts'

/** The palette, by category. */
const PALETTE: { category: LocaleKey; types: NodeType[] }[] = [
  { category: 'palette.basic', types: ['start', 'end', 'comment'] },
  { category: 'palette.ai', types: ['llm', 'intent', 'agent'] },
  { category: 'palette.logic', types: ['condition', 'loop', 'batch', 'break', 'continue', 'assign', 'aggregate', 'subflow'] },
  { category: 'palette.data', types: ['code', 'text', 'json', 'http'] },
  { category: 'palette.tool', types: ['tool'] },
  { category: 'palette.interaction', types: ['question', 'message'] },
]

const NODE_TYPES_RF = { flow: FlowNodeView, container: ContainerNodeView, comment: CommentNodeView }
const DRAG_MIME = 'application/x-dsh-flow-node'
const AUTOSAVE_MS = 1500

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

/** Props for the editor. */
export interface EditorProps {
  flow: FlowDocument
  meta: FlowMeta | null
  t: Translate
  onBack(): void
}

/** The canvas editor. */
export function Editor({ flow, meta: initialMeta, t, onBack }: EditorProps): ReactNode {
  const flowApi = useReactFlow()
  const [doc, setDoc] = useState(flow)
  const docRef = useRef(flow)
  const savedJson = useRef(JSON.stringify(flow))
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saving = useRef<Promise<boolean> | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [catalog, setCatalog] = useState<CatalogFlow[]>([])
  const [limits, setLimits] = useState<ValidateLimits>({})
  const [runView, setRunView] = useState<RunView | undefined>(undefined)
  const [hostIssues, setHostIssues] = useState<Issue[]>([])
  const [meta, setMeta] = useState(initialMeta)
  const [publishing, setPublishing] = useState<{ busy: boolean; error: string } | undefined>(undefined)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    api.catalogFlows().then(setCatalog).catch((error: unknown) => { setNotice(errorText(error)) })
    api.limits().then(setLimits).catch((error: unknown) => { setNotice(errorText(error)) })
    return () => { if (saveTimer.current !== undefined) clearTimeout(saveTimer.current) }
  }, [])

  const lookup = useMemo<FlowLookup>(() => (flowId, version) => {
    const entry = catalog.find(candidate => candidate.id === flowId)
    if (entry === undefined) return undefined
    if (version === 'draft') return entry.draft
    if (version === 'published') return entry.published
    return entry.published?.version === version ? entry.published : undefined
  }, [catalog])

  const issues = useMemo(() => [...validateFlow(doc, lookup, limits), ...hostIssues], [doc, lookup, limits, hostIssues])

  const save = useCallback(async (): Promise<boolean> => {
    if (saving.current !== undefined) return await saving.current
    const snapshot = docRef.current
    const json = JSON.stringify(snapshot)
    if (json === savedJson.current) {
      setSaveState('saved')
      return true
    }
    setSaveState('saving')
    const run = (async (): Promise<boolean> => {
      try {
        const saved = await api.save(snapshot, snapshot.revision)
        savedJson.current = JSON.stringify({ ...snapshot, revision: saved.revision, updatedAt: saved.updatedAt })
        // Keep edits made while the save was in flight; only the Host-owned fields change.
        const next = { ...docRef.current, revision: saved.revision, updatedAt: saved.updatedAt }
        docRef.current = next
        setDoc(next)
        const clean = JSON.stringify(next) === savedJson.current
        setSaveState(clean ? 'saved' : 'dirty')
        setSaveError('')
        return true
      } catch (error: unknown) {
        if (error instanceof ApiError && error.status === 409) {
          setSaveState('conflict')
        } else {
          setSaveState('error')
          setSaveError(errorText(error))
        }
        return false
      } finally {
        saving.current = undefined
      }
    })()
    saving.current = run
    const ok = await run
    if (ok && JSON.stringify(docRef.current) !== savedJson.current) schedule()
    return ok
  }, [])

  const schedule = (): void => {
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void save() }, AUTOSAVE_MS)
  }

  const flush = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
    return await save()
  }, [save])

  const commit = useCallback((next: FlowDocument): void => {
    docRef.current = next
    setDoc(next)
    setHostIssues([])
    setSaveState('dirty')
    schedule()
  }, [])

  const resolveConflict = async (mode: 'load' | 'overwrite'): Promise<void> => {
    try {
      const { flow: latest } = await api.get(doc.id)
      if (mode === 'load') {
        docRef.current = latest
        savedJson.current = JSON.stringify(latest)
        setDoc(latest)
        setSaveState('saved')
        return
      }
      docRef.current = { ...docRef.current, revision: latest.revision }
      setSaveState('dirty')
      await save()
    } catch (error: unknown) {
      setSaveError(errorText(error))
    }
  }

  // Canvas overlays: validation markers and the latest run status per node.
  const overlays = useMemo(() => {
    const map = new Map<string, NodeOverlay>()
    const entry = (id: string): NodeOverlay => {
      let current = map.get(id)
      if (current === undefined) { current = { issues: [] }; map.set(id, current) }
      return current
    }
    for (const issue of issues) if (issue.nodeId !== undefined) entry(issue.nodeId).issues.push(issue)
    for (const node of runView?.nodes ?? []) {
      const overlay = entry(node.nodeId)
      overlay.status = node.status
      if (node.durationMs !== undefined) overlay.durationMs = node.durationMs
      if (node.usage !== undefined) overlay.tokens = node.usage.inputTokens + node.usage.outputTokens
    }
    return map
  }, [issues, runView])

  const fired = useMemo(() => {
    if (runView === undefined) return undefined
    const map = new Map<string, string[]>()
    for (const node of runView.nodes) if (node.path.length === 0) map.set(node.nodeId, node.firedPorts ?? [])
    return map
  }, [runView])

  const [rfNodes, setRfNodes] = useNodesState<RfNode>([])
  useEffect(() => { setRfNodes(toRfNodes(doc, overlays, selectedId)) }, [doc, overlays, selectedId, setRfNodes])
  const rfEdges = useMemo(() => toRfEdges(doc, fired, t), [doc, fired, t])

  const onNodesChange = useCallback((changes: NodeChange<RfNode>[]): void => {
    setRfNodes(current => applyNodeChanges(changes, current))
    let next = docRef.current
    for (const change of changes) {
      if (change.type === 'position' && change.dragging === false && change.position !== undefined) next = moveNode(next, change.id, change.position)
      else if (change.type === 'remove') next = removeNodes(next, [change.id])
      else if (change.type === 'select' && change.selected) setSelectedId(change.id)
    }
    if (next !== docRef.current) commit(next)
  }, [commit, setRfNodes])

  const onEdgesChange = useCallback((changes: EdgeChange[]): void => {
    const removed = changes.flatMap(change => change.type === 'remove' ? [change.id] : [])
    if (removed.length > 0) commit(removeEdges(docRef.current, removed))
  }, [commit])

  const onConnect = useCallback((connection: Connection): void => {
    const next = connect(docRef.current, connection, newId('edge'))
    if (next !== docRef.current) commit(next)
  }, [commit])

  const isValidConnection = useCallback((connection: { source: string | null; target: string | null; sourceHandle?: string | null }) =>
    canConnect(docRef.current, { source: connection.source, target: connection.target, sourceHandle: connection.sourceHandle }), [])

  const addNode = useCallback((type: NodeType, dropPoint?: { x: number; y: number }): void => {
    const current = docRef.current
    const selected = current.nodes.find(node => node.id === selectedId)
    let parent: FlowNode | undefined
    let position: { x: number; y: number }
    if (dropPoint !== undefined) {
      parent = containerAt(current, dropPoint, id => flowApi.getInternalNode(id)?.internals.positionAbsolute)
      const origin = parent === undefined ? undefined : flowApi.getInternalNode(parent.id)?.internals.positionAbsolute
      position = origin === undefined ? dropPoint : { x: dropPoint.x - origin.x, y: dropPoint.y - origin.y }
    } else {
      parent = selected !== undefined && NODE_SPECS[selected.type].container ? selected : undefined
      const siblings = current.nodes.filter(node => node.parentId === parent?.id).length
      position = parent === undefined ? { x: 80 + siblings * 30, y: 80 + siblings * 30 } : { x: 30 + siblings * 20, y: 60 + siblings * 20 }
    }
    const node = createNode(type, newId(type), position, t(`nodeType.${type}` as LocaleKey), parent?.id)
    commit({ ...current, nodes: [...current.nodes, node] })
    setSelectedId(node.id)
  }, [commit, flowApi, selectedId, t])

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const type = event.dataTransfer.getData(DRAG_MIME) as NodeType
    if (!(type in NODE_SPECS)) return
    addNode(type, flowApi.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }, [addNode, flowApi])

  const publish = async (request: PublishRequest): Promise<void> => {
    setPublishing({ busy: true, error: '' })
    if (!await flush()) {
      setPublishing({ busy: false, error: saveError || t('conflict') })
      return
    }
    try {
      const next = await api.publish(doc.id, docRef.current.revision, request.note, request.tool)
      setMeta(next)
      setPublishing(undefined)
      setNotice(`${t('published')}${next.publishedVersion ?? ''}`)
    } catch (error: unknown) {
      if (error instanceof ApiError && error.issues !== undefined) setHostIssues(error.issues)
      const message = error instanceof ApiError && error.code === 'TOOL_NAME_TAKEN' ? t('toolNameTaken') : errorText(error)
      setPublishing({ busy: false, error: message })
    }
  }

  const selectedNode = doc.nodes.find(node => node.id === selectedId)
  const nodeViewContext = useMemo(() => ({ t, onResize: (nodeId: string, size: { width: number; height: number }) => { commit(resizeNode(docRef.current, nodeId, size)) } }), [t, commit])
  const errorCount = issues.filter(issue => issue.severity === 'error').length

  return (
    <NodeViewContext.Provider value={nodeViewContext}>
      <div
        className="dsflow-editor"
        onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void flush() } }}
      >
        <div className="dsflow-editor__toolbar">
          <Button variant="ghost" size="sm" onClick={() => { void flush().then(() => { onBack() }) }}>← {t('back')}</Button>
          <input
            className="dsflow-input dsflow-editor__name"
            value={doc.name}
            maxLength={200}
            aria-label={t('name')}
            onChange={event => { if (event.target.value.trim() !== '') commit({ ...docRef.current, name: event.target.value }) }}
          />
          <span className="dsflow-muted">{saveState === 'saving' ? t('saving') : saveState === 'dirty' ? t('unsaved') : saveState === 'error' ? `${t('saveFailed')}${saveError}` : saveState === 'saved' ? t('saved') : ''}</span>
          {notice !== '' && <span className="dsflow-muted">{notice}</span>}
          <span className="dsflow-spacer" />
          <span className={errorCount > 0 ? 'dsflow-error' : 'dsflow-muted'}>{issues.length} {t('issues')}</span>
          <Button variant="outline" size="sm" onClick={() => { void flush() }}>{t('save')}</Button>
          <Button variant="primary" size="sm" onClick={() => { setPublishing({ busy: false, error: '' }) }}>{t('publish')}</Button>
        </div>
        {saveState === 'conflict' && (
          <div className="dsflow-banner">
            <span>{t('conflict')}</span>
            <Button variant="outline" size="sm" onClick={() => { void resolveConflict('load') }}>{t('loadLatest')}</Button>
            <Button variant="outline" size="sm" onClick={() => { void resolveConflict('overwrite') }}>{t('overwrite')}</Button>
          </div>
        )}
        <div className="dsflow-editor__body">
          <div className="dsflow-palette">
            {PALETTE.map(group => (
              <div key={group.category} className="dsflow-palette__category">
                <div className="dsflow-palette__label">{t(group.category)}</div>
                {group.types.map(type => (
                  <button
                    key={type}
                    type="button"
                    className="dsflow-palette__item"
                    draggable
                    onDragStart={event => { event.dataTransfer.setData(DRAG_MIME, type); event.dataTransfer.effectAllowed = 'move' }}
                    onClick={() => { addNode(type) }}
                  >
                    {t(`nodeType.${type}` as LocaleKey)}
                  </button>
                ))}
              </div>
            ))}
            <div className="dsflow-muted dsflow-palette__hint">{t('selectContainerHint')}</div>
          </div>
          <div className="dsflow-editor__canvas" onDrop={onDrop} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}>
            <ReactFlow<RfNode>
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={NODE_TYPES_RF}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onPaneClick={() => { setSelectedId(undefined) }}
              deleteKeyCode={['Backspace', 'Delete']}
              fitView
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
          <div className="dsflow-editor__side">
            {selectedNode === undefined
              ? <div className="dsflow-muted">{t('selectNode')}</div>
              : (
                <NodeInspector
                  key={selectedNode.id}
                  doc={doc}
                  node={selectedNode}
                  lookup={lookup}
                  t={t}
                  onChange={next => { commit(replaceNode(docRef.current, next)) }}
                  onDelete={() => { commit(removeNodes(docRef.current, [selectedNode.id])); setSelectedId(undefined) }}
                />
              )}
          </div>
        </div>
        <div className="dsflow-editor__problems">
          {issues.length === 0
            ? <span className="dsflow-muted">{t('noIssues')}</span>
            : issues.map((issue, index) => (
              <button
                key={index}
                type="button"
                className="dsflow-problem"
                data-severity={issue.severity}
                title={issue.message}
                onClick={() => { if (issue.nodeId !== undefined) setSelectedId(issue.nodeId) }}
              >
                <span className="dsflow-problem__code">{t(`issue.${issue.code}` as LocaleKey)}</span>
                {issue.nodeId !== undefined && <span>{doc.nodes.find(node => node.id === issue.nodeId)?.title ?? issue.nodeId}</span>}
                {issue.field !== undefined && <span className="dsflow-muted">{issue.field}</span>}
                <span className="dsflow-muted">{issue.message}</span>
              </button>
            ))}
        </div>
        <RunPanel doc={doc} t={t} beforeRun={flush} onView={setRunView} onIssues={setHostIssues} />
        {publishing !== undefined && (
          <PublishDialog t={t} meta={meta} busy={publishing.busy} error={publishing.error} onSubmit={(request) => { void publish(request) }} onCancel={() => { setPublishing(undefined) }} />
        )}
      </div>
    </NodeViewContext.Provider>
  )
}

/** The innermost container whose absolute bounds contain a flow-space point. */
function containerAt(doc: FlowDocument, point: { x: number; y: number }, absolute: (id: string) => { x: number; y: number } | undefined): FlowNode | undefined {
  let found: FlowNode | undefined
  for (const node of doc.nodes) {
    if (!NODE_SPECS[node.type].container || node.size === undefined) continue
    const origin = absolute(node.id)
    if (origin === undefined) continue
    const inside = point.x >= origin.x && point.y >= origin.y && point.x <= origin.x + node.size.width && point.y <= origin.y + node.size.height
    if (inside && (found === undefined || (node.parentId !== undefined && node.parentId === found.id))) found = node
  }
  return found
}
