Adds `intelfabs/dsh-scheduled-message` — a composer-side scheduler that sends a message later, or turns it into a repeating Automation task.

**What it does**

- A **Schedule** button beside Send in the composer tool row, plus **Alt+Enter** (Option+Enter on macOS) registered as an editable shortcut.
- A dialog with date, hour/minute, AM/PM, quick picks and a "Sends …" summary. The optional **Repeat** row creates a DSH Automation task instead of a one-off send.
- An orange **peak-price note** in the dialog when the Session runs a DeepSeek model and the chosen time lands in DeepSeek's weekday peak window (01:00–04:00 and 06:00–10:00 UTC); it names the window in the user's own time zone, and off-peak hours are half the rate.
- A strip above the composer listing pending sends, with **Send now**, **Change time**, **Cancel**, and **Retry** for a failed delivery.
- The record and the timer live in the Host — a storage domain plus one `ctx.timer.timeout` armed for the earliest pending record — so closing the tab does not cancel delivery, and a message that came due while DSH was closed is sent at the next start and marked sent late.
- English and Chinese dictionaries ship complete; composer surfaces use host tokens, with a bottom-sheet layout under 640 px.

**Gates**

- `dsh.bundle.patch: ./cordis.patch.yml` in `package.json`, with the matching `cordis.patch.yml` at the repo root (`- insert: - id: dsh-scheduled-message`).
- `dsh-plugin` topic set; the repo is public, not a fork, not archived.
- Published on npm as `dsh-scheduled-message` **0.2.0**, so `dsh plugin add dsh-scheduled-message` resolves.
- Repo age: created 2026-11-14T01:05:42Z, so the one-day bar is now met; this push re-runs PR check and the Submission gate against it.

**Category** — `workflow`: what the plugin changes is *when* a message is sent (durable host-side scheduling, plus an Automation task for repeats), not a new view or panel. Glad to have it re-filed by a maintainer if `ui` or `notify` fits better.