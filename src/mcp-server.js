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

  // Poll the app-health probe until the dev server is serving a complete bundle.
  // Editing app source starts a rebuild; rerunning inside that window boots the
  // AUT against empty JS and the spec dies ~2 minutes later at an unrelated
  // assertion. Waiting a few seconds here removes that whole failure class.
  async function waitForAppHealthy(timeoutMs = 20000, pollMs = 750) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let waitedMs = 0;
    const startedAt = Date.now();
    for (;;) {
      last = await cdp.evalOnRunner(probe.APP_HEALTH).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      waitedMs = Date.now() - startedAt;
      // A blank AUT is expected BETWEEN runs (Cypress parks it on about:blank and
      // the previous app is torn down), so it must not block a rerun. Only
      // unservable assets mean "the dev server is not ready".
      // A blank/unmounted AUT is expected BETWEEN runs, so it must not block a
      // rerun — only unservable entry bundles mean "the dev server is not ready".
      // `indeterminate` (AUT on about:blank, no scripts to check) fails OPEN: a
      // check we cannot perform must never stop the user from running tests.
      const assetProblems = (last?.problems || []).filter((p) => /Entry bundle/.test(p));
      if (last?.indeterminate || assetProblems.length === 0) return { healthy: true, waitedMs, health: last, ...(last?.indeterminate ? { unverified: true } : {}) };
      if (Date.now() >= deadline) return { healthy: false, waitedMs, health: last, problems: assetProblems };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // After a rerun starts, confirm the app actually mounted. Catches the residual
  // case where assets served fine but the app still failed to boot.
  async function verifyAppBooted(timeoutMs = 12000, pollMs = 750) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await cdp.evalOnRunner(probe.APP_HEALTH).catch(() => null);
      const m = last?.mounted;
      if (m && m.realUrl && !m.blank && m.elementCount > 5) return { booted: true, health: last };
      if (Date.now() >= deadline) return { booted: false, health: last };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async function triggerAndVerifyRerun({ awaitFlag, timeoutMs, forceReload, skipHealthCheck = false }) {
    // Pre-flight: never start a run against a half-built bundle.
    let preflight = null;
    if (!skipHealthCheck) {
      preflight = await waitForAppHealthy();
      if (!preflight.healthy) {
        return {
          ok: false,
          abortedBeforeRerun: true,
          reason: 'App is not servable — refusing to start a run that would fail for the wrong reason.',
          waitedForRebuildMs: preflight.waitedMs,
          problems: preflight.problems,
          health: preflight.health,
          hint: 'A dev-server rebuild (or a broken build) is in progress. Fix the build or wait, then retry. Pass skipHealthCheck: true to override.',
        };
      }
    }
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

    // Post-flight: the run started, but did the app actually render? Surfaces a
    // failed boot in seconds instead of letting the first test time out against
    // a blank page and report a misleading selector/assertion error.
    let boot = null;
    if (!skipHealthCheck && final.actuallyStarted) {
      boot = await verifyAppBooted();
    }

    return {
      triggered: final.triggered,
      actuallyStarted: final.actuallyStarted,
      evidence: final.evidence,
      ...(preflight?.waitedMs > 1500 ? { waitedForRebuildMs: preflight.waitedMs } : {}),
      ...(boot && !boot.booted ? {
        appBootFailed: true,
        appBootProblems: boot.health?.problems || [],
        appBootHint: 'The run started but the app under test rendered nothing. Every test will now fail against a blank page — the errors will NOT describe the real cause. Check the dev server for a build error, then rerun. `check_app_health` has the detail.',
        health: boot.health,
      } : {}),
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

  const server = new McpServer({ name: 'cypress-inspect', version: '0.11.0' });

  // Tool annotations let MCP clients (Claude Code, etc.) reason about a tool
  // before calling it. `readOnlyHint: true` marks a tool as safe to run without
  // side effects — clients may auto-approve these. The three ACTION tools that
  // re-run the spec or wipe app state carry `destructiveHint: true` and an
  // approval warning in their description so agents do not run them
  // autonomously. `eval` is the escape hatch: it can mutate, so it is neither
  // read-only nor flagged destructive — clients should prompt for it.
  const READ = { readOnlyHint: true };
  const ACTION = { readOnlyHint: false, destructiveHint: true };
  const APPROVAL = '⚠ REQUIRES HUMAN APPROVAL — do not run autonomously; confirm with the user before calling. ';

  // ───────────────────────────── orientation ─────────────────────────────

  server.registerTool(
    'status',
    {
      title: 'Status / connection check',
      description: 'Cypress session info + attached CDP targets. Call this first when a tool returns "no Cypress" to check whether the spec runner is actually loaded.',
      annotations: READ,
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
      description: 'One-call orientation for debugging a failure. Returns spec file, pass/fail/pending counts, the first failed test (title, suite path, error, stack, code frame), the in-flight test, and `slowCommands` (non-null when an active command has used ≥50% of its timeout budget — an early warning). Recommended first call after `status`.',
      annotations: READ,
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
      description: 'Every failed test with suite, title, error, stack, and code frame. Auto-annotations: `rootCause: true` on the first failure; `looksLikeCascade: true` + `cascadeOf: <index>` on downstream ones, each with `cascadeEvidence` ("test-stopped" | "auth-context-mismatch" | "timeout") and `cascadeConfidence: "high" | "low"`. Timeout-only matches also carry `possiblyIndependent: true` (a shared timeout can be the same bug rather than pollution from the root). Compare-style errors add `parsedDiff: { summary, diffs: [{ path, pathSegments, expected, actual }] }`. Top-level `flakeSignals: [{ id, explain, count, sample }]` merges the console buffer and reporter warnings; matching ids also attach to the root failure. `dedupe: true` splits the response into `failures` (root + independent) and `cascadingFailures`, and adds top-level `rootCauses: [<index>]`.',
      annotations: READ,
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
      description: 'Standalone parser for the "InProgress Summary Widget comparison failed" / "Compare - FAILURES" error format. Pass a raw message; returns `{ summary: { failed, total }, diffs: [{ path, expected, actual }] }`, or null if it is not a Compare error.',
      annotations: READ,
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
      description: 'Case-insensitive substring search across test titles. Returns matches with index, state, and full title. Faster than scanning `list_tests` when you know the title.',
      annotations: READ,
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
      description: 'Every test in the spec: index, state (passed/failed/pending/running), title, suite ancestry. Use the returned `index` with `get_test_commands` and `step_to`.',
      annotations: READ,
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
      description: '⚠ Prefer `get_test_commands_summary` first — this can return 50+ KB and overflow the per-tool-result budget on complex tests. Returns the rendered command list for the test at `index`. Each entry: `number` (reporter-displayed, repeats across the 2-3 wrapper rows Cypress emits per command), `index` (unique DOM position), `name`, `arg`, `state`, plus `argTruncated`/`textTruncated` and `argLength`/`textLength`. `full: true` returns untruncated args + text (heavier). `bodyOnly: true` hides auto-logged network/resource rows ((fetch)/(xhr)/(image); a failed one is always kept). Also returns `numberToIndex` for resolving a reporter number to a DOM index. The panel is auto-opened and its virtualized rows are awaited first. A persistent empty `commands: []` means the spec finished and Cypress GC\'d the log — run `rerun_spec` for a live panel.',
      annotations: READ,
      inputSchema: {
        index: z.number().int().nonnegative(),
        full: z.boolean().optional(),
        bodyOnly: z.boolean().optional(),
      },
    },
    async ({ index, full, bodyOnly }) => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.commandsForTestExpr(index, { full: !!full, bodyOnly: !!bodyOnly }));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_live_commands',
    {
      title: 'Get live cy.queue (currently-running test only)',
      description: '`Cypress.cy.queue` for the in-flight test (only meaningful mid-run; use `get_test_commands` for finished tests). Each command may include `active: true` (the executing one, also `activeIndex` at top level), `elapsedMs` + `timeoutBudgetUsedPct`, `timeout` when explicit, and `suspiciouslyLargeTimeout: true` (> 30 s). `summarize: true` returns only `active`, `nextAssertion`, and `suspiciouslyLargeTimeoutCommands` — use it to see what is stuck without parsing every row.',
      annotations: READ,
      inputSchema: {
        summarize: z.boolean().optional(),
      },
    },
    async ({ summarize } = {}) => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.liveCommandsExpr({ summarize: !!summarize }));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_test_commands_summary',
    {
      title: 'Lightweight command summary (triage view)',
      description: 'Triage view: one row per command — `index` (DOM position, use with `step_to { commandIndex }`), `number` (gutter number; null for chained child rows like `-click`/`-assert`), `name`, `arg` (≤80 chars), `state`, `type`. Collapses the 2-3 wrapper rows Cypress emits per command. Also returns `firstFailedNumber` + `firstFailedIndex` for fast `step_to`. Pass EITHER `index` OR `forFirstFailure: true` (uses the first failed test, skipping `find_test`/`list_tests`). `bodyOnly` (default true) hides auto-logged network/resource rows ((fetch)/(xhr)/(image) heartbeats) while keeping a failed one; hidden rows are flagged via `hiddenNoiseRows` + `_note`. The panel is auto-opened and its virtualized rows are awaited. A persistent `commandCount: 0` means the spec finished and Cypress GC\'d the log — run `rerun_spec`.',
      annotations: READ,
      inputSchema: {
        index: z.number().int().nonnegative().optional(),
        forFirstFailure: z.boolean().optional(),
        bodyOnly: z.boolean().optional(),
      },
    },
    async ({ index, forFirstFailure, bodyOnly } = {}) => {
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
      const result = await cdp.evalOnRunner(probe.commandsSummaryForTestExpr(resolvedIndex, { bodyOnly: bodyOnly !== false }));
      if (result && result.commandCount === 0 && !result.error) {
        result._warning = 'commandCount is 0 even after auto-opening the panel and waiting for rows. The spec has likely finished and Cypress garbage-collected this test\'s command log — run `rerun_spec` to get a live panel.';
      }
      if (result && resolvedIndex !== index) result._resolvedFrom = 'forFirstFailure';
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_test_commands_page',
    {
      title: 'Paged command log (for huge tests)',
      description: 'Paged variant of `get_test_commands` — one page of wrappers (default 50). Pass `{ index, page, pageSize?, full? }`; response includes `start/end/total/hasMore`. Use when `get_test_commands` would truncate. If `total: 0`, the finished-spec log was GC\'d — `rerun_spec` first.',
      annotations: READ,
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
      description: 'The N commands BEFORE and M AFTER the failing command in a failed test (default 5/5). Resolve the failure by either `failureIndex` (position in the `get_failures` array; 0 = first; falls back to treating it as a reporter test `.index`) or `testIndex` (+ optional `commandIndex`). `mode: "logical"` (default) counts unique displayed command numbers — what a human sees in the reporter; `mode: "wrappers"` counts raw DOM rows (2-3 per command, so 5/5 can balloon to ~33).',
      annotations: READ,
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
      let resolvedFailure = null;
      if (failureIndex != null && tIdx == null) {
        const failures = await cdp.evalOnRunner(probe.FAILURES);
        const list = failures?.failures || [];
        // Try array-position semantics first (the natural way after get_failures)
        if (failureIndex < list.length) {
          resolvedFailure = list[failureIndex];
        } else {
          // Fall back to treating failureIndex as a test reporter index.
          resolvedFailure = list.find((x) => x.index === failureIndex);
        }
        if (!resolvedFailure) {
          return textResult(`No failure found for failureIndex=${failureIndex}. Got ${list.length} failures with reporter indices: [${list.map((f) => f.index).join(', ')}]`);
        }
        tIdx = resolvedFailure.index;
        if (anchor == null) anchor = resolvedFailure.relatedCommandIndex;
      }
      if (tIdx == null) return textResult('Pass either failureIndex (position in get_failures) or testIndex.');
      if (anchor == null) {
        const failures = await cdp.evalOnRunner(probe.FAILURES);
        const f = (failures?.failures || []).find((x) => x.index === tIdx);
        if (!f) return textResult(`No failed test at reporter index ${tIdx}`);
        anchor = f.relatedCommandIndex;
        if (anchor == null) return textResult(`No failed command found in test ${tIdx}.`);
      }
      const result = await cdp.evalOnRunner(probe.commandsAroundExpr(tIdx, anchor, before, after, { mode }));
      if (resolvedFailure) {
        result._resolvedFromFailureIndex = failureIndex;
        result._resolvedTestIndex = tIdx;
      }
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'expand_test',
    {
      title: 'Expand a test panel',
      description: 'Open the collapsible panel for the test at `index`, scroll it into view, and wait for its virtualized command rows to render. Returns `{ wasAlreadyOpen, isOpen, commandRowCount }`; never toggles an open panel shut. `step_to` and the `get_test_commands*` tools do this implicitly — use this to surface a panel without time-travelling.',
      annotations: READ,
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
      description: 'After `step_to`, returns the currently-pinned command driving the AUT snapshot: `{ number, name, arg, text }`, or null if nothing is pinned.',
      annotations: READ,
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
      description: 'Time-travel: pin the AUT to one command\'s state (like clicking a command in the Cypress sidebar). Auto-opens the panel, waits for rows, clicks the pin target, then confirms (`pinned: true`). Target via: `failureIndex` (position in `get_failures`; auto-resolves the failing command — shortest path); `testIndex` + `commandNumber` (the displayed reporter number, e.g. 38); or `testIndex` + `commandIndex` (raw DOM position, to disambiguate duplicate numbers or reach child rows like `-click`/`-assert` that carry no number — find their `index` via `get_test_commands_summary`). If both are given, `commandNumber` wins. `snapshot: "before"|"after"` picks which snapshot a two-state command shows (use `"before"` to see the state the command acted on); the result reports `snapshot: { ok, selected, wasAlreadyActive, active }` or `{ ok: false, reason }`. Afterwards `get_dom` / `screenshot { kind: "aut" }` / `find_in_aut` / `get_pinned_command` reflect the pin. `ok: false` (no rows) means the finished-spec log was GC\'d — `rerun_spec`.',
      annotations: READ,
      inputSchema: {
        failureIndex: z.number().int().nonnegative().optional(),
        testIndex: z.number().int().nonnegative().optional(),
        commandIndex: z.number().int().nonnegative().optional(),
        commandNumber: z.union([z.number().int().nonnegative(), z.string()]).optional(),
        snapshot: z.enum(['before', 'after']).optional(),
      },
    },
    async ({ failureIndex, testIndex, commandIndex, commandNumber, snapshot }) => {
      await ensureAttached();
      let tIdx = testIndex;
      let cIdx = commandIndex;
      let cNum = commandNumber;
      let resolvedFromFailureIndex = false;
      if (failureIndex != null && tIdx == null && cIdx == null && cNum == null) {
        const failures = await cdp.evalOnRunner(probe.FAILURES);
        const list = failures?.failures || [];
        const f = failureIndex < list.length ? list[failureIndex] : list.find((x) => x.index === failureIndex);
        if (!f) return textResult(`No failure at failureIndex=${failureIndex}. Got ${list.length} failures with reporter indices: [${list.map((x) => x.index).join(', ')}]`);
        tIdx = f.index;
        cIdx = f.relatedCommandIndex;
        cNum = f.relatedCommandNumber;
        resolvedFromFailureIndex = true;
        if (cIdx == null && cNum == null) return textResult(`Failure ${failureIndex} (test index ${tIdx}) has no identified failed command.`);
      }
      if (tIdx == null) return textResult('Provide either failureIndex OR testIndex (with commandNumber / commandIndex).');
      if (cIdx == null && cNum == null) return textResult('Provide commandNumber or commandIndex (or use failureIndex to auto-resolve).');
      const result = await cdp.evalOnRunner(probe.stepToExpr(tIdx, { commandIndex: cIdx, commandNumber: cNum, snapshot }));
      if (resolvedFromFailureIndex) result._resolvedFromFailureIndex = failureIndex;
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  // ───────────────────────────── console ─────────────────────────────

  server.registerTool(
    'get_console_logs',
    {
      title: 'Get buffered console logs',
      description: 'Console events captured from attached pages since the MCP server attached. Filters: `level` (log/info/warn/error/exception), `grep` (case-insensitive regex), `since` (epoch ms), `limit` — combine freely, e.g. `{ level: "warn", grep: "random item" }`. Tip: dropdown/picker flake often surfaces as `WARNING: selecting random item from dropdown` — grep "random item" when a value changes each run. Returns a capture-status header; when empty, full diagnostics distinguish "nothing matched" from "capture broken".',
      annotations: READ,
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
      description: 'PNG screenshot. `kind=full` (default) captures the whole runner viewport incl. the reporter sidebar; `kind=aut` clips to the app-under-test iframe. ⚠ The image reflects the AUT\'s last scroll position, so it may miss the relevant element — cross-check with `find_in_aut { selector }` (queries the DOM, unaffected by scroll), and call `step_to` first to fix the visual state at a specific step.',
      annotations: READ,
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
      description: 'List PNG files under cypress/screenshots/ in the launched project, newest first.',
      annotations: READ,
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
      description: 'Read a saved Cypress screenshot PNG and return it as an image. Path may be absolute or relative to the project root.',
      annotations: READ,
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
      description: 'Read the AUT iframe DOM (same-origin iframe in the runner) at the current snapshot — call `step_to` first to time-travel. Optional CSS `selector` restricts to one element; `maxBytes` defaults to 100 KB.',
      annotations: READ,
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
      description: 'Run a CSS selector against the AUT iframe. Default: per-element JSON `{ tag, attrs, text, textTruncated, textLength, value, visible, disabled }`. `textOnly: true` returns just the full untruncated text per match — best for summary widgets, table rows, or anything where only the visible text matters. `limit` defaults to 25.',
      annotations: READ,
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
    'get_field',
    {
      title: 'Read a form field value (Quasar-aware)',
      description: 'Read a single form field, resolving the `.text()` vs `.val()` vs sibling-`<span>` ambiguity (esp. Quasar `q-select`, where the display value lives outside the `<input>`). Pass `dataCy` (`[data-cy=...]`) OR a raw `selector`. Returns `{ found, displayText, inputValue, inputType, disabled, role, ariaExpanded, visible }`. Reads the AUT DOM, so it honors `step_to`. Note: Vue/Pinia `modelValue` is live-only heap state; `displayText`/`inputValue` are the snapshot-accurate equivalents.',
      annotations: READ,
      inputSchema: {
        dataCy: z.string().optional(),
        selector: z.string().optional(),
      },
    },
    async ({ dataCy, selector } = {}) => {
      await ensureAttached();
      if (!dataCy && !selector) return textResult('Pass either `dataCy` or `selector`.');
      const result = await cdp.evalOnRunner(probe.findFieldExpr({ dataCy, selector }));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'get_aut_info',
    {
      title: 'Get AUT iframe URL / location / online state',
      description: 'AUT iframe src, location (href/pathname/hash/search), document.title, readyState, and navigator.onLine, plus a `capture` block (attached targets/contexts, events seen). Use to confirm the app is where you expect after `step_to`.',
      annotations: READ,
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

  server.registerTool(
    'get_clock',
    {
      title: 'Get AUT clock + timezone (date/flake debugging)',
      description: 'The AUT\'s current time and timezone, so you do not compute date math via `eval`. Fields: `nowISO`, `nowEpochMs`, `timezoneOffsetMin` (e.g. -600 for AEST), `resolvedTimeZone` (IANA), `autTimezoneOffsetMin`, and `cy.clock` state — `clockFrozen` plus `clockNowEpochMs`/`clockNowISO` when a fake timer is installed. Check this first for suspicious date assertions (a classic timezone/off-by-one flake class).',
      annotations: READ,
      inputSchema: {},
    },
    async () => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.AUT_CLOCK);
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  // ───────────────────────────── network / storage / control ─────────────────

  server.registerTool(
    'get_network_logs',
    {
      title: 'Buffered network requests',
      description: 'CDP-captured network requests since the MCP server attached. Filters: `grep` (case-insensitive regex on URL), `since` (epoch ms), `statusMin`/`statusMax`, `failedOnly: true` (failed OR status >= 400), `limit` (default 100). Each row: `{ method, url, status, mime, durationMs, failed, failureText, ts, requestBody, responseBody }`. `requestBody` is captured for every request; `responseBody` only for errors (status >= 400); both truncated to 4 KB with `requestBodyTruncated`/`responseBodyTruncated` flags. So `{ failedOnly: true }` shows each 4xx/5xx and its response body — the root cause behind a "400 Bad Request" toast — in one call. For a non-error response body, use `eval`.',
      annotations: READ,
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
        let line = `[${new Date(r.ts).toISOString().slice(11, 23)}] ${failMark}${status} ${dur} ${r.method || ''} ${r.url}`;
        // Surface captured bodies (request always when present; response only on
        // errors). These are the payload behind a backend rejection.
        if (r.requestBody) line += `\n    → request: ${r.requestBody}${r.requestBodyTruncated ? ' …[truncated]' : ''}`;
        if (r.responseBody) line += `\n    ← response: ${r.responseBody}${r.responseBodyTruncated ? ' …[truncated]' : ''}`;
        return line;
      }).join('\n');
      return textResult(`${header}\n${body}`);
    },
  );

  server.registerTool(
    'get_storage',
    {
      title: 'Snapshot localStorage / sessionStorage / IndexedDB / cookies',
      description: 'Read-only snapshot of AUT storage: `localStorage` and `sessionStorage` (values clipped to 1 KB), `indexedDB` (list of `{ name, version }`; store contents not dumped — use `get_indexeddb`), and `cookies` (document.cookie). Use to diagnose flakes from stale local state (auth tokens, cached models, partially-synced PouchDB).',
      annotations: READ,
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
      description: APPROVAL + 'WRITE OPERATION. Best-effort wipe of AUT storage: localStorage, sessionStorage, every cookie on the host, and every IndexedDB database from indexedDB.databases(). Returns counts + `databasesSkipped`. Pair with `rerun_spec` for a clean re-run. **`dryRun: true` inspects what WOULD be wiped** (`localStorageKeys`, `sessionStorageKeys`, `cookieNames`, `databases: [{ name, version, loadBearing }]`, `loadBearingDatabases`) without touching anything — run it first on an unfamiliar spec. ⚠ Some DBs hold permission/seed state: `auth` caches grants like `permissionStatuses.geolocation: true` (wiping breaks GPS-dependent tests); synced caches (apiModels, dexie, postCache, …) break specs that read already-synced data. Preserve with `skipDatabases: ["auth", ...]`, or the flags `skipLocalStorage`/`skipSessionStorage`/`skipCookies`.',
      annotations: ACTION,
      inputSchema: {
        dryRun: z.boolean().optional(),
        skipDatabases: z.array(z.string()).optional(),
        skipLocalStorage: z.boolean().optional(),
        skipSessionStorage: z.boolean().optional(),
        skipCookies: z.boolean().optional(),
      },
    },
    async ({ dryRun, ...args } = {}) => {
      await ensureAttached();
      if (dryRun) {
        const preview = await cdp.evalOnRunner(probe.INSPECT_APP_STATE);
        return textResult(JSON.stringify({ dryRun: true, wouldClear: preview }, null, 2));
      }
      const result = await cdp.evalOnRunner(probe.clearAppStateExpr(args));
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'check_app_health',
    {
      title: 'Is the app under test servable and mounted?',
      description: 'Read-only build/boot check for the app under test. Returns `{ ok, indeterminate, appOrigin, mounted, entryScripts, problems }`. Call it right after editing app source and BEFORE rerunning: during a dev-server rebuild the shell keeps serving while its JS bundles do not, so a run started in that window boots a blank app and every test then fails with an error that has nothing to do with the real cause. `mounted.blank: true` = the AUT loaded a real URL but rendered nothing (app failed to mount) — expected between runs, a red flag during one. `entryScripts[]` re-fetches each `<script src>` from the AUT iframe\'s OWN window (never the runner page: a runner-side fetch of the app origin is answered by Cypress\'s proxy with HTTP 200 and the 26-byte body "TypeError: Failed to fetch"). Each row carries `{ status, bytes, contentType, isJs }` — `isJs` is the load-bearing one, because a missing bundle ALSO returns HTTP 200 with a small `text/plain` body, so status and size both lie. `indeterminate: true` (AUT on about:blank between runs) means build state could not be verified and is not a failure. `rerun_spec` runs this automatically.',
      annotations: READ,
      inputSchema: {},
    },
    async () => {
      await ensureAttached();
      const result = await cdp.evalOnRunner(probe.APP_HEALTH);
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'rerun_spec',
    {
      title: 'Re-run the current spec from the top',
      description: APPROVAL + 'Triggers a full re-run of the currently-loaded spec (Cypress has no "rerun failed only" hook). Strategy with auto-escalation: (1) click the reporter restart button (leaves AUT in-memory state intact); (2) try `Cypress.action("runner:restart")`/`Cypress.emit("restart")` (often a no-op in Cypress 15 but cheap); (3) if those did not restart, automatically fall back to `window.location.reload()` — no second call. Always post-verifies via reporter state (a test enters `running`, totals reset, or the reporter clears for a reload); the response includes `actuallyStarted`, `escalatedToForceReload`, and an `attempts: [...]` array. `forceReload: true` skips straight to the reload. `await: true` (default) blocks up to `timeoutMs` (default 15 s); `await: false` skips verification and auto-escalation. BUILD SAFETY: before triggering, it waits (up to 20 s) for the JS assets of the app under test to serve completely, so a run is never started against a half-finished dev-server rebuild — the failure mode where the AUT boots blank and the spec dies minutes later at an unrelated assertion. If the build never becomes servable it returns `abortedBeforeRerun: true` without running. After the run starts it confirms the app actually rendered and returns `appBootFailed: true` within seconds if not. `skipHealthCheck: true` disables both. Often best via `reset_and_rerun`.',
      annotations: ACTION,
      inputSchema: {
        await: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(60000).optional(),
        forceReload: z.boolean().optional(),
        skipHealthCheck: z.boolean().optional(),
      },
    },
    async ({ await: awaitFlag = true, timeoutMs = 15000, forceReload = false, skipHealthCheck = false } = {}) => {
      await ensureAttached();
      const result = await triggerAndVerifyRerun({ awaitFlag, timeoutMs, forceReload, skipHealthCheck });
      return textResult(JSON.stringify(result, null, 2));
    },
  );

  server.registerTool(
    'reset_and_rerun',
    {
      title: 'Clear app state + rerun spec (one-shot)',
      description: APPROVAL + 'Safe clear-and-rerun: navigate to the specs list (stopping any in-progress run so the app is idle), wipe all app storage, wait for the app to settle, then navigate back to the spec to start fresh — avoiding the crash from clearing cache mid-run. Sequence: capture spec file → go to specs list → clear localStorage/sessionStorage/cookies/IndexedDB → wait `postClearWaitMs` (default 5000) → return to the runner (auto-starts) → verify. Returns `{ cleared, specFile, postClearWaitMs, actuallyStarted, escalatedToForceReload, attempts }`. Raise `postClearWaitMs` for apps that eagerly re-fetch on startup. `skipDatabases` (e.g. `["auth"]`) preserves named IndexedDB databases (wiping `auth` can lose grants like `permissionStatuses.geolocation: true` and break GPS-dependent tests). **`dryRun: true`** clears/reruns nothing and returns `wouldClear` (storage keys + databases with a `loadBearing` flag).',
      annotations: ACTION,
      inputSchema: {
        dryRun: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(60000).optional(),
        forceReload: z.boolean().optional(),
        skipDatabases: z.array(z.string()).optional(),
        skipLocalStorage: z.boolean().optional(),
        skipSessionStorage: z.boolean().optional(),
        skipCookies: z.boolean().optional(),
        postClearWaitMs: z.number().int().nonnegative().max(30000).optional(),
      },
    },
    async ({ dryRun, timeoutMs = 15000, forceReload = false, skipDatabases, skipLocalStorage, skipSessionStorage, skipCookies, postClearWaitMs = 5000 } = {}) => {
      await ensureAttached();

      if (dryRun) {
        const preview = await cdp.evalOnRunner(probe.INSPECT_APP_STATE);
        return textResult(JSON.stringify({ dryRun: true, note: 'Nothing was cleared or rerun.', wouldClear: preview }, null, 2));
      }

      // Step 1 — capture the current spec file before navigating away.
      const specFile = await cdp.evalOnRunner(`(() => {
        const m = window.location.hash.match(/[?&]file=([^&]+)/);
        return m ? decodeURIComponent(m[1]) : null;
      })()`).catch(() => null);

      // Step 2 — navigate to the specs list to stop any in-progress test run.
      // This prevents the app from reading/writing storage while we wipe it.
      await cdp.evalOnRunner(`window.location.hash = '/specs'`).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));

      // Step 3 — clear all app storage. The AUT iframe is gone now that we're
      // on the specs list, but the runner page shares the same origin so the
      // updated clearAppStateExpr falls back to window and reaches the same
      // localStorage / IndexedDB.
      const cleared = await cdp.evalOnRunner(
        probe.clearAppStateExpr({ skipDatabases, skipLocalStorage, skipSessionStorage, skipCookies }),
      );

      // Step 4 — wait after clearing so the app isn't mid-initialisation when
      // the spec runner loads. Apps that eagerly re-fetch data on storage events
      // need this breathing room before the test's before-all hook runs.
      await new Promise((r) => setTimeout(r, postClearWaitMs));

      // Step 5 — navigate back to the spec runner, which auto-starts the run.
      if (specFile) {
        await cdp.evalOnRunner(
          `window.location.href = '/__/#/specs/runner?file=' + encodeURIComponent(${JSON.stringify(specFile)})`,
        ).catch(() => {});
      } else {
        // No spec file found — fall back to a plain reload of the runner.
        await cdp.evalOnRunner(`window.location.reload()`).catch(() => {});
      }

      // Step 6 — wait for the reporter to show the spec has started.
      const rerun = await triggerAndVerifyRerun({ awaitFlag: true, timeoutMs, forceReload });
      return textResult(JSON.stringify({ cleared, specFile, postClearWaitMs, ...rerun }, null, 2));
    },
  );

  server.registerTool(
    'get_indexeddb',
    {
      title: 'Read records from an IndexedDB store in the AUT',
      description: 'Open an IndexedDB database on the AUT and either list its object stores or dump one store\'s records — for the PouchDB/offline-cache case. `{ dbName }` lists stores `[{ name, count, keyPath, autoIncrement }]`; `{ dbName, store }` dumps records (default 25, max 500), each JSON-stringified and clipped to `valueMaxBytes` (default 2 KB). Use `eval` for larger or filtered reads.',
      annotations: READ,
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
      description: 'Convenience: `step_to` the failing command of a failed test, then return the AUT DOM at that snapshot (combines `step_to` + `get_dom`). Pass `failureIndex` (the test index) and optional `selector`/`maxBytes`.',
      annotations: READ,
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
      description: 'Poll the reporter until the failed-test count exceeds `baseline` (default: current count), then return the new failure — or `{ timedOut: true, currentCounts, finishedCleanly }` after `timeoutMs` (max 120000, default 60000) so you can tell "still running" from "passed cleanly". For "wait until the spec finishes", prefer `wait_for_completion`.',
      annotations: READ,
      inputSchema: {
        baseline: z.number().int().nonnegative().optional(),
        timeoutMs: z.number().int().positive().max(120000).optional(),
        pollMs: z.number().int().positive().max(5000).optional(),
      },
    },
    async ({ baseline, timeoutMs = 60000, pollMs = 1000 }) => {
      await ensureAttached();
      let base = baseline;
      let lastOverview = null;
      if (base == null) {
        lastOverview = await cdp.evalOnRunner(probe.OVERVIEW);
        base = lastOverview?.counts?.failed ?? 0;
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const o = await cdp.evalOnRunner(probe.OVERVIEW);
        lastOverview = o;
        const failed = o?.counts?.failed ?? 0;
        if (failed > base) {
          return textResult(JSON.stringify({ baseline: base, currentFailed: failed, currentCounts: o.counts, firstFailure: o.firstFailure }, null, 2));
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      const counts = lastOverview?.counts || null;
      const finishedCleanly = counts && counts.unknown === 0 && counts.running === 0 && (counts.queued || 0) === 0 && counts.total > 0 && counts.failed === 0;
      return textResult(JSON.stringify({
        timedOut: true,
        baseline: base,
        waitedMs: timeoutMs,
        currentCounts: counts,
        finishedCleanly,
        hint: finishedCleanly
          ? 'Timed out without new failures because the spec finished cleanly (all tests passed).'
          : 'Timed out without new failures — the spec may still be running. Call wait_for_completion to block until finished.',
      }, null, 2));
    },
  );

  server.registerTool(
    'wait_for_completion',
    {
      title: 'Block until every test has a final state (passed / failed / pending)',
      description: 'Poll the reporter until every test has a final state (`unknown === 0 && running === 0 && queued === 0 && total > 0`). Returns the final counts and whether the spec passed cleanly. The canonical "wait for the run to finish" primitive — cleaner than treating a `wait_for_failure` timeout as success.',
      annotations: READ,
      inputSchema: {
        timeoutMs: z.number().int().positive().max(600000).optional(),
        pollMs: z.number().int().positive().max(5000).optional(),
      },
    },
    async ({ timeoutMs = 180000, pollMs = 1000 } = {}) => {
      await ensureAttached();
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        const o = await cdp.evalOnRunner(probe.OVERVIEW);
        last = o;
        const c = o?.counts;
        // `queued` must be part of the condition: Cypress 15 marks not-yet-run
        // tests `runnable-processing`, which now normalises to `queued` instead of
        // falling into `unknown`. Without it this returns the moment the FIRST
        // test finishes, reporting a mid-flight run as complete.
        if (c && c.total > 0 && (c.unknown || 0) === 0 && (c.running || 0) === 0 && (c.queued || 0) === 0) {
          return textResult(JSON.stringify({
            completed: true,
            passed: c.failed === 0,
            counts: c,
            firstFailure: o.firstFailure,
            waitedMs: timeoutMs - (deadline - Date.now()),
          }, null, 2));
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return textResult(JSON.stringify({
        completed: false,
        timedOut: true,
        waitedMs: timeoutMs,
        currentCounts: last?.counts || null,
        hint: 'Spec did not finish within the timeout. Inspect with get_overview / get_live_commands to see what is stuck.',
      }, null, 2));
    },
  );

  // ───────────────────────────── docs / static analysis ─────────────────────

  server.registerTool(
    'cypress_docs',
    {
      title: 'Look up official Cypress documentation',
      description: 'Fetch the canonical Cypress docs page for a command/topic from docs.cypress.io (LLM-friendly markdown mirror under /llm/markdown when available). Pass a `topic` like "cy.intercept", "session", "retries", "best-practices", "selectors". Use BEFORE asserting "Cypress can/cannot X" — the docs are the source of truth, not training data. The response includes a citable `url`.',
      annotations: { readOnlyHint: true, openWorldHint: true },
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
      description: 'Static lint of a Cypress spec against the Cypress AI Toolkit explain-test rules: `brittle-selector` (cy.get/find with bare tag/single class/:nth-child/id, no data-cy), `hardcoded-wait` (cy.wait(<number>)), `missing-assertion` (it() with no .should/.and/expect/cy.contains/assert), `await-on-cypress` (`await cy.*`), `null-helper-arg` (e.g. selectFromDropdown(..., null) → random-selection flake), `focused-test`/`skipped-test` (.only/.skip), `ui-only-setup` (many clicks/types before the first assertion, no cy.session/cy.request), `overlong-test` (it() longer than `maxTestLines`, default 80). Pass `source` directly OR `path` (relative to the active project). Returns `{ smells, summary, tests }`.',
      annotations: READ,
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
      description: 'Escape hatch: run arbitrary JS on the spec-runner page (where `window.Cypress`, the reporter DOM, and the AUT iframe live) for things the built-in tools do not cover (reporter MobX state, custom Cypress globals). Must return a JSON-serializable value. ⚠ LIVE state only — does NOT honor `step_to`; the JS heap (window globals, Vue/Pinia stores, component instances) reflects the latest test that ran, not the pinned command. A `_pinnedSnapshot` warning is prepended when a pin is active. For DOM at a pinned step use `get_dom`/`find_in_aut`/`screenshot { kind: "aut" }`; Cypress snapshots only the DOM, never the JS heap, so a past command\'s reactive/component state is unreadable — pin and read the rendered DOM instead.',
      annotations: { readOnlyHint: false },
      inputSchema: { expression: z.string() },
    },
    async ({ expression }) => {
      await ensureAttached();
      const [value, pinned] = await Promise.all([
        cdp.evalOnRunner(expression),
        cdp.evalOnRunner(probe.PINNED_COMMAND).catch(() => null),
      ]);
      const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      if (pinned) {
        const label = `${pinned.name ?? ''}${pinned.arg ? ' ' + pinned.arg : ''}`.trim();
        const warn = `_pinnedSnapshot: eval reflects LIVE AUT state, not the pinned snapshot at command ${pinned.number ?? '?'}${label ? ' (' + label + ')' : ''}. Window globals may belong to a later test.\n\n`;
        return textResult(warn + raw);
      }
      return textResult(raw);
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
