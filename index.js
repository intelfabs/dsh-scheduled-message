/**
 * Host half of dsh-scheduled-message.
 *
 * Owns one durable record per scheduled message and one `ctx.timer.timeout`
 * armed for the earliest pending record, so a message still sends when the
 * browser tab is closed and DSH keeps running; a message whose instant passed
 * while DSH was closed is sent at the next start and marked late.
 *
 * Everything sits behind `ctx.inject`, so a profile without the Automation
 * service still loads: Repeat is then reported as unavailable instead of
 * failing the plugin.
 *
 * @module dsh-scheduled-message
 */

import { randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  DOMAIN_NAME,
  MAX_PENDING,
  NS,
  buildRrule,
  earliestPending,
  isLate,
  pruneTargets,
  summariseTitle,
  timerDelay,
  validateCreateRequest,
} from './lib/core.js'

/** Largest accepted create body; ten images plus text fit comfortably. */
const MAX_CREATE_BODY_BYTES = 64 * 1024 * 1024

/** Delivery is abandoned after this long instead of holding the serialized queue. */
const DELIVERY_TIMEOUT_MS = 120_000

/** Records surfaced to a session's composer strip. */
const SENT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Longest stored diagnostic. */
const MAX_ERROR_CHARS = 500

const STATUSES = new Set(['pending', 'sending', 'sent', 'failed', 'cancelled'])

const ROUTE_PREFIX = '/api/dsh-scheduled-message'

/** Stable machine codes the browser half maps onto localized copy. */
const CODES = {
  invalidRequest: 'invalid-request',
  tooSoon: 'too-soon',
  unknownSession: 'unknown-session',
  unknownReceipt: 'unknown-receipt',
  repeatUnavailable: 'repeat-unavailable',
  notPending: 'not-pending',
  notFound: 'not-found',
  tooManyPending: 'too-many-pending',
  internal: 'internal',
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record, key) {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function requireInstant(record, key) {
  const value = requireString(record, key)
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${key} must be an absolute instant`)
  return value
}

function requireAttachmentRefs(record, key) {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`)
  return value.map((ref) => {
    if (!isRecord(ref)) throw new Error(`${key} entries must be objects`)
    if (typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0) {
      throw new Error(`${key} entries need an attachmentId`)
    }
    return ref
  })
}

/**
 * Validate one stored record.
 *
 * The storage layer only ever calls `parse`, so this plain object plays the
 * role `domainTable` normally fills with a zod schema: it normalizes one
 * detached record and rejects anything the Host did not write itself.
 */
const messageSchema = {
  parse(value) {
    if (!isRecord(value)) throw new Error('a scheduled message must be an object')
    const status = requireString(value, 'status')
    if (!STATUSES.has(status)) throw new Error(`unknown status ${status}`)
    return {
      id: requireString(value, 'id'),
      sessionId: requireString(value, 'sessionId'),
      dueAt: requireInstant(value, 'dueAt'),
      timeZone: requireString(value, 'timeZone'),
      text: typeof value.text === 'string' ? value.text : '',
      images: requireAttachmentRefs(value, 'images'),
      files: requireAttachmentRefs(value, 'files'),
      createdAt: requireInstant(value, 'createdAt'),
      updatedAt: requireInstant(value, 'updatedAt'),
      status,
      ...(value.sentAt === undefined ? {} : { sentAt: requireInstant(value, 'sentAt') }),
      ...(value.late === undefined ? {} : { late: Boolean(value.late) }),
      ...(value.error === undefined ? {} : { error: String(value.error).slice(0, MAX_ERROR_CHARS) }),
    }
  },
}

const domain = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: { messages: domainTable(messageSchema) },
})

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function jsonOk(value) {
  return jsonResponse(200, { ok: true, value })
}

function jsonError(code, message) {
  return jsonResponse(200, { ok: false, error: { code, message } })
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Render one thrown error as a short user-facing diagnostic. */
function describeError(error) {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
  const text = messageOf(error).replace(/\s+/gu, ' ').trim()
  const composed = code === undefined ? text : text.length === 0 ? code : `${code}: ${text}`
  return (composed.length === 0 ? 'delivery failed' : composed).slice(0, MAX_ERROR_CHARS)
}

/** Read one request body as JSON, refusing an oversized streaming body early. */
async function readJsonBody(request, limit) {
  const declared = Number(request.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) return { ok: false, code: 'body-too-large' }
  const body = request.body
  let buffer
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, code: 'body-too-large' }
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
    buffer = Buffer.concat(chunks)
  } else {
    const text = await request.text()
    if (text.length > limit) return { ok: false, code: 'body-too-large' }
    buffer = Buffer.from(text, 'utf8')
  }
  if (buffer.byteLength === 0) return { ok: false, code: 'empty-body' }
  try {
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) }
  } catch {
    return { ok: false, code: 'invalid-json' }
  }
}

/**
 * Durable schedule store plus the single timer that delivers due messages.
 *
 * Records are read back from the domain rather than cached, so two tabs and a
 * restart always act on the same durable state and a stale browser call is
 * refused by status instead of being silently applied.
 */
class Scheduler {
  /**
   * @param ctx - Host context that owns the services this feature needs.
   */
  constructor(ctx) {
    this.ctx = ctx
    /** @type {Promise<{ domain: any, table: any }> | undefined} */
    this.opening = undefined
    this.timer = undefined
    this.armSeq = 0
    this.chain = Promise.resolve()
    this.stopping = false
    /** @type {any} */
    this.schedule = undefined
  }

  /** Open the durable domain once and prune expired records on first use. */
  async opened() {
    if (this.opening === undefined) {
      this.opening = this.ctx.storageDomain.open(domain).then(async (openedDomain) => {
        const handle = { domain: openedDomain, table: openedDomain.table('messages') }
        try {
          await this.prune(handle.table)
        } catch (error) {
          this.ctx.logger?.warn?.(`dsh-scheduled-message: pruning stored records failed: ${messageOf(error)}`)
        }
        return handle
      }).catch((error) => {
        this.opening = undefined
        throw error
      })
    }
    return await this.opening
  }

  /** The record table, opening the domain on first use. */
  async table() {
    return (await this.opened()).table
  }

  /** Every stored record. */
  async records() {
    const table = await this.table()
    return [...table.entries()].map(([, record]) => record)
  }

  /** Drop finished records past retention. */
  async prune(table) {
    const ids = pruneTargets([...table.entries()].map(([, record]) => record), Date.now())
    for (const id of ids) await table.delete(id)
  }

  /** Stop the armed timer without touching durable state. */
  disarm() {
    if (this.timer !== undefined) {
      this.timer()
      this.timer = undefined
    }
  }

  /**
   * Arm one timer for the earliest pending record.
   *
   * Long waits are chunked: a delay above what `setTimeout` can hold fires
   * early and re-arms, and every mutation and delivery re-arms again.
   */
  async rearm() {
    const seq = ++this.armSeq
    this.disarm()
    if (this.stopping) return
    // Arming is best-effort: a re-arm failure must never fail the request that
    // triggered it, because the record it belongs to is already durable.
    try {
      const next = earliestPending(await this.records())
      if (seq !== this.armSeq || this.stopping || next === undefined) return
      const delay = timerDelay(Date.parse(next.dueAt), Date.now())
      this.timer = this.ctx.timer.timeout(() => {
        this.timer = undefined
        void this.pump()
      }, delay)
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-scheduled-message: arming the delivery timer failed: ${messageOf(error)}`)
    }
  }

  /** Run one delivery task after every earlier one, keeping the chain settled. */
  exclusive(task) {
    const run = () => Promise.resolve().then(task)
    const next = this.chain.then(run, run)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  /** Deliver whatever is due now, then re-arm. */
  pump() {
    return this.exclusive(() => this.runDue()).catch((error) => {
      this.ctx.logger?.warn?.(`dsh-scheduled-message: delivery pass failed: ${messageOf(error)}`)
    })
  }

  /** Deliver every record whose instant has passed, then re-arm. */
  async runDue() {
    if (this.stopping) return
    const now = Date.now()
    const due = (await this.records())
      .filter((record) => (record.status === 'pending' || record.status === 'sending') && Date.parse(record.dueAt) <= now)
      .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
    for (const record of due) {
      if (this.stopping) return
      await this.deliver(record.id)
    }
    await this.prune(await this.table())
    await this.rearm()
  }

  /** Build the wire content of one record, re-reading every stored attachment. */
  async content(record, signal) {
    const content = []
    if (record.text.length > 0) content.push({ type: 'text', text: record.text })
    for (const ref of record.images) {
      const stored = await this.ctx.attachments.readImage(ref, signal)
      content.push({
        type: 'image',
        mediaType: stored.ref.mediaType,
        data: Buffer.from(stored.data).toString('base64'),
        ...(ref.name === undefined ? {} : { name: ref.name }),
      })
    }
    for (const ref of record.files) {
      const uploaded = await this.ctx.fileUploads.uploadStream({
        sessionId: record.sessionId,
        data: this.ctx.attachments.readFileStream(ref, signal),
        signal,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      })
      content.push({ type: 'file', receiptId: uploaded.receiptId })
    }
    return content
  }

  /**
   * Deliver one record.
   *
   * The request id is derived from the record id, so a retry after a crash
   * cannot deliver the same message twice: the Session inbox refuses a
   * repeated request id.
   * @param id - record id.
   * @returns the settled record, or undefined when it no longer exists.
   */
  async deliver(id) {
    const table = await this.table()
    const record = table.get(id)
    if (record === undefined) return undefined
    if (record.status !== 'pending' && record.status !== 'sending') return record
    const startedIso = new Date().toISOString()
    const sending = messageSchema.parse({ ...record, status: 'sending', updatedAt: startedIso })
    await table.put(id, sending)
    const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    try {
      const content = await this.content(sending, signal)
      await this.ctx.sessionController.prompt({
        requestId: `dsm-${sending.id}`,
        sessionId: sending.sessionId,
        mode: 'queue',
        content,
        clientTimeZone: sending.timeZone,
      }, signal)
      const settledMs = Date.now()
      const sent = messageSchema.parse({
        ...sending,
        status: 'sent',
        sentAt: new Date(settledMs).toISOString(),
        updatedAt: new Date(settledMs).toISOString(),
        late: isLate(Date.parse(sending.dueAt), settledMs),
      })
      await table.put(id, sent)
      return sent
    } catch (error) {
      const failed = messageSchema.parse({
        ...sending,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        error: describeError(error),
      })
      await table.put(id, failed)
      this.ctx.logger?.warn?.(`dsh-scheduled-message: delivery of ${id} failed: ${failed.error}`)
      return failed
    } finally {
      void this.rearm()
    }
  }

  /** Create one durable record from an already validated request. */
  async createRecord(validated, images, files) {
    const table = await this.table()
    const nowIso = new Date().toISOString()
    const record = messageSchema.parse({
      id: randomUUID(),
      sessionId: validated.sessionId,
      dueAt: validated.dueAt,
      timeZone: validated.timeZone,
      text: validated.text,
      images,
      files,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: 'pending',
    })
    await table.put(record.id, record)
    return record
  }

  /** Count the records that still hold a timer obligation. */
  async pendingCount() {
    return (await this.records()).filter((record) => record.status === 'pending').length
  }
}

/** Compose the JSON view of one record for the browser half. */
function publicRecord(record) {
  return {
    id: record.id,
    sessionId: record.sessionId,
    dueAt: record.dueAt,
    timeZone: record.timeZone,
    text: record.text,
    imageCount: record.images.length,
    fileCount: record.files.length,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.sentAt === undefined ? {} : { sentAt: record.sentAt }),
    ...(record.late === undefined ? {} : { late: record.late }),
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

/**
 * Apply one allowed status change under the serialized delivery chain.
 * @param scheduler - owning store.
 * @param id - record id.
 * @param change - projection returning the patch, or null when the status forbids it.
 */
async function settleMutation(scheduler, id, change) {
  return await scheduler.exclusive(async () => {
    const table = await scheduler.table()
    const record = table.get(id)
    if (record === undefined) return jsonError(CODES.notFound, 'That scheduled message no longer exists.')
    const patch = change(record)
    if (patch === null) return jsonError(CODES.notPending, 'That message is no longer waiting to be sent.')
    const next = messageSchema.parse({ ...record, ...patch, updatedAt: new Date().toISOString() })
    await table.put(id, next)
    await scheduler.rearm()
    return jsonOk({ message: publicRecord(next) })
  })
}

/**
 * Validate and commit one create request.
 * @param scheduler - owning store.
 * @param body - untrusted JSON body.
 */
async function handleCreate(scheduler, body) {
  const validated = validateCreateRequest(body, Date.now())
  if (validated.ok !== true) return jsonError(validated.code, validated.message)
  const request = validated.value

  let agent
  try {
    const resolved = await scheduler.ctx.sessionController.resolveAgent(request.sessionId)
    if (resolved === null || typeof resolved !== 'object' || 'error' in resolved) {
      return jsonError(CODES.unknownSession, 'That conversation is no longer available; reopen it and try again.')
    }
    agent = resolved.agent
    if (agent === undefined) {
      return jsonError(CODES.unknownSession, 'That conversation is no longer available; reopen it and try again.')
    }
  } catch (error) {
    return jsonError(CODES.unknownSession, describeError(error))
  }

  if (request.repeat !== null) {
    if (scheduler.schedule === undefined) {
      return jsonError(CODES.repeatUnavailable, 'Repeating messages need the Automation service in this profile.')
    }
    let rrule
    try {
      rrule = buildRrule({ repeat: request.repeat, instantMs: request.dueMs, timeZone: request.timeZone })
    } catch (error) {
      return jsonError(CODES.invalidRequest, describeError(error))
    }
    try {
      const task = await scheduler.schedule.create({
        title: summariseTitle(request.text) || 'Scheduled message',
        prompt: request.text,
        timing: { kind: 'rrule', rrule },
        target: { kind: 'session', sessionId: request.sessionId },
      })
      return jsonOk({ kind: 'automation', taskId: String(task?.id ?? ''), rrule })
    } catch (error) {
      return jsonError(CODES.invalidRequest, describeError(error))
    }
  }

  if (await scheduler.pendingCount() >= MAX_PENDING) {
    return jsonError(CODES.tooManyPending, `At most ${MAX_PENDING} messages may wait to be sent.`)
  }

  let images = []
  if (request.images.length > 0) {
    try {
      images = await scheduler.ctx.attachments.saveImages(request.images.map(image => ({
        data: Buffer.from(image.data, 'base64'),
        mediaType: image.mediaType,
        ...(image.name === undefined ? {} : { name: image.name }),
      })))
    } catch (error) {
      return jsonError('invalid-images', describeError(error))
    }
  }

  const files = []
  for (const receiptId of request.fileReceipts) {
    const staged = scheduler.ctx.fileUploads.resolve(agent, receiptId)
    if (staged === undefined || staged.type !== 'file') {
      return jsonError(CODES.unknownReceipt, 'One of the attached files is no longer available; attach it again.')
    }
    files.push(staged.attachment)
  }

  try {
    const record = await scheduler.createRecord(request, images, files)
    await scheduler.rearm()
    return jsonOk({ kind: 'once', message: publicRecord(record) })
  } catch (error) {
    return jsonError(CODES.internal, describeError(error))
  }
}

/**
 * Register the durable store, the six HTTP routes and the delivery timer.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const scheduler = new Scheduler(ctx)

  ctx.inject(['storageDomain', 'sessionController', 'connection', 'attachments', 'fileUploads', 'timer'], (scope) => {
    scheduler.ctx = scope

    scope.effect(() => () => {
      scheduler.stopping = true
      scheduler.armSeq += 1
      scheduler.disarm()
      const opening = scheduler.opening
      scheduler.opening = undefined
      if (opening !== undefined) {
        void opening.then(handle => handle.domain.close()).catch(() => undefined)
      }
    }, 'dsh-scheduled-message: stop the timer and close the durable domain')

    scope.inject(['schedule'], (scheduleScope) => {
      scheduler.schedule = scheduleScope.schedule
      return () => {
        scheduler.schedule = undefined
      }
    })

    const routes = []

    routes.push(scope.connection.fetch.register({
      path: `${ROUTE_PREFIX}/create`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        const body = await readJsonBody(request, MAX_CREATE_BODY_BYTES)
        if (body.ok !== true) {
          return jsonError(CODES.invalidRequest, body.code === 'body-too-large'
            ? 'That message is too large to schedule.'
            : 'The request body could not be read.')
        }
        return await handleCreate(scheduler, body.value)
      },
    }))

    routes.push(scope.connection.fetch.register({
      path: `${ROUTE_PREFIX}/list`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url, 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId.length === 0) {
          return jsonError(CODES.invalidRequest, 'A sessionId query parameter is required.')
        }
        const now = Date.now()
        const items = (await scheduler.records())
          .filter((record) => record.sessionId === sessionId)
          .filter((record) => record.status === 'pending' || record.status === 'failed' || record.status === 'sending'
            || (record.status === 'sent' && now - Date.parse(record.sentAt ?? record.updatedAt) <= SENT_WINDOW_MS))
          .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
        return jsonOk({ items: items.map(publicRecord), now })
      },
    }))

    routes.push(scope.connection.fetch.register({
      path: `${ROUTE_PREFIX}/cancel`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJsonBody(request, 4096)
        if (body.ok !== true || typeof body.value?.id !== 'string') {
          return jsonError(CODES.invalidRequest, 'A record id is required.')
        }
        return await settleMutation(scheduler, body.value.id, (record) => (
          record.status === 'pending' || record.status === 'failed' ? { status: 'cancelled' } : null
        ))
      },
    }))

    routes.push(scope.connection.fetch.register({
      path: `${ROUTE_PREFIX}/reschedule`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJsonBody(request, 4096)
        const id = body.ok === true ? body.value?.id : undefined
        const dueAt = body.ok === true ? body.value?.dueAt : undefined
        if (typeof id !== 'string' || typeof dueAt !== 'string') {
          return jsonError(CODES.invalidRequest, 'A record id and an absolute dueAt are required.')
        }
        const dueMs = Date.parse(dueAt)
        if (!Number.isFinite(dueMs)) return jsonError(CODES.invalidRequest, 'dueAt is not a real instant.')
        if (dueMs < Date.now() + 30_000) return jsonError(CODES.tooSoon, 'Choose a time at least 30 seconds from now.')
        return await settleMutation(scheduler, id, (record) => (
          record.status === 'pending' ? { dueAt: new Date(dueMs).toISOString() } : null
        ))
      },
    }))

    routes.push(scope.connection.fetch.register({
      path: `${ROUTE_PREFIX}/send-now`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJsonBody(request, 4096)
        if (body.ok !== true || typeof body.value?.id !== 'string') {
          return jsonError(CODES.invalidRequest, 'A record id is required.')
        }
        const id = body.value.id
        return await scheduler.exclusive(async () => {
          const table = await scheduler.table()
          const record = table.get(id)
          if (record === undefined) return jsonError(CODES.notFound, 'That scheduled message no longer exists.')
          if (record.status !== 'pending' && record.status !== 'failed') {
            return jsonError(CODES.notPending, 'That message is no longer waiting to be sent.')
          }
          const settled = await scheduler.deliver(id)
          return jsonOk({ message: settled === undefined ? null : publicRecord(settled) })
        })
      },
    }))

    routes.push(scope.connection.fetch.register({
      path: `${ROUTE_PREFIX}/retry`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJsonBody(request, 4096)
        if (body.ok !== true || typeof body.value?.id !== 'string') {
          return jsonError(CODES.invalidRequest, 'A record id is required.')
        }
        const id = body.value.id
        return await scheduler.exclusive(async () => {
          const table = await scheduler.table()
          const record = table.get(id)
          if (record === undefined) return jsonError(CODES.notFound, 'That scheduled message no longer exists.')
          if (record.status !== 'failed') return jsonError(CODES.notPending, 'Only a failed message can be retried.')
          const nowIso = new Date().toISOString()
          const { error: _error, ...rest } = record
          const pending = messageSchema.parse({ ...rest, status: 'pending', dueAt: nowIso, updatedAt: nowIso })
          await table.put(id, pending)
          const settled = await scheduler.deliver(id)
          await scheduler.rearm()
          return jsonOk({ message: settled === undefined ? null : publicRecord(settled) })
        })
      },
    }))

    scope.effect(() => () => Promise.all(routes.map(remove => remove().catch(() => undefined))),
      'dsh-scheduled-message: remove the HTTP routes')

    // Deliver whatever came due while DSH was closed, then arm the timer.
    void scheduler.rearm()
    void scheduler.pump()
  })
}

export const name = NS

/** Services the one-shot path needs; `schedule` is injected separately. */
export const inject = ['storageDomain']
