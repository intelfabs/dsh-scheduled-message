/**
 * Client half tests: the committed bundle must match its sources, and
 * materializing it must register the documented button, strip and shortcut.
 *
 * The bundle is loaded the way the web shell loads it — by executing it with a
 * `window.__ModuleLoader__` facade — and its factory is materialized with a
 * stand-in platform table, so no browser and no DSH installation is needed.
 *
 * @module dsh-scheduled-message/test/client.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildClient } from '../scripts/build-client.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = relative => readFileSync(join(ROOT, relative), 'utf8')
const NS = 'dsh-scheduled-message'

function noop() {}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useCallback: noop,
  useEffect: noop,
  useId: () => 'id',
  useMemo: () => undefined,
  useRef: () => ({ current: null }),
  useState: value => [value, noop],
  useSyncExternalStore: () => 0,
}

const fakeReactDom = { createPortal: () => null }

function fakeRequire(specifier) {
  if (specifier === 'react') return fakeReact
  if (specifier === 'react-dom' || specifier === 'react-dom/client') return fakeReactDom
  throw new Error(`client bundle requested an unavailable module: ${specifier}`)
}

let loadCount = 0

/**
 * Execute the bundle and materialize its factory.
 * @returns the plugin object the bundle exports.
 */
async function loadBundle() {
  const registry = new Map()
  globalThis.window = {
    __ModuleLoader__: {
      load(row) {
        registry.set(row.id, row.factory)
      },
    },
  }
  // A fresh query keeps the module cache from skipping the second execution.
  loadCount += 1
  await import(`${pathToFileURL(join(ROOT, 'client.js')).href}?load=${loadCount}`)
  const factory = registry.get(NS)
  assert.ok(factory !== undefined, 'the bundle registers one factory under its package name')
  return factory(fakeRequire)
}

function translate(dictionary) {
  return (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
  }
}

test('the committed bundle equals a fresh build', () => {
  assert.equal(read('client.js'), buildClient(), 'run `node scripts/build-client.mjs`')
})

test('both dictionaries declare the same keys', () => {
  const en = JSON.parse(read('locale/en.json'))
  const zh = JSON.parse(read('locale/zh.json'))
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string')
    assert.ok(value.length > 0, `${key} is empty`)
  }
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.length > 0, `${key} is empty`)
  }
})

test('materializing the bundle yields the documented plugin', async () => {
  const plugin = await loadBundle()
  assert.equal(plugin.name, NS)
  assert.ok(Array.isArray(plugin.inject), 'the plugin declares its required services')
  assert.ok(plugin.inject.includes('slots'))
  assert.ok(plugin.inject.includes('locale'))
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the composer button, the strip and the shortcut', async () => {
  const plugin = await loadBundle()
  const registrations = []
  const commands = []
  const dictionaries = []
  const en = JSON.parse(read('locale/en.json'))
  const injectCalls = []
  let shortcutScopeUsed = false

  const ctx = {
    effect(factory) {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : noop
    },
    locale: {
      register(namespace, dicts) {
        assert.equal(namespace, NS)
        dictionaries.push(dicts)
        return noop
      },
      bind(namespace) {
        assert.equal(namespace, NS)
        return translate(en)
      },
    },
    slots: {
      inject(name, factory) {
        assert.ok(name === 'conversation.input.right' || name === 'conversation.input.dock', `unexpected slot ${name}`)
        factory()
      },
      register(entry, component) {
        registrations.push({ entry, component })
        return noop
      },
    },
    inject(names, callback) {
      injectCalls.push([...names])
      const scope = { effect: ctx.effect }
      if (names.includes('shortcuts')) {
        shortcutScopeUsed = true
        scope.shortcuts = {
          register(command) {
            commands.push(command)
            return noop
          },
        }
      }
      if (names.includes('sessions')) scope.sessions = { scope: () => undefined }
      if (names.includes('layout')) scope.layout = { selectPanel: noop }
      return callback(scope)
    },
    get() {
      return undefined
    },
  }

  plugin.apply(ctx)

  assert.equal(dictionaries.length, 1, 'one dictionary registration')
  assert.deepEqual(dictionaries[0].en, en, 'the English table is the locale/en.json document')
  assert.ok(typeof dictionaries[0].zh === 'object')

  assert.equal(registrations.length, 2, 'two slot contributions')

  const button = registrations.find(item => item.entry.name === 'conversation.input.right')
  assert.ok(button !== undefined, 'the button registers into conversation.input.right')
  assert.equal(button.entry.id, 'dsm-schedule')
  assert.equal(button.entry.order, 900)
  assert.equal(button.entry.locale, NS)
  assert.equal(typeof button.component, 'function')
  assert.equal(typeof button.entry.inject, 'function')
  assert.equal(button.entry.inject('session-1').dsmSessionId, 'session-1')

  const strip = registrations.find(item => item.entry.name === 'conversation.input.dock')
  assert.ok(strip !== undefined, 'the strip registers into conversation.input.dock')
  assert.equal(strip.entry.id, 'dsm-scheduled')
  assert.equal(strip.entry.order, 30)
  assert.equal(typeof strip.component, 'function')

  assert.equal(shortcutScopeUsed, true, 'the shortcut is registered inside a shortcuts scope')
  assert.deepEqual(injectCalls.sort(), [['layout'], ['modelDirectories'], ['sessions'], ['shortcuts']],
    'optional services are requested through their own scopes instead of undeclared property reads')
  assert.equal(commands.length, 1, 'one shortcut command')
  const command = commands[0]
  assert.equal(command.id, 'dsh-scheduled-message.open')
  assert.deepEqual([...command.aliases], ['schedule', 'later', 'deliver'])
  assert.deepEqual([...command.regions], ['editable'])
  assert.deepEqual([...command.modals], [])
  assert.deepEqual(Object.keys(command.defaults).sort(), [
    'desktop:linux', 'desktop:macos', 'desktop:windows',
    'web:linux', 'web:macos', 'web:windows',
  ])
  for (const profile of Object.keys(command.defaults)) {
    assert.deepEqual(command.defaults[profile], { code: 'Enter', modifiers: ['alt'] }, profile)
  }
  assert.equal(command.label(), 'Schedule message')

  // Alt+Enter outside an editor keeps its existing meaning.
  assert.deepEqual(command.resolve({ region: 'page' }), { status: 'pass' })
  // With no mounted composer the command explains itself instead of firing.
  const blocked = command.resolve({ region: 'editable' })
  assert.equal(blocked.status, 'blocked')
  assert.equal(typeof blocked.reason, 'string')
  assert.ok(blocked.reason.length > 0)
})

test('the Schedule button follows the composer state handed to it by the slot', async () => {
  const plugin = await loadBundle()
  const registrations = []
  const en = JSON.parse(read('locale/en.json'))
  const ctx = {
    effect(factory) {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : noop
    },
    locale: {
      register: () => noop,
      bind: () => translate(en),
    },
    slots: {
      inject(_name, factory) {
        factory()
      },
      register(entry, component) {
        registrations.push({ entry, component })
        return noop
      },
    },
    inject(names, callback) {
      const scope = { effect: ctx.effect }
      if (names.includes('shortcuts')) scope.shortcuts = { register: () => noop }
      if (names.includes('sessions')) scope.sessions = { scope: () => undefined }
      if (names.includes('layout')) scope.layout = { selectPanel: noop }
      return callback(scope)
    },
    get: () => undefined,
  }
  plugin.apply(ctx)

  const schedule = registrations.find(item => item.entry.name === 'conversation.input.right')
  // `conversation.input.right` carries no owner values, so `props.input` is absent
  // at runtime; the live composer state arrives through `props.useInput`.
  const mount = (state, { withUseInput = true } = {}) => {
    const seen = []
    const element = schedule.component({
      t: translate(en),
      dsmSessionId: 'session-1',
      inputActions: { setDraft: noop, removeAttachment: noop },
      ...(withUseInput ? {
        useInput(selector) {
          seen.push(selector(state))
          return selector(state)
        },
      } : {}),
    })
    return { element, seen, button: element.children[0] }
  }

  const typedState = { draft: 'hello', attachmentIds: [], phase: 'plain' }
  const typed = mount(typedState)
  assert.equal(typed.seen.length, 1, 'the seat subscribes through useInput')
  assert.equal(typed.seen[0], typedState, 'the selector receives the published input state')
  assert.equal(typed.button.type, 'button')
  assert.equal(typed.button.props.disabled, false, 'a draft makes the button clickable')
  assert.equal(typed.button.props.title, en['button.label'])

  const empty = mount({ draft: '   ', attachmentIds: [], phase: 'plain' })
  assert.equal(empty.button.props.disabled, true, 'an empty draft keeps the button disabled')
  assert.equal(empty.button.props.title, en['button.emptyHint'])

  const attached = mount({ draft: '', attachmentIds: ['attachment-1'], phase: 'plain' })
  assert.equal(attached.button.props.disabled, false, 'an attachment alone is content to schedule')

  const busy = mount({ draft: 'hello', attachmentIds: [], phase: 'sending' })
  assert.equal(busy.button.props.disabled, true, 'a sending composer stays locked')
  assert.equal(busy.button.props.title, en['button.busyHint'])

  const noHook = mount(typedState, { withUseInput: false })
  assert.equal(noHook.button.props.disabled, true, 'a seat without the hook stays inert instead of throwing')
})

test('the bundle requires nothing beyond the browser platform table', () => {  const bundle = read('client.js')
  const required = new Set([...bundle.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(match => match[1]))
  for (const specifier of required) {
    assert.ok(
      ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'].includes(specifier),
      `${specifier} is not a baseline browser module`,
    )
  }
  assert.ok(bundle.startsWith('/**'), 'the bundle carries its header')
  assert.ok(bundle.includes(`id: ${JSON.stringify(NS)}`), 'the bundle registers under the package name')
  assert.ok(!/^\s*import\s/m.test(bundle), 'the bundle is a classic script, not a module')
})
