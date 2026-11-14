/**
 * Run the Host smoke test in a child process that can remap one package.
 *
 * The remap has to be installed before `index.js` is imported, which is a
 * process-level decision, so the test shells out instead of importing the Host
 * half itself.
 *
 * @module dsh-scheduled-message/test/host.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

test('the Host half delivers, refuses and recovers as documented', () => {
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(join(HERE, 'support/register.mjs')).href,
    join(ROOT, 'scripts/host-smoke.mjs'),
  ], { cwd: ROOT, encoding: 'utf8' })

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `host smoke failed:\n${output.slice(-4000)}`)
  assert.match(output, /host smoke: \d+ assertions passed/)
})
