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

/** A delivery later than this after its due instant is reported as sent late. */
export const LATE_THRESHOLD_MS = 60_000

/** Finished records older than this are pruned. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

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

/**
 * Format one due instant for the summary line and the strip.
 * @param instantMs - the instant to render.
 * @param locale - BCP 47 locale tag.
 * @param timeZone - explicit zone used for display.
 * @returns text such as `Fri, 14 Nov, 9:00 am`; a formatter failure falls back to ISO.
 */
export function describeDue(instantMs, locale, timeZone) {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(instantMs))
  } catch {
    return new Date(instantMs).toISOString()
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
