import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CanvasStore } from '../src/workflow-canvas/store.ts'
import type { CanvasGraph, CanvasRun } from '../src/protocol.ts'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ts-canvas-'))
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
})
