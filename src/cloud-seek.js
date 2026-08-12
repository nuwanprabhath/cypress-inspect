/*
 * Seeking the Cypress Cloud replay timeline.
 *
 * This lives outside `cloud-probe.js` because it cannot be done from inside the
 * page. The scrubber is a controlled React <input type=range>: its value comes
 * from player state, so a page-side probe that assigns `.value` and dispatches
 * `input`/`change` is ignored — React re-renders the previous value immediately.
 * Measured against a live replay, that approach reported a successful seek while
 * the timer never left 00:15 / 00:15, which is a far worse failure than an error
 * because every screenshot afterwards is silently of the wrong moment.
 *
 * What does work is a TRUSTED pointer press on the track, dispatched through the
 * CDP Input domain. Pressing at the target x lands within ~0.001 of the wanted
 * fraction. The catch is that the input's value updates asynchronously, so a
 * single read straight after the press returns the PREVIOUS position — hence the
 * settle-poll below rather than a fixed sleep.
 */

const probe = require('./cloud-probe');

// Fraction tolerance for a landed seek. The measured press error was ~0.001;
// 0.005 of a 60 s run is ~0.3 s, comfortably inside one replay frame.
const TOLERANCE = 0.005;
const MAX_ATTEMPTS = 3;

// Read the scrubber's geometry and current value together, so the pointer maths
// and the verification are based on the same observation.
const SCRUBBER_STATE = `(() => {
  var i = document.querySelector('[data-cy=scrubber-container] input[type=range]')
    || document.querySelector('input[class*="scrubber-input"]');
  if (!i) {
    var ranges = Array.prototype.slice.call(document.querySelectorAll('input[type=range]'));
    for (var k = 0; k < ranges.length; k++) {
      if (Number(ranges[k].min) > 1e12 && Number(ranges[k].max) > Number(ranges[k].min)) { i = ranges[k]; break; }
    }
  }
  if (!i) return { error: 'no-scrubber' };
  var r = i.getBoundingClientRect();
  var min = Number(i.min), max = Number(i.max), v = Number(i.value);
  if (!(r.width > 0)) return { error: 'scrubber-not-visible' };
  return {
    min: min, max: max, value: v,
    fraction: max > min ? (v - min) / (max - min) : 0,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    timer: (function () { var t = document.querySelector('[data-cy=TimerDisplay]'); return t ? t.innerText.replace(/\\s+/g, ' ').trim() : null; })(),
  };
})()`;

// Poll until the value reaches `want`, or stops moving. Returns the last state.
//
// The grace period matters more than it looks. During the press's update lag the
// value is legitimately unchanged, so an "it stopped moving" rule with no floor
// mistakes the lag for the final position and returns the PREVIOUS moment — the
// exact false-success this whole module exists to prevent. Stability may only
// end the poll once enough time has passed for a real update to have landed;
// before that, only reaching the target ends it early.
async function settle(cloud, want, { timeoutMs = 3000, pollMs = 150, graceMs = 800 } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last = null;
  let stableReads = 0;
  for (;;) {
    const s = await cloud.evaluate(SCRUBBER_STATE);
    if (s?.error) return s;
    if (want != null && Math.abs(s.fraction - want) <= TOLERANCE) return s;
    if (last && Math.abs(s.fraction - last.fraction) < 1e-6) stableReads++;
    else stableReads = 0;
    if (stableReads >= 2 && Date.now() - startedAt >= graceMs) return s;
    last = s;
    if (Date.now() >= deadline) return s;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/*
 * Seek to `fraction` (0..1) or `timeMs` (an absolute scrubber value), then
 * optionally scroll the app frame.
 *
 * The scroll is part of this operation because seeking triggers an async replay
 * re-render that resets the app frame's scrollTop; a separately-issued scroll
 * would be undone. Order is seek -> settle -> scroll (re-asserted).
 */
async function seekReplay(cloud, { fraction, timeMs, scrollTo, scrollBy, waitMs = 450 } = {}) {
  const wantsSeek = fraction != null || timeMs != null;
  const wantsScroll = scrollTo != null || scrollBy != null;

  let state = await cloud.evaluate(SCRUBBER_STATE);
  if (state?.error) return { error: state.error, hint: 'The replay timeline was not found — is a Test Replay actually loaded? Check `cloud_status`.' };

  const out = { seek: null, scroll: null };

  if (wantsSeek) {
    const span = state.max - state.min;
    const want = Math.max(0, Math.min(1,
      fraction != null ? fraction : (span > 0 ? (timeMs - state.min) / span : 0)));

    const attempts = [];
    let landed = state.fraction;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const { rect } = state;
      // Correct for any systematic offset (e.g. the native thumb's width) by
      // aiming at want + the previous attempt's error, rather than assuming the
      // track maps linearly edge to edge.
      const correction = attempts.length ? want - landed : 0;
      const aim = Math.max(0, Math.min(1, want + correction));
      const x = Math.round(rect.x + rect.width * aim);
      const y = Math.round(rect.y + rect.height / 2);
      await cloud.clickAt(x, y);
      const after = await settle(cloud, want);
      if (after?.error) return { error: after.error };
      landed = after.fraction;
      state = after;
      attempts.push({ aimedAt: Number(aim.toFixed(4)), landedAt: Number(landed.toFixed(4)), x, y });
      if (Math.abs(landed - want) <= TOLERANCE) break;
    }

    const ok = Math.abs(landed - want) <= TOLERANCE;
    out.seek = {
      requested: Number(want.toFixed(4)),
      fraction: Number(landed.toFixed(4)),
      value: state.value,
      positionSec: Number(((state.value - state.min) / 1000).toFixed(2)),
      durationSec: Number(((state.max - state.min) / 1000).toFixed(2)),
      // The rendered timer is independent evidence that the replay actually
      // moved, rather than just the input's value having been written.
      timer: state.timer,
      ok,
      attempts,
    };
    if (!ok) {
      out.seek.hint = `The timeline stopped at ${landed.toFixed(4)} instead of ${want.toFixed(4)} after ${attempts.length} attempts. ` +
        'The replay may still be buffering; retry, or check that the footer scrubber is visible (it needs the replay panel open).';
    }
  }

  await new Promise((r) => setTimeout(r, waitMs));

  if (wantsScroll) {
    const res = await cloud.evaluate(probe.scrollAppExpr({
      scrollTo: scrollTo ?? null,
      scrollBy: scrollBy ?? null,
    }));
    if (res?.error) return Object.assign(out, { error: res.error, appFrameVia: res.appFrameVia });
    out.scroll = res;
  }

  return out;
}

module.exports = { seekReplay, SCRUBBER_STATE, TOLERANCE };
