/*
 * Run-level navigation: get from a Cypress Cloud RUN to the one test worth
 * looking at.
 *
 * The replay-level tools assume you already have a replay open. This module
 * covers the step before that — a run has hundreds of tests across many specs,
 * and the usual question is "which one failed and what happened".
 *
 * The load-bearing detail throughout: the run's test-results list is
 * VIRTUALISED. A 532-test run renders about 15 rows, so any single-pass read
 * silently reports 15 tests. Every listing here either narrows with the UI's own
 * filters first (cheap, exact) or scrolls the list, and always reports the run's
 * own counts alongside so a truncated scrape cannot be mistaken for a short run.
 */

const probe = require('./cloud-probe');

/*
 * Does `re` match any of these fields, individually or joined?
 *
 * Testing only the joined string breaks anchors: a caller greps `^submit$` for a
 * test titled "submit" and matches nothing, because the haystack was
 * "basal 3 > publish submit". Testing each field as well makes the obvious
 * pattern do the obvious thing, while still allowing a cross-field match.
 */
function matchesAny(re, fields) {
  const parts = fields.filter((f) => f != null && f !== '');
  if (parts.some((f) => re.test(f))) return true;
  return re.test(parts.join(' '));
}

const RUN_URL = /^(https?:\/\/cloud\.cypress\.io\/projects\/[A-Za-z0-9]+\/runs\/\d+)/;

// Normalise any Cypress Cloud run/replay URL to that run's test-results view,
// which is where every filter and every test row lives.
function toTestResultsUrl(url) {
  const m = String(url).match(RUN_URL);
  if (!m) return null;
  return `${m[1]}/test-results`;
}

/*
 * Return to the run's test-results view.
 *
 * Every filtering and listing call needs this first. Opening a Test Replay
 * leaves the results list mounted behind the overlay, frozen on whichever filter
 * was active at the time — so a status switch made from there reads the stale
 * background list and returns the wrong tests entirely.
 */
async function ensureResultsView(cloud, { timeoutMs = 15000 } = {}) {
  const state = await cloud.evaluate(probe.RESULTS_VIEW_STATE()).catch(() => null);
  if (!state?.replayOpen) return { wasOpen: false };
  const closed = await cloud.evaluate(probe.CLOSE_REPLAY()).catch(() => null);
  const settled = await waitFor(async () => {
    const s = await cloud.evaluate(probe.RESULTS_VIEW_STATE()).catch(() => null);
    return s && !s.replayOpen && s.hasStatusLinks ? s : null;
  }, { timeoutMs, pollMs: 400 });
  return { wasOpen: true, closed: !!settled, detail: closed };
}

async function waitFor(fn, { timeoutMs = 30000, pollMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/*
 * Open a run and land on its test-results list.
 *
 * A bare run URL redirects to /overview, which has no test rows at all — so an
 * agent that opened the run and asked for tests would get nothing and reasonably
 * conclude the run was empty. Going straight to /test-results avoids that.
 */
async function openRun(cloud, url, { timeoutMs = 45000 } = {}) {
  const target = toTestResultsUrl(url);
  if (!target) {
    return {
      error: 'not-a-run-url',
      url,
      hint: 'Expected a Cypress Cloud run URL like https://cloud.cypress.io/projects/<id>/runs/<n> (a replay URL for that run works too).',
    };
  }
  await cloud.navigate(target);
  const ready = await waitFor(async () => {
    const r = await cloud.evaluate(probe.runTestsExpr({ scroll: false, maxScrollSteps: 0, stepDelayMs: 0 })).catch(() => null);
    if (r && !r.error && (r.scraped > 0 || Object.keys(r.counts || {}).length)) return r;
    return null;
  }, { timeoutMs });

  if (!ready) {
    return {
      error: 'run-did-not-load',
      url: target,
      hint: 'The run\'s test-results list did not appear. Check `cloud_status` — if `looksLoggedOut` is true, sign in once in the debug browser window.',
    };
  }
  // Deliberately NOT reporting a test count here: at this instant the list has
  // usually rendered zero rows (counts arrive first), and a `visibleTests: 0`
  // next to "ok: true" reads like an empty run. `counts` is the real answer.
  return { ok: true, url: target, counts: ready.counts, rowsMountedAtLoad: ready.scraped };
}

async function listSpecs(cloud, { timeoutMs = 20000 } = {}) {
  const tab = await cloud.evaluate(probe.runTabExpr('specs'));
  if (tab?.error) {
    return { error: 'no-specs-tab', hint: 'This page has no run tabs — open a run first with `cloud_open_run`.' };
  }
  const got = await waitFor(async () => {
    const r = await cloud.evaluate(probe.SPECS()).catch(() => null);
    return r && r.total > 0 ? r : null;
  }, { timeoutMs });
  return got || { total: 0, specs: [], hint: 'The Specs tab loaded no spec rows — the run may still be loading.' };
}

/*
 * List a run's tests.
 *
 * `status` is applied through the run's own summary links (clicking "1 failed"),
 * which is both exact and enormously cheaper than scrolling every row — and the
 * common case is "show me the failure". `spec` and `grep` are then applied here.
 */
async function listTests(cloud, { status, spec, grep, limit = 200, scroll = true, timeoutMs = 20000 } = {}) {
  const view = await ensureResultsView(cloud);

  // Spec BEFORE status: narrowing to one spec first turns a 337-row scroll into
  // single figures. Filtering by spec in JS after the fact does not work at run
  // scale — the scrape has to reach the target rows before it can match them,
  // and a partial read matches nothing at all.
  let specFilter = null;
  if (spec) {
    specFilter = await cloud.evaluate(probe.specFilterExpr({
      pattern: spec, openWaitMs: 900, applyWaitMs: 900,
    }));
    if (specFilter?.error === 'bad-spec-pattern') return { error: 'bad-spec-pattern', spec };
    if (specFilter?.error === 'spec-not-found') {
      return {
        error: 'spec-not-found',
        spec,
        available: specFilter.available,
        hint: 'No spec in this run matches that pattern. The list above is what the run actually contains.',
      };
    }
    // If the UI filter is unavailable, fall through: the JS-side filter below
    // still applies, just less reliably on a large run.
  }

  let expectedCount = null;
  if (status) {
    const applied = await cloud.evaluate(probe.statusFilterExpr({ status }));
    if (applied?.error === 'no-status-link') {
      return {
        error: 'no-status-link',
        status,
        counts: applied.counts,
        hint: `No "${status}" filter on this page. Valid: failed, passed, pending, skipped. Are you on a run's test-results view (\`cloud_open_run\`)?`,
      };
    }
    expectedCount = applied?.expected ?? null;
    // Wait for the list to actually re-render behind the filter.
    //
    // "Some rows are present" is NOT a sufficient signal: the pre-filter rows are
    // still on screen for a moment, so a scrape starting then mixes both renders.
    // Measured live as `scraped 9` on a run with 7 failures. The precise
    // condition is that every rendered row now carries the requested status.
    await waitFor(async () => {
      const r = await cloud.evaluate(probe.runTestsExpr({ scroll: false, maxScrollSteps: 0, stepDelayMs: 0 })).catch(() => null);
      if (!r || r.error) return null;
      if (applied?.expected === 0) return r;
      if (!r.scraped) return null;
      const seen = Object.keys(r.statusesSeen || {});
      return seen.length === 1 && seen[0] === status ? r : null;
    }, { timeoutMs, pollMs: 400 });
  }

  const scrapeOnce = () => cloud.evaluate(probe.runTestsExpr({
    scroll,
    maxScrollSteps: 400,
    stepDelayMs: 120,
  }));

  let raw = await scrapeOnce();
  if (raw?.error) return raw;

  /*
   * Reconcile against the run's own count.
   *
   * The status link tells us exactly how many rows there should be, so a scrape
   * returning MORE than that is provably wrong — seen intermittently as
   * "scraped 9" on a run with 7 failures, when the scrape raced a re-render and
   * picked up rows from both. The mechanism is timing-dependent and awkward to
   * pin down; reconciling against the authoritative number is robust whatever
   * the cause. Retry a couple of times, and if it still disagrees, SAY SO rather
   * than returning a list we know to be wrong.
   */
  // Only reconcile when the status filter is the ONLY narrowing in play. With a
  // spec filter also applied, the status link still reports the run-wide count
  // (337 passed), so comparing against it would flag every correct per-spec read
  // as a mismatch — a false alarm is as corrosive as a missed one.
  let countMismatch = null;
  if (status && expectedCount != null && !spec) {
    for (let attempt = 0; attempt < 3 && raw.scraped !== expectedCount; attempt++) {
      await new Promise((r) => setTimeout(r, 600));
      const retry = await scrapeOnce();
      if (!retry?.error) raw = retry;
    }
    if (raw.scraped !== expectedCount) {
      countMismatch = { expected: expectedCount, scraped: raw.scraped };
    }
  }

  let tests = raw.tests;
  if (spec) {
    let re;
    try { re = new RegExp(spec, 'i'); } catch { return { error: 'bad-spec-pattern', spec }; }
    tests = tests.filter((t) => re.test(t.spec || ''));
  }
  if (grep) {
    let re;
    try { re = new RegExp(grep, 'i'); } catch { return { error: 'bad-grep', grep }; }
    tests = tests.filter((t) => matchesAny(re, [t.title, t.suite, t.spec]));
  }

  const matched = tests.length;
  return {
    counts: raw.counts,
    scraped: raw.scraped,
    scrolled: raw.scrolled,
    filter: { status: status || null, spec: spec || null, grep: grep || null },
    matched,
    returned: Math.min(matched, limit),
    ...(view.wasOpen ? { closedReplayFirst: true } : {}),
    ...(specFilter && !specFilter.error ? { specFilterApplied: specFilter.selected } : {}),
    ...(specFilter?.error ? { specFilterUnavailable: specFilter.error } : {}),
    ...(countMismatch ? { countMismatch } : {}),
    tests: tests.slice(0, limit).map((t, i) => ({ ...t, index: i })),
  };
}

/*
 * Open a test's replay from the run list.
 *
 * Identified the same way it was listed (index into the filtered result, or a
 * grep), then polled to ready — Cypress Cloud tears down and rebuilds the replay,
 * which was measured taking longer than 4.5 s.
 */
async function openTestReplay(cloud, { index, grep, status, spec, timeoutMs = 45000 } = {}) {
  const listed = await listTests(cloud, { status, spec, grep, limit: 500 });
  if (listed?.error) return listed;
  if (!listed.tests.length) {
    return { error: 'no-matching-test', filter: listed.filter, counts: listed.counts, hint: 'Nothing matched. Widen the filter, or call `cloud_list_tests` to see what is there.' };
  }
  const pick = index != null ? listed.tests[index] : listed.tests[0];
  if (!pick) return { error: 'index-out-of-range', index, total: listed.tests.length };

  /*
   * Re-find the row in the CURRENT DOM before clicking — the visible rows shift
   * as the list scrolls, so a positional index from the scrape is not a DOM
   * index.
   *
   * Matching on the TITLE ALONE is not enough, and getting this wrong is silent
   * and severe. Test titles repeat across specs whenever they come from shared
   * helper commands: asking for `specify barcode to autofill trap ID` in
   * vertebrate-trap-3 opened the identically-titled test in
   * vertebrate-trap-2 — the tool then reported, and the agent then analysed,
   * the wrong spec entirely. The spec path (and suite, when present) must match
   * too, and if no row satisfies all of it, that is an error rather than a
   * near-enough click.
   */
  const clicked = await cloud.evaluate(`(() => {
    var wraps = Array.prototype.slice.call(document.querySelectorAll('[data-cy=parent-test-row-wrapper]'));
    var wantTitle = ${JSON.stringify(pick.title)};
    var wantSpec = ${JSON.stringify(pick.spec || '')};
    var wantSuite = ${JSON.stringify(pick.suite || '')};
    var seen = [];
    for (var i = 0; i < wraps.length; i++) {
      var frags = Array.prototype.slice.call(wraps[i].querySelectorAll('[data-cy=test-title-fragment]'))
        .map(function (f) { return (f.textContent || '').replace(/\\s+/g, ' ').trim(); }).filter(Boolean);
      var title = frags.length ? frags[frags.length - 1] : '';
      var suite = frags.length > 1 ? frags.slice(0, -1).join(' > ') : '';
      // The spec path lives on the enclosing per-spec group, not the row.
      var grp = wraps[i].closest ? wraps[i].closest('[data-cy^=RunTestResultRow-]') : null;
      var pathEl = grp ? grp.querySelector('[data-cy=test-results__spec-path-container]') : null;
      var spec = pathEl ? (pathEl.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      seen.push({ spec: spec, suite: suite, title: title });
      if (title !== wantTitle) continue;
      if (wantSpec && spec && spec !== wantSpec) continue;
      if (wantSuite && suite && suite !== wantSuite) continue;
      var b = wraps[i].querySelector('[data-cy=artifact-controls_replay]');
      if (!b) return { error: 'no-replay-button' };
      wraps[i].scrollIntoView({ block: 'center' });
      b.click();
      return { clicked: true, title: title, spec: spec, suite: suite };
    }
    return { error: 'row-not-rendered', wantTitle: wantTitle, wantSpec: wantSpec, rendered: wraps.length, seen: seen.slice(0, 20) };
  })()`);
  if (clicked?.error) {
    return {
      ...clicked,
      test: pick,
      hint: clicked.error === 'row-not-rendered'
        ? 'The list scrolled that row out of the DOM. Narrow with `status`/`spec` so the target is among the visible rows, then retry.'
        : 'That test has no Test Replay artifact recorded.',
    };
  }

  const state = await waitFor(async () => {
    const s = await cloud.evaluate(probe.REPLAY_STATE()).catch(() => null);
    return s?.replayOpen && s.hasScrubber && s.commandCount > 0 ? s : null;
  }, { timeoutMs });

  const openedWrongTest = !!(state?.header && pick.title && !pick.title.includes(state.header) && !state.header.includes(pick.title));
  return {
    ok: !!state && !openedWrongTest,
    test: pick,
    clickedRow: clicked.clicked ? { spec: clicked.spec, suite: clicked.suite, title: clicked.title } : undefined,
    replay: state,
    ...(openedWrongTest
      ? { error: 'opened-wrong-test', hint: `The replay that opened is titled "${state.header}", not "${pick.title}". Titles repeat across specs; re-run narrowing with \`spec\` and \`grep\` together.` }
      : {}),
    ...(state ? {} : { hint: 'The replay did not finish loading in time. Check `cloud_status`, then retry.' }),
  };
}

module.exports = { openRun, listSpecs, listTests, openTestReplay, toTestResultsUrl };
