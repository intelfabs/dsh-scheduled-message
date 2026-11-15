# dsh-scheduled-message v2: Scheduled tab, plan

Handoff document for the next session. It builds on [PLAN.md](PLAN.md) and [docs/DETAIL.md](docs/DETAIL.md),
which describe the shipped v1 (Schedule button, dialog, composer strip, Host timer and store).
Read both first; this file only covers what changes.

- Package directory: `C:\Users\fungk\Downloads\dsh-scheduled-message`
- Web GUI seen in the planning session: `http://127.0.0.1:4676` (PLAN.md still says 8453; use the current one)
- User time zone: `Asia/Hong_Kong`
- Planning session: 2026-11-15. No plugin files were changed.

---

## 1. Goal

Add a **Scheduled** tab to the left sidebar that lists every scheduled message across all
conversations, in time order, and lets the user:

1. edit the send time,
2. edit the message: text, images, PDFs and other files (add and remove),
3. move the message to another workspace (and conversation),
4. send now, delete, retry a failed one.

The UI should be simple and quiet, close to Claude's: one centred column, few controls visible
at rest, actions on hover, one editor at a time.

### Out of scope

- Editing repeating messages. They are Automation tasks owned by DSH (`ctx.schedule`), text only.
  The tab lists them read-only with an "Open in Automation tasks" link (`layout.selectPanel('schedules')`).
- Changing the normal send path, the Schedule button or Alt+Enter.
- Polling, automatic retries.

---

## 2. Decisions (confirm with the user at the start of the session)

| # | Question | Default chosen in planning |
|---|---|---|
| D1 | What does "change workspace" do? | Picker offers **Workspace → existing conversation**, or **Workspace → New conversation** (created at send time). |
| D2 | Repeating messages in the tab? | Listed read-only, link to the Automation tasks page. |
| D3 | Show sent messages? | Last 24 h, dimmed, in a collapsed "Sent" group at the bottom. |
| D4 | Filter | "All" by default; a small toggle "This workspace" when a conversation is open. |

If the user picks differently, adjust §4.1 (target model) and §5.3 (list) only.

---

## 3. Platform facts found during planning (verify again before coding)

Read ASAR sources with the Electron runtime, as PLAN.md §2 describes:

```sh
cd "/c/Users/fungk/AppData/Local/Programs/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 ./"DeepSeek Harness.exe" -e "console.log(require('fs').readFileSync(process.argv[1],'utf8'))" "<abs path inside app.asar>"
```

Base: `…/resources/app.asar/dsh/node_modules/@deepseek-ai/`

### 3.1 Sidebar tab = two slot registrations with one id
DSH's own Automation tasks page is the reference (`dsh-client-ui-schedule/src/client/index.ts:218-246`):

```ts
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ ... }),
}, PageComponent))
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: PANEL_ID, order: 10, locale: NS, label: () => t('panel'),
}, IconComponent))
```

- `sidebar.panellist` is root-scoped. Icon component receives `PropsRuntime<'sidebar.panellist'>` incl. `size`
  (`TaskManagerIcon.tsx:14`). Label = visible text, accessible name and collapsed-rail tooltip
  (`dsh-client-ui-sidebar/README.md`, "Global panel entries").
- `main` is root-scoped keyed; `conversation` is the reserved key. `ctx.layout.selectPanel(id)` opens a
  panel, `null` returns to the conversation; an unregistered id throws (`dsh-client-ui-layout/README.md`).
- Entry pages pad their top by `--dsh-frame-top-clearance`, and by `--dsh-frame-leading-clearance` at the
  top-left on macOS (same README, "Window-chrome seat").
- Rows: 32 px expanded, 36 px on the collapsed rail. Order 10 is taken by Automation tasks; use **order 11**.

### 3.2 Workspaces and sessions
- Host: `ctx.workspaceRegistry.list()` → `Workspace[]` with `id`, `path`, `title`
  (`dsh-workspace/src/index.ts:308`, `types.ts:71-81`); `resolveByPath(path)` (`index.ts:524`);
  `workspace.attachSession(sessionId)`; `archivedSessionIds`.
- Host session creation: `createSession({ cwd, agentPreset? })` in
  `dsh-api-session-controller/src/agent.ts:229`. **Unverified**: whether the plugin-facing
  `ctx.sessionController` exposes it. Fallback: the Automation runtime's pattern
  (`dsh-schedule/src/runtime.ts:422-488`): create a session in `cwd`, then
  `(await registry.resolveByPath(cwd))?.attachSession(sessionId)`, logging but not failing on attach errors.
- Client: `sessions.create({ workspaceId? , cwd? })` exists
  (`dsh-api-session-controller/src/client/sessions/manager.ts:487-512`). `useWorkspaces` belongs to
  `ui-workspace` and is not a public plugin hook, so **the plugin serves its own `/targets` route** (§4.3).

### 3.3 Attachments
- Already used in v1: `ctx.attachments.saveImages`, `readImage`, `readFileStream`,
  `ctx.fileUploads.uploadStream({sessionId, data, name})`, `ctx.fileUploads.resolve(agent, receiptId)`.
- New in v2: `ctx.attachments.saveFileStream({ data, name?, signal? }) → FileAttachmentRef`
  (listed in PLAN.md §2.2). **Verify** it exists in this build and find its byte cap.
- Browser upload receipts are memory-only and bound to one session (PLAN.md §2.3). The tab has no
  composer, so it cannot use them; it uploads straight to the plugin's own route (§4.3).
- Stored refs are not tied to a session; v1 re-stages files into the *target* session at delivery time.
  **Moving a message to another conversation therefore needs no attachment work.**

### 3.4 Automation service (for the read-only repeating rows)
- `ctx.schedule` has `list`, `catalog`, `view`, `edit` (`dsh-schedule/src/index.ts:427-536`).
  v1 created tasks with `target: {kind:'session'}`. To list "ours", filter by the task ids v1 returned,
  or by `target.sessionId` and title. **Decide after reading `catalog` output** whether filtering is reliable;
  if not, show all session-targeted tasks with a link and no claim of ownership.

---

## 4. Host changes (`index.ts`, `lib/core.js`)

### 4.1 Record schema v2

```ts
interface ScheduledMessageRecordV2 {
  id: string
  target:
    | { kind: 'session'; sessionId: string }
    | { kind: 'new'; cwd: string; workspaceId?: string; title?: string }
  sessionId?: string        // filled for kind 'new' once the session is created (crash safety)
  dueAt: string
  timeZone: string
  text: string
  images: ImageAttachmentRef[]
  files: FileAttachmentRef[]
  createdAt: string
  updatedAt: string         // also the optimistic-concurrency token
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'
  sentAt?: string
  late?: boolean
  error?: string
}
```

- Bump the domain to `version: 2`. Migrate v1 records on read: `sessionId` → `target: {kind:'session', sessionId}`.
  Check how `dsh-storage-domain` handles a version bump (migration hook or not) before choosing between
  an in-place upgrade and a lenient `parse` that accepts both shapes. Lenient `parse` is the safe default.
- **Back up** the domain's data directory before first run with v2 (copy, do not move).
- `updatedAt` must strictly increase on every write (`max(now, prev+1)`), as `dsh-schedule` does
  (`index.ts:190-192`), so `expectedUpdatedAt` catches every concurrent edit.

### 4.2 Shared validation (`lib/core.js`)
Extract one `validateMessageContent({text, imageCount, fileCount, totalBytes})` used by both create and
update: text ≤ 200 000 chars, ≤ 10 images, non-empty, byte caps from `ctx.attachments.imageLimits`.
Add `validateTarget(target)` and `validateUpdateRequest(payload, nowMs)`. Keep everything pure and tested.

### 4.3 Routes (all under `/api/dsh-scheduled-message`, owner-only as before)

| Path | Method | Body | Purpose |
|---|---|---|---|
| `/list-all` | GET | `?scope=all\|workspace&workspaceId=` | Pending, sending, failed, sent ≤24 h, across sessions, sorted by `dueAt`. Each item adds `targetLabel: {workspaceTitle, sessionTitle}` and image thumbnails refs (ids only). |
| `/get` | GET | `?id=` | One record for the editor, incl. attachment names, sizes, media types. |
| `/update` | POST | `{id, expectedUpdatedAt, dueAt?, text?, target?, addImages?, addFileIds?, removeAttachmentIds?}` | Only `pending`. `conflict` when `expectedUpdatedAt` differs. Re-arms the timer. |
| `/upload` | POST streaming | raw bytes, `?name=` | `ctx.attachments.saveFileStream` → `{fileId, name, bytes}`. Kept in a short-lived "staged" table; dropped after 24 h if no record claims it. |
| `/thumb` | GET | `?id=&attachmentId=` | Image bytes for card thumbnails (`readImage`), `cache-control: private, max-age=3600`. |
| `/targets` | GET | — | `workspaceRegistry.list()` plus each workspace's non-archived sessions (id, title, last active), newest first. |

Existing `/list` (per session), `/cancel`, `/reschedule`, `/send-now`, `/retry` stay for the composer strip.
`/list` must also return records whose `target` moved away (so the strip drops them) — filter on the resolved
session id.

### 4.4 Delivery
- `kind: 'session'`: unchanged.
- `kind: 'new'`: if `record.sessionId` is empty, create the session in `target.cwd`, attach it to the
  workspace, **write `sessionId` to the record before prompting** (so a crash does not create a second
  session), then deliver as usual with `requestId: 'dsm-' + id`.
- Archived or missing target at send time → `failed` with a readable reason; the editor offers "Pick another
  conversation".

### 4.5 Limits and cleanup
- Keep `MAX_PENDING = 500`.
- Removing an attachment in `/update` only drops the ref. Check whether `ctx.attachments` offers deletion;
  if not, document that stored bytes follow DSH's own attachment retention.

---

## 5. Client changes (`client.src.js` → `node scripts/build-client.mjs` → `client.js`)

### 5.1 Registration
- `PANEL_ID = 'scheduled-messages'`.
- `main` + `sidebar.panellist` (order 11), both via `ctx.slots.inject` inside `apply`, same as §3.1.
- Icon: outline clock, 16/20 px, `currentColor`. When pending > 0, a small count badge.
- Composer strip (v1 `ScheduleDock`) gets a "View all" link → `services.layout.selectPanel(PANEL_ID)`.

### 5.2 Page layout

```
┌──────────────────────────────────────────────┐
│ Scheduled                       [All ▾]      │  title 20px/600, count in secondary colour
│ 3 messages waiting                            │
│                                              │
│ TODAY                                        │  group header 12px caps, secondary
│ ┌──────────────────────────────────────────┐ │
│ │ 9:00 PM   Summarise the PR review and …  │ │  time 14px/600 · preview 2 lines
│ │           ▣ dsh-plugins › PR review      │ │  target chip
│ │           🖼 ×2  📄 spec.pdf          ⋯   │ │  attachment chips · hover actions
│ └──────────────────────────────────────────┘ │
│ TOMORROW                                     │
│ …                                            │
│ ▸ Sent (2)                                   │  collapsed group, dimmed rows
│ ▸ Repeating (1)  → Automation tasks          │
└──────────────────────────────────────────────┘
```

- Max width 720 px, centred, 24 px side padding (16 px on phones).
- Cards: `--dsw-alias-bg-layer-1`, 1 px `--dsw-alias-border-l1`, radius 12 px, 14 px padding,
  hover `--dsw-alias-bg-layer-2`. No shadows.
- Hover/focus actions: **Send now**, **Edit**, **Delete** (icon buttons with tooltips). Always visible on
  `(hover: none)`. Clicking the card body opens the editor.
- Failed card: red left rule (`--dsw-alias-state-error-primary`), reason line, **Retry** and **Edit**.
- Sent late: small "sent late" label.
- Empty state: centred clock icon, "Nothing scheduled", hint "Write a message and press Alt+Enter to send it later."
- Loading: centred spinner first time; later refreshes keep the list and show nothing.
- Groups: Today / Tomorrow / weekday name for the next 6 days / full date after that,
  computed in the browser zone with `localParts` from `core.js`.

### 5.3 Editor
Right side sheet on ≥ 900 px (420 px wide, list stays visible), full-height bottom sheet below 640 px,
centred dialog in between. One editor open at a time.

Top to bottom:
1. Header: "Edit scheduled message", close ×.
2. **When**: reuse v1 quick picks + date + 12-hour time + AM/PM, and the summary line
   ("Sends Fri, 21 Nov at 9:00 AM, Hong Kong time"). Reuse v1 peak-price notice.
3. **Message**: auto-growing textarea (min 4 lines, max 50 vh).
4. **Attachments**: chips (image thumbnail 40 px / file icon + name + size) with ×; **Add files** button,
   drag-and-drop onto the editor, paste images. Each new file uploads immediately to `/upload` with a
   progress ring; Save is disabled until uploads finish. Images go as base64 in `addImages`
   (same limits as v1).
5. **Send to**: one button showing "Workspace › Conversation". Opens a popover: search field, workspaces as
   headers, conversations below (newest first), and "+ New conversation" per workspace.
6. Footer: **Delete** (text button, left, confirm), **Cancel**, **Save** (orange primary).

Behaviour:
- Esc / backdrop closes; unsaved changes → a blocking alertdialog "Discard changes?" (scrim, warning mark,
  filled red Discard, focus parked on Keep editing). The same dialog guards Delete.
- Save sends only changed fields with `expectedUpdatedAt`. On `conflict`: reload the record, keep the
  user's text in the textarea, show "This message changed in another tab. Review and save again."
- On `not-pending` (it was sent while editing): close the editor, show a notice, refresh.
- Focus trap, focus returns to the card that opened it.

### 5.4 Refresh
On panel open, after every action, on window `focus`, on `visibilitychange` to visible, and once ~2 s
after the next `dueAt`. No interval polling (same rule as v1). Share the v1 `bumpRefresh` signal so the
composer strip and the tab stay in step.

### 5.5 Style and locale
- Only `--dsw-alias-*` tokens; orange `#F97316` for the primary button only. Classes prefixed `dsm-`.
- Light/dark, `prefers-reduced-motion`, 44 px targets and 16 px inputs on coarse pointers, safe-area insets.
- Every string in `locale/en.json` and `locale/zh.json` (new keys under `panel.*` and `editor.*`).

---

## 6. Order of work

1. Verify the four unknowns (§7). Stop and re-plan if `saveFileStream` or session creation is unavailable.
2. `lib/core.js`: schema v2 helpers, migration, validators, day grouping. Unit tests first.
3. `index.ts`: schema + migration, `/list-all`, `/get`, `/targets`, `/thumb`. Host tests.
4. Client: sidebar entry + read-only page (list, groups, actions that already exist: send now, cancel, retry).
   Install and check in the GUI.
5. Host `/update` (time, text, target) + editor without attachments. Check in the GUI.
6. Host `/upload` + attachment editing.
7. `kind: 'new'` target delivery.
8. Repeating rows, polish, locale, phone layout.
9. Update README.md, docs/DETAIL.md, bump version to 0.2.0.

Each step ends with tests green and the bundle reinstalled, so a cut-off session still leaves a working plugin.

## 7. Unknowns to resolve first

| Unknown | Where to look | If missing |
|---|---|---|
| Plugin can create a session in a given `cwd` | `dsh-api-session-controller/src/index.ts` `@Remote` list, `agent.ts:229` | Drop "New conversation" (D1 becomes existing conversations only). |
| `ctx.attachments.saveFileStream` exists, and its cap | `dsh-attachment/src/index.ts` | Accept images only in the editor; files only via the composer. |
| Storage domain version bump behaviour | `dsh-storage-domain/src/index.ts`, `spec.ts` | Lenient `parse` accepting v1 and v2. |
| Session titles readable on the Host for `/targets` | `ctx.sessions` / session headers, `workspaceRegistry` | Show workspace title + short session id. |

Also confirm models in use accept PDFs as file parts; the plugin only passes files through.

## 8. Tests

- `test/core.test.mjs`: migration v1→v2, update validation (each field, empty result, too soon, too many
  images), target validation, day grouping across midnight and DST, `updatedAt` monotonic.
- `test/host.test.mjs`: `/list-all` order and filtering, `/update` happy path + `conflict` + `not-pending`,
  `/upload` cap and orphan cleanup, delivery to `kind:'new'` incl. crash after session creation
  (no second session, no duplicate prompt).
- `test/client.test.mjs`: grouping/ordering render, editor dirty state, conflict path.
- `node scripts/check.mjs` and `node test/support/host-smoke.mjs` as in v1.

## 9. Live checks (GUI)

1. Sidebar shows **Scheduled** below Automation tasks, expanded and collapsed rail, light and dark.
2. Schedule 3 messages in 2 workspaces; tab lists them in time order with correct day headers.
3. Edit time, text, remove an image, add a PDF; save; reopen shows the change.
4. Move one message to another workspace's conversation; it leaves the old strip, appears in the new one,
   and is delivered there with its attachments.
5. Move one to "New conversation"; at due time a new session appears in that workspace with the message.
6. Edit in two tabs; second save shows the conflict notice.
7. Close the tab before due time; messages still arrive.
8. 375 px width: bottom-sheet editor, no horizontal scroll, no zoom on focus.
9. Clean up every test message, session and attachment created.

## 10. Acceptance checklist

- [ ] Sidebar tab present, opens the page, label/tooltip localized.
- [ ] All scheduled messages listed across conversations, ordered by time, grouped by day.
- [ ] Time, text, images and files editable; changes survive restart.
- [ ] Workspace/conversation can be changed, including to a new conversation (if D1 kept).
- [ ] Concurrent edits detected, never silently overwritten.
- [ ] v1 records still deliver after upgrade; backup taken.
- [ ] Composer strip, Schedule button and Alt+Enter unchanged.
- [ ] EN + ZH complete; phone layout correct; tests green.
