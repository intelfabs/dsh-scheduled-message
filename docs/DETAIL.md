# dsh-scheduled-message — design notes

Everything here was checked against the installed harness
(`DeepSeek Harness 0.2.2-rc.2`, `…/resources/app.asar/dsh/node_modules/@deepseek-ai/…`), not against
a remembered API. File and line references point at the shipped package sources inside that ASAR.

- [1. Scope](#1-scope)
- [2. Platform facts](#2-platform-facts)
- [3. Host design](#3-host-design)
- [4. Client design](#4-client-design)
- [5. Failure and edge behaviour](#5-failure-and-edge-behaviour)
- [6. Tests](#6-tests)
- [7. Verification](#7-verification)
- [8. Deviations from PLAN.md](#8-deviations-from-planmd)
- [9. The Scheduled tab (v2, 0.3.0)](#9-v2)

---

<a id="1-scope"></a>
## 1. Scope

The feature is one thing: *this exact composer content, delivered later by the Host*.

In scope: a schedule button and dialog, a 12-hour picker, quick picks, an optional Repeat that
becomes an Automation task, a strip that lists and manages scheduled records, a keyboard shortcut,
English and Chinese copy, Host-side durable storage and delivery, and late/at-startup delivery.

Out of scope, deliberately: attachments on repeating messages (the Automation service delivers text
only), automatic retries, polling, and any change to the normal send path.

<a id="2-platform-facts"></a>
## 2. Platform facts

### 2.1 A client plugin is a package export, not a URL

The Client half is not registered by naming a file. A package declares `dsh.client` with
`platform: 'web'` and exports `./client`; the Host turns that declaration into a served bundle under
`/plugins`.

- `dsh-client-modules/src/index.ts:203` — `clientExportOf` resolves `exports["./client"]`, accepting a
  string or one level of `default`.
- `dsh-client-modules/src/client/manifest.ts` — `WebBootEntry.id` is *the package name*; `inject`
  names package rows whose factories must arrive first; `external` adds non-baseline module requests.

The bundle itself is a lazy-CJS factory. Every shipped plugin ends with the same shape
(`dsh-ops/lib/client.js`, tail):

```js
window.__ModuleLoader__.load({ id: "<package>", factory: (require) => { … return load("client/index.js") } })
```

Executing the bundle only registers the factory; all side effects, including CSS injection, run when
the factory materializes. `require` resolves against the frozen platform table plus the factories
already registered, so a plugin bundle may only ask for baseline modules. The two this bundle uses —
`react` and `react-dom` — are both in that table (`react-dom` is used by `dsh-config-manager`, and
`react-dom/client` by `dsh-claude-style`).

### 2.2 Importable Host services

- `ctx.sessionController.prompt(request, signal)`
  `dsh-api-session-controller/src/index.ts:467`, request type `src/types.ts:324`:
  `{ requestId, sessionId, mode: 'queue' | 'steer', content: PromptContentPart[], clientTimeZone? }`.
  `requestId` is idempotent — the same id is never delivered twice, which is the crash-safety
  mechanism for retries. `resolveAgent(sessionId)` answers `{ agent }` or `{ error }`.
- `ctx.attachments` — `dsh-attachment/src/index.ts:116` `saveImages`, `:195` `readImage`,
  `:247` `readFileStream`; value shapes in `src/types.ts:127`/`:136`.
- `ctx.fileUploads` — `dsh-client-file-upload/src/index.ts:127` `uploadStream({ sessionId, data })`
  returns `{ receiptId, file }`; `:194` `resolve(agent, receiptId)` returns the staged attachment for
  that exact Agent.
- `ctx.schedule` — `dsh-schedule/src/index.ts:381` `create(request, actorSessionId?, signal?)`;
  timing union in `src/types.ts:335`, request in `src/types.ts:478`. Title ≤120 chars, prompt
  non-empty, both trimmed.
- `ctx.storageDomain` — `dsh-storage-domain/src/spec.ts:91` `domainTable`, `:107` `defineDomain`;
  `src/index.ts:126` calls `tableSpec.valueSchema.parse(raw)` on read. The service is provided as
  `storageDomain` (`dsh-storage-domain/lib/index.js`: `domainCtx.provide("storageDomain", facility)`),
  and unit names must match `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` exported by `@deepseek-ai/dsh-storage`.
- `ctx.connection.fetch` — `dsh-client-connection/src/rpc.ts:153` `ConnectionFetchRoute`,
  `:175` `register(route)`. Paths are absolute below `/api` (`dsh-client-file-upload/src/protocol.ts:2`
  uses `/api/session/uploadFileBinary`). Only owner peers reach an exact route.
- `ctx.timer.timeout(callback, delay)` — `cordis-plugin-timer/src/index.ts:29`.

### 2.3 Composer slots and their props

- `conversation.input.right` — list, session scope, **no owner values**
  (`dsh-client-ui-conversation/src/client/contract/slots.ts:327`). The composer renders it with an
  empty owner object: `renderSlot('conversation.input.right', {})`
  (`src/client/skeleton/InputBar.tsx:541`).
- `conversation.input.dock` — list, session scope, owner `InputZone` = `{ session, input }`
  (`contract/slots.ts:307`; the interface is at `:451`). This owner share exists on the dock only.
- A session-scoped entry receives the standard kit (`contract/slots.ts:397`):
  `useConversation`, `useInput`, **`inputActions`**, plus whatever `inject` returns, plus `t` when
  `locale` is given. There is no `input` prop on `conversation.input.right`: the live draft, phase
  and attachment ids are read with the `useInput` selector hook
  (`const input = props.useInput(state => state)`), which is how the composer's own `InputBar`
  reads them (`InputBar.tsx:57`).
- Registration form, as used by the shipped docks
  (`src/client/queue/QueueDock.tsx:393`, `src/client/skeleton/TodoPanel.tsx:116`):

  ```js
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'queue', order: 20, locale: NS,
    inject: sessionId => ({ … }),
  }, Component))
  ```

  `inject` receives the session id, so this bundle takes the conversation id from there and keeps a
  `session.sessionId` fallback.
- Attachment hand-off: `dsh-client-ui-conversation/src/client/service.ts:479`
  `serializeDraftAttachments(ids)`. It throws for a vanished id and for an upload that has not
  finished, which the dialog reports instead of scheduling a partial attachment.

### 2.4 Shortcuts, locale, layout

- `ctx.shortcuts.register(command)` — `dsh-client-shortcuts/src/client/types.ts:137`; binding type in
  `src/binding.ts` (`{ code, secondCode?, modifiers }`), profiles
  `desktop|web × macos|windows|linux`. Command ids must match
  `^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$`.
- `ctx.locale.register(ns, dicts)` / `ctx.locale.bind(ns)` —
  `dsh-client-locale/src/client/index.ts:403`, `:459`. A dictionary is `Record<string, string>` with
  `{name}` placeholders.
- `ctx.layout.selectPanel('schedules')` — the Automation tasks page id, exactly as
  `dsh-client-ui-schedule/src/client/index.ts:76` defines it (`const PANEL_ID = 'schedules'`). The call
  throws when that panel is not registered, so it is wrapped.

<a id="3-host-design"></a>
## 3. Host design

### 3.1 Shape

`index.js` exports `{ name, inject: ['storageDomain'], apply(ctx) }`. `apply` opens one
`ctx.inject(['storageDomain', 'sessionController', 'connection', 'attachments', 'fileUploads'])`
scope for the whole feature and a nested `ctx.inject(['schedule'])` for Repeat, so a profile without
the Automation service still loads and answers `repeat-unavailable` instead of failing.

`lib/core.js` holds all logic that is not I/O: 12-hour conversion, wall-clock→instant resolution per
IANA zone, request validation, RRULE text, timer chunking, retention, title summary. It has no
imports, so the same file is unit-tested and inlined into the browser bundle.

### 3.2 Durable record

Domain `dsh_scheduled_message` (storage unit names are matched against
`^[a-z][a-z0-9_]*$` by `@deepseek-ai/dsh-storage`, so the hyphenated package name is not a legal
domain name — the smoke test asserts the pattern), version 1, table `messages`, keyed by record id:

```ts
{
  id, sessionId, dueAt, timeZone,     // dueAt is one absolute instant
  text, images: ImageAttachmentRef[], files: FileAttachmentRef[],
  createdAt, updatedAt,
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled',
  sentAt?, late?: boolean, error?: string
}
```

Rules: at most 500 `pending` records; `sent`/`cancelled` records are pruned after 7 days (at open and
after each delivery pass); a record left in `sending` by a crash is retried at the next start, and its
`requestId` (`dsm-<id>`) makes the retry idempotent.

The table's `valueSchema` is a plain object with a `parse` method rather than a zod schema: the
storage layer only ever calls `parse` (`dsh-storage-domain/src/index.ts:126`), so this keeps the
bundle installable with no runtime dependency while still validating every record that crosses the
durable boundary.

### 3.3 Routes

| Path (below `/api`) | Method | Body | Purpose |
|---|---|---|---|
| `/dsh-scheduled-message/create` | POST | streaming, 64 MiB cap | validate, convert attachments, store, re-arm |
| `/dsh-scheduled-message/list` | GET | `?sessionId=` | pending + failed + sending + sent within 24 h |
| `/dsh-scheduled-message/cancel` | POST | `{ id }` | pending or failed → cancelled |
| `/dsh-scheduled-message/reschedule` | POST | `{ id, dueAt }` | pending only; the new instant must be ≥30 s ahead |
| `/dsh-scheduled-message/send-now` | POST | `{ id }` | deliver now, under the delivery lock |
| `/dsh-scheduled-message/retry` | POST | `{ id }` | failed → pending at `now`, then deliver |

Every route answers `200` with `{ ok: true, value }` or `{ ok: false, error: { code, message } }`;
domain refusals are not HTTP failures, and the carrier already answers `401`/`403` before a handler
runs. Codes: `invalid-request`, `too-soon`, `empty`, `invalid-due-at`, `invalid-time-zone`,
`invalid-repeat`, `repeat-with-attachments`, `repeat-with-new-conversation`, `too-many-images`,
`invalid-images`, `invalid-files`, `text-too-long`, `invalid-session`, `invalid-target`,
`unknown-session`, `unknown-workspace`, `unknown-receipt`, `attachments-need-conversation`,
`repeat-unavailable`, `too-many-pending`, `not-pending`, `not-found`, `internal`.

### 3.4 Create flow

1. **Validate** (`validateCreateRequest`, pure, clock injected): the body names exactly one
   destination — the v1 `sessionId` or a v2 `target`, never both and never neither — plus an instant
   at least 30 s ahead, an absolute ISO instant, a real IANA zone, text ≤200 000 chars, ≤10 images,
   not empty, and no attachments when Repeat is on. A `kind: 'new'` target also refuses Repeat, which
   the Automation service can only create against one conversation that already exists.
2. **Resolve the destination.** A session target is resolved with `sessionController.resolveAgent`;
   a missing conversation is refused before anything is stored. A new-conversation target only checks
   that its workspace still exists (`unknown-workspace`), and its staged file receipts are refused
   (`attachments-need-conversation`): a receipt belongs to the conversation that uploaded it, and
   that is not the conversation this message will open. `sessionController.create` is **not** called
   here — a record that is cancelled must not leave an empty conversation behind.
3. **Repeat branch**: `ctx.schedule.create({ title: summariseTitle(text), prompt: text,
   timing: { kind: 'rrule', rrule }, target: { kind: 'session', sessionId } })` and answer
   `{ kind: 'automation', taskId, rrule }`. No scheduled-message record is written.
4. **One-shot branch**: `saveImages` for the browser-encoded images, `fileUploads.resolve` for each
   staged file receipt, then one `pending` record carrying the validated target, and a re-armed timer.

### 3.5 Timer

One `ctx.timer.timeout`, armed for the earliest `pending` (or crash-left `sending`) record:

- delay = `min(dueAt − now, 2^31 − 1)`, so a wait longer than `setTimeout` can hold fires early and
  re-arms;
- re-armed after open, after every create/cancel/reschedule/retry, and after every delivery pass;
- an arm sequence number makes a slower, older re-arm a no-op;
- no polling, no interval.

### 3.6 Delivery

Delivery is serialized through one promise chain, so two due records never interleave:

1. mark `sending` (durably) before any I/O;
2. rebuild the content: `{ type: 'text' }`, then one re-read image per reference
   (`readImage` → base64), then one re-staged file per reference
   (`uploadStream({ sessionId, data: readFileStream(ref) })` → `{ type: 'file', receiptId }`);
3. `sessionController.prompt({ requestId: 'dsm-<id>', mode: 'queue', content, clientTimeZone })`
   under a 120 s `AbortSignal.timeout`;
4. success → `sent` with `sentAt` and `late` (true when it settled more than 60 s after `dueAt`);
   failure → `failed` with a ≤500-character reason. Never auto-retried;
5. prune, then re-arm.

`mode: 'queue'` is what Enter does while an agent is running, so a busy conversation is not an error.

**What `sent` means.** `sessionController.prompt` resolves when DSH accepts the prompt into the
conversation's queue; it reports nothing about when the turn carrying it starts or finishes, and the
services this plugin injects expose no per-turn event to wait for. `sent` therefore records
acceptance — the last fact the plugin can observe — and the UI says **Accepted**, never Sent, Running
or Completed. Two messages due at the same instant are both accepted and run one turn after the other,
so the create and edit dialogs say so inline when another pending record targets the same conversation
within `CONFLICT_WINDOW_MS` (120 s, `lib/core.js`). No status value was added: a record written by an
earlier version keeps its stored status and still lists, edits and retries.

### 3.7 Lifecycle

One `ctx.effect` owns the timer and the domain handle: disabling the plugin stops the timer, removes
the routes, closes the domain and leaves every record on disk. Re-enabling re-arms from storage.

<a id="4-client-design"></a>
## 4. Client design

### 4.1 Bundle

`client.js` is generated by `scripts/build-client.mjs` from three sources: `client.src.js` (the
factory body), `lib/core.js` (inlined as a closure-scoped `core`) and `locale/*.json` (inlined as
`EN`/`ZH`). The artifact is committed, and both a unit test and `npm run check` fail when it is
stale, so the shared date logic really is one implementation instead of two.

The factory returns `{ name, inject: ['slots', 'locale'], apply }`. Everything registered in `apply`
is owned by `ctx.effect`, so a disabled plugin removes its styles, slots and shortcut.

### 4.2 Button and dialog

`ScheduleButton` registers into `conversation.input.right` (order 900). It reads the draft, the
attachment ids and the phase through the standard `useInput` selector hook, is disabled when there
is nothing to send or the composer is busy, and keeps the editor focus by cancelling `mousedown`.
A seat mounted without the hook (no composer context) falls back to an inert snapshot instead of
throwing.

The dialog is a `ReactDOM.createPortal` into `document.body` — the composer card clips fixed
overlays, so a portal is required, not cosmetic. It holds:

- header, and a message preview (first two lines plus an attachment count);
- quick picks: *In 1 hour*, *This evening 8:00 PM* (hidden once past), *Tomorrow 9:00 AM*,
  *Next Monday 9:00 AM*;
- `<input type="date">` with `min` = today in the browser zone, hour 1–12, minute in 5-minute steps,
  and an **AM / PM** segmented control;
- a **New conversation / This conversation** control styled like AM / PM, landing on *New conversation*.
  *New conversation* sends a `kind: 'new'` target built by `newConversationTarget` from the workspace
  that owns the conversation, so it is the same target shape the editor persists; the conversation is
  opened at delivery, exactly once, and reused on retry. *This conversation* is one click away and keeps
  the v1 request byte-identical (`sessionId`) — that is now the deliberate choice rather than the
  default. When the workspace cannot be named the option is disabled and the dialog says why — a path is
  never guessed — and the control falls back to *This conversation*. Attachments switch the copy, not the
  choice: a new conversation can carry images but not staged files, so picking it with attachments on
  shows that limit before the Host refuses the create (`attachments-need-conversation`);
- one quiet line when another pending message targets the same conversation within
  `core.CONFLICT_WINDOW_MS`. It is informational: the primary action stays enabled, because a second
  message simply queues behind the first turn;
- a summary line, red when the selection is in the past or under 30 s away, and red for a wall clock
  a DST gap removed (that case is refused rather than shifted);
- a **Repeat** checkbox with the frequency and a rule-specific note; the day-29–31 case notes that
  shorter months are skipped;
- footer with Cancel and the primary action, which becomes **Create automation** when Repeat is on.

**Peak-price notice.** The dialog also reads the Session's model selection —
`ctx.modelDirectories.directoryFor(sessionId).store`, the per-session directory the composer's model
seat and the `/model` popup already share — and, when that model id contains `deepseek` *and* the
chosen instant falls inside DeepSeek's published peak window, adds one orange line naming both
windows in the reader's zone. The published rule (`api-docs.deepseek.com/quick_start/pricing`, read
2026-11-14) is: off-peak rates are half the peak rates, peak hours are 01:00–04:00 and 06:00–10:00
UTC Monday to Friday excluding Chinese public holidays, and every other hour is off-peak. The
decision is `core.deepSeekPeakNotice` — model family, instant, zone in, notice or `null` out — so it
is unit-tested without a browser; the seat only renders what it returns. Two honest limits: Chinese
public holidays are not modelled (the copy speaks about the weekday clock rather than promising a
price), and a scheduled message carries no model of its own, so the note reflects the model selected
when the time was chosen.

Escape, the backdrop and the header button close it; Tab is trapped; focus returns to whatever was
focused before it opened. Submitting converts the selection with `core.wallClockToInstant` in the
browser's zone and sends one absolute instant, so the Host never has to guess a zone.

Success clears the draft and its attachments with `inputActions.setDraft('')` /
`removeAttachment(id)`, shows a self-clearing flash in this conversation's strip, refreshes the list, and
for Repeat opens the Automation task page. No session notice is pushed: a notice handed to the platform
cannot be retracted, so it stayed on screen after the record it described was deleted (§7.3). Failure keeps the draft, keeps the dialog open and shows the reason inline.

### 4.3 Shortcut

`dsh-scheduled-message.open`, label "Schedule message", aliases `schedule`/`later`/`deliver`,
`{ code: 'Enter', modifiers: ['alt'] }` as the default on all six profiles, `regions: ['editable']`,
`modals: []`. DSH's own Enter handler swallows Alt+Enter without a line break and without submitting
(`ui-conversation/src/client/input/editor/keymap.ts`), so the chord was free.

`resolve()` returns `pass` outside an editor, `blocked` with a localized reason when no composer is
mounted or when the draft is empty or mid-send, and otherwise `handled` with the mounted composer's
opener. Mounted composers register themselves while mounted; the last one that received text wins, so
a split view picks the conversation the user was last typing in.

### 4.4 Strip

`conversation.input.dock` (order 30). Collapsed it shows the count and the next due time; expanded it
lists rows with the preview, attachment icons, the time, and **Send now** / **Change time** /
**Cancel** (cancel asks once inline). Failed rows show the stored reason and **Retry**; rows settled in
the last 24 h are dimmed and read **accepted** (or **accepted late**) — the strip never claims the turn
finished. It refreshes on mount, after
each action, on window `focus`, and once about 2 s after the next due instant. No polling.

### 4.5 Styling and copy

All classes are prefixed `dsm-`; surfaces and text use `--dsw-alias-bg-*`, `--dsw-alias-border-*`,
`--dsw-alias-label-*` and `--dsw-alias-state-*`, so light and dark both work. `#F97316` (hover
`#EA6A0C`) is the only literal colour. Under 640 px the dialog becomes a bottom sheet with
`padding-bottom: max(16px, env(safe-area-inset-bottom))`, 44 px targets and 16 px inputs;
`prefers-reduced-motion: reduce` removes the sheet and button transitions. Every visible string goes
through the `dsh-scheduled-message` namespace, and times are formatted with
`Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone })`.

<a id="5-failure-and-edge-behaviour"></a>
## 5. Failure and edge behaviour

| Case | Behaviour |
|---|---|
| Composer busy (`phase !== 'plain'`) | Button disabled; shortcut reports "Wait for the message to finish sending". |
| Empty draft | Button disabled; shortcut reports "Type a message first". |
| File still uploading | `serializeDraftAttachments` throws → "Wait for uploads to finish"; draft kept. |
| Attachment vanished | Same path, distinct message; nothing is scheduled. |
| Agent running at due time | Delivered with `mode: 'queue'`, exactly like Enter. The record still reports acceptance, never a running state. |
| Two messages to one conversation, same instant | Both are accepted and run one turn after the other. Create and edit say so inline; nothing is refused. |
| A settled record | Reads **Accepted** (or **accepted late**). The plugin cannot observe the turn, so no row claims Sent, Running or Completed. |
| New conversation with attached files | Refused at create time (`attachments-need-conversation`): a receipt belongs to the conversation that uploaded it. |
| New conversation for a workspace that is gone | Refused at create time (`unknown-workspace`) instead of failing at the due instant. |
| Conversation archived or deleted | `resolveAgent`/`prompt` fails → `failed` with the reason; Cancel still works. |
| Model rejects images | `prompt` fails → `failed` with the host diagnostic. |
| Two tabs act on one record | The Host serializes; the stale call gets `not-pending` and the UI refreshes. |
| Browser and Host in different zones | Only one absolute instant is stored; the zone is kept for display and for `DTSTART`. |
| DST gap in the picker | The selection is refused with a red summary instead of being silently shifted. |
| DST/Host zone change | One-shots are unaffected; RRULE keeps wall-clock time through `DTSTART;TZID`. |
| Monthly repeat on the 29th–31st | `BYMONTHDAY`, with a note that shorter months are skipped. |
| Repeat with attachments | Blocked in the UI and in the Host validator. |
| DSH closed over a due time | Delivered at the next start, `late: true`. |
| Crash mid-delivery | The record stays `sending`; the next start retries it; `requestId` prevents a duplicate. |
| Plugin disabled | Timer and routes stop; records stay; enabling resumes. |

<a id="6-tests"></a>
## 6. Tests

`npm test` (87 tests):

- `test/core.test.mjs` — 62 tests. 12↔24-hour conversion including 12 AM/PM, a fixed-zone instant
  (09:00 in `Asia/Hong_Kong` → `01:00Z`), a round-trip across five zones and three dates, a DST gap
  refused, an ambiguous hour resolved, every validator rejection (past, <30 s, empty, >10 images,
  repeat with attachments, oversized text, bad zone, bad instant), RRULE text for all four
  frequencies including `DTSTART;TZID=`, `WKST`, `BYMONTHDAY`, nearest-due selection, timer chunking
  past 2^31−1, retention, the storage-unit-name pattern and the 120-character title summary.
- `test/client.test.mjs` — 24 tests. The committed bundle equals a fresh build; both dictionaries
  declare one key set; executing `client.js` through a `window.__ModuleLoader__` facade yields the
  documented plugin; `apply` registers exactly the button (`conversation.input.right`, order 900) and
  the strip (`conversation.input.dock`, order 30) and one shortcut with Alt+Enter on all six
  profiles, `pass` outside an editor and a `blocked` reason inside one with no composer; the
  registered button mounts with a fake input machine and is clickable exactly when `useInput`
  reports text or an attachment and the phase is `plain`; the bundle requires nothing outside the
  baseline table.
- `test/host.test.mjs` → `test/support/host-smoke.mjs` — 239 assertions against in-memory services:
  the six routes, six refusals that write nothing, a text create/list/deliver round trip with the
  derived request id and queued mode, a failed delivery plus retry with the same id, send-now,
  cancel and `not-pending`/`not-found`, reschedule and the 30 s guard, crash recovery from
  `sending`, an image and a file surviving to delivery, Repeat producing an Automation task with the
  expected title/target/RRULE and no local record, and a profile without the Automation service
  refusing Repeat while one-shots still work.

`npm run check` re-checks the bundle freshness, parses all four JS files, verifies the manifest
exports, the dictionary parity, that every `t('…')` key exists in both dictionaries, that promised
files exist, and that `lib/core.js` stays dependency-free.

<a id="7-verification"></a>
## 7. Verification

In 0.4.0, `npm test` reports **87 tests passing** (62 core, 24 client, 1 Host wrapper that runs
239 assertions), `npm run check` passes, and `node test/support/host-smoke.mjs` reports 239 assertions.
The 0.3.1 numbers were 81 tests (60 core, 20 client, 206 assertions); 0.2.x was 32 tests (26 core,
5 client, a 66-assertion Host wrapper).

### 7.1 Automated

- `node --check` on all four JavaScript files; both JSON dictionaries and the patch YAML parse.
- The bundle-freshness gate, the dictionary-parity gate and the `t('…')` key-coverage gate.
- The Host end-to-end smoke test (239 assertions) described in [§6](#6-tests).

### 7.2 Live, on an isolated DSH 0.2.2-rc.2 instance

A throwaway `web` profile was materialised under a temporary `DSH_HOME` (never the running profile,
never the user's data) and booted with the CLI:

```sh
DSH_HOME=<tmp> dsh --profile web --dump-config      # composition
DSH_HOME=<tmp> dsh --profile web --no-open --port 0 # real boot
```

Observed, in order:

1. `--dump-config` printed the `dsh-scheduled-message` layer and its inserted row, so the package was
   resolution-visible and `dsh.bundle.patch` composed without error.
2. The booted instance's `window.__DSH_BOOT__` contained
   `plugins/??dsh-scheduled-message/client.js&rev=3921005a625d`, which only happens when the Host
   entry activated and the module scanner resolved `exports["./client"]`.
3. `GET /plugins/??dsh-scheduled-message/client.js&rev=…` answered `200` with this bundle (71 956
   bytes).
4. `GET /api/dsh-scheduled-message/list?sessionId=…` answered `{"ok":true,"value":{"items":[]…}}`.
5. `POST /api/dsh-scheduled-message/create` with a real session answered
   `{"ok":true,"value":{"kind":"once",…,"status":"pending"}}`, and the real JSON storage backend wrote
   `storages/dsh_scheduled_message.json` with a record in the expected shape.
6. The real timer fired at the due instant: due `05:42:41.945Z`, sent `05:42:41.955Z`, `late:false`.
   The delivered text became that session's title, so the prompt really entered the conversation
   rather than only updating the record.
7. `POST create` with `repeat: "weekdays"` answered
   `{"kind":"automation","taskId":"schedule-…","rrule":"DTSTART;TZID=Asia/Hong_Kong:…T134500\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;WKST=MO"}`,
   so the real `RRule.parse` accepted the generated rule and a task was stored.
8. Startup delivery: a message due `05:44:05.839Z` while the Host was stopped was delivered at
   `05:44:35.698Z` on the next start; a second cycle with the Host down for over a minute (due
   `05:46:17.931Z`, sent `05:48:22.534Z`) recorded `late: true`.

That run found two real defects, both fixed and now covered by tests:

- the Host reached `ctx.timer` without declaring it, which cordis refuses
  (`cannot get property "timer" without inject`); `timer` is now in the inject list, and the Client
  half likewise takes `sessions` and `layout` from their own optional scopes instead of reading them
  off `ctx`;
- the storage domain was named `dsh-scheduled-message`, which `@deepseek-ai/dsh-storage`'s
  `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`) rejects; the domain is now `dsh_scheduled_message` and
  `test/core.test.mjs` asserts the pattern.

`rearm()` was also made non-throwing: a re-arm failure must not fail a create whose record is already
durable.

A third defect came from the running app after 0.1.0 shipped: the composer button rendered but never
became clickable, even with a message typed. The cause was the contract misreading in §8 — the seat
read `props.input`, which `conversation.input.right` never passes, so `draft` stayed `''` and
`disabled` stayed `true`. 0.1.1 reads the state with `props.useInput(state => state)` and mounts the
registered component in `test/client.test.mjs` to assert the enabled/disabled and tooltip outcome for
typed, empty, attachment-only and sending states. The live dialog, strip and shortcut are still not
observed (§7.3).

### 7.3 Not verified

1. **The dialog has never been rendered in a browser.** No screenshot, no focus-trap check, no
   light/dark visual check, no 375 px sheet check. The layout is CSS-only reasoning.
2. **Alt+Enter has not been pressed in a real editor**, and the strip has not been seen expanded.
   Their registrations are asserted structurally, and the shortcut's `resolve()` paths are unit
   tested, but no real keystroke was delivered.
3. **The session-notice path** (`conversation.input.for(scope).notify(...)`) was never observed, and is no
   longer used: a pushed notice is not something the plugin can retract, and the composer kept saying
   "Scheduled for …" after that record had been deleted. The strip and its scoped flash carry the message
   instead. `layout.selectPanel('schedules')` still runs only from browser interactions.
4. **A message with images or files has not been delivered by a real Host.** The re-read, re-upload
   and re-stage paths are covered by the smoke test's stand-ins only.
5. **A physical phone** was never used.

<a id="8-deviations-from-planmd"></a>
## 8. Deviations from PLAN.md

| Plan | Here | Why |
|---|---|---|
| `client.js` hand-written in one file | `client.src.js` + `scripts/build-client.mjs` → `client.js` | The bundle is lazy-CJS and cannot import `lib/core.js` or read JSON. Generating it keeps one implementation of the date/clock/RRULE logic, with a test that fails on drift. |
| `dependencies: { zod: 4.6.6 }` | no dependency; the table's `valueSchema` is a plain `{ parse }` | The storage layer only calls `parse` (`dsh-storage-domain/src/index.ts:126`), and the package then installs with nothing to resolve. |
| Button reads `useInput(s => s.draft)` | reads `props.useInput(state => state)` | 0.1.0 read `props.input`, which `conversation.input.right` never passes — its `renderSlot` owner is `{}` (`InputBar.tsx:541`) and only `conversation.input.dock` carries `InputZone`. That left the button permanently disabled; 0.1.1 restores the documented hook. |
| Six routes with mixed HTTP status codes | all six answer `200` and carry `{ ok: false, error }` | Domain refusals are not transport failures, and the carrier owns `401`/`403`. |
| `test/core.test.mjs` only | `core`, `client` and `host` suites plus `test/support/host-smoke.mjs` | The Host half had no execution coverage otherwise, and the generated bundle needed a freshness gate. |
| `list` returns "pending + failed + sent in the last 24 h" | same, plus `sending` | A record mid-delivery should stay visible in the strip instead of vanishing for a moment. |
| `version: 2` domain, migrated in place on open | `version: 2` **plus** `compatibleVersions: [1]` | The backend refuses a bare version mismatch, so a plain bump would have made the three stored v1 records unreadable. The unit is backed up under `.backup/` before the first v2 run. |
| "Change workspace" = existing conversation only, if creation is unavailable | also `kind:'new'` (new conversation at send time) | `@Remote('create')` and `SessionCreateRequest.workspaceId` are both present in this build, so D1's preferred branch was buildable. |
| A `/targets` route serving its own workspace data | `/targets` exists, but a conversation title is reported only when the build exposes one | `SessionSummary` carries no title and the title plugin is optional; short ids are shown instead of invented names. |
| Editor uploads "files" through `/upload` | images still travel as base64 in `/update`; only non-image files stream through `/upload` | The image limits, the 40 px thumbnail path and the v1 dialog all speak base64 images; mixing both would have doubled that code. |
| Repeating rows listed with a count | listed read-only when `ctx.schedule.list()` reports session targets, hidden when the service is absent | The plugin never stored the task ids v1 created, so claiming ownership would be a lie; `/repeating` reports what the service says. |
| Success "shows a notice" (§4.2) | a scoped, self-clearing flash in the strip, no session notice | A notice pushed into the composer cannot be retracted, so it outlived the record it described. |
<a id="9-v2"></a>
## 9. The Scheduled tab (v2, 0.3.0)

v1 schedules *this* composer's message. v2 adds one place to see and edit **every** scheduled
message: a **Scheduled** sidebar tab over all conversations, a full editor (time, text, images,
files, destination), moves between conversations, delivery into a conversation that does not exist
yet, and read-only repeating rows that point at Automation tasks.

### 9.1 Platform facts checked for v2

| Fact | Evidence in the shipped build |
|---|---|
| A sidebar tab is two registrations sharing one id: keyed `main` + `sidebar.panellist` (id, order, label) | `dsh-client-ui-schedule/src/client/index.ts:218-246`; order 10 is Automation tasks, so this plugin takes 11 |
| `ctx.layout.selectPanel(id)` selects a registered `main` key and throws for an absent one | `dsh-client-ui-layout/README.md:36,63` |
| A plugin may create an ordinary conversation on the Host | `dsh-api-session-controller/src/index.ts:306-309` (`@Remote('create')`), request `types.ts:268-277` (`workspaceId?` exclusive with `cwd?`, `sessionId?`, `agentPreset?`), value `:280-285` |
| Verbatim file storage with no admission cap | `dsh-attachment/src/index.ts:231`; the local provider implements it at `dsh-attachment-local/src/index.ts:240-241`; "Files carry no admission limits: any byte content and length is accepted" at `dsh-attachment/src/index.ts:208-212`; input type `types.ts:64-71` |
| Attachment refs are durable and session-free | `dsh-attachment/src/types.ts:11-32` (image: id, mediaType, bytes, width, height, name) and `:39-46` (file: id = sha256 of the exact bytes, name, bytes) |
| A domain may bump its version **and** still open older stored records | `dsh-storage-domain/src/spec.ts:49-56` (`compatibleVersions`), validated `:111-117`, forwarded to the unit descriptor `:157-161`; the backend rejects a bare version mismatch at `index.ts:85-93`, so `version: 2` alone would have stranded the v1 file |
| Session summaries carry **no title** | `dsh-api-session-controller/src/types.ts:154-167`; the only title producer is the optional `dsh-session-title-all-prompts-llm` plugin (`dsh-experimental-session-titles-bundle/cordis.patch.yml`) |
| Workspaces and their sessions | `dsh-workspace/src/index.ts:308` (`list()`), `types.ts:69-99` (`id`, `path`, `title`, ordered `sessionIds`), `:360` (`archivedSessionIds`) |

### 9.2 Record v2 and the upgrade

```ts
interface ScheduledMessageRecordV2 {
  id: string
  target: { kind: 'session'; sessionId: string } | { kind: 'new'; cwd: string; workspaceId?: string; title?: string }
  sessionId?: string   // the created conversation for kind 'new', written before the prompt
  dueAt: string; timeZone: string; text: string
  images: ImageAttachmentRef[]; files: FileAttachmentRef[]
  createdAt: string; updatedAt: string
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'
  sentAt?: string; late?: boolean; error?: string
}
```

- The domain is `version: 2` with `compatibleVersions: [1]`; `parseRecord` migrates a v1 record
  (`sessionId` only) to `target: {kind:'session'}` on the way in, so nothing is rewritten on disk and
  an older build still reads the file.
- `updatedAt` is the optimistic-concurrency token and strictly increases on every write
  (`nextUpdatedAt`), so two tabs cannot silently overwrite each other: the second save gets `conflict`.
- **Backup before the first v2 run.** The live unit was `~/.dsh/storages/dsh_scheduled_message.json`
  with descriptor `{"name":"dsh_scheduled_message","version":1}` and three settled v1 records
  (2096 bytes). It was copied — not moved — to `.backup/dsh_scheduled_message-v1-20261115-124303.json`
  before the new bundle was installed.

### 9.3 Routes

Thirteen, all under `/api/dsh-scheduled-message`, owner-only, all answering HTTP 200 with
`{ok:true,value}` or `{ok:false,error:{code,message}}` (only `/thumb` answers a real 404, because the
browser loads it as an image).

| Route | Method | Purpose |
|---|---|---|
| `/create`, `/list`, `/cancel`, `/reschedule`, `/send-now`, `/retry` | as v1 | the composer strip is unchanged; `/list` now selects by the *resolved* session, so a moved record leaves the old strip |
| `/list-all` | GET | every message the tab shows, `scope=all\|workspace&workspaceId=`; day grouping stays in the browser |
| `/get` | GET | one record for the editor, whatever its status |
| `/update` | POST | merge time/text/target/attachments under `expectedUpdatedAt`; `conflict`, `not-pending`, `empty`, `unknown-file` |
| `/upload` | POST | raw body → `ctx.attachments.saveFileStream` → `{fileId,name,bytes}`, staged 24 h / 200 files |
| `/thumb` | GET | one stored image's bytes, `cache-control: private, max-age=3600` |
| `/targets` | GET | workspaces with their non-archived conversations, newest first |
| `/repeating` | GET | session-targeted Automation tasks, read-only; `available:false` when the service is absent |

### 9.4 Delivery into a new conversation

`kind:'new'` calls `ctx.sessionController.create({workspaceId})` (or `{cwd}` when only a directory is
known), **persists the new `sessionId` and a fresh `updatedAt` before prompting**, and then delivers
with the same `requestId: 'dsm-' + id`. A crash between creating and prompting therefore leaves a
record that already names its conversation: the next attempt reuses it instead of opening a second
one, and the repeated request id is refused by the Session inbox.

### 9.5 Known limits

1. **Conversation names.** `SessionSummary` has no title, so `/targets` and `targetLabel` show a short
   session id unless a title projection is actually present. The tab never invents a name.
2. **"This workspace".** The control appears only when a conversation open in this page maps to a
   workspace through `/targets`; without that mapping the tab stays on All.
3. **Removing an attachment** drops the stored reference; the bytes follow DSH's own retention — this
   build has no attachment delete API.
4. **Repeating rows** are what `ctx.schedule.list()` reports for session targets. The plugin does not
   claim ownership (it does not remember the task ids v1 created), lists at most 50, and derives
   `enabled` from the task's `status`.
5. **Images in the editor** travel as base64 through `/update` under the provider's image limits; only
   non-image files use `/upload`.

### 9.6 Verification status for v2

All automated gates pass: 59 core tests, 19 client tests, the Host wrapper (206 assertions), the
static gates in `scripts/check.mjs`, and `test/support/host-smoke.mjs` (206 assertions, including a v1
record opening under the v2 schema and a `kind:'new'` delivery that creates exactly one session).

The tab was rendered in the live desktop GUI straight after the build: the sidebar entry, the page
and its day groups appeared. Opening a message then blanked the panel, and the cause was the
editor's first paint: with no record loaded yet there is no instant, and `describeDue` fell through
to `new Date(NaN).toISOString()`, which throws `RangeError: Invalid time value` inside a render and
takes the whole panel down. 0.3.1 fixes it at both levels — `describeDue` answers an empty string
for a non-finite instant (the fallback now has its own `try`), the editor formats a summary only
when it has one, and `test/client.test.mjs` renders the editor's first paint so it cannot come
back. A human look is still owed for the sheet/dialog/bottom-sheet layouts, the destination picker
against a real workspace list, and the phone layout on a real device.

### 9.7 Tests added for v2

- `test/core.test.mjs` — migration v1→v2 and its idempotence, `parseRecord` rejections, monotonic
  `updatedAt`, both target kinds, every validation code, `nothing-to-update`, day labels across a
  midnight boundary and a DST transition, group ordering, the 24 h sent window, pending counts.
- `test/client.test.mjs` — bundle freshness, dictionary parity and key coverage, both panel
  registrations, icon/badge, grouping and headings, card model, destinations, `buildUpdate`, the
  workspace→filter resolution and its scope URLs, repeating-group visibility.
- `test/host.test.mjs` + `test/support/host-smoke.mjs` — `/list-all` order and scope, `/get`, `/update`
  happy path + `conflict` + `not-pending` + `unknown-file` + empty-after-removal, `/upload` staging and
  pruning, `/targets`, `/repeating` availability and filtering, `kind:'new'` delivery including the
  crash-after-creation cycle.
