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
import type { FlowDocument, FlowLookup, FlowNode, Issue, JsonValue, NodeType, RunView, ValidateLimits } from '@dsh-plugins/flow/spec'
import { GUIDED_NODE_TYPES, NODE_SPECS, guidedPrompt, validateFlow } from '@dsh-plugins/flow/spec'
import { api, errorText, ApiError, startFieldsOf, type CatalogFlow, type FlowMeta, type ModelCatalog, type ToolSummary } from '../api.ts'
import { addNodeAfter, addNodeAt, addNodeInside, autoLayout, canConnect, connect, createNode, moveNode, newId, removeEdges, removeNodeAndReconnect, removeNodes, replaceNode, resizeNode, seedNode, toRfEdges, toRfNodes, type NodeOverlay, type RfNode } from './convert.ts'
import { CommentNodeView, ContainerNodeView, FlowNodeView, NodeViewContext } from './NodeView.tsx'
import { NodeInspector } from './forms.tsx'
import { issueField, issueText } from './issues.ts'
import type { FormContext } from './node-forms.tsx'
import { PublishDialog, type PublishRequest } from './PublishDialog.tsx'
import { syncToolArgs, toolParams } from './variables.ts'
import { RunPanel } from '../run/RunPanel.tsx'
import type { LocaleKey, Translate } from '../locales.ts'

/** A palette entry: a node type, or the web AI preset (a `tool` node calling `web_ai_ask`). */
type PaletteItem = NodeType | 'webai'

const WEB_AI_TOOL = 'web_ai_ask'

/** The palette, by category. */
const PALETTE: { category: LocaleKey; types: PaletteItem[] }[] = [
  { category: 'palette.ai', types: ['agent', 'llm', 'intent', 'webai'] },
  { category: 'palette.logic', types: ['condition', 'loop', 'batch', 'aggregate', 'subflow'] },
  { category: 'palette.loopControl', types: ['break', 'continue', 'assign'] },
  { category: 'palette.data', types: ['code', 'text', 'json', 'http'] },
  { category: 'palette.tool', types: ['tool'] },
  { category: 'palette.interaction', types: ['question', 'message'] },
  { category: 'palette.basic', types: ['comment', 'start', 'end'] },
]

/** Node types that must sit directly inside a loop. */
const LOOP_ONLY: ReadonlySet<NodeType> = new Set(['break', 'continue', 'assign'])

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
  const [tools, setTools] = useState<ToolSummary[] | undefined>(undefined)
  const [models, setModels] = useState<ModelCatalog | undefined>(undefined)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [limits, setLimits] = useState<ValidateLimits>({})
  const [runView, setRunView] = useState<RunView | undefined>(undefined)
  const [hostIssues, setHostIssues] = useState<Issue[]>([])
  const [meta, setMeta] = useState(initialMeta)
  const [publishing, setPublishing] = useState<{ busy: boolean; error: string } | undefined>(undefined)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    api.catalogFlows().then(setCatalog).catch((error: unknown) => { setNotice(errorText(error)) })
    api.limits().then(setLimits).catch((error: unknown) => { setNotice(errorText(error)) })
    api.tools().then(setTools).catch(() => { setTools([]) })
    api.models().then(setModels).catch(() => { setModels(undefined) })
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
    const removals = changes.filter(change => change.type === 'remove')
    for (const change of changes) {
      if (change.type === 'position' && change.dragging === false && change.position !== undefined) next = moveNode(next, change.id, change.position)
      else if (change.type === 'remove') next = removals.length === 1 ? removeNodeAndReconnect(next, change.id, newId('edge')) : removeNodes(next, [change.id])
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

  const guided = doc.kind === 'guided'
  const [preview, setPreview] = useState(false)

  /** The palette label of an item: guided flows call the agent node a step. */
  const itemLabel = useCallback((item: PaletteItem): string => item === 'webai' ? t('palette.webai') : guided && item === 'agent' ? t('guided.step') : t(`nodeType.${item}` as LocaleKey), [guided, t])

  const addNode = useCallback((item: PaletteItem, dropPoint?: { x: number; y: number }): void => {
    const current = docRef.current
    const type: NodeType = item === 'webai' ? 'tool' : item
    const created = seedNode(createNode(type, newId(type), { x: 0, y: 0 }, itemLabel(item)), t, guided)
    const webAi = tools?.find(tool => tool.name === WEB_AI_TOOL)
    const fresh: FlowNode = item === 'webai' && created.type === 'tool'
      ? { ...created, data: { tool: WEB_AI_TOOL, args: webAi === undefined ? [] : syncToolArgs(toolParams(webAi.parameters), []) } }
      : created
    const selected = current.nodes.find(node => node.id === selectedId)
    const edgeId = (): string => newId('edge')
    let parent: FlowNode | undefined
    let next: FlowDocument
    if (dropPoint !== undefined) {
      parent = containerAt(current, dropPoint, id => flowApi.getInternalNode(id)?.internals.positionAbsolute)
      const origin = parent === undefined ? undefined : flowApi.getInternalNode(parent.id)?.internals.positionAbsolute
      const position = origin === undefined ? dropPoint : { x: dropPoint.x - origin.x, y: dropPoint.y - origin.y }
      next = addNodeAt(current, { ...fresh, position: { x: Math.round(position.x), y: Math.round(position.y) }, ...(parent === undefined ? {} : { parentId: parent.id }) } as FlowNode)
    } else if (selected !== undefined && NODE_SPECS[selected.type].container) {
      parent = selected
      next = addNodeInside(current, selected, fresh, edgeId)
    } else if (selected !== undefined && selected.type !== 'comment') {
      parent = current.nodes.find(node => node.id === selected.parentId)
      next = addNodeAfter(current, selected, fresh, edgeId)
    } else {
      const rect = canvasRef.current?.getBoundingClientRect()
      const center = rect === undefined ? { x: 80, y: 80 } : flowApi.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 })
      next = addNodeAt(current, { ...fresh, position: { x: Math.round(center.x - 100), y: Math.round(center.y) } })
    }
    if (LOOP_ONLY.has(type) && parent?.type !== 'loop') {
      setNotice(t('palette.loopOnly'))
      return
    }
    setNotice('')
    commit(next)
    setSelectedId(fresh.id)
    setTimeout(() => {
      const rect = canvasRef.current?.getBoundingClientRect()
      const internal = flowApi.getInternalNode(fresh.id)
      if (rect === undefined || internal === undefined) return
      const ids = [fresh.id, ...docRef.current.edges.filter(edge => edge.source === fresh.id).map(edge => edge.target)]
      const hidden = ids.some((id) => {
        const target = flowApi.getInternalNode(id)
        if (target === undefined) return false
        const screen = flowApi.flowToScreenPosition(target.internals.positionAbsolute)
        return screen.x < rect.left || screen.y < rect.top || screen.x + 180 > rect.right || screen.y + 60 > rect.bottom
      })
      const origin = internal.internals.positionAbsolute
      if (hidden) void flowApi.setCenter(origin.x + 100, origin.y + 30, { zoom: flowApi.getZoom(), duration: 200 })
    }, 50)
  }, [commit, flowApi, guided, itemLabel, selectedId, t, tools])

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const item = event.dataTransfer.getData(DRAG_MIME)
    if (item !== 'webai' && !(item in NODE_SPECS)) return
    addNode(item as PaletteItem, flowApi.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
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
  const flowName = useCallback((flowId: string) => catalog.find(entry => entry.id === flowId)?.name, [catalog])
  const nodeViewContext = useMemo(() => ({ t, flowName, guided, onResize: (nodeId: string, size: { width: number; height: number }) => { commit(resizeNode(docRef.current, nodeId, size)) } }), [t, commit, flowName, guided])
  const formContext = useMemo<FormContext>(() => ({ doc, lookup, t, tools, models, flows: catalog, guided }), [doc, lookup, t, tools, models, catalog, guided])
  const palette = useMemo(() => PALETTE.map(group => ({
    ...group,
    types: group.types.filter(item => item === 'webai'
      ? tools?.some(tool => tool.name === WEB_AI_TOOL) === true
      : !guided || GUIDED_NODE_TYPES.includes(item)),
  })).filter(group => group.types.length > 0), [guided, tools])
  const previewText = useMemo(() => {
    if (!preview) return ''
    const inputs: Record<string, JsonValue> = Object.fromEntries(startFieldsOf(doc).map(field => [field.name, `‹${field.name}›`]))
    return guidedPrompt(doc, 'conversation', inputs, { flowName }, '‹runId›')
  }, [doc, flowName, preview])
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
          {guided && <span className="dsflow-badge dsflow-badge--guided" title={t('kind.guidedHint')}>{t('kind.guided')}</span>}
          {guided && <Button variant="outline" size="sm" onClick={() => { setPreview(true) }}>{t('guided.preview')}</Button>}
          <Button variant="outline" size="sm" onClick={() => { commit(autoLayout(docRef.current)); setTimeout(() => { void flowApi.fitView({ padding: 0.2, maxZoom: 1, minZoom: 0.6, duration: 200 }) }, 50) }}>{t('layout')}</Button>
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
            <div className="dsflow-muted dsflow-palette__hint">{t('palette.hint')}</div>
            {palette.map(group => (
              <div key={group.category} className="dsflow-palette__category">
                <div className="dsflow-palette__label">{t(group.category)}</div>
                {group.types.map(item => (
                  <button
                    key={item}
                    type="button"
                    className="dsflow-palette__item"
                    data-node-type={item === 'webai' ? 'tool' : item}
                    title={item === 'webai' ? t('nodeHelp.webai') : guided && item === 'agent' ? t('guided.stepHelp') : t(`nodeHelp.${item}` as LocaleKey)}
                    draggable
                    onDragStart={event => { event.dataTransfer.setData(DRAG_MIME, item); event.dataTransfer.effectAllowed = 'move' }}
                    onClick={() => { addNode(item) }}
                  >
                    <span className="dsflow-palette__dot" />
                    {itemLabel(item)}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div ref={canvasRef} className="dsflow-editor__canvas" onDrop={onDrop} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}>
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
              connectionRadius={36}
              fitView
              fitViewOptions={{ maxZoom: 1, minZoom: 0.75, padding: 0.2 }}
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
          <div className="dsflow-editor__side">
            {selectedNode === undefined
              ? <EmptyInspector t={t} />
              : (
                <NodeInspector
                  key={selectedNode.id}
                  node={selectedNode}
                  ctx={formContext}
                  issues={issues.filter(issue => issue.nodeId === selectedNode.id)}
                  onChange={next => { commit(replaceNode(docRef.current, next)) }}
                  onDelete={() => { commit(removeNodeAndReconnect(docRef.current, selectedNode.id, newId('edge'))); setSelectedId(undefined) }}
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
                <span className="dsflow-problem__code">{issue.severity === 'error' ? '●' : '▲'}</span>
                {issue.nodeId !== undefined && <span className="dsflow-problem__node">{doc.nodes.find(node => node.id === issue.nodeId)?.title ?? issue.nodeId}</span>}
                <span>{issueText(issue, t)}</span>
                {issueField(issue, t) !== '' && <span className="dsflow-muted">{issueField(issue, t)}</span>}
              </button>
            ))}
        </div>
        <RunPanel doc={doc} t={t} beforeRun={flush} onView={setRunView} onIssues={setHostIssues} />
        {publishing !== undefined && (
          <PublishDialog t={t} meta={meta} busy={publishing.busy} error={publishing.error} onSubmit={(request) => { void publish(request) }} onCancel={() => { setPublishing(undefined) }} />
        )}
        {preview && (
          <div className="dsflow-dialog" role="dialog" aria-label={t('guided.preview')} onClick={() => { setPreview(false) }}>
            <div className="dsflow-dialog__panel dsflow-dialog__panel--wide" onClick={(event) => { event.stopPropagation() }}>
              <div className="dsflow-dialog__title">{t('guided.preview')}</div>
              <div className="dsflow-hint">{t('guided.previewHint')}</div>
              <pre className="dsflow-pre dsflow-pre--tall">{previewText}</pre>
              <div className="dsflow-dialog__actions">
                <Button variant="primary" size="sm" onClick={() => { setPreview(false) }}>{t('close')}</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </NodeViewContext.Provider>
  )
}

/** The inspector placeholder: a short how-to for first-time users. */
function EmptyInspector({ t }: { t: Translate }): ReactNode {
  return (
    <div className="dsflow-guide">
      <div className="dsflow-section__title">{t('guide.title')}</div>
      <ol>
        <li>{t('guide.step1')}</li>
        <li>{t('guide.step2')}</li>
        <li>{t('guide.step3')}</li>
        <li>{t('guide.step4')}</li>
      </ol>
    </div>
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
