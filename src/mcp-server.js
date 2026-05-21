const fs = require('fs');
const path = require('path');
const { readSession } = require('./session');
const { CdpClient } = require('./cdp-client');
const probe = require('./cypress-probe');
const { augmentFailures, parseCompareError } = require('./failure-analysis');

async function runMcp() {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');

  const cdp = new CdpClient();
  let attached = false;

  async function ensureAttached() {
    if (attached) return;
    const session = await readSession();
    if (!session?.port) {
      throw new Error('No active Cypress session. Run `cypress-inspect open` in your project first, then pick a browser + spec.');
    }
    await cdp.attach(session.port);
    attached = true;
  }

  const server = new McpServer({ name: 'cypress-inspect', version: '0.6.0' });

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
        return textResult(JSON.stringify({ session: s, targets: cdp.listTargets(), lastError: cdp.lastError }, null, 2));
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
      description: 'Returns the rendered command list for the test at `index` (use `list_tests` to find it). Each entry has `number` (reporter-displayed number, NOT unique across rows — Cypress renders one logical command as 2-3 wrapper rows for parent+children), `index` (raw DOM position, unique), `name`, `arg`, `state`, plus `argTruncated`/`textTruncated` and `argLength`/`textLength` so you can tell when content was cut. Set `full: true` to return untruncated args + text (heavier payload — use when the error message is buried in a log row\'s arg). The result also includes `numberToIndex` mapping for quickly resolving a displayed reporter number to the first DOM index, useful with `step_to { commandNumber }`.',
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
