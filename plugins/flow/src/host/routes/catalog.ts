/**
 * Catalog routes: models, tools, flows, and workspaces, for the editor's
 * pickers. All read-only; inputs are validated and bounded.
 *
 * @module @dsh-plugins/flow/host/routes/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type { FlowDocument, VarField } from '../../spec/types.ts'
import { ROUTES } from '../../spec/types.ts'
import { json, errorResponse } from '../http.ts'
import type { FlowStore } from '../store/flow-store.ts'

/** Register the catalog routes. */
export function registerCatalogRoutes(ctx: Context, store: FlowStore): void {
  ctx.connection.fetch.register({
    path: ROUTES.catalogModels,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return json({ ...await buildModelCatalog(ctx) })
      } catch (error: unknown) {
        return errorResponse(error, 500)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.catalogTools,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        const tools = ctx.tools.schemas()
        const visible = tools.filter(tool => tool.name !== 'run_code' && !tool.name.startsWith('flow_'))
        return json({ tools: visible.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) })
      } catch (error: unknown) {
        return errorResponse(error, 500)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.catalogFlows,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => {
      const flows = store.list().map(summary => {
        const draft = store.get(summary.id)
        const published = summary.publishedVersion === undefined ? undefined : store.version(summary.id, summary.publishedVersion)
        const io = (doc: ReturnType<FlowStore['get']> | undefined) => doc === undefined
          ? { inputs: [], outputs: [] }
          : { inputs: startInputs(doc), outputs: endOutputs(doc) }
        return {
          id: summary.id,
          name: summary.name,
          ...(summary.publishedVersion === undefined ? {} : { published: { version: summary.publishedVersion, ...io(published) } }),
          draft: io(draft),
        }
      })
      return Promise.resolve(json({ flows }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.catalogWorkspaces,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({
      workspaces: ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path })),
    })),
  })
}

/** Build a light model catalog from the live LLM registry. */
async function buildModelCatalog(ctx: Context): Promise<{ default: { provider: string; model: string }; groups: { id: string; name: string; models: { id: string; name: string }[] }[]; failures: { id: string; name: string; message: string }[] }> {
  const defaultSelection = ctx.agentDefaultModel.currentSelection()
  const providers = ctx.llm.listProviders()
  const groups: { id: string; name: string; models: { id: string; name: string }[] }[] = []
  const failures: { id: string; name: string; message: string }[] = []
  for (const provider of providers) {
    try {
      const models = await ctx.llm.listModels(provider.id)
      if (models.length === 0) continue
      groups.push({
        id: provider.id,
        name: provider.name,
        models: models.map(model => ({ id: model.id, name: model.name })),
      })
    } catch (error: unknown) {
      failures.push({ id: provider.id, name: provider.name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { default: { provider: defaultSelection.provider, model: defaultSelection.model }, groups, failures }
}

function startInputs(doc: FlowDocument): VarField[] {
  const start = doc.nodes.find(node => node.type === 'start')
  return start?.type === 'start' ? start.data.fields.map(f => ({ name: f.name, schema: f.schema, required: f.required })) : []
}

function endOutputs(doc: FlowDocument): VarField[] {
  const end = doc.nodes.find(node => node.type === 'end')
  if (end?.type === 'end') {
    if (end.data.mode === 'text') return [{ name: 'text', schema: { type: 'string' } }]
    return end.data.inputs.map(binding => ({ name: binding.name, schema: binding.schema }))
  }
  return []
}
