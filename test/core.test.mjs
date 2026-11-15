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
  COMPATIBLE_VERSIONS,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  LATE_THRESHOLD_MS,
  MAX_ERROR_CHARS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_PENDING,
  MAX_TEXT_CHARS,
  MAX_TIMER_DELAY_MS,
  MAX_TITLE_CHARS,
  MIN_LEAD_MS,
  RECORD_STATUSES,
  RETENTION_MS,
  SENT_WINDOW_MS,
  buildRrule,
  countPending,
  dayLabel,
  deepSeekPeakNotice,
  describeDue,
  describePeakWindows,
  earliestPending,
  estimateBase64Bytes,
  groupRecords,
  isDeepSeekModel,
  isDeepSeekPeak,
  isLate,
  isValidTimeZone,
  localParts,
  migrateRecord,
  nextUpdatedAt,
  pad2,
  parseLocalDate,
  parseRecord,
  pendingSummary,
  pruneTargets,
  resolveSessionId,
  skipsShortMonths,
  sortPendingRecords,
  summariseTitle,
  timerDelay,
  to24Hour,
  toMeridiem,
  validateCreateRequest,
  validateMerged,
  validateMessageContent,
  validateTarget,
  validateUpdateRequest,
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

// ---------------------------------------------------------------- schema v2

const UTC_ZERO_PAD = '2026-11-15T00:00:00.000Z'

const V1_RECORD = {
  id: 'msg-1',
  sessionId: 'session-a',
  dueAt: '2026-11-16T01:00:00.000Z',
  timeZone: HONG_KONG,
  text: 'hello',
  images: [{ attachmentId: 'img-1', mediaType: 'image/png', name: 'a.png' }],
  files: [],
  createdAt: UTC_ZERO_PAD,
  updatedAt: UTC_ZERO_PAD,
  status: 'pending',
}

const V2_NEW = {
  id: 'msg-2',
  target: { kind: 'new', cwd: '/work/ws', workspaceId: 'ws-1', title: 'Later' },
  dueAt: '2026-11-16T02:00:00.000Z',
  timeZone: HONG_KONG,
  text: 'later',
  images: [],
  files: [{ attachmentId: 'file-1', name: 'spec.pdf', bytes: 2048 }],
  createdAt: UTC_ZERO_PAD,
  updatedAt: UTC_ZERO_PAD,
  status: 'pending',
}

const IMAGE = { mediaType: 'image/png', data: 'AAAA' }

function hongKongAt(date, hour24, minute) {
  const resolved = wallClockToInstant({ date, hour24, minute }, HONG_KONG)
  assert.equal(resolved.ok, true, 'Hong Kong has no gap at ' + date + ' ' + hour24 + ':' + minute)
  return resolved.instantMs
}

function newYorkAt(date, hour24, minute) {
  const resolved = wallClockToInstant({ date, hour24, minute }, NEW_YORK)
  assert.equal(resolved.ok, true, 'New York has a wall clock at ' + date + ' ' + hour24 + ':' + minute)
  return resolved.instantMs
}

test('the domain is version 2 and still opens version 1', () => {
  assert.equal(DOMAIN_VERSION, 2)
  assert.deepEqual([...COMPATIBLE_VERSIONS], [1])
  assert.deepEqual([...RECORD_STATUSES], ['pending', 'sending', 'sent', 'failed', 'cancelled'])
  assert.equal(MAX_ERROR_CHARS, 500)
  assert.ok(MAX_IMAGE_BYTES > 0 && MAX_MESSAGE_IMAGE_BYTES > MAX_IMAGE_BYTES)
  assert.equal(SENT_WINDOW_MS, 24 * 60 * 60 * 1000)
})

test('a v1 record migrates to a session target', () => {
  const migrated = migrateRecord(V1_RECORD)
  assert.deepEqual(migrated.target, { kind: 'session', sessionId: 'session-a' })
  assert.equal(migrated.sessionId, 'session-a')
  assert.equal(migrated.id, 'msg-1')
  assert.equal(migrated.status, 'pending')
  assert.equal(migrated.text, 'hello')
  assert.deepEqual(migrated.images, V1_RECORD.images)
  assert.equal('sentAt' in migrated, false)
  assert.equal('error' in migrated, false)
  assert.equal(migrateRecord(null), null)
  assert.equal(migrateRecord('nope'), null)
  assert.equal(migrateRecord([]), null)
})

test('migration is idempotent and leaves a v2 record alone', () => {
  const once = migrateRecord(V1_RECORD)
  assert.deepEqual(migrateRecord(once), once)
  assert.deepEqual(migrateRecord(migrateRecord(V1_RECORD)), once)
  assert.deepEqual(migrateRecord(V2_NEW), V2_NEW)
  assert.deepEqual(migrateRecord(migrateRecord(V2_NEW)), V2_NEW)
})

test('migration defaults absent fields instead of throwing', () => {
  const bare = migrateRecord({ sessionId: 's1' })
  assert.deepEqual(bare.target, { kind: 'session', sessionId: 's1' })
  assert.equal(bare.timeZone, 'UTC')
  assert.deepEqual(bare.images, [])
  assert.deepEqual(bare.files, [])
  assert.equal(bare.text, '')
  assert.equal(bare.status, 'pending')
  assert.equal(migrateRecord({ ...V1_RECORD, sessionId: '' }).target, undefined)
  assert.equal(migrateRecord({ ...V1_RECORD, timeZone: '' }).timeZone, 'UTC')
})

test('parseRecord accepts a v1 record and normalizes it to v2', () => {
  const parsed = parseRecord(V1_RECORD)
  assert.deepEqual(parsed.target, { kind: 'session', sessionId: 'session-a' })
  assert.equal(parsed.sessionId, 'session-a')
  assert.equal(parsed.status, 'pending')
  assert.equal(parsed.timeZone, HONG_KONG)
  assert.deepEqual(parsed.files, [])
  assert.equal('sentAt' in parsed, false)
})

test('parseRecord accepts both v2 target kinds', () => {
  const fresh = parseRecord(V2_NEW)
  assert.deepEqual(fresh.target, V2_NEW.target)
  assert.equal(fresh.sessionId, undefined)
  assert.deepEqual(fresh.files, V2_NEW.files)

  const created = parseRecord({ ...V2_NEW, sessionId: 'session-created' })
  assert.equal(created.sessionId, 'session-created')

  const moved = parseRecord({
    ...V2_NEW,
    target: { kind: 'session', sessionId: 'session-b' },
    sessionId: 'session-created',
  })
  assert.deepEqual(moved.target, { kind: 'session', sessionId: 'session-b' })
  assert.equal(moved.sessionId, 'session-b', 'a session target owns the resolved id')
})

test('parseRecord keeps a fallback zone and boolean flags', () => {
  const parsed = parseRecord({ ...V1_RECORD, timeZone: 'Mars/Olympus', late: 1, status: 'sent', sentAt: UTC_ZERO_PAD })
  assert.equal(parsed.timeZone, 'UTC')
  assert.equal(parsed.late, true)
  assert.equal(parsed.sentAt, UTC_ZERO_PAD)
})

test('parseRecord refuses a bad status, instant or attachment', () => {
  assert.throws(() => parseRecord({ ...V1_RECORD, status: 'exploded' }), /unknown status exploded/)
  assert.throws(() => parseRecord({ ...V1_RECORD, dueAt: 'tomorrow' }), /dueAt/)
  assert.throws(() => parseRecord({ ...V1_RECORD, createdAt: '' }), /createdAt/)
  assert.throws(() => parseRecord({ ...V1_RECORD, updatedAt: 'soon' }), /updatedAt/)
  assert.throws(() => parseRecord({ ...V1_RECORD, id: '' }), /id/)
  assert.throws(() => parseRecord({ ...V1_RECORD, images: [{ mediaType: 'image/png' }] }), /attachmentId/)
  assert.throws(() => parseRecord({ ...V1_RECORD, images: [{ attachmentId: '' }] }), /attachmentId/)
  assert.throws(() => parseRecord({ ...V1_RECORD, files: 'nope' }), /files/)
  assert.throws(() => parseRecord({ ...V1_RECORD, target: { kind: 'automation' } }), /target/)
  assert.throws(() => parseRecord({ ...V1_RECORD, sessionId: '', target: undefined }), /target/)
  assert.throws(() => parseRecord(null), /object/)
  assert.throws(() => parseRecord([]), /object/)
})

test('a stored error is clamped and kept only when present', () => {
  const clamped = parseRecord({ ...V1_RECORD, status: 'failed', error: 'x'.repeat(4000) }, { maxErrorChars: 12 })
  assert.equal(clamped.error.length, 12)
  assert.equal(parseRecord({ ...V1_RECORD, status: 'failed', error: 'boom' }).error, 'boom')
  assert.equal('error' in parseRecord(V1_RECORD), false)
  assert.equal(parseRecord({ ...V1_RECORD, status: 'failed', error: 'x'.repeat(4000) }).error.length, MAX_ERROR_CHARS)
})

test('updatedAt strictly increases even when the clock stands still', () => {
  const previous = UTC_ZERO_PAD
  const previousMs = Date.parse(previous)
  assert.equal(nextUpdatedAt(previous, previousMs - 60_000), new Date(previousMs + 1).toISOString())
  assert.equal(nextUpdatedAt(previous, previousMs), new Date(previousMs + 1).toISOString())
  assert.equal(nextUpdatedAt(previous, previousMs + 60_000), new Date(previousMs + 60_000).toISOString())
  assert.equal(nextUpdatedAt(undefined, previousMs), new Date(previousMs).toISOString())
  let token = previous
  for (let round = 0; round < 5; round += 1) {
    const next = nextUpdatedAt(token, Date.parse(token))
    assert.ok(Date.parse(next) > Date.parse(token), 'round ' + round + ' must advance')
    token = next
  }
})

test('validateTarget accepts both kinds', () => {
  assert.deepEqual(
    validateTarget({ kind: 'session', sessionId: 's1', extra: true }),
    { ok: true, value: { kind: 'session', sessionId: 's1' } },
  )
  assert.deepEqual(validateTarget({ kind: 'new', cwd: '/work/ws' }), { ok: true, value: { kind: 'new', cwd: '/work/ws' } })
  assert.deepEqual(
    validateTarget({ kind: 'new', cwd: 'C:\\work\\ws', workspaceId: 'w1', title: 'Later' }),
    { ok: true, value: { kind: 'new', cwd: 'C:\\work\\ws', workspaceId: 'w1', title: 'Later' } },
  )
  assert.equal(validateTarget({ kind: 'new', cwd: '\\\\server\\share' }).ok, true)
})

test('validateTarget rejects anything else with one stable code', () => {
  const cases = [
    null,
    'session-a',
    { kind: 'session', sessionId: '' },
    { kind: 'session' },
    { kind: 'new' },
    { kind: 'new', cwd: 'relative/path' },
    { kind: 'new', cwd: '' },
    { kind: 'new', cwd: '/work/ws', workspaceId: '' },
    { kind: 'new', cwd: '/work/ws', title: 7 },
    { kind: 'automation', taskId: 't1' },
  ]
  for (const candidate of cases) {
    const result = validateTarget(candidate)
    assert.equal(result.ok, false, String(JSON.stringify(candidate)))
    assert.equal(result.code, 'invalid-target')
    assert.ok(result.message.length > 0)
  }
})

test('validateMessageContent enforces every limit', () => {
  assert.equal(validateMessageContent({ text: '  hi  ' }).ok, true)
  assert.equal(validateMessageContent({ text: '   ' }).code, 'empty')
  assert.equal(validateMessageContent({}).code, 'empty')
  assert.equal(validateMessageContent(undefined).code, 'empty')
  assert.equal(validateMessageContent({ text: '', images: [IMAGE] }).ok, true)
  assert.equal(validateMessageContent({ text: '', files: [{ attachmentId: 'f1', name: 'a.pdf', bytes: 10 }] }).ok, true)
  assert.equal(validateMessageContent({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }).code, 'text-too-long')
  assert.equal(validateMessageContent({ text: 'x'.repeat(MAX_TEXT_CHARS) }).ok, true)
  assert.equal(validateMessageContent({ text: 42 }).code, 'invalid-text')
  assert.equal(validateMessageContent({ images: 'nope' }).code, 'invalid-images')
  assert.equal(validateMessageContent({ images: [{}] }).code, 'invalid-images')
  assert.equal(validateMessageContent({ images: [{ mediaType: 'image/png', data: '' }] }).code, 'invalid-images')
  assert.equal(validateMessageContent({ images: [{ mediaType: '', data: 'AAAA' }] }).code, 'invalid-images')
  assert.equal(
    validateMessageContent({ images: Array.from({ length: MAX_IMAGES + 1 }, () => IMAGE) }).code,
    'too-many-images',
  )
  assert.equal(validateMessageContent({ images: [IMAGE, IMAGE], limits: { maxImagesPerMessage: 1 } }).code, 'too-many-images')
  assert.equal(validateMessageContent({ images: [IMAGE], limits: { maxImageBytes: 2 } }).code, 'image-too-large')
  assert.equal(validateMessageContent({ images: [IMAGE], limits: { maxImageBytes: 3 } }).ok, true)
  assert.equal(
    validateMessageContent({ images: [IMAGE, IMAGE], limits: { maxMessageImageBytes: 5 } }).code,
    'images-too-large',
  )
  assert.equal(validateMessageContent({ files: [{ name: 'a.pdf' }] }).code, 'invalid-files')
  assert.equal(validateMessageContent({ files: [{ attachmentId: '' }] }).code, 'invalid-files')
  assert.equal(validateMessageContent({ files: [{ attachmentId: 'f', bytes: -1 }] }).code, 'invalid-files')
  assert.equal(validateMessageContent({ files: 'nope' }).code, 'invalid-files')
  assert.equal(
    validateMessageContent({ files: [{ attachmentId: 'f', bytes: 10 }], limits: { maxFilesBytes: 5 } }).code,
    'files-too-large',
  )
  assert.equal(validateMessageContent({ text: 'x', limits: { maxTextChars: 0 } }).ok, true)
})

test('validateMessageContent reports the normalized content and sizes', () => {
  const result = validateMessageContent({
    text: 'hi',
    images: [{ mediaType: 'image/png', data: 'AAAA', name: 'a.png' }],
    files: [{ attachmentId: 'f1', name: 'a.pdf', bytes: 10 }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.text, 'hi')
  assert.deepEqual(result.value.images, [{ mediaType: 'image/png', data: 'AAAA', name: 'a.png' }])
  assert.equal(result.value.textChars, 2)
  assert.equal(result.value.imageBytes, 3)
  assert.equal(result.value.fileBytes, 10)
})

test('the base64 byte estimate subtracts padding', () => {
  assert.equal(estimateBase64Bytes('AAAA'), 3)
  assert.equal(estimateBase64Bytes('AAA='), 2)
  assert.equal(estimateBase64Bytes('AA=='), 1)
  assert.equal(estimateBase64Bytes(''), 0)
  assert.equal(estimateBase64Bytes(undefined), 0)
  assert.equal(estimateBase64Bytes('AA AA'), 3)
})

function updateBase(overrides = {}) {
  return { id: 'msg-1', expectedUpdatedAt: UTC_ZERO_PAD, ...overrides }
}

const UPDATE_NOW = Date.parse(UTC_ZERO_PAD)

test('validateUpdateRequest accepts each change field', () => {
  const dueAt = new Date(UPDATE_NOW + 10 * 60_000).toISOString()
  assert.equal(validateUpdateRequest(updateBase({ dueAt }), UPDATE_NOW).value.dueAt, dueAt)
  assert.equal(validateUpdateRequest(updateBase({ dueAt }), UPDATE_NOW).value.dueMs, Date.parse(dueAt))
  assert.equal(validateUpdateRequest(updateBase({ text: ' new text ' }), UPDATE_NOW).value.text, 'new text')
  assert.deepEqual(
    validateUpdateRequest(updateBase({ target: { kind: 'new', cwd: '/work/ws', workspaceId: 'w1' } }), UPDATE_NOW).value.target,
    { kind: 'new', cwd: '/work/ws', workspaceId: 'w1' },
  )
  assert.equal(validateUpdateRequest(updateBase({ addImages: [IMAGE] }), UPDATE_NOW).value.addImages.length, 1)
  assert.deepEqual(validateUpdateRequest(updateBase({ addFileIds: ['f1', 'f1', 'f2'] }), UPDATE_NOW).value.addFileIds, ['f1', 'f2'])
  assert.deepEqual(
    validateUpdateRequest(updateBase({ removeAttachmentIds: ['a1', 'a1'] }), UPDATE_NOW).value.removeAttachmentIds,
    ['a1'],
  )
  assert.equal(validateUpdateRequest(updateBase({ text: '' }), UPDATE_NOW).ok, true, 'an empty text is judged after the merge')
})

test('validateUpdateRequest combines every field in one request', () => {
  const dueAt = new Date(UPDATE_NOW + 10 * 60_000).toISOString()
  const result = validateUpdateRequest(updateBase({
    dueAt,
    text: 'edited',
    target: { kind: 'session', sessionId: 'session-b' },
    addImages: [IMAGE],
    addFileIds: ['f1'],
    removeAttachmentIds: ['a1'],
  }), UPDATE_NOW)
  assert.equal(result.ok, true)
  assert.equal(result.value.id, 'msg-1')
  assert.equal(result.value.expectedUpdatedAt, UTC_ZERO_PAD)
  assert.equal(result.value.dueAt, dueAt)
  assert.equal(result.value.text, 'edited')
  assert.deepEqual(result.value.target, { kind: 'session', sessionId: 'session-b' })
  assert.deepEqual(result.value.addImages, [IMAGE])
  assert.deepEqual(result.value.addFileIds, ['f1'])
  assert.deepEqual(result.value.removeAttachmentIds, ['a1'])
})

test('validateUpdateRequest refuses an empty or malformed request', () => {
  assert.equal(validateUpdateRequest(null, UPDATE_NOW).code, 'invalid-request')
  assert.equal(validateUpdateRequest(updateBase({ id: '' }), UPDATE_NOW).code, 'invalid-id')
  assert.equal(validateUpdateRequest({ id: 'msg-1' }, UPDATE_NOW).code, 'invalid-expected-updated-at')
  assert.equal(validateUpdateRequest(updateBase({ expectedUpdatedAt: 'yesterday' }), UPDATE_NOW).code, 'invalid-expected-updated-at')
  assert.equal(validateUpdateRequest(updateBase(), UPDATE_NOW).code, 'nothing-to-update')
  assert.equal(
    validateUpdateRequest(updateBase({ addImages: [], addFileIds: [], removeAttachmentIds: [] }), UPDATE_NOW).code,
    'nothing-to-update',
    'empty change lists are not changes',
  )
})

test('validateUpdateRequest refuses a time that is too soon or not an instant', () => {
  assert.equal(validateUpdateRequest(updateBase({ dueAt: 'tomorrow' }), UPDATE_NOW).code, 'invalid-due-at')
  assert.equal(validateUpdateRequest(updateBase({ dueAt: new Date(UPDATE_NOW).toISOString() }), UPDATE_NOW).code, 'too-soon')
  assert.equal(
    validateUpdateRequest(updateBase({ dueAt: new Date(UPDATE_NOW + MIN_LEAD_MS - 1).toISOString() }), UPDATE_NOW).code,
    'too-soon',
  )
  assert.equal(
    validateUpdateRequest(updateBase({ dueAt: new Date(UPDATE_NOW + MIN_LEAD_MS).toISOString() }), UPDATE_NOW).ok,
    true,
  )
})

test('validateUpdateRequest refuses a bad target and bad content', () => {
  assert.equal(validateUpdateRequest(updateBase({ target: { kind: 'automation' } }), UPDATE_NOW).code, 'invalid-target')
  assert.equal(validateUpdateRequest(updateBase({ target: { kind: 'new', cwd: 'relative' } }), UPDATE_NOW).code, 'invalid-target')
  assert.equal(validateUpdateRequest(updateBase({ text: 7 }), UPDATE_NOW).code, 'invalid-text')
  assert.equal(
    validateUpdateRequest(updateBase({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }), UPDATE_NOW).code,
    'text-too-long',
  )
  assert.equal(
    validateUpdateRequest(updateBase({ addImages: Array.from({ length: MAX_IMAGES + 1 }, () => IMAGE) }), UPDATE_NOW).code,
    'too-many-images',
  )
  assert.equal(validateUpdateRequest(updateBase({ addImages: 'nope' }), UPDATE_NOW).code, 'invalid-images')
  assert.equal(validateUpdateRequest(updateBase({ addFileIds: [''] }), UPDATE_NOW).code, 'invalid-files')
  assert.equal(validateUpdateRequest(updateBase({ removeAttachmentIds: [7] }), UPDATE_NOW).code, 'invalid-attachment-ids')
})

test('a removal plus empty text is refused by the merged check', () => {
  const update = validateUpdateRequest(updateBase({ text: '   ', removeAttachmentIds: ['img-1'] }), UPDATE_NOW)
  assert.equal(update.ok, true, 'the update itself is legal; only the merged record can be judged')
  const merged = validateMerged({ ...V1_RECORD, text: update.value.text, images: [], files: [] })
  assert.equal(merged.ok, false)
  assert.equal(merged.code, 'empty')
  assert.equal(validateMerged({ ...V1_RECORD, text: '' }).ok, true, 'the kept image still makes a message')
  assert.equal(validateMerged({ ...V1_RECORD, text: 'kept' }).ok, true)
})

test('dayLabel names today, tomorrow and the next few days', () => {
  const now = hongKongAt('2026-11-15', 9, 0)
  assert.deepEqual(dayLabel(hongKongAt('2026-11-15', 23, 0), now, HONG_KONG), {
    kind: 'today', date: '2026-11-15', isoWeekday: 7,
  })
  assert.deepEqual(dayLabel(hongKongAt('2026-11-16', 0, 5), now, HONG_KONG), {
    kind: 'tomorrow', date: '2026-11-16', isoWeekday: 1,
  })
  assert.deepEqual(dayLabel(hongKongAt('2026-11-18', 12, 0), now, HONG_KONG), {
    kind: 'weekday', date: '2026-11-18', isoWeekday: 3,
  })
  assert.equal(dayLabel(hongKongAt('2026-11-21', 12, 0), now, HONG_KONG).kind, 'weekday', 'six days out keeps a weekday name')
  assert.equal(dayLabel(hongKongAt('2026-11-22', 12, 0), now, HONG_KONG).kind, 'date', 'a week out gets the full date')
  assert.equal(dayLabel(hongKongAt('2026-11-14', 12, 0), now, HONG_KONG).kind, 'date', 'a past day gets the full date')
})

test('dayLabel crosses midnight on the calendar, not on elapsed time', () => {
  const lateNight = hongKongAt('2026-11-15', 23, 59)
  const justAfter = hongKongAt('2026-11-16', 0, 1)
  assert.ok(justAfter - lateNight <= 3 * 60_000)
  assert.equal(dayLabel(justAfter, lateNight, HONG_KONG).kind, 'tomorrow')
  const backwards = dayLabel(lateNight, justAfter, HONG_KONG)
  assert.equal(backwards.kind, 'date')
  assert.equal(backwards.date, '2026-11-15')
  assert.equal(
    zoneOffsetMs(lateNight, HONG_KONG),
    zoneOffsetMs(justAfter + 30 * 86_400_000, HONG_KONG),
    'Hong Kong keeps one offset all year',
  )
})

test('dayLabel follows the calendar across a New York DST change', () => {
  const early = newYorkAt('2026-03-08', 0, 10)
  const late = newYorkAt('2026-03-08', 23, 10)
  assert.ok(late - early < 24 * 3_600_000, 'the spring-forward day is 23 hours long')
  assert.equal(dayLabel(late, early, NEW_YORK).kind, 'today')
  assert.equal(dayLabel(late, early, NEW_YORK).date, '2026-03-08')

  const beforeMidnight = newYorkAt('2026-03-08', 23, 55)
  const afterMidnight = newYorkAt('2026-03-09', 0, 5)
  assert.ok(afterMidnight - beforeMidnight < 3_600_000)
  assert.equal(dayLabel(afterMidnight, beforeMidnight, NEW_YORK).kind, 'tomorrow')
  assert.equal(dayLabel(afterMidnight, beforeMidnight, NEW_YORK).date, '2026-03-09')

  assert.equal(
    dayLabel(newYorkAt('2026-03-15', 12, 0), newYorkAt('2026-03-08', 12, 0), NEW_YORK).kind,
    'date',
    'a week later is not a weekday label',
  )
  assert.equal(dayLabel(newYorkAt('2026-03-09', 12, 0), newYorkAt('2026-03-08', 12, 0), NEW_YORK).kind, 'tomorrow')
})

test('dayLabel falls back to UTC and refuses a broken instant', () => {
  const now = Date.UTC(2026, 10, 15, 0, 0)
  assert.equal(dayLabel(Date.UTC(2026, 10, 16, 0, 0), now, 'Not/AZone').kind, 'tomorrow')
  assert.throws(() => dayLabel(Number.NaN, now, HONG_KONG), RangeError)
  assert.throws(() => dayLabel(now, Number.NaN, HONG_KONG), RangeError)
})

test('pending rows sort by due time, then created time, then id', () => {
  const rows = [
    { id: 'b', dueAt: '2026-11-15T02:00:00.000Z', createdAt: UTC_ZERO_PAD },
    { id: 'a', dueAt: '2026-11-15T01:00:00.000Z', createdAt: UTC_ZERO_PAD },
    { id: 'c', dueAt: '2026-11-15T01:00:00.000Z', createdAt: UTC_ZERO_PAD },
    { id: 'early', dueAt: '2026-11-15T01:00:00.000Z', createdAt: '2026-11-13T00:00:00.000Z' },
    { id: 'broken', dueAt: 'whenever', createdAt: UTC_ZERO_PAD },
  ]
  assert.deepEqual(sortPendingRecords(rows).map((row) => row.id), ['early', 'a', 'c', 'b', 'broken'])
  assert.deepEqual(sortPendingRecords([]), [])
  assert.deepEqual(sortPendingRecords(undefined), [])
  assert.equal(rows[0].id, 'b', 'the input array is not reordered')
})

test('groupRecords orders day groups and appends the sent window', () => {
  const now = hongKongAt('2026-11-15', 9, 0)
  const iso = (ms) => new Date(ms).toISOString()
  const records = [
    {
      id: 'sent-old', status: 'sent',
      dueAt: iso(now - 3 * SENT_WINDOW_MS), sentAt: iso(now - 3 * SENT_WINDOW_MS), createdAt: UTC_ZERO_PAD,
    },
    {
      id: 'tomorrow-late', status: 'pending',
      dueAt: iso(hongKongAt('2026-11-16', 21, 0)), createdAt: UTC_ZERO_PAD,
    },
    {
      id: 'today-b', status: 'pending',
      dueAt: iso(hongKongAt('2026-11-15', 20, 0)), createdAt: UTC_ZERO_PAD,
    },
    {
      id: 'failed', status: 'failed',
      dueAt: iso(hongKongAt('2026-11-15', 8, 0)), createdAt: UTC_ZERO_PAD, error: 'blocked',
    },
    {
      id: 'today-a', status: 'sending',
      dueAt: iso(hongKongAt('2026-11-15', 10, 0)), createdAt: UTC_ZERO_PAD,
    },
    {
      id: 'tomorrow-early', status: 'pending',
      dueAt: iso(hongKongAt('2026-11-16', 9, 0)), createdAt: UTC_ZERO_PAD,
    },
    {
      id: 'sent-recent', status: 'sent',
      dueAt: iso(now - 120_000), sentAt: iso(now - 60_000), createdAt: UTC_ZERO_PAD,
    },
    {
      id: 'cancelled-recent', status: 'cancelled',
      dueAt: iso(now - 300_000), sentAt: iso(now - 120_000), createdAt: UTC_ZERO_PAD,
    },
    { id: 'broken', status: 'pending', dueAt: 'whenever', createdAt: UTC_ZERO_PAD },
  ]
  const groups = groupRecords(records, now, HONG_KONG)
  assert.deepEqual(groups.map((group) => group.kind), ['today', 'tomorrow', 'sent'])
  assert.deepEqual(groups.map((group) => group.date), ['2026-11-15', '2026-11-16', null])
  assert.deepEqual(groups[0].rows.map((row) => row.id), ['failed', 'today-a', 'today-b'])
  assert.deepEqual(groups[1].rows.map((row) => row.id), ['tomorrow-early', 'tomorrow-late'])
  assert.deepEqual(groups[2].rows.map((row) => row.id), ['sent-recent', 'cancelled-recent'])
  assert.equal(
    groups.flatMap((group) => group.rows).some((row) => row.id === 'sent-old'),
    false,
    'a settled record older than the window is not listed',
  )
  assert.equal(groups.flatMap((group) => group.rows).some((row) => row.id === 'broken'), false)
  assert.deepEqual(groupRecords([], now, HONG_KONG), [])
  assert.deepEqual(groupRecords(undefined, now, HONG_KONG), [])
})

test('countPending counts what still has to be sent', () => {
  assert.equal(countPending([
    { status: 'pending' },
    { status: 'sending' },
    { status: 'sent' },
    { status: 'failed' },
    { status: 'cancelled' },
    null,
  ]), 2)
  assert.equal(countPending([]), 0)
  assert.equal(countPending(undefined), 0)
})

test('the resolved session id follows a moved record', () => {
  assert.equal(resolveSessionId({ target: { kind: 'session', sessionId: 's1' } }), 's1')
  assert.equal(resolveSessionId({ target: { kind: 'new', cwd: '/work/ws' } }), undefined)
  assert.equal(resolveSessionId({ target: { kind: 'new', cwd: '/work/ws' }, sessionId: 'created' }), 'created')
  assert.equal(resolveSessionId({}), undefined)
  assert.equal(resolveSessionId(null), undefined)
  assert.equal(resolveSessionId(parseRecord(V1_RECORD)), 'session-a')
  assert.equal(resolveSessionId(parseRecord(V2_NEW)), undefined)
  assert.equal(resolveSessionId(parseRecord({ ...V2_NEW, sessionId: 'session-created' })), 'session-created')
})

test('describeDue returns an empty string instead of throwing without an instant', () => {
  // A view that is still loading has no instant yet. The old fallback called
  // toISOString() on an invalid Date, which throws RangeError('Invalid time value')
  // and took the whole panel down with it.
  assert.equal(describeDue(Number.NaN, 'en', 'Asia/Hong_Kong'), '')
  assert.equal(describeDue(undefined, 'en', 'Asia/Hong_Kong'), '')
  assert.equal(describeDue(Number.POSITIVE_INFINITY, 'en', 'Asia/Hong_Kong'), '')
  assert.equal(describeDue('not a date', 'en', 'Asia/Hong_Kong'), '')
  assert.ok(describeDue(Date.parse('2026-11-15T13:00:00.000Z'), 'en', 'Asia/Hong_Kong').length > 0)
})
