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
export function createClientPlugin(require) {
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
    internal: 'error.generic',
  }

  // ---------------------------------------------------------------- stores

  const openRequests = new Map()
  const openListeners = new Set()
  let refreshSeq = 0
  const refreshListeners = new Set()
  let toast = null

  function bumpOpen(sessionId) {
    openRequests.set(sessionId, (openRequests.get(sessionId) ?? 0) + 1)
    for (const listener of [...openListeners]) listener()
  }

  function bumpRefresh() {
    refreshSeq += 1
    for (const listener of [...refreshListeners]) listener()
  }

  function setToast(text) {
    toast = text
    bumpRefresh()
    const captured = text
    setTimeout(() => {
      if (toast === captured) {
        toast = null
        bumpRefresh()
      }
    }, 7000)
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
  const services = { sessions: undefined, layout: undefined }

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

  // ---------------------------------------------------------------- dialog

  /**
   * Date, 12-hour clock, AM/PM and Repeat editor.
   *
   * @param props - localized translator, current zone, mode, initial selection,
   *   whether Repeat is available, and the submit callback (which throws to
   *   keep the dialog open with an inline error).
   */
  function ScheduleDialog(props) {
    const { t, zone, mode, initial, repeatLocked, previewText, attachmentCount, onSubmit, onClose } = props
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
      notifySession(sessionId, 'info', t('notice.automationCreated', { time: when }))
      setToast(t('notice.automationCreated', { time: when }))
      openTasksPanel()
    } else {
      try {
        inputActions.setDraft('')
        for (const id of attachmentIds) inputActions.removeAttachment(id)
      } catch {
        // A composer that already settled its draft is not an error here.
      }
      notifySession(sessionId, 'info', t('notice.scheduled', { time: when }))
      setToast(t('notice.scheduled', { time: when }))
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

  function notifySession(sessionId, level, text) {
    try {
      const scope = services.sessions?.scope?.(sessionId)
      if (scope === undefined) return
      const conversation = scope.get?.('conversation')
      const hub = conversation?.input
      if (hub !== undefined && typeof hub.for === 'function') hub.for(scope).notify(level, text)
    } catch {
      // Notices are advisory: the strip already reports the new record.
    }
  }

  function openTasksPanel() {
    try {
      services.layout?.selectPanel?.(TASKS_PANEL)
    } catch {
      // A profile without the task page simply keeps the current panel.
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
    const [open, setOpen] = useState(false)
    const zone = useMemo(currentZone, [])

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
    const [items, setItems] = useState([])
    const [failure, setFailure] = useState(null)
    const [expanded, setExpanded] = useState(false)
    const [busyId, setBusyId] = useState(null)
    const [confirmId, setConfirmId] = useState(null)
    const [editing, setEditing] = useState(null)

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
        bumpRefresh()
      } catch (error) {
        setFailure(error)
      } finally {
        setBusyId(null)
        setConfirmId(null)
      }
    }, [])

    if (sessionId === undefined) return null

    const pending = items.filter(item => item.status === 'pending' || item.status === 'sending')
    const failed = items.filter(item => item.status === 'failed')
    const sent = items.filter(item => item.status === 'sent')
    const visible = items.length > 0
    if (!visible && toast === null) return null

    const head = pending.length > 0
      ? t('dock.collapsed', {
        count: pending.length,
        next: nextDueMs === null ? '' : core.describeDue(nextDueMs, locale, zone),
      })
      : t('dock.collapsedEmpty')

    return h('div', { className: 'dsm-dock' },
      toast !== null ? h('p', { className: 'dsm-toast', role: 'status' }, toast) : null,

      visible
        ? h('button', {
          type: 'button',
          className: 'dsm-dock-head',
          'aria-expanded': expanded,
          onClick: () => setExpanded(current => !current),
        }, h(BellIcon), h('span', null, head), h('span', { className: 'dsm-dock-caret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'))
        : null,

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
          attachmentCount: 0,
          onClose: () => setEditing(null),
          onSubmit: async (plan) => {
            setBusyId(editing.id)
            try {
              await postJson(`${API}/reschedule`, { id: editing.id, dueAt: new Date(plan.instantMs).toISOString() })
              setToast(t('notice.rescheduled', { time: core.describeDue(plan.instantMs, locale, zone) }))
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
}
@keyframes dsm-rise{from{transform:translateY(12px);opacity:.6}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){
  .dsm-dialog{animation:none}
  .dsm-btn{transition:none}
  .dsm-spinner{animation-duration:2s}
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
  }
}
