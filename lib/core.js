/**
 * Pure shared logic for dsh-scheduled-message.
 *
 * Everything here is dependency-free and deterministic so the Host half, the
 * browser half and the unit tests agree on one implementation: 12-hour clock
 * conversion, wall-clock to absolute-instant resolution in an explicit IANA
 * zone, validation of a create request, the RRULE text handed to
 * `ctx.schedule.create`, timer chunking and retention pruning.
 *
 * @module dsh-scheduled-message/lib/core
 */

/** Plugin id, locale namespace and browser entry name. */
export const NS = 'dsh-scheduled-message'

/**
 * Durable storage domain name.
 *
 * Storage unit names are narrower than package names: `@deepseek-ai/dsh-storage`
 * matches them against `/^[a-z][a-z0-9_]*$/`, so the package name (which has
 * hyphens) would be refused when the domain is defined.
 */
export const DOMAIN_NAME = 'dsh_scheduled_message'

/** A scheduled instant must be at least this far ahead of the accepted request. */
export const MIN_LEAD_MS = 30_000

/** Longest accepted message text. */
export const MAX_TEXT_CHARS = 200_000

/** Most images accepted in one scheduled message. */
export const MAX_IMAGES = 10

/** Most `pending` records the Host keeps. */
export const MAX_PENDING = 500

/** Longest title accepted by `ctx.schedule.create`. */
export const MAX_TITLE_CHARS = 120

/** `setTimeout` stores its delay in a signed 32-bit integer. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Acceptance later than this after the due instant is reported as accepted late. */
export const LATE_THRESHOLD_MS = 60_000

/** Finished records older than this are pruned. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Durable record schema the Host writes; v2 adds a delivery target. */
export const DOMAIN_VERSION = 2

/**
 * Earlier record versions this build still opens.
 *
 * A v1 record carries `sessionId` where v2 carries `target`; {@link migrateRecord} and
 * {@link parseRecord} accept that shape, so upgrading the plugin never strands
 * a message that was scheduled before the upgrade.
 */
export const COMPATIBLE_VERSIONS = Object.freeze([1])

/** Every record status, in lifecycle order. */
export const RECORD_STATUSES = Object.freeze(['pending', 'sending', 'sent', 'failed', 'cancelled'])

/** Longest stored diagnostic. */
export const MAX_ERROR_CHARS = 500

/** Fallback per-image cap, used when the caller passes no `imageLimits`. */
export const MAX_IMAGE_BYTES = 5_000_000

/** Fallback cap on every image of one message together, in decoded bytes. */
export const MAX_MESSAGE_IMAGE_BYTES = 20_000_000

/** Settled records a list still shows, in the trailing accepted group. */
export const SENT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Two pending messages to one conversation this close together queue behind
 * each other: DSH accepts both, then runs one turn after the other.
 */
export const CONFLICT_WINDOW_MS = 120_000

/** Repeat frequencies the composer offers. */
export const REPEAT_FREQUENCIES = Object.freeze(['daily', 'weekdays', 'weekly', 'monthly'])

const ISO_WEEKDAY_CODES = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** Clamp and zero-pad one clock field. */
export function pad2(value) {
  return String(Math.trunc(value)).padStart(2, '0')
}

/**
 * Convert a 24-hour clock hour to the 12-hour face shown in the picker.
 * @param hour24 - hour in 0..23.
 * @returns the 1..12 hour and its meridiem; an out-of-range hour throws.
 */
export function toMeridiem(hour24) {
  if (!Number.isInteger(hour24) || hour24 < 0 || hour24 > 23) throw new RangeError(`hour out of range: ${hour24}`)
  if (hour24 === 0) return { hour12: 12, meridiem: 'AM' }
  if (hour24 < 12) return { hour12: hour24, meridiem: 'AM' }
  if (hour24 === 12) return { hour12: 12, meridiem: 'PM' }
  return { hour12: hour24 - 12, meridiem: 'PM' }
}

/**
 * Convert the picker's 12-hour face back to a 24-hour clock hour.
 * @param hour12 - hour in 1..12.
 * @param meridiem - 'AM' or 'PM'.
 * @returns the 0..23 hour; a malformed input throws.
 */
export function to24Hour(hour12, meridiem) {
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) throw new RangeError(`hour out of range: ${hour12}`)
  if (meridiem !== 'AM' && meridiem !== 'PM') throw new RangeError(`meridiem out of range: ${String(meridiem)}`)
  const base = hour12 % 12
  return meridiem === 'PM' ? base + 12 : base
}

/**
 * Render the picker's clock face for a copy line.
 * @param hour12 - hour in 1..12.
 * @param minute - minute in 0..59.
 * @param meridiem - 'AM' or 'PM'.
 * @returns text such as `9:00 AM`.
 */
export function formatClock(hour12, minute, meridiem) {
  return `${hour12}:${pad2(minute)} ${meridiem}`
}

/**
 * Read a strict `YYYY-MM-DD` calendar date without consulting a process zone.
 * @param text - candidate date.
 * @returns the three fields, or null when the text is not a real calendar date.
 */
export function parseLocalDate(text) {
  if (typeof text !== 'string') return null
  const match = ISO_DATE.exec(text)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  return { year, month, day }
}

/**
 * Whether a name is usable as an IANA zone for `Intl`.
 * @param timeZone - candidate zone name.
 * @returns whether `Intl.DateTimeFormat` accepts it; `UTC` is accepted.
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

const offsetFormatters = new Map()

function offsetFormatter(timeZone) {
  let formatter = offsetFormatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    offsetFormatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Read the wall clock of one instant in one zone.
 * @param instantMs - epoch milliseconds.
 * @param timeZone - explicit IANA zone.
 * @returns local calendar fields, including the ISO weekday 1..7 (Monday first).
 */
export function localParts(instantMs, timeZone) {
  const parts = offsetFormatter(timeZone).formatToParts(new Date(instantMs))
  const field = (type) => Number(parts.find(part => part.type === type)?.value)
  const year = field('year')
  const month = field('month')
  const day = field('day')
  const hour24 = field('hour')
  const minute = field('minute')
  const second = field('second')
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return {
    year,
    month,
    day,
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    hour24,
    minute,
    second,
    isoWeekday: weekday === 0 ? 7 : weekday,
  }
}

/**
 * Offset of one zone at one instant, in milliseconds (local minus UTC).
 * @param instantMs - epoch milliseconds.
 * @param timeZone - explicit IANA zone.
 * @returns the offset, positive east of Greenwich.
 */
export function zoneOffsetMs(instantMs, timeZone) {
  const local = localParts(instantMs, timeZone)
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour24, local.minute, local.second)
  return asUtc - Math.floor(instantMs / 1000) * 1000
}

/**
 * Resolve a wall-clock selection in an explicit zone to an absolute instant.
 *
 * The selection is the one the picker shows, so it is interpreted in the
 * browser's zone; the Host only ever sees the resulting absolute instant.
 * A wall clock that a daylight-saving gap removed is refused instead of being
 * shifted silently.
 * @param selection - `date` (`YYYY-MM-DD`), `hour24` (0..23) and `minute` (0..59).
 * @param timeZone - explicit IANA zone.
 * @returns the resolved instant, or a rejection naming the reason.
 */
export function wallClockToInstant(selection, timeZone) {
  if (!isValidTimeZone(timeZone)) return { ok: false, reason: 'invalid-time-zone' }
  const date = parseLocalDate(selection?.date)
  const hour24 = selection?.hour24
  const minute = selection?.minute
  if (date === null) return { ok: false, reason: 'invalid-date' }
  if (!Number.isInteger(hour24) || hour24 < 0 || hour24 > 23) return { ok: false, reason: 'invalid-time' }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { ok: false, reason: 'invalid-time' }
  const target = Date.UTC(date.year, date.month - 1, date.day, hour24, minute, 0, 0)
  // Two passes settle zones whose offset at UTC midnight differs from the
  // offset at the resolved instant; a third pass changes nothing.
  let instantMs = target - zoneOffsetMs(target, timeZone)
  instantMs = target - zoneOffsetMs(instantMs, timeZone)
  const check = localParts(instantMs, timeZone)
  if (check.date !== `${date.year}-${pad2(date.month)}-${pad2(date.day)}`
    || check.hour24 !== hour24 || check.minute !== minute) {
    return { ok: false, reason: 'nonexistent-local-time' }
  }
  return { ok: true, instantMs, iso: new Date(instantMs).toISOString() }
}

/**
 * Build the two-line `DTSTART` + `RRULE` text `ctx.schedule.create` accepts.
 *
 * `DTSTART` carries the zone, so the wall clock the user chose is kept across
 * daylight-saving changes and Host zone changes; `BYDAY`/`BYMONTHDAY` project
 * that same wall clock onto the requested cadence.
 * @param options - repeat frequency, first occurrence instant and explicit zone.
 * @returns normalized recurrence text; an unsupported frequency throws.
 */
export function buildRrule({ repeat, instantMs, timeZone }) {
  if (!REPEAT_FREQUENCIES.includes(repeat)) throw new RangeError(`unsupported repeat: ${String(repeat)}`)
  if (!isValidTimeZone(timeZone)) throw new RangeError(`invalid time zone: ${String(timeZone)}`)
  const parts = localParts(instantMs, timeZone)
  const stamp = `${parts.date.replaceAll('-', '')}T${pad2(parts.hour24)}${pad2(parts.minute)}00`
  const start = `DTSTART;TZID=${timeZone}:${stamp}`
  const day = ISO_WEEKDAY_CODES[parts.isoWeekday - 1]
  switch (repeat) {
    case 'daily':
      return `${start}\nRRULE:FREQ=DAILY`
    case 'weekdays':
      return `${start}\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;WKST=MO`
    case 'weekly':
      return `${start}\nRRULE:FREQ=WEEKLY;BYDAY=${day};WKST=MO`
    default:
      return `${start}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=${parts.day}`
  }
}

/**
 * Whether a monthly rule on this day of month skips shorter months.
 * @param dayOfMonth - day 1..31.
 * @returns whether the rule cannot fire in every month.
 */
export function skipsShortMonths(dayOfMonth) {
  return Number.isInteger(dayOfMonth) && dayOfMonth >= 29 && dayOfMonth <= 31
}

/**
 * Compress a message into the one-line title `ctx.schedule.create` requires.
 * @param text - message text.
 * @param max - longest accepted title; 120 by default.
 * @returns a trimmed single line no longer than `max` characters.
 */
export function summariseTitle(text, max = MAX_TITLE_CHARS) {
  const collapsed = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return ''
  if (collapsed.length <= max) return collapsed
  if (max <= 1) return collapsed.slice(0, Math.max(max, 0))
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/**
 * Validate one create request before any durable work happens.
 *
 * Pure: the caller supplies the clock, so the same request validates
 * identically in the browser and in the Host.
 * The body names exactly one destination: the v1 `sessionId`, or a v2
 * `target` that may also open a new conversation at send time. Both or neither
 * is refused instead of being resolved by a fallback, so an old client keeps
 * sending the one shape it always sent.
 * @param payload - untrusted request body.
 * @param nowMs - the accepting clock.
 * @returns normalized content, or a stable rejection code and message.
 */
export function validateCreateRequest(payload, nowMs) {
  const fail = (code, message) => ({ ok: false, code, message })
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('invalid-request', 'The request body must be an object.')
  }
  const { sessionId, dueAt, timeZone } = payload
  const hasSessionId = typeof sessionId === 'string' && sessionId.length > 0
  const hasTarget = payload.target !== undefined && payload.target !== null
  if (hasSessionId && hasTarget) {
    return fail('invalid-request', 'Send either sessionId or target, not both.')
  }
  if (!hasSessionId && !hasTarget) return fail('invalid-session', 'A session id is required.')
  if (typeof dueAt !== 'string' || !ISO_INSTANT.test(dueAt)) {
    return fail('invalid-due-at', 'dueAt must be an absolute ISO instant with an offset or Z.')
  }
  const dueMs = Date.parse(dueAt)
  if (!Number.isFinite(dueMs)) return fail('invalid-due-at', 'dueAt is not a real instant.')
  if (dueMs < nowMs + MIN_LEAD_MS) {
    return fail('too-soon', `Choose a time at least ${Math.round(MIN_LEAD_MS / 1000)} seconds from now.`)
  }
  if (!isValidTimeZone(timeZone)) return fail('invalid-time-zone', 'timeZone must be an IANA zone name or UTC.')

  const target = hasTarget
    ? validateTarget(payload.target)
    : { ok: true, value: { kind: 'session', sessionId } }
  if (target.ok !== true) return fail(target.code, target.message)

  const text = typeof payload.text === 'string' ? payload.text : ''
  if (text.length > MAX_TEXT_CHARS) return fail('text-too-long', `A message may carry at most ${MAX_TEXT_CHARS} characters.`)
  const images = Array.isArray(payload.images) ? payload.images : payload.images === undefined ? [] : null
  if (images === null) return fail('invalid-images', 'images must be an array.')
  if (images.length > MAX_IMAGES) return fail('too-many-images', `A message may carry at most ${MAX_IMAGES} images.`)
  for (const image of images) {
    if (image === null || typeof image !== 'object'
      || typeof image.mediaType !== 'string' || image.mediaType.length === 0
      || typeof image.data !== 'string' || image.data.length === 0) {
      return fail('invalid-images', 'Every image needs a mediaType and base64 data.')
    }
  }
  const rawReceipts = payload.fileReceipts ?? []
  if (!Array.isArray(rawReceipts) || rawReceipts.some(id => typeof id !== 'string' || id.length === 0)) {
    return fail('invalid-files', 'fileReceipts must be a list of receipt ids.')
  }
  const fileReceipts = [...new Set(rawReceipts)]

  const trimmed = text.trim()
  if (trimmed.length === 0 && images.length === 0 && fileReceipts.length === 0) {
    return fail('empty', 'Type a message or attach something first.')
  }

  const repeat = payload.repeat ?? null
  if (repeat !== null && !REPEAT_FREQUENCIES.includes(repeat)) {
    return fail('invalid-repeat', 'repeat must be daily, weekdays, weekly or monthly.')
  }
  if (repeat !== null && (images.length > 0 || fileReceipts.length > 0)) {
    return fail('repeat-with-attachments', "Repeating messages can't include images or files.")
  }
  if (repeat !== null && trimmed.length === 0) {
    return fail('empty', 'A repeating message needs text.')
  }
  // A repeating task is created against one conversation in the Automation
  // service, so it cannot be addressed to one that does not exist yet.
  if (repeat !== null && target.value.kind !== 'session') {
    return fail('repeat-with-new-conversation', 'A repeating message needs an existing conversation.')
  }

  // A staged file receipt is memory-only and belongs to the conversation that
  // uploaded it. A session target is that conversation, so its receipts resolve
  // against its own agent. A new-conversation target opens a different
  // conversation at delivery, so it must name the uploader explicitly; the
  // Host resolves the receipt now and stores only the durable attachment ref.
  const hasSourceSessionId = payload.sourceSessionId !== undefined
  if (hasSourceSessionId && target.value.kind !== 'new') {
    return fail('invalid-request', 'sourceSessionId is only for a new-conversation target.')
  }
  if (hasSourceSessionId && (typeof payload.sourceSessionId !== 'string' || payload.sourceSessionId.length === 0)) {
    return fail('invalid-request', 'sourceSessionId must be a non-empty conversation id.')
  }
  if (target.value.kind === 'new' && fileReceipts.length > 0 && !hasSourceSessionId) {
    return fail('invalid-request', 'A new conversation with attached files needs the conversation that uploaded them.')
  }

  return {
    ok: true,
    value: {
      target: target.value,
      ...(target.value.kind === 'session' ? { sessionId: target.value.sessionId } : {}),
      ...(target.value.kind === 'new' && hasSourceSessionId ? { sourceSessionId: payload.sourceSessionId } : {}),
      dueAt: new Date(dueMs).toISOString(),
      dueMs,
      timeZone,
      text: trimmed,
      images: images.map(image => ({
        mediaType: image.mediaType,
        data: image.data,
        ...(typeof image.name === 'string' && image.name.length > 0 ? { name: image.name } : {}),
      })),
      fileReceipts,
      repeat,
    },
  }
}

// ---------------------------------------------------------------- record schema v2

const STATUS_SET = new Set(RECORD_STATUSES)

const DRIVE_PATH = /^[A-Za-z]:[\\/]/

const UNC_PATH = /^\\\\/

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalText(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function copyRef(ref) {
  return isPlainObject(ref) ? { ...ref } : ref
}

function migratedRefs(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value.map(copyRef) : value
}

/** Whether a path looks absolute on POSIX or Windows, so a new conversation can open it. */
function isAbsolutePath(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return text.startsWith('/') || DRIVE_PATH.test(text) || UNC_PATH.test(text)
}

/** The target a stored record implies: a v2 target as it is, or a v1 session id. */
function migratedTarget(raw) {
  const target = raw.target
  if (isPlainObject(target)) {
    if (target.kind === 'session' && typeof target.sessionId === 'string') {
      return { kind: 'session', sessionId: target.sessionId }
    }
    if (target.kind === 'new') {
      const migrated = { kind: 'new', cwd: typeof target.cwd === 'string' ? target.cwd : '' }
      const workspaceId = optionalText(target.workspaceId)
      if (workspaceId !== undefined) migrated.workspaceId = workspaceId
      const title = optionalText(target.title)
      if (title !== undefined) migrated.title = title
      return migrated
    }
    // A malformed v2 target is kept so parseRecord can reject it loudly instead
    // of the migration inventing a destination.
    return copyRef(target)
  }
  const sessionId = optionalText(raw.sessionId)
  return sessionId === undefined ? undefined : { kind: 'session', sessionId }
}

/**
 * Bring one stored record up to the v2 shape.
 *
 * v1 stored `sessionId`; v2 stores `target`. The migration derives a session target
 * from a v1 record, keeps an already-v2 target as it is, and fills absent
 * fields with defaults instead of throwing, so a lenient read can never lose a
 * message. `sessionId` always mirrors a `kind: 'session'` target, so a moved record
 * cannot leave a stale id behind; for a `kind: 'new'` target it holds the id of
 * the conversation that was created.
 * @param raw - one stored record, v1 or v2.
 * @returns the v2-shaped record, or null when `raw` is not an object.
 */
export function migrateRecord(raw) {
  if (!isPlainObject(raw)) return null
  const migrated = {
    id: typeof raw.id === 'string' ? raw.id : '',
    dueAt: typeof raw.dueAt === 'string' ? raw.dueAt : '',
    timeZone: optionalText(raw.timeZone) ?? 'UTC',
    text: typeof raw.text === 'string' ? raw.text : '',
    images: migratedRefs(raw.images),
    files: migratedRefs(raw.files),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    status: typeof raw.status === 'string' ? raw.status : 'pending',
  }
  const target = migratedTarget(raw)
  if (target !== undefined) migrated.target = target
  const sessionId = target !== undefined && target.kind === 'session'
    ? target.sessionId
    : optionalText(raw.sessionId)
  if (typeof sessionId === 'string' && sessionId.length > 0) migrated.sessionId = sessionId
  if (typeof raw.sentAt === 'string') migrated.sentAt = raw.sentAt
  if (raw.late !== undefined) migrated.late = Boolean(raw.late)
  if (typeof raw.error === 'string' && raw.error.length > 0) migrated.error = raw.error
  return migrated
}

function requireInstant(record, key) {
  const value = record[key]
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(key + ' must be an absolute instant')
  }
  return value
}

function normalizedRefs(refs, key) {
  if (!Array.isArray(refs)) throw new Error(key + ' must be an array')
  return refs.map((ref) => {
    if (!isPlainObject(ref)) throw new Error(key + ' entries must be objects')
    if (typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0) {
      throw new Error(key + ' entries need an attachmentId')
    }
    return copyRef(ref)
  })
}

/**
 * Validate and normalize one stored record, accepting both schema shapes.
 *
 * This is the record table's `parse`: the storage layer only ever calls it, so
 * nothing the Host did not write reaches the rest of the plugin. A session
 * target owns the resolved id. An absent `timeZone` and an unknown one both
 * fall back to `UTC`, because a zone tzdata dropped must not make the whole
 * domain unreadable.
 * @param raw - untrusted stored record, v1 or v2.
 * @param options - `maxErrorChars`, the longest kept diagnostic; 500 by default.
 * @returns the normalized v2 record.
 * @throws Error when the record is structurally invalid.
 */
export function parseRecord(raw, options) {
  const maxErrorChars = Number.isInteger(options?.maxErrorChars) && options.maxErrorChars >= 0
    ? options.maxErrorChars
    : MAX_ERROR_CHARS
  const migrated = migrateRecord(raw)
  if (migrated === null) throw new Error('a scheduled message must be an object')
  if (migrated.id.length === 0) throw new Error('id must be a non-empty string')
  if (!STATUS_SET.has(migrated.status)) throw new Error('unknown status ' + migrated.status)
  if (migrated.target === undefined) throw new Error('target is required: a session id or a new-conversation cwd')
  const target = validateTarget(migrated.target)
  if (!target.ok) throw new Error(target.message)
  requireInstant(migrated, 'dueAt')
  requireInstant(migrated, 'createdAt')
  requireInstant(migrated, 'updatedAt')
  const record = {
    id: migrated.id,
    target: target.value,
    dueAt: migrated.dueAt,
    timeZone: isValidTimeZone(migrated.timeZone) ? migrated.timeZone : 'UTC',
    text: migrated.text,
    images: normalizedRefs(migrated.images, 'images'),
    files: normalizedRefs(migrated.files, 'files'),
    createdAt: migrated.createdAt,
    updatedAt: migrated.updatedAt,
    status: migrated.status,
  }
  if (target.value.kind === 'session') record.sessionId = target.value.sessionId
  else if (migrated.sessionId !== undefined) record.sessionId = migrated.sessionId
  if (migrated.sentAt !== undefined) record.sentAt = requireInstant(migrated, 'sentAt')
  if (migrated.late !== undefined) record.late = Boolean(migrated.late)
  if (migrated.error !== undefined) record.error = String(migrated.error).slice(0, maxErrorChars)
  return record
}

/**
 * Advance a record's optimistic-concurrency token.
 *
 * The new instant is strictly greater than the previous one, so two writes in
 * the same millisecond cannot compare equal. The caller passes the clock: this
 * is deterministic and never reads `Date` itself.
 * @param previousIso - the record's current `updatedAt`, if any.
 * @param nowMs - the writing clock.
 * @returns an ISO instant strictly later than `previousIso` when that parses.
 */
export function nextUpdatedAt(previousIso, nowMs) {
  const previousMs = Date.parse(previousIso)
  const clockMs = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Number.NaN
  const floorMs = Number.isFinite(previousMs) ? previousMs + 1 : clockMs
  const nextMs = Number.isFinite(clockMs) ? Math.max(clockMs, floorMs) : floorMs
  return new Date(Number.isFinite(nextMs) ? nextMs : 0).toISOString()
}

/**
 * The session a record belongs to today.
 *
 * `sessionId` wins when a `kind: 'new'` record has already created its
 * conversation; otherwise a session target names it. A `kind: 'new'` record
 * that has not fired yet belongs to no session.
 * @param record - a stored record, v1 or v2.
 * @returns the session id, or undefined when there is none yet.
 */
export function resolveSessionId(record) {
  if (!isPlainObject(record)) return undefined
  const sessionId = optionalText(record.sessionId)
  if (sessionId !== undefined) return sessionId
  const target = record.target
  if (isPlainObject(target) && target.kind === 'session') return optionalText(target.sessionId)
  return undefined
}

/**
 * Validate one delivery target shared by create and update.
 *
 * `kind: 'session'` needs an existing conversation; `kind: 'new'` needs an absolute
 * cwd to open the conversation in at send time, plus optional workspace and
 * title hints. Unknown fields are dropped so one target shape reaches storage.
 * @param target - untrusted target.
 * @returns the normalized target, or the stable code `invalid-target`.
 */
export function validateTarget(target) {
  const reject = (message) => ({ ok: false, code: 'invalid-target', message })
  if (!isPlainObject(target)) return reject('target must be an object')
  if (target.kind === 'session') {
    if (typeof target.sessionId !== 'string' || target.sessionId.length === 0) {
      return reject('A session target needs a session id.')
    }
    return { ok: true, value: { kind: 'session', sessionId: target.sessionId } }
  }
  if (target.kind === 'new') {
    if (!isAbsolutePath(target.cwd)) {
      return reject('A new-conversation target needs an absolute cwd.')
    }
    const value = { kind: 'new', cwd: target.cwd }
    for (const key of ['workspaceId', 'title']) {
      if (target[key] === undefined) continue
      if (typeof target[key] !== 'string' || target[key].length === 0) {
        return reject('target.' + key + ' must be a non-empty string')
      }
      value[key] = target[key]
    }
    return { ok: true, value }
  }
  return reject("target.kind must be 'session' or 'new'")
}

/**
 * Estimate the decoded size of base64 data without decoding it.
 * @param data - base64 text, whitespace tolerated.
 * @returns the byte count the encoded payload stands for; 0 for anything else.
 */
export function estimateBase64Bytes(data) {
  if (typeof data !== 'string' || data.length === 0) return 0
  const clean = data.replace(/\s+/gu, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

function cappedValue(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

/**
 * Check message content against the limits one message must respect.
 *
 * Codes, in the order they are reported: `invalid-text`, `text-too-long`,
 * `invalid-images`, `too-many-images`, `image-too-large` (one image over
 * `maxImageBytes`), `images-too-large` (all images over
 * `maxMessageImageBytes`), `invalid-files` (an entry without an `attachmentId`
 * or with negative bytes) and `files-too-large` (over the optional `maxFilesBytes`).
 * @param input - `text`, `images`, `files` and the caller's `limits`.
 * @returns normalized content and its sizes, or a rejection code and message.
 */
export function checkMessageContent(input) {
  return checkContent(isPlainObject(input) ? input : {}, isPlainObject(input) && isPlainObject(input.limits) ? input.limits : {})
}

function checkContent(payload, limits, acceptRefs) {
  const fail = (code, message) => ({ ok: false, code, message })
  const maxTextChars = cappedValue(limits.maxTextChars, MAX_TEXT_CHARS)
  const maxImages = Math.min(
    MAX_IMAGES,
    cappedValue(limits.maxImages, MAX_IMAGES),
    cappedValue(limits.maxImagesPerMessage, MAX_IMAGES),
  )
  const maxImageBytes = cappedValue(limits.maxImageBytes, MAX_IMAGE_BYTES)
  const maxMessageImageBytes = cappedValue(limits.maxMessageImageBytes, MAX_MESSAGE_IMAGE_BYTES)
  const maxFilesBytes = cappedValue(limits.maxFilesBytes, Number.POSITIVE_INFINITY)

  const text = payload.text === undefined ? '' : payload.text
  if (typeof text !== 'string') return fail('invalid-text', 'text must be a string.')
  if (text.length > maxTextChars) {
    return fail('text-too-long', 'A message may carry at most ' + maxTextChars + ' characters.')
  }

  const rawImages = payload.images === undefined ? [] : payload.images
  if (!Array.isArray(rawImages)) return fail('invalid-images', 'images must be an array.')
  if (rawImages.length > maxImages) {
    return fail('too-many-images', 'A message may carry at most ' + maxImages + ' images.')
  }
  const images = []
  let imageBytes = 0
  for (const image of rawImages) {
    const hasData = isPlainObject(image)
      && typeof image.mediaType === 'string' && image.mediaType.length > 0
      && typeof image.data === 'string' && image.data.length > 0
    // A stored record holds attachment refs, not bytes; the merged check may
    // accept one because the bytes live in the attachment store.
    const isStoredRef = acceptRefs && isPlainObject(image)
      && typeof image.attachmentId === 'string' && image.attachmentId.length > 0
    if (!hasData && !isStoredRef) {
      return fail('invalid-images', 'Every image needs a mediaType and base64 data.')
    }
    if (!hasData) {
      images.push({ ...image })
      continue
    }
    const bytes = estimateBase64Bytes(image.data)
    if (bytes > maxImageBytes) {
      return fail('image-too-large', 'An image may hold at most ' + maxImageBytes + ' bytes.')
    }
    imageBytes += bytes
    images.push({
      mediaType: image.mediaType,
      data: image.data,
      ...(optionalText(image.name) === undefined ? {} : { name: image.name }),
    })
  }
  if (imageBytes > maxMessageImageBytes) {
    return fail('images-too-large', 'The images of one message may hold at most ' + maxMessageImageBytes + ' bytes.')
  }

  const rawFiles = payload.files === undefined ? [] : payload.files
  if (!Array.isArray(rawFiles)) return fail('invalid-files', 'files must be an array.')
  const files = []
  let fileBytes = 0
  for (const file of rawFiles) {
    if (!isPlainObject(file) || typeof file.attachmentId !== 'string' || file.attachmentId.length === 0) {
      return fail('invalid-files', 'Every file needs an attachmentId.')
    }
    if (file.bytes !== undefined && (!Number.isFinite(file.bytes) || file.bytes < 0)) {
      return fail('invalid-files', 'file bytes must be a non-negative number.')
    }
    fileBytes += file.bytes === undefined ? 0 : file.bytes
    files.push({ ...file })
  }
  if (fileBytes > maxFilesBytes) {
    return fail('files-too-large', 'A message may carry at most ' + maxFilesBytes + ' bytes of files.')
  }

  return { ok: true, value: { text, images, files, textChars: text.length, imageBytes, fileBytes } }
}

/**
 * Validate everything a create or update may put in one message.
 *
 * One implementation for both paths, so the composer and the editor can never
 * disagree. Limits default to {@link MAX_TEXT_CHARS}, {@link MAX_IMAGES},
 * {@link MAX_IMAGE_BYTES} and {@link MAX_MESSAGE_IMAGE_BYTES}; the caller may
 * narrow any of them, typically from `ctx.attachments.imageLimits`.
 * @param input - `text`, `images`, `files` and `limits`, all optional.
 * @returns normalized content, or code `empty` when nothing would be sent, or
 *   one of the codes {@link checkMessageContent} documents.
 */
function validateContent(payload, limits, acceptRefs) {
  const checked = checkContent(payload, limits, acceptRefs)
  if (!checked.ok) return checked
  const { text, images, files } = checked.value
  if (text.trim().length === 0 && images.length === 0 && files.length === 0) {
    return { ok: false, code: 'empty', message: 'Type a message or attach something first.' }
  }
  return checked
}

export function validateMessageContent(input) {
  const payload = isPlainObject(input) ? input : {}
  const limits = isPlainObject(payload.limits) ? payload.limits : {}
  return validateContent(payload, limits, false)
}

/**
 * Re-check a record after an update was merged into it.
 *
 * An update that only removes attachments and blanks the text is legal on its
 * own, but leaves a message with nothing to send; only the merged record can
 * answer that question. Stored images are attachment refs rather than base64
 * data, so a ref counts as an attachment here; the update path still refuses a
 * new image without bytes.
 * @param record - the record as it would be stored after the update.
 * @param limits - optional tightened content limits.
 * @returns the same result shape as {@link validateMessageContent}.
 */
export function validateMerged(record, limits) {
  const merged = isPlainObject(record) ? record : {}
  return validateContent({
    text: merged.text,
    images: merged.images,
    files: merged.files,
  }, isPlainObject(limits) ? limits : {}, true)
}

function dedupedIds(value) {
  if (!Array.isArray(value)) return null
  if (value.some((id) => typeof id !== 'string' || id.length === 0)) return null
  return [...new Set(value)]
}

/**
 * Validate one `/update` request before the record is touched.
 *
 * Every change field is optional, but at least one must be present and the
 * request must name the record version it was built from, so a stale tab is
 * refused instead of overwriting a newer edit. An empty `text` is accepted
 * here on purpose: only the merged record can say whether the message became
 * empty, and {@link validateMerged} answers that.
 * @param payload - untrusted request body.
 * @param nowMs - the accepting clock.
 * @returns the normalized changes, or a stable rejection code and message:
 *   `invalid-request`, `invalid-id`, `invalid-expected-updated-at`,
 *   `invalid-due-at`, `too-soon`, `invalid-text`, `text-too-long`,
 *   `invalid-target`, the image codes, `invalid-files`,
 *   `invalid-attachment-ids` and `nothing-to-update`.
 */
export function validateUpdateRequest(payload, nowMs) {
  const fail = (code, message) => ({ ok: false, code, message })
  if (!isPlainObject(payload)) return fail('invalid-request', 'The request body must be an object.')
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    return fail('invalid-id', 'id must be a non-empty string.')
  }
  if (typeof payload.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(payload.expectedUpdatedAt))) {
    return fail('invalid-expected-updated-at', 'expectedUpdatedAt must be the record version you loaded.')
  }
  const value = { id: payload.id, expectedUpdatedAt: payload.expectedUpdatedAt }
  let changes = 0

  if (payload.dueAt !== undefined) {
    if (typeof payload.dueAt !== 'string'
      || !ISO_INSTANT.test(payload.dueAt)
      || !Number.isFinite(Date.parse(payload.dueAt))) {
      return fail('invalid-due-at', 'dueAt must be an absolute ISO instant with an offset or Z.')
    }
    const dueMs = Date.parse(payload.dueAt)
    if (dueMs < nowMs + MIN_LEAD_MS) {
      return fail('too-soon', 'Choose a time at least ' + Math.round(MIN_LEAD_MS / 1000) + ' seconds from now.')
    }
    value.dueAt = new Date(dueMs).toISOString()
    value.dueMs = dueMs
    changes += 1
  }

  if (payload.text !== undefined) {
    if (typeof payload.text !== 'string') return fail('invalid-text', 'text must be a string.')
    if (payload.text.length > MAX_TEXT_CHARS) {
      return fail('text-too-long', 'A message may carry at most ' + MAX_TEXT_CHARS + ' characters.')
    }
    value.text = payload.text.trim()
    changes += 1
  }

  if (payload.target !== undefined) {
    const target = validateTarget(payload.target)
    if (!target.ok) return fail(target.code, target.message)
    value.target = target.value
    changes += 1
  }

  if (payload.addImages !== undefined) {
    const images = checkContent({ images: payload.addImages }, {})
    if (!images.ok) return images
    if (images.value.images.length > 0) {
      value.addImages = images.value.images
      changes += 1
    }
  }

  if (payload.addFileIds !== undefined) {
    const ids = dedupedIds(payload.addFileIds)
    if (ids === null) return fail('invalid-files', 'addFileIds must be a list of attachment ids.')
    if (ids.length > 0) {
      value.addFileIds = ids
      changes += 1
    }
  }

  if (payload.removeAttachmentIds !== undefined) {
    const ids = dedupedIds(payload.removeAttachmentIds)
    if (ids === null) return fail('invalid-attachment-ids', 'removeAttachmentIds must be a list of attachment ids.')
    if (ids.length > 0) {
      value.removeAttachmentIds = ids
      changes += 1
    }
  }

  if (changes === 0) return fail('nothing-to-update', 'Change the time, the message or the destination first.')
  return { ok: true, value }
}

/**
 * Pick the record that must be delivered first.
 * @param records - every stored record.
 * @returns the earliest `pending` (or crash-left `sending`) record, if any.
 */
export function earliestPending(records) {
  let best
  let bestMs = Number.POSITIVE_INFINITY
  for (const record of records) {
    if (record.status !== 'pending' && record.status !== 'sending') continue
    const dueMs = Date.parse(record.dueAt)
    if (!Number.isFinite(dueMs)) continue
    if (dueMs < bestMs) {
      best = record
      bestMs = dueMs
    }
  }
  return best
}

/**
 * Clamp the wait for one due instant to what `setTimeout` can hold.
 * @param dueMs - target instant.
 * @param nowMs - current instant.
 * @returns a non-negative delay no larger than {@link MAX_TIMER_DELAY_MS}.
 */
export function timerDelay(dueMs, nowMs) {
  const remaining = dueMs - nowMs
  if (!Number.isFinite(remaining)) return MAX_TIMER_DELAY_MS
  return Math.min(Math.max(Math.round(remaining), 0), MAX_TIMER_DELAY_MS)
}

/**
 * Whether a delivery happened long enough after its due instant to be reported late.
 * @param dueMs - the instant the message was due.
 * @param deliveredMs - the instant delivery settled.
 * @returns whether the delivery is late by more than {@link LATE_THRESHOLD_MS}.
 */
export function isLate(dueMs, deliveredMs) {
  return Number.isFinite(dueMs) && deliveredMs - dueMs > LATE_THRESHOLD_MS
}

/**
 * Choose the finished records that retention should drop.
 * @param records - every stored record.
 * @param nowMs - current instant.
 * @returns ids of finished records older than {@link RETENTION_MS}.
 */
export function pruneTargets(records, nowMs) {
  const ids = []
  for (const record of records) {
    if (record.status !== 'sent' && record.status !== 'cancelled') continue
    const settledMs = Date.parse(record.sentAt ?? record.updatedAt ?? record.createdAt)
    if (!Number.isFinite(settledMs)) continue
    if (nowMs - settledMs > RETENTION_MS) ids.push(record.id)
  }
  return ids
}

/**
 * Count the records a session's composer strip should show.
 * @param records - records for one session.
 * @param nowMs - current instant.
 * @returns how many are still scheduled and when the next one fires.
 */
export function pendingSummary(records, nowMs) {
  let pending = 0
  let nextMs = Number.POSITIVE_INFINITY
  for (const record of records) {
    if (record.status !== 'pending') continue
    pending += 1
    const dueMs = Date.parse(record.dueAt)
    if (Number.isFinite(dueMs) && dueMs < nextMs) nextMs = dueMs
  }
  return { pending, nextDueMs: Number.isFinite(nextMs) ? nextMs : null, nowMs }
}

// ---------------------------------------------------------------- scheduled tab

function localDayNumber(parts) {
  return Math.round(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000)
}

/**
 * Name the day one instant falls on, relative to now, in one explicit zone.
 *
 * Days are compared as local calendar dates, never as elapsed time, so a
 * daylight-saving day of 23 or 25 hours still counts as one day. `weekday`
 * covers the six days after today (tomorrow has its own name); anything older
 * or further out is a plain `date`.
 * @param instantMs - the instant to place.
 * @param nowMs - the reference instant.
 * @param timeZone - explicit IANA zone; an unknown zone falls back to UTC.
 * @returns the kind, the local `YYYY-MM-DD` date and the ISO weekday 1..7.
 */
export function dayLabel(instantMs, nowMs, timeZone) {
  if (!Number.isFinite(instantMs) || !Number.isFinite(nowMs)) {
    throw new RangeError('dayLabel needs finite instants')
  }
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  const at = localParts(instantMs, zone)
  const now = localParts(nowMs, zone)
  const delta = localDayNumber(at) - localDayNumber(now)
  const kind = delta === 0 ? 'today' : delta === 1 ? 'tomorrow' : delta >= 2 && delta <= 6 ? 'weekday' : 'date'
  return { kind, date: at.date, isoWeekday: at.isoWeekday }
}

function compareInstants(left, right) {
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  const first = Number.isFinite(leftMs) ? leftMs : Number.POSITIVE_INFINITY
  const second = Number.isFinite(rightMs) ? rightMs : Number.POSITIVE_INFINITY
  if (first === second) return 0
  return first < second ? -1 : 1
}

/**
 * Order records by when they are due: `dueAt`, then `createdAt`, then `id`.
 * The original order breaks any remaining tie, so the sort is stable and never
 * shuffles rows between refreshes. An unparsable instant sorts last.
 * @param records - records to order; anything else yields an empty list.
 * @returns a new array, leaving the input untouched.
 */
export function sortPendingRecords(records) {
  const rows = Array.isArray(records) ? records.map((record, index) => ({ record, index })) : []
  rows.sort((left, right) => {
    const byDue = compareInstants(left.record?.dueAt, right.record?.dueAt)
    if (byDue !== 0) return byDue
    const byCreated = compareInstants(left.record?.createdAt, right.record?.createdAt)
    if (byCreated !== 0) return byCreated
    const leftId = String(left.record?.id ?? '')
    const rightId = String(right.record?.id ?? '')
    if (leftId !== rightId) return leftId < rightId ? -1 : 1
    return left.index - right.index
  })
  return rows.map((row) => row.record)
}

/**
 * The pending records a new message would queue behind.
 *
 * DSH accepts a prompt into one conversation's queue and runs the turns one at
 * a time, so a second message due at the same instant waits for the first one to
 * finish. Two messages further apart than {@link CONFLICT_WINDOW_MS} are not
 * reported: a turn almost always ends inside that window.
 *
 * Only a `kind: 'session'` target conflicts — a `kind: 'new'` record opens its
 * own conversation and queues behind nothing. The record being edited is
 * excluded, so an editor never warns about itself.
 * @param candidate - the `{ id?, target, dueAt }` about to be scheduled.
 * @param records - every record the caller already holds.
 * @param windowMs - how close two due instants must be; {@link CONFLICT_WINDOW_MS} by default.
 * @returns the conflicting records, possibly none.
 */
export function sameConversationConflict(candidate, records, windowMs) {
  const target = isPlainObject(candidate?.target) ? candidate.target : null
  if (target === null || target.kind !== 'session') return []
  const sessionId = optionalText(target.sessionId)
  if (sessionId === undefined) return []
  const dueMs = Date.parse(candidate?.dueAt)
  if (!Number.isFinite(dueMs)) return []
  const window = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : CONFLICT_WINDOW_MS
  const selfId = optionalText(candidate?.id)
  const found = []
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record) || record.status !== 'pending') continue
    if (selfId !== undefined && record.id === selfId) continue
    const other = record.target
    if (!isPlainObject(other) || other.kind !== 'session' || other.sessionId !== sessionId) continue
    const otherMs = Date.parse(record.dueAt)
    if (!Number.isFinite(otherMs)) continue
    if (Math.abs(otherMs - dueMs) <= window) found.push(record)
  }
  return found
}

function settledMsOf(record) {
  return Date.parse(record.sentAt ?? record.updatedAt ?? record.createdAt)
}

/**
 * Group the records the Scheduled tab lists into day sections.
 *
 * Pending, sending and failed records become one group per local day, ordered
 * by day and then by `dueAt` ascending. Settled records (`sent` and
 * `cancelled`) whose settle time is within the last {@link SENT_WINDOW_MS} form one
 * trailing group of kind `sent`, newest first; its `date` is null because a
 * rolling window has none. Rows are the records themselves: the client formats.
 * @param records - every record the list has.
 * @param nowMs - the reference instant for the day labels and the window.
 * @param timeZone - the zone the reader's day boundaries follow.
 * @returns ordered '{ kind, date, rows }' groups.
 */
export function groupRecords(records, nowMs, timeZone) {
  const rows = Array.isArray(records) ? records : []
  const byDate = new Map()
  const sent = []
  for (const record of rows) {
    if (!isPlainObject(record)) continue
    if (record.status === 'sent' || record.status === 'cancelled') {
      const settledMs = settledMsOf(record)
      if (Number.isFinite(settledMs) && settledMs >= nowMs - SENT_WINDOW_MS) sent.push(record)
      continue
    }
    if (record.status !== 'pending' && record.status !== 'sending' && record.status !== 'failed') continue
    const dueMs = Date.parse(record.dueAt)
    if (!Number.isFinite(dueMs)) continue
    const label = dayLabel(dueMs, nowMs, timeZone)
    const group = byDate.get(label.date)
    if (group === undefined) byDate.set(label.date, { kind: label.kind, date: label.date, rows: [record] })
    else group.rows.push(record)
  }
  const groups = [...byDate.values()]
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0))
  for (const group of groups) group.rows = sortPendingRecords(group.rows)
  if (sent.length > 0) {
    sent.sort((left, right) => {
      const bySettled = settledMsOf(right) - settledMsOf(left)
      return bySettled === 0 ? compareInstants(left.createdAt, right.createdAt) : bySettled
    })
    groups.push({ kind: 'sent', date: null, rows: sent })
  }
  return groups
}

/**
 * Count the messages that still have to be sent, for the sidebar badge.
 * @param records - records from any scope.
 * @returns how many are `pending` or crash-left `sending`.
 */
export function countPending(records) {
  if (!Array.isArray(records)) return 0
  let count = 0
  for (const record of records) {
    if (isPlainObject(record) && (record.status === 'pending' || record.status === 'sending')) count += 1
  }
  return count
}

/**
 * Format one due instant for the summary line and the strip.
 * @param instantMs - the instant to render.
 * @param locale - BCP 47 locale tag.
 * @param timeZone - explicit zone used for display.
 * @returns text such as `Fri, 14 Nov, 9:00 am`; a formatter failure falls back to ISO.
 */
export function describeDue(instantMs, locale, timeZone) {
  // A caller that is still loading has no instant yet. Returning an empty
  // string keeps a render alive: the old fallback called toISOString() on an
  // invalid Date, which throws and takes the whole view down with it.
  if (!Number.isFinite(instantMs)) return ''
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(instantMs))
  } catch {
    try {
      return new Date(instantMs).toISOString()
    } catch {
      return ''
    }
  }
}

/**
 * Format one zone's label for a copy line.
 * @param instantMs - the instant whose offset should be labelled.
 * @param locale - BCP 47 locale tag.
 * @param timeZone - explicit zone.
 * @returns the zone's long name when available, else its IANA name.
 */
export function describeZone(instantMs, locale, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'long' }).formatToParts(new Date(instantMs))
    const name = parts.find(part => part.type === 'timeZoneName')?.value
    return typeof name === 'string' && name.length > 0 ? name : timeZone
  } catch {
    return timeZone
  }
}

// ---------------------------------------------------------------- DeepSeek price clock

/**
 * DeepSeek's peak-price windows as UTC minutes since midnight.
 *
 * DeepSeek documents the rule verbatim: "Off-peak rates are half of the peak
 * rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through
 * Friday, excluding Chinese public holidays. All other hours are off-peak,
 * including weekends and Chinese public holidays in full."
 * (https://api-docs.deepseek.com/quick_start/pricing, read 2026-11-14.)
 *
 * Chinese public holidays are not modelled: the notice speaks about the
 * weekday clock, which is right for every ordinary working week.
 */
export const DEEPSEEK_PEAK_UTC_MINUTES = Object.freeze([[60, 240], [360, 600]])

/**
 * Whether one instant is billed at DeepSeek's standard (peak) rate.
 * @param instantMs - epoch milliseconds.
 * @returns whether the instant sits inside a weekday peak window.
 */
export function isDeepSeekPeak(instantMs) {
  if (!Number.isFinite(instantMs)) return false
  const instant = new Date(instantMs)
  const weekday = instant.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const minutes = instant.getUTCHours() * 60 + instant.getUTCMinutes()
  return DEEPSEEK_PEAK_UTC_MINUTES.some(([start, end]) => minutes >= start && minutes < end)
}

/**
 * Whether a model id belongs to the DeepSeek family, whose clock is priced.
 * @param modelName - provider model id, e.g. `deepseek-v4.1-flash`.
 * @returns whether the name contains `deepseek`, case-insensitively.
 */
export function isDeepSeekModel(modelName) {
  return typeof modelName === 'string' && /deepseek/i.test(modelName)
}

/**
 * Render both peak windows in the reader's zone, e.g. `09:00–12:00 / 14:00–18:00`.
 * A zone west of UTC shows a window on the neighbouring date, which is
 * correct: the boundaries are instants, not wall-clock times.
 * @param instantMs - the instant whose UTC date anchors the windows.
 * @param timeZone - explicit IANA zone used for display.
 * @returns the two windows joined by ` / `.
 */
export function describePeakWindows(instantMs, timeZone) {
  const at = Number.isFinite(instantMs) ? instantMs : Date.now()
  const stamp = new Date(at)
  const dayStart = Date.UTC(stamp.getUTCFullYear(), stamp.getUTCMonth(), stamp.getUTCDate())
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  const clock = (ms) => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone,
      }).format(new Date(ms))
    } catch {
      return new Date(ms).toISOString().slice(11, 16)
    }
  }
  return DEEPSEEK_PEAK_UTC_MINUTES
    .map(([start, end]) => `${clock(dayStart + start * 60_000)}–${clock(dayStart + end * 60_000)}`)
    .join(' / ')
}

/**
 * The peak-window notice the dialog shows, or `null` when it does not apply.
 *
 * One rule, decided in one place: only a DeepSeek model is billed on this
 * clock, and only a chosen instant inside a peak window is worth mentioning.
 * @param options - chosen instant, model id and display zone.
 * @returns `{ windows }` with the windows in the reader's zone, or `null`.
 */
export function deepSeekPeakNotice({ instantMs, modelName, timeZone } = {}) {
  if (!isDeepSeekModel(modelName)) return null
  if (!isDeepSeekPeak(instantMs)) return null
  return { windows: describePeakWindows(instantMs, timeZone) }
}
