import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const relative of ['index.js', 'tests/doctor.test.js', 'tests/doctor-cli.test.js']) {
  const file = path.join(root, relative)
  const source = readFileSync(file, 'utf8')
  const normalized = source.replace(/\r\n/g, '\n')
  if (normalized !== source) writeFileSync(file, normalized)
}
