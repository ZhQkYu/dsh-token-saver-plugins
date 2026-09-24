/**
 * Right-hand inspector. With nothing selected it edits the workflow (name,
 * description, execution mode) and shows the run input and the last strict
 * run's result; with one node selected it edits that node, including the
 * kind-specific editors: tool and provider pickers, condition branches and
 * rules, and loop or sub-workflow references.
 */

import type { CSSProperties, ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, IconTrashOutlineRegular, SegmentedControl, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  NODE_KINDS, RULE_OPS,
  type CanvasBranch, type CanvasGraph, type CanvasNode, type CanvasRun, type CatalogProvider, type CatalogTool, type DecideMode, type GraphMode,
  type NodeKind, type RuleMatch,
} from '@dsh-plugins/token-saver/protocol'
import type { GraphSummary } from './api.ts'
import { CONTROL_KINDS, KIND_COLOR, KindIcon } from './kinds.tsx'
import type { LocaleKey } from './locales.ts'
import { ToolPicker } from './ToolPicker.tsx'

/** Node fields the inspector edits. */
export type NodePatch = Partial<Pick<CanvasNode, 'kind' | 'title' | 'instruction' | 'config'>>

/** Branches a condition node may hold; the schema enforces the same ceiling. */
const MAX_BRANCHES = 8
const MAX_ROUNDS = 100

type T = (key: LocaleKey) => string

function newBranchId(): string {
  return `b-${crypto.randomUUID().slice(0, 8)}`
}

function RuleEditor(props: { rule: RuleMatch; t: T; onChange: (rule: RuleMatch) => void; label: string }): ReactNode {
  const { rule, t } = props
  return (
    <div className="ts-rule">
      <select aria-label={props.label} value={rule.op} onChange={event => { props.onChange({ ...rule, op: event.target.value as RuleMatch['op'] }) }}>
        {RULE_OPS.map(op => <option key={op} value={op}>{t(`rule.${op}`)}</option>)}
      </select>
      <input aria-label={t('ruleValue')} placeholder={t('ruleValue')} value={rule.value} onChange={event => { props.onChange({ ...rule, value: event.target.value }) }} />
    </div>
  )
}

function DecideSelect(props: { value: DecideMode; t: T; onChange: (value: DecideMode) => void }): ReactNode {
  const { t } = props
  return (
    <>
      <label htmlFor="ts-node-decide">{t('decide')}</label>
      <select id="ts-node-decide" value={props.value} onChange={event => { props.onChange(event.target.value as DecideMode) }}>
        <option value="model">{t('decideModel')}</option>
        <option value="rule">{t('decideRule')}</option>
      </select>
    </>
  )
}

function WorkflowSelect(props: { graphId: string | undefined; selfId: string; graphs: readonly GraphSummary[]; t: T; onChange: (graphId: string) => void }): ReactNode {
  const { t } = props
  const others = props.graphs.filter(graph => graph.id !== props.selfId)
  const missing = props.graphId !== undefined && !others.some(graph => graph.id === props.graphId)
  return (
    <>
      <label htmlFor="ts-node-workflow">{t('workflowRef')}</label>
      <select id="ts-node-workflow" value={props.graphId ?? ''} onChange={event => { props.onChange(event.target.value) }}>
        <option value="" disabled>{t('pickWorkflow')}</option>
        {missing && <option value={props.graphId}>{t('refMissing')}</option>}
        {others.map(graph => (
          <option key={graph.id} value={graph.id}>{graph.mode === 'strict' ? `${graph.name} · ${t('strictBadge')}` : graph.name}</option>
        ))}
      </select>
      {others.length === 0 && <div className="ts-field-hint" data-warning="true">{t('noOtherWorkflows')}</div>}
      {missing && <div className="ts-field-hint" data-warning="true">{t('refMissing')}</div>}
    </>
  )
}

function BranchEditor(props: { node: CanvasNode; t: T; onConfig: (config: CanvasNode['config']) => void }): ReactNode {
  const { node, t } = props
  const branches = node.config.branches ?? []
  const byRule = node.config.decide === 'rule'
  const setBranches = (next: CanvasBranch[]): void => { props.onConfig({ ...node.config, branches: next }) }
  const update = (id: string, patch: Partial<CanvasBranch>): void => {
    setBranches(branches.map(branch => branch.id === id ? { ...branch, ...patch } : branch))
  }
  return (
    <>
      <label>{t('branches')}</label>
      {branches.map(branch => (
        <div key={branch.id} className="ts-branch-edit">
          <div className="ts-branch-edit-row">
            <input aria-label={t('branchLabel')} placeholder={t('branchLabel')} value={branch.label} onChange={event => { update(branch.id, { label: event.target.value }) }} />
            <Tooltip label={t('removeBranch')} side="top">
              <Button
                size="sm"
                aria-label={t('removeBranch')}
                disabled={branches.length <= 1}
                icon={<IconTrashOutlineRegular size={14} />}
                onClick={() => { setBranches(branches.filter(item => item.id !== branch.id)) }}
              />
            </Tooltip>
          </div>
          {byRule && (
            <RuleEditor
              label={t('decideRule')}
              rule={branch.rule ?? { op: 'contains', value: '' }}
              t={t}
              onChange={(rule) => { update(branch.id, { rule }) }}
            />
          )}
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={branches.length >= MAX_BRANCHES}
        icon={<IconPlusOutlineRegular size={14} />}
        onClick={() => {
          const label = `${t('branchLabel')} ${branches.length + 1}`
          setBranches([...branches, { id: newBranchId(), label, ...(byRule ? { rule: { op: 'contains' as const, value: label } } : {}) }])
        }}
      >
        {t('addBranch')}
      </Button>
      <div className="ts-field-hint">{t('elseHint')}</div>
    </>
  )
}

function GraphPanel(props: {
  graph: CanvasGraph
  selectionCount: number
  run: CanvasRun | null
  runInput: string
  t: T
  onGraph: (patch: Pick<Partial<CanvasGraph>, 'name' | 'description' | 'mode'>) => void
  onRunInput: (input: string) => void
}): ReactNode {
  const { graph, run, t } = props
  const mode: GraphMode = graph.mode ?? 'guided'
  return (
    <aside className="ts-canvas-inspector">
      {props.selectionCount > 1 && <div className="ts-field-hint">{t('multiSelected')}</div>}
      <label htmlFor="ts-graph-name">{t('graphName')}</label>
      <input id="ts-graph-name" value={graph.name} onChange={event => { props.onGraph({ name: event.target.value }) }} />
      <label htmlFor="ts-graph-description">{t('graphDescription')}</label>
      <textarea id="ts-graph-description" className="ts-short" value={graph.description} onChange={event => { props.onGraph({ description: event.target.value }) }} />
      <label>{t('modeLabel')}</label>
      <SegmentedControl<GraphMode>
        id="ts-graph-mode"
        label={t('modeLabel')}
        value={mode}
        options={[{ value: 'guided', label: t('modeGuided') }, { value: 'strict', label: t('modeStrict') }]}
        onChange={(next) => { props.onGraph({ mode: next }) }}
      />
      <div className="ts-field-hint">{mode === 'strict' ? t('modeStrictHint') : t('modeGuidedHint')}</div>
      <label htmlFor="ts-run-input">{t('runInput')}</label>
      <textarea id="ts-run-input" className="ts-short" value={props.runInput} placeholder={t('runInputPlaceholder')} onChange={event => { props.onRunInput(event.target.value) }} />
      {run?.mode === 'strict' && run.state !== undefined && (
        <>
          <label>{t('runOutput')} · {t(`state.${run.state}`)}</label>
          {run.output !== undefined && run.output !== '' && <div className="ts-canvas-summary">{run.output}</div>}
          {run.error !== undefined && <div className="ts-canvas-summary" data-warning="true">{t('runError')}: {run.error}</div>}
        </>
      )}
      <div className="ts-field-hint">{t('canvasHelp')}</div>
    </aside>
  )
}

/**
 * Render the inspector.
 * @param props.graph - the open workflow.
 * @param props.node - the single selected node, if any.
 * @param props.selectionCount - how many nodes are selected.
 * @param props.graphs - saved workflows, for loop and sub-workflow references.
 * @param props.tools - tool catalog (`null` loading, `undefined` unavailable).
 * @param props.providers - web AI providers (`null` loading, `undefined` unavailable).
 * @param props.run - the open workflow's latest run.
 * @param props.runInput - the text the next run starts from.
 * @returns the inspector element.
 */
export function Inspector(props: {
  graph: CanvasGraph
  node: CanvasNode | undefined
  selectionCount: number
  graphs: readonly GraphSummary[]
  tools: readonly CatalogTool[] | null | undefined
  providers: readonly CatalogProvider[] | null | undefined
  run: CanvasRun | null
  runInput: string
  t: T
  onGraph: (patch: Pick<Partial<CanvasGraph>, 'name' | 'description' | 'mode'>) => void
  onRunInput: (input: string) => void
  onNode: (id: string, patch: NodePatch) => void
  onPickTool: (node: CanvasNode, tool: string) => void
  onPickProvider: (node: CanvasNode, provider: string) => void
  onDelete: (id: string) => void
}): ReactNode {
  const { graph, node, t } = props
  if (node === undefined) {
    return (
      <GraphPanel
        graph={graph}
        selectionCount={props.selectionCount}
        run={props.run}
        runInput={props.runInput}
        t={t}
        onGraph={props.onGraph}
        onRunInput={props.onRunInput}
      />
    )
  }
  const { config } = node
  const decide: DecideMode = config.decide ?? 'model'
  const onConfig = (next: CanvasNode['config']): void => { props.onNode(node.id, { config: next }) }
  const summary = props.run?.nodes[node.id]?.summary
  const instructionLabel: LocaleKey = node.kind === 'condition' ? 'question' : node.kind === 'loop' ? 'stopCondition' : 'instruction'
  const showInstruction = node.kind !== 'subflow' && !(node.kind === 'loop' && decide === 'rule')
  return (
    <aside className="ts-canvas-inspector">
      <label>{t('nodeKind')}</label>
      <div className="ts-kind-grid" role="radiogroup" aria-label={t('nodeKind')}>
        {NODE_KINDS.map((kind: NodeKind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={node.kind === kind}
            className="ts-kind-chip"
            style={{ '--ts-kind': KIND_COLOR[kind] } as CSSProperties}
            onClick={() => { props.onNode(node.id, { kind }) }}
          >
            <KindIcon kind={kind} />{t(`kind.${kind}`)}
          </button>
        ))}
      </div>
      {CONTROL_KINDS.has(node.kind) && graph.mode !== 'strict' && <div className="ts-field-hint" data-warning="true">{t('guidedControlHint')}</div>}
      <label htmlFor="ts-node-title">{t('nodeTitle')}</label>
      <input id="ts-node-title" value={node.title} onChange={event => { props.onNode(node.id, { title: event.target.value }) }} />
      {node.kind === 'tool' && (
        <>
          <label htmlFor="ts-node-tool">{t('tool')}</label>
          <ToolPicker tools={props.tools} value={config.tool ?? ''} onPick={name => { props.onPickTool(node, name) }} t={t} />
        </>
      )}
      {node.kind === 'web-ai' && (
        <>
          <label htmlFor="ts-node-provider">{t('provider')}</label>
          {props.providers === undefined
            ? <input id="ts-node-provider" value={config.provider ?? ''} placeholder={t('providerPlaceholder')} onChange={event => { props.onPickProvider(node, event.target.value) }} />
            : (
              <select id="ts-node-provider" value={config.provider ?? ''} onChange={event => { props.onPickProvider(node, event.target.value) }}>
                <option value="">{t('anyProvider')}</option>
                {(props.providers ?? []).map(provider => (
                  <option key={provider.id} value={provider.id}>
                    {provider.enabled ? provider.displayName : `${provider.displayName}${t('providerDisabled')}`}
                  </option>
                ))}
              </select>
            )}
          {(() => {
            const chosen = props.providers?.find(provider => provider.id === config.provider)
            if (chosen === undefined) return <div className="ts-field-hint">{t('anyProviderHint')}</div>
            return <div className="ts-field-hint" data-warning={!chosen.enabled}>{chosen.enabled ? chosen.strengths : t('providerDisabledHint')}</div>
          })()}
        </>
      )}
      {node.kind === 'condition' && (
        <>
          <DecideSelect
            value={decide}
            t={t}
            onChange={(next) => {
              // Rule mode needs a rule on every branch; seed each from its label.
              const branches = next === 'rule'
                ? (config.branches ?? []).map(branch => ({ ...branch, rule: branch.rule ?? { op: 'contains' as const, value: branch.label } }))
                : config.branches
              onConfig({ ...config, decide: next, branches })
            }}
          />
          <div className="ts-field-hint">{decide === 'model' ? t('decideModelHint') : t('decideRuleHint')}</div>
          <BranchEditor node={node} t={t} onConfig={onConfig} />
        </>
      )}
      {(node.kind === 'loop' || node.kind === 'subflow') && (
        <WorkflowSelect graphId={config.graphId} selfId={graph.id} graphs={props.graphs} t={t} onChange={(graphId) => { onConfig({ ...config, graphId }) }} />
      )}
      {node.kind === 'subflow' && <div className="ts-field-hint">{t('subflowHint')}</div>}
      {node.kind === 'loop' && (
        <>
          <label htmlFor="ts-node-rounds">{t('maxIterations')}</label>
          <input
            id="ts-node-rounds"
            type="number"
            min={1}
            max={MAX_ROUNDS}
            value={config.maxIterations ?? 1}
            onChange={(event) => {
              const rounds = Math.round(Number(event.target.value))
              if (Number.isFinite(rounds)) onConfig({ ...config, maxIterations: Math.min(MAX_ROUNDS, Math.max(1, rounds)) })
            }}
          />
          <DecideSelect
            value={decide}
            t={t}
            onChange={(next) => { onConfig({ ...config, decide: next, ...(next === 'rule' && config.exitRule === undefined ? { exitRule: { op: 'contains' as const, value: '' } } : {}) }) }}
          />
          {decide === 'rule' && (
            <>
              <label>{t('exitRule')}</label>
              <RuleEditor label={t('exitRule')} rule={config.exitRule ?? { op: 'contains', value: '' }} t={t} onChange={(exitRule) => { onConfig({ ...config, exitRule }) }} />
            </>
          )}
          <div className="ts-field-hint">{t('loopHint')}</div>
        </>
      )}
      {showInstruction && (
        <>
          <label htmlFor="ts-node-instruction">{t(instructionLabel)}</label>
          <textarea
            id="ts-node-instruction"
            value={node.instruction}
            placeholder={t(`placeholder.${node.kind}`)}
            onChange={event => { props.onNode(node.id, { instruction: event.target.value }) }}
          />
        </>
      )}
      {summary !== undefined && (
        <>
          <label>{t('result')}</label>
          <div className="ts-canvas-summary">{summary}</div>
        </>
      )}
      <Button variant="outline" className="ts-danger" icon={<IconTrashOutlineRegular size={14} />} onClick={() => { props.onDelete(node.id) }}>{t('deleteNode')}</Button>
    </aside>
  )
}
