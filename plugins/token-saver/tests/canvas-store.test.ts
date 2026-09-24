import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CanvasStore } from '../src/workflow-canvas/store.ts'
import { graphSchema, runSchema } from '../src/workflow-canvas/schema.ts'
import type { CanvasGraph, CanvasRun } from '../src/protocol.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-canvas-'))
  dirs.push(dir)
  return dir
}

const graphValidator = { parse: (value: unknown) => value as CanvasGraph }
const runValidator = { parse: (value: unknown) => value as CanvasRun }

function store(dir: string): CanvasStore {
  return new CanvasStore({ storageDir: dir, maxGraphBytes: 262144, keepRuns: 3 }, graphValidator, runValidator)
}

function graph(id: string): CanvasGraph {
  return { version: 1, id, name: id, description: '', nodes: [], edges: [], updatedAt: Date.now() }
}

function run(runId: string, graphId: string, startedAt: number): CanvasRun {
  return { runId, graphId, startedAt, updatedAt: startedAt, nodes: {} }
}

describe('CanvasStore', () => {
  it('saves and reads a graph', async () => {
    const dir = tmpDir()
    const s = store(dir)
    await s.save(graph('g1'))
    expect(s.get('g1')?.id).toBe('g1')
  })

  it('deletes a graph', async () => {
    const dir = tmpDir()
    const s = store(dir)
    await s.save(graph('g1'))
    s.delete('g1')
    expect(s.get('g1')).toBeUndefined()
  })

  it('prunes runs past keepRuns', async () => {
    const dir = tmpDir()
    const s = store(dir)
    for (let i = 0; i < 5; i++) {
      await s.saveRun(run(`r${i}`, 'g1', i))
    }
    const runs = s.runsFor('g1')
    expect(runs.length).toBe(3)
  })

  it('rejects an invalid id', () => {
    const dir = tmpDir()
    const s = store(dir)
    expect(() => s.save(graph('bad id'))).toThrow(/invalid id/)
  })

  it('applies concurrent run updates without losing any', async () => {
    const s = store(tmpDir())
    await s.saveRun({ ...run('r1', 'g1', 1), nodes: { a: { status: 'pending', updatedAt: 1 }, b: { status: 'pending', updatedAt: 1 } } })
    await Promise.all(['a', 'b'].map(nodeId => s.updateRun('r1', current => ({
      ...current,
      nodes: { ...current.nodes, [nodeId]: { status: 'done', updatedAt: 2 } },
    }))))
    expect(Object.values(s.getRun('r1')!.nodes).map(node => node.status)).toEqual(['done', 'done'])
  })

  it('does not write when an update aborts', async () => {
    const s = store(tmpDir())
    await s.saveRun(run('r1', 'g1', 1))
    await expect(s.updateRun('r1', () => { throw new Error('unknown node') })).rejects.toThrow(/unknown node/)
    await expect(s.updateRun('missing', current => current)).rejects.toThrow(/unknown run/)
    expect(s.getRun('r1')?.updatedAt).toBe(1)
  })

  it('treats a stored graph that violates the schema as absent', async () => {
    const dir = tmpDir()
    const s = new CanvasStore({ storageDir: dir, maxGraphBytes: 262144, keepRuns: 3 }, graphSchema, runSchema)
    await s.save(graph('g1'))
    expect(s.get('g1')?.id).toBe('g1')
    const bad = { ...graph('g2'), nodes: [{ id: 'n1', kind: 'unknown', title: '', instruction: '', config: {}, position: { x: 0, y: 0 } }] }
    fs.writeFileSync(path.join(dir, 'graphs', 'g2.json'), JSON.stringify(bad))
    expect(s.get('g2')).toBeUndefined()
    expect(s.list().map(item => item.id)).toEqual(['g1'])
  })
})
