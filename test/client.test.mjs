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

// The portal facade hands the node back instead of dropping it, so a test can
// inspect what a portalled component rendered.
const fakeReactDom = { createPortal: node => node }

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
        assert.ok(['conversation.input.right', 'conversation.input.dock', 'main', 'sidebar.panellist'].includes(name), `unexpected slot ${name}`)
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

  assert.equal(registrations.length, 4, 'two composer seats, one panel page and one sidebar entry')

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

  const page = registrations.find(item => item.entry.name === 'main')
  assert.ok(page !== undefined, 'the page registers into main')
  assert.equal(page.entry.key, 'scheduled-messages')
  assert.equal(page.entry.locale, NS)
  assert.equal(typeof page.component, 'function')

  const entry = registrations.find(item => item.entry.name === 'sidebar.panellist')
  assert.ok(entry !== undefined, 'the sidebar entry registers into sidebar.panellist')
  assert.equal(entry.entry.id, 'scheduled-messages')
  assert.equal(entry.entry.order, 11, 'order 10 is Automation tasks, so the tab sits below it')
  assert.equal(entry.entry.locale, NS)
  assert.equal(entry.entry.label(), 'Scheduled')
  assert.equal(typeof entry.component, 'function')

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

// ---------------------------------------------------------------- Scheduled tab

/**
 * Apply the plugin against the same minimal browser context the shell provides.
 * @param plugin - the loaded bundle export.
 * @returns the recorded slot registrations and the English dictionary.
 */
function applyPlugin(plugin, options) {
  const registrations = []
  const en = JSON.parse(read('locale/en.json'))
  const selectPanel = options === undefined || typeof options.selectPanel !== 'function' ? noop : options.selectPanel
  const ctx = {
    effect(factory) {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : noop
    },
    locale: { register: () => noop, bind: () => translate(en) },
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
      if (names.includes('layout')) scope.layout = { selectPanel }
      return callback(scope)
    },
    get: () => undefined,
  }
  plugin.apply(ctx)
  return { registrations, en }
}

/**
 * Load the bundle and return the pure decisions it exposes for these tests.
 * @returns the internals object.
 */
async function loadInternals() {
  const plugin = await loadBundle()
  assert.ok(plugin.__internals !== undefined, 'the bundle exposes its pure decisions')
  return plugin.__internals
}

const UTC = 'UTC'

/**
 * Build one public record fixture.
 * @param overrides - fields to replace.
 * @returns a PublicRecord-shaped object.
 */
function makeRecord(overrides) {
  return {
    id: 'msg-1',
    target: { kind: 'session', sessionId: 'session-abcdef12' },
    dueAt: '2026-11-15T09:00:00.000Z',
    timeZone: UTC,
    text: 'Summarise the PR review',
    images: [],
    files: [],
    createdAt: '2026-11-14T09:00:00.000Z',
    updatedAt: '2026-11-14T09:00:01.000Z',
    status: 'pending',
    ...overrides,
  }
}

test('the sidebar icon draws a clock in currentColor and badges pending work', async () => {
  const internals = await loadInternals()
  const plain = internals.panelIcon(16, 0)
  assert.equal(plain.type, 'span')
  assert.equal(plain.props.className, 'dsm-panel-icon')
  assert.equal(plain.children.length, 1, 'no badge without pending work')

  const badged = internals.panelIcon(20, 3)
  assert.equal(badged.children.length, 2)
  assert.equal(badged.children[1].props.className, 'dsm-panel-badge')
  assert.deepEqual(badged.children[1].children, ['3'])
  assert.deepEqual(internals.panelIcon(16, 120).children[1].children, ['99+'])

  const glyph = badged.children[0].type({ size: 20 })
  assert.equal(glyph.type, 'svg')
  assert.equal(glyph.props.stroke, 'currentColor')
  assert.equal(glyph.props.width, 20)
  assert.equal(glyph.props.height, 20)
  assert.equal(glyph.props['aria-hidden'], 'true')
})

test('day groups follow the reader zone and put settled rows last', async () => {
  const internals = await loadInternals()
  const now = Date.parse('2026-11-15T08:00:00.000Z')
  const records = [
    makeRecord({ id: 'a', dueAt: '2026-11-18T10:00:00.000Z' }),
    makeRecord({ id: 'b', dueAt: '2026-11-15T09:00:00.000Z' }),
    makeRecord({ id: 'c', dueAt: '2026-11-16T10:00:00.000Z' }),
    makeRecord({ id: 'd', dueAt: '2026-11-25T10:00:00.000Z' }),
    makeRecord({ id: 'e', status: 'failed', dueAt: '2026-11-16T08:00:00.000Z', error: 'Target conversation is archived.' }),
    makeRecord({ id: 'f', status: 'sent', dueAt: '2026-11-14T09:00:00.000Z', sentAt: '2026-11-15T06:00:00.000Z' }),
  ]
  const groups = internals.buildGroups(records, now, UTC, 'en')
  assert.deepEqual(groups.map(group => group.date), ['2026-11-15', '2026-11-16', '2026-11-18', '2026-11-25', null])
  assert.equal(groups[0].heading.key, 'panel.today')
  assert.equal(groups[1].heading.key, 'panel.tomorrow')
  assert.equal(groups[2].heading.key, 'weekday.wed', 'the next six days use the weekday name')
  assert.equal(groups[3].heading.kind, 'text', 'later days use a formatted date')
  assert.ok(groups[3].heading.text.length > 0)
  assert.deepEqual(groups[0].rows.map(row => row.id), ['b'])
  assert.deepEqual(groups[1].rows.map(row => row.id), ['e', 'c'], 'rows are ordered by due instant')
  assert.equal(groups[1].rows[0].failed, true)
  assert.equal(groups[1].rows[0].error, 'Target conversation is archived.')
  assert.equal(groups[0].rows[0].time, '9:00 AM')
  const settled = groups[4]
  assert.equal(settled.kind, 'sent')
  assert.equal(settled.heading.key, 'panel.sent')
  assert.equal(settled.rows[0].sent, true)
})

test('a card summarises its record in the browser clock', async () => {
  const internals = await loadInternals()
  const model = internals.cardModel(makeRecord({
    dueAt: '2026-11-15T13:00:00.000Z',
    text: 'first line\nsecond line\nthird line',
    images: [{ attachmentId: 'img-1', mediaType: 'image/png', bytes: 2048 }],
    files: [{ attachmentId: 'file-1', name: 'spec.pdf', bytes: 4096 }],
    targetLabel: { workspaceTitle: 'dsh-plugins', sessionTitle: 'PR review' },
  }), 'Asia/Hong_Kong', null)
  assert.equal(model.time, '9:00 PM', 'the clock face follows the reader zone')
  assert.equal(model.preview, 'first line\nsecond line', 'two lines of preview')
  assert.equal(model.hasText, true)
  assert.equal(model.images, 1)
  assert.equal(model.files, 1)
  assert.equal(model.attachments, 2)
  assert.equal(model.late, false)
  assert.equal(model.destination.workspaceTitle, 'dsh-plugins')
  assert.equal(model.destination.sessionTitle, 'PR review')

  const late = internals.cardModel(makeRecord({
    status: 'sent',
    late: true,
    sentAt: '2026-11-15T09:30:00.000Z',
  }), UTC, null)
  assert.equal(late.late, true, 'a late delivery is labelled')
  const cancelled = internals.cardModel(makeRecord({ status: 'cancelled', sentAt: '2026-11-15T09:30:00.000Z' }), UTC, null)
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.sent, true)
})

test('destinations fall back to the short session id and to a new conversation', async () => {
  const internals = await loadInternals()
  const t = translate(JSON.parse(read('locale/en.json')))
  const session = internals.destinationOf(makeRecord({
    target: { kind: 'session', sessionId: 'abcdef123456' },
  }), null)
  assert.equal(session.workspaceTitle, undefined)
  assert.equal(session.sessionTitle, 'abcdef12')
  assert.equal(internals.destinationText(t, session), 'abcdef12')

  const fresh = internals.destinationOf(makeRecord({
    target: { kind: 'new', cwd: 'C:/repo/plugins', workspaceId: 'ws-1' },
    targetLabel: { workspaceTitle: 'Repo' },
  }), null)
  assert.equal(internals.destinationText(t, fresh), 'Repo \u203A New conversation')
  assert.equal(internals.destinationText(t, null), 'Choose a destination')
})

test('save sends only changed fields and always the record version', async () => {
  const internals = await loadInternals()
  const base = makeRecord({})
  assert.equal(
    internals.buildUpdate(base, { dueAt: base.dueAt, text: base.text, target: base.target }),
    null,
    'an untouched draft sends nothing',
  )
  assert.equal(
    internals.buildUpdate(base, { dueAt: base.dueAt, text: base.text + '\n\n', target: base.target }),
    null,
    'whitespace-only text is not a change',
  )

  const textOnly = internals.buildUpdate(base, { dueAt: base.dueAt, text: 'new words', target: base.target })
  assert.deepEqual(Object.keys(textOnly).sort(), ['expectedUpdatedAt', 'id', 'text'])
  assert.equal(textOnly.expectedUpdatedAt, base.updatedAt, 'the loaded version always travels')

  const timeOnly = internals.buildUpdate(base, {
    dueAt: '2026-11-17T09:00:00.000Z',
    text: base.text,
    target: base.target,
  })
  assert.deepEqual(Object.keys(timeOnly).sort(), ['dueAt', 'expectedUpdatedAt', 'id'])

  const moved = internals.buildUpdate(base, {
    dueAt: base.dueAt,
    text: base.text,
    target: { kind: 'session', sessionId: 'other-session' },
  })
  assert.deepEqual(moved.target, { kind: 'session', sessionId: 'other-session' })

  const attach = internals.buildUpdate(base, {
    dueAt: base.dueAt,
    text: base.text,
    target: base.target,
    removeIds: ['img-1', 'img-1'],
    addedFiles: [{ fileId: 'file-9', name: 'a.pdf', bytes: 10 }],
    addedImages: [{ mediaType: 'image/png', data: 'AAAA', name: 'shot.png' }],
  })
  assert.deepEqual(attach.removeAttachmentIds, ['img-1'], 'removals are de-duplicated')
  assert.deepEqual(attach.addFileIds, ['file-9'])
  assert.deepEqual(attach.addImages, [{ mediaType: 'image/png', data: 'AAAA', name: 'shot.png' }])
})

test('the editor starts from the record and resolves a saved wall clock', async () => {
  const internals = await loadInternals()
  const base = makeRecord({ dueAt: '2026-11-16T01:30:00.000Z' })
  const draft = internals.draftOf(base, UTC)
  assert.equal(draft.text, base.text)
  assert.deepEqual(draft.selection, { date: '2026-11-16', hour12: 1, minute: 30, meridiem: 'AM' })
  assert.deepEqual(draft.target, base.target)
  assert.equal(draft.dueAt, base.dueAt)

  const payload = internals.draftPayload({
    ...draft,
    selection: { date: '2026-11-20', hour12: 9, minute: 0, meridiem: 'PM' },
  }, UTC)
  assert.equal(payload.dueAt, '2026-11-20T21:00:00.000Z')

  const merged = internals.pendingAttachments(makeRecord({
    images: [{ attachmentId: 'img-1' }, { attachmentId: 'img-2' }],
    files: [{ attachmentId: 'file-1' }],
  }), {
    removeIds: ['img-1'],
    addedImages: [{ localId: 'local-1' }],
    addedFiles: [{ fileId: 'file-9' }],
  })
  assert.equal(merged.images.length, 1)
  assert.equal(merged.files.length, 1)
  assert.equal(merged.total, 4)
})

test('the destination picker filters by workspace and conversation, newest first', async () => {
  const internals = await loadInternals()
  const targets = {
    workspaces: [
      {
        id: 'ws-1',
        title: 'dsh-plugins',
        path: 'C:/repo/plugins',
        sessions: [
          { id: 's-old', label: 'old notes', updatedAt: 1 },
          { id: 's-new', label: 'PR review', updatedAt: 9 },
          { id: 's-none', label: 'no timestamp' },
        ],
      },
      { id: 'ws-2', title: 'other', path: 'C:/repo/other', sessions: [{ id: 's-b', label: 'alpha' }] },
    ],
  }
  const all = internals.filterTargets(targets, '')
  assert.deepEqual(all.map(group => group.workspace.id), ['ws-1', 'ws-2'])
  assert.deepEqual(all[0].sessions.map(session => session.id), ['s-new', 's-old', 's-none'])

  const pr = internals.filterTargets(targets, 'pr')
  assert.deepEqual(pr.map(group => group.workspace.id), ['ws-1'])
  assert.deepEqual(pr[0].sessions.map(session => session.id), ['s-new'])

  const byWorkspace = internals.filterTargets(targets, 'dsh')
  assert.equal(byWorkspace.length, 1)
  assert.equal(byWorkspace[0].sessions.length, 0, 'a workspace title match still offers a new conversation')
  assert.deepEqual(internals.filterTargets(targets, 'zzz'), [])

  assert.deepEqual(
    internals.newConversationTarget(targets.workspaces[0]),
    { kind: 'new', cwd: 'C:/repo/plugins', workspaceId: 'ws-1' },
  )
  assert.equal(internals.newConversationTarget({ id: 'ws-3', title: 'no path' }), null)
})

test('counts and byte sizes are decided without a DOM', async () => {
  const internals = await loadInternals()
  assert.deepEqual(internals.countText(1), { key: 'panel.waitingOne', params: { count: 1 } })
  assert.deepEqual(internals.countText(3), { key: 'panel.waitingMany', params: { count: 3 } })
  assert.deepEqual(internals.countText(0), { key: 'panel.waitingMany', params: { count: 0 } })
  assert.equal(internals.formatBytes(512), '512 B')
  assert.equal(internals.formatBytes(1536), '1.5 KB')
  assert.equal(internals.formatBytes(1048576), '1 MB')
  assert.equal(internals.formatBytes(-1), '')
})

test('every key the bundle asks for exists in both dictionaries', async () => {
  const internals = await loadInternals()
  const en = JSON.parse(read('locale/en.json'))
  const zh = JSON.parse(read('locale/zh.json'))
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())

  const used = new Set()
  const source = read('client.src.js')
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(match[1])
  for (const match of source.matchAll(/label:\s*'([a-z][A-Za-z0-9.]*)'/g)) used.add(match[1])
  for (const value of Object.values(internals.errorKeys)) used.add(value)
  for (const key of [
    'repeat.daily', 'repeat.weekdays', 'repeat.weekly', 'repeat.monthly',
    'repeat.detail.daily', 'repeat.detail.weekdays', 'repeat.detail.weekly', 'repeat.detail.monthly',
    'weekday.mon', 'weekday.tue', 'weekday.wed', 'weekday.thu', 'weekday.fri', 'weekday.sat', 'weekday.sun',
    'panel.waitingOne', 'panel.waitingMany', 'panel.sent',
  ]) used.add(key)

  assert.ok(used.size >= 100, 'the scan finds every literal key the bundle uses')
  for (const key of used) {
    assert.ok(key in en, 'locale/en.json is missing ' + key)
    assert.ok(key in zh, 'locale/zh.json is missing ' + key)
  }
  for (const prefix of ['panel.', 'editor.']) {
    assert.ok(Object.keys(en).some(key => key.startsWith(prefix)), 'the tab strings live under ' + prefix)
    assert.ok(Object.keys(zh).some(key => key.startsWith(prefix)), 'the Chinese strings live under ' + prefix)
  }
})

test('the tab opens itself and Automation tasks through the layout service', async () => {
  const plugin = await loadBundle()
  const opened = []
  applyPlugin(plugin, { selectPanel: id => opened.push(id) })
  plugin.__internals.openPanel()
  plugin.__internals.openTasksPanel()
  assert.deepEqual(opened, ['scheduled-messages', 'schedules'])
})

test('the workspace filter resolves the last open conversation to its workspace', async () => {
  const internals = await loadInternals()
  const targets = {
    workspaces: [
      { id: 'ws-1', title: 'dsh-plugins', path: 'C:/repo/plugins', sessions: [{ id: 's-1', label: 'PR review' }] },
      { id: 'ws-2', title: 'other', path: 'C:/repo/other', sessions: [] },
      { title: 'no id', path: 'C:/nowhere', sessions: [{ id: 's-2', label: 'x' }] },
    ],
  }
  assert.deepEqual(internals.resolveWorkspaceFilter(targets, 's-1'), {
    workspaceId: 'ws-1',
    workspaceTitle: 'dsh-plugins',
  })
  assert.equal(internals.resolveWorkspaceFilter(targets, 's-2'), null, 'a workspace without an id cannot filter')
  assert.equal(internals.resolveWorkspaceFilter(targets, 's-missing'), null)
  assert.equal(internals.resolveWorkspaceFilter(targets, null), null)
  assert.equal(internals.resolveWorkspaceFilter(null, 's-1'), null)

  assert.equal(
    internals.listAllUrl({ kind: 'workspace', workspaceId: 'ws 1/x' }),
    '/api/dsh-scheduled-message/list-all?scope=workspace&workspaceId=ws%201%2Fx',
  )
  assert.equal(internals.listAllUrl({ kind: 'all' }), '/api/dsh-scheduled-message/list-all?scope=all')
  assert.equal(internals.listAllUrl(null), '/api/dsh-scheduled-message/list-all?scope=all')
})

test('the repeating group only appears when the automation service reports tasks', async () => {
  const internals = await loadInternals()
  assert.deepEqual(internals.repeatingView(null), { show: false, items: [] })
  assert.equal(internals.repeatingView({ available: false, items: [{ id: 'r1', title: 'x' }] }).show, false)
  assert.equal(internals.repeatingView({ available: true, items: [] }).show, false)

  const view = internals.repeatingView({
    available: true,
    items: [
      { id: 'r1', title: 'Daily standup', rrule: 'DTSTART;TZID=UTC:20261116T090000\nRRULE:FREQ=DAILY' },
      { id: 'r2', title: 'Weekly review' },
      { id: 'r3', title: '   ' },
      null,
    ],
  })
  assert.equal(view.show, true)
  assert.deepEqual(view.items, [
    { id: 'r1', title: 'Daily standup', rrule: 'DTSTART;TZID=UTC:20261116T090000\nRRULE:FREQ=DAILY' },
    { id: 'r2', title: 'Weekly review', rrule: null },
  ], 'a row without a rule still renders, a blank title does not')
})

test('a composer seat records the open conversation for the workspace filter', async () => {
  const plugin = await loadBundle()
  const { registrations, en } = applyPlugin(plugin)
  const button = registrations.find(item => item.entry.name === 'conversation.input.right')
  const mount = sessionId => button.component({
    t: translate(en),
    dsmSessionId: sessionId,
    inputActions: { setDraft: noop, removeAttachment: noop },
  })
  mount('session-42')
  assert.equal(plugin.__internals.openSessionId(), 'session-42')
  mount('session-77')
  assert.equal(plugin.__internals.openSessionId(), 'session-77', 'the newest conversation wins')
})

test('the editor paints a loading state before its record arrives', async () => {
  const plugin = await loadBundle()
  const internals = plugin.__internals
  const t = translate(JSON.parse(read('locale/en.json')))
  globalThis.document = { activeElement: null, visibilityState: 'visible', addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [] }
  globalThis.window = { ...globalThis.window, innerHeight: 800, addEventListener: noop, removeEventListener: noop }
  // First paint: no record, no draft, no instant. This used to throw while
  // formatting the summary and blanked the whole tab on the first click.
  const tree = internals.EditorSheet({
    t,
    zone: 'Asia/Hong_Kong',
    locale: 'en',
    messageId: 'msg-1',
    opener: null,
    onClose: noop,
    onNotice: noop,
  })
  const classNames = []
  const walk = node => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node !== 'object') return
    if (typeof node.props?.className === 'string') classNames.push(node.props.className)
    walk(node.children)
  }
  walk(tree)
  assert.ok(classNames.includes('dsm-sheet'), 'the sheet mounts')
  assert.ok(classNames.some(name => name.includes('dsm-loading')), 'a loading state shows until /get answers')
  assert.ok(!classNames.some(name => name.includes('dsm-summary')), 'no summary is formatted without an instant')
})


test('a destructive question is a blocking alertdialog, not an inline strip', async () => {
  const plugin = await loadBundle()
  const internals = plugin.__internals
  const en = JSON.parse(read('locale/en.json'))
  globalThis.document = { activeElement: null, body: {}, querySelectorAll: () => [] }
  const answers = []
  const tree = internals.ConfirmDialog({
    t: translate(en),
    title: en['editor.discard'],
    body: en['editor.discardBody'],
    confirmLabel: en['editor.discardYes'],
    cancelLabel: en['editor.discardNo'],
    busy: false,
    onConfirm: () => answers.push('discard'),
    onCancel: () => answers.push('keep'),
  })

  const nodes = []
  const walk = node => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node !== 'object') return
    nodes.push(node)
    walk(node.children)
  }
  walk(tree)

  const dialog = nodes.find(node => node.props?.role === 'alertdialog')
  assert.ok(dialog !== undefined, 'the question renders as an alertdialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.ok(nodes.some(node => node.props?.className === 'dsm-confirm-mark'), 'a warning mark carries the weight')
  assert.ok(nodes.some(node => node.type === 'h2' && node.children?.[0] === en['editor.discard']), 'the title asks the question')

  const buttons = nodes.filter(node => node.type === 'button')
  assert.equal(buttons.length, 2, 'two answers, no third way out')
  assert.ok(String(buttons[0].props.className).includes('dsm-btn-ghost'), 'the safe answer stays quiet')
  assert.equal(buttons[0].children?.[0], en['editor.discardNo'])
  assert.ok(String(buttons[1].props.className).includes('dsm-btn-danger'), 'the destructive answer is filled red')
  assert.equal(buttons[1].children?.[0], en['editor.discardYes'])

  dialog.props.onKeyDown({ key: 'Escape', preventDefault: noop, stopPropagation: noop })
  assert.deepEqual(answers, ['keep'], 'Escape keeps the draft')
  buttons[1].props.onClick()
  assert.deepEqual(answers, ['keep', 'discard'])
})

test('the scheduled flash belongs to one conversation and dies with the record', async () => {
  const plugin = await loadBundle()
  const internals = plugin.__internals
  internals.setToast('session-a', 'Scheduled for Nov 15, 2026, 4:10 PM')
  assert.equal(internals.toastFor('session-a'), 'Scheduled for Nov 15, 2026, 4:10 PM')
  assert.equal(internals.toastFor('session-b'), null, 'another conversation never inherits the flash')
  internals.clearToast()
  assert.equal(internals.toastFor('session-a'), null, 'deleting the record drops the flash at once')
})
