const assert = require('node:assert/strict');
const { test } = require('node:test');

const { seekReplay, TOLERANCE } = require('../src/cloud-seek');

/*
 * A stand-in for the replay's timeline.
 *
 * The behaviours modelled here are the ones measured against a live Cypress
 * Cloud replay, because they are what broke the first implementation:
 *
 *   • The scrubber is a CONTROLLED input. Writing `.value` from page script does
 *     nothing — only a trusted pointer press moves it. `ignoreScriptedWrites`
 *     makes that explicit.
 *   • The value updates ASYNCHRONOUSLY. A read immediately after the press still
 *     returns the previous position, which is what made a broken seek look
 *     successful.
 */
function makeReplay({ min = 1_000_000, span = 15_000, lagReads = 1, thumbOffset = 0 } = {}) {
  const rect = { x: 100, y: 600, width: 500, height: 32 };
  const state = {
    value: min + span, // parked at the end, as a finished replay is
    pending: null,
    pendingReads: 0,
    clicks: [],
    scriptedWrites: 0,
  };
  const observed = () => ({
    min,
    max: min + span,
    value: state.value,
    fraction: (state.value - min) / span,
    rect,
    timer: `00:${String(Math.floor((state.value - min) / 1000)).padStart(2, '0')} / 00:15`,
  });
  return {
    state,
    rect,
    cloud: {
      async evaluate(expr) {
        // Page-side writes to a controlled input are silently ignored.
        if (/setter|dispatchEvent/.test(expr)) { state.scriptedWrites++; return { ok: true }; }
        if (/scrollingElement|scrollTop/.test(expr)) {
          return { scrollTop: 42, scrollHeight: 2000, clientHeight: 800, via: 'id' };
        }
        // A pending press only becomes visible after `lagReads` observations.
        if (state.pending != null) {
          if (state.pendingReads >= lagReads) { state.value = state.pending; state.pending = null; state.pendingReads = 0; }
          else state.pendingReads++;
        }
        return observed();
      },
      async clickAt(x, y) {
        state.clicks.push({ x, y });
        const f = Math.max(0, Math.min(1, (x - rect.x) / rect.width + thumbOffset));
        state.pending = min + f * span;
        state.pendingReads = 0;
      },
    },
  };
}

test('a seek lands on the requested fraction and reports the replay timer', async () => {
  const { cloud, state } = makeReplay();
  const out = await seekReplay(cloud, { fraction: 0.25, waitMs: 0 });
  assert.equal(out.seek.ok, true);
  assert.ok(Math.abs(out.seek.fraction - 0.25) <= TOLERANCE);
  assert.equal(out.seek.requested, 0.25);
  assert.equal(state.clicks.length, 1, 'one press should suffice when the track maps linearly');
  // The rendered timer is independent evidence: reading back the input's own
  // value cannot distinguish "the replay moved" from "we wrote to a field".
  assert.match(out.seek.timer, /^00:03/);
});

test('a seek waits out the async value update instead of reading a stale position', async () => {
  // The original bug: the value updates on a later tick, so a single read after
  // the press returns the PREVIOUS position. That made a failed seek report
  // success, and every screenshot afterwards was silently of the wrong moment.
  const { cloud } = makeReplay({ lagReads: 4 });
  const out = await seekReplay(cloud, { fraction: 0.5, waitMs: 0 });
  assert.equal(out.seek.ok, true);
  assert.ok(Math.abs(out.seek.fraction - 0.5) <= TOLERANCE, `landed at ${out.seek.fraction}`);
});

test('a systematic track offset is corrected by a second attempt', async () => {
  // e.g. the native range thumb's width means pointer x does not map exactly to
  // value. Rather than assume linearity, the seek measures and corrects.
  const { cloud, state } = makeReplay({ thumbOffset: 0.15 });
  const out = await seekReplay(cloud, { fraction: 0.25, waitMs: 0 });
  assert.equal(out.seek.ok, true, `landed at ${out.seek.fraction} after ${state.clicks.length} attempts`);
  assert.ok(state.clicks.length > 1, 'the offset should have forced a correcting press');
  assert.ok(Math.abs(out.seek.fraction - 0.25) <= TOLERANCE);
});

test('an unreachable target is reported as ok:false, not as success', async () => {
  // Never claim a seek worked when it did not — a wrong-moment screenshot that
  // looks authoritative is worse than an error.
  const { cloud } = makeReplay({ thumbOffset: 0.9 });
  const out = await seekReplay(cloud, { fraction: 0.05, waitMs: 0 });
  assert.equal(out.seek.ok, false);
  assert.match(out.seek.hint, /stopped at/);
});

test('timeMs is an absolute scrubber value, not an offset', async () => {
  const { cloud } = makeReplay({ min: 1_000_000, span: 15_000 });
  const out = await seekReplay(cloud, { timeMs: 1_000_000 + 7293, waitMs: 0 });
  assert.equal(out.seek.ok, true);
  assert.equal(out.seek.positionSec, 7.29);
});

test('a seek out of range is clamped rather than throwing', async () => {
  const { cloud } = makeReplay();
  const low = await seekReplay(cloud, { timeMs: 0, waitMs: 0 });
  assert.equal(low.seek.requested, 0);
  const high = await seekReplay(cloud, { timeMs: 9e15, waitMs: 0 });
  assert.equal(high.seek.requested, 1);
});

test('scrolling alone does not press the timeline', async () => {
  const { cloud, state } = makeReplay();
  const out = await seekReplay(cloud, { scrollTo: 500, waitMs: 0 });
  assert.equal(out.seek, null);
  assert.equal(state.clicks.length, 0);
  assert.equal(out.scroll.scrollTop, 42);
});

test('a missing scrubber is reported with a usable hint', async () => {
  const cloud = { async evaluate() { return { error: 'no-scrubber' }; }, async clickAt() {} };
  const out = await seekReplay(cloud, { fraction: 0.5, waitMs: 0 });
  assert.equal(out.error, 'no-scrubber');
  assert.match(out.hint, /Test Replay/);
});

test('the seek never writes to the input from page script', async () => {
  // Guards the regression directly: page-side writes are ignored by the
  // controlled component, so relying on them is what silently did nothing.
  const { cloud, state } = makeReplay();
  await seekReplay(cloud, { fraction: 0.4, waitMs: 0 });
  assert.equal(state.scriptedWrites, 0, 'must drive the scrubber with trusted pointer events only');
  assert.ok(state.clicks.length >= 1);
});
