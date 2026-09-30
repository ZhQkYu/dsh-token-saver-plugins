/**
 * Per-node run details: status, attempts, duration, tokens, inputs, outputs,
 * the rendered LLM prompt, logs, warnings, and errors, in collapsible
 * sections. Shown in the side panel for the selected node.
 *
 * @module @dsh-plugins/flow-ui/client/run/NodeRunDetail
 */

import { useState, type ReactNode } from 'react'
import type { FlowDocument, JsonValue, RunView, RunViewNode } from '@dsh-plugins/flow/spec'
import type { LocaleKey, Translate } from '../locales.ts'
import { JsonTree } from './JsonTree.tsx'

function isEmptyValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).length === 0
  return false
}

/** A collapsible labeled section; hidden when the value is empty. Text renders as-is, structured values as a tree. */
function Section({ label, value, t, open = true }: { label: string; value: JsonValue | undefined; t: Translate; open?: boolean }): ReactNode {
  if (isEmptyValue(value)) return null
  return (
    <details className="dsflow-trace__section" open={open}>
      <summary className="dsflow-trace__summary">{label}</summary>
      {typeof value === 'string'
        ? <div className="dsflow-json__block dsflow-trace__text">{value}</div>
        : <JsonTree value={value as JsonValue} copyLabel={t('trace.copy')} />}
    </details>
  )
}

/**
 * The details of one node execution.
 * @param props - the node's folded run state and the translator.
 * @returns the detail body.
 */
export function NodeRunDetail({ node, t }: { node: RunViewNode; t: Translate }): ReactNode {
  return (
    <div className="dsflow-trace__detail">
      {node.error !== undefined && <div className="dsflow-error" title={node.error.code}>{node.error.code}: {node.error.message}</div>}
      <Section label={t('trace.inputs')} value={node.inputs} t={t} />
      <Section label={t('trace.outputs')} value={node.outputs} t={t} />
      {node.rendered?.system !== undefined && node.rendered.system !== '' && <Section label={t('trace.system')} value={node.rendered.system} t={t} open={false} />}
      {node.rendered?.prompt !== undefined && <Section label={t('trace.prompt')} value={node.rendered.prompt} t={t} open={false} />}
      {node.logs !== undefined && node.logs.length > 0 && <Section label={t('trace.logs')} value={node.logs.join('\n')} t={t} />}
      {node.warnings !== undefined && node.warnings.length > 0 && <Section label={t('trace.warnings')} value={node.warnings.join('\n')} t={t} />}
    </div>
  )
}

/** One-line metrics: status, attempts, duration, tokens. */
function Meta({ node, t }: { node: RunViewNode; t: Translate }): ReactNode {
  const tokens = node.usage === undefined ? 0 : node.usage.inputTokens + node.usage.outputTokens
  return (
    <span className="dsflow-trace__meta">
      <span className="dsflow-run__status" data-status={node.status}>{t(`status.${node.status}` as LocaleKey)}</span>
      {(node.attempts ?? 1) > 1 && <span className="dsflow-muted">×{node.attempts}</span>}
      {node.durationMs !== undefined && <span className="dsflow-muted">{node.durationMs} ms</span>}
      {tokens > 0 && <span className="dsflow-muted">{tokens} {t('tokens')}</span>}
    </span>
  )
}

/** The iteration path of a node inside loops/batches, e.g. `Loop #2`; `titleOf` maps container ids to titles. */
function pathText(node: RunViewNode, titleOf: (id: string) => string = id => id): string {
  return node.path.map(step => `${titleOf(step.node)}${step.index === undefined ? '' : ` #${step.index + 1}`}`).join(' › ')
}

/**
 * The side panel's run result for the selected node. A node that ran several
 * times (inside a loop or batch) shows one chip per execution; the chosen
 * execution's details are shown below, defaulting to the latest.
 * @param props - the node id, the run view, the flow document for container titles, and the translator.
 * @returns the run result, or a not-run notice.
 */
export function NodeRunSection({ nodeId, view, doc, t }: { nodeId: string; view: RunView | undefined; doc: FlowDocument; t: Translate }): ReactNode {
  const runs = view?.nodes.filter(node => node.nodeId === nodeId && node.status !== 'pending') ?? []
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  if (runs.length === 0) return <div className="dsflow-muted">{t('trace.notRun')}</div>
  const titleOf = (id: string): string => doc.nodes.find(candidate => candidate.id === id)?.title ?? id
  const current = runs.find(node => node.execKey === chosen) ?? runs[runs.length - 1] as RunViewNode
  return (
    <div className="dsflow-trace">
      {runs.length > 1 && (
        <div className="dsflow-trace__runs">
          {runs.map((node, index) => (
            <button
              key={node.execKey}
              type="button"
              className="dsflow-trace__run"
              data-status={node.status}
              aria-pressed={node.execKey === current.execKey}
              title={pathText(node, titleOf)}
              onClick={() => { setChosen(node.execKey) }}
            >
              {index + 1}
            </button>
          ))}
        </div>
      )}
      <div className="dsflow-trace__item" data-status={current.status}>
        <div className="dsflow-trace__head dsflow-trace__head--static">
          {pathText(current, titleOf) !== '' && <span className="dsflow-muted">{pathText(current, titleOf)}</span>}
          <Meta node={current} t={t} />
        </div>
        <NodeRunDetail node={current} t={t} />
      </div>
    </div>
  )
}
