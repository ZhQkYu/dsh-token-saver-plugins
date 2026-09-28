/**
 * The flow main panel page. Shows the flow list; opening a flow loads the
 * canvas editor. Saving updates the list.
 *
 * @module @dsh-plugins/flow-ui/client/FlowPage
 */

import { useCallback, useEffect, useState } from 'react'
import type { FlowDocument } from '@dsh-plugins/flow/spec'
import { api, errorText, type FlowSummary } from './api.ts'
import { FlowList } from './FlowList.tsx'
import { Editor } from './editor/Editor.tsx'

/** Props for {@link FlowPage}. */
export interface FlowPageProps {
  t: (key: string) => string
}

/** The flow main panel page. */
export function FlowPage({ t }: FlowPageProps): JSX.Element {
  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [flow, setFlow] = useState<FlowDocument | undefined>(undefined)
  const [error, setError] = useState<string>('')
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setFlows(await api.flows())
    } catch (caught: unknown) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const open = useCallback(async (id: string): Promise<void> => {
    setError('')
    setLoading(true)
    try {
      const { flow } = await api.get(id)
      setFlow(flow)
      setOpenId(id)
    } catch (caught: unknown) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  const close = useCallback((): void => {
    setFlow(undefined)
    setOpenId(undefined)
    void reload()
  }, [reload])

  const onSaved = useCallback((): void => {
    void reload()
  }, [reload])

  const create = useCallback(async (name: string): Promise<void> => {
    setError('')
    try {
      const created = await api.create(name, '')
      await open(created.id)
    } catch (caught: unknown) {
      setError(errorText(caught))
    }
  }, [open])

  if (openId !== undefined && flow !== undefined) {
    return <Editor flow={flow} onSaved={onSaved} t={t} />
  }

  return (
    <FlowList
      t={t}
      flows={flows}
      loading={loading}
      error={error}
      onCreate={create}
      onOpen={id => { void open(id) }}
    />
  )
}
