/**
 * Unit tests for the shared core: clock conversion, zone resolution, the
 * create-request validator, RRULE text, timer chunking, retention and the
 * title summary.
 *
 * @module dsh-scheduled-message/test/core.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOMAIN_NAME,
  LATE_THRESHOLD_MS,
  MAX_PENDING,
  MAX_TEXT_CHARS,
  MAX_TIMER_DELAY_MS,
  MAX_TITLE_CHARS,
  MIN_LEAD_MS,
  RETENTION_MS,
  buildRrule,
  deepSeekPeakNotice,
  describeDue,
  describePeakWindows,
  earliestPending,
  isDeepSeekModel,
  isDeepSeekPeak,
  isLate,
  isValidTimeZone,
  localParts,
  pad2,
  parseLocalDate,
  pendingSummary,
  pruneTargets,
  skipsShortMonths,
  summariseTitle,
  timerDelay,
  to24Hour,
  toMeridiem,
  validateCreateRequest,
  wallClockToInstant,
  zoneOffsetMs,
} from '../lib/core.js'

const HONG_KONG = 'Asia/Hong_Kong'
const NEW_YORK = 'America/New_York'

test('DeepSeek peak windows follow the published UTC weekday rule', () => {
  // Monday 2026-11-16: 01:00-04:00 and 06:00-10:00 UTC are peak.
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 10, 16, 0, 30)), false)
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 10, 16, 1, 0)), true)
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 10, 16, 3, 59)), true)
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 10, 16, 4, 0)), false)
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 10, 16, 7, 30)), true)
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 10, 16, 10, 0)), false)
  // Saturday and Sunday are off-peak all day.
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 10, 21, 2, 0)), false)
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 10, 22, 7, 30)), false)
  assert.equal(isDeepSeekPeak(null), false)
})

test('the peak notice only speaks for DeepSeek models', () => {
  assert.equal(isDeepSeekModel('deepseek-v4.1-flash'), true)
  assert.equal(isDeepSeekModel('DeepSeek-V4-Pro'), true)
  assert.equal(isDeepSeekModel('claude-sonnet-4'), false)
  assert.equal(isDeepSeekModel(''), false)
  assert.equal(isDeepSeekModel(undefined), false)
})

test('the peak notice names both windows in the reader zone', () => {
  const mondayPeak = Date.UTC(2026, 10, 16, 2, 0)
  assert.deepEqual(
    deepSeekPeakNotice({ instantMs: mondayPeak, modelName: 'deepseek-v4.1-flash', timeZone: HONG_KONG }),
    { windows: '09:00–12:00 / 14:00–18:00' },
  )
  // A non-DeepSeek model, an off-peak instant and an unresolved time stay silent.
  assert.equal(deepSeekPeakNotice({ instantMs: mondayPeak, modelName: 'claude-sonnet-4', timeZone: HONG_KONG }), null)
  assert.equal(deepSeekPeakNotice({ instantMs: Date.UTC(2026, 10, 16, 12, 0), modelName: 'deepseek-v4.1-flash', timeZone: HONG_KONG }), null)
  assert.equal(deepSeekPeakNotice({ instantMs: null, modelName: 'deepseek-v4.1-flash', timeZone: HONG_KONG }), null)
  assert.equal(deepSeekPeakNotice({}), null)
})

test('peak windows render in the reader zone, crossing dates when needed', () => {
  // 01:00-04:00 UTC is 20:00-23:00 the previous evening in New York in November.
  assert.equal(describePeakWindows(Date.UTC(2026, 10, 16, 2, 0), NEW_YORK), '20:00–23:00 / 01:00–05:00')
  // An unknown zone falls back to UTC instead of throwing.
  assert.equal(describePeakWindows(Date.UTC(2026, 10, 16, 2, 0), 'Not/AZone'), '01:00–04:00 / 06:00–10:00')
})

test('the 12-hour clock keeps 12 AM at midnight and 12 PM at noon', () => {
  assert.deepEqual(toMeridiem(0), { hour12: 12, meridiem: 'AM' })
  assert.deepEqual(toMeridiem(1), { hour12: 1, meridiem: 'AM' })
  assert.deepEqual(toMeridiem(11), { hour12: 11, meridiem: 'AM' })
  assert.deepEqual(toMeridiem(12), { hour12: 12, meridiem: 'PM' })
  assert.deepEqual(toMeridiem(13), { hour12: 1, meridiem: 'PM' })
  assert.deepEqual(toMeridiem(23), { hour12: 11, meridiem: 'PM' })
})

test('the picker face converts back to the 24-hour clock', () => {
  assert.equal(to24Hour(12, 'AM'), 0)
  assert.equal(to24Hour(12, 'PM'), 12)
  assert.equal(to24Hour(1, 'AM'), 1)
  assert.equal(to24Hour(1, 'PM'), 13)
  assert.equal(to24Hour(11, 'PM'), 23)
  for (let hour24 = 0; hour24 < 24; hour24 += 1) {
    const face = toMeridiem(hour24)
    assert.equal(to24Hour(face.hour12, face.meridiem), hour24, `round trip at ${hour24}`)
  }
  assert.throws(() => to24Hour(0, 'AM'), RangeError)
  assert.throws(() => to24Hour(13, 'AM'), RangeError)
  assert.throws(() => to24Hour(3, 'XM'), RangeError)
  assert.throws(() => toMeridiem(24), RangeError)
})

test('pad2 formats one clock field', () => {
  assert.equal(pad2(0), '00')
  assert.equal(pad2(9), '09')
  assert.equal(pad2(59), '59')
})

test('a wall clock resolves to the right absolute instant in a fixed zone', () => {
  const hongKong = wallClockToInstant({ date: '2026-11-14', hour24: 9, minute: 0 }, HONG_KONG)
  assert.equal(hongKong.ok, true)
  assert.equal(hongKong.iso, '2026-11-14T01:00:00.000Z', 'Hong Kong is UTC+8 all year')

  const newYorkSummer = wallClockToInstant({ date: '2026-07-04', hour24: 9, minute: 0 }, NEW_YORK)
  assert.equal(newYorkSummer.ok, true)
  assert.deepEqual(localParts(newYorkSummer.instantMs, NEW_YORK).hour24, 9)
  assert.equal(zoneOffsetMs(newYorkSummer.instantMs, NEW_YORK), -4 * 3_600_000, 'July is daylight time')

  const utc = wallClockToInstant({ date: '2026-01-01', hour24: 0, minute: 0 }, 'UTC')
  assert.equal(utc.iso, '2026-01-01T00:00:00.000Z')
})

test('every resolved instant reads back as the wall clock it came from', () => {
  for (const zone of [HONG_KONG, NEW_YORK, 'Europe/Berlin', 'Australia/Adelaide', 'UTC']) {
    for (const date of ['2026-01-15', '2026-06-15', '2026-11-14']) {
      for (const hour24 of [0, 3, 12, 23]) {
        const resolved = wallClockToInstant({ date, hour24, minute: 45 }, zone)
        assert.equal(resolved.ok, true, `${zone} ${date} ${hour24}:45 should resolve`)
        const parts = localParts(resolved.instantMs, zone)
        assert.equal(parts.date, date, `${zone} date`)
        assert.equal(parts.hour24, hour24, `${zone} hour`)
        assert.equal(parts.minute, 45, `${zone} minute`)
      }
    }
  }
})

test('a daylight-saving gap is refused instead of being shifted', () => {
  const gap = wallClockToInstant({ date: '2026-03-08', hour24: 2, minute: 30 }, NEW_YORK)
  assert.equal(gap.ok, false)
  assert.equal(gap.reason, 'nonexistent-local-time')
})

test('a repeated wall clock still resolves to one real instant', () => {
  const ambiguous = wallClockToInstant({ date: '2026-11-01', hour24: 1, minute: 30 }, NEW_YORK)
  assert.equal(ambiguous.ok, true)
  const parts = localParts(ambiguous.instantMs, NEW_YORK)
  assert.equal(parts.hour24, 1)
  assert.equal(parts.minute, 30)
  const offsets = zoneOffsetMs(ambiguous.instantMs - 3_600_000, NEW_YORK)
  assert.ok(offsets === -4 * 3_600_000 || offsets === -5 * 3_600_000)
})

test('malformed dates and times are refused', () => {
  assert.equal(parseLocalDate('2026-02-30'), null)
  assert.equal(parseLocalDate('2026-2-3'), null)
  assert.equal(parseLocalDate('not-a-date'), null)
  assert.deepEqual(parseLocalDate('2026-02-28'), { year: 2026, month: 2, day: 28 })
  assert.equal(wallClockToInstant({ date: '2026-02-30', hour24: 9, minute: 0 }, UTC_ZONE).ok, false)
  assert.equal(wallClockToInstant({ date: '2026-01-01', hour24: 24, minute: 0 }, UTC_ZONE).ok, false)
  assert.equal(wallClockToInstant({ date: '2026-01-01', hour24: 9, minute: 60 }, UTC_ZONE).ok, false)
  assert.equal(wallClockToInstant({ date: '2026-01-01', hour24: 9, minute: 0 }, 'Mars/Olympus').reason, 'invalid-time-zone')
})

const UTC_ZONE = 'UTC'

test('only real IANA names are accepted as zones', () => {
  assert.equal(isValidTimeZone('UTC'), true)
  assert.equal(isValidTimeZone(HONG_KONG), true)
  assert.equal(isValidTimeZone('Asia/Nowhere'), false)
  assert.equal(isValidTimeZone(''), false)
  assert.equal(isValidTimeZone(undefined), false)
})

test('RRULE text pins the zone with DTSTART and projects the cadence', () => {
  const start = wallClockToInstant({ date: '2026-11-14', hour24: 9, minute: 0 }, HONG_KONG)
  assert.equal(start.ok, true)

  assert.equal(
    buildRrule({ repeat: 'daily', instantMs: start.instantMs, timeZone: HONG_KONG }),
    'DTSTART;TZID=Asia/Hong_Kong:20261114T090000\nRRULE:FREQ=DAILY',
  )
  assert.equal(
    buildRrule({ repeat: 'weekdays', instantMs: start.instantMs, timeZone: HONG_KONG }),
    'DTSTART;TZID=Asia/Hong_Kong:20261114T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;WKST=MO',
  )
  assert.equal(
    buildRrule({ repeat: 'weekly', instantMs: start.instantMs, timeZone: HONG_KONG }),
    'DTSTART;TZID=Asia/Hong_Kong:20261114T090000\nRRULE:FREQ=WEEKLY;BYDAY=SA;WKST=MO',
    '2026-11-14 is a Saturday',
  )
  assert.equal(
    buildRrule({ repeat: 'monthly', instantMs: start.instantMs, timeZone: HONG_KONG }),
    'DTSTART;TZID=Asia/Hong_Kong:20261114T090000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=14',
  )

  const monthEnd = wallClockToInstant({ date: '2026-01-31', hour24: 7, minute: 5 }, HONG_KONG)
  assert.match(
    buildRrule({ repeat: 'monthly', instantMs: monthEnd.instantMs, timeZone: HONG_KONG }),
    /BYMONTHDAY=31$/,
  )
  assert.equal(skipsShortMonths(31), true)
  assert.equal(skipsShortMonths(29), true)
  assert.equal(skipsShortMonths(28), false)
  assert.throws(() => buildRrule({ repeat: 'hourly', instantMs: 0, timeZone: HONG_KONG }), RangeError)
})

test('the title summary is one trimmed line of at most 120 characters', () => {
  assert.equal(summariseTitle('  hello\n\n  world  '), 'hello world')
  assert.equal(summariseTitle(''), '')
  const long = 'x'.repeat(300)
  const summary = summariseTitle(long)
  assert.equal(summary.length, MAX_TITLE_CHARS)
  assert.ok(summary.endsWith('…'))
  assert.equal(summariseTitle('a'.repeat(120)).length, 120, 'a title at the limit is kept whole')
  assert.ok(summariseTitle('  spaced  out  ').length <= MAX_TITLE_CHARS)
})

function baseRequest(overrides = {}) {
  return {
    sessionId: 'session-a',
    dueAt: new Date(1_800_000_000_000 + 120_000).toISOString(),
    timeZone: HONG_KONG,
    text: 'hello',
    ...overrides,
  }
}

const NOW = 1_800_000_000_000

test('a valid create request normalizes to trimmed content', () => {
  const result = validateCreateRequest(baseRequest({ text: '  hi there  ' }), NOW)
  assert.equal(result.ok, true)
  assert.equal(result.value.text, 'hi there')
  assert.equal(result.value.dueMs, Date.parse(baseRequest().dueAt))
  assert.deepEqual(result.value.images, [])
  assert.deepEqual(result.value.fileReceipts, [])
  assert.equal(result.value.repeat, null)
})

test('a past time and a time under thirty seconds ahead are refused', () => {
  const past = validateCreateRequest(baseRequest({ dueAt: new Date(NOW - 1000).toISOString() }), NOW)
  assert.equal(past.ok, false)
  assert.equal(past.code, 'too-soon')

  const borderline = validateCreateRequest(baseRequest({ dueAt: new Date(NOW + MIN_LEAD_MS - 1).toISOString() }), NOW)
  assert.equal(borderline.code, 'too-soon')

  const accepted = validateCreateRequest(baseRequest({ dueAt: new Date(NOW + MIN_LEAD_MS).toISOString() }), NOW)
  assert.equal(accepted.ok, true)
})

test('an empty message is refused unless an attachment or file is present', () => {
  assert.equal(validateCreateRequest(baseRequest({ text: '   ' }), NOW).code, 'empty')
  assert.equal(validateCreateRequest(baseRequest({ text: '' }), NOW).code, 'empty')
  assert.equal(
    validateCreateRequest(baseRequest({ text: '  ', fileReceipts: ['receipt-1'] }), NOW).ok,
    true,
    'a file-only message is allowed',
  )
  assert.equal(
    validateCreateRequest(baseRequest({
      text: ' ',
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    }), NOW).ok,
    true,
    'an image-only message is allowed',
  )
})

test('too many images, malformed images and an unknown zone are refused', () => {
  const image = { mediaType: 'image/png', data: 'AAAA' }
  const eleven = Array.from({ length: 11 }, () => image)
  assert.equal(validateCreateRequest(baseRequest({ images: eleven }), NOW).code, 'too-many-images')
  assert.equal(validateCreateRequest(baseRequest({ images: Array.from({ length: 10 }, () => image) }), NOW).ok, true)
  assert.equal(validateCreateRequest(baseRequest({ images: [{ mediaType: '', data: 'AAAA' }] }), NOW).code, 'invalid-images')
  assert.equal(validateCreateRequest(baseRequest({ images: [{ mediaType: 'image/png', data: '' }] }), NOW).code, 'invalid-images')
  assert.equal(validateCreateRequest(baseRequest({ images: 'nope' }), NOW).code, 'invalid-images')
  assert.equal(validateCreateRequest(baseRequest({ timeZone: 'Nowhere/Land' }), NOW).code, 'invalid-time-zone')
  assert.equal(validateCreateRequest(baseRequest({ dueAt: '2026-01-01 09:00' }), NOW).code, 'invalid-due-at')
  assert.equal(validateCreateRequest(baseRequest({ sessionId: '' }), NOW).code, 'invalid-session')
  assert.equal(validateCreateRequest(null, NOW).code, 'invalid-request')
})

test('oversized text is refused', () => {
  const tooLong = 'x'.repeat(MAX_TEXT_CHARS + 1)
  assert.equal(validateCreateRequest(baseRequest({ text: tooLong }), NOW).code, 'text-too-long')
  assert.equal(validateCreateRequest(baseRequest({ text: 'x'.repeat(MAX_TEXT_CHARS) }), NOW).ok, true)
})

test('Repeat is refused together with attachments', () => {
  assert.equal(validateCreateRequest(baseRequest({ repeat: 'daily' }), NOW).ok, true)
  assert.equal(validateCreateRequest(baseRequest({ repeat: 'hourly' }), NOW).code, 'invalid-repeat')
  assert.equal(
    validateCreateRequest(baseRequest({ repeat: 'daily', fileReceipts: ['r'] }), NOW).code,
    'repeat-with-attachments',
  )
  assert.equal(
    validateCreateRequest(baseRequest({
      repeat: 'weekly',
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    }), NOW).code,
    'repeat-with-attachments',
  )
  assert.equal(validateCreateRequest(baseRequest({ repeat: 'monthly', text: '   ' }), NOW).code, 'empty')
})

test('duplicate file receipts collapse to one', () => {
  const result = validateCreateRequest(baseRequest({ fileReceipts: ['a', 'a', 'b'] }), NOW)
  assert.deepEqual(result.value.fileReceipts, ['a', 'b'])
})

test('the earliest pending record wins, ignoring settled ones', () => {
  const rows = [
    { id: 'sent', status: 'sent', dueAt: new Date(NOW).toISOString() },
    { id: 'late', status: 'pending', dueAt: new Date(NOW + 5000).toISOString() },
    { id: 'soon', status: 'pending', dueAt: new Date(NOW + 1000).toISOString() },
    { id: 'stuck', status: 'sending', dueAt: new Date(NOW + 2000).toISOString() },
    { id: 'failed', status: 'failed', dueAt: new Date(NOW + 300).toISOString() },
  ]
  assert.equal(earliestPending(rows).id, 'soon')
  assert.equal(earliestPending([]), undefined)
  assert.equal(earliestPending([{ id: 'x', status: 'sent', dueAt: new Date(NOW).toISOString() }]), undefined)
  assert.equal(earliestPending([{ id: 'y', status: 'pending', dueAt: 'not a date' }]), undefined)
})

test('long waits are chunked to what a timer can hold', () => {
  assert.equal(timerDelay(NOW + 1000, NOW), 1000)
  assert.equal(timerDelay(NOW - 1000, NOW), 0, 'an overdue record fires immediately')
  const far = NOW + 30 * 24 * 3_600_000
  assert.equal(timerDelay(far, NOW), MAX_TIMER_DELAY_MS)
  assert.ok(timerDelay(far, NOW) < far - NOW)
  assert.equal(timerDelay(NOW + 1.5, NOW), 2, 'sub-millisecond waits round up')
  assert.equal(timerDelay(Number.POSITIVE_INFINITY, NOW), MAX_TIMER_DELAY_MS)
})

test('a delivery over a minute late is reported as late', () => {
  assert.equal(isLate(NOW, NOW), false)
  assert.equal(isLate(NOW, NOW + LATE_THRESHOLD_MS), false)
  assert.equal(isLate(NOW, NOW + LATE_THRESHOLD_MS + 1), true)
  assert.equal(isLate(Number.NaN, NOW), false)
})

test('retention drops finished records older than seven days', () => {
  const now = NOW
  const rows = [
    { id: 'old-sent', status: 'sent', sentAt: new Date(now - RETENTION_MS - 1).toISOString() },
    { id: 'fresh-sent', status: 'sent', sentAt: new Date(now - 1000).toISOString() },
    { id: 'old-cancelled', status: 'cancelled', updatedAt: new Date(now - RETENTION_MS - 1).toISOString() },
    { id: 'old-pending', status: 'pending', updatedAt: new Date(now - RETENTION_MS - 1).toISOString() },
    { id: 'old-failed', status: 'failed', updatedAt: new Date(now - RETENTION_MS - 1).toISOString() },
  ]
  assert.deepEqual(pruneTargets(rows, now).sort(), ['old-cancelled', 'old-sent'])
})

test('the strip summary counts pending records and names the next one', () => {
  const rows = [
    { id: 'a', status: 'pending', dueAt: new Date(NOW + 5000).toISOString() },
    { id: 'b', status: 'pending', dueAt: new Date(NOW + 1000).toISOString() },
    { id: 'c', status: 'sent', dueAt: new Date(NOW).toISOString() },
  ]
  const summary = pendingSummary(rows, NOW)
  assert.equal(summary.pending, 2)
  assert.equal(summary.nextDueMs, NOW + 1000)
  assert.equal(pendingSummary([], NOW).nextDueMs, null)
})

test('the storage domain name is a legal storage unit name', () => {
  // @deepseek-ai/dsh-storage exports this pattern as UNIT_NAME_RE and
  // @deepseek-ai/dsh-storage-domain applies it to the domain name and every
  // table name; a hyphen would throw when the domain is defined.
  const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
  assert.ok(UNIT_NAME_RE.test(DOMAIN_NAME), `${DOMAIN_NAME} must match ${UNIT_NAME_RE}`)
  assert.ok(UNIT_NAME_RE.test('messages'))
  assert.equal(UNIT_NAME_RE.test('dsh-scheduled-message'), false, 'the package name is not a unit name')
})

test('the pending cap and retention constants are the documented ones', () => {
  assert.equal(MAX_PENDING, 500)
  assert.equal(RETENTION_MS, 7 * 24 * 60 * 60 * 1000)
  assert.equal(MIN_LEAD_MS, 30_000)
})

test('due instants format through Intl without throwing', () => {
  const instant = Date.parse('2026-11-14T01:00:00.000Z')
  const text = describeDue(instant, 'en-GB', HONG_KONG)
  assert.ok(text.includes('9:00'), `expected a 12-hour or 24-hour time, got ${text}`)
  assert.ok(describeDue(instant, 'not a locale', HONG_KONG).length > 0)
})
