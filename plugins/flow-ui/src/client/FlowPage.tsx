/**
 * The flow main panel page: the flow list, or the editor for the opened flow.
 *
 * @module @dsh-plugins/flow-ui/client/FlowPage
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import type { FlowDocument } from '@dsh-plugins/flow/spec'
import { api, errorText, type FlowMeta, type FlowSummary } from './api.ts'
import { FlowList } from './FlowList.tsx'
import { Editor } from './editor/Editor.tsx'
import type { Translate } from './locales.ts'

/** Props the main slot passes. */
export interface FlowPageProps {
  t: Translate
}

/** The flow main panel page. */
export function FlowPage({ t }: FlowPageProps): ReactNode {
  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [opened, setOpened] = useState<{ flow: FlowDocument; meta: FlowMeta | null } | undefined>(undefined)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setFlows(await api.flows())
      setError('')
    } catch (caught: unknown) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const open = useCallback(async (id: string): Promise<void> => {
    try {
      setOpened(await api.get(id))
      setError('')
    } catch (caught: unknown) {
      setError(errorText(caught))
    }
  }, [])

  const run = (action: () => Promise<unknown>): void => {
    action().then(() => reload()).catch((caught: unknown) => { setError(errorText(caught)) })
  }

  if (opened !== undefined) {
    return (
      <ReactFlowProvider>
        <Editor key={opened.flow.id} flow={opened.flow} meta={opened.meta} t={t} onBack={() => { setOpened(undefined); void reload() }} />
      </ReactFlowProvider>
    )
  }
  return (
    <FlowList
      t={t}
      flows={flows}
      loading={loading}
      error={error}
      onCreate={(name) => { api.create(name, '').then(flow => open(flow.id)).catch((caught: unknown) => { setError(errorText(caught)) }) }}
      onOpen={(id) => { void open(id) }}
      onDuplicate={(id) => { run(() => api.duplicate(id)) }}
      onDelete={(id) => { run(() => api.remove(id)) }}
    />
  )
}
