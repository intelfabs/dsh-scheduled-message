/**
 * Host half of dsh-scheduled-message.
 *
 * Owns one durable record per scheduled message and one ctx.timer.timeout
 * armed for the earliest pending record, so a message still sends when the
 * browser tab is closed and DSH keeps running; a message whose instant passed
 * while DSH was closed is sent at the next start and marked late.
 *
 * v2 adds a delivery target: a message either belongs to an existing
 * conversation or opens a new one at send time. The Scheduled tab reads every
 * record across conversations through /list-all, edits one through /update,
 * attaches files through /upload and names its destinations through /targets.
 *
 * Everything sits behind ctx.inject, so a profile without the Automation
 * service still loads: Repeat is then reported as unavailable instead of
 * failing the plugin. ctx.workspaceRegistry is read opportunistically, so a
 * build without it answers an empty target list instead of refusing to load.
 *
 * @module dsh-scheduled-message
 */

import { randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  COMPATIBLE_VERSIONS,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  MAX_ERROR_CHARS,
  MAX_PENDING,
  MIN_LEAD_MS,
  NS,
  SENT_WINDOW_MS,
  buildRrule,
  earliestPending,
  isLate,
  nextUpdatedAt,
  parseRecord,
  pruneTargets,
  resolveSessionId,
  sortPendingRecords,
  summariseTitle,
  timerDelay,
  validateCreateRequest,
  validateMerged,
  validateUpdateRequest,
} from './lib/core.js'

/** Largest accepted create or update body; ten images plus text fit comfortably. */
const MAX_CREATE_BODY_BYTES = 64 * 1024 * 1024

/** Delivery is abandoned after this long instead of holding the serialized queue. */
const DELIVERY_TIMEOUT_MS = 120_000

/** How long a target list waits for the Session summaries it joins. */
const LIST_TIMEOUT_MS = 10_000

/** How long an uploaded file stays claimable before an update loses it. */
const STAGED_TTL_MS = 24 * 60 * 60 * 1000

/** Most staged uploads kept; the oldest is dropped first. */
const MAX_STAGED_FILES = 200

/** Thumbnails are private bytes that never change under one attachment id. */
const THUMB_CACHE_CONTROL = 'private, max-age=3600'

/** Most repeating tasks one listing answers. */
const MAX_REPEATING_ITEMS = 50

const ROUTE_PREFIX = '/api/dsh-scheduled-message'

/** Stable machine codes the browser half maps onto localized copy. */
const CODES = {
  invalidRequest: 'invalid-request',
  invalidId: 'invalid-id',
  tooSoon: 'too-soon',
  unknownSession: 'unknown-session',
  unknownWorkspace: 'unknown-workspace',
  unknownReceipt: 'unknown-receipt',
  unknownFile: 'unknown-file',
  repeatUnavailable: 'repeat-unavailable',
  notPending: 'not-pending',
  notFound: 'not-found',
  conflict: 'conflict',
  invalidImages: 'invalid-images',
  emptyBody: 'empty-body',
  bodyTooLarge: 'body-too-large',
  tooManyPending: 'too-many-pending',
  internal: 'internal',
}

/**
 * Whether one value is a plain object.
 * @param value - anything.
 * @returns whether it is a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The durable record table.
 *
 * parse is the only hook the storage layer calls, so every read comes back as a
 * normalized v2 record: a v1 record still carrying sessionId is migrated on the
 * way in, and anything the Host did not write is rejected.
 */
const domain = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  compatibleVersions: COMPATIBLE_VERSIONS,
  tables: { messages: domainTable({ parse: value => parseRecord(value) }) },
})

/**
 * Render one JSON envelope.
 * @param status - HTTP status.
 * @param body - already-serializable body.
 * @returns the response.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Render one success envelope; every route answers HTTP 200 for an accepted call.
 * @param value - the route value.
 * @returns the response.
 */
function jsonOk(value) {
  return jsonResponse(200, { ok: true, value })
}

/**
 * Render one failure envelope.
 *
 * Only /thumb answers a non-200 status, because the browser loads it as an
 * image rather than reading the envelope.
 * @param code - stable machine code.
 * @param message - English fallback copy.
 * @param status - HTTP status; 200 unless the caller says otherwise.
 * @returns the response.
 */
function jsonError(code, message, status = 200) {
  return jsonResponse(status, { ok: false, error: { code, message } })
}

/**
 * Read one error as text.
 * @param error - a thrown value.
 * @returns its message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Render one thrown error as a short user-facing diagnostic.
 * @param error - a thrown value.
 * @returns at most MAX_ERROR_CHARS characters, prefixed by its code.
 */
function describeError(error) {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
  const text = messageOf(error).replace(/\s+/gu, ' ').trim()
  const composed = code === undefined ? text : text.length === 0 ? code : code + ': ' + text
  return (composed.length === 0 ? 'delivery failed' : composed).slice(0, MAX_ERROR_CHARS)
}

/**
 * Read one request body as JSON, refusing an oversized streaming body early.
 * @param request - inbound request.
 * @param limit - largest accepted body in bytes.
 * @returns the parsed value, or the codes body-too-large, empty-body, invalid-json.
 */
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
 * Stream one request body chunk by chunk.
 *
 * The uploaded bytes are handed to ctx.attachments.saveFileStream as an async
 * iterable, so the whole file is never held twice; a body that is already an
 * async iterable is passed straight through.
 * @param body - the request body stream.
 * @yields the next chunk of the body.
 */
async function* requestChunks(body) {
  if (body === null || body === undefined) return
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done === true) return
        if (value !== undefined) yield value
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // The stream is already closed; nothing to release.
      }
    }
    return
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    yield* body
  }
}

/**
 * Count the bytes of a stream on the way past.
 *
 * saveFileStream reports the stored length, but a provider that normalizes bytes
 * would hide an empty upload, so the accepted request counts its own.
 * @param source - the chunk stream.
 * @param counter - the counter object, incremented per chunk.
 * @returns the counting stream.
 */
function countingChunks(source, counter) {
  return (async function* count() {
    for await (const chunk of source) {
      counter.bytes += chunk.byteLength
      yield chunk
    }
  })()
}

/**
 * The first eight characters of a session id, used when no title is readable.
 * @param sessionId - session identity.
 * @returns the short label.
 */
function shortId(sessionId) {
  return sessionId.slice(0, 8)
}

/**
 * Whether a record belongs in the Scheduled tab at one instant.
 *
 * Pending, sending and failed records always do; a settled record only for the
 * trailing Sent window, so the tab never grows without bound.
 * @param record - one stored record.
 * @param nowMs - the reading clock.
 * @returns whether the tab lists it.
 */
function listedInTab(record, nowMs) {
  if (record.status === 'pending' || record.status === 'sending' || record.status === 'failed') return true
  if (record.status !== 'sent' && record.status !== 'cancelled') return false
  const settledMs = Date.parse(record.sentAt ?? record.updatedAt)
  return Number.isFinite(settledMs) && nowMs - settledMs <= SENT_WINDOW_MS
}

/**
 * Durable schedule store plus the single timer that delivers due messages.
 *
 * Records are read back from the domain rather than cached, so two tabs and a
 * restart always act on the same durable state and a stale browser call is
 * refused by status instead of being silently applied. Uploads the browser has
 * not attached yet live in one bounded in-memory table: they are a convenience,
 * not durable state.
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
    /** Uploaded-but-unclaimed files, oldest first. */
    this.staged = new Map()
  }

  /** Open the durable domain once and prune expired records on first use. */
  async opened() {
    if (this.opening === undefined) {
      this.opening = this.ctx.storageDomain.open(domain).then(async (openedDomain) => {
        const handle = { domain: openedDomain, table: openedDomain.table('messages') }
        try {
          await this.prune(handle.table)
        } catch (error) {
          this.ctx.logger?.warn?.('dsh-scheduled-message: pruning stored records failed: ' + messageOf(error))
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

  /**
   * Remember one durable upload until a record claims it.
   * @param ref - the stored attachment reference.
   * @returns the same reference.
   */
  stage(ref) {
    const nowMs = Date.now()
    this.staged.set(ref.attachmentId, { name: ref.name, bytes: ref.bytes, createdAt: nowMs })
    this.pruneStaged(nowMs)
    return ref
  }

  /**
   * Drop staged uploads past their life, then the oldest over the bound.
   * @param nowMs - the pruning clock.
   */
  pruneStaged(nowMs = Date.now()) {
    for (const [fileId, entry] of this.staged) {
      if (nowMs - entry.createdAt > STAGED_TTL_MS) this.staged.delete(fileId)
    }
    while (this.staged.size > MAX_STAGED_FILES) {
      const oldest = this.staged.keys().next()
      if (oldest.done === true) return
      this.staged.delete(oldest.value)
    }
  }

  /**
   * One staged upload, if it is still claimable.
   * @param fileId - the attachment id the browser holds.
   * @returns the staged entry, or undefined once it expired.
   */
  stagedFile(fileId) {
    this.pruneStaged()
    return this.staged.get(fileId)
  }

  /**
   * The workspaces this build can name.
   *
   * The registry is optional: a profile without it answers an empty list rather
   * than failing a route the tab uses on every open.
   * @returns the workspace list, empty when unavailable.
   */
  async workspaces() {
    try {
      // `ctx.get` is the optional-service accessor: reading an undeclared service as a
      // property throws in cordis, and DSH's own schedule runtime reads the same
      // registry this way (dsh-schedule/src/index.ts:653).
      const registry = this.ctx.get('workspaceRegistry')
      if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
      const listed = await registry.list()
      return Array.isArray(listed) ? listed : []
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-scheduled-message: reading workspaces failed: ' + messageOf(error))
      return []
    }
  }

  /**
   * Session ids the registry has archived.
   * @returns the archived ids, empty when unavailable.
   */
  async archivedSessionIds() {
    try {
      const ids = this.ctx.get('workspaceRegistry')?.archivedSessionIds
      return Array.isArray(ids) ? ids : []
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-scheduled-message: reading archived sessions failed: ' + messageOf(error))
      return []
    }
  }

  /**
   * Join the Session summaries the target list and labels need.
   * @param signal - cancellation for the listing call.
   * @returns a map from session id to summary, or undefined when unavailable.
   */
  async sessionSummaries(signal) {
    try {
      const listed = await this.ctx.sessionController.list({}, signal)
      const items = Array.isArray(listed?.items) ? listed.items : []
      const summaries = new Map()
      for (const item of items) {
        if (isRecord(item) && typeof item.sessionId === 'string' && item.sessionId.length > 0) {
          summaries.set(item.sessionId, item)
        }
      }
      return summaries
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-scheduled-message: listing sessions failed: ' + messageOf(error))
      return undefined
    }
  }

  /**
   * Best-effort names for a batch of records.
   *
   * A workspace title always comes from the registry. A conversation title is
   * reported only when this build actually exposes one; the Session summary
   * carries no title, so the browser falls back to the short id rather than the
   * Host inventing a name.
   * @param records - records about to be rendered.
   * @returns one targetLabel (or undefined) per record, in order.
   */
  async labels(records) {
    const workspaces = await this.workspaces()
    if (workspaces.length === 0) return records.map(() => undefined)
    const bySession = new Map()
    const byId = new Map()
    for (const workspace of workspaces) {
      if (typeof workspace.id === 'string' && workspace.id.length > 0) byId.set(workspace.id, workspace)
      const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      for (const sessionId of sessionIds) {
        if (typeof sessionId === 'string' && sessionId.length > 0) bySession.set(sessionId, workspace)
      }
    }
    const summaries = await this.sessionSummaries(AbortSignal.timeout(LIST_TIMEOUT_MS))
    return records.map((record) => {
      const resolved = resolveSessionId(record)
      const target = record.target
      const workspace = resolved === undefined ? undefined : bySession.get(resolved)
      const named = workspace !== undefined
        ? workspace
        : target.kind === 'new' && target.workspaceId !== undefined ? byId.get(target.workspaceId) : undefined
      const summary = resolved === undefined ? undefined : summaries?.get(resolved)
      /** @type {{ workspaceTitle?: string, sessionTitle?: string }} */
      const label = {}
      if (typeof named?.title === 'string' && named.title.length > 0) label.workspaceTitle = named.title
      if (typeof summary?.title === 'string' && summary.title.length > 0) label.sessionTitle = summary.title
      return Object.keys(label).length === 0 ? undefined : label
    })
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
   * Long waits are chunked: a delay above what setTimeout can hold fires early
   * and re-arms, and every mutation and delivery re-arms again.
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
      this.ctx.logger?.warn?.('dsh-scheduled-message: arming the delivery timer failed: ' + messageOf(error))
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
      this.ctx.logger?.warn?.('dsh-scheduled-message: delivery pass failed: ' + messageOf(error))
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

  /**
   * Open the conversation a kind-new record names, once.
   *
   * The new session id is written to the record before the message is prompted:
   * a crash between the two leaves a record that already names its conversation,
   * so the next attempt reuses it instead of opening a second one.
   * @param record - the record, already marked sending.
   * @param table - the record table.
   * @returns the record, now carrying a session id.
   */
  async ensureSession(record, table) {
    if (record.target.kind !== 'new' || record.sessionId !== undefined) return record
    const target = record.target
    const missing = await missingWorkspace(this, target)
    if (missing !== null) throw new Error(missing)
    // The two fields are exclusive on the wire: a named workspace already fixes
    // the directory, and cwd is only the fallback destination.
    const request = target.workspaceId === undefined ? { cwd: target.cwd } : { workspaceId: target.workspaceId }
    const created = await this.ctx.sessionController.create(request)
    const sessionId = typeof created?.sessionId === 'string' && created.sessionId.length > 0
      ? created.sessionId
      : undefined
    if (sessionId === undefined) throw new Error('the new conversation could not be created')
    const stored = parseRecord({ ...record, sessionId, updatedAt: nextUpdatedAt(record.updatedAt, Date.now()) })
    await table.put(record.id, stored)
    return stored
  }

  /**
   * Refuse a record whose conversation DSH has archived.
   *
   * The check is best-effort: without a workspace registry the delivery is
   * attempted and any refusal from the Session service is recorded instead.
   * @param record - the record about to be delivered.
   */
  async assertReachable(record) {
    const sessionId = resolveSessionId(record)
    if (sessionId === undefined) return
    const archived = await this.archivedSessionIds()
    if (archived.includes(sessionId)) {
      throw new Error('the conversation this message was scheduled for was archived')
    }
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
    const sessionId = resolveSessionId(record)
    for (const ref of record.files) {
      const uploaded = await this.ctx.fileUploads.uploadStream({
        sessionId,
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
   * cannot deliver the same message twice: the Session inbox refuses a repeated
   * request id. Nothing thrown here escapes: a failure becomes a failed record
   * with a readable reason.
   * @param id - record id.
   * @returns the settled record, or undefined when it no longer exists.
   */
  async deliver(id) {
    const table = await this.table()
    const record = table.get(id)
    if (record === undefined) return undefined
    if (record.status !== 'pending' && record.status !== 'sending') return record
    const sending = parseRecord({ ...record, status: 'sending', updatedAt: nextUpdatedAt(record.updatedAt, Date.now()) })
    await table.put(id, sending)
    const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    let current = sending
    try {
      current = await this.ensureSession(sending, table)
      await this.assertReachable(current)
      const content = await this.content(current, signal)
      await this.ctx.sessionController.prompt({
        requestId: 'dsm-' + current.id,
        sessionId: resolveSessionId(current),
        mode: 'queue',
        content,
        clientTimeZone: current.timeZone,
      }, signal)
      const settledMs = Date.now()
      // DSH accepts the prompt into the conversation's queue and reports nothing
      // about when the turn starts or finishes, so `sent` records acceptance —
      // the last fact the plugin can observe. The UI calls that state Accepted
      // and never claims the message was sent (docs/DETAIL.md §3.6).
      const sent = parseRecord({
        ...current,
        status: 'sent',
        sentAt: new Date(settledMs).toISOString(),
        updatedAt: nextUpdatedAt(current.updatedAt, settledMs),
        late: isLate(Date.parse(current.dueAt), settledMs),
      })
      await table.put(id, sent)
      return sent
    } catch (error) {
      const failed = parseRecord({
        ...current,
        status: 'failed',
        updatedAt: nextUpdatedAt(current.updatedAt, Date.now()),
        error: describeError(error),
      })
      await table.put(id, failed)
      this.ctx.logger?.warn?.('dsh-scheduled-message: delivery of ' + id + ' failed: ' + failed.error)
      return failed
    } finally {
      void this.rearm()
    }
  }

  /** Create one durable record from an already validated request. */
  async createRecord(validated, images, files) {
    const table = await this.table()
    const nowIso = new Date().toISOString()
    const record = parseRecord({
      id: randomUUID(),
      // The validated destination is stored as it arrived: parseRecord mirrors a
      // session target's id into sessionId, and a new-conversation target owns no
      // session until delivery opens one.
      target: validated.target,
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

/**
 * Compose the JSON view of one record for the browser half.
 * @param record - one stored record.
 * @param targetLabel - best-effort destination names, when the caller resolved them.
 * @returns the wire record.
 */
function publicRecord(record, targetLabel) {
  const sessionId = resolveSessionId(record)
  return {
    id: record.id,
    target: { ...record.target },
    ...(sessionId === undefined ? {} : { sessionId }),
    dueAt: record.dueAt,
    timeZone: record.timeZone,
    text: record.text,
    images: record.images.map(ref => ({ ...ref })),
    files: record.files.map(ref => ({ ...ref })),
    imageCount: record.images.length,
    fileCount: record.files.length,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.sentAt === undefined ? {} : { sentAt: record.sentAt }),
    ...(record.late === undefined ? {} : { late: record.late }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(targetLabel === undefined ? {} : { targetLabel }),
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
    const next = parseRecord({ ...record, ...patch, updatedAt: nextUpdatedAt(record.updatedAt, Date.now()) })
    await table.put(id, next)
    await scheduler.rearm()
    return jsonOk({ message: publicRecord(next) })
  })
}

/**
 * Refuse a new-conversation target whose workspace is gone.
 *
 * A build without a workspace registry cannot answer, so the check stays
 * best-effort there and the delivery is attempted as before.
 * @param scheduler - owning store.
 * @param target - one validated delivery target.
 * @returns the reason it cannot be reached, or null when it still can.
 */
async function missingWorkspace(scheduler, target) {
  if (target.kind !== 'new' || target.workspaceId === undefined) return null
  const workspaces = await scheduler.workspaces()
  if (workspaces.length === 0) return null
  if (workspaces.some(workspace => workspace.id === target.workspaceId)) return null
  return 'the workspace this message was addressed to no longer exists'
}

/**
 * Validate and commit one create request.
 *
 * A session target resolves its agent now, because the conversation exists. A
 * new-conversation target does not: creating it here would leave an empty
 * conversation behind every cancelled message, so the workspace is only checked
 * and the conversation is opened at delivery time. When it carries staged
 * files, the conversation that uploaded them is resolved instead, because a
 * receipt is memory-only and cannot be read back at delivery.
 * @param scheduler - owning store.
 * @param body - untrusted JSON body.
 */
async function handleCreate(scheduler, body) {
  const validated = validateCreateRequest(body, Date.now())
  if (validated.ok !== true) return jsonError(validated.code, validated.message)
  const request = validated.value
  const target = request.target

  let agent
  // A new-conversation target resolves the conversation that uploaded its file
  // receipts into its own variable, so the session path's agent is untouched.
  let sourceAgent
  if (target.kind === 'session') {
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
  } else {
    // A destination that is already gone is a validation failure now, not a
    // delivery failure left to rot until the due instant.
    const missing = await missingWorkspace(scheduler, target)
    if (missing !== null) return jsonError(CODES.unknownWorkspace, missing)
    // A staged receipt belongs to the conversation that uploaded it, not to the
    // conversation this message will open. It is resolved here, while it is
    // still in memory, and only the durable ref is stored; delivery re-uploads
    // that ref into the conversation it opens.
    if (request.fileReceipts.length > 0) {
      try {
        const resolved = await scheduler.ctx.sessionController.resolveAgent(request.sourceSessionId)
        if (resolved === null || typeof resolved !== 'object' || 'error' in resolved
          || resolved.agent === undefined) {
          return jsonError(CODES.unknownSession, 'That conversation is no longer available; reopen it and try again.')
        }
        sourceAgent = resolved.agent
      } catch (error) {
        return jsonError(CODES.unknownSession, describeError(error))
      }
    }
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
    return jsonError(CODES.tooManyPending, 'At most ' + MAX_PENDING + ' messages may wait to be sent.')
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
      return jsonError(CODES.invalidImages, describeError(error))
    }
  }

  const files = []
  const receiptAgent = target.kind === 'session' ? agent : sourceAgent
  for (const receiptId of request.fileReceipts) {
    const staged = scheduler.ctx.fileUploads.resolve(receiptAgent, receiptId)
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
 * Read the record selection the composer strip asks for.
 * @param scheduler - owning store.
 * @param request - inbound request carrying the sessionId query parameter.
 */
async function handleList(scheduler, request) {
  const url = new URL(request.url, 'http://localhost')
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId.length === 0) {
    return jsonError(CODES.invalidRequest, 'A sessionId query parameter is required.')
  }
  const now = Date.now()
  const items = (await scheduler.records())
    .filter((record) => resolveSessionId(record) === sessionId)
    .filter((record) => record.status === 'pending' || record.status === 'failed' || record.status === 'sending'
      || (record.status === 'sent' && now - Date.parse(record.sentAt ?? record.updatedAt) <= SENT_WINDOW_MS))
    .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
  return jsonOk({ items: items.map(record => publicRecord(record)), now })
}

/**
 * List every scheduled message the Scheduled tab shows.
 * @param scheduler - owning store.
 * @param request - inbound request carrying scope and an optional workspaceId.
 */
async function handleListAll(scheduler, request) {
  const url = new URL(request.url, 'http://localhost')
  const scope = url.searchParams.get('scope') ?? 'all'
  if (scope !== 'all' && scope !== 'workspace') {
    return jsonError(CODES.invalidRequest, 'scope must be all or workspace.')
  }
  const workspaceId = url.searchParams.get('workspaceId')
  if (scope === 'workspace' && (workspaceId === null || workspaceId.length === 0)) {
    return jsonError(CODES.invalidRequest, 'A workspaceId query parameter is required for scope=workspace.')
  }
  const now = Date.now()
  let records = (await scheduler.records()).filter(record => listedInTab(record, now))
  if (scope === 'workspace') {
    const workspace = (await scheduler.workspaces()).find(candidate => candidate.id === workspaceId)
    if (workspace === undefined) return jsonOk({ items: [], now })
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    records = records.filter((record) => {
      const resolved = resolveSessionId(record)
      if (resolved !== undefined) return sessionIds.includes(resolved)
      return record.target.kind === 'new' && record.target.workspaceId === workspaceId
    })
  }
  const ordered = sortPendingRecords(records)
  const labels = await scheduler.labels(ordered)
  return jsonOk({ items: ordered.map((record, index) => publicRecord(record, labels[index])), now })
}

/**
 * Read one record for the editor, whatever its status.
 * @param scheduler - owning store.
 * @param request - inbound request carrying the id query parameter.
 */
async function handleGet(scheduler, request) {
  const url = new URL(request.url, 'http://localhost')
  const id = url.searchParams.get('id')
  if (id === null || id.length === 0) return jsonError(CODES.invalidId, 'An id query parameter is required.')
  const record = (await scheduler.table()).get(id)
  if (record === undefined) return jsonError(CODES.notFound, 'That scheduled message no longer exists.')
  const labels = await scheduler.labels([record])
  return jsonOk({ message: publicRecord(record, labels[0]), now: Date.now() })
}

/**
 * Merge one edit into a pending record.
 *
 * The stored record is re-read inside the delivery chain, so a concurrent edit
 * is refused by expectedUpdatedAt instead of being overwritten; the merged
 * result is re-validated as a whole, because only it can tell whether the
 * message still has something to send.
 * @param scheduler - owning store.
 * @param request - inbound request carrying the edit.
 */
async function handleUpdate(scheduler, request) {
  const body = await readJsonBody(request, MAX_CREATE_BODY_BYTES)
  if (body.ok !== true) {
    if (body.code === 'body-too-large') return jsonError(CODES.bodyTooLarge, 'That message is too large to save.')
    return jsonError(CODES.invalidRequest, 'The request body could not be read.')
  }
  const validated = validateUpdateRequest(body.value, Date.now())
  if (validated.ok !== true) return jsonError(validated.code, validated.message)
  const changes = validated.value
  return await scheduler.exclusive(async () => {
    const table = await scheduler.table()
    const record = table.get(changes.id)
    if (record === undefined) return jsonError(CODES.notFound, 'That scheduled message no longer exists.')
    if (record.status !== 'pending') return jsonError(CODES.notPending, 'That message is no longer waiting to be sent.')
    if (record.updatedAt !== changes.expectedUpdatedAt) {
      return jsonError(CODES.conflict, 'This message changed in another tab; reopen it and save again.')
    }

    let images = record.images
    if (changes.addImages !== undefined) {
      try {
        const added = await scheduler.ctx.attachments.saveImages(changes.addImages.map(image => ({
          data: Buffer.from(image.data, 'base64'),
          mediaType: image.mediaType,
          ...(image.name === undefined ? {} : { name: image.name }),
        })))
        images = [...images, ...added]
      } catch (error) {
        return jsonError(CODES.invalidImages, describeError(error))
      }
    }

    let files = record.files
    if (changes.addFileIds !== undefined) {
      for (const fileId of changes.addFileIds) {
        const staged = scheduler.stagedFile(fileId)
        if (staged !== undefined) {
          files = [...files, { attachmentId: fileId, name: staged.name, bytes: staged.bytes }]
          continue
        }
        const existing = record.files.find(file => file.attachmentId === fileId)
        if (existing === undefined) {
          return jsonError(CODES.unknownFile, 'One of the attached files is no longer available; attach it again.')
        }
        files = [...files, existing]
      }
    }

    if (changes.removeAttachmentIds !== undefined) {
      const removing = new Set(changes.removeAttachmentIds)
      images = images.filter(ref => !removing.has(ref.attachmentId))
      files = files.filter(ref => !removing.has(ref.attachmentId))
    }

    const merged = {
      ...record,
      ...(changes.text === undefined ? {} : { text: changes.text }),
      ...(changes.dueAt === undefined ? {} : { dueAt: changes.dueAt }),
      ...(changes.target === undefined ? {} : { target: changes.target }),
      images,
      files,
    }
    if (changes.target !== undefined) {
      if (changes.target.kind === 'session') merged.sessionId = changes.target.sessionId
      else delete merged.sessionId
    }

    const checked = validateMerged(merged, scheduler.ctx.attachments?.imageLimits)
    if (checked.ok !== true) return jsonError(checked.code, checked.message)

    const next = parseRecord({ ...merged, updatedAt: nextUpdatedAt(record.updatedAt, Date.now()) })
    await table.put(changes.id, next)
    await scheduler.rearm()
    return jsonOk({ message: publicRecord(next), now: Date.now() })
  })
}

/**
 * Store one uploaded file and stage it for a later update.
 * @param scheduler - owning store.
 * @param request - inbound request whose body is the file.
 */
async function handleUpload(scheduler, request) {
  const url = new URL(request.url, 'http://localhost')
  if (request.body === null || request.body === undefined) {
    return jsonError(CODES.invalidRequest, 'An upload needs a request body.')
  }
  const name = url.searchParams.get('name')
  const counter = { bytes: 0 }
  const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
  try {
    scheduler.pruneStaged()
    const ref = await scheduler.ctx.attachments.saveFileStream({
      data: countingChunks(requestChunks(request.body), counter),
      signal,
      ...(name === null || name.length === 0 ? {} : { name }),
    })
    if (ref.bytes === 0 || counter.bytes === 0) return jsonError(CODES.emptyBody, 'That file is empty.')
    scheduler.stage(ref)
    return jsonOk({ fileId: ref.attachmentId, name: ref.name, bytes: ref.bytes })
  } catch (error) {
    return jsonError(CODES.internal, describeError(error))
  }
}

/**
 * Serve one stored image of one record.
 * @param scheduler - owning store.
 * @param request - inbound request carrying id and attachmentId.
 */
async function handleThumb(scheduler, request) {
  const url = new URL(request.url, 'http://localhost')
  const id = url.searchParams.get('id')
  const attachmentId = url.searchParams.get('attachmentId')
  if (id === null || id.length === 0 || attachmentId === null || attachmentId.length === 0) {
    return jsonError(CODES.invalidRequest, 'id and attachmentId query parameters are required.')
  }
  const record = (await scheduler.table()).get(id)
  if (record === undefined) return jsonError(CODES.notFound, 'That scheduled message no longer exists.', 404)
  const ref = record.images.find(image => image.attachmentId === attachmentId)
  if (ref === undefined) return jsonError(CODES.notFound, 'That image is not attached to this message.', 404)
  try {
    const stored = await scheduler.ctx.attachments.readImage(ref)
    const bytes = stored?.data
    if (bytes === undefined) return jsonError(CODES.notFound, 'That image is no longer stored.', 404)
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': stored.ref?.mediaType ?? ref.mediaType,
        'cache-control': THUMB_CACHE_CONTROL,
      },
    })
  } catch (error) {
    return jsonError(CODES.notFound, describeError(error), 404)
  }
}

/**
 * Name every destination the editor offers.
 * @param scheduler - owning store.
 * @returns the workspaces with their non-archived sessions, newest first.
 */
async function handleTargets(scheduler) {
  const workspaces = await scheduler.workspaces()
  const archived = await scheduler.archivedSessionIds()
  const summaries = await scheduler.sessionSummaries(AbortSignal.timeout(LIST_TIMEOUT_MS))
  const items = []
  for (const workspace of workspaces) {
    if (typeof workspace.id !== 'string' || workspace.id.length === 0) continue
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    const sessions = []
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue
      if (archived.includes(sessionId)) continue
      const summary = summaries?.get(sessionId)
      const title = typeof summary?.title === 'string' && summary.title.length > 0 ? summary.title : undefined
      sessions.push({
        id: sessionId,
        label: title ?? shortId(sessionId),
        ...(title === undefined ? {} : { title }),
        ...(Number.isFinite(summary?.updatedAt) ? { updatedAt: summary.updatedAt } : {}),
        ...(typeof summary?.blank === 'boolean' ? { blank: summary.blank } : {}),
        ...(typeof summary?.running === 'boolean' ? { running: summary.running } : {}),
      })
    }
    sessions.sort((left, right) => {
      const leftMs = Number.isFinite(left.updatedAt) ? left.updatedAt : -1
      const rightMs = Number.isFinite(right.updatedAt) ? right.updatedAt : -1
      return rightMs - leftMs
    })
    items.push({
      id: workspace.id,
      title: typeof workspace.title === 'string' ? workspace.title : '',
      path: typeof workspace.path === 'string' ? workspace.path : '',
      sessions,
    })
  }
  return jsonOk({ workspaces: items })
}

/**
 * Order repeating tasks by title, then id.
 * @param left - one item.
 * @param right - another item.
 * @returns the sort order.
 */
function compareRepeating(left, right) {
  if (left.title !== right.title) return left.title < right.title ? -1 : 1
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

/**
 * Read one stored-as-boolean activity flag.
 * @param entry - one Automation task entry.
 * @returns the flag when the entry carries one, otherwise undefined.
 */
function repeatingEnabled(entry) {
  if (typeof entry.enabled === 'boolean') return entry.enabled
  if (typeof entry.active === 'boolean') return entry.active
  if (entry.status === 'active') return true
  if (entry.status === 'paused' || entry.status === 'ended') return false
  return undefined
}

/**
 * List the repeating tasks the Automation service reports for one session.
 *
 * Read-only and ownership-free: the service is Host-wide, so the tab lists what
 * it reports as session-targeted instead of claiming the tasks this plugin
 * created. A missing service or a failing listing is reported as
 * unavailability rather than an error, so the tab can hide the group.
 * @param scheduler - owning store.
 * @returns the availability flag and at most fifty mapped tasks.
 */
async function handleRepeating(scheduler) {
  const unavailable = { available: false, items: [] }
  const service = scheduler.schedule
  if (service === undefined || service === null || typeof service.list !== 'function') return unavailable
  let listed
  try {
    listed = await service.list({})
  } catch (error) {
    scheduler.ctx.logger?.warn?.('dsh-scheduled-message: listing repeating tasks failed: ' + messageOf(error))
    return unavailable
  }
  const entries = Array.isArray(listed?.items) ? listed.items : []
  const items = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : undefined
    const title = typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : undefined
    const target = isRecord(entry.target) ? entry.target : undefined
    const targetSessionId = target !== undefined && target.kind === 'session'
      && typeof target.sessionId === 'string' && target.sessionId.length > 0
      ? target.sessionId
      : undefined
    if (id === undefined || title === undefined || targetSessionId === undefined) continue
    const item = { id, title, targetSessionId }
    if (typeof entry.rrule === 'string' && entry.rrule.length > 0) item.rrule = entry.rrule
    const enabled = repeatingEnabled(entry)
    if (enabled !== undefined) item.enabled = enabled
    items.push(item)
  }
  items.sort(compareRepeating)
  return { available: true, items: items.slice(0, MAX_REPEATING_ITEMS) }
}

/**
 * Register the durable store, the thirteen HTTP routes and the delivery timer.
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
      scheduler.staged.clear()
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

    /**
     * Register one route, turning an unexpected throw into the JSON envelope.
     *
     * A handler rejects with an envelope of its own; this catches only what
     * escapes, so one broken service cannot answer a browser call with a bare
     * transport error.
     * @param route - route definition.
     * @returns the removal callback.
     */
    const mount = (route) => scope.connection.fetch.register({
      ...route,
      fetch: async (request) => {
        try {
          return await route.fetch(request)
        } catch (error) {
          return jsonError(CODES.internal, describeError(error))
        }
      },
    })

    routes.push(mount({
      path: ROUTE_PREFIX + '/create',
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

    routes.push(mount({
      path: ROUTE_PREFIX + '/list',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => await handleList(scheduler, request),
    }))

    routes.push(mount({
      path: ROUTE_PREFIX + '/list-all',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => await handleListAll(scheduler, request),
    }))

    routes.push(mount({
      path: ROUTE_PREFIX + '/get',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => await handleGet(scheduler, request),
    }))

    routes.push(mount({
      path: ROUTE_PREFIX + '/update',
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => await handleUpdate(scheduler, request),
    }))

    routes.push(mount({
      path: ROUTE_PREFIX + '/upload',
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => await handleUpload(scheduler, request),
    }))

    routes.push(mount({
      path: ROUTE_PREFIX + '/thumb',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => await handleThumb(scheduler, request),
    }))

    routes.push(mount({
      path: ROUTE_PREFIX + '/targets',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => await handleTargets(scheduler),
    }))

    routes.push(mount({
      path: ROUTE_PREFIX + '/repeating',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => jsonOk(await handleRepeating(scheduler)),
    }))

    routes.push(mount({
      path: ROUTE_PREFIX + '/cancel',
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

    routes.push(mount({
      path: ROUTE_PREFIX + '/reschedule',
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
        if (dueMs < Date.now() + MIN_LEAD_MS) {
          return jsonError(CODES.tooSoon, 'Choose a time at least 30 seconds from now.')
        }
        return await settleMutation(scheduler, id, (record) => (
          record.status === 'pending' ? { dueAt: new Date(dueMs).toISOString() } : null
        ))
      },
    }))

    routes.push(mount({
      path: ROUTE_PREFIX + '/send-now',
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

    routes.push(mount({
      path: ROUTE_PREFIX + '/retry',
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
          const pending = parseRecord({
            ...rest,
            status: 'pending',
            dueAt: nowIso,
            updatedAt: nextUpdatedAt(record.updatedAt, Date.now()),
          })
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

/**
 * Services the one-shot path needs.
 *
 * schedule is injected separately and workspaceRegistry is read opportunistically,
 * so neither can stop the plugin from loading.
 */
export const inject = ['storageDomain']
