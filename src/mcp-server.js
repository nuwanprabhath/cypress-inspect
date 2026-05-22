const fs = require('fs');
const path = require('path');
const { readSession } = require('./session');
const { CdpClient } = require('./cdp-client');
const probe = require('./cypress-probe');
const { augmentFailures, parseCompareError } = require('./failure-analysis');
const { fetchCypressDoc, resolveDocPath } = require('./cypress-docs');
const { analyzeSpec } = require('./spec-analysis');

async function runMcp() {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');

  const cdp = new CdpClient();
  let attachedPort = null;

  // Re-attach on every tool call if the session port changed OR every attached
  // CDP socket has dropped. This handles the common case where the user closes
  // the Chrome test browser from the Cypress App and picks a spec again —
  // Cypress spawns a NEW Chrome with a NEW port and the launcher updates
  // session.json, but the MCP process is long-lived and would otherwise keep
  // holding the dead first connection.
  async function ensureAttached() {
    const session = await readSession();
    if (!session?.port) {
      throw new Error('No active Cypress session. Run `cypress-inspect open` in your project first, then pick a browser + spec.');
    }
    const portChanged = attachedPort != null && session.port !== attachedPort;
    const noTargets = attachedPort != null && cdp.listTargets().length === 0;
    if (portChanged || noTargets) {
      try { await cdp.detach(); } catch {}
      attachedPort = null;
    }
    if (attachedPort == null) {
      await cdp.attach(session.port);
      attachedPort = session.port;
      // Newly-launched Chrome may need a moment to load the spec runner
      // page. Poll briefly (up to ~3 s) for a runner target so the very next
      // tool call after re-attach doesn't trip over "no CDP target".
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (cdp.listTargets().some((t) => t.kind === 'runner' || t.isSpecRunner)) return;
        await new Promise((r) => setTimeout(r, 200));
        await cdp.refreshTargets().catch(() => {});
      }
      return;
    }
    // Same port, still have targets — but force a quick refresh so a newly-
    // opened spec window inside the SAME Chrome process gets picked up.
    if (noTargets === false && cdp.listTargets().length === 0) {
      await cdp.refreshTargets();
    }
  }

  // Shared restart-and-verify path used by both `rerun_spec` and
  // `reset_and_rerun`. Snapshots reporter state, fires the restart probe,
  // then polls the runner state for evidence of an actual restart (a test
  // entering `running`, totals resetting, or the page reloading and tests
  // pending). When `awaitFlag` is false we still spend a short window
  // verifying so the caller never gets a false-positive "ok: true" when
  // nothing happened — which was the original bug.
  //
  // When the default (button-click) strategy fails to take, we AUTOMATICALLY
  // escalate to `location.reload()` rather than punting back to the caller.
  // The agent's next call would do the same thing anyway, so saving the
  // round-trip is a clear win. Pass `forceReload: true` from the outset to
  // skip straight to the reload (useful if you already know in-memory state
  // doesn't matter).
  async function attemptOnce({ forceReload, verifyWindow, baseline }) {
    const triggered = await cdp.evalOnRunner(probe.rerunSpecExpr({ forceReload }));
    const deadline = Date.now() + verifyWindow;
    let actuallyStarted = false;
    let currentCounts = null;
    let evidence = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const o = await cdp.evalOnRunner(probe.OVERVIEW).catch(() => null);
      if (!o?.counts) continue;
      currentCounts = o.counts;
      if ((o.counts.running || 0) > 0) { actuallyStarted = true; evidence = 'a test entered running state'; break; }
      if (baseline.failed > 0 && (o.counts.failed || 0) < baseline.failed) {
        actuallyStarted = true; evidence = `failed count reset (${baseline.failed} → ${o.counts.failed})`; break;
      }
      if (baseline.total > 0 && (o.counts.total || 0) === 0) {
        actuallyStarted = true; evidence = 'reporter cleared (page reload in progress)'; break;
      }
    }
    return { triggered, actuallyStarted, evidence, currentCounts, verifyWindow };
  }

  async function triggerAndVerifyRerun({ awaitFlag, timeoutMs, forceReload }) {
    const before = await cdp.evalOnRunner(probe.OVERVIEW).catch(() => null);
    const baselineCounts = before?.counts || null;
    const baseline = {
      failed: baselineCounts?.failed ?? 0,
      total: baselineCounts?.total ?? 0,
    };
    const fullWindow = awaitFlag ? timeoutMs : 3000;
    // First attempt: honour the caller's `forceReload` flag.
    const firstWindow = forceReload ? fullWindow : Math.min(4000, fullWindow);
    const attempt1 = await attemptOnce({ forceReload, verifyWindow: firstWindow, baseline });
    const attempts = [{ ...attempt1, forceReload }];
    let final = attempt1;

    // Auto-escalate to forceReload if the click strategy didn't take. Skip
    // when the caller already asked for forceReload OR explicitly opted out
    // of verification (awaitFlag === false → they don't want us to spend
    // more time).
    if (!attempt1.actuallyStarted && !forceReload && awaitFlag) {
      const remaining = Math.max(4000, fullWindow - firstWindow);
      const attempt2 = await attemptOnce({ forceReload: true, verifyWindow: remaining, baseline });
      attempts.push({ ...attempt2, forceReload: true, escalated: true });
      final = attempt2;
    }

    const totalWindow = attempts.reduce((s, a) => s + a.verifyWindow, 0);
    const usedForceReload = forceReload || attempts.length > 1;
    return {
      triggered: final.triggered,
      actuallyStarted: final.actuallyStarted,
      evidence: final.evidence,
      escalatedToForceReload: attempts.length > 1,
      attempts: attempts.map((a) => ({
        via: a.triggered?.via || null,
        forceReload: !!a.forceReload,
        actuallyStarted: a.actuallyStarted,
        evidence: a.evidence,
        verifyWindowMs: a.verifyWindow,
      })),
      previousCounts: baselineCounts,
      currentCounts: final.currentCounts,
      verifiedWithinMs: totalWindow,
      hint: final.actuallyStarted
        ? (usedForceReload
          ? 'Restart confirmed via location.reload(). Call `wait_for_failure` or `get_overview` to track the new run.'
          : 'Restart confirmed via reporter button click. Call `wait_for_failure` or `get_overview` to track the new run.')
        : (usedForceReload
          ? 'location.reload() was attempted but the reporter did not reset within ' + totalWindow + 'ms. The page may still be loading — call `get_overview` shortly.'
          : 'The trigger fired but the reporter state did not change. Retry with `{ forceReload: true }` to do a hard `location.reload()`. (Auto-escalation was skipped because `await: false` was set.)'),
    };
  }

  const server = new McpServer({ name: 'cypress-inspect', version: '0.8.4' });

  // ───────────────────────────── orientation ─────────────────────────────

  server.registerTool(
    'status',
    {
      title: 'Status / connection check',
      description: 'Return Cypress session info and the list of attached CDP targets. Always call this first if a tool returns "no Cypress" — it tells you whether the spec runner is actually loaded.',
      inputSchema: {},
    },
    async () => {
      const s = await readSession();
      if (!s) return textResult('No active session. Run `cypress-inspect open` in your project.');
      try {
        await ensureAttached();
        const targets = cdp.listTargets();
        const out = {
          session: s,
          attachedPort,
          sessionPortChanged: attachedPort !== s.port,
          targets,
          lastError: cdp.lastError,
        };
        if (targets.length === 0) {
          out.hint = 'Attached to the CDP port but no pages are open yet. If you just closed Chrome and re-picked a spec, give the new Chrome process 2-3 s to load — then retry. The MCP will auto-rebind to the latest session port on the next call.';
        } else if (!targets.some((t) => t.kind === 'runner' || t.isSpecRunner)) {
          out.hint = 'CDP is attached but no spec runner page found. The user may still be on the "Choose a browser" or spec-picker screen. Pick a spec to continue.';
        }
        return textResult(JSON.stringify(out, null, 2));
      } catch (err) {
        return textResult(`Session file present but CDP attach failed: ${err.message}\n${JSON.stringify(s, null, 2)}`);
      }
    },
  );

  server.registerTool(
    'get_overview',
    {
      title: 'Get debug overview (start here)',
      description: 'One-call orientation for an agent debugging a Cypress failure. Returns: spec file, pass/fail/pending counts, the first failed test (with title, suite path, error message, stack, code frame), and the currently in-flight test if any. This is the recommended first tool to call after status.',
      inputSchema: {},
    },
    async () => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.OVERVIEW);
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_failures',
    {
      title: 'List all failed tests with details',
      description: 'Return every failed test with suite, title, error message, stack, and code frame.\n\nAuto-annotations on every call:\n  • `rootCause: true` on the first failure; `looksLikeCascade: true` + `cascadeOf: <index>` on subsequent failures matching downstream patterns (timeouts, "Cypress test was stopped while running this command", auth/session deep-equal failures).\n  • Compare-style errors → `parsedDiff: { summary, diffs: [{ path, pathSegments, expected, actual }] }`.\n  • Top-level `flakeSignals: [{ id, explain, count, sample }]` populated by scanning the recent console buffer for known flake warnings ("random item from dropdown", "no search query provided for dropdown"). The matching IDs are also attached to the root-cause failure as `flakeSignals: ["..."]`.\n\nSet `dedupe: true` to split the response into `failures` (root + independent) and `cascadingFailures` (one-line summaries). Dedupe mode also surfaces `rootCauses: [<index>]` at the top level.',
      inputSchema: {
        dedupe: z.boolean().optional(),
      },
    },
    async ({ dedupe } = {}) => {
      await ensureAttached();
      const raw = await cdp.evalOnRunner(probe.FAILURES);
      // Two signal sources are merged into `flakeSignals`:
      //   1. CDP console buffer (last 1000)
      //   2. Reporter command-log rows matching /WARNING:/i — Cypress wraps
      //      console.* in the AUT iframe and routes calls into the reporter,
      //      so the buffer often misses them. The reporter scrape is the
      //      canonical source.
      const logs = cdp.getLogs({ limit: 1000 });
      const reporterWarnings = await cdp.evalOnRunner(probe.REPORTER_WARNINGS).catch(() => []);
      const augmented = augmentFailures(raw, {
        dedupe: !!dedupe,
        logs,
        reporterWarnings,
      });
      return textResult(JSON.stringify(augmented, null, 2));
    },
  );

  server.registerTool(
    'parse_compare_error',
    {
      title: 'Parse a Cypress Compare-style error into a structured diff',
      description: 'Standalone parser for the "InProgress Summary Widget comparison failed" / "Compare - FAILURES" error format. Pass a raw error message; returns `{ summary: { failed, total }, diffs: [{ path, expected, actual }] }`, or null if the message is not a Compare error.',
      inputSchema: { message: z.string() },
    },
    async ({ message }) => {
      return textResult(JSON.stringify(parseCompareError(message), null, 2));
    },
  );

  server.registerTool(
    'find_test',
    {
      title: 'Find a test by partial title (case-insensitive)',
      description: 'Substring search across test titles. Returns matches with index, state, and full title. Faster than calling list_tests and scanning when you already know what test you want.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.findTestExpr(query));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'list_tests',
    {
      title: 'List all tests with state',
      description: 'Lightweight list of every test in the spec: index, state (passed/failed/pending/running), title, suite ancestry. Use the returned `index` with `get_test_commands` and `step_to`.',
      inputSchema: {},
    },
    async () => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.LIST_TESTS);
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  // ───────────────────────────── command log ─────────────────────────────

  server.registerTool(
    'get_test_commands',
    {
      title: 'Get commands logged for a specific test',
      description: 'Returns the rendered command list for the test at `index` (use `list_tests` to find it). Each entry has `number` (reporter-displayed number, NOT unique across rows — Cypress renders one logical command as 2-3 wrapper rows for parent+children), `index` (raw DOM position, unique), `name`, `arg`, `state`, plus `argTruncated`/`textTruncated` and `argLength`/`textLength` so you can tell when content was cut. Set `full: true` to return untruncated args + text (heavier payload — use when the error message is buried in a log row\'s arg). The result also includes `numberToIndex` mapping for quickly resolving a displayed reporter number to the first DOM index, useful with `step_to { commandNumber }`.\n\nFinished-spec caveat: Cypress garbage-collects test panels after a spec completes, so an empty `commands: []` typically means the spec is no longer live. Call mid-run, or trigger `rerun_spec` first. (For complex specs prefer `get_test_commands_summary` / `get_test_commands_page` to avoid truncation.)',
      inputSchema: {
        index: z.number().int().nonnegative(),
        full: z.boolean().optional(),
      },
    },
    async ({ index, full }) => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.commandsForTestExpr(index, { full: !!full }));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_live_commands',
    {
      title: 'Get live cy.queue (currently-running test only)',
      description: 'Return Cypress.cy.queue for the in-flight test. Only meaningful while a test is mid-run; for finished tests use `get_test_commands`.',
      inputSchema: {},
    },
    async () => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.LIVE_COMMANDS);
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_test_commands_summary',
    {
      title: 'Lightweight command summary (triage view)',
      description: 'Returns one row per UNIQUE displayed command number — name, arg (≤80 chars), state. Cypress renders one logical command as 2-3 wrapper rows; this view collapses them. Designed for triage on complex tests where `get_test_commands` busts the token budget. Also returns `firstFailedNumber` for fast jumps via `step_to`.\n\nPass EITHER `index` (a specific test) OR `forFirstFailure: true` (skip the `find_test`/`list_tests` step — uses the first failed test in the spec).\n\nFinished-spec caveat: Cypress garbage-collects test panels after a spec completes, so `commandCount: 0` typically means the spec is no longer live. Call mid-run, or run `rerun_spec` first.',
      inputSchema: {
        index: z.number().int().nonnegative().optional(),
        forFirstFailure: z.boolean().optional(),
      },
    },
    async ({ index, forFirstFailure } = {}) => {
      await ensureAttached();
      let resolvedIndex = index;
      if (resolvedIndex == null) {
        if (!forFirstFailure) return textResult('Pass either `index` or `forFirstFailure: true`.');
        const overview = await cdp.evalOnRunner(probe.OVERVIEW);
        const tests = overview?.counts?.total ? await cdp.evalOnRunner(probe.LIST_TESTS) : [];
        const firstFailed = (tests || []).find((t) => t.state === 'failed');
        if (!firstFailed) return textResult('No failed tests in the spec.');
        resolvedIndex = firstFailed.index;
      }
      const result = await cdp.evalOnRunner(probe.commandsSummaryForTestExpr(resolvedIndex));
      if (result && result.commandCount === 0 && !result.error) {
        result._warning = 'commandCount is 0 — Cypress may have garbage-collected the panel (typical after spec completion). Call mid-run or trigger `rerun_spec` first.';
      }
      if (result && resolvedIndex !== index) result._resolvedFrom = 'forFirstFailure';
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_test_commands_page',
    {
      title: 'Paged command log (for huge tests)',
      description: 'Same shape as `get_test_commands` but returns one page of wrappers (default 50). Pass `{ index, page, pageSize?, full? }`. Response includes `start/end/total/hasMore` so the caller can iterate. Use when `get_test_commands` truncation breaks your debugging flow.\n\nFinished-spec caveat: same as `get_test_commands` — Cypress GCs test panels after spec completion. If `total: 0`, trigger `rerun_spec` first.',
      inputSchema: {
        index: z.number().int().nonnegative(),
        page: z.number().int().nonnegative().optional(),
        pageSize: z.number().int().positive().max(500).optional(),
        full: z.boolean().optional(),
      },
    },
    async ({ index, page = 0, pageSize = 50, full = false }) => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.commandsPagedForTestExpr(index, { page, pageSize, full }));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_failure_context',
    {
      title: 'Commands before / after the failing command',
      description: 'Returns the N commands BEFORE and M AFTER the failing command in a given failed test (default 5 / 5). Resolves the anchor from either `failureIndex` (a test\'s reporter index — finds the failed command in it) or an explicit `{ testIndex, commandIndex }`. The most common follow-up to `get_failures` — skips manual slicing.\n\n`mode` controls what `before`/`after` count:\n  • `"logical"` (default) — UNIQUE displayed command numbers. 5/5 ≈ 5 logical cy.* calls on each side. Matches what a human sees in the reporter.\n  • `"wrappers"` — raw DOM rows. Cypress emits 2-3 wrappers per command (parent + retries), so 5/5 can return up to ~33 rows. Use only if you need exact wrapper-row diagnostics.',
      inputSchema: {
        failureIndex: z.number().int().nonnegative().optional(),
        testIndex: z.number().int().nonnegative().optional(),
        commandIndex: z.number().int().nonnegative().optional(),
        before: z.number().int().nonnegative().max(50).optional(),
        after: z.number().int().nonnegative().max(50).optional(),
        mode: z.enum(['logical', 'wrappers']).optional(),
      },
    },
    async ({ failureIndex, testIndex, commandIndex, before = 5, after = 5, mode = 'logical' }) => {
      await ensureAttached();
      let tIdx = testIndex;
      let anchor = commandIndex;
      if (tIdx == null && failureIndex != null) tIdx = failureIndex;
      if (tIdx == null) return textResult('Pass either failureIndex or testIndex.');
      if (anchor == null) {
        const failures = await cdp.evalOnRunner(probe.FAILURES);
        const f = (failures?.failures || []).find((x) => x.index === tIdx);
        if (!f) return textResult(`No failed test at index ${tIdx}`);
        anchor = f.relatedCommandIndex;
        if (anchor == null) return textResult(`No failed command found in test ${tIdx}.`);
      }
      const result = await cdp.evalOnRunner(probe.commandsAroundExpr(tIdx, anchor, before, after, { mode }));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'expand_test',
    {
      title: 'Expand a test panel',
      description: 'Open the collapsible panel for the test at `index` so its commands and error block are visible in the reporter. Scrolls the panel into view. `step_to` already does this implicitly; use this when you just want to read commands without time-travelling.',
      inputSchema: { index: z.number().int().nonnegative() },
    },
    async ({ index }) => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.expandTestExpr(index));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_pinned_command',
    {
      title: 'Get the currently-pinned command',
      description: 'After `step_to`, returns which command is currently pinned (driving the AUT snapshot). Returns null if nothing is pinned.',
      inputSchema: {},
    },
    async () => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.PINNED_COMMAND);
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'step_to',
    {
      title: 'Time-travel: pin to a command in a specific test',
      description: 'Restore the AUT to the state at one command (same as clicking in the Cypress sidebar). Expands the test panel first if collapsed. Specify the command by EITHER `commandNumber` (the displayed reporter number, e.g. 38 — preferred; matches what humans see) OR `commandIndex` (raw DOM position 0..N — useful when there are duplicate numbers because Cypress renders parents + children as separate rows). If both are given, `commandNumber` wins. After this, `get_dom` / `screenshot { kind: "aut" }` / `get_pinned_command` reflect the pinned step.',
      inputSchema: {
        testIndex: z.number().int().nonnegative(),
        commandIndex: z.number().int().nonnegative().optional(),
        commandNumber: z.union([z.number().int().nonnegative(), z.string()]).optional(),
      },
    },
    async ({ testIndex, commandIndex, commandNumber }) => {
      if (commandIndex == null && commandNumber == null) {
        return textResult('Provide either commandNumber or commandIndex.');
      }
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.stepToExpr(testIndex, { commandIndex, commandNumber }));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  // ───────────────────────────── console ─────────────────────────────

  server.registerTool(
    'get_console_logs',
    {
      title: 'Get buffered console logs',
      description: 'Console events captured from the runner page (and any other attached pages) since the MCP server attached. Filter by `level` (log/info/warn/error/exception), substring `grep` (case-insensitive regex), `since` (epoch ms), and `limit`.\n\nWorked examples:\n  • `{ level: "error" }` — only errors\n  • `{ grep: "WARNING|deprecated" }` — match a regex across all levels\n  • `{ level: "warn", grep: "random item" }` — combine: warnings mentioning random selection (a common test-flake source)\n  • `{ grep: "selectFromDropdown" }` — find logs from a specific command\n\nTip: dropdown / picker flakiness in Cypress often shows up as `console.error("WARNING: selecting random item from dropdown ...")`. If a test fails with a value that changes each run, grep for "random item".',
      inputSchema: {
        level: z.string().optional(),
        grep: z.string().optional(),
        since: z.number().optional(),
        limit: z.number().int().positive().max(2000).optional(),
      },
    },
    async (args) => {
      await ensureAttached();
      const logs = cdp.getLogs(args || {});
      const status = cdp.bufferStatus();
      // When empty, ALWAYS return diagnostics so callers can distinguish
      // "nothing matched" from "capture is broken". When non-empty, still
      // include a one-line capture summary at the top for the same reason.
      const header =
        `# capture: attached ${Math.round((status.capturedSinceMs || 0) / 1000)}s ago, ` +
        `${status.totalEventsSeen} events seen, ${status.bufferedCount} buffered, ` +
        `${status.attachedContexts} execution contexts on ${status.attachedTargets} target(s)`;
      if (logs.length === 0) {
        return textResult(
          `${header}\n(no logs matched filter)\n\nDIAGNOSTICS:\n` +
          JSON.stringify(status, null, 2) +
          `\n\nIf totalEventsSeen is 0 even after running tests, Cypress likely wrapped console.* before the MCP attached. ` +
          `Check reporter-DOM warnings via get_failures (which folds them into flakeSignals) or rerun the spec with the MCP already attached.`,
        );
      }
      return textResult(header + '\n' + logs.map(formatLog).join('\n'));
    },
  );

  // ───────────────────────────── visual ─────────────────────────────

  server.registerTool(
    'screenshot',
    {
      title: 'Take screenshot',
      description: 'PNG screenshot. kind=full (default) captures the whole runner viewport including the reporter sidebar. kind=aut clips to the app-under-test iframe only.',
      inputSchema: {
        kind: z.enum(['full', 'aut']).optional(),
      },
    },
    async ({ kind } = {}) => {
      await ensureAttached();
      let clip = null;
      if (kind === 'aut') {
        clip = await cdp.evalOnRunner(probe.AUT_RECT);
        if (!clip) return textResult('AUT iframe not found. Has a spec started?');
      }
      const data = await cdp.screenshot({ clip });
      return { content: [{ type: 'image', mimeType: 'image/png', data }] };
    },
  );

  server.registerTool(
    'list_saved_screenshots',
    {
      title: 'List saved Cypress screenshots',
      description: 'List PNG files under cypress/screenshots/ in the project where `cypress-inspect open` was launched (sorted newest first).',
      inputSchema: {},
    },
    async () => {
      const s = await readSession();
      if (!s) return textResult('No active session.');
      const dir = path.join(s.cwd, 'cypress', 'screenshots');
      if (!fs.existsSync(dir)) return textResult(`No directory: ${dir}`);
      const files = walk(dir).filter((p) => p.endsWith('.png'));
      files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return textResult(files.join('\n') || '(none)');
    },
  );

  server.registerTool(
    'read_saved_screenshot',
    {
      title: 'Read saved screenshot',
      description: 'Read a saved Cypress screenshot PNG and return it as an image. Path can be absolute or relative to the project root.',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => {
      const s = await readSession();
      const abs = path.isAbsolute(p) ? p : path.resolve(s?.cwd || process.cwd(), p);
      const data = fs.readFileSync(abs).toString('base64');
      return { content: [{ type: 'image', mimeType: 'image/png', data }] };
    },
  );

  // ───────────────────────────── DOM ─────────────────────────────

  server.registerTool(
    'get_dom',
    {
      title: 'Get rendered HTML of the app under test',
      description: 'Read the AUT iframe DOM (same-origin iframe inside the runner). Returns the current snapshot — call `step_to` first to time-travel. Optional CSS `selector` restricts to one element. `maxBytes` defaults to 100 KB.',
      inputSchema: {
        selector: z.string().optional(),
        maxBytes: z.number().int().positive().max(1_000_000).optional(),
      },
    },
    async ({ selector, maxBytes = 100_000 } = {}) => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.autDomExpr(selector, maxBytes));
      if (result?.error) return textResult(result.error);
      const header = `AUT URL: ${result.url}\nTotal bytes: ${result.length}\n---\n`;
      return textResult(header + result.html);
    },
  );

  server.registerTool(
    'find_in_aut',
    {
      title: 'Query AUT DOM (compact, structured)',
      description: 'Run a CSS selector against the app-under-test iframe. Default mode returns per-element JSON `{ tag, attrs, text, textTruncated, textLength, value, visible, disabled }`. Set `textOnly: true` to get just the FULL untruncated text per match (no attrs/visibility overhead) — best for extracting summary widget content, table rows, or anything where you only care about what the user reads. Limit defaults to 25.',
      inputSchema: {
        selector: z.string(),
        limit: z.number().int().positive().max(200).optional(),
        textOnly: z.boolean().optional(),
      },
    },
    async ({ selector, limit = 25, textOnly = false }) => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.findInAutExpr(selector, limit, { textOnly }));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_aut_info',
    {
      title: 'Get AUT iframe URL / location / online state',
      description: 'Returns the AUT iframe src, current location (href / pathname / hash / search), document.title, readyState, and navigator.onLine. Use to confirm the app is where you expect after `step_to`.',
      inputSchema: {},
    },
    async () => {
      await ensureAttached();
      const browserSide = await cdp.evalOnRunner(probe.AUT_INFO);
      const status = cdp.bufferStatus();
      // Surface the execution contexts the console listener is subscribed to
      // so callers can tell whether AUT-side console.* calls have a chance of
      // reaching the buffer.
      return textResult(JSON.stringify({
        ...browserSide,
        capture: {
          attachedAt: status.attachedAt,
          attachedTargets: status.attachedTargets,
          attachedContexts: status.attachedContexts,
          totalEventsSeen: status.totalEventsSeen,
          contexts: status.contexts,
        },
      }, null, 2));
    },
  );

  // ───────────────────────────── network / storage / control ─────────────────

  server.registerTool(
    'get_network_logs',
    {
      title: 'Buffered network requests',
      description: 'CDP-captured network requests since the MCP server attached. Filters: `grep` (case-insensitive regex on URL), `since` (epoch ms), `statusMin/statusMax`, `failedOnly: true` (shorthand for failed OR status >= 400), `limit` (default 100). Each entry: `{ method, url, status, mime, durationMs, failed, failureText, ts }`. Body content is intentionally NOT captured — use `eval` if you need it.',
      inputSchema: {
        grep: z.string().optional(),
        since: z.number().optional(),
        statusMin: z.number().int().optional(),
        statusMax: z.number().int().optional(),
        failedOnly: z.boolean().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async (args) => {
      await ensureAttached();
      const rows = cdp.getNetworkLogs(args || {});
      const status = cdp.bufferStatus();
      const ageSec = Math.round((status.capturedSinceMs || 0) / 1000);
      const header = `# network: ${status.totalNetSeen} requests seen, ${status.bufferedNetCount} buffered (since attach ${ageSec}s ago), ${rows.length} returned`;
      if (rows.length === 0) {
        // Distinguish "filter excluded everything" from "buffer is empty
        // because you attached after the action". The latter is by far the
        // most common surprise.
        const hint = status.totalNetSeen === 0
          ? `(buffer is empty — cypress-inspect attached ${ageSec}s ago and has seen 0 requests since. ` +
            `If you ran the failing action BEFORE the MCP attached, those requests are gone. ` +
            `Trigger \`rerun_spec\` (optionally after \`clear_app_state\`) to capture them.)`
          : `(no network requests matched filter; buffer has ${status.bufferedNetCount} entries)`;
        return textResult(`${header}\n${hint}`);
      }
      const body = rows.map((r) => {
        const failMark = r.failed ? `FAIL ${r.failureText || ''} ` : '';
        const status = r.status != null ? r.status : '   ';
        const dur = r.durationMs != null ? `${r.durationMs}ms` : '    ';
        return `[${new Date(r.ts).toISOString().slice(11, 23)}] ${failMark}${status} ${dur} ${r.method || ''} ${r.url}`;
      }).join('\n');
      return textResult(`${header}\n${body}`);
    },
  );

  server.registerTool(
    'get_storage',
    {
      title: 'Snapshot localStorage / sessionStorage / IndexedDB / cookies',
      description: 'Read-only snapshot of the AUT iframe storage. Returns:\n  • `localStorage` — every key/value (each value clipped to 1 KB)\n  • `sessionStorage` — same shape\n  • `indexedDB` — list of `{ name, version }` from indexedDB.databases() (object store contents NOT dumped; use `eval` for that)\n  • `cookies` — document.cookie string\n\nUse to diagnose flakes caused by stale local state from a previous run (auth tokens, cached models, partially-synced PouchDB databases).',
      inputSchema: {},
    },
    async () => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.STORAGE_SNAPSHOT);
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'clear_app_state',
    {
      title: 'Clear localStorage / sessionStorage / cookies / IndexedDB (AUT)',
      description: 'Best-effort wipe of the app-under-test storage: clears localStorage, sessionStorage, every cookie on the current host, and deletes every IndexedDB database listed by indexedDB.databases(). Returns the count of each. Pair with `rerun_spec` for a clean-slate re-run. WRITE OPERATION on the app — use deliberately.',
      inputSchema: {},
    },
    async () => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.CLEAR_APP_STATE);
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'rerun_spec',
    {
      title: 'Re-run the current spec from the top',
      description: 'Triggers a full re-run of the currently-loaded spec.\n\nStrategy (with auto-escalation):\n  1. Click the reporter\'s restart button (leaves AUT in-memory state intact)\n  2. Try `Cypress.action("runner:restart")` / `Cypress.emit("restart")` (often a no-op in Cypress 15 but cheap)\n  3. **If steps 1-2 did not actually restart the spec, automatically falls back to `window.location.reload()`** — no second tool call required.\n\nALWAYS post-verifies via reporter state (a test enters `running`, totals reset, or the reporter clears for a page reload). Response includes `actuallyStarted`, `escalatedToForceReload`, and an `attempts: [...]` array so the agent can see exactly what happened.\n\nPass `forceReload: true` to skip straight to the reload (useful if you already know in-memory state doesn\'t matter). `await: true` (default) blocks up to `timeoutMs` (default 15 s); `await: false` skips both verification and auto-escalation.\n\nCypress does not expose a "rerun failed only" hook — this is a full re-run. Often most useful via `reset_and_rerun`.',
      inputSchema: {
        await: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(60000).optional(),
        forceReload: z.boolean().optional(),
      },
    },
    async ({ await: awaitFlag = true, timeoutMs = 15000, forceReload = false } = {}) => {
      await ensureAttached();
      const result = await triggerAndVerifyRerun({ awaitFlag, timeoutMs, forceReload });
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'reset_and_rerun',
    {
      title: 'Clear app state + rerun spec (one-shot)',
      description: 'Convenience: `clear_app_state` then `rerun_spec` with verification + auto-escalation to `location.reload()` if the reporter-button click strategy doesn\'t take. The realistic combined workflow when a previous run left bad state behind. Returns `{ cleared, ...rerunResult }` including `actuallyStarted`, `escalatedToForceReload`, and an `attempts` array. Pass `forceReload: true` to skip the click-first attempt.',
      inputSchema: {
        timeoutMs: z.number().int().positive().max(60000).optional(),
        forceReload: z.boolean().optional(),
      },
    },
    async ({ timeoutMs = 15000, forceReload = false } = {}) => {
      await ensureAttached();
      const cleared = await cdp.evalOnRunner(probe.CLEAR_APP_STATE);
      const rerun = await triggerAndVerifyRerun({ awaitFlag: true, timeoutMs, forceReload });
      return textResult(JSON.stringify({ cleared, ...rerun }, null, 2));
    },
  );

  server.registerTool(
    'get_indexeddb',
    {
      title: 'Read records from an IndexedDB store in the AUT',
      description: 'Opens an IndexedDB database on the AUT iframe and either lists its object stores OR dumps records from one store. Designed for the PouchDB / offline-cache debugging case ("what is actually queued / cached?").\n\nUsage:\n  • `{ dbName }` — list stores: `[{ name, count, keyPath, autoIncrement }]`\n  • `{ dbName, store }` — dump records (default 25, max 500). Each value is JSON-stringified and clipped to `valueMaxBytes` (default 2 KB) so the payload stays manageable.\n\nFor larger or filtered reads use `eval` directly — this tool intentionally trades flexibility for ergonomics.',
      inputSchema: {
        dbName: z.string(),
        store: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        valueMaxBytes: z.number().int().positive().max(50000).optional(),
      },
    },
    async ({ dbName, store, limit = 25, valueMaxBytes = 2000 }) => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.getIndexedDbExpr(dbName, { store, limit, valueMaxBytes }));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_failure_dom',
    {
      title: 'DOM at the failure frame (convenience: step_to + get_dom)',
      description: 'For a failed test, time-travel to the failing command and return the AUT DOM at that snapshot. Combines `step_to` + `get_dom` so you don\'t have to chain them. Pass `failureIndex` (the test index) and optional `selector` / `maxBytes`.',
      inputSchema: {
        failureIndex: z.number().int().nonnegative(),
        selector: z.string().optional(),
        maxBytes: z.number().int().positive().max(1_000_000).optional(),
      },
    },
    async ({ failureIndex, selector, maxBytes = 100_000 }) => {
      await ensureAttached();
      const failures = await cdp.evalOnRunner(probe.FAILURES);
      const f = (failures?.failures || []).find((x) => x.index === failureIndex);
      if (!f) return textResult(`No failed test at index ${failureIndex}`);
      if (f.relatedCommandIndex == null && !f.relatedCommandNumber) {
        return textResult(`Failed test ${failureIndex} has no identified failing command. Try step_to manually.`);
      }
      const stepped = await cdp.evalOnRunner(
        probe.stepToExpr(failureIndex, {
          commandIndex: f.relatedCommandIndex,
          commandNumber: f.relatedCommandNumber,
        }),
      );
      const dom = await cdp.evalOnRunner(probe.autDomExpr(selector, maxBytes));
      if (dom?.error) return textResult(`step_to=${JSON.stringify(stepped)}\nDOM error: ${dom.error}`);
      const header = `# pinned: ${JSON.stringify(stepped)}\n# AUT URL: ${dom.url}\n# Total bytes: ${dom.length}\n---\n`;
      return textResult(header + dom.html);
    },
  );

  server.registerTool(
    'wait_for_failure',
    {
      title: 'Block until the failure count grows (or timeout)',
      description: 'Polls the reporter until the failed-test count exceeds `baseline` (default: current count). Returns the new failure when it appears, or `{ timedOut: true }` after `timeoutMs` (max 120000, default 60000). Use this in a watch loop: call `get_overview` to capture baseline, then ask the agent to call `wait_for_failure { baseline }` so it can react to the next failure without you having to nudge it.',
      inputSchema: {
        baseline: z.number().int().nonnegative().optional(),
        timeoutMs: z.number().int().positive().max(120000).optional(),
        pollMs: z.number().int().positive().max(5000).optional(),
      },
    },
    async ({ baseline, timeoutMs = 60000, pollMs = 1000 }) => {
      await ensureAttached();
      let base = baseline;
      if (base == null) {
        const o = await cdp.evalOnRunner(probe.OVERVIEW);
        base = o?.counts?.failed ?? 0;
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const o = await cdp.evalOnRunner(probe.OVERVIEW);
        const failed = o?.counts?.failed ?? 0;
        if (failed > base) {
          return textResult(JSON.stringify({ baseline: base, currentFailed: failed, firstFailure: o.firstFailure }, null, 2));
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return textResult(JSON.stringify({ timedOut: true, baseline: base, waitedMs: timeoutMs }, null, 2));
    },
  );

  // ───────────────────────────── docs / static analysis ─────────────────────

  server.registerTool(
    'cypress_docs',
    {
      title: 'Look up official Cypress documentation',
      description: 'Fetch the canonical Cypress docs page for a command or topic from docs.cypress.io. Uses the LLM-friendly markdown mirror under /llm/markdown when available, falling back to a docs URL otherwise. Pass a `topic` like "cy.intercept", "intercept", "session", "retries", "best-practices", "selectors". Use this BEFORE asserting that "Cypress can / cannot X" — the docs are the source of truth, not your training data. The response includes a `url` you can cite to the user.',
      inputSchema: { topic: z.string() },
    },
    async ({ topic }) => {
      const result = await fetchCypressDoc(topic);
      if (result.error && !result.markdown) {
        const candidates = resolveDocPath(topic);
        return textResult(
          `${result.error}\nCandidate URLs:\n${candidates.map((c) => `  - [${c.kind}] ${c.url}`).join('\n')}`,
        );
      }
      const header = `# ${result.kind === 'guide' ? 'Guide' : 'Command'}: ${topic}\nSource: ${result.url}\n---\n`;
      return textResult(header + result.markdown);
    },
  );

  server.registerTool(
    'analyze_spec',
    {
      title: 'Static analysis of a Cypress spec for flake smells',
      description: 'Lint a Cypress spec file against the Cypress AI Toolkit explain-test rules. Detects:\n  • brittle-selector — cy.get/find with bare tag / single class / :nth-child / id (no data-cy)\n  • hardcoded-wait — cy.wait(<number>) literals\n  • missing-assertion — it() body with no .should / .and / expect / cy.contains / assert\n  • await-on-cypress — `await cy.*` (Cypress chains are not real Promises)\n  • null-helper-arg — selectFromDropdown(..., null) and similar (often triggers random selection → flake)\n  • focused-test / skipped-test — .only / .skip left in\n  • ui-only-setup — many clicks/types before first assertion with no cy.session / cy.request\n  • overlong-test — single it() longer than `maxTestLines` (default 80)\n\nPass `source` directly OR `path` (resolved relative to the active project from cypress-inspect open). Returns `{ smells: [...], summary: {<rule>: count}, tests: [...] }`.',
      inputSchema: {
        path: z.string().optional(),
        source: z.string().optional(),
        maxTestLines: z.number().int().positive().max(2000).optional(),
      },
    },
    async ({ path: p, source, maxTestLines } = {}) => {
      let text = source;
      let resolvedPath = null;
      if (!text) {
        if (!p) return textResult('Pass either `source` (the spec text) or `path` (file to read).');
        const s = await readSession();
        resolvedPath = path.isAbsolute(p) ? p : path.resolve(s?.cwd || process.cwd(), p);
        if (!fs.existsSync(resolvedPath)) return textResult(`No such file: ${resolvedPath}`);
        text = fs.readFileSync(resolvedPath, 'utf8');
      }
      const result = analyzeSpec(text, { path: resolvedPath || p || null, maxTestLines });
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  // ───────────────────────────── escape hatch ─────────────────────────────

  server.registerTool(
    'eval',
    {
      title: 'Evaluate JavaScript on the spec-runner page',
      description: 'Escape hatch: run arbitrary JS on the spec-runner page where `window.Cypress`, the reporter DOM, and the AUT iframe all live. Must return a JSON-serializable value. Use for things the built-in tools do not cover (e.g. inspecting reporter MobX state, custom Cypress globals).',
      inputSchema: { expression: z.string() },
    },
    async ({ expression }) => {
      await ensureAttached();
      const value = await cdp.evalOnRunner(expression);
      return textResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}
function formatLog(l) {
  const t = new Date(l.ts > 1e12 ? l.ts : Date.now()).toISOString().slice(11, 23);
  return `[${t}] [${l.kind}/${l.level}] ${l.text}`;
}
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

module.exports = { runMcp };
