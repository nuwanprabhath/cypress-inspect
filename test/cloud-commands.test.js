const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  getCommands, stepTo, selectTest, resolveCommand, resolveTest, filterCommands,
} = require('../src/cloud-commands');

const CMDS = [
  { index: 0, number: '1', method: 'log', message: 'validateFieldOptions: {...}', state: 'passed', isPinned: false },
  { index: 1, number: '2', method: 'get', message: '[data-cy="slope"]', state: 'passed', isPinned: false },
  { index: 2, number: '2', method: 'get', message: '[data-cy="slope"] wrapper', state: 'passed', isPinned: false },
  { index: 3, number: '3', method: 'assert', message: 'expected 0 to equal 0', state: 'failed', isPinned: false },
  { index: 4, number: '4', method: 'click', message: 'submit', state: 'passed', isPinned: true },
];

// A stand-in for the replay page. `pinnable: false` models a click that misses —
// the failure that would otherwise leave you screenshotting the previous step.
function makeCloud({ commands = CMDS, pinnable = true, tests = null, loadAfter = 0 } = {}) {
  const state = { pinnedIndex: commands.findIndex((c) => c.isPinned), clicks: [], polls: 0 };
  // Probes are serialised functions, so the function NAME identifies which one
  // is being run. Matching on that beats matching on selector substrings, which
  // appear in several probes because the helpers are inlined into each.
  const args = (expr) => JSON.parse(expr.slice(expr.lastIndexOf('.apply(null, ') + 13, -1))[0] || {};
  return {
    state,
    async evaluate(expr) {
      if (/function pinCommandProbe/.test(expr)) {
        const idx = args(expr).index;
        state.clicks.push(idx);
        if (pinnable) state.pinnedIndex = idx;
        const pinned = commands[state.pinnedIndex];
        return {
          requestedIndex: idx,
          pinnedIndex: state.pinnedIndex,
          alreadyPinned: false,
          pinned: pinned ? { ...pinned, number: '', isPinned: true } : null,
          total: commands.length,
        };
      }
      if (/function commandsProbe/.test(expr)) {
        return { total: commands.length, pinnedIndex: state.pinnedIndex, commands };
      }
      if (/function selectTestProbe/.test(expr)) {
        const idx = args(expr).index;
        state.clicks.push(`test:${idx}`);
        return { clicked: true, test: tests[idx] };
      }
      if (/function testsProbe/.test(expr)) return { total: tests.length, tests };
      if (/test-replay-container/.test(expr)) {
        state.polls++;
        const loaded = state.polls > loadAfter;
        return {
          replayOpen: loaded,
          header: loaded ? tests[Number(String(state.clicks.at(-1)).split(':')[1])].title : null,
          timer: loaded ? '00:05 / 00:05' : null,
          hasScrubber: loaded,
          durationSec: loaded ? 5.73 : null,
          commandCount: loaded ? 71 : 0,
        };
      }
      return {};
    },
  };
}

// ── resolution ──────────────────────────────────────────────────────────────

test('a command is resolvable by index, displayed number, or grep', () => {
  assert.equal(resolveCommand(CMDS, { index: 3 }).index, 3);
  assert.equal(resolveCommand(CMDS, { grep: 'expected 0' }).index, 3);
  // Cypress emits several wrapper rows per displayed number; the LAST one is the
  // row whose snapshot the reporter pins.
  assert.equal(resolveCommand(CMDS, { number: '2' }).index, 2);
  assert.equal(resolveCommand(CMDS, { number: 2 }).index, 2);
});

test('an unresolvable command is an error, never a silent fallback to index 0', () => {
  // Pinning the wrong step and screenshotting it looks authoritative, so a miss
  // must never quietly become "step 0".
  assert.equal(resolveCommand(CMDS, { index: 99 }).error, 'index-out-of-range');
  assert.equal(resolveCommand(CMDS, { number: '404' }).error, 'number-not-found');
  assert.equal(resolveCommand(CMDS, { grep: 'nothing here' }).error, 'grep-no-match');
  assert.equal(resolveCommand(CMDS, { grep: '([bad' }).error, 'bad-grep');
  assert.equal(resolveCommand(CMDS, {}).error, 'nothing-specified');
});

test('an ambiguous grep reports the other candidates', () => {
  const r = resolveCommand(CMDS, { grep: 'slope' });
  assert.equal(r.index, 1, 'takes the first match');
  assert.equal(r.matched, 2);
  assert.equal(r.matches.length, 2, 'so the caller can pick a different one');
});

test('filters and paging report how much was not shown', () => {
  assert.equal(filterCommands(CMDS, { failedOnly: true }).matched, 1);
  assert.equal(filterCommands(CMDS, { grep: 'get' }).matched, 2);
  const paged = filterCommands(CMDS, { offset: 1, limit: 2 });
  assert.deepEqual(paged.page.map((c) => c.index), [1, 2]);
  assert.equal(paged.matched, 5, 'matched counts everything, not just the page');
});

test('a test is resolvable by index or grep over suite and title', () => {
  const tests = [
    { index: 0, suite: 'Landing', title: 'login', status: 'passed' },
    { index: 1, suite: 'Plot Description', title: 'Collect slope', status: 'failed' },
  ];
  assert.equal(resolveTest(tests, { index: 1 }).index, 1);
  assert.equal(resolveTest(tests, { grep: 'collect slope' }).index, 1);
  assert.equal(resolveTest(tests, { grep: 'Plot Description' }).index, 1);
  assert.equal(resolveTest(tests, { grep: 'nope' }).error, 'grep-no-match');
});

// ── orchestration ───────────────────────────────────────────────────────────

test('getCommands surfaces the total and the current pin alongside the page', async () => {
  const cloud = makeCloud();
  const out = await getCommands(cloud, { limit: 2 });
  assert.equal(out.total, 5);
  assert.equal(out.returned, 2);
  assert.equal(out.pinnedIndex, 4);
});

test('stepTo confirms the pin actually landed', async () => {
  const cloud = makeCloud();
  const out = await stepTo(cloud, { index: 3, waitMs: 0 });
  assert.equal(out.ok, true);
  assert.equal(out.pinnedIndex, 3);
  assert.deepEqual(cloud.state.clicks, [3]);
});

test('stepTo reports ok:false when the click misses, rather than claiming success', async () => {
  // Without this the agent screenshots the PREVIOUS step believing it is the
  // requested one — the same silent-wrong-state failure as the seek bug.
  const cloud = makeCloud({ pinnable: false });
  const out = await stepTo(cloud, { index: 1, waitMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.pinnedIndex, 4, 'the old pin is still in place');
  assert.match(out.hint, /Another command/);
});

test('stepTo restores the number the reporter hides behind the pin icon', async () => {
  const cloud = makeCloud();
  const out = await stepTo(cloud, { index: 3, waitMs: 0 });
  assert.equal(out.pinned.number, '3', 'a pinned row renders a pin icon in place of its number');
});

test('stepTo refuses an out-of-range index without clicking anything', async () => {
  const cloud = makeCloud();
  const out = await stepTo(cloud, { index: 99, waitMs: 0 });
  assert.equal(out.error, 'index-out-of-range');
  assert.equal(cloud.state.clicks.length, 0);
});

test('selectTest waits for the new replay instead of guessing a delay', async () => {
  // Measured live: switching tears the old replay down and takes several
  // seconds, so a fixed sleep either wastes time or reports a false failure.
  const tests = [
    { index: 0, suite: 'S', title: 'first', status: 'passed', hasReplay: true },
    { index: 1, suite: 'S', title: 'second', status: 'passed', hasReplay: true },
  ];
  const cloud = makeCloud({ tests, loadAfter: 3 });
  const out = await selectTest(cloud, { index: 1, timeoutMs: 10000 });
  assert.equal(out.ok, true);
  assert.equal(out.selected.title, 'second');
  assert.equal(out.replay.commandCount, 71);
  assert.ok(cloud.state.polls > 3, 'must have polled past the not-yet-loaded reads');
});

test('selectTest gives up with a hint rather than hanging forever', async () => {
  const tests = [{ index: 0, suite: 'S', title: 'first', status: 'passed', hasReplay: true }];
  const cloud = makeCloud({ tests, loadAfter: Infinity });
  const out = await selectTest(cloud, { index: 0, timeoutMs: 1500 });
  assert.equal(out.ok, false);
  assert.match(out.hint, /did not finish loading/);
});
