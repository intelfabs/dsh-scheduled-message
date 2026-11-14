#!/usr/bin/env node
/**
 * Build the browser bundle `client.js` from its three sources.
 *
 * The Client half is one lazily materialized CJS factory, so it cannot import
 * `lib/core.js` or read `locale/*.json` at runtime. This script inlines both
 * into `client.src.js`'s factory: `core` stays the single implementation of the
 * date, 12-hour clock and RRULE logic, and the dictionaries keep one source of
 * truth. `test/client.test.mjs` rebuilds in memory and fails when the committed
 * bundle differs, so the artifact can never drift from its sources.
 *
 * @module dsh-scheduled-message/scripts/build-client
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE_NAME = 'dsh-scheduled-message'

/**
 * Read one package-relative file.
 * @param relative - path below the package root.
 * @returns the file text.
 */
function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/**
 * Turn `lib/core.js` into a factory-local module object.
 * @returns source for one `const core = (() => { … })()` expression.
 */
function coreBlock() {
  const source = read('lib/core.js')
  const names = [...source.matchAll(/^export (?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1])
  if (names.length === 0) throw new Error('lib/core.js exports nothing to inline')
  if (/^export\s+(?!const|function|class)/m.test(source)) {
    throw new Error('lib/core.js uses an export form the bundler cannot inline')
  }
  const body = source.replace(/^export\s+/gm, '')
  return `const core = (() => {\n${body}\nreturn { ${names.join(', ')} }\n})()`
}

/**
 * Turn both dictionaries into factory-local constants.
 * @returns source declaring `EN` and `ZH`.
 */
function localeBlock() {
  const en = JSON.parse(read('locale/en.json'))
  const zh = JSON.parse(read('locale/zh.json'))
  const missing = Object.keys(en).filter(key => !(key in zh))
  const extra = Object.keys(zh).filter(key => !(key in en))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`locale key mismatch: en-only ${JSON.stringify(missing)}, zh-only ${JSON.stringify(extra)}`)
  }
  return `const EN = ${JSON.stringify(en, null, 2)}\n\nconst ZH = ${JSON.stringify(zh, null, 2)}`
}

/**
 * Compose the whole bundle text.
 * @returns the `client.js` artifact.
 */
export function buildClient() {
  const source = read('client.src.js')
  if (!/^export function createClientPlugin\(require\) \{/m.test(source)) {
    throw new Error('client.src.js must export exactly one createClientPlugin factory')
  }
  const plugin = source.replace(/^export function createClientPlugin\(require\) \{/m, 'function createClientPlugin(require) {')
  return [
    '/**',
    ' * dsh-scheduled-message — browser bundle. GENERATED FILE, do not edit.',
    ' *',
    ' * Built from client.src.js + lib/core.js + locale/en.json + locale/zh.json by',
    ' * scripts/build-client.mjs. Rebuild with `node scripts/build-client.mjs`;',
    ' * `node --test test/` fails when this file is stale.',
    ' */',
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(PACKAGE_NAME)},`,
    '  factory: (require) => {',
    coreBlock(),
    '',
    localeBlock(),
    '',
    plugin,
    '',
    '    return createClientPlugin(require)',
    '  },',
    '})',
    '',
  ].join('\n')
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = join(ROOT, 'client.js')
  writeFileSync(target, buildClient(), 'utf8')
  process.stdout.write(`wrote ${target}\n`)
}
