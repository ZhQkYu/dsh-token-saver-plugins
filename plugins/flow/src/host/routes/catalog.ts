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
import { ROUTES } from '../../spec/types.ts'
import type { ValidateLimits } from '../../spec/validate.ts'
import { json, errorResponse } from '../http.ts'
import type { FlowStore } from '../store/flow-store.ts'
import type { ToolCatalog } from '../known-tools.ts'
import { FLOW_WORKFLOW_TOOL } from '../../spec/guided.ts'

/** Register the catalog routes. */
export function registerCatalogRoutes(ctx: Context, store: FlowStore, toolPrefix: string, limits: ValidateLimits, toolCatalog: ToolCatalog): void {
  ctx.connection.fetch.register({
    path: ROUTES.catalogLimits,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({ limits })),
  })

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
        await toolCatalog.refresh()
        const visible = toolCatalog.schemas().filter(tool => tool.name !== 'run_code' && tool.name !== FLOW_WORKFLOW_TOOL && tool.name !== 'flow_design' && !tool.name.startsWith(toolPrefix))
        return json({ tools: visible.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, output: toolCatalog.outputSchema(tool.name) ?? null })) })
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
        const empty = { inputs: [], outputs: [], subflows: [] }
        const published = summary.publishedVersion === undefined ? undefined : store.lookup(summary.id, summary.publishedVersion)
        return {
          id: summary.id,
          name: summary.name,
          kind: summary.kind,
          ...(summary.publishedVersion === undefined ? {} : { published: { version: summary.publishedVersion, ...(published ?? empty) } }),
          draft: store.lookup(summary.id, 'draft') ?? empty,
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
