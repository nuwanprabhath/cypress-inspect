# Changelog

## 0.14.0

### Added
- **Time-travel by command, not just by clock.** Seeking to a millisecond is fine when
  you already know *when* something happened; usually you know *what* happened — "the
  step where it clicked submit". Four tools make the replay's left-hand command log
  and its test list drivable, so the agent can pin a step and screenshot the app
  exactly as it looked there.

  | Tool | Use |
  |---|---|
  | `cloud_get_commands` | The numbered command log. Filters: `grep`, `failedOnly`, `offset`/`limit` |
  | `cloud_step_to` | Scroll a command into view and click it, pinning its snapshot |
  | `cloud_list_tests` | Every test in the run, with suite, title and status |
  | `cloud_select_test` | Replay a different test from the same run |

  The loop: `cloud_get_commands { grep }` → `cloud_step_to { index }` →
  `cloud_screenshot { kind: "app" }`. `cloud_select_test` then moves to another test in
  the run without pasting a new replay URL, after which every other cloud tool
  addresses the newly selected test.

### Notes on the implementation
- **Cypress Cloud reuses the local runner's private reporter DOM** — `.command-wrapper`,
  `.command-state-failed`, `.command-is-pinned` — so these tools deliberately mirror the
  shape of the existing `get_test_commands` / `step_to`. Two differences, both measured
  live: the Cloud command log is **not** virtualised (one `.runnable` scroller holds
  every row, so a single pass reads all of it), and `.command-number` does not exist —
  the number lives in a `.command-number-column` child.
- **Pinning uses a scripted click; seeking still needs trusted events.** The two look
  similar but fail differently: React's `onClick` fires for untrusted click events, so
  `.click()` pins fine, whereas the timeline scrubber's problem was React re-rendering a
  *controlled input's value*, which no scripted event can defeat. Clicking
  `.command-wrapper` itself does nothing — the handler is on `.command-wrapper-container`
  and the event bubbles past it.
- **Every navigation is verified, never assumed.** `cloud_step_to` confirms the pin
  landed on the requested row and returns `ok` plus the replay's `timer`; a missed click
  leaves the *previous* pin in place, and reporting that as success would have the agent
  screenshotting the wrong step while looking authoritative — the same failure class as
  the 0.13.0 seek bug. Likewise an unresolvable `index`/`number`/`grep` is an error, not
  a silent fall back to step 0.
- **Switching test is polled, not slept.** Cypress Cloud tears the current replay down
  before building the next; measured live it was still not ready at 4.5 s and had
  finished by the next check. `cloud_select_test` polls for the real end state — replay
  open, timeline present, command log populated — rather than guessing a delay.
- **Re-pinning an already-pinned command is a no-op**, because clicking a pinned row
  toggles the pin off; "step to 8" twice would otherwise leave nothing pinned.
- A pinned row renders a pin icon *in place of* its number, so `cloud_step_to` carries
  the pre-click number through rather than reporting an empty one.

### Verified
Against a live run: 181 commands listed and filtered, pins landing on both a `grep` and
an explicit index (timer moving `00:00` → `00:06`, snapshots visibly different), all 24
tests listed with statuses, and a switch to another test completing in 3.1 s with its
own 71-command log loaded.

## 0.13.0

### Fixed
- **`cloud_seek` reported success without moving the replay.** The scrubber is a
  *controlled* React `<input type=range>` whose value comes from player state, so the
  page-side approach of assigning `.value` and dispatching synthetic `input`/`change`
  events was ignored — React re-rendered the previous value straight back. The probe
  then read that value back and called it a successful seek. Caught by screenshotting
  the whole page instead of just the app frame: the seek claimed `positionSec: 7.29`
  while the footer still read **`15016ms`** and **`00:15 / 00:15`**.

  This was the worst possible failure mode — every screenshot afterwards was silently
  of the wrong moment, and looked authoritative. Seeking now dispatches **trusted**
  pointer events through the CDP `Input` domain (measured accurate to ~0.001 of the
  timeline), which is the only thing that actually drives the component.

  Two further traps found while fixing it, both now covered by tests:
  - **The value updates asynchronously.** Reading straight after the press returns the
    *previous* position — during one measurement run, four consecutive seeks each read
    back the preceding one's target. The seek now polls until the position settles.
  - **"It stopped changing" is not "it arrived."** During the update lag the value is
    legitimately unchanged, so a naive stability check mistakes the lag for the final
    position. Stability can only end the poll after a grace period; before that, only
    reaching the target does.

  `cloud_seek` now returns `ok`, where it actually landed, the attempts it made, and
  the replay's own on-screen `timer` — independent evidence that the *replay* moved,
  which reading back the input's value can never establish.

### Added
- **`cloud_seek { offsetMs }`** — milliseconds from the start of the run, the way
  people actually think about a timeline ("the screenshot around 7293 ms") and the same
  clock `cloud_console_logs` timestamps use. Previously the only absolute option was
  `timeMs`, an *epoch* scrubber value; passing a duration to it silently clamped to the
  start of the run. `fraction` and `timeMs` still work.

### Changed
- Seeking moved out of `cloud-probe.js` into a new `src/cloud-seek.js`, since it needs
  the CDP client and can no longer be expressed as a page-side probe. Scrolling the app
  frame stays a probe — that frame is same-origin, so driving its `scrollingElement`
  directly is both exact and unaffected by the controlled-input problem.

## 0.12.1

### Fixed
- **"No page target on the cloud debug browser" when the browser was plainly running.**
  A live debugging port does not imply a live window: on macOS, closing the last Chrome
  window quits the window but leaves the process — and the port — alive with zero page
  targets. `cypress-inspect cloud` then refused to adopt the browser it had just
  confirmed was listening, and told the user to relaunch something already running. It
  now opens a tab instead (at the given URL, or at cloud.cypress.io so there is
  somewhere to paste), and `cloud_open` does the same. The remaining no-tab error names
  the macOS behaviour rather than implying the browser is gone.

### Added
- **A warning when the shell has eaten your URL.** Unquoted, bash splits a replay link
  on every `&`: only the fragment up to the first one reaches the CLI and the rest run
  as background jobs (`[1] 59838 …`). A Cypress Cloud replay link always carries several
  query parameters, so a single-parameter one now prints a quote-your-URL warning and
  continues, instead of silently loading a truncated page.

## 0.12.0

### Added
- **Cloud mode — debug a failure that only reproduces in CI.** When a spec fails only
  in the pipeline, there is no local runner to attach to; the evidence lives in a
  Cypress Cloud Test Replay recording. `cypress-inspect cloud [url]` launches a
  separate CDP-enabled Chrome on a **persistent profile**
  (`~/.cypress-inspect/cloud-profile`), so you log in to cloud.cypress.io once and
  stay logged in. Paste a Test Replay link, and seven new `cloud_*` MCP tools let an
  agent read the recorded console output and take screenshots at any point on the
  timeline — replacing the add-console-logs / scrape-the-Cloud-UI-by-hand loop.

  It is **fully isolated** from `open` / `run`: its own browser, its own session file
  (`~/.cypress-inspect/cloud-session.json`), a fixed port 9333 (`--port` to change).
  Both modes can run at the same time, and neither can clobber the other's CDP port.

  | Tool | What it does |
  |---|---|
  | `cloud_status` | Browser alive? Page loaded? Is it a drivable replay? Signed in? |
  | `cloud_open` | Navigate to a Test Replay URL and wait for the timeline to hydrate |
  | `cloud_console_logs` | Reconstruct the full console output; optional `grep`, `limit` |
  | `cloud_timeline` | Scrubber bounds/position (`durationSec`, `fraction`) + app scroll metrics |
  | `cloud_seek` | Seek to a moment, then scroll the app frame |
  | `cloud_screenshot` | PNG of the whole replay or clipped to the app frame; optional `saveTo` |
  | `cloud_eval` | Escape hatch for panels the tools above do not cover |

- **Console lines carry their position on the timeline.** Each row is returned as
  `[<seconds> f=<fraction>] <text>`, taken from the list's own `data-cy-event-start`,
  which shares a clock with the scrubber. So "find my debug marker" → "see the app at
  the instant it fired" is `cloud_console_logs { grep }` → `cloud_seek { fraction }` →
  `cloud_screenshot { kind: "app" }`, with no arithmetic in between.

- **`cypress-inspect status` now reports both sessions**, local runner and cloud.

### Notes on the implementation
- **The Console tab is selected automatically.** The replay's devtools drawer opens on
  *Network*, so the console rows are not in the DOM at all until the Console tab is
  clicked. Found while verifying against a live replay: without this, the first scrape
  of every session silently returned the test tree instead of console output.
- **The console panel is virtualised**, so only ~19 rows exist in the DOM at once.
  `cloud_console_logs` scrolls it end to end and reassembles the list, keyed on each
  row's `data-cy-event-id` — exact identity, so genuinely repeated log lines survive
  (a set-based dedupe collapses them, losing precisely the signal that says a loop ran
  twice). It degrades to the row's inline pixel offset, and then to stitching
  consecutive `innerText` snapshots on their longest overlapping run of lines.
- **`cloud_seek` performs the scroll as well, by design.** Seeking triggers an async
  replay re-render that resets the app frame's `scrollTop`, so a separately-issued
  scroll would silently do nothing. Seek → wait → scroll (re-asserted, since the replay
  can restore scroll on a rAF) is one call so that ordering cannot be got wrong.
- **Selectors degrade instead of breaking.** Cypress Cloud is a hosted app that ships
  hashed CSS-module class names, so every lookup has an ordered fallback chain ending
  in a structural match — the timeline scrubber is found by `data-cy`, then by class
  prefix, and finally as *any* range input whose min/max look like epoch milliseconds.
  A probe that finds nothing returns `{ error: '<code>' }` naming the lookup that
  missed, rather than failing silently.
- **The debugging port keeps its Origin check.** Chrome is deliberately launched
  *without* `--remote-allow-origins=*`: that flag lets any visited web page open a
  WebSocket to the debugging port, and this browser holds a logged-in Cypress Cloud
  session.
- **A fresh profile is signed out**, and Cypress Cloud redirects it to the identity
  provider (GitHub OAuth, SSO) rather than showing its own login form. `cloud_status`
  and `cloud_open` detect that and report `looksLoggedOut` with the `authHost`, so the
  agent asks for a one-time human sign-in instead of reporting missing selectors.

### Verified
Against a live 56-second Cypress Cloud Test Replay, end to end through the MCP server:
the Console tab auto-selected from Network, 282 console rows reconstructed over 47
scroll steps of a ~14,000px virtualised list, `grep` narrowed to 6 matches, a seek to
one match's `fraction` landed at 30.22 s, and the app-clipped screenshot showed the
app at that moment. Unit tests cover the reconstruction strategies, tab activation,
argument parsing and Chrome resolution against a stand-in DOM (124 tests, all passing).

## 0.11.0

Every fix below was found while debugging a real Cypress 15 spec, and each was
verified against a live runner rather than only in unit tests.

### Fixed
- **Every reporter-backed tool returned empty on Cypress ≥ 10.** The unified runner
  renders the reporter into a same-origin `<iframe id="reporter-frame">`, but all probe
  expressions queried the runner's top-level `document` — which contains none of it.
  `get_overview` reported all-zero counts and `list_tests` returned `[]` while the
  reporter plainly showed 12 passed / 3 failed; `get_failures`, `find_test`,
  `expand_test`, `step_to`, `get_test_commands*`, `get_failure_context` and
  `rerun_spec` were all blind. A new resolver picks whichever document actually holds
  the reporter (falling back to inline layouts, and tolerating cross-origin frames), so
  the fix is not Cypress-15-specific. Controls that straddle both documents — the
  pinned-snapshot before/after toggle and the "Rerun all tests" button — are searched in
  both.
- **Failure anchors landed on auto-logged network noise.** The failed-command locator
  took the *first* `command-state-failed` row. Cypress also stamps that class on
  auto-logged resource rows whose request failed, so in an offline spec the anchor
  became a failed Mapbox tile eleven rows from the real failure — silently misdirecting
  `get_failure_context`, `step_to { failureIndex }` and `get_failure_dom`. Now takes the
  *last* failed row that is not auto-logged noise, falling back to a network row only
  when it is the sole candidate (a genuinely failing xhr really is the failure).
- **`get_failures` returned all-null failures when panels were collapsed.** Cypress
  renders a test's error message, stack, code frame and command rows only while its
  panel is open, and panels are collapsed after a fresh run — so the primary triage tool
  reported failures with no error at all. `get_failures` now expands each failed panel
  and waits for its rows before reading. It also re-resolves test nodes by index instead
  of holding element references across `await`s, which the reporter can invalidate
  mid-run.
- **Cypress 15 renamed two reporter test states.** The executing test is
  `runnable-active` (not `running`) and queued tests are `runnable-processing` (not
  `pending`). Matching only the old names put the live test and every queued test into
  `unknown`, leaving `counts.running` permanently 0 — indistinguishable from a halted
  run. `active` now maps to `running` and `processing` to a new `queued` bucket
  (deliberately *not* `pending`, which means *skipped* in mocha terms).

### Added
- **`check_app_health`** — read-only build/boot check for the app under test. Returns
  `{ ok, indeterminate, appOrigin, mounted, entryScripts, problems }`. Call it after
  editing app source and before rerunning.
- **Build-safety gate in `rerun_spec`.** Editing app source starts a dev-server rebuild;
  rerunning inside that window boots the AUT against empty JS, and the spec then dies
  minutes later at an unrelated assertion whose error says nothing about the cause.
  `rerun_spec` now waits (up to 20 s) for the bundles to serve completely before
  triggering, returns `abortedBeforeRerun: true` rather than starting a doomed run, and
  after the run starts confirms the app actually rendered — surfacing `appBootFailed`
  within seconds instead of after a full test timeout. `skipHealthCheck: true` opts out.

  Two traps this had to work around, both found against a live runner:
  a runner-side `fetch` of the app origin is answered by Cypress's proxy with **HTTP 200
  and the 26-byte body `"TypeError: Failed to fetch"`**, so bundles are fetched from the
  AUT iframe's own window instead; and a *missing* bundle also returns **HTTP 200 with
  26 bytes**, so status and size both lie — `content-type` is the only reliable
  discriminator (`application/javascript` vs a `text/plain` fallback).

### Changed
- `get_overview` counts gain a `queued` bucket, and `wait_for_completion` now waits it
  out as well as `unknown`/`running` — without that it would report a run complete the
  moment the first test finished.

### Tests
- New `test/mcp-server.test.js` boots the server over stdio and lists all 36 tools. Tool
  registration runs only inside `runMcp()`, so a bad identifier in a `registerTool` call
  cannot be caught by `require()` alone — this gap had already let through a reference to
  an undefined `READ_ONLY` constant.
- Every generated probe expression is now syntax-checked. These are assembled from
  nested template literals, where a stray backtick in a comment silently produces
  unparseable JS that only fails inside the browser at CDP evaluation time.
- A guard test fails if `check_app_health`'s description drifts from the fields the probe
  actually returns.
- Suite grew from 75 to 99 tests.

## 0.10.0

### Added
- **MCP tool annotations on every tool.** Read-only tools carry `readOnlyHint: true`
  (clients may auto-approve them); `cypress_docs` also sets `openWorldHint: true`.
- **Human-approval gating for the action tools.** `clear_app_state`, `rerun_spec`, and
  `reset_and_rerun` are marked `destructiveHint: true` and their descriptions now begin
  with "⚠ REQUIRES HUMAN APPROVAL — do not run autonomously; confirm with the user before
  calling." so agents don't trigger spec runs or wipe app state on their own. `eval` is
  marked `readOnlyHint: false` (it can mutate) so clients prompt rather than auto-approve.

### Changed
- **Trimmed all 35 tool descriptions** to cut the per-request token cost of the tool
  definitions (~22 KB → ~15.5 KB of description text, ≈29% smaller) without dropping any
  parameter semantics or usage guidance. This payload is sent to the model on every
  request, so the saving applies session-wide.
- README: documented the annotation scheme, added "requires human approval" markers to
  the three action tools, bumped the tools heading to v0.10, and corrected the stale
  "No write tools" limitation note.
