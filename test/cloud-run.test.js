const assert = require('node:assert/strict');
const { test } = require('node:test');

const { toTestResultsUrl, listTests, openRun } = require('../src/cloud-run');
const { listNetwork, isErrorStatus } = require('../src/cloud-network');

/*
 * A stand-in for a run's test-results page.
 *
 * The behaviour that matters — and that a small fixture would hide — is that the
 * list is VIRTUALISED: a 532-test run keeps ~15 rows in the DOM. `windowSize`
 * models that, so a scrape that forgets to scroll fails the test the same way it
 * failed against the real thing.
 */
function makeRun({ tests, windowSize = 15, counts = null } = {}) {
  const state = { statusClicks: [], scrollPos: 0, filtered: null };
  const visible = () => {
    const list = state.filtered || tests;
    return list.slice(state.scrollPos, state.scrollPos + windowSize);
  };
  const realCounts = counts || tests.reduce((a, t) => ({ ...a, [t.status]: (a[t.status] || 0) + 1 }), {});
  return {
    state,
    cloud: {
      async navigate() { return { timedOut: false }; },
      async evaluate(expr) {
        if (/function statusFilterProbe/.test(expr)) {
          const status = JSON.parse(expr.slice(expr.lastIndexOf('.apply(null, ') + 13, -1))[0].status;
          state.statusClicks.push(status);
          state.filtered = tests.filter((t) => t.status === status);
          state.scrollPos = 0;
          return { clicked: true, status, expected: state.filtered.length };
        }
        if (/function runTestsProbe/.test(expr)) {
          const opts = JSON.parse(expr.slice(expr.lastIndexOf('.apply(null, ') + 13, -1))[0];
          const list = state.filtered || tests;
          // Without scrolling, only the window is visible — the real bug.
          const seen = opts.scroll ? list : visible();
          return {
            scraped: seen.length,
            scrolled: !!opts.scroll && list.length > windowSize,
            hadScroller: list.length > windowSize,
            counts: realCounts,
            tests: seen.map((t, i) => ({ index: i, ...t })),
          };
        }
        return {};
      },
    },
  };
}

const TESTS = [
  ...Array.from({ length: 300 }, (_, i) => ({ specIndex: 0, spec: 'test/a.cy.js', suite: 'A', title: `passing ${i}`, status: 'passed', hasReplay: true })),
  { specIndex: 1, spec: 'test/basal-area-dbh-protocols.cy.js', suite: 'basal 3 > publish', title: 'submit', status: 'failed', hasReplay: true },
  ...Array.from({ length: 231 }, (_, i) => ({ specIndex: 2, spec: 'test/c.cy.js', suite: 'C', title: `other ${i}`, status: 'passed', hasReplay: true })),
];

test('a run or replay URL is normalised to the test-results view', () => {
  // A bare run URL redirects to /overview, which has NO test rows — an agent
  // landing there would reasonably conclude the run was empty.
  assert.equal(
    toTestResultsUrl('https://cloud.cypress.io/projects/6b9ofw/runs/12906'),
    'https://cloud.cypress.io/projects/6b9ofw/runs/12906/test-results',
  );
  assert.equal(
    toTestResultsUrl('https://cloud.cypress.io/projects/6b9ofw/runs/12906/test-results/abc-def/replay?att=1&x=2'),
    'https://cloud.cypress.io/projects/6b9ofw/runs/12906/test-results',
  );
  assert.equal(toTestResultsUrl('https://example.com/nope'), null);
});

test('openRun rejects a non-run URL with a usable hint', async () => {
  const { cloud } = makeRun({ tests: TESTS });
  const out = await openRun(cloud, 'https://example.com/nope');
  assert.equal(out.error, 'not-a-run-url');
  assert.match(out.hint, /runs\/</);
});

test('the status filter is applied through the UI, not by scraping 532 rows', async () => {
  const { cloud, state } = makeRun({ tests: TESTS });
  const out = await listTests(cloud, { status: 'failed' });
  assert.deepEqual(state.statusClicks, ['failed']);
  assert.equal(out.matched, 1);
  assert.equal(out.tests[0].title, 'submit');
});

test('an unscrolled read of a virtualised list is visibly partial, never silently so', async () => {
  // The bug this guards: a 532-test run renders ~15 rows, so a single-pass read
  // reported 15 tests and an agent concluded the other 517 did not exist. The
  // run's own counts must always travel with the scrape.
  const { cloud } = makeRun({ tests: TESTS, windowSize: 15 });
  const out = await listTests(cloud, { scroll: false });
  assert.equal(out.scraped, 15);
  assert.equal(out.counts.passed, 531);
  assert.equal(out.counts.failed, 1);
  assert.ok(out.counts.passed > out.scraped, 'counts must expose the shortfall');
});

test('scrolling reaches every test in the run', async () => {
  const { cloud } = makeRun({ tests: TESTS, windowSize: 15 });
  const out = await listTests(cloud, { scroll: true, limit: 1000 });
  assert.equal(out.scraped, 532);
  assert.equal(out.scrolled, true);
});

test('spec and grep narrow the scraped list', async () => {
  const { cloud } = makeRun({ tests: TESTS });
  const bySpec = await listTests(cloud, { spec: 'basal-area' });
  assert.equal(bySpec.matched, 1);
  const byGrep = await listTests(cloud, { grep: '^submit$' });
  assert.equal(byGrep.matched, 1);
  const none = await listTests(cloud, { spec: 'no-such-spec' });
  assert.equal(none.matched, 0);
});

test('an invalid filter pattern is reported, not thrown', async () => {
  const { cloud } = makeRun({ tests: TESTS });
  assert.equal((await listTests(cloud, { grep: '([bad' })).error, 'bad-grep');
  assert.equal((await listTests(cloud, { spec: '([bad' })).error, 'bad-spec-pattern');
});

test('limit caps the response but matched still reports the truth', async () => {
  const { cloud } = makeRun({ tests: TESTS });
  const out = await listTests(cloud, { status: 'passed', limit: 5 });
  assert.equal(out.returned, 5);
  assert.equal(out.matched, 531);
});

// ── network ─────────────────────────────────────────────────────────────────

function makeNetwork(items) {
  return {
    async evaluate(expr) {
      if (/function networkListProbe/.test(expr)) {
        const opts = JSON.parse(expr.slice(expr.lastIndexOf('.apply(null, ') + 13, -1))[0];
        const filtered = opts.filterTab === 'errors' ? items.filter((i) => Number(i.status) >= 400) : items;
        return {
          networkTab: { tabFound: true, activated: false },
          filterTab: opts.filterTab,
          total: filtered.length,
          scrolled: true,
          items: filtered.map((it, i) => ({ index: i, rowId: `devtool-network-item-${it.n}`, ...it })),
        };
      }
      return {};
    },
  };
}

const REQS = [
  { n: 0, status: '400', method: 'POST', path: 'sentry?x=1', tSec: 2.99, fraction: 0.04 },
  { n: 3, status: '200', method: 'POST', path: 'bulk?api-version=v2', tSec: 4.63, fraction: 0.06 },
  { n: 7, status: '204', method: 'HEAD', path: '_health', tSec: 18.9, fraction: 0.25 },
  { n: 9, status: '500', method: 'GET', path: 'protocols', tSec: 20.1, fraction: 0.27 },
];

test('failedOnly returns 4xx/5xx only', async () => {
  const out = await listNetwork(makeNetwork(REQS), { failedOnly: true });
  assert.equal(out.filterTab, 'errors');
  assert.deepEqual(out.items.map((i) => i.status), ['400', '500']);
});

test('grep matches across method, path and status', async () => {
  const cloud = makeNetwork(REQS);
  assert.equal((await listNetwork(cloud, { grep: 'bulk' })).matched, 1);
  assert.equal((await listNetwork(cloud, { grep: '^HEAD' })).matched, 1);
  assert.equal((await listNetwork(cloud, { grep: '500' })).matched, 1);
  assert.equal((await listNetwork(cloud, { grep: '([bad' })).error, 'bad-grep');
});

test('rows are addressed by stable rowId, not position', async () => {
  // The list is virtualised, so position N in a previous listing is not
  // position N in the DOM now — a positional index would silently read a
  // different request's payload.
  const out = await listNetwork(makeNetwork(REQS), {});
  assert.equal(out.items[1].rowId, 'devtool-network-item-3');
  assert.ok(out.items.every((i) => /^devtool-network-item-\d+$/.test(i.rowId)));
});

test('isErrorStatus treats only 4xx/5xx as failures', () => {
  assert.equal(isErrorStatus('200'), false);
  assert.equal(isErrorStatus('204'), false);
  assert.equal(isErrorStatus('400'), true);
  assert.equal(isErrorStatus('503'), true);
  assert.equal(isErrorStatus(null), false);
  assert.equal(isErrorStatus('pending'), false);
});

test('a scrape spanning a re-render does not count the same test twice', async () => {
  // Applying a filter renumbers every RunTestResultRow-N, so a key built from
  // the group index treats the same test as new when the scrape straddles the
  // re-render. Observed live as "scraped 9" on a run with exactly 7 failures.
  // Keying on the stable spec path removes the whole class.
  // The key is built page-side, so it is asserted against the probe source.
  const src = require('../src/cloud-probe')._internals.runListSrc();
  assert.ok(!/var key = gi \+/.test(src), 'must not key on the volatile group index');
  assert.match(src, /spec \|\| \('g' \+ gi\)/, 'must key on the spec path, falling back to the group index');
});

test('a status filter is not trusted until every rendered row carries that status', async () => {
  // "Some rows are present" is satisfied by the stale pre-filter render, which
  // is exactly how the duplicate rows got in.
  const tests = [
    { specIndex: 0, spec: 'a.cy.js', suite: 'A', title: 'one', status: 'failed', hasReplay: true },
    { specIndex: 0, spec: 'a.cy.js', suite: 'A', title: 'two', status: 'passed', hasReplay: true },
  ];
  let renders = 0;
  const cloud = {
    async navigate() { return {}; },
    async evaluate(expr) {
      if (/function statusFilterProbe/.test(expr)) return { clicked: true, status: 'failed', expected: 1 };
      if (/function runTestsProbe/.test(expr)) {
        renders++;
        // First two reads still show the mixed, pre-filter list.
        const visible = renders <= 2 ? tests : tests.filter((t) => t.status === 'failed');
        const statusesSeen = {};
        for (const t of visible) statusesSeen[t.status] = (statusesSeen[t.status] || 0) + 1;
        return { scraped: visible.length, scrolled: false, hadScroller: false, counts: { failed: 1, passed: 1 }, statusesSeen, tests: visible.map((t, i) => ({ index: i, ...t })) };
      }
      return {};
    },
  };
  const out = await listTests(cloud, { status: 'failed', timeoutMs: 5000 });
  assert.equal(out.matched, 1, 'must wait past the stale render rather than scraping it');
  assert.ok(renders > 2, 'should have polled until the filtered render appeared');
});

test('a scrape that disagrees with the run count is retried, then flagged', async () => {
  // The authoritative number comes from the status link. A scrape returning MORE
  // than that is provably wrong (seen live as "scraped 9" on a run with 7
  // failures, racing a re-render). Retry; if it persists, say so rather than
  // returning a list we know is wrong.
  const failed = [
    { specIndex: 0, spec: 'a.cy.js', suite: 'A', title: 'one', status: 'failed', hasReplay: true },
    { specIndex: 0, spec: 'a.cy.js', suite: 'A', title: 'two', status: 'failed', hasReplay: true },
  ];
  const ghost = { specIndex: 9, spec: 'stale.cy.js', suite: 'S', title: 'ghost', status: 'failed', hasReplay: true };

  const build = (rows) => ({
    scraped: rows.length, scrolled: true, hadScroller: true,
    counts: { failed: 2 }, statusesSeen: { failed: rows.length },
    tests: rows.map((t, i) => ({ index: i, ...t })),
  });

  let reads = 0;
  const settling = {
    async navigate() { return {}; },
    async evaluate(expr) {
      if (/function statusFilterProbe/.test(expr)) return { clicked: true, status: 'failed', expected: 2 };
      if (/function runTestsProbe/.test(expr)) { reads++; return build(reads <= 2 ? [...failed, ghost] : failed); }
      return {};
    },
  };
  const recovered = await listTests(settling, { status: 'failed', timeoutMs: 4000 });
  assert.equal(recovered.matched, 2, 'the retry must land on the correct list');
  assert.equal(recovered.countMismatch, undefined, 'a recovered read is not flagged');

  const stuck = {
    async navigate() { return {}; },
    async evaluate(expr) {
      if (/function statusFilterProbe/.test(expr)) return { clicked: true, status: 'failed', expected: 2 };
      if (/function runTestsProbe/.test(expr)) return build([...failed, ghost]);
      return {};
    },
  };
  const flagged = await listTests(stuck, { status: 'failed', timeoutMs: 4000 });
  assert.deepEqual(flagged.countMismatch, { expected: 2, scraped: 3 }, 'a persistent disagreement must be surfaced');
});
