const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');

const probe = require('../src/cloud-probe');

// ── fake DOM ────────────────────────────────────────────────────────────────
// The probes are strings evaluated in a browser, so the only way to test them
// off-browser is to run them against a stand-in DOM. This models the one thing
// that actually makes the console scrape hard: react-window virtualisation, where
// the container reports the full scrollHeight but only renders the rows currently
// in view. `positioned: false` models the degraded case where the rows carry no
// inline offsets, which is what the innerText-stitch fallback exists for.
function makePanel({ rows, clientHeight = 300, rowHeight = 20, positioned = true }) {
  const rowParent = { id: 'react-window-inner' };
  const visible = () => {
    const start = Math.floor(panel.scrollTop / rowHeight);
    const end = Math.min(rows.length, start + Math.ceil(clientHeight / rowHeight) + 1);
    const out = [];
    for (let i = start; i < end; i++) out.push(i);
    return out;
  };
  const panel = {
    scrollTop: 0,
    clientHeight,
    scrollHeight: rows.length * rowHeight,
    querySelectorAll(sel) {
      if (sel !== '[style]' || !positioned) return [];
      return visible().map((i) => ({
        style: { position: 'absolute', top: `${i * rowHeight}px`, transform: '' },
        innerText: rows[i],
        parentElement: rowParent,
      }));
    },
    get innerText() { return visible().map((i) => rows[i]).join('\n'); },
    contains: () => false,
  };
  return panel;
}

// The replay devtools drawer opens on the Network tab, so the Console rows are
// not in the DOM until the Console tab is selected. `consoleTab` models that
// strip so the auto-activation can be tested.
function makeConsoleTab({ selected = false } = {}) {
  return {
    clicks: 0,
    getAttribute(name) { return name === 'aria-selected' ? String(selected) : null; },
    click() { this.clicks++; selected = true; },
  };
}

function runProbe(expression, panel, { consoleTab = null } = {}) {
  const sandbox = {
    setTimeout,
    location: { href: 'https://cloud.cypress.io/projects/x/runs/1/test-results/y/replay', hostname: 'cloud.cypress.io', pathname: '/projects/x' },
    document: {
      title: 'Test Replay',
      querySelectorAll: (sel) => (sel === '*' ? [panel] : []),
      querySelector: (sel) => (consoleTab && /aria-controls=console-tabpanel/.test(sel) ? consoleTab : null),
    },
  };
  // JSON round-trip on the way out mirrors CDP's `returnByValue: true`, and
  // rebuilds the value in THIS realm — vm returns cross-realm objects, which
  // deepStrictEqual rejects on prototype identity even when the data matches.
  return Promise.resolve(vm.runInNewContext(expression, sandbox, { timeout: 30000 }))
    .then((v) => JSON.parse(JSON.stringify(v)));
}

const LINES = Array.from({ length: 200 }, (_, i) => `[#2317-gf-debug] step ${i} value=${i * 3}`);

// ── console reconstruction ──────────────────────────────────────────────────

test('console scrape reconstructs every virtualised row in order', async () => {
  const panel = makePanel({ rows: LINES });
  const out = await runProbe(
    probe.consoleExpr({ grep: null, limit: null, maxScrollSteps: 600, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
  );
  assert.equal(out.error, undefined);
  assert.equal(out.strategy, 'virtual-row-offset');
  assert.equal(out.panelVia, 'most-virtual-rows');
  assert.deepEqual(out.entries.map((e) => e.text), LINES, 'must return all rows, in original order, with no duplicates');
  assert.equal(out.totalRows, LINES.length);
});

test('console scrape keeps genuinely repeated lines', async () => {
  // pull-console.js deduped through a Set, which silently collapsed a log that
  // legitimately fired the same text at two different points — exactly the signal
  // you need when hunting a loop that ran twice.
  const rows = ['a', 'b', 'a', 'c', 'a'];
  const panel = makePanel({ rows, clientHeight: 110, rowHeight: 60 });
  const out = await runProbe(
    probe.consoleExpr({ grep: null, limit: null, maxScrollSteps: 600, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
  );
  assert.deepEqual(out.entries.map((e) => e.text), rows);
});

test('console scrape falls back to innerText stitching when rows carry no offsets', async () => {
  const panel = makePanel({ rows: LINES, positioned: false });
  const out = await runProbe(
    probe.consoleExpr({ grep: null, limit: null, maxScrollSteps: 600, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
  );
  assert.equal(out.strategy, 'innertext-stitch');
  assert.deepEqual(out.entries.map((e) => e.text), LINES, 'overlapping snapshots must be stitched, not concatenated');
});

test('grep filters but still reports how many rows existed', async () => {
  const panel = makePanel({ rows: LINES });
  const out = await runProbe(
    probe.consoleExpr({ grep: 'value=9$', limit: null, maxScrollSteps: 600, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
  );
  assert.equal(out.totalRows, 200, 'totalRows must count the whole panel, not the matches');
  assert.deepEqual(out.entries.map((e) => e.text), ['[#2317-gf-debug] step 3 value=9']);
});

test('limit keeps the LAST matches', async () => {
  const panel = makePanel({ rows: LINES });
  const out = await runProbe(
    probe.consoleExpr({ grep: null, limit: 3, maxScrollSteps: 600, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
  );
  assert.deepEqual(out.entries.map((e) => e.text), LINES.slice(-3));
  assert.equal(out.matchedRows, 200);
  assert.equal(out.returnedRows, 3);
});

test('an invalid grep is reported, not thrown as an opaque eval failure', async () => {
  const panel = makePanel({ rows: LINES });
  const out = await runProbe(
    probe.consoleExpr({ grep: '([unclosed', limit: null, maxScrollSteps: 600, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
  );
  assert.equal(out.error, 'bad-grep');
});

test('a missing console panel names what it looked for', async () => {
  const empty = { scrollTop: 0, clientHeight: 10, scrollHeight: 10, querySelectorAll: () => [], innerText: '', contains: () => false };
  const out = await runProbe(
    probe.consoleExpr({ grep: null, limit: null, maxScrollSteps: 10, stepDelayMs: 0, tabWaitMs: 0 }),
    empty,
  );
  assert.equal(out.error, 'no-console-panel');
  assert.equal(out.scrollables, 0);
});

test('the Console tab is selected automatically when it is not already active', async () => {
  // Found live: the replay devtools drawer opens on Network, so without this the
  // first scrape of every session silently returned the test tree instead.
  const tab = makeConsoleTab({ selected: false });
  const panel = makePanel({ rows: LINES });
  const out = await runProbe(
    probe.consoleExpr({ grep: null, limit: 5, maxScrollSteps: 600, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
    { consoleTab: tab },
  );
  assert.equal(tab.clicks, 1, 'the Console tab must be clicked exactly once');
  assert.equal(out.consoleTab.activated, true);
});

test('an already-active Console tab is left alone', async () => {
  const tab = makeConsoleTab({ selected: true });
  const panel = makePanel({ rows: LINES });
  const out = await runProbe(
    probe.consoleExpr({ grep: null, limit: 5, maxScrollSteps: 600, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
    { consoleTab: tab },
  );
  assert.equal(tab.clicks, 0, 're-clicking a selected tab could toggle the drawer shut');
  assert.equal(out.consoleTab.alreadyActive, true);
});

// ── serialisation ───────────────────────────────────────────────────────────

test('every probe expression is syntactically valid JavaScript', () => {
  // These strings only ever run inside Chrome, so a syntax error would otherwise
  // surface as a runtime eval failure during a live debugging session.
  const expressions = {
    PAGE_INFO: probe.PAGE_INFO(),
    TIMELINE: probe.TIMELINE(),
    APP_RECT: probe.APP_RECT(),
    scrollApp: probe.scrollAppExpr({ scrollTo: 100, scrollBy: null }),
    console: probe.consoleExpr({ grep: 'x', limit: 10, maxScrollSteps: 600, stepDelayMs: 90 }),
  };
  for (const [name, src] of Object.entries(expressions)) {
    assert.doesNotThrow(() => new vm.Script(src), `${name} must parse`);
  }
});

test('probe helpers are actually inlined, since probes cannot close over scope', () => {
  assert.match(probe.TIMELINE(), /function findScrubber\(\)/);
  assert.match(probe.TIMELINE(), /function findAppFrame\(\)/);
  assert.match(probe.consoleExpr({}), /function findConsolePanel\(/);
  for (const src of [probe.PAGE_INFO(), probe.TIMELINE(), probe.APP_RECT(), probe.consoleExpr({})]) {
    assert.ok(!src.includes('__HELPERS__'), 'the marker must be replaced, not shipped to the browser');
  }
});

test('a probe missing its helper marker fails at build time, not in the browser', () => {
  assert.throws(
    () => probe._internals.withHelpers(function noMarker() { return 1; }, 'x'),
    /__HELPERS__/,
  );
});

test('the scrubber lookup does not depend on a hashed CSS-module class', () => {
  // `_scrubber-input_frhir_21` is a per-build hash; matching it exactly (as the
  // original shot.js did) breaks on Cypress Cloud's next deploy.
  const src = probe._internals.findScrubberSrc();
  assert.ok(!/_scrubber-input_\w+/.test(src), 'must not hardcode a hashed class');
  assert.match(src, /data-cy/, 'should prefer a stable data-cy hook');
  assert.match(src, /1e12/, 'should have a structural epoch-ms fallback');
});

// ── scrape robustness ───────────────────────────────────────────────────────

test('a virtualised list that grows while scrolling is still read completely', async () => {
  // Measured live: the console panel's scrollHeight went from 38,716px to
  // 140,329px over a single traversal, because rows materialise as you scroll.
  // Two things follow, and both are load-bearing: the step count cannot be
  // predicted up front, and jumping to the end is NOT a valid shortcut for
  // reading the tail — only the first few hundred rows exist at that point.
  const all = Array.from({ length: 400 }, (_, i) => `row ${i}`);
  let revealed = 60; // only this many exist until scrolling pulls in more
  const rowHeight = 20;
  const clientHeight = 200;
  let _top = 0;
  const panel = {
    // Browsers CLAMP scrollTop to [0, scrollHeight - clientHeight]. A fake that
    // lets it run past the end renders nothing at the bottom and fails for a
    // reason the real page never would.
    get scrollTop() { return Math.max(0, Math.min(_top, this.scrollHeight - clientHeight)); },
    set scrollTop(v) { _top = v; },
    clientHeight,
    get scrollHeight() { return revealed * rowHeight; },
    querySelectorAll(sel) {
      if (sel !== '[style]') return [];
      const start = Math.floor(this.scrollTop / rowHeight);
      const end = Math.min(revealed, start + Math.ceil(clientHeight / rowHeight) + 1);
      const out = [];
      for (let i = start; i < end; i++) {
        out.push({
          style: { position: 'absolute', top: `${i * rowHeight}px`, transform: '' },
          innerText: all[i],
          parentElement: rowParent,
        });
      }
      // Approaching the current end reveals more, exactly as the real list does.
      if (this.scrollTop + clientHeight >= revealed * rowHeight - 40) {
        revealed = Math.min(all.length, revealed + 60);
      }
      return out;
    },
    get innerText() { return ''; },
    contains: () => false,
  };
  const rowParent = { id: 'inner' };

  const out = await runProbe(
    probe.consoleExpr({ grep: null, limit: null, maxScrollSteps: 2000, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
  );
  assert.equal(out.entries.length, all.length, 'every row must be reached despite the list growing');
  assert.equal(out.grewWhileScraping, true, 'growth must be reported');
  assert.equal(out.hitStepLimit, false);
});

test('hitting the step limit is reported, never passed off as a complete read', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => `row ${i}`);
  const panel = makePanel({ rows, clientHeight: 200, rowHeight: 20 });
  const out = await runProbe(
    probe.consoleExpr({ grep: null, limit: null, maxScrollSteps: 3, stepDelayMs: 0, tabWaitMs: 0 }),
    panel,
  );
  assert.equal(out.hitStepLimit, true, 'a truncated scrape must say so');
  assert.ok(out.entries.length < rows.length);
});
