/**
 * dsh-scheduled-message — browser bundle. GENERATED FILE, do not edit.
 *
 * Built from client.src.js + lib/core.js + locale/en.json + locale/zh.json by
 * scripts/build-client.mjs. Rebuild with `node scripts/build-client.mjs`;
 * `node --test test/` fails when this file is stale.
 */
window.__ModuleLoader__.load({
  id: "dsh-scheduled-message",
  factory: (require) => {
const core = (() => {
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
const NS = 'dsh-scheduled-message'

/**
 * Durable storage domain name.
 *
 * Storage unit names are narrower than package names: `@deepseek-ai/dsh-storage`
 * matches them against `/^[a-z][a-z0-9_]*$/`, so the package name (which has
 * hyphens) would be refused when the domain is defined.
 */
const DOMAIN_NAME = 'dsh_scheduled_message'

/** A scheduled instant must be at least this far ahead of the accepted request. */
const MIN_LEAD_MS = 30_000

/** Longest accepted message text. */
const MAX_TEXT_CHARS = 200_000

/** Most images accepted in one scheduled message. */
const MAX_IMAGES = 10

/** Most `pending` records the Host keeps. */
const MAX_PENDING = 500

/** Longest title accepted by `ctx.schedule.create`. */
const MAX_TITLE_CHARS = 120

/** `setTimeout` stores its delay in a signed 32-bit integer. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** A delivery later than this after its due instant is reported as sent late. */
const LATE_THRESHOLD_MS = 60_000

/** Finished records older than this are pruned. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Durable record schema the Host writes; v2 adds a delivery target. */
const DOMAIN_VERSION = 2

/**
 * Earlier record versions this build still opens.
 *
 * A v1 record carries `sessionId` where v2 carries `target`; {@link migrateRecord} and
 * {@link parseRecord} accept that shape, so upgrading the plugin never strands
 * a message that was scheduled before the upgrade.
 */
const COMPATIBLE_VERSIONS = Object.freeze([1])

/** Every record status, in lifecycle order. */
const RECORD_STATUSES = Object.freeze(['pending', 'sending', 'sent', 'failed', 'cancelled'])

/** Longest stored diagnostic. */
const MAX_ERROR_CHARS = 500

/** Fallback per-image cap, used when the caller passes no `imageLimits`. */
const MAX_IMAGE_BYTES = 5_000_000

/** Fallback cap on every image of one message together, in decoded bytes. */
const MAX_MESSAGE_IMAGE_BYTES = 20_000_000

/** Finished records a list still shows, in the trailing Sent group. */
const SENT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Repeat frequencies the composer offers. */
const REPEAT_FREQUENCIES = Object.freeze(['daily', 'weekdays', 'weekly', 'monthly'])

const ISO_WEEKDAY_CODES = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** Clamp and zero-pad one clock field. */
function pad2(value) {
  return String(Math.trunc(value)).padStart(2, '0')
}

/**
 * Convert a 24-hour clock hour to the 12-hour face shown in the picker.
 * @param hour24 - hour in 0..23.
 * @returns the 1..12 hour and its meridiem; an out-of-range hour throws.
 */
function toMeridiem(hour24) {
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
function to24Hour(hour12, meridiem) {
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
function formatClock(hour12, minute, meridiem) {
  return `${hour12}:${pad2(minute)} ${meridiem}`
}

/**
 * Read a strict `YYYY-MM-DD` calendar date without consulting a process zone.
 * @param text - candidate date.
 * @returns the three fields, or null when the text is not a real calendar date.
 */
function parseLocalDate(text) {
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
function isValidTimeZone(timeZone) {
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
function localParts(instantMs, timeZone) {
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
function zoneOffsetMs(instantMs, timeZone) {
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
function wallClockToInstant(selection, timeZone) {
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
function buildRrule({ repeat, instantMs, timeZone }) {
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
function skipsShortMonths(dayOfMonth) {
  return Number.isInteger(dayOfMonth) && dayOfMonth >= 29 && dayOfMonth <= 31
}

/**
 * Compress a message into the one-line title `ctx.schedule.create` requires.
 * @param text - message text.
 * @param max - longest accepted title; 120 by default.
 * @returns a trimmed single line no longer than `max` characters.
 */
function summariseTitle(text, max = MAX_TITLE_CHARS) {
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
 * @param payload - untrusted request body.
 * @param nowMs - the accepting clock.
 * @returns normalized content, or a stable rejection code and message.
 */
function validateCreateRequest(payload, nowMs) {
  const fail = (code, message) => ({ ok: false, code, message })
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('invalid-request', 'The request body must be an object.')
  }
  const { sessionId, dueAt, timeZone } = payload
  if (typeof sessionId !== 'string' || sessionId.length === 0) return fail('invalid-session', 'A session id is required.')
  if (typeof dueAt !== 'string' || !ISO_INSTANT.test(dueAt)) {
    return fail('invalid-due-at', 'dueAt must be an absolute ISO instant with an offset or Z.')
  }
  const dueMs = Date.parse(dueAt)
  if (!Number.isFinite(dueMs)) return fail('invalid-due-at', 'dueAt is not a real instant.')
  if (dueMs < nowMs + MIN_LEAD_MS) {
    return fail('too-soon', `Choose a time at least ${Math.round(MIN_LEAD_MS / 1000)} seconds from now.`)
  }
  if (!isValidTimeZone(timeZone)) return fail('invalid-time-zone', 'timeZone must be an IANA zone name or UTC.')

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

  return {
    ok: true,
    value: {
      sessionId,
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
function migrateRecord(raw) {
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
function parseRecord(raw, options) {
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
function nextUpdatedAt(previousIso, nowMs) {
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
function resolveSessionId(record) {
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
function validateTarget(target) {
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
function estimateBase64Bytes(data) {
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
function checkMessageContent(input) {
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

function validateMessageContent(input) {
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
function validateMerged(record, limits) {
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
function validateUpdateRequest(payload, nowMs) {
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
function earliestPending(records) {
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
function timerDelay(dueMs, nowMs) {
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
function isLate(dueMs, deliveredMs) {
  return Number.isFinite(dueMs) && deliveredMs - dueMs > LATE_THRESHOLD_MS
}

/**
 * Choose the finished records that retention should drop.
 * @param records - every stored record.
 * @param nowMs - current instant.
 * @returns ids of finished records older than {@link RETENTION_MS}.
 */
function pruneTargets(records, nowMs) {
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
function pendingSummary(records, nowMs) {
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
function dayLabel(instantMs, nowMs, timeZone) {
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
function sortPendingRecords(records) {
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
function groupRecords(records, nowMs, timeZone) {
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
function countPending(records) {
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
function describeDue(instantMs, locale, timeZone) {
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
function describeZone(instantMs, locale, timeZone) {
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
const DEEPSEEK_PEAK_UTC_MINUTES = Object.freeze([[60, 240], [360, 600]])

/**
 * Whether one instant is billed at DeepSeek's standard (peak) rate.
 * @param instantMs - epoch milliseconds.
 * @returns whether the instant sits inside a weekday peak window.
 */
function isDeepSeekPeak(instantMs) {
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
function isDeepSeekModel(modelName) {
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
function describePeakWindows(instantMs, timeZone) {
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
function deepSeekPeakNotice({ instantMs, modelName, timeZone } = {}) {
  if (!isDeepSeekModel(modelName)) return null
  if (!isDeepSeekPeak(instantMs)) return null
  return { windows: describePeakWindows(instantMs, timeZone) }
}

return { NS, DOMAIN_NAME, MIN_LEAD_MS, MAX_TEXT_CHARS, MAX_IMAGES, MAX_PENDING, MAX_TITLE_CHARS, MAX_TIMER_DELAY_MS, LATE_THRESHOLD_MS, RETENTION_MS, DOMAIN_VERSION, COMPATIBLE_VERSIONS, RECORD_STATUSES, MAX_ERROR_CHARS, MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGE_BYTES, SENT_WINDOW_MS, REPEAT_FREQUENCIES, pad2, toMeridiem, to24Hour, formatClock, parseLocalDate, isValidTimeZone, localParts, zoneOffsetMs, wallClockToInstant, buildRrule, skipsShortMonths, summariseTitle, validateCreateRequest, migrateRecord, parseRecord, nextUpdatedAt, resolveSessionId, validateTarget, estimateBase64Bytes, checkMessageContent, validateMessageContent, validateMerged, validateUpdateRequest, earliestPending, timerDelay, isLate, pruneTargets, pendingSummary, dayLabel, sortPendingRecords, groupRecords, countPending, describeDue, describeZone, DEEPSEEK_PEAK_UTC_MINUTES, isDeepSeekPeak, isDeepSeekModel, describePeakWindows, deepSeekPeakNotice }
})()

const EN = {
  "button.label": "Schedule",
  "button.shortLabel": "Later",
  "button.emptyHint": "Type a message first",
  "button.busyHint": "Wait for the message to finish sending",
  "shortcut.label": "Schedule message",
  "attachments.image": "{count} image",
  "attachments.images": "{count} images",
  "attachments.file": "{count} file",
  "attachments.files": "{count} files",
  "attachments.any": "{count} attachment",
  "attachments.anyMany": "{count} attachments",
  "dialog.title": "Schedule message",
  "dialog.rescheduleTitle": "Change send time",
  "dialog.close": "Close",
  "dialog.date": "Date",
  "dialog.hour": "Hour",
  "dialog.minute": "Minute",
  "dialog.meridiem": "AM or PM",
  "dialog.summary": "Sends {time} ({zone})",
  "dialog.pastWarning": "That time has already passed, or is less than 30 seconds away.",
  "dialog.peakHint": "DeepSeek's busy window is {windows} — a send there bills at 2× the off-peak rate. An evening or weekend slot is half price, so it's worth nudging this one later.",
  "dialog.repeat": "Repeat",
  "dialog.repeatHint": "Create an automation task that sends this text again on a rule.",
  "dialog.repeatLocked": "Repeating messages can't include images or files.",
  "dialog.repeatShortMonths": "Shorter months are skipped.",
  "dialog.submit": "Schedule",
  "dialog.createAutomation": "Create automation",
  "dialog.saveTime": "Save time",
  "dialog.cancel": "Cancel",
  "dialog.noText": "Only attachments",
  "repeat.daily": "Daily",
  "repeat.weekdays": "Weekdays",
  "repeat.weekly": "Weekly",
  "repeat.monthly": "Monthly",
  "repeat.detail.daily": "Every day at this time.",
  "repeat.detail.weekdays": "Monday to Friday at this time.",
  "repeat.detail.weekly": "Every {weekday} at this time.",
  "repeat.detail.monthly": "Every month on this date at this time.",
  "weekday.mon": "Monday",
  "weekday.tue": "Tuesday",
  "weekday.wed": "Wednesday",
  "weekday.thu": "Thursday",
  "weekday.fri": "Friday",
  "weekday.sat": "Saturday",
  "weekday.sun": "Sunday",
  "quick.inHour": "In 1 hour",
  "quick.thisEvening": "This evening, 8:00 PM",
  "quick.tomorrow": "Tomorrow, 9:00 AM",
  "quick.nextMonday": "Next Monday, 9:00 AM",
  "dock.collapsed": "{count} scheduled · next {next}",
  "dock.collapsedEmpty": "Scheduled messages",
  "dock.noText": "Only attachments",
  "dock.sent": "sent {time}",
  "dock.sentLate": "sent late, {time}",
  "dock.failed": "failed, was due {time}",
  "dock.sending": "sending…",
  "dock.sendNow": "Send now",
  "dock.changeTime": "Change time",
  "dock.cancel": "Cancel",
  "dock.confirmCancel": "Cancel it",
  "dock.keep": "Keep",
  "dock.retry": "Retry",
  "notice.scheduled": "Scheduled for {time}",
  "notice.automationCreated": "Automation created, first send {time}",
  "notice.rescheduled": "Send time changed to {time}",
  "notice.noComposer": "Open a conversation to schedule a message",
  "notice.busy": "Wait for the message to finish sending",
  "notice.typeFirst": "Type a message first",
  "error.generic": "That did not work. Try again.",
  "error.tooSoon": "Choose a time at least 30 seconds from now.",
  "error.empty": "Type a message or attach something first.",
  "error.repeatWithAttachments": "Repeating messages can't include images or files.",
  "error.repeatUnavailable": "Repeating messages need the Automation service in this profile.",
  "error.unknownReceipt": "One of the attached files is no longer available; attach it again.",
  "error.unknownSession": "That conversation is no longer available; reopen it and try again.",
  "error.notPending": "That message is no longer waiting to be sent.",
  "error.notFound": "That scheduled message no longer exists.",
  "error.tooManyPending": "At most 500 messages may wait to be sent.",
  "error.invalidImages": "One of the images could not be stored. Try attaching it again.",
  "error.attachmentsUnavailable": "This conversation cannot hand over its attachments.",
  "error.uploading": "Wait for uploads to finish, then try again.",
  "panel.label": "Scheduled",
  "panel.title": "Scheduled",
  "panel.viewAll": "View all",
  "panel.waitingOne": "{count} message waiting",
  "panel.waitingMany": "{count} messages waiting",
  "panel.today": "Today",
  "panel.tomorrow": "Tomorrow",
  "panel.sent": "Sent",
  "panel.sentLate": "Sent late",
  "panel.cancelled": "Cancelled",
  "panel.repeating": "Repeating",
  "panel.repeatingHint": "Repeating messages are Automation tasks. They stay read-only here.",
  "panel.openTasks": "Open Automation tasks",
  "panel.empty": "Nothing scheduled",
  "panel.emptyHint": "Write a message and press Alt+Enter to send it later.",
  "panel.loading": "Loading scheduled messages…",
  "panel.retry": "Retry",
  "panel.sendNow": "Send now",
  "panel.edit": "Edit",
  "panel.delete": "Delete",
  "panel.deleteConfirm": "Delete this message?",
  "panel.deleteYes": "Delete",
  "panel.deleteKeep": "Keep",
  "panel.noText": "Only attachments",
  "panel.newConversation": "New conversation",
  "panel.noticeDeleted": "Scheduled message deleted",
  "panel.scope": "Filter",
  "panel.scopeAll": "All",
  "panel.scopeWorkspace": "This workspace",
  "editor.title": "Edit scheduled message",
  "editor.when": "When",
  "editor.message": "Message",
  "editor.messagePlaceholder": "Write the message to send",
  "editor.attachments": "Attachments",
  "editor.addFiles": "Add files",
  "editor.dropHint": "Drop files here, or paste an image",
  "editor.uploading": "Uploading…",
  "editor.uploadFailed": "Upload failed. Try again.",
  "editor.imageLimit": "A message can carry at most 10 images.",
  "editor.sendTo": "Send to",
  "editor.searchTargets": "Search workspaces and conversations",
  "editor.noResults": "No matches",
  "editor.noSessions": "No conversations here yet",
  "editor.noTarget": "Choose a destination",
  "editor.save": "Save",
  "editor.saving": "Saving…",
  "editor.cancel": "Cancel",
  "editor.delete": "Delete",
  "editor.discard": "Discard changes?",
  "editor.discardYes": "Discard",
  "editor.discardNo": "Keep editing",
  "editor.discardBody": "Your edits to this message will not be saved.",
  "editor.deleteTitle": "Delete this scheduled message?",
  "editor.deleteBody": "It will be removed from your schedule and will not be sent.",
  "editor.conflict": "This message changed in another tab. Review it and save again.",
  "editor.notPending": "This message was sent while you were editing.",
  "editor.saved": "Changes saved",
  "editor.loading": "Loading the message…",
  "editor.remove": "Remove attachment",
  "editor.errNothingToUpdate": "Change the time, the message or the destination first.",
  "editor.errBodyTooLarge": "That request was too large. Send less at once.",
  "editor.errEmptyBody": "That file was empty; pick another one.",
  "editor.errInvalidId": "That scheduled message could not be identified.",
  "editor.errInvalidTarget": "That destination is no longer available. Pick another conversation.",
  "editor.errInvalidText": "The message text could not be accepted.",
  "editor.errInvalidDueAt": "That send time could not be accepted.",
  "editor.errInvalidVersion": "This message changed while you were editing. Reopen it and try again.",
  "editor.errInvalidFiles": "One of the files could not be accepted. Attach it again.",
  "editor.errInvalidAttachmentIds": "One of the attachments could not be removed.",
  "editor.errImageTooLarge": "That image is too large. Try a smaller one.",
  "editor.errImagesTooLarge": "These images are too large together. Remove one."
}

const ZH = {
  "button.label": "定时发送",
  "button.shortLabel": "稍后",
  "button.emptyHint": "先输入内容",
  "button.busyHint": "请等这条消息发送完成",
  "shortcut.label": "定时发送消息",
  "attachments.image": "{count} 张图片",
  "attachments.images": "{count} 张图片",
  "attachments.file": "{count} 个文件",
  "attachments.files": "{count} 个文件",
  "attachments.any": "{count} 个附件",
  "attachments.anyMany": "{count} 个附件",
  "dialog.title": "定时发送消息",
  "dialog.rescheduleTitle": "修改发送时间",
  "dialog.close": "关闭",
  "dialog.date": "日期",
  "dialog.hour": "小时",
  "dialog.minute": "分钟",
  "dialog.meridiem": "上午或下午",
  "dialog.summary": "将于 {time}（{zone}）发送",
  "dialog.pastWarning": "这个时间已经过去，或距现在不足 30 秒。",
  "dialog.peakHint": "DeepSeek 的高峰时段是 {windows}——此时段的价格是平时的 2 倍；挪到晚上或周末就是半价，晚一点发更划算。",
  "dialog.repeat": "重复",
  "dialog.repeatHint": "创建自动化任务，按规则重复发送这段文字。",
  "dialog.repeatLocked": "重复消息不能包含图片或文件。",
  "dialog.repeatShortMonths": "没有这一天的小月会被跳过。",
  "dialog.submit": "定时发送",
  "dialog.createAutomation": "创建自动化",
  "dialog.saveTime": "保存时间",
  "dialog.cancel": "取消",
  "dialog.noText": "仅附件",
  "repeat.daily": "每天",
  "repeat.weekdays": "工作日",
  "repeat.weekly": "每周",
  "repeat.monthly": "每月",
  "repeat.detail.daily": "每天这个时间发送。",
  "repeat.detail.weekdays": "周一至周五这个时间发送。",
  "repeat.detail.weekly": "每周{weekday}这个时间发送。",
  "repeat.detail.monthly": "每月这一天这个时间发送。",
  "weekday.mon": "一",
  "weekday.tue": "二",
  "weekday.wed": "三",
  "weekday.thu": "四",
  "weekday.fri": "五",
  "weekday.sat": "六",
  "weekday.sun": "日",
  "quick.inHour": "1 小时后",
  "quick.thisEvening": "今晚 20:00",
  "quick.tomorrow": "明天 09:00",
  "quick.nextMonday": "下周一 09:00",
  "dock.collapsed": "{count} 条待发送 · 最近 {next}",
  "dock.collapsedEmpty": "定时消息",
  "dock.noText": "仅附件",
  "dock.sent": "已发送 {time}",
  "dock.sentLate": "已补发 {time}",
  "dock.failed": "发送失败，原定 {time}",
  "dock.sending": "正在发送…",
  "dock.sendNow": "立即发送",
  "dock.changeTime": "改时间",
  "dock.cancel": "取消",
  "dock.confirmCancel": "确认取消",
  "dock.keep": "保留",
  "dock.retry": "重试",
  "notice.scheduled": "已定时，将于 {time} 发送",
  "notice.automationCreated": "已创建自动化，首次发送 {time}",
  "notice.rescheduled": "发送时间改为 {time}",
  "notice.noComposer": "请先打开一个会话再定时",
  "notice.busy": "请等这条消息发送完成",
  "notice.typeFirst": "先输入内容",
  "error.generic": "没有成功，请再试一次。",
  "error.tooSoon": "请选择至少 30 秒之后的时间。",
  "error.empty": "请先输入内容或添加附件。",
  "error.repeatWithAttachments": "重复消息不能包含图片或文件。",
  "error.repeatUnavailable": "重复消息需要此配置里的自动化服务。",
  "error.unknownReceipt": "其中一个附件已经不可用，请重新添加。",
  "error.unknownSession": "该会话已不可用，请重新打开后重试。",
  "error.notPending": "这条消息已经不在待发送状态。",
  "error.notFound": "这条定时消息已经不存在。",
  "error.tooManyPending": "最多只能有 500 条待发送消息。",
  "error.invalidImages": "其中一张图片保存失败，请重新添加。",
  "error.attachmentsUnavailable": "此会话无法交出草稿附件。",
  "error.uploading": "请等附件上传完成后再试。",
  "panel.label": "定时消息",
  "panel.title": "定时消息",
  "panel.viewAll": "查看全部",
  "panel.waitingOne": "{count} 条待发送",
  "panel.waitingMany": "{count} 条待发送",
  "panel.today": "今天",
  "panel.tomorrow": "明天",
  "panel.sent": "已发送",
  "panel.sentLate": "补发",
  "panel.cancelled": "已取消",
  "panel.repeating": "重复",
  "panel.repeatingHint": "重复消息属于自动化任务，这里只读。",
  "panel.openTasks": "打开自动化任务",
  "panel.empty": "暂无定时消息",
  "panel.emptyHint": "写好消息后按 Alt+Enter，即可稍后发送。",
  "panel.loading": "正在加载定时消息…",
  "panel.retry": "重试",
  "panel.sendNow": "立即发送",
  "panel.edit": "编辑",
  "panel.delete": "删除",
  "panel.deleteConfirm": "删除这条消息？",
  "panel.deleteYes": "删除",
  "panel.deleteKeep": "保留",
  "panel.noText": "仅附件",
  "panel.newConversation": "新会话",
  "panel.noticeDeleted": "已删除定时消息",
  "panel.scope": "筛选",
  "panel.scopeAll": "全部",
  "panel.scopeWorkspace": "当前工作区",
  "editor.title": "编辑定时消息",
  "editor.when": "时间",
  "editor.message": "内容",
  "editor.messagePlaceholder": "输入要发送的内容",
  "editor.attachments": "附件",
  "editor.addFiles": "添加文件",
  "editor.dropHint": "拖入文件，或粘贴图片",
  "editor.uploading": "上传中…",
  "editor.uploadFailed": "上传失败，请重试。",
  "editor.imageLimit": "每条消息最多 10 张图片。",
  "editor.sendTo": "发送到",
  "editor.searchTargets": "搜索工作区与会话",
  "editor.noResults": "没有匹配项",
  "editor.noSessions": "这里还没有会话",
  "editor.noTarget": "选择发送目标",
  "editor.save": "保存",
  "editor.saving": "保存中…",
  "editor.cancel": "取消",
  "editor.delete": "删除",
  "editor.discard": "放弃修改？",
  "editor.discardYes": "放弃",
  "editor.discardNo": "继续编辑",
  "editor.discardBody": "你对这条消息的修改不会保存。",
  "editor.deleteTitle": "删除这条定时消息？",
  "editor.deleteBody": "它会从定时列表中移除，并且不会发送。",
  "editor.conflict": "这条消息在另一个标签页里被修改过，请检查后再次保存。",
  "editor.notPending": "这条消息在编辑期间已发送。",
  "editor.saved": "已保存修改",
  "editor.loading": "正在加载消息…",
  "editor.remove": "移除附件",
  "editor.errNothingToUpdate": "请先修改时间、内容或发送目标。",
  "editor.errBodyTooLarge": "这次请求的内容太大，请分开处理。",
  "editor.errEmptyBody": "这个文件是空的，请换一个。",
  "editor.errInvalidId": "无法识别这条定时消息。",
  "editor.errInvalidTarget": "该发送目标已不可用，请重新选择会话。",
  "editor.errInvalidText": "消息内容无法被接受。",
  "editor.errInvalidDueAt": "该发送时间无法被接受。",
  "editor.errInvalidVersion": "这条消息在编辑期间被修改过，请重新打开后再试。",
  "editor.errInvalidFiles": "其中一个文件无法被接受，请重新添加。",
  "editor.errInvalidAttachmentIds": "其中一个附件无法移除。",
  "editor.errImageTooLarge": "这张图片太大，请换一张小一点的。",
  "editor.errImagesTooLarge": "这些图片合起来太大，请移除一张。"
}

/**
 * Browser half of dsh-scheduled-message — source template.
 *
 * This file is not loaded by the browser. `scripts/build-client.mjs` inlines
 * `lib/core.js` and `locale/*.json` into it and writes the module-loader
 * bundle `client.js`, which is what the package exports as `./client`.
 * Run `node scripts/build-client.mjs` after editing either half; the test
 * suite fails when `client.js` is stale.
 *
 * The bundle must not import another DSH package: it may only require the
 * platform table (`react`, `react-dom`).
 *
 * @module dsh-scheduled-message/client
 */

/**
 * Build one client plugin instance.
 * @param require - the module-loader require handed to the bundle factory.
 * @returns the cordis plugin object.
 */
function createClientPlugin(require) {
  'use strict'

  const React = require('react')
  const ReactDOM = require('react-dom')
  const h = React.createElement
  const { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } = React

  const NS = core.NS
  const API = '/api/dsh-scheduled-message'
  const SHORTCUT_ID = 'dsh-scheduled-message.open'
  const SHORTCUT_PROFILES = ['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows', 'web:linux']
  const TASKS_PANEL = 'schedules'
  const ORANGE = '#F97316'
  const ORANGE_HOVER = '#EA6A0C'
  const STYLE_ID = 'dsm-styles'
  const MINUTE_STEPS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
  const HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  const WEEKDAY_KEYS = ['weekday.mon', 'weekday.tue', 'weekday.wed', 'weekday.thu', 'weekday.fri', 'weekday.sat', 'weekday.sun']

  /** Id of the Scheduled tab: one id shared by the page and the sidebar entry. */
  const PANEL_ID = 'scheduled-messages'

  /** Stable machine codes the Host answers with, mapped onto localized copy. */
  const ERROR_KEYS = {
    'too-soon': 'error.tooSoon',
    empty: 'error.empty',
    'repeat-with-attachments': 'error.repeatWithAttachments',
    'repeat-unavailable': 'error.repeatUnavailable',
    'unknown-receipt': 'error.unknownReceipt',
    'unknown-session': 'error.unknownSession',
    'not-pending': 'error.notPending',
    'not-found': 'error.notFound',
    'too-many-pending': 'error.tooManyPending',
    'invalid-images': 'error.invalidImages',
    'invalid-request': 'error.generic',
    conflict: 'editor.conflict',
    'too-many-images': 'editor.imageLimit',
    'unknown-file': 'error.unknownReceipt',
    'nothing-to-update': 'editor.errNothingToUpdate',
    'body-too-large': 'editor.errBodyTooLarge',
    'empty-body': 'editor.errEmptyBody',
    'invalid-id': 'editor.errInvalidId',
    'invalid-target': 'editor.errInvalidTarget',
    'invalid-text': 'editor.errInvalidText',
    'invalid-due-at': 'editor.errInvalidDueAt',
    'invalid-expected-updated-at': 'editor.errInvalidVersion',
    'invalid-files': 'editor.errInvalidFiles',
    'invalid-attachment-ids': 'editor.errInvalidAttachmentIds',
    'image-too-large': 'editor.errImageTooLarge',
    'images-too-large': 'editor.errImagesTooLarge',
    internal: 'error.generic',
  }

  // ---------------------------------------------------------------- stores

  const openRequests = new Map()
  const openListeners = new Set()
  let refreshSeq = 0
  const refreshListeners = new Set()
  // One conversation's flash: `{ sessionId, text }`. It never crosses into
  // another composer, and a delete clears it, so it cannot outlive its record.
  let toast = null

  function bumpOpen(sessionId) {
    openRequests.set(sessionId, (openRequests.get(sessionId) ?? 0) + 1)
    for (const listener of [...openListeners]) listener()
  }

  function bumpRefresh() {
    refreshSeq += 1
    for (const listener of [...refreshListeners]) listener()
    // The tab and the strip share one signal: an action in either one reloads
    // both, so the sidebar badge and the list can never disagree.
    void loadAll()
  }

  function setToast(sessionId, text) {
    toast = { sessionId, text }
    bumpRefresh()
    const captured = toast
    const timer = setTimeout(() => {
      if (toast === captured) {
        toast = null
        bumpRefresh()
      }
    }, 7000)
    // A pending timer must not hold a Node test process open. Browsers return a
    // number here and simply skip this.
    if (typeof timer?.unref === 'function') timer.unref()
  }

  /** The flash this conversation may show, or null when it belongs to another. */
  function toastFor(sessionId) {
    return toast !== null && toast.sessionId === sessionId ? toast.text : null
  }

  /** Drop the flash: the record it announced no longer exists. */
  function clearToast() {
    if (toast === null) return
    toast = null
    bumpRefresh()
  }

  function subscribeOpen(listener) {
    openListeners.add(listener)
    return () => openListeners.delete(listener)
  }

  function subscribeRefresh(listener) {
    refreshListeners.add(listener)
    return () => refreshListeners.delete(listener)
  }

  function useOpenRequest(sessionId) {
    return useSyncExternalStore(subscribeOpen, () => openRequests.get(sessionId) ?? 0, () => 0)
  }

  function useRefreshSignal() {
    return useSyncExternalStore(subscribeRefresh, () => refreshSeq, () => 0)
  }

  // ---------------------------------------------------------------- open conversation

  /**
   * The conversation a composer seat last showed.
   *
   * A `main` panel receives no session context of its own, so this is how the
   * Scheduled tab learns which workspace "This workspace" means. Both composer
   * seats record it while rendered; the seat that set it clears it on unmount,
   * and only if the value still matches.
   */
  let lastOpenSessionId = null

  function rememberOpenSession(sessionId) {
    if (typeof sessionId === 'string' && sessionId.length > 0) lastOpenSessionId = sessionId
  }

  function forgetOpenSession(sessionId) {
    if (lastOpenSessionId === sessionId) lastOpenSessionId = null
  }

  // ---------------------------------------------------------------- scheduled tab store

  /** Translator for components the platform mounts outside a localized seat. */
  let translate = key => key

  /**
   * One shared `/list-all` answer for the tab, the sidebar badge and the strip.
   *
   * The store lives outside React because the sidebar entry is mounted without
   * the page, and because the due-time timer must keep running while the page
   * is closed. There is one timer and never an interval: it is re-armed for the
   * earliest pending instant after every load.
   */
  let allVersion = 0
  const allListeners = new Set()
  const allState = { items: [], nowMs: 0, loading: false, loaded: false, error: null }
  let allInFlight = null
  let allRequestSeq = 0
  let allScope = { kind: 'all' }
  let dueTimer = null
  let dueArmedFor = null

  function subscribeAll(listener) {
    allListeners.add(listener)
    return () => allListeners.delete(listener)
  }

  function allSnapshot() {
    return allVersion
  }

  function emitAll(patch) {
    if (patch !== undefined) Object.assign(allState, patch)
    allVersion += 1
    for (const listener of [...allListeners]) listener()
  }

  function armDueTimer() {
    if (dueTimer !== null) {
      clearTimeout(dueTimer)
      dueTimer = null
    }
    let nextMs = null
    for (const record of allState.items) {
      if (record === null || record === undefined) continue
      if (record.status !== 'pending' && record.status !== 'sending') continue
      const dueMs = Date.parse(record.dueAt)
      if (!Number.isFinite(dueMs)) continue
      if (nextMs === null || dueMs < nextMs) nextMs = dueMs
    }
    if (nextMs === null) {
      dueArmedFor = null
      return
    }
    const now = Date.now()
    // One refresh about two seconds after each due instant. An instant that is
    // already past is refreshed once, not polled: the Host delivery (or the
    // next focus/visibility refresh) reports the outcome.
    if (nextMs <= now && dueArmedFor === nextMs) return
    dueArmedFor = nextMs
    const wait = nextMs <= now
      ? 2000
      : Math.min(Math.max(nextMs - now + 2000, 500), core.MAX_TIMER_DELAY_MS)
    dueTimer = setTimeout(() => {
      dueTimer = null
      void loadAll()
    }, wait)
  }

  /** The `/list-all` URL for one scope, so the header control and the URL agree. */
  function listAllUrl(scope) {
    const value = scope === null || scope === undefined ? { kind: 'all' } : scope
    if (value.kind === 'workspace' && typeof value.workspaceId === 'string' && value.workspaceId.length > 0) {
      return API + '/list-all?scope=workspace&workspaceId=' + encodeURIComponent(value.workspaceId)
    }
    return API + '/list-all?scope=all'
  }

  /**
   * Load the shared list, or point it at another scope first.
   *
   * A newer request always wins, so a slow answer for the old filter can never
   * overwrite the rows the user is looking at.
   */
  function loadAll(force) {
    if (allInFlight !== null && force !== true) return allInFlight
    const scope = allScope
    allRequestSeq += 1
    const seq = allRequestSeq
    emitAll({ loading: true })
    const promise = requestJson(listAllUrl(scope), { method: 'GET' }).then((value) => {
      const items = Array.isArray(value?.items) ? value.items : []
      if (seq === allRequestSeq) {
        emitAll({
          items,
          nowMs: Number.isFinite(value?.now) ? value.now : Date.now(),
          loading: false,
          loaded: true,
          error: null,
        })
        armDueTimer()
      }
      return items
    }, (error) => {
      if (seq === allRequestSeq) emitAll({ loading: false, loaded: true, error })
      return []
    })
    allInFlight = promise.then((items) => {
      if (seq === allRequestSeq) allInFlight = null
      return items
    })
    return allInFlight
  }

  /** Point the shared list at All or at one workspace, then reload it. */
  function setListScope(scope) {
    const next = scope !== null && scope !== undefined
      && scope.kind === 'workspace'
      && typeof scope.workspaceId === 'string'
      && scope.workspaceId.length > 0
      ? { kind: 'workspace', workspaceId: scope.workspaceId }
      : { kind: 'all' }
    const same = next.kind === allScope.kind
      && (next.kind === 'all' || next.workspaceId === allScope.workspaceId)
    if (same) return
    allScope = next
    void loadAll(true)
  }

  /** The `/targets` answer is cached: the editor is opened many times per session. */
  const targetCache = { value: null, loading: false, error: null }
  let targetInFlight = null

  function loadTargets(force) {
    if (force !== true && targetCache.value !== null) return Promise.resolve(targetCache.value)
    if (targetInFlight !== null) return targetInFlight
    targetCache.loading = true
    targetInFlight = requestJson(API + '/targets', { method: 'GET' }).then((value) => {
      const targets = { workspaces: Array.isArray(value?.workspaces) ? value.workspaces : [] }
      targetCache.value = targets
      targetCache.loading = false
      targetCache.error = null
      targetInFlight = null
      return targets
    }, (error) => {
      targetCache.loading = false
      targetCache.error = error
      targetInFlight = null
      throw error
    })
    return targetInFlight
  }

  // ---------------------------------------------------------------- tab helpers (pure)

  let localIdSeq = 0

  function nextLocalId() {
    localIdSeq += 1
    return 'local-' + String(Date.now()) + '-' + String(localIdSeq)
  }

  /** Localized plural copy for the waiting count under the title. */
  function countText(count) {
    const value = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
    return { key: value === 1 ? 'panel.waitingOne' : 'panel.waitingMany', params: { count: value } }
  }

  /**
   * Find the workspace that owns one open conversation.
   *
   * Returns null when no conversation has been open, when the targets answer has
   * no such session, or when that workspace has no id. The tab then hides the
   * "This workspace" control and stays on All.
   * @param targets - the `/targets` answer.
   * @param sessionId - the conversation a composer seat last showed.
   * @returns `{ workspaceId, workspaceTitle }`, or null.
   */
  function resolveWorkspaceFilter(targets, sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    const workspaces = Array.isArray(targets?.workspaces) ? targets.workspaces : []
    for (const workspace of workspaces) {
      if (workspace === null || workspace === undefined) continue
      const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : []
      const owns = sessions.some(session => session !== null && session !== undefined && session.id === sessionId)
      if (!owns) continue
      if (typeof workspace.id !== 'string' || workspace.id.length === 0) return null
      return {
        workspaceId: workspace.id,
        workspaceTitle: typeof workspace.title === 'string' ? workspace.title : '',
      }
    }
    return null
  }

  /**
   * Decide what the read-only Repeating group shows.
   *
   * The Automation service owns these rows, so the tab only mirrors what the
   * Host reports: no group when the service is unavailable or the list is empty,
   * one plain row per task otherwise, with no edit affordances.
   * @param repeating - the `/repeating` answer, or null.
   * @returns `{ show, items: [{ id, title, rrule }] }`.
   */
  function repeatingView(repeating) {
    const available = repeating !== null && repeating !== undefined && repeating.available === true
    const raw = available && Array.isArray(repeating.items) ? repeating.items : []
    const items = []
    for (const item of raw) {
      if (item === null || item === undefined) continue
      const title = typeof item.title === 'string' ? item.title.trim() : ''
      if (title.length === 0) continue
      items.push({
        id: typeof item.id === 'string' && item.id.length > 0 ? item.id : 'repeating-' + String(items.length),
        title,
        rrule: typeof item.rrule === 'string' && item.rrule.length > 0 ? item.rrule : null,
      })
    }
    return { show: available && items.length > 0, items }
  }

  /** Readable byte size for an attachment chip. */
  function formatBytes(bytes) {
    const value = Number(bytes)
    if (!Number.isFinite(value) || value < 0) return ''
    if (value < 1024) return String(Math.round(value)) + ' B'
    const units = ['KB', 'MB', 'GB']
    let size = value / 1024
    let index = 0
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024
      index += 1
    }
    const rounded = size >= 10 ? Math.round(size) : Math.round(size * 10) / 10
    return String(rounded) + ' ' + units[index]
  }

  /** The 12-hour clock face one instant shows in one zone, e.g. 9:00 PM. */
  function clockOf(instantMs, zone) {
    if (!Number.isFinite(instantMs)) return ''
    const parts = core.localParts(instantMs, zone)
    const clock = core.toMeridiem(parts.hour24)
    return core.formatClock(clock.hour12, parts.minute, clock.meridiem)
  }

  function formatDate(instantMs, locale, zone) {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: zone }).format(new Date(instantMs))
    } catch {
      return ''
    }
  }

  /** Where one record will be delivered, resolved as far as the tab can see. */
  function destinationOf(record, index) {
    const label = record?.targetLabel ?? {}
    const target = record?.target ?? {}
    const sessionId = typeof record?.sessionId === 'string'
      ? record.sessionId
      : (target.kind === 'session' ? target.sessionId : undefined)
    const entry = index !== null && index !== undefined && typeof sessionId === 'string' ? index[sessionId] : undefined
    const workspaceTitle = typeof label.workspaceTitle === 'string' && label.workspaceTitle.length > 0
      ? label.workspaceTitle
      : (typeof entry?.workspaceTitle === 'string' ? entry.workspaceTitle : undefined)
    if (target.kind === 'new') return { kind: 'new', workspaceTitle, sessionTitle: undefined }
    let sessionTitle = typeof label.sessionTitle === 'string' && label.sessionTitle.length > 0
      ? label.sessionTitle
      : undefined
    if (sessionTitle === undefined && typeof entry?.sessionTitle === 'string' && entry.sessionTitle.length > 0) {
      sessionTitle = entry.sessionTitle
    }
    if (sessionTitle === undefined && typeof sessionId === 'string' && sessionId.length > 0) {
      sessionTitle = sessionId.slice(0, 8)
    }
    return { kind: 'session', workspaceTitle, sessionTitle }
  }

  /** Button copy for a destination: Workspace > Conversation. */
  function destinationText(t, destination) {
    if (destination === null || destination === undefined) return t('editor.noTarget')
    const workspace = typeof destination.workspaceTitle === 'string' ? destination.workspaceTitle : ''
    const session = destination.kind === 'new'
      ? t('panel.newConversation')
      : (typeof destination.sessionTitle === 'string' ? destination.sessionTitle : '')
    if (workspace.length > 0 && session.length > 0) return workspace + ' \u203A ' + session
    if (session.length > 0) return session
    if (workspace.length > 0) return workspace
    return t('editor.noTarget')
  }

  /** Pure card model: everything the card renders, with no DOM access. */
  function cardModel(record, zone, index) {
    const dueMs = Date.parse(record?.dueAt)
    const text = typeof record?.text === 'string' ? record.text : ''
    const images = Array.isArray(record?.images) ? record.images : []
    const files = Array.isArray(record?.files) ? record.files : []
    const status = record?.status
    return {
      record,
      id: record?.id,
      status,
      dueAt: record?.dueAt,
      updatedAt: record?.updatedAt,
      createdAt: record?.createdAt,
      time: Number.isFinite(dueMs) ? clockOf(dueMs, zone) : String(record?.dueAt ?? ''),
      preview: firstLine(text, 2),
      hasText: text.trim().length > 0,
      images: images.length,
      files: files.length,
      attachments: images.length + files.length,
      late: status === 'sent' && record?.late === true,
      cancelled: status === 'cancelled',
      failed: status === 'failed',
      sending: status === 'sending',
      sent: status === 'sent' || status === 'cancelled',
      error: typeof record?.error === 'string' ? record.error : undefined,
      destination: destinationOf(record, index),
    }
  }

  /** Day-group heading: a locale key for today/tomorrow/weekday, text for far dates. */
  function groupHeading(group, zone, locale) {
    if (group === null || group === undefined) return { kind: 'text', text: '' }
    if (group.kind === 'sent') return { kind: 'key', key: 'panel.sent' }
    if (group.kind === 'today') return { kind: 'key', key: 'panel.today' }
    if (group.kind === 'tomorrow') return { kind: 'key', key: 'panel.tomorrow' }
    const dueMs = group.rows !== undefined && group.rows.length > 0 ? Date.parse(group.rows[0].dueAt) : Number.NaN
    if (group.kind === 'weekday' && Number.isFinite(dueMs)) {
      return { kind: 'key', key: WEEKDAY_KEYS[core.localParts(dueMs, zone).isoWeekday - 1] }
    }
    const text = Number.isFinite(dueMs) ? formatDate(dueMs, locale, zone) : ''
    return { kind: 'text', text: text.length > 0 ? text : String(group.date ?? '') }
  }

  function headingText(t, heading) {
    if (heading === null || heading === undefined) return ''
    if (heading.kind === 'text') return heading.text
    return t(heading.key, heading.params)
  }

  /** Ordered day groups with pure card models, ready for rendering or assertions. */
  function buildGroups(records, nowMs, zone, locale, index) {
    return core.groupRecords(records, nowMs, zone).map(group => ({
      kind: group.kind,
      date: group.date,
      heading: groupHeading(group, zone, locale),
      rows: group.rows.map(record => cardModel(record, zone, index)),
    }))
  }

  function sameTarget(left, right) {
    if (left === null || left === undefined || right === null || right === undefined) return false
    if (left.kind !== right.kind) return false
    if (left.kind === 'session') return left.sessionId === right.sessionId
    const leftKey = typeof left.workspaceId === 'string' ? left.workspaceId : left.cwd
    const rightKey = typeof right.workspaceId === 'string' ? right.workspaceId : right.cwd
    return leftKey === rightKey
  }

  function targetKey(target) {
    if (target === null || target === undefined || typeof target !== 'object') return ''
    if (target.kind === 'session') return 'session:' + String(target.sessionId)
    if (target.kind === 'new') return 'new:' + String(typeof target.workspaceId === 'string' ? target.workspaceId : target.cwd)
    return ''
  }

  /**
   * Build the \`/update\` body from an editor draft.
   *
   * Only changed fields travel, so a concurrent edit of one field is not
   * clobbered by an untouched one. The record version always travels, so the
   * Host can refuse a stale save instead of overwriting it.
   */
  function buildUpdate(record, draft) {
    if (record === null || record === undefined || typeof record.id !== 'string') return null
    const changes = { id: record.id, expectedUpdatedAt: String(record.updatedAt ?? '') }
    let count = 0
    if (typeof draft?.dueAt === 'string' && draft.dueAt !== record.dueAt) {
      changes.dueAt = draft.dueAt
      count += 1
    }
    if (typeof draft?.text === 'string' && draft.text.trim() !== String(record.text ?? '').trim()) {
      changes.text = draft.text
      count += 1
    }
    if (draft?.target !== undefined && draft.target !== null && !sameTarget(draft.target, record.target)) {
      changes.target = draft.target
      count += 1
    }
    const removed = Array.isArray(draft?.removeIds) ? [...new Set(draft.removeIds)] : []
    if (removed.length > 0) {
      changes.removeAttachmentIds = removed
      count += 1
    }
    const fileIds = Array.isArray(draft?.addedFiles)
      ? [...new Set(draft.addedFiles.map(file => file?.fileId).filter(id => typeof id === 'string' && id.length > 0))]
      : []
    if (fileIds.length > 0) {
      changes.addFileIds = fileIds
      count += 1
    }
    const images = Array.isArray(draft?.addedImages) ? draft.addedImages : []
    if (images.length > 0) {
      changes.addImages = images.map(image => ({
        mediaType: image.mediaType,
        data: image.data,
        ...(typeof image.name === 'string' && image.name.length > 0 ? { name: image.name } : {}),
      }))
      count += 1
    }
    return count === 0 ? null : changes
  }

  /** The editor draft one record starts from. */
  function draftOf(record, zone) {
    const dueMs = Date.parse(record?.dueAt)
    return {
      text: typeof record?.text === 'string' ? record.text : '',
      dueAt: typeof record?.dueAt === 'string' ? record.dueAt : '',
      selection: selectionOf(Number.isFinite(dueMs) ? dueMs : Date.now() + 60 * 60_000, zone),
      target: record?.target ?? null,
      removeIds: [],
      addedImages: [],
      addedFiles: [],
    }
  }

  /** Resolve the chosen wall clock into the \`/update\` draft shape. */
  function draftPayload(draft, zone) {
    const resolved = resolveSelection(draft.selection, zone)
    return {
      dueAt: resolved.ok === true ? resolved.iso : draft.dueAt,
      text: draft.text,
      target: draft.target,
      removeIds: draft.removeIds,
      addedImages: draft.addedImages,
      addedFiles: draft.addedFiles,
    }
  }

  /** Attachments a draft would leave on the record, existing-first. */
  function pendingAttachments(record, draft) {
    const removed = new Set(Array.isArray(draft?.removeIds) ? draft.removeIds : [])
    const keep = refs => (Array.isArray(refs) ? refs : []).filter(ref => ref !== null && ref !== undefined && !removed.has(ref.attachmentId))
    const images = keep(record?.images)
    const files = keep(record?.files)
    const addedImages = Array.isArray(draft?.addedImages) ? draft.addedImages : []
    const addedFiles = Array.isArray(draft?.addedFiles) ? draft.addedFiles : []
    return {
      images,
      files,
      addedImages,
      addedFiles,
      total: images.length + files.length + addedImages.length + addedFiles.length,
    }
  }

  /** Conversations newest first; a summary without a timestamp sorts last. */
  function sortSessions(sessions) {
    const rows = Array.isArray(sessions) ? sessions.map((session, position) => ({ session, position })) : []
    rows.sort((left, right) => {
      const first = Number.isFinite(left.session?.updatedAt) ? left.session.updatedAt : -1
      const second = Number.isFinite(right.session?.updatedAt) ? right.session.updatedAt : -1
      if (first !== second) return second - first
      return left.position - right.position
    })
    return rows.map(row => row.session)
  }

  /** Filter the target popover by workspace title or conversation label. */
  function filterTargets(targets, query) {
    const workspaces = Array.isArray(targets?.workspaces) ? targets.workspaces : []
    const needle = String(query ?? '').trim().toLowerCase()
    const groups = []
    for (const workspace of workspaces) {
      if (workspace === null || workspace === undefined) continue
      const title = typeof workspace.title === 'string' && workspace.title.length > 0
        ? workspace.title
        : String(workspace.path ?? '')
      const sessions = sortSessions(workspace.sessions)
      const titleMatch = needle.length === 0 || title.toLowerCase().includes(needle)
      const matched = needle.length === 0
        ? sessions
        : sessions.filter(session => String(session?.label ?? session?.title ?? session?.id ?? '').toLowerCase().includes(needle))
      if (!titleMatch && matched.length === 0) continue
      groups.push({ workspace, sessions: matched })
    }
    return groups
  }

  function newConversationTarget(workspace) {
    const cwd = typeof workspace?.path === 'string' ? workspace.path : ''
    if (cwd.length === 0) return null
    const target = { kind: 'new', cwd }
    if (typeof workspace.id === 'string' && workspace.id.length > 0) target.workspaceId = workspace.id
    return target
  }

  function sessionIndexOf(targets) {
    const index = {}
    const workspaces = Array.isArray(targets?.workspaces) ? targets.workspaces : []
    for (const workspace of workspaces) {
      if (workspace === null || workspace === undefined) continue
      const workspaceTitle = typeof workspace.title === 'string' && workspace.title.length > 0
        ? workspace.title
        : workspace.path
      for (const session of Array.isArray(workspace.sessions) ? workspace.sessions : []) {
        if (session === null || session === undefined || typeof session.id !== 'string') continue
        index[session.id] = {
          workspaceTitle: typeof workspaceTitle === 'string' ? workspaceTitle : undefined,
          sessionTitle: typeof session.label === 'string' ? session.label : session.title,
        }
      }
    }
    return index
  }

  function thumbUrl(recordId, attachmentId) {
    return API + '/thumb?id=' + encodeURIComponent(recordId) + '&attachmentId=' + encodeURIComponent(attachmentId)
  }

  /** Read one pasted or dropped image as a data URL, for \`addImages\`. */
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => reject(reader.error ?? new Error('read failed'))
      reader.readAsDataURL(file)
    })
  }

  /** POST raw bytes to /upload, reporting real progress through XHR. */
  function uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const name = typeof file?.name === 'string' ? file.name : 'file'
      const xhr = new XMLHttpRequest()
      xhr.open('POST', API + '/upload?name=' + encodeURIComponent(name))
      xhr.withCredentials = true
      if (xhr.upload !== null && xhr.upload !== undefined && typeof onProgress === 'function') {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
        }
      }
      xhr.onload = () => {
        let body = null
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          body = null
        }
        if (body?.ok === true && body.value !== undefined) {
          resolve(body.value)
          return
        }
        const failure = body?.error
        reject(Object.assign(new Error(failure?.message ?? ('HTTP ' + String(xhr.status))), {
          code: typeof failure?.code === 'string' ? failure.code : 'internal',
        }))
      }
      xhr.onerror = () => reject(Object.assign(new Error('network'), { code: 'internal' }))
      xhr.send(file)
    })
  }


  /**
   * The session's current model id, read from the same shared directory the
   * composer's model seat renders, so the dialog follows a model switch live.
   * @param sessionId - owning conversation, or undefined outside a seat.
   * @returns the model id, or null when the profile has no model selection.
   */
  /**
   * The Session's durable model selection, read straight from its projection.
   *
   * A fallback for the first paint, or a profile whose model catalog failed to
   * load, where the shared directory has no `current` yet. Every step is
   * optional-chained: an unexpected shape answers null instead of throwing.
   * @param sessionId - owning conversation.
   * @returns the model id, or null when the projection cannot be read.
   */
  function projectSessionModel(sessionId) {
    try {
      const face = services.sessions?.binding?.(sessionId)?.session?.projections?.faceOf?.('modelSelection')
      const projected = face?.getSnapshot?.()
      const selection = projected?.next ?? projected?.lastUsed ?? null
      return typeof selection?.model === 'string' ? selection.model : null
    } catch {
      return null
    }
  }  function useSessionModelName(sessionId) {
    const store = useMemo(() => {
      const resolver = services.modelDirectories
      if (resolver === undefined || sessionId === undefined || typeof resolver.directoryFor !== 'function') return null
      try {
        return resolver.directoryFor(sessionId)?.store ?? null
      } catch {
        return null
      }
    }, [sessionId])
    const subscribe = useCallback(
      (listener) => (store === null ? () => {} : store.subscribe(() => listener())),
      [store],
    )
    const state = useSyncExternalStore(
      subscribe,
      () => (store === null ? null : store.getSnapshot()),
      () => null,
    )
    const selection = state?.current ?? state?.pending ?? null
    if (typeof selection?.model === 'string') return selection.model
    // The directory only reports a selection once the shared catalog has
    // loaded; the Session's own durable projection answers before that.
    return projectSessionModel(sessionId)
  }

  /** Mounted composers, used by the shortcut to find the focused conversation. */
  const composers = new Map()
  let lastTouchedSession = null

  function preferComposer(sessionId) {
    lastTouchedSession = sessionId
  }

  function pickComposer() {
    if (composers.size === 0) return null
    const preferred = lastTouchedSession === null ? undefined : composers.get(lastTouchedSession)
    if (preferred !== undefined) return preferred
    return composers.values().next().value ?? null
  }

  /** Inert snapshot for a seat rendered outside the composer tree. */
  const EMPTY_INPUT = Object.freeze({ draft: '', attachmentIds: Object.freeze([]), phase: 'plain' })

  /** Stand-in for `props.useInput`: registered in the same hook position, so hook order stays fixed. */
  function useNoopInput() {
    return EMPTY_INPUT
  }

  /** Identity selector; `InputState` is immutable, so a seat re-renders only when it changes. */
  function selectInput(state) {
    return state ?? EMPTY_INPUT
  }

  // ---------------------------------------------------------------- helpers

  function currentZone() {
    try {
      const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
      return typeof zone === 'string' && zone.length > 0 ? zone : 'UTC'
    } catch {
      return 'UTC'
    }
  }

  function currentLocale() {
    try {
      const declared = document?.documentElement?.getAttribute('lang')
      if (typeof declared === 'string' && declared.length > 0) return declared
    } catch {
      // A missing document is not an error here: fall through to the navigator.
    }
    try {
      return navigator.language || 'en'
    } catch {
      return 'en'
    }
  }

  function selectionOf(instantMs, zone) {
    const parts = core.localParts(instantMs, zone)
    const clock = core.toMeridiem(parts.hour24)
    return { date: parts.date, hour12: clock.hour12, minute: parts.minute, meridiem: clock.meridiem }
  }

  function addDays(date, days) {
    const [year, month, day] = date.split('-').map(Number)
    const shifted = new Date(Date.UTC(year, month - 1, day + days))
    return `${shifted.getUTCFullYear()}-${core.pad2(shifted.getUTCMonth() + 1)}-${core.pad2(shifted.getUTCDate())}`
  }

  function defaultSelection(zone) {
    const rounded = Math.ceil((Date.now() + 30 * 60_000) / 300_000) * 300_000
    return selectionOf(rounded, zone)
  }

  function resolveSelection(selection, zone) {
    return core.wallClockToInstant({
      date: selection.date,
      hour24: core.to24Hour(selection.hour12, selection.meridiem),
      minute: selection.minute,
    }, zone)
  }

  function firstLine(text, lines) {
    return String(text ?? '').split('\n').slice(0, lines).join('\n').trim()
  }

  function attachmentSummary(t, imageCount, fileCount) {
    const parts = []
    if (imageCount > 0) parts.push(t(imageCount === 1 ? 'attachments.image' : 'attachments.images', { count: imageCount }))
    if (fileCount > 0) parts.push(t(fileCount === 1 ? 'attachments.file' : 'attachments.files', { count: fileCount }))
    return parts.join(' · ')
  }

  function attachmentCountText(t, count) {
    if (count <= 0) return ''
    return t(count === 1 ? 'attachments.any' : 'attachments.anyMany', { count })
  }

  /**
   * Optional services, filled by nested `ctx.inject` scopes.
   *
   * Reading a service the plugin did not declare throws in cordis, so each
   * optional service is taken from its own scope; when the profile has no such
   * service the scope never runs and the feature that needs it degrades to a
   * no-op.
   */
  const services = { sessions: undefined, layout: undefined, modelDirectories: undefined }

  function errorText(t, error) {
    const code = error?.code
    const key = typeof code === 'string' ? ERROR_KEYS[code] : undefined
    if (key !== undefined) return t(key)
    const message = error?.message
    if (typeof message === 'string' && message.length > 0) return message
    return t('error.generic')
  }

  async function requestJson(path, init) {
    const response = await fetch(path, { credentials: 'include', ...init })
    let body
    try {
      body = await response.json()
    } catch {
      throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'internal' })
    }
    if (body?.ok !== true) {
      const failure = body?.error
      throw Object.assign(new Error(failure?.message ?? `HTTP ${response.status}`), {
        code: typeof failure?.code === 'string' ? failure.code : 'internal',
      })
    }
    return body.value
  }

  function postJson(path, payload) {
    return requestJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  function listScheduled(sessionId) {
    return requestJson(`${API}/list?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET' })
  }

  // ---------------------------------------------------------------- icons

  function ClockSendIcon() {
    return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
      h('circle', { cx: 6.5, cy: 8, r: 4.75, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
      h('path', { d: 'M6.5 5.4V8l1.9 1.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      h('path', { d: 'M11.6 9.1 15 11l-3.4 1.9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
  }

  function BellIcon() {
    return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
      h('path', {
        d: 'M4.2 11.1V7.3a3.8 3.8 0 0 1 7.6 0v3.8l1 1.1H3.2l1-1.1Z',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }),
      h('path', { d: 'M6.6 14a1.5 1.5 0 0 0 2.8 0', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
  }

  function CloseIcon() {
    return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
      h('path', { d: 'm4.5 4.5 7 7m0-7-7 7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
  }

  /** Small upward-trend mark for the peak-window notice. */
  function PeakIcon() {
    return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false' },
      h('path', {
        d: 'M2.4 11.6 6 7.6l2.6 2.2 3.9-5',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M10.6 4.4h2.6v2.6',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
  }

  /** Outline clock shared by the sidebar entry, the empty state and cards. */
  function ClockGlyph(props) {
    const size = Number.isFinite(props?.size) ? props.size : 16
    return h('svg', {
      viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true', focusable: 'false',
    },
      h('circle', { cx: 8, cy: 8, r: 6.1 }),
      h('path', { d: 'M8 4.6V8l2.4 1.5', strokeLinecap: 'round' }))
  }

  /** The sidebar entry: the clock plus a small badge while anything is waiting. */
  function panelIcon(size, count) {
    const pending = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
    const children = [h(ClockGlyph, { size: Number.isFinite(size) ? size : 16 })]
    if (pending > 0) {
      children.push(h('span', { className: 'dsm-panel-badge', 'aria-hidden': 'true' }, pending > 99 ? '99+' : String(pending)))
    }
    return h('span', { className: 'dsm-panel-icon' }, ...children)
  }

  function SendGlyph() {
    return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M14 2 6.6 9.4' }),
      h('path', { d: 'M14 2 9.6 14 6.6 9.4 2 6.4 14 2Z' }))
  }

  function PencilGlyph() {
    return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'm10.6 2.9 2.5 2.5-7.4 7.4-3 .5.5-3 7.4-7.4Z' }))
  }

  function TrashGlyph() {
    return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M3 4.5h10' }),
      h('path', { d: 'M6.2 4.5V2.8h3.6v1.7' }),
      h('path', { d: 'M4.4 4.5 5 13h6l.6-8.5' }))
  }

  function RetryGlyph() {
    return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7' }),
      h('path', { d: 'M13.4 2.4v3.2h-3.2' }))
  }

  function ChevronGlyph() {
    return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'm4.5 6 3.5 3.5L11.5 6' }))
  }

  function PaperclipGlyph() {
    return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M10.9 5.3 6 10.2a1.7 1.7 0 0 0 2.4 2.4l5.4-5.4a3.4 3.4 0 0 0-4.8-4.8L3.2 8.2a4.6 4.6 0 0 0 6.5 6.5l4-4' }))
  }

  function FileGlyph() {
    return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M9.2 2.2H4.8v11.6h6.4V4.2L9.2 2.2Z' }),
      h('path', { d: 'M9.2 2.2v2.2h2' }))
  }

  /** Warning triangle for the two destructive confirmations. */
  function WarnGlyph(props) {
    const size = Number.isFinite(props?.size) ? props.size : 18
    return h('svg', { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M8 2.1 1.9 13h12.2L8 2.1Z' }),
      h('path', { d: 'M8 6.1v3.2' }),
      h('path', { d: 'M8 11.4h.01' }))
  }

  // ---------------------------------------------------------------- dialog

  /**
   * Date, 12-hour clock, AM/PM and Repeat editor.
   *
   * @param props - localized translator, current zone, mode, initial selection,
   *   whether Repeat is available, and the submit callback (which throws to
   *   keep the dialog open with an inline error).
   */
  function ScheduleDialog(props) {
    const { t, zone, mode, initial, repeatLocked, previewText, attachmentCount, modelName, onSubmit, onClose } = props
    const locale = currentLocale()
    const titleId = useId()
    const panel = useRef(null)
    const restore = useRef(null)

    const [selection, setSelection] = useState(() => initial ?? defaultSelection(zone))
    const [repeat, setRepeat] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)

    const resolved = useMemo(() => resolveSelection(selection, zone), [selection, zone])
    const now = Date.now()
    const tooSoon = resolved.ok !== true || resolved.instantMs < now + core.MIN_LEAD_MS

    const quickPicks = useMemo(() => listQuickPicks(t, zone, now), [t, zone, Math.floor(now / 60_000)])

    /** Peak-price notice: DeepSeek models only, and only inside a peak window. */
    const peak = useMemo(
      () => core.deepSeekPeakNotice({
        instantMs: resolved.ok === true ? resolved.instantMs : null,
        modelName,
        timeZone: zone,
      }) ?? null,
      [resolved, modelName, zone],
    )

    useEffect(() => {
      restore.current = typeof document !== 'undefined' ? document.activeElement : null
      const first = panel.current?.querySelector('button, select, input')
      first?.focus?.()
      return () => {
        const target = restore.current
        if (target !== null && typeof target?.focus === 'function') target.focus()
      }
    }, [])

    const onKeyDown = useCallback((event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || panel.current === null) return
      const focusable = [...panel.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }, [onClose])

    const update = (patch) => setSelection(current => ({ ...current, ...patch }))

    const submit = async () => {
      if (busy || tooSoon) return
      setBusy(true)
      setError(null)
      try {
        await onSubmit({ selection, repeat, instantMs: resolved.instantMs })
      } catch (failure) {
        setError(failure)
        setBusy(false)
      }
    }

    const minDate = core.localParts(now, zone).date
    const dayOfMonth = Number(selection.date.slice(8, 10))
    const weekday = (() => {
      const probe = resolved.ok === true ? resolved.instantMs : now
      return WEEKDAY_KEYS[core.localParts(probe, zone).isoWeekday - 1]
    })()

    const summary = tooSoon
      ? t('dialog.pastWarning')
      : t('dialog.summary', {
        time: core.describeDue(resolved.instantMs, locale, zone),
        zone: core.describeZone(resolved.instantMs, locale, zone),
      })

    const primaryLabel = mode === 'reschedule'
      ? t('dialog.saveTime')
      : repeat === null ? t('dialog.submit') : t('dialog.createAutomation')

    return ReactDOM.createPortal(
      h('div', {
        className: 'dsm-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
      h('div', {
        className: 'dsm-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        ref: panel,
        onKeyDown,
      },
      h('header', { className: 'dsm-dialog-head' },
        h('h2', { id: titleId, className: 'dsm-dialog-title' }, mode === 'reschedule' ? t('dialog.rescheduleTitle') : t('dialog.title')),
        h('button', { type: 'button', className: 'dsm-icon-btn', 'aria-label': t('dialog.close'), onClick: onClose }, h(CloseIcon))),

      mode === 'create'
        ? h('div', { className: 'dsm-preview' },
          h('p', { className: 'dsm-preview-text' }, firstLine(previewText, 2) || t('dialog.noText')),
          attachmentCount > 0
            ? h('p', { className: 'dsm-preview-meta' }, attachmentCountText(t, attachmentCount))
            : null)
        : null,

      quickPicks.length > 0
        ? h('div', { className: 'dsm-quick' },
          quickPicks.map(pick => h('button', {
            key: pick.id,
            type: 'button',
            className: 'dsm-chip',
            disabled: busy,
            onClick: () => setSelection(pick.selection),
          }, t(pick.label))))
        : null,

      h('div', { className: 'dsm-fields' },
        h('label', { className: 'dsm-field dsm-field-date' },
          h('span', { className: 'dsm-label' }, t('dialog.date')),
          h('input', {
            className: 'dsm-input',
            type: 'date',
            value: selection.date,
            min: minDate,
            disabled: busy,
            onChange: (event) => {
              const value = event.target.value
              if (typeof value === 'string' && value.length === 10) update({ date: value })
            },
          })),
        h('label', { className: 'dsm-field' },
          h('span', { className: 'dsm-label' }, t('dialog.hour')),
          h('select', {
            className: 'dsm-select',
            value: String(selection.hour12),
            disabled: busy,
            onChange: (event) => update({ hour12: Number(event.target.value) }),
          }, HOURS.map(hour => h('option', { key: hour, value: String(hour) }, String(hour))))),
        h('label', { className: 'dsm-field' },
          h('span', { className: 'dsm-label' }, t('dialog.minute')),
          h('select', {
            className: 'dsm-select',
            value: String(selection.minute),
            disabled: busy,
            onChange: (event) => update({ minute: Number(event.target.value) }),
          }, MINUTE_STEPS.map(minute => h('option', { key: minute, value: String(minute) }, core.pad2(minute))))),
        h('div', { className: 'dsm-field dsm-field-meridiem', role: 'group', 'aria-label': t('dialog.meridiem') },
          ['AM', 'PM'].map(meridiem => h('button', {
            key: meridiem,
            type: 'button',
            className: `dsm-seg${selection.meridiem === meridiem ? ' dsm-seg-on' : ''}`,
            'aria-pressed': selection.meridiem === meridiem,
            disabled: busy,
            onClick: () => update({ meridiem }),
          }, meridiem)))),

      h('p', { className: `dsm-summary${tooSoon ? ' dsm-summary-bad' : ''}`, role: 'status' }, summary),
      peak === null
        ? null
        : h('p', { className: 'dsm-peak' },
          h(PeakIcon),
          h('span', null, t('dialog.peakHint', { windows: peak.windows }))),

      mode === 'create'
        ? h('div', { className: 'dsm-repeat' },
          h('label', { className: `dsm-check${repeatLocked ? ' dsm-check-off' : ''}` },
            h('input', {
              type: 'checkbox',
              checked: repeat !== null,
              disabled: busy || repeatLocked,
              onChange: (event) => setRepeat(event.target.checked ? 'daily' : null),
            }),
            h('span', null, t('dialog.repeat'))),
          repeat === null
            ? h('p', { className: 'dsm-hint' }, repeatLocked ? t('dialog.repeatLocked') : t('dialog.repeatHint'))
            : h('div', { className: 'dsm-repeat-body' },
              h('select', {
                className: 'dsm-select',
                value: repeat,
                disabled: busy,
                'aria-label': t('dialog.repeat'),
                onChange: (event) => setRepeat(event.target.value),
              },
              core.REPEAT_FREQUENCIES.map(frequency => h('option', { key: frequency, value: frequency }, t(`repeat.${frequency}`)))),
              h('p', { className: 'dsm-hint' }, repeatDetail(t, repeat, weekday)),
              repeat === 'monthly' && core.skipsShortMonths(dayOfMonth)
                ? h('p', { className: 'dsm-hint dsm-hint-warn' }, t('dialog.repeatShortMonths'))
                : null))
        : null,

      error !== null
        ? h('p', { className: 'dsm-error', role: 'alert' }, errorText(t, error))
        : null,

      h('footer', { className: 'dsm-foot' },
        h('button', { type: 'button', className: 'dsm-btn-ghost', disabled: busy, onClick: onClose }, t('dialog.cancel')),
        h('button', {
          type: 'button',
          className: 'dsm-btn dsm-btn-primary',
          disabled: busy || tooSoon,
          onClick: submit,
        }, busy ? h('span', { className: 'dsm-spinner', 'aria-hidden': 'true' }) : null, primaryLabel)))),
      document.body)
  }

  function listQuickPicks(t, zone, now) {
    const picks = []
    const current = selectionOf(now + 60 * 60_000, zone)
    picks.push({ id: 'hour', label: 'quick.inHour', selection: current })

    const today = core.localParts(now, zone).date
    const evening = core.wallClockToInstant({ date: today, hour24: 20, minute: 0 }, zone)
    if (evening.ok === true && evening.instantMs > now + core.MIN_LEAD_MS) {
      picks.push({ id: 'evening', label: 'quick.thisEvening', selection: selectionOf(evening.instantMs, zone) })
    }

    const tomorrow = core.wallClockToInstant({ date: addDays(today, 1), hour24: 9, minute: 0 }, zone)
    if (tomorrow.ok === true) {
      picks.push({ id: 'tomorrow', label: 'quick.tomorrow', selection: selectionOf(tomorrow.instantMs, zone) })
    }

    const isoWeekday = core.localParts(now, zone).isoWeekday
    const toMonday = ((8 - isoWeekday) % 7) || 7
    const monday = core.wallClockToInstant({ date: addDays(today, toMonday), hour24: 9, minute: 0 }, zone)
    if (monday.ok === true) {
      picks.push({ id: 'monday', label: 'quick.nextMonday', selection: selectionOf(monday.instantMs, zone) })
    }
    return picks
  }

  function repeatDetail(t, repeat, weekdayKey) {
    if (repeat === 'weekly') return t('repeat.detail.weekly', { weekday: t(weekdayKey) })
    if (repeat === 'monthly') return t('repeat.detail.monthly')
    return t(`repeat.detail.${repeat}`)
  }

  // ---------------------------------------------------------------- create plumbing

  /**
   * Turn the current composer draft into a create request and send it.
   *
   * Attachment ids are serialized by the concrete conversation service, so an
   * unfinished upload is reported instead of scheduling a partial attachment.
   */
  async function createScheduledMessage(environment, plan) {
    const { t, sessionId, draft, attachmentIds, inputActions } = environment
    const zone = currentZone()
    let images = []
    const fileReceipts = []
    if (attachmentIds.length > 0) {
      const conversation = conversationOf(sessionId)
      if (conversation === undefined || typeof conversation.serializeDraftAttachments !== 'function') {
        throw Object.assign(new Error(t('error.attachmentsUnavailable')), { code: 'internal' })
      }
      let serialized
      try {
        serialized = await conversation.serializeDraftAttachments(attachmentIds)
      } catch {
        throw Object.assign(new Error(t('error.uploading')), { code: 'internal' })
      }
      for (const part of serialized.attachments) {
        if (part.type === 'image') {
          images.push({
            mediaType: part.mediaType,
            data: part.data,
            ...(typeof part.name === 'string' && part.name.length > 0 ? { name: part.name } : {}),
          })
        } else if (part.type === 'file') {
          fileReceipts.push(part.receiptId)
        }
      }
    }

    const value = await postJson(`${API}/create`, {
      sessionId,
      dueAt: new Date(plan.instantMs).toISOString(),
      timeZone: zone,
      text: draft,
      images,
      fileReceipts,
      repeat: plan.repeat,
    })

    const locale = currentLocale()
    const when = core.describeDue(plan.instantMs, locale, zone)
    if (value.kind === 'automation') {
      setToast(sessionId, t('notice.automationCreated', { time: when }))
      openTasksPanel()
    } else {
      try {
        inputActions.setDraft('')
        for (const id of attachmentIds) inputActions.removeAttachment(id)
      } catch {
        // A composer that already settled its draft is not an error here.
      }
      // The strip already reports this record, so the composer gets only a
      // self-clearing flash. A pushed session notice is a sentence the plugin
      // cannot retract, and it outlived a deleted record (docs/DETAIL.md §7.3).
      setToast(sessionId, t('notice.scheduled', { time: when }))
    }
    bumpRefresh()
    return value
  }

  function conversationOf(sessionId) {
    try {
      const scope = services.sessions?.scope?.(sessionId)
      if (scope === undefined) return undefined
      return scope.get?.('conversation')
    } catch {
      return undefined
    }
  }

  function openTasksPanel() {
    try {
      services.layout?.selectPanel?.(TASKS_PANEL)
    } catch {
      // A profile without the task page simply keeps the current panel.
    }
  }

  /** Open this plugin's own panel, e.g. from the composer strip. */
  function openPanel() {
    try {
      services.layout?.selectPanel?.(PANEL_ID)
    } catch {
      // A profile without the layout service simply keeps the current panel.
    }
  }

  // ---------------------------------------------------------------- button

  /**
   * Orange Schedule control in the composer tool row.
   *
   * Enter, Shift+Enter, Ctrl/Cmd+Enter and the Send button keep their meaning:
   * this only stages the current draft for later delivery.
   */
  function ScheduleButton(props) {
    const { t, inputActions } = props
    const sessionId = props.dsmSessionId ?? props.sessionId ?? props.session?.sessionId
    // `conversation.input.right` is a session-scope list slot: the owner passes
    // no per-seat `input` (only `conversation.input.dock` gets the `InputZone`
    // owner values). Live draft state arrives through the standard
    // `useInput` selector hook that every session-scope entry receives.
    const useInputHook = typeof props.useInput === 'function' ? props.useInput : useNoopInput
    const input = useInputHook(selectInput)
    const draft = typeof input?.draft === 'string' ? input.draft : ''
    const attachmentIds = Array.isArray(input?.attachmentIds) ? input.attachmentIds : []
    const phase = typeof input?.phase === 'string' ? input.phase : 'plain'
    const openSeq = useOpenRequest(sessionId)
    const modelName = useSessionModelName(sessionId)
    const [open, setOpen] = useState(false)
    const zone = useMemo(currentZone, [])

    useEffect(() => {
      if (sessionId === undefined) return undefined
      rememberOpenSession(sessionId)
      return () => forgetOpenSession(sessionId)
    }, [sessionId])

    useEffect(() => {
      if (openSeq > 0) setOpen(true)
    }, [openSeq])

    const hasContent = draft.trim().length > 0 || attachmentIds.length > 0
    const disabled = !hasContent || phase !== 'plain'

    useEffect(() => {
      if (sessionId === undefined) return undefined
      composers.set(sessionId, {
        sessionId,
        draft,
        attachments: attachmentIds.length,
        phase,
        open: () => setOpen(true),
      })
      if (hasContent) preferComposer(sessionId)
      return () => {
        if (composers.get(sessionId)?.sessionId === sessionId) composers.delete(sessionId)
      }
    }, [sessionId, draft, attachmentIds.length, phase, hasContent])

    if (sessionId === undefined) return null

    // The tab has no session context of its own: remember the conversation the
    // composer last showed so "This workspace" can resolve to its workspace.
    rememberOpenSession(sessionId)

    const environment = { t, sessionId, draft, attachmentIds, inputActions }

    return h(React.Fragment, null,
      h('button', {
        type: 'button',
        className: 'dsm-btn dsm-btn-schedule',
        disabled,
        'aria-haspopup': 'dialog',
        'aria-label': t('button.label'),
        title: disabled ? (phase !== 'plain' ? t('button.busyHint') : t('button.emptyHint')) : t('button.label'),
        onMouseDown: (event) => event.preventDefault(),
        onClick: () => setOpen(true),
      },
      h(ClockSendIcon),
      h('span', { className: 'dsm-btn-wide' }, t('button.label')),
      h('span', { className: 'dsm-btn-short' }, t('button.shortLabel'))),

      open
        ? h(ScheduleDialog, {
          t,
          zone,
          mode: 'create',
          modelName,
          initial: defaultSelection(zone),
          repeatLocked: attachmentIds.length > 0,
          previewText: draft,
          attachmentCount: attachmentIds.length,
          onClose: () => setOpen(false),
          onSubmit: async (plan) => {
            await createScheduledMessage(environment, plan)
            setOpen(false)
          },
        })
        : null)
  }

  // ---------------------------------------------------------------- dock

  /** The composer strip that lists and manages this session's scheduled messages. */
  function ScheduleDock(props) {
    const { t } = props
    const sessionId = props.dsmSessionId ?? props.sessionId ?? props.session?.sessionId
    const refresh = useRefreshSignal()
    const zone = useMemo(currentZone, [])
    const locale = useMemo(currentLocale, [])
    const modelName = useSessionModelName(sessionId)
    const [items, setItems] = useState([])
    const [failure, setFailure] = useState(null)
    const [expanded, setExpanded] = useState(false)
    const [busyId, setBusyId] = useState(null)
    const [confirmId, setConfirmId] = useState(null)
    const [editing, setEditing] = useState(null)

    useEffect(() => {
      if (sessionId === undefined) return undefined
      rememberOpenSession(sessionId)
      return () => forgetOpenSession(sessionId)
    }, [sessionId])

    useEffect(() => {
      if (sessionId === undefined) return undefined
      let cancelled = false
      listScheduled(sessionId).then((value) => {
        if (cancelled) return
        setItems(Array.isArray(value.items) ? value.items : [])
        setFailure(null)
      }, (error) => {
        if (cancelled) return
        setFailure(error)
      })
      return () => {
        cancelled = true
      }
    }, [sessionId, refresh])

    useEffect(() => {
      const onFocus = () => bumpRefresh()
      window.addEventListener('focus', onFocus)
      return () => window.removeEventListener('focus', onFocus)
    }, [])

    const nextDueMs = useMemo(() => {
      const pending = items.filter(item => item.status === 'pending')
      if (pending.length === 0) return null
      return Math.min(...pending.map(item => Date.parse(item.dueAt)))
    }, [items])

    useEffect(() => {
      if (nextDueMs === null || !Number.isFinite(nextDueMs)) return undefined
      const wait = Math.max(nextDueMs - Date.now() + 2000, 1000)
      const timer = setTimeout(() => bumpRefresh(), Math.min(wait, 2_147_483_647))
      return () => clearTimeout(timer)
    }, [nextDueMs])

    const act = useCallback(async (id, path, payload) => {
      setBusyId(id)
      try {
        await postJson(`${API}/${path}`, { id, ...payload })
        if (path === 'cancel') clearToast()
        bumpRefresh()
      } catch (error) {
        setFailure(error)
      } finally {
        setBusyId(null)
        setConfirmId(null)
      }
    }, [])

    if (sessionId === undefined) return null

    rememberOpenSession(sessionId)

    const pending = items.filter(item => item.status === 'pending' || item.status === 'sending')
    const failed = items.filter(item => item.status === 'failed')
    const sent = items.filter(item => item.status === 'sent')
    const visible = items.length > 0
    const flash = toastFor(sessionId)
    if (!visible && flash === null) return null

    const head = pending.length > 0
      ? t('dock.collapsed', {
        count: pending.length,
        next: nextDueMs === null ? '' : core.describeDue(nextDueMs, locale, zone),
      })
      : t('dock.collapsedEmpty')

    return h('div', { className: 'dsm-dock' },
      flash !== null ? h('p', { className: 'dsm-toast', role: 'status' }, flash) : null,

      h('div', { className: 'dsm-dock-bar' },
        visible
          ? h('button', {
            type: 'button',
            className: 'dsm-dock-head',
            'aria-expanded': expanded,
            onClick: () => setExpanded(current => !current),
          }, h(BellIcon), h('span', null, head), h('span', { className: 'dsm-dock-caret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'))
          : null,
        h('button', { type: 'button', className: 'dsm-link dsm-dock-all', onClick: openPanel }, t('panel.viewAll'))),

      expanded
        ? h('ul', { className: 'dsm-dock-list' },
          pending.map(item => h(DockRow, {
            key: item.id,
            t,
            locale,
            zone,
            item,
            busy: busyId === item.id,
            confirming: confirmId === item.id,
            onSendNow: () => act(item.id, 'send-now', {}),
            onAskCancel: () => setConfirmId(item.id),
            onCancelDismiss: () => setConfirmId(null),
            onCancel: () => act(item.id, 'cancel', {}),
            onChangeTime: () => setEditing(item),
          })),
          failed.map(item => h(DockRow, {
            key: item.id,
            t,
            locale,
            zone,
            item,
            busy: busyId === item.id,
            confirming: confirmId === item.id,
            onRetry: () => act(item.id, 'retry', {}),
            onAskCancel: () => setConfirmId(item.id),
            onCancelDismiss: () => setConfirmId(null),
            onCancel: () => act(item.id, 'cancel', {}),
          })),
          sent.map(item => h(DockRow, { key: item.id, t, locale, zone, item, busy: false, confirming: false })))
        : null,

      failure !== null
        ? h('p', { className: 'dsm-error dsm-dock-error', role: 'alert' }, errorText(t, failure))
        : null,

      editing !== null
        ? h(ScheduleDialog, {
          t,
          zone,
          mode: 'reschedule',
          initial: Number.isFinite(Date.parse(editing.dueAt))
            ? selectionOf(Date.parse(editing.dueAt), zone)
            : defaultSelection(zone),
          repeatLocked: true,
          previewText: '',
          modelName,
          attachmentCount: 0,
          onClose: () => setEditing(null),
          onSubmit: async (plan) => {
            setBusyId(editing.id)
            try {
              await postJson(`${API}/reschedule`, { id: editing.id, dueAt: new Date(plan.instantMs).toISOString() })
              setToast(sessionId, t('notice.rescheduled', { time: core.describeDue(plan.instantMs, locale, zone) }))
              bumpRefresh()
              setEditing(null)
            } finally {
              setBusyId(null)
            }
          },
        })
        : null)
  }

  /** One scheduled-message row with its actions. */
  function DockRow(props) {
    const { t, locale, zone, item, busy, confirming, onSendNow, onRetry, onAskCancel, onCancel, onCancelDismiss, onChangeTime } = props
    const dueMs = Date.parse(item.dueAt)
    const time = Number.isFinite(dueMs) ? core.describeDue(dueMs, locale, zone) : item.dueAt
    const preview = firstLine(item.text, 1) || t('dock.noText')
    const meta = attachmentSummary(t, item.imageCount, item.fileCount)

    if (item.status === 'sent') {
      return h('li', { className: 'dsm-dock-row dsm-dock-row-sent' },
        h('span', { className: 'dsm-dock-tick', 'aria-hidden': 'true' }, '✓'),
        h('span', { className: 'dsm-dock-text' }, preview),
        h('span', { className: 'dsm-dock-time' }, item.late === true ? t('dock.sentLate', { time }) : t('dock.sent', { time })))
    }

    if (item.status === 'failed') {
      return h('li', { className: 'dsm-dock-row dsm-dock-row-failed' },
        h('span', { className: 'dsm-dock-text' }, preview),
        h('span', { className: 'dsm-dock-time' }, t('dock.failed', { time })),
        item.error === undefined ? null : h('p', { className: 'dsm-dock-error-text' }, item.error),
        h('div', { className: 'dsm-dock-actions' },
          h('button', { type: 'button', className: 'dsm-link', disabled: busy, onClick: onRetry }, t('dock.retry')),
          confirming
            ? h(React.Fragment, null,
              h('button', { type: 'button', className: 'dsm-link dsm-link-danger', disabled: busy, onClick: onCancel }, t('dock.confirmCancel')),
              h('button', { type: 'button', className: 'dsm-link', disabled: busy, onClick: onCancelDismiss }, t('dock.keep')))
            : h('button', { type: 'button', className: 'dsm-link', disabled: busy, onClick: onAskCancel }, t('dock.cancel'))))
    }

    return h('li', { className: 'dsm-dock-row' },
      h('span', { className: 'dsm-dock-text' }, preview),
      h('span', { className: 'dsm-dock-time' }, item.status === 'sending' ? t('dock.sending') : time),
      meta.length > 0 ? h('span', { className: 'dsm-dock-meta' }, meta) : null,
      h('div', { className: 'dsm-dock-actions' },
        h('button', { type: 'button', className: 'dsm-link', disabled: busy, onClick: onSendNow }, t('dock.sendNow')),
        h('button', { type: 'button', className: 'dsm-link', disabled: busy, onClick: onChangeTime }, t('dock.changeTime')),
        confirming
          ? h(React.Fragment, null,
            h('button', { type: 'button', className: 'dsm-link dsm-link-danger', disabled: busy, onClick: onCancel }, t('dock.confirmCancel')),
            h('button', { type: 'button', className: 'dsm-link', disabled: busy, onClick: onCancelDismiss }, t('dock.keep')))
          : h('button', { type: 'button', className: 'dsm-link', disabled: busy, onClick: onAskCancel }, t('dock.cancel'))))
  }

  // ---------------------------------------------------------------- scheduled tab

  /** One card in the tab: time, two-line preview, destination, hover actions. */
  function RecordCard(props) {
    const { t, model, confirming, busy, onOpen, onSendNow, onRetry, onEdit, onAskDelete, onDelete, onDeleteDismiss } = props
    const record = model.record
    const sent = model.sent
    const cardClass = 'dsm-card' + (model.failed ? ' dsm-card-failed' : '') + (sent ? ' dsm-card-sent' : '')
    const open = (element) => {
      if (sent) return
      if (typeof onOpen === 'function') onOpen(record, element)
    }
    return h('article', {
      className: cardClass,
      tabIndex: sent ? undefined : 0,
      role: sent ? undefined : 'button',
      'aria-label': model.preview.length > 0 ? model.preview : t('panel.noText'),
      onClick: sent ? undefined : (event) => open(event.currentTarget),
      onKeyDown: sent ? undefined : (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open(event.currentTarget)
        }
      },
    },
      h('span', { className: 'dsm-card-time' }, model.time),
      h('div', { className: 'dsm-card-body' },
        h('p', { className: 'dsm-card-text' }, model.preview.length > 0 ? model.preview : t('panel.noText')),
        model.failed && model.error !== undefined ? h('p', { className: 'dsm-card-reason' }, model.error) : null,
        h('p', { className: 'dsm-card-meta' },
          h('span', { className: 'dsm-card-target' }, destinationText(t, model.destination)),
          model.attachments > 0
            ? h('span', { className: 'dsm-card-attach' }, h(PaperclipGlyph), h('span', null, attachmentSummary(t, model.images, model.files)))
            : null,
          model.late ? h('span', { className: 'dsm-card-late' }, t('panel.sentLate')) : null,
          model.cancelled ? h('span', { className: 'dsm-card-late' }, t('panel.cancelled')) : null,
          model.sending ? h('span', null, t('dock.sending')) : null)),
      sent ? null : h('div', {
        className: 'dsm-card-actions',
        onClick: (event) => event.stopPropagation(),
        onKeyDown: (event) => event.stopPropagation(),
      },
        confirming
          ? h(React.Fragment, null,
            h('span', { className: 'dsm-action dsm-action-question' }, t('panel.deleteConfirm')),
            h('button', { type: 'button', className: 'dsm-action dsm-action-danger', disabled: busy, onClick: () => onDelete(record) }, t('panel.deleteYes')),
            h('button', { type: 'button', className: 'dsm-action', disabled: busy, onClick: onDeleteDismiss }, t('panel.deleteKeep')))
          : h(React.Fragment, null,
            model.failed
              ? h('button', { type: 'button', className: 'dsm-action', disabled: busy, title: t('panel.retry'), 'aria-label': t('panel.retry'), onClick: () => onRetry(record) }, h(RetryGlyph), h('span', { className: 'dsm-action-text' }, t('panel.retry')))
              : h('button', { type: 'button', className: 'dsm-action', disabled: busy || model.sending, title: t('panel.sendNow'), 'aria-label': t('panel.sendNow'), onClick: () => onSendNow(record) }, h(SendGlyph), h('span', { className: 'dsm-action-text' }, t('panel.sendNow'))),
            h('button', { type: 'button', className: 'dsm-action', disabled: busy, title: t('panel.edit'), 'aria-label': t('panel.edit'), onClick: () => onEdit(record) }, h(PencilGlyph), h('span', { className: 'dsm-action-text' }, t('panel.edit'))),
            model.failed
              ? null
              : h('button', { type: 'button', className: 'dsm-action dsm-action-danger', disabled: busy, title: t('panel.delete'), 'aria-label': t('panel.delete'), onClick: () => onAskDelete(record) }, h(TrashGlyph), h('span', { className: 'dsm-action-text' }, t('panel.delete')))))
    )
  }

  /** Sidebar entry: subscribes to the shared list so the badge stays current. */
  function ScheduledIcon(props) {
    const size = props !== null && props !== undefined && Number.isFinite(props.size) ? props.size : 16
    useSyncExternalStore(subscribeAll, allSnapshot, () => 0)
    useEffect(() => {
      void loadAll()
    }, [])
    return panelIcon(size, core.countPending(allState.items))
  }

  /**
   * The Scheduled page: one centred column, day groups, cards and the editor.
   *
   * Refresh follows the contract: on open, on window focus, when a hidden page
   * becomes visible, after every action and once about two seconds after the
   * next due instant. There is no interval polling.
   */
  function ScheduledPage(props) {
    const t = typeof props?.t === 'function' ? props.t : translate
    const zone = useMemo(currentZone, [])
    const locale = useMemo(currentLocale, [])
    useSyncExternalStore(subscribeAll, allSnapshot, () => 0)
    const items = allState.items
    const [busyId, setBusyId] = useState(null)
    const [confirmId, setConfirmId] = useState(null)
    const [editing, setEditing] = useState(null)
    const [notice, setNotice] = useState(null)
    const [sentOpen, setSentOpen] = useState(false)
    const [scope, setScope] = useState('all')
    const [workspaceFilter, setWorkspaceFilter] = useState(null)
    const [repeating, setRepeating] = useState(null)
    const refresh = useRefreshSignal()

    useEffect(() => {
      void loadAll()
      const onFocus = () => {
        bumpRefresh()
      }
      const onVisible = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') bumpRefresh()
      }
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onVisible)
      }
    }, [])

    useEffect(() => {
      if (notice === null) return undefined
      const timer = setTimeout(() => setNotice(null), 5000)
      return () => clearTimeout(timer)
    }, [notice])

    // Resolve "This workspace" from the last open conversation. Without a
    // mapping the control stays hidden and the list stays on All.
    useEffect(() => {
      let cancelled = false
      const apply = (targets) => {
        if (cancelled) return
        const filter = resolveWorkspaceFilter(targets, lastOpenSessionId)
        setWorkspaceFilter(filter)
        if (filter === null) {
          setScope('all')
          setListScope({ kind: 'all' })
        }
      }
      if (targetCache.value !== null) apply(targetCache.value)
      else loadTargets().then(apply, () => apply(null))
      return () => {
        cancelled = true
      }
    }, [])

    // Repeating messages belong to the Automation service; the tab mirrors the
    // Host answer after every refresh and never edits one.
    useEffect(() => {
      let cancelled = false
      requestJson(API + '/repeating', { method: 'GET' }).then((value) => {
        if (!cancelled) setRepeating(value === undefined ? null : value)
      }, () => {
        if (!cancelled) setRepeating(null)
      })
      return () => {
        cancelled = true
      }
    }, [refresh])

    const act = (record, path, noticeKey) => {
      setBusyId(record.id)
      postJson(API + '/' + path, { id: record.id }).then(() => {
        if (path === 'cancel') clearToast()
        bumpRefresh()
        if (noticeKey !== undefined) setNotice(t(noticeKey))
      }, (error) => {
        setNotice(errorText(t, error))
      }).then(() => {
        setBusyId(null)
        setConfirmId(null)
      })
    }

    const openEditor = (record, element) => {
      let opener = element === undefined ? null : element
      if (opener === null && typeof document !== 'undefined' && document.activeElement !== null) {
        const card = document.activeElement.closest === undefined ? null : document.activeElement.closest('.dsm-card')
        if (card !== null && card !== undefined) opener = card
      }
      setEditing({ id: record.id, opener })
    }

    const closeEditor = () => {
      setEditing(null)
      bumpRefresh()
    }

    const renderCard = (model) => h(RecordCard, {
      key: model.id,
      t,
      model,
      busy: busyId === model.id,
      confirming: confirmId === model.id,
      onOpen: openEditor,
      onSendNow: (record) => act(record, 'send-now'),
      onRetry: (record) => act(record, 'retry'),
      onEdit: (record) => openEditor(record, null),
      onAskDelete: (record) => setConfirmId(record.id),
      onDelete: (record) => act(record, 'cancel', 'panel.noticeDeleted'),
      onDeleteDismiss: () => setConfirmId(null),
    })

    const renderGroup = (group) => {
      if (group.kind === 'sent') {
        return h('section', { key: 'sent', className: 'dsm-group' },
          h('button', {
            type: 'button',
            className: 'dsm-group-head dsm-group-toggle',
            'aria-expanded': sentOpen,
            onClick: () => setSentOpen(current => !current),
          },
            h('span', { className: 'dsm-group-caret', 'aria-hidden': 'true' }, sentOpen ? '\u25BE' : '\u25B8'),
            h('span', null, t('panel.sent') + ' (' + String(group.rows.length) + ')')),
          sentOpen ? h('div', { className: 'dsm-cards' }, group.rows.map(renderCard)) : null)
      }
      return h('section', { key: String(group.date ?? group.heading.text), className: 'dsm-group' },
        h('h2', { className: 'dsm-group-head' }, headingText(t, group.heading)),
        h('div', { className: 'dsm-cards' }, group.rows.map(renderCard)))
    }

    const chooseScope = (next) => {
      setScope(next)
      setListScope(next === 'workspace' && workspaceFilter !== null
        ? { kind: 'workspace', workspaceId: workspaceFilter.workspaceId }
        : { kind: 'all' })
    }

    const now = Date.now()
    const groups = buildGroups(items, now, zone, locale, null)
    const repeatingModel = repeatingView(repeating)
    const count = countText(core.countPending(items))
    const firstLoad = !allState.loaded
    const failure = allState.error
    const empty = !firstLoad && failure === null && items.length === 0

    return h('div', { className: 'dsm-page' },
      h('div', { className: 'dsm-page-inner' },
        h('header', { className: 'dsm-page-head' },
          h('h1', { className: 'dsm-page-title' }, t('panel.title')),
          h('p', { className: 'dsm-page-count' }, t(count.key, count.params)),
          workspaceFilter === null
            ? null
            : h('div', { className: 'dsm-scope', role: 'group', 'aria-label': t('panel.scope') },
              h('button', {
                type: 'button',
                className: 'dsm-scope-btn' + (scope === 'all' ? ' dsm-scope-on' : ''),
                'aria-pressed': scope === 'all',
                onClick: () => chooseScope('all'),
              }, t('panel.scopeAll')),
              h('button', {
                type: 'button',
                className: 'dsm-scope-btn' + (scope === 'workspace' ? ' dsm-scope-on' : ''),
                'aria-pressed': scope === 'workspace',
                title: workspaceFilter.workspaceTitle,
                onClick: () => chooseScope('workspace'),
              }, t('panel.scopeWorkspace'))),
          notice !== null ? h('p', { className: 'dsm-page-notice', role: 'status' }, notice) : null),
        failure !== null
          ? h('p', { className: 'dsm-error dsm-page-error', role: 'alert' },
            errorText(t, failure),
            ' ',
            h('button', { type: 'button', className: 'dsm-link', onClick: () => { void loadAll() } }, t('panel.retry')))
          : null,
        firstLoad
          ? h('div', { className: 'dsm-loading' },
            h('span', { className: 'dsm-spinner dsm-spinner-dark', 'aria-hidden': 'true' }),
            h('span', null, t('panel.loading')))
          : null,
        empty
          ? h('div', { className: 'dsm-empty' },
            h('span', { className: 'dsm-empty-icon', 'aria-hidden': 'true' }, h(ClockGlyph, { size: 40 })),
            h('p', { className: 'dsm-empty-title' }, t('panel.empty')),
            h('p', { className: 'dsm-empty-hint' }, t('panel.emptyHint')))
          : null,
        firstLoad ? null : groups.map(renderGroup),
        repeatingModel.show
          ? h('section', { className: 'dsm-group dsm-group-repeating' },
            h('div', { className: 'dsm-group-headrow' },
              h('h2', { className: 'dsm-group-head' }, t('panel.repeating') + ' (' + String(repeatingModel.items.length) + ')'),
              h('button', { type: 'button', className: 'dsm-link', onClick: openTasksPanel }, t('panel.openTasks'))),
            h('div', { className: 'dsm-repeating-list' }, repeatingModel.items.map(item => h('div', {
              key: item.id,
              className: 'dsm-repeating-row',
            },
              h('span', { className: 'dsm-repeating-title' }, item.title),
              item.rrule === null ? null : h('span', { className: 'dsm-repeating-rule' }, item.rrule)))))
          : null,
        editing !== null
          ? h(EditorSheet, {
            t,
            zone,
            locale,
            messageId: editing.id,
            opener: editing.opener,
            onNotice: (text) => setNotice(text),
            onClose: closeEditor,
          })
          : null))
  }

  // ---------------------------------------------------------------- editor

  /** One attachment chip: thumbnail or file glyph, name, size, remove. */
  function AttachmentChip(props) {
    const { t, name, bytes, image, src, onRemove } = props
    const label = typeof name === 'string' && name.length > 0 ? name : t('attachments.file', { count: 1 })
    return h('span', { className: 'dsm-attach' },
      image === true && typeof src === 'string'
        ? h('img', { className: 'dsm-attach-thumb', src, alt: '', loading: 'lazy' })
        : h('span', { className: 'dsm-attach-icon', 'aria-hidden': 'true' }, h(FileGlyph)),
      h('span', { className: 'dsm-attach-body' },
        h('span', { className: 'dsm-attach-name', title: label }, label),
        h('span', { className: 'dsm-attach-size' }, formatBytes(bytes))),
      h('button', {
        type: 'button',
        className: 'dsm-attach-remove',
        'aria-label': t('editor.remove'),
        title: t('editor.remove'),
        onClick: onRemove,
      }, h(CloseIcon)))
  }

  /** One in-flight (or failed) upload, with a progress ring. */
  function UploadChip(props) {
    const { t, item, onRemove, onRetry } = props
    const failed = item.state === 'failed'
    return h('span', { className: 'dsm-attach' + (failed ? ' dsm-attach-failed' : '') },
      h('span', {
        className: 'dsm-ring',
        style: { '--dsm-progress': String(Math.round((Number.isFinite(item.progress) ? item.progress : 0) * 100)) },
        'aria-hidden': 'true',
      }),
      h('span', { className: 'dsm-attach-body' },
        h('span', { className: 'dsm-attach-name' }, item.name),
        h('span', { className: 'dsm-attach-size' }, failed ? t('editor.uploadFailed') : t('editor.uploading'))),
      failed ? h('button', { type: 'button', className: 'dsm-link', onClick: onRetry }, t('panel.retry')) : null,
      h('button', {
        type: 'button',
        className: 'dsm-attach-remove',
        'aria-label': t('editor.remove'),
        title: t('editor.remove'),
        onClick: onRemove,
      }, h(CloseIcon)))
  }

  /** Destination popover: search, workspaces as headers, new conversation per workspace. */
  function TargetPicker(props) {
    const { t, targets, error, current, onPick, onClose } = props
    const [query, setQuery] = useState('')
    const searchRef = useRef(null)

    useEffect(() => {
      const node = searchRef.current
      if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
    }, [])

    const groups = filterTargets(targets, query)
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }

    return h('div', {
      className: 'dsm-target-pop',
      role: 'dialog',
      'aria-label': t('editor.sendTo'),
      onKeyDown,
    },
      h('input', {
        ref: searchRef,
        className: 'dsm-input dsm-target-search',
        type: 'search',
        value: query,
        placeholder: t('editor.searchTargets'),
        'aria-label': t('editor.searchTargets'),
        onChange: (event) => setQuery(event.target.value),
      }),
      error !== null && error !== undefined ? h('p', { className: 'dsm-error' }, errorText(t, error)) : null,
      targets === null
        ? h('p', { className: 'dsm-hint' }, t('panel.loading'))
        : groups.length === 0
          ? h('p', { className: 'dsm-hint' }, t('editor.noResults'))
          : null,
      groups.map(group => h('div', { key: String(group.workspace.id ?? group.workspace.path), className: 'dsm-target-group' },
        h('div', { className: 'dsm-target-ws' },
          h('span', { className: 'dsm-target-ws-title' }, String(group.workspace.title ?? group.workspace.path ?? '')),
          h('button', {
            type: 'button',
            className: 'dsm-link',
            onClick: () => {
              const target = newConversationTarget(group.workspace)
              if (target !== null) onPick(target)
            },
          }, t('panel.newConversation'))),
        group.sessions.map(session => h('button', {
          key: session.id,
          type: 'button',
          className: 'dsm-target-row' + (targetKey(current) === 'session:' + String(session.id) ? ' dsm-target-on' : ''),
          onClick: () => onPick({ kind: 'session', sessionId: session.id }),
        },
          h('span', { className: 'dsm-target-row-label' }, String(session.label ?? session.title ?? session.id)),
          session.running === true ? h('span', { className: 'dsm-target-row-meta' }, t('dock.sending')) : null)),
        group.sessions.length === 0 ? h('p', { className: 'dsm-hint' }, t('editor.noSessions')) : null)))
  }

  /**
   * One blocking yes/no for a question with a destructive answer.
   *
   * The inline confirm strips this replaces were grey rows of 11.5 px text links
   * sitting in the middle of ordinary chrome: nothing drew the eye, the footer
   * jumped under the pointer as the row appeared, and a sheet scrolled to the top
   * could push the question out of view entirely. This is a real alertdialog —
   * scrim, warning mark, a title and a filled red answer button — stacked above
   * the sheet, with focus parked on the safe answer so Escape, or a stray Enter,
   * keeps the draft instead of discarding it.
   *
   * @param props - localized translator, title, body, both button labels, whether
   *   the question is mid-flight, and the two callbacks.
   */
  function ConfirmDialog(props) {
    const { t, title, body, confirmLabel, cancelLabel, busy, onConfirm, onCancel } = props
    const titleId = useId()
    const bodyId = useId()
    const panelRef = useRef(null)
    const safeRef = useRef(null)

    useEffect(() => {
      const opener = typeof document === 'undefined' ? null : document.activeElement
      const node = safeRef.current
      if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      return () => {
        // Discard closes the sheet at the same moment, so never pull focus back
        // onto a node that is already out of the document.
        if (opener !== null && opener !== undefined && typeof opener.focus === 'function' && opener.isConnected !== false) opener.focus()
      }
    }, [])

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const node = panelRef.current
      if (node === null || node === undefined) return
      const focusable = [...node.querySelectorAll('button:not([disabled])')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    const hasBody = typeof body === 'string' && body.length > 0
    return ReactDOM.createPortal(
      h('div', {
        className: 'dsm-confirm-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel()
        },
      },
        h('div', {
          className: 'dsm-confirm-dialog',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          'aria-describedby': hasBody ? bodyId : undefined,
          tabIndex: -1,
          ref: panelRef,
          onKeyDown,
        },
          h('span', { className: 'dsm-confirm-mark', 'aria-hidden': 'true' }, h(WarnGlyph)),
          h('h2', { id: titleId, className: 'dsm-confirm-title' }, title),
          hasBody ? h('p', { id: bodyId, className: 'dsm-confirm-body' }, body) : null,
          h('div', { className: 'dsm-confirm-actions' },
            h('button', {
              type: 'button',
              className: 'dsm-btn-ghost',
              ref: safeRef,
              disabled: busy,
              onClick: onCancel,
            }, cancelLabel),
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn-danger',
              disabled: busy,
              onClick: onConfirm,
            }, confirmLabel)))),
      document.body)
  }

  /**
   * The editor: time, message, attachments and destination for one record.
   *
   * It loads the record from `/get` (so a stale list row cannot be saved over a
   * newer edit), sends only changed fields, and keeps the user's text when the
   * Host answers `conflict`.
   */
  function EditorSheet(props) {
    const { t, zone, locale, messageId, opener, onClose, onNotice } = props
    const titleId = useId()
    const panelRef = useRef(null)
    const textRef = useRef(null)
    const dirtyRef = useRef(false)
    const [record, setRecord] = useState(null)
    const [draft, setDraft] = useState(null)
    const [failure, setFailure] = useState(null)
    const [conflict, setConflict] = useState(false)
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [confirmDiscard, setConfirmDiscard] = useState(false)
    const [uploads, setUploads] = useState([])
    const [imageLimitHit, setImageLimitHit] = useState(false)
    const [dropping, setDropping] = useState(false)
    const [targets, setTargets] = useState(targetCache.value)
    const [targetsFailure, setTargetsFailure] = useState(targetCache.error)
    const [pickerOpen, setPickerOpen] = useState(false)

    const targetSessionId = draft !== null && draft.target !== null && draft.target !== undefined && draft.target.kind === 'session'
      ? draft.target.sessionId
      : undefined
    const modelName = useSessionModelName(targetSessionId)

    useEffect(() => {
      let cancelled = false
      requestJson(API + '/get?id=' + encodeURIComponent(messageId), { method: 'GET' }).then((value) => {
        if (cancelled) return
        const loaded = value?.message === undefined ? null : value.message
        setRecord(loaded)
        setDraft(loaded === null ? null : draftOf(loaded, zone))
      }, (error) => {
        if (cancelled) return
        setFailure(error)
      })
      return () => {
        cancelled = true
      }
    }, [messageId, zone])

    useEffect(() => {
      let cancelled = false
      loadTargets().then((value) => {
        if (!cancelled) setTargets(value)
      }, (error) => {
        if (!cancelled) setTargetsFailure(error)
      })
      return () => {
        cancelled = true
      }
    }, [])

    useEffect(() => {
      const node = panelRef.current
      if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      return () => {
        if (opener !== null && opener !== undefined && typeof opener.focus === 'function') opener.focus()
      }
    }, [opener])

    const textValue = draft === null ? '' : draft.text
    useEffect(() => {
      const node = textRef.current
      if (node === null || node === undefined) return
      node.style.height = 'auto'
      const limit = typeof window === 'undefined' ? 320 : Math.round(window.innerHeight * 0.5)
      node.style.height = String(Math.min(node.scrollHeight, limit)) + 'px'
    }, [textValue, draft === null])

    const update = (patch) => setDraft(current => (current === null ? current : { ...current, ...patch }))

    const merged = record !== null && draft !== null
      ? pendingAttachments(record, draft)
      : { images: [], files: [], addedImages: [], addedFiles: [], total: 0 }
    const uploading = uploads.some(item => item.state === 'uploading')
    const changes = record !== null && draft !== null ? buildUpdate(record, draftPayload(draft, zone)) : null
    const dirty = changes !== null || uploads.length > 0
    dirtyRef.current = dirty
    const contentEmpty = draft !== null && draft.text.trim().length === 0 && merged.total === 0
    const busy = saving || deleting
    const resolved = draft === null ? { ok: false } : resolveSelection(draft.selection, zone)
    const dueInstant = resolved.ok === true ? resolved.instantMs : Number.NaN
    const tooSoon = !Number.isFinite(dueInstant) || dueInstant < Date.now() + core.MIN_LEAD_MS
    // A record already past its instant (a failed one, say) stays editable; only
    // a time the user changed has to be at least 30 seconds ahead.
    const dueChanged = record !== null && resolved.ok === true && resolved.iso !== record.dueAt
    const timeBlocked = dueChanged && tooSoon
    const summaryInstant = Number.isFinite(dueInstant) ? dueInstant : Date.parse(record === null ? '' : record.dueAt)
    const peak = core.deepSeekPeakNotice({
      instantMs: Number.isFinite(summaryInstant) ? summaryInstant : null,
      modelName,
      timeZone: zone,
    })
    // An editor that is still loading its record has no instant yet. Formatting
    // one would throw inside the render and blank the whole tab, so the summary
    // line stays empty until a real instant exists.
    const summaryTime = Number.isFinite(summaryInstant) ? summaryInstant : null
    const summary = timeBlocked
      ? t('dialog.pastWarning')
      : summaryTime === null
        ? ''
        : t('dialog.summary', {
          time: core.describeDue(summaryTime, locale, zone),
          zone: core.describeZone(summaryTime, locale, zone),
        })
    const quickPicks = listQuickPicks(t, zone, Date.now())
    const destination = destinationOf(
      { target: draft === null ? null : draft.target, targetLabel: record === null ? undefined : record.targetLabel, sessionId: targetSessionId },
      sessionIndexOf(targets),
    )

    const requestClose = () => {
      if (busy) return
      if (dirtyRef.current) {
        setConfirmDiscard(true)
        return
      }
      onClose()
    }

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (confirmDiscard) {
          setConfirmDiscard(false)
          return
        }
        requestClose()
        return
      }
      if (event.key !== 'Tab') return
      const node = panelRef.current
      if (node === null || node === undefined) return
      const focusable = [...node.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    const startUpload = (file) => {
      const localId = nextLocalId()
      setUploads(current => [...current, {
        localId,
        name: typeof file?.name === 'string' ? file.name : '',
        bytes: Number.isFinite(file?.size) ? file.size : 0,
        progress: 0,
        state: 'uploading',
        file,
      }])
      return uploadFile(file, (fraction) => {
        setUploads(current => current.map(item => item.localId === localId ? { ...item, progress: fraction } : item))
      }).then((value) => {
        setUploads(current => current.filter(item => item.localId !== localId))
        if (typeof value?.fileId === 'string' && value.fileId.length > 0) {
          setDraft(current => current === null ? current : {
            ...current,
            addedFiles: [...current.addedFiles, {
              fileId: value.fileId,
              name: typeof value.name === 'string' ? value.name : '',
              bytes: Number.isFinite(value.bytes) ? value.bytes : 0,
            }],
          })
        }
      }, () => {
        setUploads(current => current.map(item => item.localId === localId ? { ...item, state: 'failed' } : item))
      })
    }

    const acceptFiles = async (fileList) => {
      const files = [...(fileList ?? [])]
      let images = merged.images.length + merged.addedImages.length
      for (const file of files) {
        if (file === null || file === undefined) continue
        const isImage = typeof file.type === 'string' && file.type.startsWith('image/')
        if (!isImage) {
          void startUpload(file)
          continue
        }
        if (images >= core.MAX_IMAGES) {
          setImageLimitHit(true)
          continue
        }
        let dataUrl = null
        try {
          dataUrl = await readAsDataUrl(file)
        } catch {
          dataUrl = null
        }
        if (typeof dataUrl !== 'string') continue
        const comma = dataUrl.indexOf(',')
        if (comma < 0) continue
        images += 1
        setDraft(current => current === null ? current : {
          ...current,
          addedImages: [...current.addedImages, {
            localId: nextLocalId(),
            mediaType: typeof file.type === 'string' && file.type.length > 0 ? file.type : 'image/png',
            data: dataUrl.slice(comma + 1),
            preview: dataUrl,
            name: typeof file.name === 'string' ? file.name : '',
            bytes: Number.isFinite(file.size) ? file.size : 0,
          }],
        })
      }
    }

    const save = () => {
      if (record === null || draft === null || saving || deleting) return
      const payload = buildUpdate(record, draftPayload(draft, zone))
      if (payload === null) {
        onClose()
        return
      }
      setSaving(true)
      setFailure(null)
      postJson(API + '/update', payload).then(() => {
        onNotice(t('editor.saved'))
        onClose()
      }, (error) => {
        if (error?.code === 'conflict') {
          requestJson(API + '/get?id=' + encodeURIComponent(record.id), { method: 'GET' }).then((value) => {
            if (value?.message !== undefined && value.message !== null) setRecord(value.message)
            setConflict(true)
            setSaving(false)
          }, () => {
            setConflict(true)
            setSaving(false)
          })
          return
        }
        if (error?.code === 'not-pending') {
          onNotice(t('editor.notPending'))
          onClose()
          return
        }
        setSaving(false)
        setFailure(error)
      })
    }

    const remove = () => {
      if (record === null || deleting) return
      setDeleting(true)
      postJson(API + '/cancel', { id: record.id }).then(() => {
        clearToast()
        onNotice(t('panel.noticeDeleted'))
        onClose()
      }, (error) => {
        setDeleting(false)
        setFailure(error)
      })
    }

    const removeExisting = (attachmentId) => update({ removeIds: [...(draft === null ? [] : draft.removeIds), attachmentId] })
    const removeAddedImage = (localId) => setDraft(current => current === null ? current : {
      ...current,
      addedImages: current.addedImages.filter(image => image.localId !== localId),
    })
    const removeAddedFile = (fileId) => setDraft(current => current === null ? current : {
      ...current,
      addedFiles: current.addedFiles.filter(file => file.fileId !== fileId),
    })
    const dropUpload = (localId) => setUploads(current => current.filter(item => item.localId !== localId))

    const chipCount = merged.images.length + merged.files.length + merged.addedImages.length + merged.addedFiles.length + uploads.length

    return ReactDOM.createPortal(
      h('div', {
        className: 'dsm-backdrop dsm-sheet-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) requestClose()
        },
      },
        h('div', {
          className: 'dsm-sheet' + (dropping ? ' dsm-sheet-drop' : ''),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          tabIndex: -1,
          ref: panelRef,
          onKeyDown,
          onDragOver: (event) => {
            event.preventDefault()
            setDropping(true)
          },
          onDragLeave: () => setDropping(false),
          onDrop: (event) => {
            event.preventDefault()
            setDropping(false)
            const files = [...(event.dataTransfer?.files ?? [])]
            if (files.length > 0) void acceptFiles(files)
          },
          onPaste: (event) => {
            const files = [...(event.clipboardData?.files ?? [])]
            if (files.length > 0) {
              event.preventDefault()
              void acceptFiles(files)
            }
          },
        },
          h('header', { className: 'dsm-sheet-head' },
            h('h2', { id: titleId, className: 'dsm-sheet-title' }, t('editor.title')),
            h('button', { type: 'button', className: 'dsm-icon-btn', 'aria-label': t('dialog.close'), onClick: requestClose }, h(CloseIcon))),
          failure !== null ? h('p', { className: 'dsm-error', role: 'alert' }, errorText(t, failure)) : null,
          conflict ? h('p', { className: 'dsm-conflict', role: 'alert' }, t('editor.conflict')) : null,
          record === null && failure === null
            ? h('div', { className: 'dsm-loading' },
              h('span', { className: 'dsm-spinner dsm-spinner-dark', 'aria-hidden': 'true' }),
              h('span', null, t('editor.loading')))
            : null,
          record !== null && draft !== null
            ? h(React.Fragment, null,
              h('section', { className: 'dsm-editor-section' },
                h('h3', { className: 'dsm-editor-label' }, t('editor.when')),
                h('div', { className: 'dsm-quick' }, quickPicks.map(pick => h('button', {
                  key: pick.id,
                  type: 'button',
                  className: 'dsm-chip',
                  disabled: busy,
                  onClick: () => update({ selection: pick.selection }),
                }, t(pick.label)))),
                h('div', { className: 'dsm-fields' },
                  h('label', { className: 'dsm-field dsm-field-date' },
                    h('span', { className: 'dsm-label' }, t('dialog.date')),
                    h('input', {
                      className: 'dsm-input',
                      type: 'date',
                      value: draft.selection.date,
                      min: core.localParts(Date.now(), zone).date,
                      disabled: busy,
                      onChange: (event) => {
                        const value = event.target.value
                        if (typeof value === 'string' && value.length === 10) {
                          update({ selection: { ...draft.selection, date: value } })
                        }
                      },
                    })),
                  h('label', { className: 'dsm-field' },
                    h('span', { className: 'dsm-label' }, t('dialog.hour')),
                    h('select', {
                      className: 'dsm-select',
                      value: String(draft.selection.hour12),
                      disabled: busy,
                      onChange: (event) => update({ selection: { ...draft.selection, hour12: Number(event.target.value) } }),
                    }, HOURS.map(hour => h('option', { key: hour, value: String(hour) }, String(hour))))),
                  h('label', { className: 'dsm-field' },
                    h('span', { className: 'dsm-label' }, t('dialog.minute')),
                    h('select', {
                      className: 'dsm-select',
                      value: String(draft.selection.minute),
                      disabled: busy,
                      onChange: (event) => update({ selection: { ...draft.selection, minute: Number(event.target.value) } }),
                    }, MINUTE_STEPS.map(minute => h('option', { key: minute, value: String(minute) }, core.pad2(minute))))),
                  h('div', { className: 'dsm-field dsm-field-meridiem', role: 'group', 'aria-label': t('dialog.meridiem') },
                    ['AM', 'PM'].map(meridiem => h('button', {
                      key: meridiem,
                      type: 'button',
                      className: 'dsm-seg' + (draft.selection.meridiem === meridiem ? ' dsm-seg-on' : ''),
                      'aria-pressed': draft.selection.meridiem === meridiem,
                      disabled: busy,
                      onClick: () => update({ selection: { ...draft.selection, meridiem } }),
                    }, meridiem)))),
                summary.length === 0
                  ? null
                  : h('p', { className: 'dsm-summary' + (timeBlocked ? ' dsm-summary-bad' : ''), role: 'status' }, summary),
                peak === null
                  ? null
                  : h('p', { className: 'dsm-peak' }, h(PeakIcon), h('span', null, t('dialog.peakHint', { windows: peak.windows })))),
              h('section', { className: 'dsm-editor-section' },
                h('h3', { className: 'dsm-editor-label' }, t('editor.message')),
                h('textarea', {
                  ref: textRef,
                  className: 'dsm-textarea',
                  value: draft.text,
                  placeholder: t('editor.messagePlaceholder'),
                  'aria-label': t('editor.message'),
                  disabled: busy,
                  onChange: (event) => update({ text: event.target.value }),
                })),
              h('section', { className: 'dsm-editor-section' },
                h('h3', { className: 'dsm-editor-label' }, t('editor.attachments')),
                chipCount > 0
                  ? h('div', { className: 'dsm-attach-list' },
                    merged.images.map(ref => h(AttachmentChip, {
                      key: 'image-' + String(ref.attachmentId),
                      t,
                      name: typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : t('attachments.image', { count: 1 }),
                      bytes: ref.bytes,
                      image: true,
                      src: thumbUrl(record.id, ref.attachmentId),
                      onRemove: () => removeExisting(ref.attachmentId),
                    })),
                    merged.files.map(ref => h(AttachmentChip, {
                      key: 'file-' + String(ref.attachmentId),
                      t,
                      name: ref.name,
                      bytes: ref.bytes,
                      image: false,
                      onRemove: () => removeExisting(ref.attachmentId),
                    })),
                    merged.addedImages.map(image => h(AttachmentChip, {
                      key: image.localId,
                      t,
                      name: image.name,
                      bytes: image.bytes,
                      image: true,
                      src: image.preview,
                      onRemove: () => removeAddedImage(image.localId),
                    })),
                    merged.addedFiles.map(file => h(AttachmentChip, {
                      key: 'added-' + String(file.fileId),
                      t,
                      name: file.name,
                      bytes: file.bytes,
                      image: false,
                      onRemove: () => removeAddedFile(file.fileId),
                    })),
                    uploads.map(item => h(UploadChip, {
                      key: item.localId,
                      t,
                      item,
                      onRemove: () => dropUpload(item.localId),
                      onRetry: () => {
                        dropUpload(item.localId)
                        void startUpload(item.file)
                      },
                    })))
                  : null,
                h('div', { className: 'dsm-attach-bar' },
                  h('label', { className: 'dsm-btn-ghost dsm-add-files' },
                    h(PaperclipGlyph),
                    h('span', null, t('editor.addFiles')),
                    h('input', {
                      type: 'file',
                      multiple: true,
                      className: 'dsm-file-input',
                      disabled: busy,
                      onChange: (event) => {
                        const files = [...(event.target.files ?? [])]
                        event.target.value = ''
                        if (files.length > 0) void acceptFiles(files)
                      },
                    })),
                  h('span', { className: 'dsm-hint' }, t('editor.dropHint'))),
                imageLimitHit ? h('p', { className: 'dsm-hint dsm-hint-warn' }, t('editor.imageLimit')) : null),
              h('section', { className: 'dsm-editor-section' },
                h('h3', { className: 'dsm-editor-label' }, t('editor.sendTo')),
                h('button', {
                  type: 'button',
                  className: 'dsm-target-btn',
                  disabled: busy,
                  'aria-haspopup': 'dialog',
                  'aria-expanded': pickerOpen,
                  onClick: () => {
                    const next = !pickerOpen
                    setPickerOpen(next)
                    if (next) {
                      loadTargets().then((value) => setTargets(value), (error) => setTargetsFailure(error))
                    }
                  },
                },
                  h('span', { className: 'dsm-target-text' }, destinationText(t, destination)),
                  h(ChevronGlyph)),
                pickerOpen
                  ? h(TargetPicker, {
                    t,
                    targets,
                    error: targetsFailure,
                    current: draft.target,
                    onPick: (target) => {
                      update({ target })
                      setPickerOpen(false)
                    },
                    onClose: () => setPickerOpen(false),
                  })
                  : null),
              confirmDelete
                ? h(ConfirmDialog, {
                  t,
                  title: t('editor.deleteTitle'),
                  body: t('editor.deleteBody'),
                  confirmLabel: t('panel.deleteYes'),
                  cancelLabel: t('panel.deleteKeep'),
                  busy,
                  onConfirm: remove,
                  onCancel: () => setConfirmDelete(false),
                })
                : null,
              confirmDiscard
                ? h(ConfirmDialog, {
                  t,
                  title: t('editor.discard'),
                  body: t('editor.discardBody'),
                  confirmLabel: t('editor.discardYes'),
                  cancelLabel: t('editor.discardNo'),
                  busy: false,
                  onConfirm: onClose,
                  onCancel: () => setConfirmDiscard(false),
                })
                : null,
              h('footer', { className: 'dsm-sheet-foot' },
                h('button', { type: 'button', className: 'dsm-link dsm-link-danger', disabled: busy, onClick: () => setConfirmDelete(true) }, t('editor.delete')),
                h('span', { className: 'dsm-page-spacer' }),
                h('button', { type: 'button', className: 'dsm-btn-ghost', disabled: busy, onClick: requestClose }, t('editor.cancel')),
                h('button', {
                  type: 'button',
                  className: 'dsm-btn dsm-btn-primary dsm-save',
                  disabled: busy || uploading || contentEmpty || timeBlocked,
                  onClick: save,
                },
                  saving ? h('span', { className: 'dsm-spinner', 'aria-hidden': 'true' }) : null,
                  saving ? t('editor.saving') : t('editor.save'))))
            : null)),
      document.body)
  }

  // ---------------------------------------------------------------- styles

  function stylesheet() {
    if (typeof document === 'undefined') return () => undefined
    const existing = document.getElementById(STYLE_ID)
    if (existing !== null) return () => undefined
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }

  const CSS = `
.dsm-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:none;border-radius:999px;
  font:inherit;font-size:12px;font-weight:600;line-height:1;cursor:pointer;white-space:nowrap;
  background:${ORANGE};color:#fff;transition:background .15s ease,opacity .15s ease}
.dsm-btn:hover:not([disabled]){background:${ORANGE_HOVER}}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}
.dsm-btn[disabled]{opacity:.45;cursor:not-allowed}
.dsm-btn-short{display:none}
@media (max-width:380px){.dsm-btn-wide{display:none}.dsm-btn-short{display:inline}}
.dsm-btn-ghost{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#d4d4d8);
  background:transparent;color:var(--dsw-alias-label-primary,#18181b);font:inherit;font-size:13px;cursor:pointer}
.dsm-btn-ghost:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2,#f4f4f5)}
.dsm-btn-primary{height:32px;padding:0 14px;font-size:13px;border-radius:8px}
.dsm-btn-danger{background:var(--dsw-alias-state-error-primary,#dc2626)}
.dsm-btn-danger:hover:not([disabled]){background:var(--dsw-alias-state-error-primary,#dc2626);filter:brightness(.9)}
.dsm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-secondary,#52525b);cursor:pointer}
.dsm-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,#f4f4f5)}

.dsm-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(9,9,11,.45);padding:16px}
.dsm-dialog{width:min(420px,100%);max-height:calc(100vh - 32px);overflow:auto;display:flex;flex-direction:column;gap:12px;
  padding:16px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,#e4e4e7);
  background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#18181b);
  box-shadow:0 24px 64px rgba(9,9,11,.28);font-size:13px}
.dsm-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsm-dialog-title{margin:0;font-size:15px;font-weight:650}
.dsm-preview{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,#fafafa);border:1px solid var(--dsw-alias-border-l1,#f0f0f1)}
.dsm-preview-text{margin:0;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,#18181b);
  white-space:pre-wrap;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsm-preview-meta{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-quick{display:flex;flex-wrap:wrap;gap:6px}
.dsm-chip{height:26px;padding:0 10px;border-radius:999px;cursor:pointer;font:inherit;font-size:11.5px;
  border:1px solid var(--dsw-alias-border-l1,#e4e4e7);background:var(--dsw-alias-bg-layer-2,#f4f4f5);
  color:var(--dsw-alias-label-primary,#18181b)}
.dsm-chip:hover:not([disabled]){border-color:${ORANGE};color:${ORANGE_HOVER}}
.dsm-fields{display:grid;grid-template-columns:1.6fr .8fr .8fr auto;gap:8px;align-items:end}
.dsm-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsm-field-meridiem{flex-direction:row;align-items:center;gap:4px}
.dsm-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-input,.dsm-select{height:34px;min-width:0;padding:0 8px;border-radius:8px;font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-border-l1,#e4e4e7);background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-primary,#18181b)}
.dsm-input:focus-visible,.dsm-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}
.dsm-seg{height:34px;min-width:38px;padding:0 8px;border-radius:8px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1,#e4e4e7);background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-seg-on{border-color:${ORANGE};color:#fff;background:${ORANGE}}
.dsm-summary{margin:0;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary,#52525b)}
.dsm-summary-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsm-peak{display:flex;align-items:flex-start;gap:6px;margin:0;padding:7px 9px;border-radius:8px;
  font-size:12px;line-height:1.45;color:#C2410C;background:rgba(249,115,22,.10);
  border:1px solid rgba(249,115,22,.32)}
.dsm-peak svg{flex:none;margin-top:1px}
@media (prefers-color-scheme:dark){
.dsm-peak{color:#FDBA74;background:rgba(249,115,22,.16);border-color:rgba(253,186,116,.34)}
}
.dsm-repeat{display:flex;flex-direction:column;gap:8px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1,#f0f0f1)}
.dsm-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;min-height:32px}
.dsm-check-off{opacity:.55;cursor:not-allowed}
.dsm-repeat-body{display:flex;flex-direction:column;gap:6px}
.dsm-hint{margin:0;font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-hint-warn{color:var(--dsw-alias-state-warn-primary,#b45309)}
.dsm-error{margin:0;font-size:12px;line-height:1.45;color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsm-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
.dsm-spinner{width:12px;height:12px;margin-right:6px;border-radius:50%;border:2px solid rgba(255,255,255,.45);
  border-top-color:#fff;animation:dsm-spin .7s linear infinite}
@keyframes dsm-spin{to{transform:rotate(360deg)}}

.dsm-dock{display:flex;flex-direction:column;gap:4px;margin:0 0 6px;font-size:12px}
.dsm-toast{margin:0 0 2px;padding:6px 10px;border-radius:8px;font-size:12px;
  background:var(--dsw-alias-bg-layer-2,#f4f4f5);color:var(--dsw-alias-label-primary,#18181b);
  border:1px solid var(--dsw-alias-border-l1,#e4e4e7)}
.dsm-dock-head{display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:2px 8px;border-radius:8px;
  border:1px dashed var(--dsw-alias-border-l1,#e4e4e7);background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#52525b);font:inherit;font-size:11.5px;text-align:left}
.dsm-dock-head:hover{background:var(--dsw-alias-bg-layer-1,#fafafa)}
.dsm-dock-caret{margin-left:auto;opacity:.7}
.dsm-dock-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dsm-dock-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:5px 8px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-1,#fafafa);border:1px solid var(--dsw-alias-border-l1,#f0f0f1)}
.dsm-dock-row-failed{border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsm-dock-row-sent{opacity:.6}
.dsm-dock-text{flex:1 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-primary,#18181b)}
.dsm-dock-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#71717a);font-size:11px}
.dsm-dock-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-dock-tick{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dsm-dock-error-text{flex:1 1 100%;margin:0;font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsm-dock-actions{display:flex;gap:6px;margin-left:auto}
.dsm-dock-error{margin:2px 0 0}
.dsm-link{height:22px;padding:0 4px;border:none;background:transparent;cursor:pointer;font:inherit;font-size:11.5px;
  color:var(--dsw-alias-brand-primary,#2563eb);border-radius:4px}
.dsm-link:hover:not([disabled]){text-decoration:underline}
.dsm-link-danger{color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsm-link[disabled]{opacity:.5;cursor:not-allowed}

@media (max-width:640px){
  .dsm-backdrop{align-items:flex-end;padding:0}
  .dsm-dialog{width:100%;max-height:88vh;border-radius:18px 18px 0 0;border-bottom:none;
    padding:16px 16px max(16px,env(safe-area-inset-bottom)) 16px;
    animation:dsm-rise .18s ease-out}
  .dsm-fields{grid-template-columns:1fr 1fr;gap:10px}
  .dsm-field-date{grid-column:1 / -1}
  .dsm-field-meridiem{grid-column:1 / -1;justify-content:flex-start}
  .dsm-btn,.dsm-btn-ghost,.dsm-btn-primary,.dsm-chip,.dsm-link{min-height:44px}
  .dsm-input,.dsm-select,.dsm-seg{height:44px;font-size:16px}
  .dsm-dialog{gap:14px}
  .dsm-confirm-backdrop{padding:0 12px}
  .dsm-confirm-dialog{width:100%;padding:18px}
  .dsm-confirm-actions .dsm-btn,.dsm-confirm-actions .dsm-btn-ghost{flex:1 1 auto;justify-content:center}
}
@keyframes dsm-rise{from{transform:translateY(12px);opacity:.6}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){
  .dsm-dialog{animation:none}
  .dsm-btn{transition:none}
  .dsm-spinner{animation-duration:2s}
}

/* ---------------------------------------------------------------- scheduled tab */
.dsm-page{box-sizing:border-box;height:100%;min-height:100%;overflow-y:auto;
  padding-top:var(--dsh-frame-top-clearance,0px);padding-left:var(--dsh-frame-leading-clearance,0px);
  background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#18181b)}
.dsm-page-inner{max-width:720px;margin:0 auto;padding:20px 24px 48px;display:flex;flex-direction:column;gap:18px}
@media (max-width:640px){.dsm-page-inner{padding:16px 16px 40px}}
.dsm-page-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dsm-page-title{margin:0;font-size:20px;font-weight:600;line-height:1.2}
.dsm-page-count{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-page-spacer{flex:1 1 auto}
.dsm-page-notice{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#52525b);
  background:var(--dsw-alias-bg-layer-2,#f4f4f5);border:1px solid var(--dsw-alias-border-l1,#e4e4e7);
  border-radius:8px;padding:5px 10px}
.dsm-group{display:flex;flex-direction:column;gap:8px}
.dsm-group-head{margin:0;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-group-toggle{display:inline-flex;align-items:center;gap:6px;padding:2px 0;border:none;background:transparent;
  cursor:pointer;font:inherit;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dsw-alias-label-secondary,#71717a);text-align:left}
.dsm-group-caret{font-size:10px}
.dsm-group-headrow{display:flex;align-items:center;gap:8px}
.dsm-group-headrow .dsm-link{margin-left:auto;font-size:11px}
.dsm-scope{display:inline-flex;gap:2px;margin-left:auto;padding:2px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-2,#f4f4f5);border:1px solid var(--dsw-alias-border-l1,#e4e4e7)}
.dsm-scope-btn{height:24px;padding:0 10px;border:none;border-radius:999px;background:transparent;cursor:pointer;
  font:inherit;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-scope-btn:hover{color:var(--dsw-alias-label-primary,#18181b)}
.dsm-scope-on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#18181b)}
.dsm-repeating-list{display:flex;flex-direction:column;gap:6px}
.dsm-repeating-row{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-radius:10px;opacity:.72;
  border:1px dashed var(--dsw-alias-border-l1,#e4e4e7)}
.dsm-repeating-title{font-size:12.5px;color:var(--dsw-alias-label-primary,#18181b);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-repeating-rule{font-size:11px;color:var(--dsw-alias-label-secondary,#71717a);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (pointer:coarse){.dsm-scope-btn{min-height:32px;padding:0 12px}}
.dsm-cards{display:flex;flex-direction:column;gap:8px}
.dsm-card{position:relative;display:flex;gap:14px;align-items:flex-start;padding:12px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1,#e4e4e7);background:var(--dsw-alias-bg-layer-1,#fafafa);
  cursor:pointer;transition:background .12s ease}
.dsm-card:hover{background:var(--dsw-alias-bg-layer-2,#f4f4f5)}
.dsm-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}
.dsm-card-failed{border-left:3px solid var(--dsw-alias-state-error-primary,#dc2626);padding-left:12px}
.dsm-card-sent{opacity:.62;cursor:default;background:transparent;border-color:var(--dsw-alias-border-l1,#f0f0f1)}
.dsm-card-sent:hover{background:transparent}
.dsm-card-time{flex:none;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;padding-top:1px;
  color:var(--dsw-alias-label-primary,#18181b);white-space:nowrap}
.dsm-card-body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}
.dsm-card-text{margin:0;font-size:13.5px;line-height:1.4;color:var(--dsw-alias-label-primary,#18181b);
  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.dsm-card-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-card-target{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dsm-card-attach{display:inline-flex;align-items:center;gap:4px}
.dsm-card-reason{margin:0;font-size:11.5px;line-height:1.4;color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsm-card-late{color:var(--dsw-alias-state-warn-primary,#b45309)}
.dsm-card-actions{display:flex;gap:2px;align-items:center;flex:none;opacity:0;transition:opacity .12s ease}
.dsm-card:hover .dsm-card-actions,.dsm-card:focus .dsm-card-actions,.dsm-card:focus-within .dsm-card-actions{opacity:1}
.dsm-action{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;min-width:28px;
  padding:0 6px;border:none;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary,#52525b);cursor:pointer;font:inherit;font-size:11.5px}
.dsm-action:hover:not([disabled]){background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#18181b)}
.dsm-action-danger{color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsm-action-question{color:var(--dsw-alias-label-secondary,#52525b);cursor:default}
.dsm-action[disabled]{opacity:.45;cursor:not-allowed}
.dsm-action-text{display:none}
@media (hover:none){.dsm-card-actions{opacity:1}.dsm-action-text{display:inline}}
@media (pointer:coarse){.dsm-action{min-width:44px;height:44px}}
.dsm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:56px 16px;text-align:center}
.dsm-empty-icon{color:var(--dsw-alias-label-tertiary,#a1a1aa)}
.dsm-empty-title{margin:0;font-size:14px;font-weight:600}
.dsm-empty-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#71717a);max-width:340px;line-height:1.5}
.dsm-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:40px 0;font-size:12.5px;
  color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-spinner-dark{width:14px;height:14px;margin:0;border-color:var(--dsw-alias-border-l1,#e4e4e7);
  border-top-color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-page-error{margin:0}

.dsm-panel-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;line-height:0}
.dsm-panel-badge{position:absolute;top:-5px;right:-7px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;
  font-size:9.5px;font-weight:700;line-height:14px;text-align:center;
  background:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-label-inverse,#fff)}
.dsm-dock-bar{display:flex;align-items:center;gap:8px}
.dsm-dock-all{margin-left:auto;font-size:11px}

/* ---------------------------------------------------------------- editor sheet */
.dsm-sheet-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(9,9,11,.42);padding:16px}
.dsm-sheet{display:flex;flex-direction:column;gap:14px;width:min(560px,100%);max-height:calc(100vh - 32px);
  overflow:auto;padding:18px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,#e4e4e7);
  background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#18181b);font-size:13px}
.dsm-sheet-drop{border-color:var(--dsw-alias-brand-primary,#3b82f6);border-style:dashed}
@media (min-width:900px){
  .dsm-sheet-backdrop{background:transparent;justify-content:flex-end;align-items:stretch;padding:0}
  .dsm-sheet{width:420px;max-height:none;height:100%;border-radius:0;border:none;
    border-left:1px solid var(--dsw-alias-border-l1,#e4e4e7);
    padding-bottom:max(18px,env(safe-area-inset-bottom))}
}
@media (max-width:639px){
  .dsm-sheet-backdrop{align-items:flex-end;padding:0}
  .dsm-sheet{width:100%;max-height:92vh;border-radius:18px 18px 0 0;border-bottom:none;
    padding:16px 16px max(16px,env(safe-area-inset-bottom)) 16px;animation:dsm-rise .18s ease-out}
}
.dsm-sheet-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsm-sheet-title{margin:0;font-size:15px;font-weight:650}
.dsm-editor-section{display:flex;flex-direction:column;gap:8px}
.dsm-editor-label{margin:0;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-textarea{width:100%;box-sizing:border-box;min-height:96px;max-height:50vh;padding:10px;border-radius:10px;
  resize:none;font:inherit;font-size:13px;line-height:1.45;overflow-y:auto;
  border:1px solid var(--dsw-alias-border-l1,#e4e4e7);background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-primary,#18181b)}
.dsm-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}
.dsm-attach-list{display:flex;flex-wrap:wrap;gap:8px}
.dsm-attach{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:6px 8px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1,#e4e4e7);background:var(--dsw-alias-bg-layer-1,#fafafa)}
.dsm-attach-failed{border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsm-attach-thumb{width:40px;height:40px;border-radius:6px;object-fit:cover;background:var(--dsw-alias-bg-layer-2,#f4f4f5)}
.dsm-attach-icon{display:inline-flex;width:40px;height:40px;align-items:center;justify-content:center;
  border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f4f4f5);color:var(--dsw-alias-label-secondary,#52525b)}
.dsm-attach-body{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsm-attach-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.dsm-attach-size{font-size:11px;color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-attach-remove{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;
  border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#71717a);cursor:pointer}
.dsm-attach-remove:hover{background:var(--dsw-alias-bg-layer-2,#f4f4f5)}
.dsm-ring{width:18px;height:18px;border-radius:50%;flex:none;
  background:conic-gradient(var(--dsw-alias-brand-primary,#3b82f6) calc(var(--dsm-progress,0) * 1%),
  var(--dsw-alias-bg-layer-2,#e4e4e7) 0)}
.dsm-ring::after{content:'';display:block;width:8px;height:8px;margin:5px;border-radius:50%;
  background:var(--dsw-alias-bg-layer-1,#fafafa)}
.dsm-attach-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsm-file-input{display:none}
.dsm-add-files{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.dsm-target-btn{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:0 10px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1,#e4e4e7);background:var(--dsw-alias-bg-base,#fff);cursor:pointer;
  font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary,#18181b);text-align:left}
.dsm-target-btn:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2,#f4f4f5)}
.dsm-target-text{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-target-pop{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto;padding:10px;
  border-radius:12px;border:1px solid var(--dsw-alias-border-l1,#e4e4e7);background:var(--dsw-alias-bg-layer-1,#fafafa)}
.dsm-target-search{height:30px;font-size:12.5px}
.dsm-target-group{display:flex;flex-direction:column;gap:2px;padding-top:6px;
  border-top:1px solid var(--dsw-alias-border-l1,#f0f0f1)}
.dsm-target-ws{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsm-target-ws-title{font-size:11.5px;font-weight:650;color:var(--dsw-alias-label-secondary,#52525b);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-target-row{display:flex;align-items:center;gap:8px;min-height:30px;padding:2px 6px;border:none;border-radius:6px;
  background:transparent;cursor:pointer;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary,#18181b);text-align:left}
.dsm-target-row:hover{background:var(--dsw-alias-bg-layer-2,#f4f4f5)}
.dsm-target-on{background:var(--dsw-alias-bg-layer-2,#f4f4f5);font-weight:600}
.dsm-target-row-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-target-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#71717a)}
.dsm-sheet-foot{display:flex;align-items:center;gap:8px;padding-top:6px;
  border-top:1px solid var(--dsw-alias-border-l1,#f0f0f1)}
.dsm-save{min-width:80px;justify-content:center}
.dsm-confirm-backdrop{position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;
  background:rgba(9,9,11,.55);padding:16px;animation:dsm-fade .12s ease-out}
.dsm-confirm-dialog{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:min(360px,100%);
  box-sizing:border-box;padding:20px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,#e4e4e7);
  background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#18181b);
  box-shadow:0 28px 72px rgba(9,9,11,.34);font-size:13px;animation:dsm-pop .14s ease-out}
.dsm-confirm-mark{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;
  background:rgba(220,38,38,.1);color:var(--dsw-alias-state-error-primary,#dc2626);
  box-shadow:inset 0 0 0 1px rgba(220,38,38,.22)}
.dsm-confirm-title{margin:4px 0 0;font-size:16px;font-weight:650;line-height:1.3}
.dsm-confirm-body{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#52525b)}
.dsm-confirm-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;width:100%;margin-top:12px}
.dsm-confirm-actions .dsm-btn{min-width:88px;justify-content:center}
@keyframes dsm-fade{from{opacity:0}to{opacity:1}}
@keyframes dsm-pop{from{transform:translateY(6px) scale(.98);opacity:0}to{transform:none;opacity:1}}
.dsm-conflict{margin:0;padding:8px 10px;border-radius:10px;font-size:12px;line-height:1.45;
  color:var(--dsw-alias-state-warn-primary,#b45309);background:var(--dsw-alias-bg-layer-2,#f4f4f5);
  border:1px solid var(--dsw-alias-state-warn-primary,#b45309)}
@media (pointer:coarse){
  .dsm-textarea,.dsm-input,.dsm-select,.dsm-target-btn{font-size:16px}
  .dsm-target-btn{min-height:44px}
  .dsm-attach-remove,.dsm-sheet-head .dsm-icon-btn{min-width:44px;height:44px}
  .dsm-sheet-foot .dsm-btn,.dsm-sheet-foot .dsm-btn-ghost,.dsm-add-files{min-height:44px}
}
@media (prefers-reduced-motion:reduce){
  .dsm-card{transition:none}
  .dsm-sheet{animation:none}
  .dsm-confirm-dialog,.dsm-confirm-backdrop{animation:none}
  .dsm-action{transition:none}
}
`

  // ---------------------------------------------------------------- apply

  /**
   * Register the button, the strip, the shortcut and both dictionaries.
   * @param ctx - browser plugin context.
   */
  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-scheduled-message: dictionaries')
    const t = ctx.locale.bind(NS)
    // Pages and the sidebar entry are mounted by the platform, not by a
    // localized seat, so they fall back to this translator when props carry none.
    translate = t
    ctx.effect(() => stylesheet(), 'dsh-scheduled-message: styles')

    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right',
      id: 'dsm-schedule',
      order: 900,
      locale: NS,
      inject: sessionId => ({ dsmSessionId: sessionId }),
    }, ScheduleButton))

    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'dsm-scheduled',
      order: 30,
      locale: NS,
      inject: sessionId => ({ dsmSessionId: sessionId }),
    }, ScheduleDock))

    // A sidebar tab is two registrations sharing one id: the keyed page and the
    // panel-list entry, exactly like DSH's own Automation tasks page.
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
    }, ScheduledPage))

    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 11,
      locale: NS,
      label: () => t('panel.label'),
    }, ScheduledIcon))

    // Optional services: each scope runs only when the profile provides it.
    ctx.inject(['sessions'], (scope) => {
      services.sessions = scope.sessions
      return () => {
        services.sessions = undefined
      }
    })

    ctx.inject(['layout'], (scope) => {
      services.layout = scope.layout
      return () => {
        services.layout = undefined
      }
    })

    // The composer's model seat and the /model popup share one directory; the
    // dialog reads that same selection to know whether the DeepSeek price clock
    // applies. A profile without it simply never shows the notice.
    ctx.inject(['modelDirectories'], (scope) => {
      services.modelDirectories = scope.modelDirectories
      return () => {
        services.modelDirectories = undefined
      }
    })

    ctx.inject(['shortcuts'], (scope) => {
      scope.effect(() => scope.shortcuts.register({
        id: SHORTCUT_ID,
        label: () => t('shortcut.label'),
        aliases: ['schedule', 'later', 'deliver'],
        defaults: Object.fromEntries(SHORTCUT_PROFILES.map(profile => [profile, { code: 'Enter', modifiers: ['alt'] }])),
        regions: ['editable'],
        modals: [],
        resolve(context) {
          if (context.region !== 'editable') return { status: 'pass' }
          const composer = pickComposer()
          if (composer === null) return { status: 'blocked', reason: t('notice.noComposer') }
          if (composer.phase !== 'plain') return { status: 'blocked', reason: t('notice.busy') }
          if (composer.draft.trim().length === 0 && composer.attachments === 0) {
            return { status: 'blocked', reason: t('notice.typeFirst') }
          }
          return {
            status: 'handled',
            run() {
              preferComposer(composer.sessionId)
              composer.open()
            },
          }
        },
      }), 'dsh-scheduled-message: schedule shortcut')
    })
  }

  return {
    name: NS,
    inject: ['slots', 'locale'],
    apply,
    /**
     * Pure decisions and shared constants the hermetic client tests assert on.
     * Not part of the plugin protocol; the platform ignores unknown properties.
     */
    __internals: {
      panelId: PANEL_ID,
      EditorSheet,
      ConfirmDialog,
      openPanel,
      openTasksPanel,
      panelIcon,
      countText,
      formatBytes,
      clockOf,
      cardModel,
      groupHeading,
      headingText,
      buildGroups,
      buildUpdate,
      draftOf,
      draftPayload,
      pendingAttachments,
      filterTargets,
      sortSessions,
      destinationOf,
      destinationText,
      newConversationTarget,
      targetKey,
      sameTarget,
      resolveWorkspaceFilter,
      repeatingView,
      listAllUrl,
      rememberOpenSession,
      openSessionId: () => lastOpenSessionId,
      sessionIndexOf,
      errorKeys: ERROR_KEYS,
      setToast,
      clearToast,
      toastFor,
    },
  }
}


    return createClientPlugin(require)
  },
})
