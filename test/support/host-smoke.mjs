/**
 * Host smoke test: drive index.js end to end against in-memory services.
 *
 * The storage-domain remap has to be installed before the Host half is
 * imported, so this module registers it and then imports index.js dynamically.
 * Running this file directly prints the summary line test/host.test.mjs greps
 * for; the test file imports runHostSmoke to run the same assertions under
 * node:test instead of spawning a child process.
 *
 * Every assertion is about observable behaviour of the shipped Host half: which
 * routes it owns, what it stores, when it delivers, and what it refuses.
 *
 * @module dsh-scheduled-message/test/support/host-smoke
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createStorageDomainStub } from './storage-domain-stub.mjs'

const PREFIX = '/api/dsh-scheduled-message'

const ROUTES = [
  [PREFIX + '/create', 'POST', 'streaming'],
  [PREFIX + '/list', 'GET', 'buffered'],
  [PREFIX + '/list-all', 'GET', 'buffered'],
  [PREFIX + '/get', 'GET', 'buffered'],
  [PREFIX + '/update', 'POST', 'streaming'],
  [PREFIX + '/upload', 'POST', 'streaming'],
  [PREFIX + '/thumb', 'GET', 'buffered'],
  [PREFIX + '/targets', 'GET', 'buffered'],
  [PREFIX + '/repeating', 'GET', 'buffered'],
  [PREFIX + '/cancel', 'POST', 'buffered'],
  [PREFIX + '/reschedule', 'POST', 'buffered'],
  [PREFIX + '/send-now', 'POST', 'buffered'],
  [PREFIX + '/retry', 'POST', 'buffered'],
]

let assertions = 0

/** Resolve one condition, counting the assertion. */
function ok(condition, message) {
  assertions += 1
  assert.ok(condition, message)
}

/** Compare one value, counting the assertion. */
function equal(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

let hostModule

/**
 * Install the storage-domain remap once, then load the Host half.
 * @returns the Host module.
 */
async function loadHost() {
  if (hostModule === undefined) {
    register(new URL('./stub-loader.mjs', import.meta.url).href)
    hostModule = await import('../../index.js')
  }
  return hostModule
}

/** The workspaces the fake registry serves. */
const WORKSPACES = [
  {
    id: 'ws-a',
    path: 'C:/work/a',
    title: 'Workspace A',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: ['session-a', 'session-b'],
  },
  {
    id: 'ws-b',
    path: 'C:/work/b',
    title: 'Workspace B',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: ['session-c'],
  },
  {
    id: 'ws-c',
    path: 'C:/work/c',
    title: 'Workspace C',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: ['aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-2222-4222-8222-222222222222'],
  },
]

/** Archived session ids the fake registry serves. */
const ARCHIVED = ['bbbbbbbb-2222-4222-8222-222222222222']

/**
 * Build one Host context around in-memory services.
 * @param options - withSchedule and withRegistry switches, both defaulting on.
 * @returns the context, the fakes and the helpers a scenario needs.
 */
function createHost(options = {}) {
  const log = []
  const storageDomain = createStorageDomainStub(log)
  const routes = new Map()
  const prompts = []
  const uploads = []
  const staged = new Map()
  const imageBytes = new Map()
  const fileBytes = new Map()
  const workspaces = options.workspaces ?? WORKSPACES
  const archived = options.archived ?? ARCHIVED
  const state = {
    timer: null,
    promptError: null,
    scheduleTasks: [],
    createCalls: [],
    listCalls: 0,
    listError: null,
    summaries: [],
    uploaded: [],
    scheduleListCalls: [],
    scheduleListError: null,
    scheduleListValue: { items: [], shown: 0, total: 0, limit: 100, offset: 0 },
  }
  let imageSeq = 0

  const sessionController = {
    async resolveAgent(sessionId) {
      if (sessionId === 'missing-session') return { error: { message: 'session missing' } }
      return { agent: { session: { id: sessionId } } }
    },
    async prompt(request) {
      if (state.promptError !== null) {
        const error = state.promptError
        state.promptError = null
        throw error
      }
      prompts.push(request)
      return { accepted: true }
    },
    async create(request) {
      state.createCalls.push(request)
      const sessionId = 'new-session-' + state.createCalls.length
      const workspace = workspaces.find(candidate => candidate.id === request.workspaceId)
      if (workspace !== undefined) workspace.sessionIds = [sessionId, ...workspace.sessionIds]
      return { sessionId }
    },
    async list(_request, _signal) {
      state.listCalls += 1
      if (state.listError !== null) {
        const error = state.listError
        state.listError = null
        throw error
      }
      return { items: state.summaries }
    },
  }

  const attachments = {
    imageLimits: {
      maxImageBytes: 5_000_000,
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 20_000_000,
      maxImagePixels: 40_000_000,
      maxImageDimension: 8_000,
      mediaTypes: ['image/png', 'image/jpeg'],
    },
    async saveImages(inputs) {
      return inputs.map((input) => {
        imageSeq += 1
        const ref = {
          attachmentId: 'image-' + imageSeq,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
          ...(input.name === undefined ? {} : { name: input.name }),
        }
        imageBytes.set(ref.attachmentId, input.data)
        return ref
      })
    },
    async readImage(ref) {
      const data = imageBytes.get(ref.attachmentId)
      if (data === undefined) throw new Error('missing image ' + ref.attachmentId)
      return { ref, data }
    },
    async *readFileStream(ref) {
      const data = fileBytes.get(ref.attachmentId)
      if (data === undefined) throw new Error('missing file ' + ref.attachmentId)
      yield data
    },
    async saveFileStream({ data, name }) {
      const chunks = []
      let total = 0
      for await (const chunk of data) {
        const bytes = Buffer.from(chunk)
        chunks.push(bytes)
        total += bytes.byteLength
      }
      const ref = { attachmentId: 'upload-' + (state.uploaded.length + 1), name: name ?? 'upload.bin', bytes: total }
      fileBytes.set(ref.attachmentId, Buffer.concat(chunks))
      state.uploaded.push(ref)
      return ref
    },
  }

  const fileUploads = {
    resolve(_agent, receiptId) {
      return staged.get(receiptId)
    },
    async uploadStream({ sessionId, data, name }) {
      const chunks = []
      for await (const chunk of data) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const ref = { attachmentId: 'file-' + (fileBytes.size + 1), name: name ?? 'file', bytes: bytes.byteLength }
      fileBytes.set(ref.attachmentId, bytes)
      const receiptId = 'out-receipt-' + (uploads.length + 1)
      staged.set(receiptId, { type: 'file', attachment: ref })
      uploads.push({ sessionId, receiptId })
      return { receiptId, file: ref }
    },
  }

  const schedule = {
    async create(request) {
      state.scheduleTasks.push(request)
      return { id: 'schedule-' + state.scheduleTasks.length }
    },
    async list(request) {
      state.scheduleListCalls.push(request)
      if (state.scheduleListError !== null) {
        const error = state.scheduleListError
        state.scheduleListError = null
        throw error
      }
      return state.scheduleListValue
    },
  }

  const workspaceRegistry = {
    list() {
      return workspaces
    },
    get archivedSessionIds() {
      return archived
    },
  }

  const base = {
    storageDomain,
    sessionController,
    attachments,
    fileUploads,
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => {
            routes.delete(route.path)
          }
        },
      },
    },
    timer: {
      timeout(callback, delay) {
        state.timer = { callback, delay }
        return () => {
          if (state.timer?.callback === callback) state.timer = null
        }
      },
    },
    logger: { warn: message => log.push(['warn', String(message)]) },
    ...(options.withSchedule === false ? {} : { schedule }),
    ...(options.withRegistry === false ? {} : { workspaceRegistry }),
  }

  const ctx = {
    ...base,
    effect(factory) {
      return factory()
    },
    inject(names, callback) {
      const scope = Object.create(ctx)
      scope.inject = (innerNames, innerCallback) => {
        // The Automation service is optional: without it the Host must not run
        // this scope at all, exactly as Cordis waits for a missing service.
        if (innerNames.includes('schedule') && options.withSchedule === false) return undefined
        const inner = Object.create(scope)
        if (innerNames.includes('schedule')) inner.schedule = schedule
        return innerCallback(inner)
      }
      return callback(scope)
    },
    get(name) {
      return ctx[name]
    },
  }

  return {
    ctx,
    state,
    routes,
    prompts,
    uploads,
    staged,
    storageDomain,
    log,
    workspaces,
    /** Stage one inbound file receipt the composer would have uploaded. */
    stageFile(name, text) {
      const ref = { attachmentId: 'in-file-' + (fileBytes.size + 1), name, bytes: Buffer.byteLength(text) }
      fileBytes.set(ref.attachmentId, Buffer.from(text))
      const receiptId = 'in-receipt-' + (staged.size + 1)
      staged.set(receiptId, { type: 'file', attachment: ref })
      return receiptId
    },
  }
}

/** The fake context of one running Host. */
let active = undefined

/** The record table of the running Host. */
function tableOf(host) {
  return host.storageDomain.opened[0].table('messages')
}

/**
 * Wait for one condition, failing the scenario when it never holds.
 * @param predicate - predicate to poll.
 * @param label - what is being waited for.
 * @param timeoutMs - longest wait.
 */
async function until(predicate, label, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Issue one request against a registered route.
 * @param route - registered route.
 * @param options - query suffix or JSON body or raw body.
 * @returns the response.
 */
function call(route, options = {}) {
  const url = 'http://127.0.0.1' + route.path + (options.query ?? '')
  const init = { method: route.methods[0] }
  if (options.raw !== undefined) {
    init.body = options.raw
    init.headers = { 'content-type': 'application/octet-stream' }
  } else if (options.json !== undefined) {
    init.body = options.json
    init.headers = { 'content-type': 'application/json' }
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers = { 'content-type': 'application/json' }
  }
  return route.fetch(new Request(url, init))
}

/**
 * Call one route and decode its JSON envelope.
 * @param route - registered route.
 * @param options - query suffix, JSON body or raw body.
 * @returns the envelope.
 */
async function body(route, options) {
  const response = await call(route, options)
  return await response.json()
}

/**
 * One registered route, asserting it exists.
 * @param routes - route map.
 * @param path - route path.
 * @returns the route.
 */
function routeOf(routes, path) {
  const route = routes.get(path)
  assert.ok(route !== undefined, 'route ' + path + ' is not registered')
  return route
}

/**
 * Fire the armed timer once, as the Host's own callback would.
 * @param host - running Host.
 */
async function fireWhenArmed(host) {
  await until(() => host.state.timer !== null, 'a timer to be armed')
  const armed = host.state.timer
  host.state.timer = null
  armed.callback()
}

/** Create one record through /create. */
async function schedule(host, overrides = {}) {
  const created = await body(routeOf(host.routes, PREFIX + '/create'), {
    body: {
      sessionId: overrides.sessionId ?? 'session-a',
      dueAt: overrides.dueAt ?? new Date(Date.now() + 120_000).toISOString(),
      timeZone: overrides.timeZone ?? 'Asia/Hong_Kong',
      text: overrides.text ?? 'text',
      ...(overrides.images === undefined ? {} : { images: overrides.images }),
      ...(overrides.fileReceipts === undefined ? {} : { fileReceipts: overrides.fileReceipts }),
      ...(overrides.repeat === undefined ? {} : { repeat: overrides.repeat }),
    },
  })
  if (created.ok !== true) return { created }
  if (created.value.kind !== 'once') return { created }
  const id = created.value.message.id
  if (overrides.duePast === true || overrides.status !== undefined) {
    const table = tableOf(host)
    const current = table.get(id)
    await table.put(id, {
      ...current,
      ...(overrides.status === undefined ? {} : { status: overrides.status }),
      ...(overrides.duePast === true ? { dueAt: new Date(Date.now() - 1000).toISOString() } : {}),
    })
  }
  return { created, id }
}

/** Push one stored record into the past, keeping everything else. */
async function makeDue(host, id, extra = {}) {
  const table = tableOf(host)
  await table.put(id, { ...table.get(id), ...extra, dueAt: new Date(Date.now() - 1000).toISOString() })
}

/** Read the current stored record, asserting it exists. */
function stored(host, id) {
  const record = tableOf(host).get(id)
  assert.ok(record !== undefined, 'record ' + id + ' is stored')
  return record
}

/**
 * Run the whole Host scenario.
 * @returns the number of assertions that passed.
 */
export async function runHostSmoke() {
  const { apply } = await loadHost()
  assertions = 0

  const host = createHost()
  active = host
  apply(host.ctx)

  // 1. Routes.
  equal([...host.routes.keys()].sort(), ROUTES.map(([path]) => path).sort(), 'the Host owns exactly thirteen routes')
  for (const [path, method, mode] of ROUTES) {
    const route = routeOf(host.routes, path)
    ok(route.methods.includes(method), path + ' accepts ' + method)
    equal(route.requestBody, mode, path + ' body mode')
  }

  await until(() => host.storageDomain.opened.length > 0, 'the durable domain to open')
  const table = tableOf(host)
  const created = (path) => routeOf(host.routes, PREFIX + path)

  // 2. The domain declares the v2 shape and still opens v1 records.
  const openedSpec = host.storageDomain.opened[0].spec
  equal(openedSpec.version, 2, 'the domain is version 2')
  equal(openedSpec.compatibleVersions, [1], 'v1 records stay readable')

  // 3. Rejections before any durable write.
  const createRoute = created('/create')
  const tooSoon = await body(createRoute, {
    body: { sessionId: 'session-a', dueAt: new Date(Date.now() + 5_000).toISOString(), timeZone: 'Asia/Hong_Kong', text: 'hi' },
  })
  equal(tooSoon.error?.code, 'too-soon', 'a time under thirty seconds ahead is refused')

  const empty = await body(createRoute, {
    body: { sessionId: 'session-a', dueAt: new Date(Date.now() + 60_000).toISOString(), timeZone: 'Asia/Hong_Kong', text: '   ' },
  })
  equal(empty.error?.code, 'empty', 'an empty message is refused')

  const badZone = await body(createRoute, {
    body: { sessionId: 'session-a', dueAt: new Date(Date.now() + 60_000).toISOString(), timeZone: 'Mars/Olympus', text: 'hi' },
  })
  equal(badZone.error?.code, 'invalid-time-zone', 'an unknown zone is refused')

  const unknownSession = await body(createRoute, {
    body: { sessionId: 'missing-session', dueAt: new Date(Date.now() + 60_000).toISOString(), timeZone: 'UTC', text: 'hi' },
  })
  equal(unknownSession.error?.code, 'unknown-session', 'a conversation that cannot be resolved is refused')

  const repeatWithImage = await body(createRoute, {
    body: {
      sessionId: 'session-a',
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      timeZone: 'UTC',
      text: 'hi',
      repeat: 'daily',
      images: [{ mediaType: 'image/png', data: Buffer.from('png').toString('base64') }],
    },
  })
  equal(repeatWithImage.error?.code, 'repeat-with-attachments', 'Repeat refuses attachments')

  const unknownReceipt = await body(createRoute, {
    body: { sessionId: 'session-a', dueAt: new Date(Date.now() + 60_000).toISOString(), timeZone: 'UTC', text: 'hi', fileReceipts: ['nope'] },
  })
  equal(unknownReceipt.error?.code, 'unknown-receipt', 'a receipt the Host never staged is refused')

  equal(table.size, 0, 'no refused request wrote a record')

  // 4. Create a text-only one-shot.
  const first = await schedule(host, { text: '  hello there  ' })
  equal(first.created.ok, true, 'a text-only message is accepted')
  equal(first.created.value.kind, 'once', 'it is a one-shot')
  equal(first.created.value.message.text, 'hello there', 'the stored text is trimmed')
  equal(first.created.value.message.status, 'pending', 'the record starts pending')
  equal(first.created.value.message.target, { kind: 'session', sessionId: 'session-a' }, 'a created record carries a v2 target')
  ok(host.state.timer !== null, 'a timer is armed for it')

  const listed = await body(created('/list'), { query: '?sessionId=session-a' })
  equal(listed.value.items.length, 1, 'the strip lists the pending record')
  equal(listed.value.items[0].id, first.id, 'the list names the created record')
  const otherSession = await body(created('/list'), { query: '?sessionId=session-b' })
  equal(otherSession.value.items.length, 0, 'another conversation does not see it')

  // 5. Delivery.
  await makeDue(host, first.id)
  await fireWhenArmed(host)
  await until(() => table.get(first.id)?.status === 'sent', 'the record to be sent')
  equal(host.prompts.length, 1, 'exactly one prompt was delivered')
  equal(host.prompts[0].requestId, 'dsm-' + first.id, 'the request id is derived from the record id')
  equal(host.prompts[0].mode, 'queue', 'delivery queues behind a running agent instead of steering it')
  equal(host.prompts[0].clientTimeZone, 'Asia/Hong_Kong', 'the captured zone is replayed')
  equal(host.prompts[0].content, [{ type: 'text', text: 'hello there' }], 'the text arrives unchanged')
  equal(table.get(first.id).late, false, 'an on-time delivery is not marked late')
  ok(typeof table.get(first.id).sentAt === 'string', 'the record keeps its send time')

  // 6. A failed delivery is reported, then retried with the same request id.
  const failing = await schedule(host, { text: 'fail me', duePast: true })
  host.state.promptError = Object.assign(new Error('the agent refused'), { code: 'session/refused' })
  await fireWhenArmed(host)
  await until(() => table.get(failing.id)?.status === 'failed', 'the failure to be stored')
  ok(String(table.get(failing.id).error).includes('session/refused'), 'the diagnostic reaches the record')

  const retried = await body(created('/retry'), { body: { id: failing.id } })
  equal(retried.ok, true, 'a failed record can be retried')
  await until(() => table.get(failing.id)?.status === 'sent', 'the retry to settle')
  equal(host.prompts.at(-1).requestId, 'dsm-' + failing.id, 'the retry reuses the record request id')

  // 7. Send now, then cancel.
  const immediate = await schedule(host, { text: 'right away' })
  const sentNow = await body(created('/send-now'), { body: { id: immediate.id } })
  equal(sentNow.value.message.status, 'sent', 'Send now delivers immediately')
  equal(host.prompts.at(-1).content[0].text, 'right away', 'Send now carries the stored text')

  const doomed = await schedule(host, { text: 'never' })
  const cancelled = await body(created('/cancel'), { body: { id: doomed.id } })
  equal(cancelled.value.message.status, 'cancelled', 'Cancel stops a pending record')
  const afterCancel = await body(created('/list'), { query: '?sessionId=session-a' })
  ok(!afterCancel.value.items.some(item => item.id === doomed.id), 'a cancelled record leaves the strip')

  const cancelSettled = await body(created('/cancel'), { body: { id: immediate.id } })
  equal(cancelSettled.error?.code, 'not-pending', 'a settled record refuses further mutations')
  const cancelUnknown = await body(created('/cancel'), { body: { id: 'nope' } })
  equal(cancelUnknown.error?.code, 'not-found', 'an unknown record is reported')

  // 8. Rescheduling moves the stored instant and refuses a stale one.
  const movable = await schedule(host, { text: 'move me' })
  const target = new Date(Date.now() + 3_600_000).toISOString()
  const moved = await body(created('/reschedule'), { body: { id: movable.id, dueAt: target } })
  equal(moved.value.message.dueAt, target, 'the new instant is stored')
  const staleMove = await body(created('/reschedule'), {
    body: { id: movable.id, dueAt: new Date(Date.now() + 1000).toISOString() },
  })
  equal(staleMove.error?.code, 'too-soon', 'a new instant under thirty seconds ahead is refused')
  await body(created('/cancel'), { body: { id: movable.id } })

  // 9. Crash recovery: a record left in sending is delivered at startup.
  const crashed = await schedule(host, { text: 'after crash', status: 'sending', duePast: true })
  await fireWhenArmed(host)
  await until(() => table.get(crashed.id)?.status === 'sent', 'the crash-left record to settle')
  equal(host.prompts.at(-1).requestId, 'dsm-' + crashed.id, 'the recovered delivery keeps its request id')

  // 10. Images and files survive to delivery.
  const imageBase64 = Buffer.from('image-bytes').toString('base64')
  const fileReceipt = host.stageFile('note.txt', 'file-bytes')
  const attached = await schedule(host, {
    text: 'look',
    images: [{ mediaType: 'image/png', data: imageBase64, name: 'shot.png' }],
    fileReceipts: [fileReceipt],
    duePast: true,
  })
  equal(attached.created.ok, true, 'a message with an image and a file is accepted')
  equal(attached.created.value.message.imageCount, 1, 'the record counts one image')
  equal(attached.created.value.message.fileCount, 1, 'the record counts one file')
  equal(attached.created.value.message.images[0].attachmentId, 'image-1', 'the wire record carries the image ref')
  await fireWhenArmed(host)
  await until(() => table.get(attached.id)?.status === 'sent', 'the attachment message to settle')
  const content = host.prompts.at(-1).content
  equal(content[0].text, 'look', 'the text is still first')
  equal(content[1].type, 'image', 'the image part is rebuilt')
  equal(content[1].data, imageBase64, 'the stored image bytes are re-encoded')
  equal(content[1].name, 'shot.png', 'the display name survives')
  equal(content[2].type, 'file', 'the file part is re-staged')
  equal(content[2].receiptId, 'out-receipt-1', 'the file is uploaded again and cited by receipt')
  equal(host.uploads[0].sessionId, 'session-a', 'the file is uploaded against the target session')

  // 11. Repeat creates an automation task instead of a record.
  const before = table.size
  const automation = await schedule(host, { text: 'stand up', repeat: 'weekdays' })
  equal(automation.created.value.kind, 'automation', 'Repeat answers with an automation task')
  equal(table.size, before, 'Repeat writes no scheduled-message record')
  equal(host.state.scheduleTasks.length, 1, 'one automation task was created')
  const task = host.state.scheduleTasks[0]
  equal(task.title, 'stand up', 'the title summarises the message')
  equal(task.target, { kind: 'session', sessionId: 'session-a' }, 'the task delivers to the same conversation')
  ok(task.timing.rrule.startsWith('DTSTART;TZID=Asia/Hong_Kong:'), 'the rule pins the chosen zone')
  ok(task.timing.rrule.includes('BYDAY=MO,TU,WE,TH,FR'), 'weekdays map onto BYDAY')

  // 11b. /repeating lists session-targeted Automation tasks read-only.
  const repeatingRoute = created('/repeating')
  host.state.scheduleListValue = {
    items: [
      {
        id: 'task-b',
        kind: 'rrule',
        title: 'Beta',
        rrule: 'RRULE:FREQ=DAILY',
        status: 'active',
        target: { kind: 'session', sessionId: 'session-a' },
      },
      {
        id: 'task-a',
        kind: 'rrule',
        title: 'Alpha',
        rrule: 'RRULE:FREQ=WEEKLY',
        status: 'paused',
        target: { kind: 'session', sessionId: 'session-b' },
      },
      { id: 'task-c', kind: 'after', title: 'Reserved conversation', status: 'active', target: { kind: 'new_once', sessionId: 'reserved' } },
      { id: 'task-d', kind: 'at', title: 'Fresh conversation each time', status: 'active', target: { kind: 'new', create: {} } },
      { title: 'no identity', status: 'active', target: { kind: 'session', sessionId: 'session-a' } },
      { id: 'task-e', status: 'active', target: { kind: 'session', sessionId: 'session-a' } },
      null,
    ],
    shown: 7,
    total: 7,
    limit: 100,
    offset: 0,
  }
  const repeating = await body(repeatingRoute, {})
  equal(repeating.ok, true, '/repeating answers a value')
  equal(repeating.value.available, true, 'the Automation service is reported available')
  equal(repeating.value.items.map(item => item.id), ['task-a', 'task-b'], 'only session-targeted tasks are listed, ordered by title then id')
  equal(repeating.value.items[0],
    { id: 'task-a', title: 'Alpha', targetSessionId: 'session-b', rrule: 'RRULE:FREQ=WEEKLY', enabled: false },
    'a paused task maps to exactly the documented fields')
  equal(repeating.value.items[1],
    { id: 'task-b', title: 'Beta', targetSessionId: 'session-a', rrule: 'RRULE:FREQ=DAILY', enabled: true },
    'an active task maps to exactly the documented fields')
  const manyTasks = []
  for (let index = 0; index < 60; index += 1) {
    manyTasks.push({
      id: 'bulk-' + index,
      kind: 'rrule',
      title: 'task-' + String(index).padStart(2, '0'),
      rrule: 'RRULE:FREQ=DAILY',
      status: 'active',
      target: { kind: 'session', sessionId: 'session-a' },
    })
  }
  host.state.scheduleListValue = { items: manyTasks, shown: 60, total: 60, limit: 100, offset: 0 }
  const cappedRepeating = await body(repeatingRoute, {})
  equal(cappedRepeating.value.items.length, 50, '/repeating caps the list at fifty')
  equal(cappedRepeating.value.items.at(-1).title, 'task-49', 'the cap keeps the first fifty by title')
  host.state.scheduleListError = new Error('the schedule service is unavailable')
  const failedRepeating = await body(repeatingRoute, {})
  equal(failedRepeating.ok, true, 'a failing listing is still an envelope')
  equal(failedRepeating.value, { available: false, items: [] }, 'a failing listing reports unavailability')
  host.state.scheduleListValue = { items: [], shown: 0, total: 0, limit: 100, offset: 0 }

  // 12. A keeper record keeps a timer armed for the rest of the scenario.
  const keeper = await schedule(host, { text: 'keeper' })

  // 13. /get returns one record whatever its status.
  equal((await body(created('/get'), { query: '' })).error?.code, 'invalid-id', '/get needs an id')
  equal((await body(created('/get'), { query: '?id=' })).error?.code, 'invalid-id', 'an empty id is refused')
  equal((await body(created('/get'), { query: '?id=nope' })).error?.code, 'not-found', 'an unknown id is reported')
  const gotFirst = await body(created('/get'), { query: '?id=' + first.id })
  equal(gotFirst.value.message.id, first.id, '/get returns a settled record')
  equal(gotFirst.value.message.target, { kind: 'session', sessionId: 'session-a' }, '/get carries the target')
  ok(typeof gotFirst.value.now === 'number', '/get reports its reading clock')
  const gotKeeper = await body(created('/get'), { query: '?id=' + keeper.id })
  equal(gotKeeper.value.message.targetLabel.workspaceTitle, 'Workspace A', '/get labels the workspace')

  // 14. /list-all filters, orders and labels.
  const listed2 = await body(created('/list-all'), { query: '?scope=all' })
  ok(listed2.value.items.length >= 5, 'list-all returns every visible record')
  const dues = listed2.value.items.map(item => Date.parse(item.dueAt))
  equal(dues, [...dues].sort((left, right) => left - right), 'list-all is ordered by dueAt ascending')
  ok(listed2.value.items.some(item => item.status === 'cancelled'), 'a cancelled record inside the window is listed')
  ok(listed2.value.items.some(item => item.status === 'sent'), 'a sent record inside the window is listed')
  ok(listed2.value.items.every(item => item.target.kind === 'session' || item.target.kind === 'new'), 'every row carries a target')
  equal((await body(created('/list-all'), { query: '?scope=nope' })).error?.code, 'invalid-request', 'an unknown scope is refused')
  equal((await body(created('/list-all'), { query: '?scope=workspace' })).error?.code, 'invalid-request', 'scope=workspace needs a workspaceId')
  equal((await body(created('/list-all'), { query: '?scope=workspace&workspaceId=ws-missing' })).value.items, [], 'an unknown workspace selects nothing')
  const scoped = await body(created('/list-all'), { query: '?scope=workspace&workspaceId=ws-a' })
  ok(scoped.value.items.length > 0, 'the workspace scope keeps its own records')
  ok(scoped.value.items.every(item => item.sessionId === 'session-a'), 'the workspace scope excludes other conversations')
  equal(scoped.value.items[0].targetLabel.workspaceTitle, 'Workspace A', 'a scoped row names its workspace')
  const otherWorkspace = await body(created('/list-all'), { query: '?scope=workspace&workspaceId=ws-b' })
  equal(otherWorkspace.value.items, [], 'another workspace selects nothing yet')

  // 15. A settled record leaves the tab after 24 h but stays readable.
  await table.put(first.id, { ...table.get(first.id), sentAt: new Date(Date.now() - 25 * 3_600_000).toISOString() })
  const aged = await body(created('/list-all'), { query: '?scope=all' })
  ok(!aged.value.items.some(item => item.id === first.id), 'a sent record older than 24 h leaves the tab')
  const agedGet = await body(created('/get'), { query: '?id=' + first.id })
  equal(agedGet.value.message.id, first.id, '/get still returns an aged record')

  // 16. /update merges, refuses staleness and re-validates the result.
  const updateRoute = created('/update')
  const editable = await schedule(host, { text: 'edit me' })
  const editableBefore = stored(host, editable.id)
  const newDue = new Date(Date.now() + 7_200_000).toISOString()
  const edited = await body(updateRoute, {
    body: { id: editable.id, expectedUpdatedAt: editableBefore.updatedAt, dueAt: newDue, text: '  edited text  ' },
  })
  equal(edited.ok, true, '/update accepts a text and time change')
  equal(edited.value.message.text, 'edited text', 'the edited text is trimmed and stored')
  equal(edited.value.message.dueAt, newDue, 'the edited instant is stored')
  ok(Date.parse(edited.value.message.updatedAt) > Date.parse(editableBefore.updatedAt), 'updatedAt strictly increases')
  ok(typeof edited.value.now === 'number', '/update reports its reading clock')

  const conflict = await body(updateRoute, {
    body: { id: editable.id, expectedUpdatedAt: editableBefore.updatedAt, text: 'later' },
  })
  equal(conflict.error?.code, 'conflict', 'a stale edit is refused')
  equal(stored(host, editable.id).text, 'edited text', 'a refused edit never overwrites')

  const current = stored(host, editable.id)
  equal((await body(updateRoute, { body: { id: editable.id, expectedUpdatedAt: current.updatedAt } })).error?.code,
    'nothing-to-update', 'an empty edit is refused')
  equal((await body(updateRoute, {
    body: { id: editable.id, expectedUpdatedAt: current.updatedAt, dueAt: new Date(Date.now() + 1000).toISOString() },
  })).error?.code, 'too-soon', 'an edit into the next thirty seconds is refused')
  equal((await body(updateRoute, {
    body: { id: editable.id, expectedUpdatedAt: current.updatedAt, target: { kind: 'new', cwd: 'relative/path' } },
  })).error?.code, 'invalid-target', 'a relative cwd is refused')
  equal((await body(updateRoute, {
    body: { id: 'missing', expectedUpdatedAt: new Date().toISOString(), text: 'x' },
  })).error?.code, 'not-found', 'an unknown record is reported')
  equal((await body(updateRoute, {
    body: { id: first.id, expectedUpdatedAt: stored(host, first.id).updatedAt, text: 'x' },
  })).error?.code, 'not-pending', 'a settled record refuses an edit')

  // 17. Removing the last attachment and the text leaves nothing to send.
  const imageOnly = await schedule(host, { text: 'has image', images: [{ mediaType: 'image/png', data: imageBase64 }] })
  const imageOnlyStored = stored(host, imageOnly.id)
  equal(imageOnlyStored.images.length, 1, 'the record holds one image')
  const imageId = imageOnlyStored.images[0].attachmentId
  const emptied = await body(updateRoute, {
    body: { id: imageOnly.id, expectedUpdatedAt: imageOnlyStored.updatedAt, text: '', removeAttachmentIds: [imageId] },
  })
  equal(emptied.error?.code, 'empty', 'an edit that leaves nothing to send is refused')
  const removed = await body(updateRoute, {
    body: { id: imageOnly.id, expectedUpdatedAt: imageOnlyStored.updatedAt, removeAttachmentIds: [imageId] },
  })
  equal(removed.ok, true, 'removing an attachment is accepted')
  equal(removed.value.message.images.length, 0, 'the removed image leaves the record')
  equal(removed.value.message.text, 'has image', 'the text survives the removal')
  const ignoredRemoval = await body(updateRoute, {
    body: { id: imageOnly.id, expectedUpdatedAt: removed.value.message.updatedAt, removeAttachmentIds: ['nothing-here'] },
  })
  equal(ignoredRemoval.ok, true, 'an unmatched attachment id is ignored')

  // 18. Moving a record moves it between strips.
  const movedRecord = await body(updateRoute, {
    body: { id: imageOnly.id, expectedUpdatedAt: ignoredRemoval.value.message.updatedAt, target: { kind: 'session', sessionId: 'session-b' } },
  })
  equal(movedRecord.value.message.target, { kind: 'session', sessionId: 'session-b' }, 'the target is replaced')
  equal(movedRecord.value.message.sessionId, 'session-b', 'the resolved session follows the target')
  const stripB = await body(created('/list'), { query: '?sessionId=session-b' })
  ok(stripB.value.items.some(item => item.id === imageOnly.id), 'a moved record joins the new strip')
  const stripA = await body(created('/list'), { query: '?sessionId=session-a' })
  ok(!stripA.value.items.some(item => item.id === imageOnly.id), 'a moved record leaves the old strip')

  // 18b. Images are appended, and the remaining update codes are reported.
  const appendedImage = await body(updateRoute, {
    body: {
      id: imageOnly.id,
      expectedUpdatedAt: movedRecord.value.message.updatedAt,
      addImages: [{ mediaType: 'image/png', data: imageBase64, name: 'added.png' }],
    },
  })
  equal(appendedImage.ok, true, 'an added image is accepted')
  equal(appendedImage.value.message.images.length, 1, 'the added image is appended to the record')
  equal(appendedImage.value.message.images[0].name, 'added.png', 'the added image keeps its name')
  equal((await body(updateRoute, { body: { expectedUpdatedAt: new Date().toISOString(), text: 'x' } })).error?.code,
    'invalid-id', '/update needs an id')
  equal((await body(updateRoute, {
    body: {
      id: imageOnly.id,
      expectedUpdatedAt: appendedImage.value.message.updatedAt,
      text: 'x'.repeat(200_001),
    },
  })).error?.code, 'text-too-long', 'an over-long text is refused')
  equal((await body(updateRoute, {
    body: { id: imageOnly.id, expectedUpdatedAt: appendedImage.value.message.updatedAt, addImages: [{ mediaType: 'image/png' }] },
  })).error?.code, 'invalid-images', 'an image without bytes is refused')

  // 19. /upload stores bytes and turns away an empty or missing body.
  const uploadRoute = created('/upload')
  const uploaded = await body(uploadRoute, { raw: Buffer.from('file-bytes-here'), query: '?name=' + encodeURIComponent('spec.pdf') })
  equal(uploaded.ok, true, '/upload accepts a file')
  equal(uploaded.value.name, 'spec.pdf', 'the display name round-trips')
  equal(uploaded.value.bytes, 15, 'the byte count is exact')
  ok(typeof uploaded.value.fileId === 'string', 'the file id is an attachment id')
  equal((await body(uploadRoute, {})).error?.code, 'invalid-request', 'an upload without a body is refused')
  equal((await body(uploadRoute, { raw: Buffer.alloc(0), query: '?name=empty.bin' })).error?.code,
    'empty-body', 'an empty upload is refused')

  // 20. The staged table is bounded; the oldest upload stops being claimable.
  const uploadIds = []
  for (let index = 0; index < 201; index += 1) {
    const one = await body(uploadRoute, { raw: Buffer.from('u' + index), query: '?name=f' + index + '.bin' })
    uploadIds.push(one.value.fileId)
  }
  const fileHosted = await schedule(host, { text: 'file target' })
  const fileHostedStored = stored(host, fileHosted.id)
  const evicted = await body(updateRoute, {
    body: { id: fileHosted.id, expectedUpdatedAt: fileHostedStored.updatedAt, addFileIds: [uploaded.value.fileId] },
  })
  equal(evicted.error?.code, 'unknown-file', 'an upload older than the bound is no longer claimable')
  const fileAdded = await body(updateRoute, {
    body: { id: fileHosted.id, expectedUpdatedAt: fileHostedStored.updatedAt, addFileIds: [uploadIds.at(-1)] },
  })
  equal(fileAdded.ok, true, 'a staged upload is claimable')
  equal(fileAdded.value.message.files.length, 1, 'the claimed file joins the record')
  equal(fileAdded.value.message.files[0].name, 'f200.bin', 'the claimed file keeps its name')
  equal(fileAdded.value.message.files[0].bytes, 4, 'the claimed file keeps its size')

  // 21. /thumb serves the stored image bytes and 404s otherwise.
  const thumbRoute = created('/thumb')
  const thumbRecord = await schedule(host, { text: 'thumbs', images: [{ mediaType: 'image/png', data: imageBase64 }] })
  const thumbRef = stored(host, thumbRecord.id).images[0]
  const thumbResponse = await call(thumbRoute, { query: '?id=' + thumbRecord.id + '&attachmentId=' + thumbRef.attachmentId })
  equal(thumbResponse.status, 200, '/thumb answers the image')
  equal(thumbResponse.headers.get('content-type'), 'image/png', '/thumb reports the stored media type')
  equal(thumbResponse.headers.get('cache-control'), 'private, max-age=3600', '/thumb is privately cacheable')
  equal(Buffer.from(await thumbResponse.arrayBuffer()).toString(), 'image-bytes', '/thumb serves the stored bytes')
  const unknownThumb = await call(thumbRoute, { query: '?id=' + thumbRecord.id + '&attachmentId=nope' })
  equal(unknownThumb.status, 404, 'an unknown attachment is a 404')
  equal((await unknownThumb.json()).error.code, 'not-found', 'the 404 keeps the JSON envelope')
  const unknownRecordThumb = await call(thumbRoute, { query: '?id=nope&attachmentId=nope' })
  equal(unknownRecordThumb.status, 404, 'an unknown record is a 404')
  equal((await body(thumbRoute, { query: '?id=x' })).error?.code, 'invalid-request', '/thumb needs both parameters')

  // 22. /targets names workspaces and their live conversations.
  const targets = await body(created('/targets'), {})
  equal(targets.value.workspaces.length, 3, '/targets lists every workspace')
  const wsA = targets.value.workspaces.find(item => item.id === 'ws-a')
  equal(wsA.title, 'Workspace A', 'a workspace carries its title')
  equal(wsA.path, 'C:/work/a', 'a workspace carries its path')
  const wsC = targets.value.workspaces.find(item => item.id === 'ws-c')
  equal(wsC.sessions.map(item => item.id), ['aaaaaaaa-1111-4111-8111-111111111111'], 'an archived conversation is filtered out')
  equal(wsC.sessions[0].label, 'aaaaaaaa', 'a conversation without a title is labelled by its short id')
  equal(wsC.sessions[0].title, undefined, 'no title is invented')
  host.state.summaries = [
    { sessionId: 'session-a', updatedAt: 1000, running: false, blank: false, agentAvailable: true },
    { sessionId: 'session-b', updatedAt: 5000, running: true, blank: true, agentAvailable: true },
    { sessionId: 'session-c', updatedAt: 3000, running: false, blank: false, agentAvailable: true },
  ]
  const joined = await body(created('/targets'), {})
  const joinedA = joined.value.workspaces.find(item => item.id === 'ws-a')
  equal(joinedA.sessions.map(item => item.id), ['session-b', 'session-a'], 'conversations are newest first')
  equal(joinedA.sessions[0].running, true, 'the running flag is joined from the summary')
  equal(joinedA.sessions[0].blank, true, 'the blank flag is joined from the summary')
  equal(joinedA.sessions[0].updatedAt, 5000, 'the activity instant is joined from the summary')
  host.state.listError = new Error('session listing unavailable')
  const degraded = await body(created('/targets'), {})
  const degradedA = degraded.value.workspaces.find(item => item.id === 'ws-a')
  equal(degradedA.sessions.map(item => item.id), ['session-a', 'session-b'], 'without a listing the ids and their order survive')
  ok(degradedA.sessions.every(item => item.updatedAt === undefined && item.running === undefined && item.blank === undefined),
    'without a listing the joined fields are omitted')
  host.state.summaries = []

  // 23. A kind-new record opens its conversation once and names it before prompting.
  const herald = await schedule(host, { text: 'new conversation' })
  const heraldBefore = stored(host, herald.id)
  const toNew = await body(updateRoute, {
    body: { id: herald.id, expectedUpdatedAt: heraldBefore.updatedAt, target: { kind: 'new', cwd: 'C:/work/a', workspaceId: 'ws-a' } },
  })
  equal(toNew.value.message.target.kind, 'new', 'the record now targets a new conversation')
  equal(toNew.value.message.sessionId, undefined, 'a new-conversation record owns no session yet')
  const newScoped = await body(created('/list-all'), { query: '?scope=workspace&workspaceId=ws-a' })
  ok(newScoped.value.items.some(item => item.id === herald.id), 'an unopened new-conversation record belongs to its workspace')

  await makeDue(host, herald.id)
  const createsBefore = host.state.createCalls.length
  await fireWhenArmed(host)
  await until(() => table.get(herald.id)?.status === 'sent', 'the new-conversation message to settle')
  equal(host.state.createCalls.length, createsBefore + 1, 'one conversation is created')
  equal(host.state.createCalls.at(-1), { workspaceId: 'ws-a' }, 'the named workspace wins and cwd is not sent with it')
  const heraldSession = stored(host, herald.id).sessionId
  ok(typeof heraldSession === 'string', 'the created session id is stored on the record')
  equal(host.prompts.at(-1).sessionId, heraldSession, 'the message is prompted into the new conversation')
  equal(host.prompts.at(-1).requestId, 'dsm-' + herald.id, 'the delivery keeps its request id')

  // 24. A crash after session creation reuses the conversation.
  const crashedNew = await schedule(host, { text: 'crash after create' })
  const crashedNewBefore = stored(host, crashedNew.id)
  await body(updateRoute, {
    body: { id: crashedNew.id, expectedUpdatedAt: crashedNewBefore.updatedAt, target: { kind: 'new', cwd: 'C:/work/a' } },
  })
  await makeDue(host, crashedNew.id)
  host.state.promptError = new Error('the agent refused the new conversation')
  const createsCrash = host.state.createCalls.length
  await fireWhenArmed(host)
  await until(() => table.get(crashedNew.id)?.status === 'failed', 'the failed new-conversation delivery')
  equal(host.state.createCalls.length, createsCrash + 1, 'the conversation was created once')
  const persisted = stored(host, crashedNew.id).sessionId
  ok(typeof persisted === 'string', 'the session id is durable before the prompt')
  ok(String(stored(host, crashedNew.id).error).includes('refused'), 'the readable reason is stored')
  const retriedNew = await body(created('/retry'), { body: { id: crashedNew.id } })
  equal(retriedNew.ok, true, 'the failed new-conversation record can be retried')
  await until(() => table.get(crashedNew.id)?.status === 'sent', 'the retried new-conversation delivery')
  equal(host.state.createCalls.length, createsCrash + 1, 'the retry reuses the conversation instead of creating another')
  equal(host.prompts.at(-1).sessionId, persisted, 'the retry prompts the stored conversation')
  equal(host.prompts.at(-1).requestId, 'dsm-' + crashedNew.id, 'the retry keeps one request id')

  // 25. A record left between creation and prompt is finished, not recreated.
  const halfDone = await schedule(host, { text: 'half done' })
  await table.put(halfDone.id, {
    ...stored(host, halfDone.id),
    target: { kind: 'new', cwd: 'C:/work/a' },
    sessionId: 'session-already-created',
    status: 'sending',
    dueAt: new Date(Date.now() - 1000).toISOString(),
  })
  const createsHalf = host.state.createCalls.length
  await fireWhenArmed(host)
  await until(() => table.get(halfDone.id)?.status === 'sent', 'the half-delivered record to settle')
  equal(host.state.createCalls.length, createsHalf, 'a stored session id is never created again')
  equal(host.prompts.at(-1).sessionId, 'session-already-created', 'the stored conversation receives the message')

  // 26. An archived or vanished destination fails with a reason instead of throwing.
  const archivedTarget = await schedule(host, { text: 'archived target' })
  await makeDue(host, archivedTarget.id, { target: { kind: 'session', sessionId: ARCHIVED[0] } })
  await fireWhenArmed(host)
  await until(() => table.get(archivedTarget.id)?.status === 'failed', 'the archived target to fail')
  ok(String(stored(host, archivedTarget.id).error).includes('archived'), 'an archived conversation is reported')
  equal(host.prompts.filter(item => item.sessionId === ARCHIVED[0]).length, 0, 'nothing is prompted to an archived conversation')

  const goneWorkspace = await schedule(host, { text: 'gone workspace' })
  await table.put(goneWorkspace.id, {
    ...stored(host, goneWorkspace.id),
    target: { kind: 'new', cwd: 'C:/gone', workspaceId: 'ws-gone' },
    sessionId: undefined,
  })
  await makeDue(host, goneWorkspace.id)
  const createsGone = host.state.createCalls.length
  await fireWhenArmed(host)
  await until(() => table.get(goneWorkspace.id)?.status === 'failed', 'the vanished workspace to fail')
  ok(String(stored(host, goneWorkspace.id).error).includes('workspace'), 'a vanished workspace is reported')
  equal(host.state.createCalls.length, createsGone, 'no conversation is created for a vanished workspace')

  // 27. A record stored by v1 opens, lists and delivers after the upgrade.
  const legacyId = 'legacy-record-1'
  const legacyIso = new Date(Date.now() - 60_000).toISOString()
  tableOf(host).putRaw(legacyId, {
    id: legacyId,
    sessionId: 'session-a',
    dueAt: new Date(Date.now() - 1000).toISOString(),
    timeZone: 'Asia/Hong_Kong',
    text: 'from v1',
    images: [],
    files: [],
    createdAt: legacyIso,
    updatedAt: legacyIso,
    status: 'pending',
  })
  const legacyRead = stored(host, legacyId)
  equal(legacyRead.target, { kind: 'session', sessionId: 'session-a' }, 'a v1 record is migrated to a session target')
  equal(legacyRead.sessionId, 'session-a', 'the migrated record still names its conversation')
  const legacyStrip = await body(created('/list'), { query: '?sessionId=session-a' })
  ok(legacyStrip.value.items.some(item => item.id === legacyId), 'a v1 record joins the strip')
  const legacyGet = await body(created('/get'), { query: '?id=' + legacyId })
  equal(legacyGet.value.message.id, legacyId, 'a v1 record is readable through /get')
  await fireWhenArmed(host)
  await until(() => table.get(legacyId)?.status === 'sent', 'the v1 record to be delivered')
  equal(host.prompts.at(-1).requestId, 'dsm-' + legacyId, 'a v1 record delivers with the same request id')
  equal(host.prompts.at(-1).content, [{ type: 'text', text: 'from v1' }], 'a v1 record delivers its text')
  equal(stored(host, legacyId).target, { kind: 'session', sessionId: 'session-a' }, 'the migrated record is written back as v2')

  // 30. Two messages to one conversation at the same instant: both are accepted,
  // in due order, each with its own request id.
  const twinDue = new Date(Date.now() + 120_000).toISOString()
  const twinA = await schedule(host, { text: 'twin a', dueAt: twinDue })
  const twinB = await schedule(host, { text: 'twin b', dueAt: twinDue })
  equal(twinA.created.ok, true, 'the first of two simultaneous messages is accepted')
  equal(twinB.created.ok, true, 'the second one is accepted too')
  equal(twinA.created.value.message.status, 'pending', 'the second one is not blocked by the first')
  await makeDue(host, twinA.id)
  await makeDue(host, twinB.id)
  const twinsFrom = host.prompts.length
  await fireWhenArmed(host)
  await until(() => table.get(twinA.id)?.status === 'sent' && table.get(twinB.id)?.status === 'sent',
    'both simultaneous messages to settle')
  const twins = host.prompts.slice(twinsFrom)
  equal(twins.length, 2, 'two queue prompts are delivered')
  equal(twins.every(item => item.mode === 'queue'), true, 'both queue behind the conversation')
  equal(new Set(twins.map(item => item.requestId)).size, 2, 'each delivery has its own request id')
  equal(twins.map(item => item.content[0].text), ['twin a', 'twin b'], 'ties keep insertion order')

  // 31. Exactly once: a settled record refuses every delivery route.
  const settledFrom = host.prompts.length
  equal((await body(created('/retry'), { body: { id: twinA.id } })).error?.code, 'not-pending',
    'a delivered record cannot be retried')
  equal((await body(created('/send-now'), { body: { id: twinA.id } })).error?.code, 'not-pending',
    'a delivered record cannot be sent again')
  equal(host.prompts.length, settledFrom, 'no second prompt is issued')
  equal(host.prompts.filter(item => item.requestId === 'dsm-' + twinA.id).length, 1, 'one record is prompted once')

  // 32. A running turn is neither waited on nor mistaken for a state change.
  host.state.summaries = [{ sessionId: 'session-a', updatedAt: Date.now(), running: true, blank: false }]
  const busyOne = await schedule(host, { text: 'while busy' })
  await makeDue(host, busyOne.id)
  const busyFrom = host.prompts.length
  await fireWhenArmed(host)
  await until(() => table.get(busyOne.id)?.status === 'sent', 'the message queued behind a running turn to settle')
  equal(host.prompts.length, busyFrom + 1, 'it is delivered instead of being held back')
  equal(host.prompts.at(-1).mode, 'queue', 'delivery queues behind the running turn')
  equal(stored(host, busyOne.id).status, 'sent', 'the record reports acceptance, not a running state')
  ok(!['running', 'started', 'completed'].includes(stored(host, busyOne.id).status), 'no invented status is written')
  const runningTargets = await body(created('/targets'), {})
  equal(runningTargets.value.workspaces.find(item => item.id === 'ws-a').sessions[0].running, true,
    'the running flag the UI shows comes from the Session summary')
  host.state.summaries = []

  // 33. Create can address a new conversation without opening it.
  const newTargetDue = new Date(Date.now() + 120_000).toISOString()
  const createsAtCreate = host.state.createCalls.length
  const born = await body(created('/create'), {
    body: {
      target: { kind: 'new', cwd: 'C:/work/a', workspaceId: 'ws-a' },
      dueAt: newTargetDue,
      timeZone: 'Asia/Hong_Kong',
      text: 'open later',
    },
  })
  equal(born.ok, true, 'a create addressed to a new conversation is accepted')
  equal(born.value.kind, 'once', 'it is a one-shot record')
  equal(born.value.message.target.kind, 'new', 'the stored destination is a new conversation')
  equal(born.value.message.sessionId, undefined, 'no conversation exists yet')
  equal(host.state.createCalls.length, createsAtCreate, 'creating a record opens no conversation')
  const bornId = born.value.message.id
  await makeDue(host, bornId)
  await fireWhenArmed(host)
  await until(() => table.get(bornId)?.status === 'sent', 'the new-conversation message to settle')
  equal(host.state.createCalls.length, createsAtCreate + 1, 'delivery opens exactly one conversation')
  equal(host.state.createCalls.at(-1), { workspaceId: 'ws-a' }, 'the named workspace travels alone')
  const bornSession = stored(host, bornId).sessionId
  ok(typeof bornSession === 'string', 'the opened conversation is stored on the record')
  equal(host.prompts.at(-1).sessionId, bornSession, 'the message lands in the conversation it opened')
  equal(host.prompts.at(-1).requestId, 'dsm-' + bornId, 'the request id still comes from the record')
  await table.put(bornId, { ...stored(host, bornId), status: 'failed', error: 'the turn refused it' })
  await body(created('/retry'), { body: { id: bornId } })
  await until(() => table.get(bornId)?.status === 'sent', 'the retried new-conversation delivery')
  equal(host.state.createCalls.length, createsAtCreate + 1, 'the retry reuses the conversation')

  // 34. A create body names one destination, and a dead one fails at create time.
  const soon = new Date(Date.now() + 120_000).toISOString()
  const bothDestinations = await body(created('/create'), {
    body: { sessionId: 'session-a', target: { kind: 'session', sessionId: 'session-a' }, dueAt: soon, timeZone: 'UTC', text: 'x' },
  })
  equal(bothDestinations.error?.code, 'invalid-request', 'a body carrying both destinations is refused')
  const noDestination = await body(created('/create'), { body: { dueAt: soon, timeZone: 'UTC', text: 'x' } })
  equal(noDestination.error?.code, 'invalid-session', 'a body carrying neither is refused')
  const relativeNew = await body(created('/create'), {
    body: { target: { kind: 'new', cwd: 'relative/path' }, dueAt: soon, timeZone: 'UTC', text: 'x' },
  })
  equal(relativeNew.error?.code, 'invalid-target', 'a new conversation needs an absolute cwd')
  const deadWorkspace = await body(created('/create'), {
    body: { target: { kind: 'new', cwd: 'C:/gone', workspaceId: 'ws-gone' }, dueAt: soon, timeZone: 'UTC', text: 'x' },
  })
  equal(deadWorkspace.error?.code, 'unknown-workspace', 'a vanished workspace fails at create time, not at delivery')
  const receiptForNew = await body(created('/create'), {
    body: {
      target: { kind: 'new', cwd: 'C:/work/a' },
      dueAt: soon,
      timeZone: 'UTC',
      text: 'x',
      fileReceipts: [host.stageFile('late.txt', 'bytes')],
    },
  })
  equal(receiptForNew.error?.code, 'attachments-need-conversation',
    'a staged file cannot follow a conversation that does not exist yet')
  const repeatNew = await body(created('/create'), {
    body: { target: { kind: 'new', cwd: 'C:/work/a' }, repeat: 'daily', dueAt: soon, timeZone: 'UTC', text: 'x' },
  })
  equal(repeatNew.error?.code, 'repeat-with-new-conversation', 'a repeating task needs an existing conversation')

  // 28. Without the Automation service, Repeat is refused instead of crashing.
  const soloHost = createHost({ withSchedule: false })
  apply(soloHost.ctx)
  await until(() => soloHost.storageDomain.opened.length > 0, 'the second Host domain to open')
  const noSchedule = await body(routeOf(soloHost.routes, PREFIX + '/create'), {
    body: { sessionId: 'session-a', dueAt: new Date(Date.now() + 120_000).toISOString(), timeZone: 'UTC', text: 'x', repeat: 'daily' },
  })
  equal(noSchedule.error?.code, 'repeat-unavailable', 'Repeat reports the missing service')
  const soloOnce = await body(routeOf(soloHost.routes, PREFIX + '/create'), {
    body: { sessionId: 'session-a', dueAt: new Date(Date.now() + 120_000).toISOString(), timeZone: 'UTC', text: 'still works' },
  })
  equal(soloOnce.value.kind, 'once', 'a one-shot still works without the Automation service')
  const soloRepeating = await body(routeOf(soloHost.routes, PREFIX + '/repeating'), {})
  equal(soloRepeating.ok, true, '/repeating answers without the Automation service')
  equal(soloRepeating.value, { available: false, items: [] }, 'a missing Automation service reports unavailability')

  // 29. Without a workspace registry the target list degrades instead of failing.
  const registrylessHost = createHost({ withRegistry: false })
  apply(registrylessHost.ctx)
  await until(() => registrylessHost.storageDomain.opened.length > 0, 'the third Host domain to open')
  const noTargets = await body(routeOf(registrylessHost.routes, PREFIX + '/targets'), {})
  equal(noTargets.ok, true, '/targets still answers without a registry')
  equal(noTargets.value.workspaces, [], '/targets names no workspace without a registry')
  const noLabels = await schedule(registrylessHost, { text: 'no registry' })
  equal(noLabels.created.ok, true, 'a message can still be scheduled without a registry')

  active = undefined
  return { assertions }
}

/**
 * Run the scenario when this file is executed directly.
 */
const invoked = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === invoked) {
  const result = await runHostSmoke()
  process.stdout.write('host smoke: ' + result.assertions + ' assertions passed' + String.fromCharCode(10))
}
