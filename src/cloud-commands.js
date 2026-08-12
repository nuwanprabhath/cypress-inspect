/*
 * Command-log and test-list navigation for a Cypress Cloud replay.
 *
 * Kept out of `cloud-probe.js` because these are multi-step operations with
 * verification, not single page reads: pinning has to be confirmed to have
 * landed, and switching test has to be waited out (measured well over five
 * seconds against a live replay). The probes stay dumb; the retry/poll policy
 * lives here.
 */

const probe = require('./cloud-probe');

// Resolve "which command did the caller mean" from any of three ways of saying
// it. Returns { index } or { error, ... } with enough context to fix the call.
function resolveCommand(commands, { index, number, grep }) {
  if (index != null) {
    if (index < 0 || index >= commands.length) {
      return { error: 'index-out-of-range', index, total: commands.length };
    }
    return { index };
  }
  if (number != null) {
    const want = String(number);
    const hits = commands.filter((c) => c.number === want);
    if (!hits.length) return { error: 'number-not-found', number: want };
    // A displayed number can repeat across Cypress's wrapper rows; the last row
    // carrying it is the one whose snapshot the reporter pins.
    return { index: hits[hits.length - 1].index };
  }
  if (grep) {
    let re;
    try { re = new RegExp(grep, 'i'); } catch { return { error: 'bad-grep', grep }; }
    const hits = commands.filter((c) => re.test(`${c.method || ''} ${c.message || ''}`));
    if (!hits.length) return { error: 'grep-no-match', grep };
    return { index: hits[0].index, matched: hits.length, matches: hits.slice(0, 10) };
  }
  return { error: 'nothing-specified' };
}

function filterCommands(commands, { grep, failedOnly, offset = 0, limit = 100 }) {
  let out = commands;
  if (failedOnly) out = out.filter((c) => c.state === 'failed');
  if (grep) {
    let re;
    try { re = new RegExp(grep, 'i'); } catch { return { error: 'bad-grep', grep }; }
    out = out.filter((c) => re.test(`${c.method || ''} ${c.message || ''}`));
  }
  const matched = out.length;
  return { matched, page: out.slice(offset, offset + limit) };
}

async function getCommands(cloud, opts = {}) {
  const raw = await cloud.evaluate(probe.COMMANDS());
  if (raw?.error) return raw;
  const filtered = filterCommands(raw.commands, opts);
  if (filtered.error) return filtered;
  return {
    total: raw.total,
    pinnedIndex: raw.pinnedIndex,
    matched: filtered.matched,
    offset: opts.offset || 0,
    returned: filtered.page.length,
    commands: filtered.page,
  };
}

/*
 * Pin a command so the app frame renders its snapshot, then confirm it landed.
 *
 * The confirmation matters: a click that misses (wrong element, re-render mid
 * click) leaves the PREVIOUS pin in place, and every screenshot afterwards would
 * silently be of the wrong step while looking authoritative — the same failure
 * class as the seek bug.
 */
async function stepTo(cloud, { index, number, grep, waitMs = 400 } = {}) {
  const raw = await cloud.evaluate(probe.COMMANDS());
  if (raw?.error) return raw;

  const target = resolveCommand(raw.commands, { index, number, grep });
  if (target.error) return { ...target, total: raw.total };

  const res = await cloud.evaluate(probe.pinCommandExpr({
    index: target.index,
    waitMs,
    scrollIntoView: true,
  }));
  if (res?.error) return res;

  const ok = res.pinnedIndex === target.index;
  const state = await cloud.evaluate(probe.REPLAY_STATE()).catch(() => null);
  // The reporter replaces a pinned row's number with a pin icon, so re-reading
  // the row after the click loses it. Carry the pre-click number over.
  const pinned = res.pinned && !res.pinned.number
    ? { ...res.pinned, number: raw.commands[res.pinnedIndex]?.number ?? null }
    : res.pinned;
  return {
    ok,
    requestedIndex: target.index,
    pinnedIndex: res.pinnedIndex,
    pinned,
    alreadyPinned: res.alreadyPinned,
    // The replay's own clock is independent evidence that the snapshot moved,
    // rather than just a class having been toggled.
    timer: state?.timer ?? null,
    ...(target.matched > 1 ? { grepMatched: target.matched, otherMatches: target.matches } : {}),
    ...(ok ? {} : {
      hint: res.pinnedIndex < 0
        ? 'The click did not pin anything. The reporter may have re-rendered — retry, or pass an explicit `index` from `cloud_get_commands`.'
        : `Another command (index ${res.pinnedIndex}) is pinned instead. Retry with an explicit \`index\`.`,
    }),
  };
}

async function listTests(cloud) {
  return cloud.evaluate(probe.TESTS());
}

function resolveTest(tests, { index, grep }) {
  if (index != null) {
    if (index < 0 || index >= tests.length) return { error: 'index-out-of-range', index, total: tests.length };
    return { index };
  }
  if (grep) {
    let re;
    try { re = new RegExp(grep, 'i'); } catch { return { error: 'bad-grep', grep }; }
    const hits = tests.filter((t) => re.test(`${t.suite || ''} ${t.title || ''}`));
    if (!hits.length) return { error: 'grep-no-match', grep };
    if (hits.length > 1) return { index: hits[0].index, matched: hits.length, matches: hits.slice(0, 10) };
    return { index: hits[0].index };
  }
  return { error: 'nothing-specified' };
}

/*
 * Switch which test is being replayed.
 *
 * Clicking the row's "Test Replay" button tears the current replay down and
 * builds another. Measured live, that took longer than 4.5 s and left the
 * overlay closed in between — so a fixed sleep either wastes time or reports
 * failure on a load that was merely slow. Poll for the real end state instead:
 * replay open, on the expected test, with a timeline and a command log.
 */
async function selectTest(cloud, { index, grep, timeoutMs = 30000 } = {}) {
  const list = await cloud.evaluate(probe.TESTS());
  if (list?.error) return list;

  const target = resolveTest(list.tests, { index, grep });
  if (target.error) return { ...target, total: list.total };
  const wanted = list.tests[target.index];

  const clicked = await cloud.evaluate(probe.selectTestExpr({ index: target.index }));
  if (clicked?.error) return clicked;

  const deadline = Date.now() + timeoutMs;
  let state = null;
  for (;;) {
    state = await cloud.evaluate(probe.REPLAY_STATE()).catch(() => null);
    const onTarget = state?.replayOpen && state.hasScrubber && state.commandCount > 0
      && (!wanted.title || (state.header && wanted.title.includes(state.header)) || (state.header && state.header.includes(wanted.title)));
    if (onTarget) break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 750));
  }

  const ok = !!(state?.replayOpen && state.hasScrubber && state.commandCount > 0);
  return {
    ok,
    selected: wanted,
    replay: state,
    ...(target.matched > 1 ? { grepMatched: target.matched, otherMatches: target.matches } : {}),
    ...(ok ? {} : {
      hint: 'The replay did not finish loading in time. Cypress Cloud tears the old replay down before building the new one, which can take a while — call `cloud_status` to check, then retry.',
    }),
  };
}

module.exports = { getCommands, stepTo, listTests, selectTest, resolveCommand, resolveTest, filterCommands };
