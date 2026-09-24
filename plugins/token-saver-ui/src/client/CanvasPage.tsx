/**
 * The workflow canvas main panel: a graph list, a React Flow editor with a
 * node palette, context menus, and connect/reconnect/delete interactions, an
 * inspector with the node and workflow editors, and save/run/stop controls
 * with live run status. `graph` owns the saved content, positions, and edges;
 * the React Flow state owns node selection and measurements, and edge
 * selection is kept beside it.
 *
 * @module @dsh-plugins/token-saver-ui/client/canvas-page
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  Background, ConnectionLineType, Controls, MarkerType, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  useNodesState, useReactFlow,
  type Connection, type EdgeChange, type FinalConnectionState, type IsValidConnection, type Node, type NodeChange,
} from '@xyflow/react'
import {
  Button, IconPlayOutlineRegular, IconPlusOutlineRegular, IconStopFillRegular, IconWorkspaceTreeOutlineRegular, Menu, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ELSE_BRANCH, NODE_KINDS, type CanvasEdge, type CanvasGraph, type CanvasNode, type CanvasRun, type CatalogProvider, type CatalogTool,
  type NodeKind, type NodeStatus,
} from '@dsh-plugins/token-saver/protocol'
import { CanvasActionsContext, type CanvasActions } from './actions.ts'
import { api, errorText, type GraphSummary, type WorkspaceSummary } from './api.ts'
import { autoLayout, hasCycle, reconcileBranchEdges, wouldCreateCycle } from './graph-ops.ts'
import { Inspector, type NodePatch } from './Inspector.tsx'
import { KIND_COLOR, KindIcon } from './kinds.tsx'
import type { LocaleKey } from './locales.ts'
import { StepEdge, type StepFlowEdge } from './StepEdge.tsx'
import { StepNode, type StepFlowNode } from './StepNode.tsx'

/** Props the `main` slot passes to the page. */
export interface CanvasPageProps {
  t: (key: string) => string
}

type Notice = { kind: 'info' | 'error'; text: string }
type Side = 'source' | 'target'
type MenuTarget =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | { type: 'pane' }
  | { type: 'connect'; from: string; fromSide: Side; handle: string | null }
type OpenMenu = { x: number; y: number; target: MenuTarget }

const NODE_TYPES = { step: StepNode }
const EDGE_TYPES = { step: StepEdge }
const EDGE_MARKER = { type: MarkerType.ArrowClosed, width: 18, height: 18 }
const DRAG_MIME = 'application/x-token-saver-node-kind'
/** Approximate half of a node box, used to center a new node on the pointer. */
const NODE_HALF = { x: 100, y: 36 }
const TERMINAL: ReadonlySet<NodeStatus> = new Set(['done', 'failed', 'skipped'])
const POLL_MS = 2000
/** How long to keep polling after "Run" before the new session has created its run. */
const RUN_START_GRACE_MS = 90_000
/** A run untouched this long counts as abandoned and stops the polling. */
const RUN_STALE_MS = 10 * 60_000
const DETAIL_CHARS = 60
/** Fitting never zooms past 1:1, so a graph with one or two nodes stays readable. */
const FIT_VIEW = { padding: 0.2, maxZoom: 1 }

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

function toFlowNode(node: CanvasNode, selected = false): StepFlowNode {
  return { id: node.id, type: 'step', position: node.position, selected, data: { kind: node.kind, title: node.title, detail: '', detailWarning: false } }
}

function isActive(run: CanvasRun): boolean {
  if (run.mode === 'strict') return run.state === 'running'
  return Date.now() - run.updatedAt < RUN_STALE_MS && Object.values(run.nodes).some(node => !TERMINAL.has(node.status))
}

function pointerOf(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ('changedTouches' in event) {
    const touch = event.changedTouches[0]
    return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 }
  }
  return { x: event.clientX, y: event.clientY }
}

/**
 * Render the canvas page.
 * @param props - the slot's bound translator.
 * @returns the page element.
 */
export function CanvasPage(props: CanvasPageProps): ReactNode {
  return (
    <ReactFlowProvider>
      <CanvasEditor t={props.t as (key: LocaleKey) => string} />
    </ReactFlowProvider>
  )
}

function CanvasEditor({ t }: { t: (key: LocaleKey) => string }): ReactNode {
  const flow = useReactFlow<StepFlowNode, StepFlowEdge>()
  const wrapper = useRef<HTMLDivElement>(null)
  const [graphs, setGraphs] = useState<GraphSummary[]>([])
  const [graph, setGraph] = useState<CanvasGraph | null>(null)
  const [dirty, setDirty] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<StepFlowNode>([])
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set())
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [runInput, setRunInput] = useState('')
  const [tools, setTools] = useState<CatalogTool[] | null | undefined>(null)
  const [providers, setProviders] = useState<CatalogProvider[] | null | undefined>(null)
  const [run, setRun] = useState<CanvasRun | null>(null)
  const [pollUntil, setPollUntil] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [pendingDiscard, setPendingDiscard] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const reconnecting = useRef<string | null>(null)

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
    // Missing catalogs degrade the pickers to free text.
    api.tools().then(setTools, () => { setTools(undefined) })
    api.providers().then(setProviders, () => { setProviders(undefined) })
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
    setGraph(current => current === null ? current : reconcileBranchEdges(change(current)))
    setDirty(true)
    setPendingDiscard(null)
  }

  const load = (next: CanvasGraph, unsaved: boolean): void => {
    setGraph(next)
    setDirty(unsaved)
    setPendingDelete(null)
    setPendingDiscard(null)
    setRun(null)
    setMenu(null)
    setNodes(next.nodes.map(node => toFlowNode(node)))
    setSelectedEdges(new Set())
    requestAnimationFrame(() => { void flow.fitView(FIT_VIEW) })
  }

  /** Run `action`, or first require a second click when it would drop unsaved edits. */
  const guardUnsaved = (key: string, action: () => void): void => {
    if (dirty && pendingDiscard !== key) {
      setPendingDiscard(key)
      setNotice({ kind: 'error', text: t('discardConfirm') })
      return
    }
    setPendingDiscard(null)
    setNotice(null)
    action()
  }

  const openGraph = (id: string): void => {
    guardUnsaved(`open:${id}`, () => { api.graph(id).then(next => { load(next, false) }, fail('loadFailed')) })
  }

  const newGraph = (): void => {
    guardUnsaved('new', () => {
      load({ version: 1, id: newId('g'), name: t('newGraphName'), description: '', nodes: [], edges: [], updatedAt: 0 }, true)
    })
  }

  // Node and edge editing.

  /** Config a node of `kind` starts with, so control-flow nodes are valid as soon as they are added. */
  const defaultConfig = (kind: NodeKind): CanvasNode['config'] => {
    switch (kind) {
      case 'condition': return {
        decide: 'model',
        branches: [{ id: newId('b'), label: t('branchYes') }, { id: newId('b'), label: t('branchNo') }],
      }
      case 'loop': return { decide: 'model', maxIterations: 3 }
      default: return {}
    }
  }

  const addNode = (kind: NodeKind, position: { x: number; y: number }, connect?: { from: string; fromSide: Side; handle: string | null }): void => {
    if (graph === null) return
    const node: CanvasNode = { id: newId('n'), kind, title: t(`kind.${kind}`), instruction: '', config: defaultConfig(kind), position }
    const edge: CanvasEdge | undefined = connect === undefined
      ? undefined
      : connect.fromSide === 'source'
        ? { id: newId('e'), source: connect.from, target: node.id, ...(connect.handle === null ? {} : { sourceHandle: connect.handle }) }
        : { id: newId('e'), source: node.id, target: connect.from }
    edit(current => ({ ...current, nodes: [...current.nodes, node], edges: edge === undefined ? current.edges : [...current.edges, edge] }))
    setNodes(current => [...current.map(item => item.selected === true ? { ...item, selected: false } : item), toFlowNode(node, true)])
  }

  const flowPointAt = (clientX: number, clientY: number): { x: number; y: number } => {
    const point = flow.screenToFlowPosition({ x: clientX, y: clientY })
    return { x: Math.round(point.x - NODE_HALF.x), y: Math.round(point.y - NODE_HALF.y) }
  }

  const addNodeAtCenter = (kind: NodeKind): void => {
    const rect = wrapper.current?.getBoundingClientRect()
    if (rect === undefined || graph === null) return
    // Stagger repeated clicks so new nodes do not stack exactly.
    const offset = (graph.nodes.length % 5) * 24
    const point = flowPointAt(rect.left + rect.width / 2, rect.top + rect.height / 2)
    addNode(kind, { x: point.x + offset, y: point.y + offset })
  }

  const updateNode = (id: string, patch: NodePatch): void => {
    edit(current => ({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id !== id) return node
        const next = { ...node, ...patch }
        if (patch.kind === undefined || patch.kind === node.kind) return next
        // A kind change fills that kind's required fields and renames a generated title.
        return {
          ...next,
          config: { ...defaultConfig(patch.kind), ...next.config },
          title: isGeneratedTitle(node, undefined) ? t(`kind.${patch.kind}`) : next.title,
        }
      }),
    }))
  }

  /** Whether the title is still generated (empty, the kind label, or the previous pick), so a new pick may replace it. */
  const isGeneratedTitle = (node: CanvasNode, previous: string | undefined): boolean =>
    node.title.trim() === '' || node.title === t(`kind.${node.kind}`) || (previous !== undefined && node.title === previous)

  const pickTool = (node: CanvasNode, tool: string): void => {
    const title = tool !== '' && isGeneratedTitle(node, node.config.tool) ? tool : node.title
    updateNode(node.id, { title, config: { ...node.config, tool } })
  }

  const pickProvider = (node: CanvasNode, provider: string): void => {
    const previous = providers?.find(item => item.id === node.config.provider)?.displayName
    const next = providers?.find(item => item.id === provider)?.displayName
    const title = next !== undefined && isGeneratedTitle(node, previous) ? next : node.title
    const config = { ...node.config }
    if (provider === '') delete config.provider
    else config.provider = provider
    updateNode(node.id, { title, config })
  }

  const duplicateNode = (id: string): void => {
    const source = graph?.nodes.find(node => node.id === id)
    if (source === undefined) return
    const position = { x: source.position.x + 40, y: source.position.y + 40 }
    const copy: CanvasNode = { ...source, id: newId('n'), config: { ...source.config }, position }
    edit(current => ({ ...current, nodes: [...current.nodes, copy] }))
    setNodes(current => [...current.map(item => item.selected === true ? { ...item, selected: false } : item), toFlowNode(copy, true)])
  }

  const onNodesDelete = (deleted: Node[]): void => {
    const removed = new Set(deleted.map(node => node.id))
    edit(current => ({
      ...current,
      nodes: current.nodes.filter(node => !removed.has(node.id)),
      edges: current.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)),
    }))
  }

  const onEdgesDelete = (deleted: { id: string }[]): void => {
    const removed = new Set(deleted.map(edge => edge.id))
    edit(current => ({ ...current, edges: current.edges.filter(edge => !removed.has(edge.id)) }))
  }

  const deleteNode = (id: string): void => { void flow.deleteElements({ nodes: [{ id }] }) }
  const deleteEdge = (id: string): void => { void flow.deleteElements({ edges: [{ id }] }) }

  const onNodesChangeAndMove = (changes: NodeChange<StepFlowNode>[]): void => {
    onNodesChange(changes)
    // Drag ends and keyboard nudges report settled positions; mid-drag frames carry `dragging: true`.
    const moved = new Map(changes.flatMap(change =>
      change.type === 'position' && change.position !== undefined && change.dragging !== true ? [[change.id, change.position] as const] : []))
    if (moved.size === 0) return
    edit(current => ({ ...current, nodes: current.nodes.map(node => ({ ...node, position: moved.get(node.id) ?? node.position })) }))
  }

  // Connections.

  const connectionProblem = (source: string, target: string, handle: string | null, ignoreEdge: string | null): LocaleKey | undefined => {
    const others = (graph?.edges ?? []).filter(edge => edge.id !== ignoreEdge)
    if (source === target) return 'selfLoop'
    if (others.some(edge => edge.source === source && edge.target === target && (edge.sourceHandle ?? null) === handle)) return 'duplicateEdge'
    if (wouldCreateCycle(others, source, target)) return 'cycleEdge'
    return undefined
  }

  const isValidConnection: IsValidConnection<StepFlowEdge> = connection =>
    connectionProblem(connection.source, connection.target, connection.sourceHandle ?? null, reconnecting.current) === undefined

  const onConnect = (connection: Connection): void => {
    const problem = connectionProblem(connection.source, connection.target, connection.sourceHandle, null)
    if (problem !== undefined) {
      setNotice({ kind: 'error', text: t(problem) })
      return
    }
    const edge: CanvasEdge = {
      id: newId('e'),
      source: connection.source,
      target: connection.target,
      ...(connection.sourceHandle === null ? {} : { sourceHandle: connection.sourceHandle }),
    }
    edit(current => ({ ...current, edges: [...current.edges, edge] }))
  }

  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState): void => {
    // Only a drop on empty pane offers "add a connected node"; drops on nodes or invalid handles do nothing.
    if (state.isValid === true || state.fromNode === null || state.toNode !== null) return
    const { x, y } = pointerOf(event)
    if (document.elementFromPoint(x, y)?.closest('.react-flow__node') != null) return
    const fromSide = state.fromHandle?.type ?? 'source'
    setMenu({ x, y, target: { type: 'connect', from: state.fromNode.id, fromSide, handle: fromSide === 'source' ? state.fromHandle?.id ?? null : null } })
  }

  const onReconnect = (old: StepFlowEdge, connection: Connection): void => {
    if (connectionProblem(connection.source, connection.target, connection.sourceHandle, old.id) !== undefined) return
    edit(current => ({
      ...current,
      edges: current.edges.map((edge) => {
        if (edge.id !== old.id) return edge
        const { sourceHandle: _previous, ...rest } = edge
        return { ...rest, source: connection.source, target: connection.target, ...(connection.sourceHandle === null ? {} : { sourceHandle: connection.sourceHandle }) }
      }),
    }))
  }

  const onEdgesChange = (changes: EdgeChange<StepFlowEdge>[]): void => {
    // Removal goes through onEdgesDelete; only selection lives outside the graph.
    const selections = changes.flatMap(change => change.type === 'select' ? [change] : [])
    if (selections.length === 0) return
    setSelectedEdges((current) => {
      const next = new Set(current)
      for (const change of selections) {
        if (change.selected) next.add(change.id)
        else next.delete(change.id)
      }
      return next
    })
  }

  // Menus.

  const menuEntries = (target: MenuTarget): MenuEntry[] => {
    switch (target.type) {
      case 'node': return [
        { id: 'duplicate', label: t('duplicateNode') },
        { id: 'delete-node', label: t('deleteNode'), danger: true },
      ]
      case 'edge': return [{ id: 'delete-edge', label: t('deleteEdge'), danger: true }]
      case 'pane':
      case 'connect': return [
        { type: 'label', id: 'add-label', text: t('addNode') },
        ...NODE_KINDS.map(kind => ({ id: `add:${kind}`, label: t(`kind.${kind}`), icon: <KindIcon kind={kind} size={16} /> })),
      ]
    }
  }

  const onMenuSelect = (id: string): void => {
    const current = menu
    setMenu(null)
    if (current === null) return
    const { target } = current
    if (id === 'duplicate' && target.type === 'node') duplicateNode(target.id)
    else if (id === 'delete-node' && target.type === 'node') deleteNode(target.id)
    else if (id === 'delete-edge' && target.type === 'edge') deleteEdge(target.id)
    else if (id.startsWith('add:')) {
      const kind = id.slice('add:'.length) as NodeKind
      const point = flowPointAt(current.x, current.y)
      if (target.type !== 'connect') addNode(kind, point)
      else {
        // Put the new node's facing handle, not its center, under the drop point.
        const x = target.fromSide === 'source' ? point.x + NODE_HALF.x : point.x - NODE_HALF.x
        addNode(kind, { x, y: point.y }, { from: target.from, fromSide: target.fromSide, handle: target.handle })
      }
    }
  }

  const openMenu = (event: ReactMouseEvent | MouseEvent, target: MenuTarget): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, target })
  }

  // Palette drag and drop.

  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes(DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const onDrop = (event: DragEvent): void => {
    const kind = event.dataTransfer.getData(DRAG_MIME)
    if (!(NODE_KINDS as readonly string[]).includes(kind)) return
    event.preventDefault()
    addNode(kind as NodeKind, flowPointAt(event.clientX, event.clientY))
  }

  // Layout, save, and run.

  const arrange = (): void => {
    if (graph === null) return
    if (hasCycle(graph)) {
      setNotice({ kind: 'error', text: t('cycle') })
      return
    }
    const positions = autoLayout(graph)
    edit(current => ({ ...current, nodes: current.nodes.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })) }))
    setNodes(current => current.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })))
    requestAnimationFrame(() => { void flow.fitView({ ...FIT_VIEW, duration: 300 }) })
  }

  const save = async (): Promise<boolean> => {
    if (graph === null) return false
    if (graph.name.trim() === '') {
      setNotice({ kind: 'error', text: t('nameRequired') })
      return false
    }
    if (hasCycle(graph)) {
      setNotice({ kind: 'error', text: t('cycle') })
      return false
    }
    try {
      setGraph(await api.save(graph))
      setDirty(false)
      setNotice({ kind: 'info', text: t('saved') })
      await refreshGraphs()
      return true
    } catch (error: unknown) {
      fail('saveFailed')(error)
      return false
    }
  }

  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  const runGraph = async (): Promise<void> => {
    if (graph === null || workspaceId === '') return
    if (dirty && !await save()) return
    try {
      const started = await api.run(graph.id, workspaceId, runInput.trim())
      setNotice({ kind: 'info', text: `${t('runStarted')}${started.sessionId}` })
      setPollUntil(Date.now() + RUN_START_GRACE_MS)
    } catch (error: unknown) {
      fail('runFailed')(error)
    }
  }

  const stopRun = (runId: string): void => {
    api.cancel(runId).then(() => { setPollUntil(Date.now() + RUN_START_GRACE_MS) }, fail('stopFailed'))
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
        setDirty(false)
        setNodes([])
        setSelectedEdges(new Set())
      }
      return refreshGraphs()
    }, fail('loadFailed'))
  }

  // Derived view.

  const runForGraph = run !== null && graph !== null && run.graphId === graph.id ? run : null

  const displayNodes = useMemo((): StepFlowNode[] => {
    const byId = new Map((graph?.nodes ?? []).map(node => [node.id, node]))
    const toolDescriptions = tools === null || tools === undefined ? undefined : new Map(tools.map(tool => [tool.name, tool.description]))
    const graphById = new Map(graphs.map(item => [item.id, item]))
    const reference = (graphId: string | undefined): { detail: string; warning: boolean } => {
      if (graphId === undefined) return { detail: t('noWorkflowPicked'), warning: true }
      const target = graphById.get(graphId)
      if (target === undefined) return { detail: t('refMissing'), warning: true }
      return { detail: target.mode === 'strict' ? `${target.name} · ${t('strictBadge')}` : target.name, warning: false }
    }
    return nodes.map((flowNode) => {
      const node = byId.get(flowNode.id)
      if (node === undefined) return flowNode
      const runNode = runForGraph?.nodes[node.id]
      let detail = node.instruction.split('\n')[0]?.slice(0, DETAIL_CHARS) ?? ''
      let detailWarning = false
      let badge: string | undefined
      let branches: { id: string; label: string }[] | undefined
      switch (node.kind) {
        case 'tool': {
          const tool = node.config.tool ?? ''
          const known = toolDescriptions?.get(tool)
          detail = tool === '' ? t('noToolPicked') : node.title === tool ? known ?? '' : tool
          detailWarning = tool === '' || (toolDescriptions !== undefined && known === undefined)
          break
        }
        case 'web-ai': {
          const provider = providers?.find(item => item.id === node.config.provider)
          detail = provider?.displayName ?? node.config.provider ?? t('anyProvider')
          detailWarning = provider !== undefined && !provider.enabled
          break
        }
        case 'condition':
          detail = node.config.decide === 'rule' ? t('decideRule') : t('decideModel')
          branches = [...(node.config.branches ?? []).map(branch => ({ id: branch.id, label: branch.label })), { id: ELSE_BRANCH, label: t('elseBranch') }]
          break
        case 'loop': {
          const target = reference(node.config.graphId)
          detail = `${target.detail} · ${t('roundLimitPrefix')}${node.config.maxIterations ?? 1}${t('roundLimitSuffix')}`
          detailWarning = target.warning
          if (runNode?.iteration !== undefined) badge = `${t('roundPrefix')}${runNode.iteration}${t('roundSuffix')}`
          break
        }
        case 'subflow': {
          const target = reference(node.config.graphId)
          detail = target.detail
          detailWarning = target.warning
          break
        }
        default:
          break
      }
      return {
        ...flowNode,
        data: {
          kind: node.kind,
          title: node.title,
          detail,
          detailWarning,
          ...(runNode === undefined ? {} : { status: runNode.status }),
          ...(badge === undefined ? {} : { badge }),
          ...(branches === undefined ? {} : { branches }),
          ...(runNode?.branch === undefined ? {} : { takenBranch: runNode.branch }),
        },
      }
    })
  }, [nodes, graph, graphs, tools, providers, runForGraph, t])

  const displayEdges = useMemo((): StepFlowEdge[] => (graph?.edges ?? []).map(edge => ({
    id: edge.id,
    type: 'step',
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    selected: selectedEdges.has(edge.id),
    markerEnd: EDGE_MARKER,
    animated: runForGraph?.nodes[edge.target]?.status === 'running',
  })), [graph, selectedEdges, runForGraph])

  const selectedFlow = nodes.filter(node => node.selected === true)
  const selectedId = selectedFlow.length === 1 ? selectedFlow[0]?.id : undefined
  const selected = selectedId === undefined ? undefined : graph?.nodes.find(node => node.id === selectedId)
  const runNodes = runForGraph === null ? [] : Object.values(runForGraph.nodes)
  const finished = runNodes.filter(node => TERMINAL.has(node.status)).length
  const liveStrictRun = runForGraph?.mode === 'strict' && runForGraph.state === 'running' ? runForGraph : null

  const actions: CanvasActions = { t, duplicateNode, deleteNode, deleteEdge }

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div className="ts-canvas">
        <div className="ts-canvas-bar">
          <Button variant="outline" icon={<IconPlusOutlineRegular size={14} />} onClick={newGraph}>{t('newGraph')}</Button>
          <Tooltip label={t('saveShortcut')} side="bottom">
            <Button variant="primary" disabled={graph === null} onClick={() => { void save() }}>{t('save')}</Button>
          </Tooltip>
          {dirty && <span className="ts-canvas-notice">{t('unsaved')}</span>}
          <Button variant="outline" disabled={graph === null || graph.nodes.length === 0} icon={<IconWorkspaceTreeOutlineRegular size={14} />} onClick={arrange}>{t('autoLayout')}</Button>
          <span className="ts-spacer" />
          {notice !== null && <span className="ts-canvas-notice" data-kind={notice.kind}>{notice.text}</span>}
          {workspaces.length === 0
            ? <span className="ts-canvas-notice">{t('noWorkspace')}</span>
            : (
              <select value={workspaceId} aria-label={t('selectWorkspace')} onChange={event => { setWorkspaceId(event.target.value) }}>
                {workspaces.map(workspace => <option key={workspace.id} value={workspace.id} title={workspace.path}>{workspace.title}</option>)}
              </select>
            )}
          <Button variant="primary" icon={<IconPlayOutlineRegular size={14} />} disabled={graph === null || workspaceId === '' || graph.nodes.length === 0 || liveStrictRun !== null} onClick={() => { void runGraph() }}>{t('run')}</Button>
          {liveStrictRun !== null && (
            <Button variant="outline" className="ts-danger" icon={<IconStopFillRegular size={14} />} onClick={() => { stopRun(liveStrictRun.runId) }}>{t('stop')}</Button>
          )}
        </div>
        <div className="ts-canvas-body">
          <aside className="ts-canvas-list">
            <h3>{t('graphs')}</h3>
            {graphs.length === 0 && <div className="ts-canvas-notice">{t('emptyGraphs')}</div>}
            {graphs.map(item => (
              <div key={item.id} className="ts-canvas-list-item" data-active={item.id === graph?.id}>
                <Button className="ts-graph" title={item.description} onClick={() => { openGraph(item.id) }}>
                  <span className="ts-graph-name">{item.name}</span>
                  {item.mode === 'strict' && <span className="ts-graph-badge">{t('strictBadge')}</span>}
                </Button>
                <Button size="sm" className={pendingDelete === item.id ? 'ts-danger' : undefined} onClick={() => { deleteGraph(item.id) }}>
                  {pendingDelete === item.id ? t('confirmDelete') : t('delete')}
                </Button>
              </div>
            ))}
          </aside>
          <div className="ts-canvas-flow" ref={wrapper} onDragOver={onDragOver} onDrop={onDrop}>
            {graph === null
              ? <div className="ts-canvas-empty">{t('noGraph')}</div>
              : (
                <ReactFlow<StepFlowNode, StepFlowEdge>
                  nodes={displayNodes}
                  edges={displayEdges}
                  nodeTypes={NODE_TYPES}
                  edgeTypes={EDGE_TYPES}
                  onNodesChange={onNodesChangeAndMove}
                  onEdgesChange={onEdgesChange}
                  onNodesDelete={onNodesDelete}
                  onEdgesDelete={onEdgesDelete}
                  onConnect={onConnect}
                  onConnectEnd={onConnectEnd}
                  isValidConnection={isValidConnection}
                  onReconnect={onReconnect}
                  onReconnectStart={(_event, edge) => { reconnecting.current = edge.id }}
                  onReconnectEnd={() => { reconnecting.current = null }}
                  onNodeContextMenu={(event, node) => {
                    setNodes(current => current.map(item => ({ ...item, selected: item.id === node.id })))
                    openMenu(event, { type: 'node', id: node.id })
                  }}
                  onEdgeContextMenu={(event, edge) => { openMenu(event, { type: 'edge', id: edge.id }) }}
                  onPaneContextMenu={(event) => { openMenu(event, { type: 'pane' }) }}
                  deleteKeyCode={['Backspace', 'Delete']}
                  connectionLineType={ConnectionLineType.Bezier}
                  connectionRadius={28}
                  reconnectRadius={14}
                  snapToGrid
                  snapGrid={[16, 16]}
                  fitView
                  fitViewOptions={FIT_VIEW}
                >
                  <Background gap={16} />
                  <Controls showInteractive={false} fitViewOptions={FIT_VIEW} />
                  <MiniMap<StepFlowNode> pannable zoomable nodeColor={node => KIND_COLOR[node.data.kind]} />
                  <Panel position="top-left" className="ts-palette">
                    <div className="ts-palette-title">{t('palette')}</div>
                    {NODE_KINDS.map(kind => (
                      <button
                        key={kind}
                        type="button"
                        draggable
                        className="ts-palette-item"
                        style={{ '--ts-kind': KIND_COLOR[kind] } as CSSProperties}
                        title={t('paletteHint')}
                        onClick={() => { addNodeAtCenter(kind) }}
                        onDragStart={(event) => {
                          event.dataTransfer.setData(DRAG_MIME, kind)
                          event.dataTransfer.effectAllowed = 'move'
                        }}
                      >
                        <KindIcon kind={kind} />{t(`kind.${kind}`)}
                      </button>
                    ))}
                  </Panel>
                  {graph.nodes.length === 0 && (
                    <Panel position="top-center" className="ts-canvas-hint">{t('emptyCanvas')}</Panel>
                  )}
                </ReactFlow>
              )}
          </div>
          {graph !== null && (
            <Inspector
              graph={graph}
              node={selected}
              selectionCount={selectedFlow.length}
              graphs={graphs}
              tools={tools}
              providers={providers}
              run={runForGraph}
              runInput={runInput}
              t={t}
              onGraph={(patch) => { edit(current => ({ ...current, ...patch })) }}
              onRunInput={setRunInput}
              onNode={updateNode}
              onPickTool={pickTool}
              onPickProvider={pickProvider}
              onDelete={deleteNode}
            />
          )}
        </div>
        {runNodes.length > 0 && (
          <div className="ts-canvas-progress">
            {runForGraph?.mode === 'strict' && runForGraph.state !== undefined ? `${t(`state.${runForGraph.state}`)} · ` : ''}
            {t('progress')}: {finished}/{runNodes.length}
          </div>
        )}
        <Menu
          open={menu !== null}
          portal
          autoFocus
          anchor={<span className="ts-menu-anchor" />}
          getAnchorRect={() => menu === null ? null : new DOMRect(menu.x, menu.y, 0, 0)}
          items={menu === null ? [] : menuEntries(menu.target)}
          onSelect={onMenuSelect}
          onClose={() => { setMenu(null) }}
        />
      </div>
    </CanvasActionsContext.Provider>
  )
}
