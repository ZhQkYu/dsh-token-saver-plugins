/**
 * The `@dsh-plugins/flow/design` plugin: mounts `flow_design` and the bundled
 * flow-authoring skills in the agent preset that lists it, so only a
 * workflow-designer agent gets them. It reads the stores and engine the main
 * flow plugin publishes as `flowDesign`.
 *
 * @module @dsh-plugins/flow/host/design-plugin
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { registerDesignTool, type DesignToolDeps } from './design-tool.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Stores, engine, and catalogs of the flow plugin, for the design tool. */
    flowDesign: DesignToolDeps
  }
}

export const name = 'dsh-flow-design'
export const inject = ['tools', 'skills', 'flowDesign']

/** The bundled skills, one directory each under `skills/`. */
export const FLOW_SKILLS = ['flow-authoring', 'flow-debugging'] as const

const PROVIDER = 'dsh-flow'

function splitSkill(raw: string, path: string): { description: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const description = match?.[1]?.split(/\r?\n/u).find(line => line.startsWith('description:'))?.slice('description:'.length).trim()
  if (match === null || description === undefined || description === '') throw new Error(`dsh-flow-design: ${path} needs frontmatter with a description`)
  return { description, content: raw.slice(match[0].length).trim() }
}

/**
 * Register `flow_design` and the flow skills in this plugin's scope.
 * @param ctx - the preset-scoped context.
 */
export function apply(ctx: Context): void {
  registerDesignTool(ctx, ctx.flowDesign)
  const root = fileURLToPath(new URL('../../skills/', import.meta.url))
  const candidates: SkillCandidate[] = FLOW_SKILLS.map((skill) => {
    const directory = join(root, skill)
    const path = join(directory, 'SKILL.md')
    return {
      name: skill,
      description: splitSkill(readFileSync(path, 'utf8'), path).description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory },
      locator: path,
    }
  })
  const provider: SkillProvider = {
    name: PROVIDER,
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: splitSkill(raw, locator as string).content }
    },
  }
  ctx.skills.registerProvider(() => provider)
}
