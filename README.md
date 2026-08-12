# cypress-inspect

Debug Cypress test failures from an LLM agent (Claude Code, Claude Desktop, VS Code, Cursor — anything with an MCP client).

Gives the agent the same toolkit a human uses when staring at a failing `cypress open`: read console, see screenshots, list the command log, click back through previous steps, inspect the DOM at any step, see all failures with their errors.

It works by attaching to Cypress's test browser via the Chrome DevTools Protocol. **No changes to your project's Cypress config are required.**

For failures that **only happen in CI**, there is no local runner to attach to — so
[cloud mode](#cloud-mode--when-a-spec-only-fails-in-ci) points the same idea at a
Cypress Cloud Test Replay recording instead, letting the agent read the recorded
console and screenshot the app at any point on the run's timeline.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Agent  (Claude Code · VS Code Copilot · any MCP client)     │
│                                                                 │
│   "get_failures"  "step_to"  "get_dom"  "screenshot"  …         │
└────────────────────────┬────────────────────────────────────────┘
                         │  MCP  (stdio JSON-RPC)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  cypress-inspect MCP server  (Node.js)                          │
│                                                                 │
│  • Reads ~/.cypress-inspect/session.json for the CDP port       │
│  • Maintains a live CDP WebSocket connection to Chrome          │
│  • Buffers Runtime.consoleAPICalled events (up to 5 000)        │
│  • Translates MCP tool calls → CDP commands / DOM queries       │
└──────────┬──────────────────────────────────┬───────────────────┘
           │ writes port on start             │ Chrome DevTools Protocol
           │                                  │ (WebSocket)
┌──────────▼────────────┐          ┌──────────▼───────────────────┐
│  cypress-inspect open │          │  Chrome  (Cypress test       │
│  (wraps cypress open) │          │  browser,--remote-debugging) │
│                       │  spawns  │                              │
│  Sets DEBUG=          ├─────────►│ ┌───────────────────────────┐│
│  cypress:server:      │          │ │   Spec Runner page        ││
│  browsers*            │          │ │   (window.Cypress lives   ││
│                       │          │ │    here)                  ││
│  Scrapes CDP port     │          │ │                           ││
│  from debug stdout    │          │ │  ┌────────────────────┐   ││
│  (ignores Electron's  │          │ │  │  Reporter DOM      │   ││
│   own port)           │          │ │  │  .test             │   ││
└───────────────────────┘          │ │  │  .command-wrapper  │   ││
                                   │ │  │  .runnable-err-*   │   ││
┌──────────────────────┐           │ │  └────────────────────┘   ││
│  Cypress Electron App│           │ │                           ││
│  (launchpad / project│           │ │  ┌────────────────────┐   ││
│   picker)            │           │ │  │  AUT iframe        │   ││
│                      │           │ │  │  (app under test)  │   ││
│  cypress-inspect     │           │ │  │  same-origin →     │   ││
│  ignores this port   │           │ │  │  no separate CDP   │   ││
└──────────────────────┘           │ │  │  target            │   ││
                                   │ │  └────────────────────┘   ││
                                   │ └───────────────────────────┘│
                                   └──────────────────────────────┘
```

### Where each data type comes from

| Tool / data | Source |
|---|---|
| Console logs (`get_console_logs`) | CDP `Runtime.consoleAPICalled` events, buffered as they arrive |
| Reporter warnings (`flakeSignals`) | Reporter DOM scrape — Cypress wraps `console.*` in the AUT iframe so those calls never reach CDP; the reporter command-log rows are the canonical source |
| Screenshots (`screenshot`) | CDP `Page.captureScreenshot` on the spec-runner page, with optional crop to the AUT iframe rect |
| DOM snapshot (`get_dom`, `find_in_aut`) | `Runtime.evaluate` on the runner page → reads `iframe.aut-iframe.contentDocument` |
| Test results & failures (`get_overview`, `get_failures`) | `Runtime.evaluate` walks the reporter DOM (`.test.runnable-failed`, `.runnable-err-message`, etc.) |
| Command log & time-travel (`get_test_commands`, `step_to`) | `Runtime.evaluate` reads `.command-wrapper` rows; `step_to` simulates a click on the target row to pin the AUT snapshot |
| Live test state (`get_live_commands`) | `Runtime.evaluate` → `window.Cypress.cy.queue` |
| AUT page info (`get_aut_info`) | `Runtime.evaluate` → `iframe.aut-iframe.contentWindow.location`, `document.title`, `readyState` |
| Network requests (`get_network_logs`) | CDP `Network.requestWillBeSent` / `responseReceived` / `loadingFailed` events, buffered (cap 2 000) |
| Storage snapshots (`get_storage`) | `Runtime.evaluate` → reads `localStorage` / `sessionStorage` / `indexedDB.databases()` from the AUT iframe |
| Failure classification | Pure heuristic over the failure payload + flake signals — `src/failure-classifier.js` |

## How it works

`cypress-inspect open` wraps `cypress open`, turns on Cypress's internal browser debug logging, and scrapes the test-browser's CDP port out of stdout. The port + project cwd are written to `~/.cypress-inspect/session.json`.

`cypress-inspect mcp` runs an MCP server over stdio. It reads the session file, attaches to that CDP port, watches for console events, and exposes a curated toolset to the agent — most of which are short reads against the running spec runner's DOM and `window.Cypress`.

> **Cypress 15 architecture note:** `cypress open` launches an Electron App first (the project picker / launchpad). When you pick "Chrome", Cypress spawns a *separate* Chrome process for the spec. cypress-inspect discards the Electron port and locks onto the Chrome process. `Cypress.cy`, `Cypress.mocha`, and the reporter UI all live on the spec-runner page; the app-under-test is a same-origin iframe (`iframe.aut-iframe`) inside it.

## Install

```bash
git clone <this repo> ~/projects/pet-projects/cypress-inspect
cd ~/projects/pet-projects/cypress-inspect
npm install
```

### Expose the `cypress-inspect` command globally (recommended)

Run this once from the cloned repo directory:

```bash
cd ~/projects/pet-projects/cypress-inspect
npm link
```

`npm link` symlinks the `cypress-inspect` binary into your global Node bin directory (e.g. `/usr/local/bin/cypress-inspect` or `~/.nvm/versions/node/<v>/bin/cypress-inspect`), so you can run it from *any* project:

```bash
which cypress-inspect          # confirm the symlink resolves
cd ~/projects/my-webapp
cypress-inspect open           # launches Cypress for the project you're in
```

To remove the global symlink later: `npm unlink -g cypress-inspect` (from anywhere) or `npm unlink` from the repo.

### Claude Code

Register globally (works across all worktrees and projects):

```bash
claude mcp add --scope user cypress-inspect cypress-inspect mcp
```

(That's not a typo — `cypress-inspect` is both the MCP server name and the linked binary. If you skipped `npm link`, substitute `node /absolute/path/to/cypress-inspect/bin/cypress-inspect.js` for the binary.)

Verify with `claude mcp list` and `/mcp` inside a Claude session.

### VS Code Copilot (GitHub Copilot Chat)

VS Code reads MCP server definitions from a `.vscode/mcp.json` file at the workspace root, or from your user settings. Choose the scope that fits.

**Workspace-level** (committed to the repo — good for teams):

Create `.vscode/mcp.json` in your webapp project:

```json
{
  "servers": {
    "cypress-inspect": {
      "type": "stdio",
      "command": "cypress-inspect",
      "args": ["mcp"]
    }
  }
}
```

(Requires `npm link`. Without the link, replace `"command": "cypress-inspect"` with `"command": "node"` and `"args": ["/absolute/path/to/cypress-inspect/bin/cypress-inspect.js", "mcp"]`.)

**User-level** (applies to every workspace you open):

Open VS Code settings (`Cmd+,`), switch to JSON (`Open User Settings (JSON)`), and add:

```json
{
  "mcp": {
    "servers": {
      "cypress-inspect": {
        "type": "stdio",
        "command": "cypress-inspect",
        "args": ["mcp"]
      }
    }
  }
}
```

After saving, open Copilot Chat, switch to **Agent mode** (`@` → select the agent), and the `cypress-inspect` tools will appear in the tool picker. You can also reference them explicitly: `Use cypress-inspect get_overview to show me the failing tests.`

## Use

1. In your webapp project, launch Cypress through the wrapper:

   ```bash
   cd ~/projects/my-webapp
   cypress-inspect open
   # or: cypress-inspect open -- --e2e --browser chrome
   ```

   The Cypress App opens. Pick a browser → pick a spec. You'll see a line like:

   ```
   [cypress-inspect] Detected CDP port: 49948
   ```

2. In your agent, ask it to investigate. A good starter prompt:

   > "A Cypress test failed. Use cypress-inspect MCP to debug it and fix it."

### `cypress run` mode (experimental, opt-in)

`cypress-inspect open` is the default and fully-supported path. There is also an
**opt-in** `run` subcommand for inspecting a `cypress run` execution:

```bash
cypress-inspect run -- --spec test/cypress/integration/run/my-spec.cy.js
```

It is **not** enabled by default — you must explicitly invoke `run`. Under the
hood it forces the flags that make a `cypress run` browser inspectable and adds
the same CDP attach you get in `open` mode:

```
cypress run --headed --no-exit --browser chrome --config numTestsKeptInMemory=50
```

| Flag | Why it's forced |
|---|---|
| `--headed` | Keep a real Chrome with the reporter DOM + AUT iframe (not headless). |
| `--no-exit` | Keep the runner/browser **alive after the spec finishes** so you can inspect it. Default `cypress run` tears the browser down and exits — leaving nothing to attach to. |
| `--browser chrome` | The CDP attach target (same as open mode). |
| `--config numTestsKeptInMemory=50` | Default `cypress run` sets this to **0**, which garbage-collects the command log **and time-travel snapshots** immediately. 50 keeps them so `step_to` / `get_test_commands` / before-after work. |

Each forced flag is skipped if you supply your own (e.g. `-- --browser chrome --config video=false` — your `--config` is merged, not clobbered).

**Drawbacks of run mode** (also printed at launch):

- **Multi-spec runs leave only the *last* spec inspectable.** `cypress run` executes every matched spec sequentially and only the final browser state survives — always pass `--spec <one spec>`.
- **`rerun_spec` cannot re-trigger a run-mode spec.** Run mode has no reporter "Rerun" button; it would fall back to `location.reload()`, which doesn't cleanly restart a run. Re-launch `cypress-inspect run` instead.
- **Chrome only.** A non-Chrome `--browser` (e.g. `electron`) has no compatible CDP attach and won't be inspectable — the launcher warns if you override it.
- **Kept open via `--no-exit`.** The browser stays up until you close it / Ctrl-C the launcher.
- **Pure headless CI `cypress run` is intentionally unsupported.** Without `--headed --no-exit` there's no persistent browser to attach to; for that, use Cypress's own failure screenshots/videos.

### Cloud mode — when a spec only fails in CI

Some failures never reproduce locally. The evidence then lives in a **Cypress Cloud
Test Replay** recording, not in a runner you can attach to — which is why the usual
workaround is to add `console.log` markers, push, wait for the pipeline, then dig
through the Cloud UI by hand.

Cloud mode automates the digging half:

```bash
cypress-inspect cloud
# or straight to a replay:
cypress-inspect cloud "https://cloud.cypress.io/projects/…/test-results/…/replay?…"
```

This launches a **separate** Chrome with CDP enabled on a **persistent profile**
(`~/.cypress-inspect/cloud-profile`), so you sign in to cloud.cypress.io once and
stay signed in. Paste a Test Replay link into that window (or pass it as an
argument / call `cloud_open`), then let the agent work:

> "This spec only fails in CI. Here's the Test Replay link — use the cypress-inspect
> cloud tools to find why."

It is **fully isolated from `open` / `run`**: its own browser, its own session file
(`~/.cypress-inspect/cloud-session.json`), and a fixed port **9333**. Both modes can
be live at the same time and neither can clobber the other's CDP port. `--port` gives
you a second, independent cloud browser; `CHROME_PATH` overrides browser discovery.

**The loop it enables.** `cloud_console_logs` prefixes every line with the moment it
fired and a ready-to-use timeline fraction, so finding a log and *seeing the app at
that instant* is two calls:

```
cloud_console_logs { grep: "#2317-gf-debug" }
  # console: 282 rows on the panel, 6 matched /…/i, showing 6
  #   (panel via console-tabpanel/virtualized-list, strategy event-id, 47 scroll steps)
  # [ 30.22s f=0.5369] toggleDropdown: "unknown field" isOpen=false, targetOpenState=true
  # …

cloud_seek { fraction: 0.5369 }        # jump to that moment
cloud_screenshot { kind: "app" }       # see the app exactly there
```

Or seek by wall-clock offset directly — `cloud_seek { offsetMs: 7293 }` for "7293 ms
into the run".

| Tool | Use |
| --- | --- |
| `cloud_status` | Browser alive? Which page? Is it a drivable replay (`isReplay`)? Signed in (`looksLoggedOut`, `authHost`)? **Start here.** |
| `cloud_open` `{ url }` | Navigate to a Test Replay link and wait for the timeline to hydrate. |
| `cloud_console_logs` `{ grep?, limit?, maxScrollSteps? }` | The recorded console output. Selects the Console tab for you and scrolls the virtualised list end to end. `grep` is a case-insensitive regex; omit for everything. Each line carries `[<sec> f=<fraction>]`. |
| `cloud_timeline` | Scrubber bounds + position (`durationSec`, `positionSec`, `fraction`) and the app frame's scroll metrics. |
| `cloud_seek` `{ offsetMs? \| fraction? \| timeMs?, scrollTo? \| scrollBy?, waitMs? }` | Seek the replay, then scroll the app frame. `offsetMs` is ms from the start of the run (usually what you want); `fraction` is 0..1; `timeMs` is an *absolute* epoch scrubber value. Returns `ok`, where it landed, and the replay's own `timer`. |
| `cloud_screenshot` `{ kind?, saveTo? }` | PNG of the whole replay (`full`) or clipped to the app frame (`app`). `saveTo` also writes it to disk. |
| `cloud_get_commands` `{ grep?, failedOnly?, offset?, limit? }` | The numbered command log for the replayed test. Same shape as the local `get_test_commands`. |
| `cloud_step_to` `{ index? \| number? \| grep? }` | Scroll a command into view and click it, pinning its snapshot so the app frame shows that step. Verifies the pin landed. |
| `cloud_list_tests` | Every test in the run, with suite, title and status. |
| `cloud_select_test` `{ index? \| grep? }` | Replay a different test from the same run — no new URL needed. |
| `cloud_eval` `{ expression }` | Escape hatch for Cloud UI panels the tools above don't cover. |

**Stepping through commands.** Seeking by time is right when you know *when*; usually
you know *what* — "the step where it clicked submit". So the command log is drivable
too, and pinning a command renders the app exactly as it was at that step:

```
cloud_get_commands { grep: "submit" }
  # commands: 181 total, 3 matched, showing 3 from offset 0 (nothing pinned)
  # [ 88]   61      click            submit [at support/commands-publish.js:120:8]
  # …

cloud_step_to { index: 88 }            # pins it; returns ok + the replay timer
cloud_screenshot { kind: "app" }       # the app at that step
```

`cloud_list_tests` + `cloud_select_test { grep: "…" }` then move to another test in the
same run, after which every other cloud tool addresses the newly selected test.

**Five things worth knowing:**

- **Pinning a command uses a scripted click; seeking needs trusted events.** They look
  alike but fail differently — React's `onClick` fires for untrusted clicks, so pinning
  works from page script, whereas the scrubber's problem is React re-rendering a
  *controlled input's value*, which no scripted event can defeat. Both paths verify
  they landed rather than assuming.

- **Seeking uses trusted pointer events, not scripted ones.** The scrubber is a
  *controlled* React input: assigning `.value` from page script is ignored, because
  React re-renders the previous value straight back. So `cloud_seek` presses the track
  through CDP's `Input` domain like a real user, then polls until the position settles
  (the value updates asynchronously — read too early and you get the *previous*
  moment). It reports `ok`, where it landed, and the replay's own on-screen `timer` as
  independent evidence the replay actually moved.
- **The Console tab is selected automatically.** The replay devtools drawer opens on
  *Network*, so the console rows aren't in the DOM at all until the tab is clicked.
  Without this, the first scrape of a session silently returns the test tree instead.
- **`cloud_seek` scrolls as well as seeks, deliberately.** Seeking triggers an async
  re-render that resets the app frame's `scrollTop`, so a separately-issued scroll
  silently does nothing. Seek → wait → scroll (re-asserted, since the replay can
  restore scroll on a rAF) is one call so the ordering can't be got wrong.
- **Repeated log lines are preserved.** Rows are keyed on the list's own
  `data-cy-event-id`, so a line that legitimately fired twice stays twice — which is
  exactly the signal you want when hunting a loop that ran more often than it should.

## Tools (v0.10)

Every tool carries an MCP [annotation](https://modelcontextprotocol.io/docs/concepts/tools#tool-annotations) so clients can reason about it before calling. Read-only tools are marked `readOnlyHint: true` (clients may auto-approve them). The three tools that re-run a spec or wipe app state — `clear_app_state`, `rerun_spec`, `reset_and_rerun` — are marked `destructiveHint: true` and their descriptions begin with **"⚠ REQUIRES HUMAN APPROVAL — do not run autonomously"** so an agent won't trigger runs on its own. `eval` is neither (it can mutate), so clients should prompt for it. **The actual gate is your MCP client's permission system** — e.g. in Claude Code, leave these tools off the allowlist so each call prompts; the annotations/warnings just make that the obvious default.

### Orientation
| Tool | Use |
| --- | --- |
| `status` | Session info + attached CDP targets. Always call if something returns "no Cypress". |
| `get_overview` | **Start here.** Spec file, pass/fail/pending counts, first failure (title + suite + error + stack + code frame), live test if any. |
| `get_failures` `{ dedupe? }` | All failed tests with error/stack/code-frame. Auto-tags `rootCause: true` on the first failure + `looksLikeCascade` / `cascadeOf` on downstream ones. Each failure also includes:<br>• `relatedCommandIndex` / `relatedCommandNumber` pointing at the failed command in the reporter so the agent can `step_to` directly<br>• `cypressDocsHints: [{ command, url }]` linking every `cy.<command>` mentioned in the error to its docs page<br>• `classification: { category, confidence, explain, evidence }` — stable named cause (`compare_diff`, `dropdown_ambiguity`, `selector_not_found`, `route_mismatch`, `network_failure`, `timeout_cascade`, `stale_local_state`, `unknown`)<br>Compare-style errors are parsed into `parsedDiff.diffs: [{ path, pathSegments, expected, actual }]`. Top-level `flakeSignals` is populated from TWO sources merged by id: the CDP console buffer **and** the reporter command-log (`/WARNING:/i` rows) — important because Cypress wraps `console.*` in the AUT iframe so the CDP buffer often misses warnings. Matching IDs also attach to the root failure. `dedupe: true` adds `rootCauses: [<index>]` and splits cascading failures into a separate array. |
| `get_failure_context` `{ failureIndex \| testIndex, commandIndex?, before?, after?, mode? }` | The N commands before and M after the failing command (defaults 5/5). **`failureIndex` is the position in the `get_failures` array** (0 = first failure); falls back to test reporter index. `mode: "logical"` (default) counts UNIQUE displayed command numbers — what a human sees in the reporter. `mode: "wrappers"` counts raw DOM rows (Cypress emits 2-3 wrappers per command, so 5/5 can balloon). Skips the manual slice after `get_failures`. |
| `parse_compare_error` `{ message }` | Standalone parser for "Compare - FAILURES" / "InProgress Summary Widget comparison failed" strings. Returns `{ summary: { failed, total }, diffs: [...] }`. |
| `list_tests` | Lightweight list of every test with state + title + suite ancestry. Use returned `index` with the next two tools. |
| `find_test` `{ query }` | Partial-title search across tests. Returns matches with index + state. Faster than scanning `list_tests`. |

### Command log
| Tool | Use |
| --- | --- |
| `get_test_commands` `{ index, full? }` | Commands rendered for the test at that reporter index. Each entry has `number` (display, may repeat across rows), `index` (unique DOM position), plus `argTruncated`/`argLength` markers. `full: true` returns untruncated args + text. Response also includes `numberToIndex` to resolve a displayed reporter number to a DOM index. |
| `get_test_commands_summary` `{ index? \| forFirstFailure? }` | Triage view: one row per UNIQUE displayed command number (`name`, short `arg`, `state`). Designed for complex tests where the full command list busts the token budget. `forFirstFailure: true` resolves the test for you (skips a `list_tests` round-trip). Also surfaces `firstFailedNumber` for fast `step_to`. Emits a `_warning` when the result is empty (typically a GC'd post-run panel). |
| `get_test_commands_page` `{ index, page?, pageSize?, full? }` | Paged variant of `get_test_commands` — returns one slice at a time with `start/end/total/hasMore`. Use when `get_test_commands` would truncate. |
| `get_live_commands` | `Cypress.cy.queue` for the in-flight test only. |
| `step_to` `{ failureIndex \| testIndex, commandIndex?, commandNumber? }` | Time-travel: pin the AUT snapshot to that command. `failureIndex` (position in `get_failures`) is the shortest path — auto-resolves test + command. Otherwise pass `testIndex` + `commandNumber` (the visible reporter number — preferred) or `commandIndex` (raw DOM position, to disambiguate duplicate rows). Expands the panel if collapsed. |
| `expand_test` `{ index }` | Open a test panel without pinning a command. Useful when you just want to read commands or the error block. |
| `get_pinned_command` | Returns which command is currently pinned (driving the AUT snapshot). Sanity check after `step_to`. |

### Console / visual / DOM
| Tool | Use |
| --- | --- |
| `get_console_logs` `{ level?, grep?, since?, limit? }` | Buffered console events since the MCP server attached. Response always includes a capture-status header (`attached Xs ago, N events seen, M buffered, K contexts on T target(s)`); when the buffer is empty, full diagnostics are returned so callers can distinguish "nothing matched the filter" from "capture is broken". |
| `screenshot` `{ kind?: 'full' \| 'aut' }` | PNG of the whole runner viewport, or just the AUT iframe. |
| `list_saved_screenshots` / `read_saved_screenshot` | Cypress's `cypress/screenshots/` artifacts (relevant for `cypress run` mode). |
| `get_dom` `{ selector?, maxBytes? }` | Rendered HTML of the AUT iframe at the currently-pinned snapshot. |
| `find_in_aut` `{ selector, limit?, textOnly? }` | Run a CSS selector against the AUT. Default: compact JSON per match (tag, attrs, text, textTruncated, textLength, value, visible, disabled). `textOnly: true` returns just the **full untruncated text** of each match — best for summary widgets or anything where you only care what the user reads. |
| `get_aut_info` | AUT iframe src + location (href/pathname/hash/search) + document.title + readyState + navigator.onLine. Also returns a `capture` block with attached targets, execution contexts (with origin / aux frame data), and total events seen — useful for diagnosing why a console.* call might not be reaching the buffer. |
| `get_failure_dom` `{ failureIndex, selector?, maxBytes? }` | Convenience: `step_to` the failing command, then `get_dom`. Returns the AUT DOM at the moment of failure in one tool call. |

### Network
| Tool | Use |
| --- | --- |
| `get_network_logs` `{ grep?, since?, statusMin?, statusMax?, failedOnly?, limit? }` | CDP-buffered HTTP requests. Filter by URL regex, status range, or `failedOnly: true` (failed OR ≥400). Each row: method / url / status / mime / durationMs / failed / failureText. Bodies are NOT captured — use `eval` if needed. Empty response distinguishes "filter excluded everything" from "buffer empty since attach"; the latter is the usual surprise. |

### App state / control
| Tool | Use |
| --- | --- |
| `get_storage` | Snapshot of localStorage, sessionStorage, cookies, and IndexedDB database **names** from the AUT iframe. Each value clipped to 1 KB. Use to diagnose stale-state flakes (cached auth, partially-synced PouchDB databases). For object-store contents see `get_indexeddb`. |
| `get_indexeddb` `{ dbName, store?, limit?, valueMaxBytes? }` | Open an IndexedDB database and either list its object stores (omit `store`) or dump records from one store (default 25, max 500). Values are JSON-stringified and clipped to `valueMaxBytes` (default 2 KB). Designed for PouchDB / offline-queue debugging without writing eval payloads. |
| `clear_app_state` `{ skipDatabases?, skipLocalStorage?, skipSessionStorage?, skipCookies? }` | **⚠ Requires human approval — write operation.** Clears localStorage, sessionStorage, cookies, and IndexedDB databases in the AUT. ⚠ Some DBs (e.g. `auth`) hold persisted permission state like `permissionStatuses.geolocation: true` — wiping them can silently break GPS-dependent tests. Pass `skipDatabases: ["auth"]` to preserve those. |
| `rerun_spec` `{ await?, timeoutMs?, forceReload? }` | **⚠ Requires human approval.** Re-run the current spec from the top. Tries clicking the reporter's "Rerun all tests" button first; if that doesn't actually restart, **auto-escalates to `location.reload()`** within the same call — no second round-trip. Pass `forceReload: true` to skip straight to the reload. Returns `{ actuallyStarted, escalatedToForceReload, attempts: [...] }` so the agent sees exactly what happened. |
| `reset_and_rerun` `{ timeoutMs?, forceReload?, skipDatabases? }` | **⚠ Requires human approval.** `clear_app_state` then `rerun_spec` with the same auto-escalation. Returns both reports. `skipDatabases` preserves named IndexedDB databases (e.g. `["auth"]`). |
| `wait_for_failure` `{ baseline?, timeoutMs?, pollMs? }` | Block until the failure count grows past `baseline`, then return the new failure. On timeout, response now includes `currentCounts` + `finishedCleanly` so callers can distinguish "still running" from "spec passed". For a positive "wait until finished" signal use `wait_for_completion`. |
| `wait_for_completion` `{ timeoutMs?, pollMs? }` | Block until every test has a final state (`unknown === 0 && running === 0 && total > 0`). Returns `{ completed: true, passed: bool, counts, firstFailure }`. The canonical "wait for the spec to finish" primitive. Default timeout 180 s. |

### Docs & static analysis
| Tool | Use |
| --- | --- |
| `cypress_docs` `{ topic }` | Fetch the canonical Cypress doc page for a command or topic from `docs.cypress.io`, preferring the LLM-friendly markdown mirror under `/llm/markdown/...`. Topics: `cy.intercept`, `intercept`, `session`, `retries`, `best-practices`, `selectors`, etc. Use **before** asserting "Cypress can / cannot X" — the docs are the source of truth, not training data. |
| `analyze_spec` `{ path? \| source?, maxTestLines? }` | Static lint of a Cypress spec against the [cypress-io/ai-toolkit](https://github.com/cypress-io/ai-toolkit) explain-test rules: brittle selectors (no `data-cy`), `cy.wait(<number>)` literals, missing assertions, `await cy.*` (Cypress chains aren't real Promises), `null` dropdown args (random-selection flake), `.only`/`.skip` left in, UI-only login setup without `cy.session`/`cy.request`, overlong tests. Returns `{ smells, summary, tests }` — pair with `get_failures` to correlate static smells with runtime failures. |

### Escape hatch
| Tool | Use |
| --- | --- |
| `eval` `{ expression }` | Arbitrary JS on the spec-runner page (where `window.Cypress`, the reporter DOM, and the AUT iframe all live). Use when the curated tools don't cover something. |

## Suggested debug flow for the agent

```
1. status              → confirm spec runner target present
2. get_overview        → spec + first failure + counts
3. get_failures        → if more than one failed, get them all
4. list_tests          → find the index of a specific test you want to dig into
5. get_test_commands i → see the command list, find the failed command's index
6. step_to i j         → pin the AUT to that step
7. get_dom + screenshot aut → see what the app looked like at that step
8. get_console_logs grep:"error" → cross-reference any browser errors
```

## Limitations / caveats

- **Cypress version**: written and verified against Cypress 15. Reporter class names (`.test.runnable.runnable-failed`, `.command-wrapper`, `.runnable-err-message`, etc.) are private to Cypress and may shift across versions — if a tool returns empty/`total: 0`, run the `eval` tool to discover the new class names and either tell the user or open a PR to `src/cypress-probe.js`.
- **Chrome only** (both `open` and `run` modes). Electron mode's CDP port isn't announced the same way. Pass `--browser chrome` (the wrapper adds it automatically).
- **`cypress run` support is experimental and opt-in** via the `run` subcommand — see [`cypress run` mode](#cypress-run-mode-experimental-opt-in) for the forced flags and drawbacks (multi-spec only keeps the last spec; `rerun_spec` can't re-trigger a run; headless CI runs are unsupported).
- **Port-scrape fragility**: detection relies on Cypress's `cypress:server:browsers*` debug strings. If those change, you'll see no `[cypress-inspect] Detected CDP port:` line.
- **Console buffer is in-memory, capped at 5,000 entries**. Logs from before the MCP server attached are not captured. Best practice: start the MCP server, then run the failing spec.
- **Network buffer is in-memory, capped at 2,000 entries**. Same "since attach" caveat — `get_network_logs` will warn when the buffer is empty so the agent doesn't blame its filter.
- **Cypress garbage-collects test panels after a spec completes.** `get_test_commands*` returns empty for finished specs; trigger `rerun_spec` (or `reset_and_rerun`) to repopulate.
- **Re-launching Chrome** (close → re-pick spec in the Cypress App) is handled automatically: the launcher writes the new CDP port to `~/.cypress-inspect/session.json` and the MCP server re-attaches on the next tool call. If the very next tool returns "no CDP target", give the new Chrome 1-2 s and retry — the auto-rebind needs the new spec runner page to load.
- **Mid-call WebSocket drops** (Chrome briefly hangs, the launchpad opens a new tab) trigger a single auto-retry inside `evalOnRunner` — the affected tool call should still succeed without bubbling the raw `ECONNREFUSED` / "WebSocket is not open" error to the agent.
- **Cloud mode depends on Cypress Cloud's private DOM.** Cypress Cloud is a hosted app that redesigns without notice, so every lookup has an ordered fallback chain ending in a structural match (the timeline scrubber is found by `data-cy`, then by class prefix, then as *any* range input whose min/max look like epoch milliseconds). When a lookup does miss, the tool returns `{ error: '<code>' }` naming which one — use `cloud_eval` to find the new selector and open a PR to `src/cloud-probe.js`. Verified against Cypress Cloud as of v0.12.0.
- **Cloud mode needs an interactive sign-in once.** A fresh profile is redirected to your identity provider (GitHub OAuth, SSO). The tools detect this and report `looksLoggedOut` with the `authHost` rather than failing obscurely — a human has to complete that sign-in in the browser window, after which the persistent profile remembers it.
- **`cloud_console_logs` reads what the Cloud UI has, which is what was recorded.** If a log never reached Test Replay it cannot be recovered here; and a very long run means a lot of scroll steps (282 rows took 47 steps against a ~14,000px list, a few seconds).
- **Mostly read-only.** Every tool is annotated: read-only tools carry `readOnlyHint: true`. The only tools with side effects are `rerun_spec` / `reset_and_rerun` (re-trigger a spec run) and `clear_app_state` (wipe AUT storage) — all marked `destructiveHint: true` with a "requires human approval" warning — plus `eval` (arbitrary JS). None of these modify your project files or Cypress config; they scrape/click the runner UI and the app's own storage. Gate them via your MCP client's permission settings.

## Inspirations

- [`cypress-log-to-output`](https://github.com/flotwig/cypress-log-to-output) — captures browser console via CDP for `cypress run`.
- [`cypress-terminal-report`](https://github.com/archfz/cypress-terminal-report) — pipes logs to the terminal during CI.

`cypress-inspect` is closer to `cypress-log-to-output` in approach (CDP, no plugin install) but oriented at interactive `cypress open` and an MCP agent rather than CI output.
