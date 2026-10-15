// Records the SHA-256 of the engine bundle next to it, so a stale or hand-edited copy can be told apart.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dir = path.resolve(import.meta.dirname, '../engine-dist')
const hash = createHash('sha256').update(readFileSync(path.join(dir, 'retirement_engine.js'))).digest('hex')
writeFileSync(path.join(dir, 'retirement_engine.sha256'), hash + '\n')
console.log(`engine bundle ${hash.slice(0, 12)}`)
