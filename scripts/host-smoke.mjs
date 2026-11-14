/**
 * Host smoke test: drive `index.js` end to end against in-memory services.
 *
 * Run through `test/host.test.mjs`, which installs the storage-domain remap
 * first. Every assertion is about observable behaviour of the shipped Host
 * half: which routes it owns, what it stores, when it delivers, and what it
 * refuses.
 *
 * @module dsh-scheduled-message/scripts/host-smoke
 */

import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { createStorageDomainStub } from '../test/support/storage-domain-stub.mjs'

const ROUTES = [
  ['/api/dsh-scheduled-message/create', 'POST'],
  ['/api/dsh-scheduled-message/list', 'GET'],
  ['/api/dsh-scheduled-message/cancel', 'POST'],
  ['/api/dsh-scheduled-message/reschedule', 'POST'],
  ['/api/dsh-scheduled-message/send-now', 'POST'],
  ['/api/dsh-scheduled-message/retry', 'POST'],
]

let assertions = 0

function ok(condition, message) {
  assertions += 1
  assert.ok(condition, message)
}

function equal(actual, expected, message) {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

/** Build one Host context around in-memory services. */
function createHost(options = {}) {
  const log = []
  const storageDomain = createStorageDomainStub(log)
  const routes = new Map()
  const prompts = []
  const uploads = []
  const staged = new Map()
  const imageBytes = new Map()
  const fileBytes = new Map()
  const state = { timer: null, promptError: null, scheduleTasks: [] }
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
  }

  const attachments = {
    async saveImages(inputs) {
      return inputs.map((input) => {
        imageSeq += 1
        const ref = {
          attachmentId: `image-${imageSeq}`,
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
      if (data === undefined) throw new Error(`missing image ${ref.attachmentId}`)
      return { ref, data }
    },
    async *readFileStream(ref) {
      const data = fileBytes.get(ref.attachmentId)
      if (data === undefined) throw new Error(`missing file ${ref.attachmentId}`)
      yield data
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
      const ref = { attachmentId: `file-${fileBytes.size + 1}`, name: name ?? 'file', bytes: bytes.byteLength }
      fileBytes.set(ref.attachmentId, bytes)
      const receiptId = `out-receipt-${uploads.length + 1}`
      staged.set(receiptId, { type: 'file', attachment: ref })
      uploads.push({ sessionId, receiptId })
      return { receiptId, file: ref }
    },
  }

  const schedule = {
    async create(request) {
      state.scheduleTasks.push(request)
      return { id: `schedule-${state.scheduleTasks.length}` }
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
    /** Stage one inbound file receipt the composer would have uploaded. */
    stageFile(name, text) {
      const ref = { attachmentId: `in-file-${fileBytes.size + 1}`, name, bytes: Buffer.byteLength(text) }
      fileBytes.set(ref.attachmentId, Buffer.from(text))
      const receiptId = `in-receipt-${staged.size + 1}`
      staged.set(receiptId, { type: 'file', attachment: ref })
      return receiptId
    },
  }
}

function tableOf(host) {
  return host.storageDomain.opened[0].table('messages')
}

async function until(predicate, label, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function call(route, options = {}) {
  const url = `http://127.0.0.1${route.path}${options.query ?? ''}`
  const init = { method: route.methods[0] }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers = { 'content-type': 'application/json' }
  }
  return route.fetch(new Request(url, init))
}

async function body(route, options) {
  const response = await call(route, options)
  return await response.json()
}

function routeOf(routes, path) {
  const route = routes.get(path)
  assert.ok(route !== undefined, `route ${path} is not registered`)
  return route
}

async function fireWhenArmed(host) {
  await until(() => host.state.timer !== null, 'a timer to be armed')
  const armed = host.state.timer
  host.state.timer = null
  armed.callback()
}

/** Create through the route, then optionally pull the record into the past. */
async function schedule(host, overrides = {}) {
  const created = await body(routeOf(host.routes, '/api/dsh-scheduled-message/create'), {
    body: {
      sessionId: overrides.sessionId ?? 'session-a',
      dueAt: new Date(Date.now() + 120_000).toISOString(),
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

// ---------------------------------------------------------------- scenario

const host = createHost()
apply(host.ctx)

// 1. Routes.
equal([...host.routes.keys()].sort(), ROUTES.map(([path]) => path).sort(), 'the Host owns exactly six routes')
for (const [path, method] of ROUTES) {
  const route = routeOf(host.routes, path)
  ok(route.methods.includes(method), `${path} accepts ${method}`)
  equal(route.requestBody, path.endsWith('/create') ? 'streaming' : 'buffered', `${path} body mode`)
}

await until(() => host.storageDomain.opened.length > 0, 'the durable domain to open')
const table = tableOf(host)

// 2. Rejections before any durable write.
const createRoute = routeOf(host.routes, '/api/dsh-scheduled-message/create')
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

// 3. Create a text-only one-shot.
const first = await schedule(host, { text: '  hello there  ' })
equal(first.created.ok, true, 'a text-only message is accepted')
equal(first.created.value.kind, 'once', 'it is a one-shot')
equal(first.created.value.message.text, 'hello there', 'the stored text is trimmed')
equal(first.created.value.message.status, 'pending', 'the record starts pending')
ok(host.state.timer !== null, 'a timer is armed for it')

const listed = await body(routeOf(host.routes, '/api/dsh-scheduled-message/list'), { query: '?sessionId=session-a' })
equal(listed.value.items.length, 1, 'the strip lists the pending record')
equal(listed.value.items[0].id, first.id, 'the list names the created record')
const otherSession = await body(routeOf(host.routes, '/api/dsh-scheduled-message/list'), { query: '?sessionId=session-b' })
equal(otherSession.value.items.length, 0, 'another conversation does not see it')

// 4. Delivery.
await table.put(first.id, { ...table.get(first.id), dueAt: new Date(Date.now() - 1000).toISOString() })
await fireWhenArmed(host)
await until(() => table.get(first.id)?.status === 'sent', 'the record to be sent')
equal(host.prompts.length, 1, 'exactly one prompt was delivered')
equal(host.prompts[0].requestId, `dsm-${first.id}`, 'the request id is derived from the record id')
equal(host.prompts[0].mode, 'queue', 'delivery queues behind a running agent instead of steering it')
equal(host.prompts[0].clientTimeZone, 'Asia/Hong_Kong', 'the captured zone is replayed')
equal(host.prompts[0].content, [{ type: 'text', text: 'hello there' }], 'the text arrives unchanged')
equal(table.get(first.id).late, false, 'an on-time delivery is not marked late')
ok(typeof table.get(first.id).sentAt === 'string', 'the record keeps its send time')

// 5. A failed delivery is reported, then retried with the same request id.
const failing = await schedule(host, { text: 'fail me', duePast: true })
host.state.promptError = Object.assign(new Error('the agent refused'), { code: 'session/refused' })
await fireWhenArmed(host)
await until(() => table.get(failing.id)?.status === 'failed', 'the failure to be stored')
ok(String(table.get(failing.id).error).includes('session/refused'), 'the diagnostic reaches the record')

const retried = await body(routeOf(host.routes, '/api/dsh-scheduled-message/retry'), { body: { id: failing.id } })
equal(retried.ok, true, 'a failed record can be retried')
await until(() => table.get(failing.id)?.status === 'sent', 'the retry to settle')
equal(host.prompts.at(-1).requestId, `dsm-${failing.id}`, 'the retry reuses the record request id')

// 6. Send now, then cancel.
const immediate = await schedule(host, { text: 'right away' })
const sentNow = await body(routeOf(host.routes, '/api/dsh-scheduled-message/send-now'), { body: { id: immediate.id } })
equal(sentNow.value.message.status, 'sent', 'Send now delivers immediately')
equal(host.prompts.at(-1).content[0].text, 'right away', 'Send now carries the stored text')

const doomed = await schedule(host, { text: 'never' })
const cancelled = await body(routeOf(host.routes, '/api/dsh-scheduled-message/cancel'), { body: { id: doomed.id } })
equal(cancelled.value.message.status, 'cancelled', 'Cancel stops a pending record')
const afterCancel = await body(routeOf(host.routes, '/api/dsh-scheduled-message/list'), { query: '?sessionId=session-a' })
ok(!afterCancel.value.items.some(item => item.id === doomed.id), 'a cancelled record leaves the strip')

const cancelSettled = await body(routeOf(host.routes, '/api/dsh-scheduled-message/cancel'), { body: { id: immediate.id } })
equal(cancelSettled.error?.code, 'not-pending', 'a settled record refuses further mutations')
const cancelUnknown = await body(routeOf(host.routes, '/api/dsh-scheduled-message/cancel'), { body: { id: 'nope' } })
equal(cancelUnknown.error?.code, 'not-found', 'an unknown record is reported')

// 7. Rescheduling moves the stored instant and refuses a stale one.
const movable = await schedule(host, { text: 'move me' })
const target = new Date(Date.now() + 3_600_000).toISOString()
const moved = await body(routeOf(host.routes, '/api/dsh-scheduled-message/reschedule'), { body: { id: movable.id, dueAt: target } })
equal(moved.value.message.dueAt, target, 'the new instant is stored')
const staleMove = await body(routeOf(host.routes, '/api/dsh-scheduled-message/reschedule'), {
  body: { id: movable.id, dueAt: new Date(Date.now() + 1000).toISOString() },
})
equal(staleMove.error?.code, 'too-soon', 'a new instant under thirty seconds ahead is refused')
await body(routeOf(host.routes, '/api/dsh-scheduled-message/cancel'), { body: { id: movable.id } })

// 8. Crash recovery: a record left in `sending` is delivered at startup.
const crashed = await schedule(host, { text: 'after crash', status: 'sending', duePast: true })
await fireWhenArmed(host)
await until(() => table.get(crashed.id)?.status === 'sent', 'the crash-left record to settle')
equal(host.prompts.at(-1).requestId, `dsm-${crashed.id}`, 'the recovered delivery keeps its request id')

// 9. Images and files survive to delivery.
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

// 10. Repeat creates an automation task instead of a record.
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

// 11. Without the Automation service, Repeat is refused instead of crashing.
const soloHost = createHost({ withSchedule: false })
apply(soloHost.ctx)
await until(() => soloHost.storageDomain.opened.length > 0, 'the second Host domain to open')
const noSchedule = await body(routeOf(soloHost.routes, '/api/dsh-scheduled-message/create'), {
  body: { sessionId: 'session-a', dueAt: new Date(Date.now() + 120_000).toISOString(), timeZone: 'UTC', text: 'x', repeat: 'daily' },
})
equal(noSchedule.error?.code, 'repeat-unavailable', 'Repeat reports the missing service')
const soloOnce = await body(routeOf(soloHost.routes, '/api/dsh-scheduled-message/create'), {
  body: { sessionId: 'session-a', dueAt: new Date(Date.now() + 120_000).toISOString(), timeZone: 'UTC', text: 'still works' },
})
equal(soloOnce.value.kind, 'once', 'a one-shot still works without the Automation service')

process.stdout.write(`host smoke: ${assertions} assertions passed\n`)
