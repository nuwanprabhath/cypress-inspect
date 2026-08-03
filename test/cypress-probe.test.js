// These tests verify the *shape* of the generated JS expressions, not their
// runtime behavior (which requires a live Cypress runner page). Catches regressions
// in argument substitution, regex escaping, and option threading.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const probe = require('../src/cypress-probe');

test('static expressions are non-empty strings', () => {
  for (const key of ['OVERVIEW', 'FAILURES', 'LIST_TESTS', 'LIVE_COMMANDS', 'AUT_RECT', 'AUT_INFO', 'PINNED_COMMAND']) {
    assert.equal(typeof probe[key], 'string', `${key} should be a string`);
    assert.ok(probe[key].length > 50, `${key} should be non-trivial`);
  }
});

test('commandsForTestExpr: embeds the index and full flag', () => {
  const e1 = probe.commandsForTestExpr(7);
  assert.match(e1, /all\[7\]/);
  assert.match(e1, /argRaw\.slice\(0, 240\)/);                 // full=false → truncates
  const e2 = probe.commandsForTestExpr(7, { full: true });
  assert.match(e2, /\(true \? argRaw : argRaw\.slice\(0, 240\)\)/); // full=true → returns argRaw
});

test('stepToExpr: requires either index or number, supports both', () => {
  const byNum = probe.stepToExpr(2, { commandNumber: 38 });
  assert.match(byNum, /all\[2\]/);
  assert.match(byNum, /wantNumber\s*=\s*"38"/);
  assert.match(byNum, /wantIndex\s*=\s*null/);

  const byIdx = probe.stepToExpr(2, { commandIndex: 111 });
  assert.match(byIdx, /wantIndex\s*=\s*111/);
  assert.match(byIdx, /wantNumber\s*=\s*null/);

  const both = probe.stepToExpr(2, { commandIndex: 5, commandNumber: 38 });
  assert.match(both, /wantNumber\s*=\s*"38"/);
  assert.match(both, /wantIndex\s*=\s*5/);
});

test('findInAutExpr: textOnly toggles output shape', () => {
  const reg = probe.findInAutExpr('button', 10);
  assert.match(reg, /if \(false\)/); // textOnly=false → never enters textOnly branch
  assert.match(reg, /elements:\s*els\.map/);

  const txt = probe.findInAutExpr('button', 10, { textOnly: true });
  assert.match(txt, /if \(true\)/);
  assert.match(txt, /texts:\s*els\.map/);
});

test('findTestExpr: lowercases the query for case-insensitive match', () => {
  const e = probe.findTestExpr('Plot Description');
  // The expression should embed the lowercased query as a JS string.
  assert.match(e, /"plot description"/);
});

test('commandsAroundExpr: defaults to logical mode, embeds before/after', () => {
  const e = probe.commandsAroundExpr(0, 10, 5, 5);
  assert.match(e, /const before = 5/);
  assert.match(e, /const after = 5/);
  assert.match(e, /const mode = "logical"/);
  assert.match(e, /uniqueNumbers/);
});

test('commandsAroundExpr: wrapper mode skips the logical-collapse path', () => {
  const e = probe.commandsAroundExpr(0, 10, 5, 5, { mode: 'wrappers' });
  assert.match(e, /const mode = "wrappers"/);
});

test('getIndexedDbExpr: embeds dbName and store when given', () => {
  const list = probe.getIndexedDbExpr('myDb');
  assert.match(list, /"myDb"/);
  assert.match(list, /const wanted = null/);

  const dump = probe.getIndexedDbExpr('myDb', { store: 'docs', limit: 50 });
  assert.match(dump, /const wanted = "docs"/);
  assert.match(dump, /records\.length >= 50/);
});

test('expandTestExpr / autDomExpr / commandsForTestExpr: safely embed numeric indices', () => {
  // No string-injection paths from unsanitised numbers — confirm only digits make it in.
  for (const fn of [probe.expandTestExpr, probe.autDomExpr, probe.commandsForTestExpr]) {
    const out = String(fn(42, 100));
    assert.ok(out.includes('42'), 'index 42 should appear in expression');
  }
});

// ─────────────────── reporter document resolution (Cypress 10+) ───────────────────
// Cypress >= 10 renders the reporter inside a same-origin <iframe id="reporter-frame">.
// Probing the runner's top-level `document` finds zero `.test.runnable` rows, which the
// tools reported as "spec has no tests" rather than "wrong document".

// Minimal document stub. `hasTests` / `hasChrome` decide which reporter selectors hit.
function makeDoc(name, { hasTests = false, hasChrome = false, iframes = [] } = {}) {
  const doc = {
    __name: name,
    defaultView: { __name: name + ':win' },
    querySelector(sel) {
      if (sel.includes('#reporter-frame')) return iframes[0] || null;
      if (sel.includes('.test.runnable')) return hasTests ? { __name: name } : null;
      if (/\.reporter|\.runnable|\.command-wrapper/.test(sel)) return (hasChrome || hasTests) ? { __name: name } : null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel.startsWith('iframe')) return iframes;
      return [];
    },
  };
  return doc;
}
const makeFrame = (doc) => ({ contentDocument: doc });

function resolveRdoc(topDoc) {
  const fn = new Function('document', 'window', `${probe.REPORTER_DOC_HELPER}\nreturn __rdoc.__name;`);
  return fn(topDoc, { __name: 'topwin' });
}

test('REPORTER_DOC_HELPER: resolves the reporter iframe when the runner document is empty', () => {
  const reporter = makeDoc('reporter', { hasTests: true });
  const top = makeDoc('top', { iframes: [makeFrame(reporter)] });
  assert.equal(resolveRdoc(top), 'reporter');
});

test('REPORTER_DOC_HELPER: prefers the runner document when it renders the reporter itself', () => {
  const top = makeDoc('top', { hasTests: true, iframes: [makeFrame(makeDoc('reporter'))] });
  assert.equal(resolveRdoc(top), 'top');
});

test('REPORTER_DOC_HELPER: falls back to the reporter frame before any test has rendered', () => {
  // Run not started: no `.test.runnable` anywhere. Must still target the reporter frame,
  // otherwise a later poll on the same resolved document would read the wrong DOM.
  const top = makeDoc('top', { iframes: [makeFrame(makeDoc('reporter'))] });
  assert.equal(resolveRdoc(top), 'reporter');
});

test('REPORTER_DOC_HELPER: survives a cross-origin iframe without throwing', () => {
  const hostile = { get contentDocument() { throw new Error('cross-origin'); } };
  const reporter = makeDoc('reporter', { hasTests: true });
  const top = makeDoc('top', { iframes: [hostile, makeFrame(reporter)] });
  assert.equal(resolveRdoc(top), 'reporter');
});

test('REPORTER_DOC_HELPER: degrades to the runner document when there is no iframe at all', () => {
  assert.equal(resolveRdoc(makeDoc('top')), 'top');
});

test('reporter expressions read the resolved reporter document, never the runner document', () => {
  const reporterExprs = ['OVERVIEW', 'FAILURES', 'LIST_TESTS', 'PINNED_COMMAND', 'REPORTER_WARNINGS'];
  for (const key of reporterExprs) {
    assert.doesNotMatch(
      probe[key],
      /document\.querySelector(All)?\(\s*'[^']*(\.test\.runnable|command-is-pinned)/,
      `${key} must not query the runner document for reporter DOM`,
    );
    assert.match(probe[key], /__rdoc/, `${key} must resolve the reporter document`);
  }
  for (const build of [probe.findTestExpr, probe.rerunSpecExpr]) {
    assert.match(String(build('x')), /__rdoc|__qsaAll/);
  }
});

test('REPORTER_DOM_HELPERS-based expressions inherit the reporter document resolution', () => {
  for (const e of [probe.commandsForTestExpr(0), probe.stepToExpr(0, { commandIndex: 1 }), probe.expandTestExpr(0)]) {
    assert.match(e, /const __rdoc =/);
    assert.match(e, /__rdoc\.querySelectorAll\('\.test\.runnable'\)/);
  }
});

// ─────────────────── failing-command selection (offline noise) ───────────────────
// Cypress marks auto-logged network/resource rows ((image)/(fetch)/(xhr)) as
// `command-state-failed` when a request fails. An offline spec logs dozens of them,
// all BEFORE the assertion that actually ends the test — so picking the first failed
// row anchored get_failure_context / step_to { failureIndex } / get_failure_dom on a
// map tile instead of the failure.

const makeWrapper = (name, state) => ({
  className: `command-wrapper${state ? ' command-state-' + state : ''}`,
  querySelector: (sel) => (/command-method/.test(sel) ? { innerText: name } : null),
});

function pickFailed(wrappers) {
  const fn = new Function('wrappers', `${probe.REPORTER_COMMAND_HELPERS}\nreturn __failedCommandIdx(wrappers);`);
  return fn(wrappers);
}

test('__failedCommandIdx: skips failed auto-logged resource rows for the real failure', () => {
  const wrappers = [
    makeWrapper('get', 'passed'),
    makeWrapper('(image)', 'failed'),   // offline map tile — not the failure
    makeWrapper('(fetch)', 'failed'),   // offline heartbeat — not the failure
    makeWrapper('location', 'passed'),
    makeWrapper('assert', 'failed'),    // the command that ended the test
  ];
  assert.equal(pickFailed(wrappers), 4);
});

test('__failedCommandIdx: picks the LAST real failed row (innermost child assertion)', () => {
  // A failing `cy.get(...).should(...)` marks both the parent get and the child assert.
  const wrappers = [makeWrapper('get', 'failed'), makeWrapper('assert', 'failed')];
  assert.equal(pickFailed(wrappers), 1);
});

test('__failedCommandIdx: falls back to a failed network row when it is the only candidate', () => {
  // A genuinely failing xhr IS the failure when nothing else failed.
  const wrappers = [makeWrapper('get', 'passed'), makeWrapper('(xhr)', 'failed')];
  assert.equal(pickFailed(wrappers), 1);
});

test('__failedCommandIdx: returns -1 when nothing failed', () => {
  assert.equal(pickFailed([makeWrapper('get', 'passed')]), -1);
});

test('failure anchors resolve through __failedCommandIdx, not a first-match scan', () => {
  assert.match(probe.FAILURES, /__failedCommandIdx\(/);
  assert.doesNotMatch(probe.FAILURES, /findIndex\(\(w\) => \/command-state-failed\//);
  const summary = probe.commandsSummaryForTestExpr(0);
  assert.match(summary, /__failedCommandIdx\(/);
  assert.doesNotMatch(summary, /commands\.find\(\(c\) => c\.state === 'failed'\)/);
});

test('every generated expression is syntactically valid JS', () => {
  // The expressions are assembled from nested template literals, so a stray
  // backtick in a comment silently produces unparseable JS that only fails at
  // CDP evaluation time, inside the browser, as an opaque error.
  const exprs = {
    OVERVIEW: probe.OVERVIEW,
    FAILURES: probe.FAILURES,
    LIST_TESTS: probe.LIST_TESTS,
    LIVE_COMMANDS: probe.LIVE_COMMANDS,
    AUT_RECT: probe.AUT_RECT,
    AUT_INFO: probe.AUT_INFO,
    AUT_CLOCK: probe.AUT_CLOCK,
    PINNED_COMMAND: probe.PINNED_COMMAND,
    REPORTER_WARNINGS: probe.REPORTER_WARNINGS,
    STORAGE_SNAPSHOT: probe.STORAGE_SNAPSHOT,
    CLEAR_APP_STATE: probe.CLEAR_APP_STATE,
    INSPECT_APP_STATE: probe.INSPECT_APP_STATE,
    RERUN_SPEC: probe.RERUN_SPEC,
    APP_HEALTH: probe.APP_HEALTH,
    commandsForTestExpr: probe.commandsForTestExpr(0),
    commandsSummaryForTestExpr: probe.commandsSummaryForTestExpr(0),
    commandsPagedForTestExpr: probe.commandsPagedForTestExpr(0),
    commandsAroundExpr: probe.commandsAroundExpr(0, 1),
    stepToExpr: probe.stepToExpr(0, { commandIndex: 1, snapshot: 'before' }),
    expandTestExpr: probe.expandTestExpr(0),
    findTestExpr: probe.findTestExpr('x'),
    findInAutExpr: probe.findInAutExpr('button', 10),
    findFieldExpr: probe.findFieldExpr({ dataCy: 'x' }),
    autDomExpr: probe.autDomExpr('body', 100),
    getIndexedDbExpr: probe.getIndexedDbExpr('db', { store: 's' }),
    rerunSpecExpr: probe.rerunSpecExpr(),
    clearAppStateExpr: probe.clearAppStateExpr(),
    appHealthExpr: probe.appHealthExpr(),
  };
  for (const [name, src] of Object.entries(exprs)) {
    assert.doesNotThrow(() => new Function(`return ${src}`), `${name} must parse as JS`);
  }
});

// ─────────────── collapsed failed panels hide the whole error DOM ───────────────
// Cypress renders a test's error message, stack, code frame AND command rows only
// while its panel is open. After a fresh run the panels are collapsed, so reading
// them without expanding first made get_failures return an all-null failure list.

// Stub test panel. Details appear a tick AFTER the header click, mimicking the
// reporter's async re-render.
function makeTestPanel({ startsOpen = false, renderDelayMs = 30 } = {}) {
  let open = startsOpen;
  let ready = startsOpen;
  const state = { headerClicks: 0, scrolled: 0 };
  const header = {
    click() {
      state.headerClicks++;
      open = true;
      setTimeout(() => { ready = true; }, renderDelayMs);
    },
  };
  const collapsible = {
    classList: { contains: (c) => c === 'is-open' && open },
    querySelector: (sel) => (sel.includes('collapsible-header') ? header : null),
  };
  const el = {
    classList: { contains: () => false },
    scrollIntoView() { state.scrolled++; },
    querySelector(sel) {
      if (sel.includes('.collapsible') && !sel.includes('header')) return collapsible;
      if (sel.includes('runnable-err-message')) return ready ? { innerText: 'AssertionError: boom' } : null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('command-wrapper')) return ready ? [{ className: 'command-wrapper' }] : [];
      return [];
    },
  };
  return { el, state };
}

function runEnsureErrDetails(el) {
  const top = makeDoc('top', { iframes: [makeFrame(makeDoc('reporter', { hasTests: true }))] });
  const fn = new Function(
    'document', 'window', 'el',
    `return (async () => { ${probe.REPORTER_DOM_HELPERS}\nreturn __ensureErrDetails(el, 1500); })();`,
  );
  return fn(top, { __name: 'topwin' }, el);
}

test('__ensureErrDetails: expands a collapsed failed panel and waits for the error DOM', async () => {
  const { el, state } = makeTestPanel({ startsOpen: false });
  const res = await runEnsureErrDetails(el);
  assert.equal(state.headerClicks, 1, 'must click the header exactly once');
  assert.equal(res.wasOpen, false);
  assert.equal(res.open, true);
  assert.equal(res.hasError, true, 'must wait until the error message has rendered');
});

test('__ensureErrDetails: never toggles an already-open panel shut', async () => {
  const { el, state } = makeTestPanel({ startsOpen: true });
  const res = await runEnsureErrDetails(el);
  assert.equal(state.headerClicks, 0, 'an open panel must not be clicked');
  assert.equal(res.wasOpen, true);
  assert.equal(res.open, true);
});

test('FAILURES expands failed panels before reading the error DOM', () => {
  assert.match(probe.FAILURES, /^\(async \(\) =>/, 'FAILURES must be async to await panel expansion');
  assert.match(probe.FAILURES, /await __ensureErrDetails\(/);
});

test('OVERVIEW stays side-effect-free but flags collapsed failure details', () => {
  // get_overview backs wait_for_completion / wait_for_failure polling loops, so it
  // must never click the reporter. It has to say WHY the details are null instead.
  assert.doesNotMatch(probe.OVERVIEW, /__ensureErrDetails|__openPanel|\.click\(\)/);
  assert.match(probe.OVERVIEW, /detailsCollapsed/);
});

test('FAILURES re-resolves test nodes by index instead of holding refs across awaits', () => {
  // Expanding a panel re-renders the reporter; mid-run React can replace sibling
  // test nodes, detaching any reference captured before the await.
  assert.match(probe.FAILURES, /const testAt = \(i\) =>/);
  assert.doesNotMatch(probe.FAILURES, /for \(const \{ el \} of failedEls\)/);
});

// ───────────── app build/boot health (dev-server rebuild race) ─────────────
// Editing app source starts a dev-server rebuild. Rerunning inside that window
// serves shell HTML whose JS bundles come back empty, so the app never mounts and
// the spec fails minutes later at an unrelated assertion.

test('appHealthExpr: fetches entry bundles from the AUT window, NEVER the runner', () => {
  // A runner-side fetch of the app origin is answered by Cypress's proxy with
  // HTTP 200 and the body "TypeError: Failed to fetch" (26 bytes) — a naive
  // ok/bytes check scores that as healthy. Verified against a live runner.
  const e = probe.appHealthExpr();
  assert.match(e, /^\(async \(\) =>/);
  assert.match(e, /w\.fetch\(u, \{ cache: 'no-store' \}\)/, 'must fetch via the AUT contentWindow');
  assert.doesNotMatch(e, /[^.]\bfetch\(u, \{ cache/, 'must not use the runner-page fetch');
  assert.match(e, /iframe\.aut-iframe/);
});

test('appHealthExpr: flags both a non-200 and a 0-byte entry bundle', () => {
  const e = probe.appHealthExpr();
  assert.match(e, /served 0 bytes/);                    // 200-with-empty-body rebuild case
  assert.match(e, /returned HTTP ' \+ res\.status/);    // 404/500 broken-build case
  assert.match(e, /failed to load/);                     // network-level failure
});

test('appHealthExpr: flags a loaded-but-unrendered AUT as a failed mount', () => {
  assert.match(probe.appHealthExpr(), /rendered nothing — the app failed to mount/);
});

test('appHealthExpr: treats about:blank between runs as indeterminate, not unhealthy', () => {
  // Cypress parks the AUT on about:blank between runs. Reporting that as a
  // failure would block every legitimate rerun.
  const e = probe.appHealthExpr();
  assert.match(e, /indeterminate: !realUrl/);
  assert.match(e, /about:blank/);
});

test('appHealthExpr: honours maxAssets so a big shell cannot fan out unbounded fetches', () => {
  assert.match(probe.appHealthExpr({ maxAssets: 3 }), /\.slice\(0, 3\)/);
  assert.match(probe.appHealthExpr(), /\.slice\(0, 6\)/);
});

test('appHealthExpr: content-type is the discriminator, because status and size both lie', () => {
  // Verified against a live runner: an unavailable bundle comes back HTTP 200,
  // 26 bytes, content-type text/plain, body "TypeError: Failed to fetch". An
  // ok/bytes-only check scores that as HEALTHY — a false pass, which is worse
  // than no check at all.
  const e = probe.appHealthExpr();
  assert.match(e, /content-type/);
  assert.match(e, /javascript\|ecmascript/);
  assert.match(e, /NOT served as JavaScript/);
});

// ─────────── Cypress 15 reporter test states (active / processing) ───────────
// Cypress 15 marks the executing test `runnable-active` and queued tests
// `runnable-processing`. Matching only passed|failed|pending|running dumped both
// into `unknown`, so `counts.running` was permanently 0 — which reads as "the run
// has halted" while it is in fact mid-flight.

test('test-state regex recognises Cypress 15 active + processing states', () => {
  for (const expr of [probe.OVERVIEW, probe.LIST_TESTS, probe.findTestExpr('x')]) {
    assert.match(expr, /runnable-\(passed\|failed\|pending\|running\|active\|processing\)/);
  }
});

test('active maps to running and processing maps to queued', () => {
  // `processing` must NOT map to `pending`: in mocha terms pending means SKIPPED,
  // whereas processing means queued-but-not-yet-run.
  for (const expr of [probe.OVERVIEW, probe.LIST_TESTS]) {
    assert.match(expr, /active.*running|__normaliseState/s);
  }
  assert.match(probe.OVERVIEW, /queued/);
});

test('OVERVIEW counts include a queued bucket', () => {
  assert.match(probe.OVERVIEW, /queued: 0/);
});
