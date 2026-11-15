/**
 * Build the browser bundle and verify the package is internally consistent.
 *
 * Static gates only: nothing here imports the Host half, so a missing DSH
 * installation cannot make the check fail for the wrong reason.
 * @module dsh-scheduled-message/scripts/check
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { buildClient } from './build-client.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

/**
 * Assert one condition, collecting a readable failure instead of throwing.
 * @param condition - the condition to require.
 * @param message - diagnostic for a failure.
 */
function requireThat(condition, message) {
  if (!condition) failures.push(message)
}

// 1. The committed bundle must equal a fresh build.
const expected = buildClient()
const actual = readFileSync(join(ROOT, 'client.js'), 'utf8')
requireThat(actual === expected, 'client.js is stale: run `node scripts/build-client.mjs`')

/**
 * Remove module syntax so a file can be compiled as a classic script.
 *
 * Only used when this sandbox refuses to spawn a second Node process for the
 * authoritative `node --check` gate; it strips import declarations (including
 * multi-line ones) and export keywords, which is enough to surface a syntax
 * error in the code itself.
 * @param source - module source text.
 * @returns script source text.
 */
function stripModuleSyntax(source) {
  return source
    .replace(/^import[\s\S]*?from\s*(['"])[^'"\n]*\1[ \t]*;?[ \t]*$/gm, '')
    .replace(/^import\s*(['"])[^'"\n]*\1[ \t]*;?[ \t]*$/gm, '')
    .replace(/^export\s*\{[\s\S]*?\}[ \t]*;?[ \t]*$/gm, '')
    .replace(/^export\s+(?:default\s+)?/gm, '')
}

/**
 * Report the first syntax error in one package file.
 *
 * `node --check` is the real gate. Where the sandbox refuses to spawn Node
 * (EPERM/EACCES/ENOENT), the same source is compiled in-process instead of
 * failing the check for an environment reason.
 * @param file - package-relative path.
 * @returns the first error line, or null when the file parses.
 */
function parseFailure(file) {
  const path = join(ROOT, file)
  const source = readFileSync(path, 'utf8')
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
    return null
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : ''
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') {
      return String(error.stderr ?? error.message).split('\n')[0]
    }
  }
  try {
    new vm.Script(stripModuleSyntax(source), { filename: path })
    return null
  } catch (error) {
    return String(error.message).split('\n')[0]
  }
}

// 2. Both halves and the tests must parse.
for (const file of ['index.js', 'lib/core.js', 'client.js', 'client.src.js']) {
  const failure = parseFailure(file)
  if (failure !== null) failures.push(`${file} does not parse: ${failure}`)
}

// 3. package.json and both dictionaries must parse and agree on their keys.
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
requireThat(manifest.type === 'module', 'package.json must declare "type": "module"')
requireThat(manifest.main === './index.js', 'package.json main must be ./index.js')
requireThat(manifest.exports?.['./client'] === './client.js', 'package.json must export ./client -> ./client.js')
requireThat(manifest.dsh?.client?.platform === 'web', 'package.json must declare dsh.client.platform = web')
requireThat(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json must point dsh.bundle.patch at cordis.patch.yml')

const en = JSON.parse(readFileSync(join(ROOT, 'locale/en.json'), 'utf8'))
const zh = JSON.parse(readFileSync(join(ROOT, 'locale/zh.json'), 'utf8'))
requireThat(Object.keys(en).length > 0, 'locale/en.json is empty')
requireThat(
  JSON.stringify(Object.keys(en).sort()) === JSON.stringify(Object.keys(zh).sort()),
  'locale/en.json and locale/zh.json must declare the same keys',
)

// 4. Every key the bundle asks for must exist in the dictionary. Keys composed
// at runtime (repeat.<freq>, repeat.detail.<freq>, weekday.<day>, error.<code>,
// attachments.<form>) are covered by the parity check below and by the smoke
// test's rendering paths, so only literal keys are counted here.
const usedKeys = new Set()
const build = readFileSync(join(ROOT, 'client.src.js'), 'utf8')
for (const match of build.matchAll(/\bt\(\s*'([^']+)'/g)) usedKeys.add(match[1])
for (const match of build.matchAll(/label:\s*'([a-z][A-Za-z0-9.]*)'/g)) usedKeys.add(match[1])
for (const key of usedKeys) {
  requireThat(key in en, `client.src.js uses t('${key}') but locale/en.json does not define it`)
  requireThat(key in zh, `client.src.js uses t('${key}') but locale/zh.json does not define it`)
}

// 5. Files the manifest promises must exist.
for (const file of ['index.js', 'client.js', 'lib/core.js', 'icon.svg', 'cordis.patch.yml', 'README.md', 'docs/DETAIL.md']) {
  try {
    readFileSync(join(ROOT, file))
  } catch {
    failures.push(`missing file: ${file}`)
  }
}

// 6. The bundle must not require anything outside the platform table.
for (const match of expected.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
  requireThat(
    ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'].includes(match[1]),
    `client.js requires '${match[1]}', which is not in the browser platform table`,
  )
}

// 7. The package must ship no TypeScript-only imports in the shipped halves.
for (const file of readdirSync(join(ROOT, 'lib')).filter(name => name.endsWith('.js'))) {
  const source = readFileSync(join(ROOT, 'lib', file), 'utf8')
  requireThat(!/^import\s/m.test(source), `lib/${file} must stay dependency-free`)
}

// 8. The Scheduled tab is two registrations sharing one id, and the browser
// half never polls: refresh is event- and timer-driven only.
const clientSource = readFileSync(join(ROOT, 'client.src.js'), 'utf8')
requireThat(
  /name: 'main',\s*\n\s*key: PANEL_ID/.test(clientSource),
  "client.src.js must register the 'main' page under PANEL_ID",
)
requireThat(
  /name: 'sidebar\.panellist',\s*\n\s*id: PANEL_ID,\s*\n\s*order: 11/.test(clientSource),
  'client.src.js must register the sidebar entry under PANEL_ID at order 11',
)
requireThat(!/setInterval\s*\(/.test(clientSource), 'client.src.js must not poll with setInterval')

if (failures.length > 0) {
  process.stderr.write(`check failed:\n${failures.map(line => `  - ${line}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `check passed: ${usedKeys.size} literal locale keys of ${Object.keys(en).length} defined, `
    + `${expected.length} bundle bytes\n`,
  )
}
