# Changelog

## 0.20.0

### Fixed
- **`cloud_open_test` could open a test from the WRONG SPEC.** After listing, the row was
  re-found in the DOM by **title alone**. Test titles repeat across specs whenever they
  come from shared helper commands, so asking for `specify barcode to autofill trap ID`
  in `vertebrate-trap-3.cy.js` opened the identically-titled test in
  `vertebrate-trap-2.cy.js` — and every tool called afterwards (failure, console,
  network, screenshot) then described the wrong spec, confidently and with no warning.
  Caught only because a screenshot showed `vertebrate-trap-2.cy.js` in the replay header.

  Rows are now matched on **spec path + suite + title**, with the spec read from the
  enclosing per-spec group. If no row satisfies all three it is an error, not a
  near-enough click. As a second line of defence the replay's own header is compared to
  the requested title after opening, and a mismatch is reported as
  `error: 'opened-wrong-test'` rather than returned as success.

### Verified
Against run 12735: the five `vertebrate-trap-3.cy.js` failures listed, the first opened
and confirmed as trap-3 (`clickedRow.spec`, and the error's own
`vertebrate-trap-3.cy.js:62` origin) where it previously opened trap-2; console and
network read for both a failed and a passed test in that spec (1070 console rows in 59
scroll steps, 410 network rows).

## 0.19.0

### Fixed
- **Filtering after opening a replay read the wrong list entirely.** Opening a Test
  Replay leaves the run's results list mounted *behind* the overlay, frozen on whatever
  filter was active. `cloud_list_tests { status: "passed" }` called from there returned
  the three **failed** tests — the status link was clicked while the overlay covered the
  list. Every listing call now returns to the results view first (reporting
  `closedReplayFirst`), which is what a human does.
- **`spec` was applied in JavaScript after scraping, which does not work at run scale.**
  On a 337-test run the scrape read 208 rows and matched **none** of the target spec's
  tests — they sort after the point the scrape reached. `spec` now drives the Cloud UI's
  own "Spec File" filter *before* scraping, turning 337 rows into single figures and
  making the result exact. An unmatched pattern lists the specs the run actually
  contains instead of silently returning nothing.
- **The count reconciliation fired false alarms.** With a spec filter applied the status
  link still reports the run-wide count (337 passed), so a correct 8-row per-spec read
  was flagged as a mismatch. Reconciliation now runs only when the status filter is the
  sole narrowing — a false alarm is as corrosive as a missed one.
- **The retry only covered one direction.** It triggered on `scraped > expected`, so the
  filter-switch failure (`expected 337, scraped 3`) warned without ever retrying. It now
  retries on any disagreement.

### Verified
Against run 12763: the three `camera-trap-retrieval.cy.js` failures diagnosed, its 8
passed tests listed and one opened by `spec` + `grep` with console and network read, and
seek + screenshot used to capture the open dropdown that explains the root failure.

## 0.18.0

### Fixed
- **`cloud_list_tests` intermittently reported more tests than the run contains.**
  Seen live as `scraped 9` on a run with exactly 7 failures, then `scraped 7` on the
  identical call moments later — a race between the scrape and the list re-rendering
  behind the status filter. Two changes, because the first alone did not settle it:
  - Rows are keyed on the **spec path**, not the `RunTestResultRow-N` group index.
    Applying a filter renumbers every group, so a group-index key can treat one test
    as two when the scrape straddles a re-render.
  - The result is **reconciled against the run's own count**. The status link states
    exactly how many rows there should be, so a scrape returning more is provably
    wrong: it retries, and if the disagreement persists it prints a `⚠` naming both
    numbers instead of returning a list already known to be wrong. Verified stable
    across repeated cold runs.
- **The status filter was trusted too early.** Readiness was "some rows are present",
  which the stale pre-filter render satisfies immediately. It now waits until every
  rendered row carries the requested status.
- **The empty-network message hedged when it did not need to.** It suggested no replay
  might be open even when the panel was present and explicitly reporting "No network
  requests available". That state is often the finding itself — a test that goes
  offline deliberately records none — so it now says so, and only mentions a missing
  replay when the panel really is absent.

## 0.17.0

### Added
- **The browser starts itself.** Every cloud session used to begin with a hard stop —
  "run `cypress-inspect cloud` in a terminal first" — which an agent cannot resolve on
  its own, and which is odd for a tool that owns that launcher. `ensureCloud` now
  launches one when there isn't a live browser, spawned **detached** so it survives the
  MCP server being restarted by an editor reload. Measured cold (no browser, no session
  file): GitLab job URL → loaded run in **6.2 s, one call**. `cypress-inspect cloud`
  still works for launching it yourself.
- **`cloud_get_failure` now surfaces `consoleSignals`.** A 200–800 row console holds a
  handful of lines that actually explain a CI-only failure, and nobody finds them by
  eye. Real case, from the run this was built against: three tests failed reporting
  plain `cy.get` timeouts, while the console held

  > `Uncaught exception caught by Cypress: … ResizeObserver loop completed with
  > undelivered notifications … Cypress will automatically fail the current test.`

  which reframes the failure from "the element never rendered" to "Cypress aborted on a
  benign browser warning". Signals carry a severity, **what the pattern means**, a count,
  and a seekable `fraction`. Repeats are counted with a few samples rather than dumped,
  so a warning that fires 200 times cannot bury the rest. Mirrors the local runner's
  `flakeSignals`. `skipConsole: true` opts out.
- **`cloud_network_logs { failedOnly }` sets aside telemetry that fails by design.**
  Every run examined returned nothing but Sentry POSTs 400ing on a placeholder DSN
  (`sentry_key=examplePublicKey`) — 6 of 6 in one job, 4 of 4 in another. A filter whose
  entire output is noise trains you to ignore it. These are **flagged, never silently
  dropped**: the hidden count and kinds are always printed, and `includeNoise: true`
  brings them back. Suppression is deliberately narrow — real app traffic is covered by
  a test asserting it is never mistaken for noise, since hiding a genuine 500 would be
  far worse than showing a Sentry 400.

### Fixed
- **`cloud_open_ci_job` discarded work when the browser was missing.** It fetched the CI
  job log first (~4 s), found the run URL, then threw a bare "no cloud debug browser"
  and lost it. The browser check now happens first — it is the cheap step.

## 0.16.0

### Fixed
- **Long console scrapes could silently lose rows.** The scrape advanced by a fixed
  window each step. That is unsafe here because the panel *grows while you traverse it*
  — measured live, `scrollHeight` went from 38,716px to 140,329px over a single pass as
  rows materialised — so a fixed step can jump over rows that appear mid-list.
  Reproduced in a test: rows 60-62 and 240-242 vanished at the growth boundaries. The
  scrape now anchors each step on the **last row it actually rendered**, which cannot
  skip; the cost is one row of overlap per step.
- **Reaching the bottom was treated as being finished.** The loop sampled once and
  stopped, but the list may have just grown taller in response to that very scroll,
  leaving an unsampled tail. All three scrapes (console, network, run test list) now
  require the scroll height to settle before stopping.
- **A truncated console read looked like a complete short one.** Hitting the scroll-step
  cap now reports `hitStepLimit` and prints a `⚠ INCOMPLETE` line. The default cap rose
  from 600 to 2000 steps.
- **`cloud_list_specs` could under-report without saying so.** It now also reads the
  Specs tab's own badge and warns when the scrape came up short (seen once: 17 of 18).
- **`cloud_open_run` reported a misleading `visibleTests: 0`.** That was rows mounted at
  that instant — the counts arrive before the rows do — and next to `ok: true` it read
  like an empty run. Renamed to `rowsMountedAtLoad`; `counts` is the real answer.

### Changed
- **Console/network/test-list scrapes are ~8× faster.** Each scroll step waited a flat
  90 ms. Now it waits two animation frames — enough for React to commit the new window —
  and only falls back to a real delay when that produced no new rows. Combined with the
  anchoring above, a 773-row console went from **332 steps / 25.8 s to 57 steps / 3.3 s**,
  returning the identical 773 rows.
- Redundant per-step re-sampling removed (each window was scanned twice).

### Notes
A "jump to the end and read the last N rows" fast path was prototyped and **rejected**:
because the list materialises progressively, jumping to the bottom exposes only the
first few hundred rows, so it would have returned a silently-wrong tail. Verified by
measurement — at the bottom of an un-traversed 773-row console, the highest row index
present was 385.

## 0.15.0

### Fixed
- **`cloud_list_tests` silently truncated big runs.** It read the test rows in one
  pass, which was correct on the 24-test run it was built against — but the run list
  is **virtualised**, so a 532-test run keeps about 15 rows in the DOM. The tool
  reported 15 tests and an agent would reasonably conclude the other 517 did not
  exist. It now narrows with the run's own filters first, scrolls when it must, and
  always reports the run's true `counts` beside how many it `scraped`, so a partial
  read is impossible to mistake for a short run.
- **`grep` could not match with an anchor.** Patterns were tested against the
  concatenation of the fields, so `^submit$` against a test titled "submit" matched
  nothing — the haystack was "basal 3 > publish submit". Every `grep` now tests each
  field individually as well as the joined form. Applies to `cloud_list_tests`,
  `cloud_get_commands`, `cloud_step_to` and `cloud_select_test`.

### Added
- **From a CI job link to the failing test, in one flow.** The whole point: a pipeline
  failed, and the evidence is in a Cypress Cloud recording you have to go and find.

  ```
  cloud_open_ci_job { url: "https://gitlab.com/<group>/<project>/-/jobs/15922202335" }
  cloud_list_tests  { status: "failed" }
  cloud_open_test   { status: "failed" }
  cloud_get_failure
  cloud_console_logs { grep: "…" } | cloud_network_logs { failedOnly: true }
  ```

  | Tool | Use |
  |---|---|
  | `cloud_open_ci_job` | GitLab job URL → reads the log via `glab` → opens the Cypress run |
  | `cloud_open_run` | Open a run by URL, or extract one from a blob of CI log `text` |
  | `cloud_list_specs` | Every spec file in the run |
  | `cloud_open_test` | Open a test's replay, filtered by `status` / `spec` / `grep` |
  | `cloud_get_failure` | Error message, stack, and the command that failed |
  | `cloud_network_logs` | Recorded requests: time, method, status, path |
  | `cloud_network_detail` | One request's headers and payloads |

### Notes on the implementation
- **CI logs are ANSI-coloured, and the escape codes land inside the URL match.** A
  naive regex over a GitLab trace yields `…/runs/12906?[0m` — a URL that reads
  correctly in a log and 404s in a browser. Codes are stripped before matching, the
  several mentions in a log collapse to one, and the most specific form wins so a
  replay link is preferred over a run overview.
- **`glab` is an optional dependency, used because you already have it authenticated**
  (including for self-hosted GitLab), so this tool stores no second credential. Every
  failure — not installed, not logged in, no access, no Cypress URL in the log — is
  reported distinctly, because "no output" from an auth problem otherwise looks
  identical to "this job never ran Cypress".
- **A bare run URL redirects to `/overview`, which contains no test rows at all**, so
  every entry point normalises to `/test-results` where the filters and tests live.
- **`status` is applied by clicking the run's own summary link** ("1 failed") rather
  than by scraping and filtering — exact, and it turns a 532-row scroll into one click.
- **Network rows carry the same `data-cy-event-start` timestamps as console rows**, so
  each request gets a seekable `fraction`: find the request that 500'd, then
  `cloud_seek` to it and screenshot the app at that moment.
- **Network rows are addressed by `rowId`, not position.** That list is virtualised too,
  so position N in an earlier listing is not position N in the DOM now — an index would
  quietly return a different request's payload.
- **`cloud_get_failure` avoids the auto-logged-network trap.** Cypress stamps
  `command-state-failed` on auto-logged network rows, so the first red row is often an
  unrelated request — verified live, where a failing test's first "failed" row was a
  `(fetch)` POST that returned **200**. It takes the last failed row that is not a
  network row, and reports the network ones separately rather than hiding them.
- Everything in the devtools panels reads `textContent`, not `innerText`: those panels
  are tab-switched and `innerText` returns `''` for anything not currently rendered,
  which produced a full list of blank rows during development.

### Verified
End to end against a real job: `…/-/jobs/15922202335` → run 12906 (532 tests, 18 specs,
1 failure) → the failing test's replay → its error ("Historical data count in Dexie for
table responses did not reach expected count of 4 within timeout"), stack, failed
command, and both its failed requests with full JSON payloads. 167 tests pass.

### ⚠ Note on payloads
`cloud_network_detail` returns request headers verbatim, which includes `Authorization`
bearer tokens. That is the point of the tool, but be careful about pasting its output
into issues or chats.

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
