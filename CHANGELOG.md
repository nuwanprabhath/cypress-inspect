# Changelog

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
