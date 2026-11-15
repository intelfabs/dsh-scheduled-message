/**
 * Host test: run the whole Host scenario in process under node:test.
 *
 * The storage-domain remap has to be installed before index.js is imported,
 * which is a process-level decision, so test/support/host-smoke.mjs registers it and
 * imports the Host half itself; this file only wraps that scenario so the
 * summary is printed by the TAP reporter instead of a child process.
 *
 * @module dsh-scheduled-message/test/host.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { runHostSmoke } from './support/host-smoke.mjs'

test('the Host half delivers, refuses and recovers as documented', async () => {
  const result = await runHostSmoke()
  assert.ok(result.assertions > 0, 'the scenario ran at least one assertion')
  process.stdout.write('host test: ' + result.assertions + ' assertions passed\n')
})
