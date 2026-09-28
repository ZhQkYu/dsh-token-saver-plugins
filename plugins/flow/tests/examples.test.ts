import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { flowDocumentSchema } from '../src/host/schemas.ts'
import { validateFlow } from '../src/spec/validate.ts'

const dir = path.join(import.meta.dirname, '..', 'examples')

describe('example flows', () => {
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.json'))

  it('ships the four documented examples', () => {
    expect(files.sort()).toEqual(['http-check.json', 'read-summarize-confirm.json', 'review-loop.json', 'topic-outline.json'])
  })

  for (const file of files) {
    it(`${file} is an importable, valid flow`, () => {
      const doc = flowDocumentSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))
      const errors = validateFlow(doc, () => undefined).filter(issue => issue.severity === 'error')
      expect(errors).toEqual([])
    })
  }
})
