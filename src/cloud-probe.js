/*
 * Page-side probes for a Cypress Cloud Test Replay page.
 *
 * Each probe is written as a REAL function here and serialised with
 * `Function.prototype.toString` by `expr()` below, rather than being kept as a
 * string literal. Escaping nested template literals inside a string-literal
 * probe is where the original helper scripts became unreadable, and a syntax
 * error in a string is only discovered at eval time in the browser.
 *
 * Consequences of the serialisation, which every probe must respect:
 *   • No closures. A probe sees only its own arguments.
 *   • No requires, no module scope.
 *   • Return JSON-serialisable values only.
 *   • On failure return `{ error: '<code>', ...diagnostics }` instead of
 *     throwing, and name the selector that missed. Cypress Cloud is a hosted app
 *     that redesigns without notice, so "which lookup failed" is the single most
 *     valuable thing a probe can report.
 */

// Serialise `fn` into an immediately-applied expression with `args` baked in.
function expr(fn, ...args) {
  return `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
}

// ───────────────────────── shared page-side helpers ─────────────────────────
// Inlined into each probe that needs them (probes cannot share scope). Kept as
// source strings so they can be prepended inside the serialised function body.

/*
 * Find the replay timeline scrubber.
 *
 * The scrubber is an <input type=range> whose value is an epoch-ms timestamp
 * spanning the whole run. Cypress Cloud ships CSS-module class names with a
 * per-build hash (`_scrubber-input_frhir_21`), so matching that exact class —
 * as the original shot.js did — breaks on their next deploy. Ordered fallbacks,
 * cheapest and most stable first:
 *   1. the data-cy hook (stable, semantic)
 *   2. a hashed class name matched by its stable prefix, not the whole string
 *   3. ANY range input whose min/max look like epoch milliseconds — a structural
 *      match that survives a complete restyle
 */
function findScrubberSrc() {
  return `
  function findScrubber() {
    var byHook = document.querySelector('[data-cy=scrubber-container] input[type=range]')
      || document.querySelector('[data-cy=scrubber] input[type=range]')
      || document.querySelector('input[data-cy=scrubber-input]');
    if (byHook) return { el: byHook, via: 'data-cy' };
    var byClass = document.querySelector('input[class*="scrubber-input"]')
      || document.querySelector('input[class*="scrubber"]');
    if (byClass) return { el: byClass, via: 'class-prefix' };
    var ranges = Array.prototype.slice.call(document.querySelectorAll('input[type=range]'));
    for (var i = 0; i < ranges.length; i++) {
      var min = Number(ranges[i].min), max = Number(ranges[i].max);
      // Epoch-ms values are > 1e12; a plain 0..100 slider is not the scrubber.
      if (isFinite(min) && isFinite(max) && max > min && min > 1e12) {
        return { el: ranges[i], via: 'epoch-heuristic' };
      }
    }
    return { el: null, via: null, candidates: ranges.length };
  }`;
}

/*
 * Find the app-under-test iframe inside the replay.
 *
 * Same-origin, so its document scrolls independently and can be driven directly.
 * Falls back to "largest iframe we can actually reach into" so an id rename does
 * not take the whole scroll/clip feature down.
 */
function findAppFrameSrc() {
  return `
  function findAppFrame() {
    var byId = document.querySelector('iframe[data-cy=replay-iframe]')
      || document.querySelector('iframe#replay')
      || document.querySelector('iframe[data-cy=replay]')
      || document.querySelector('iframe[data-cy=aut-iframe]');
    if (byId) return { el: byId, via: 'id' };
    var frames = Array.prototype.slice.call(document.querySelectorAll('iframe'));
    var best = null, bestArea = 0;
    for (var i = 0; i < frames.length; i++) {
      var doc = null;
      try { doc = frames[i].contentDocument; } catch (e) { doc = null; }
      if (!doc) continue; // cross-origin — not the AUT
      var r = frames[i].getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = frames[i]; }
    }
    return best ? { el: best, via: 'largest-same-origin' } : { el: null, via: null, iframes: frames.length };
  }`;
}

/*
 * Locate (and if necessary reveal) the console output.
 *
 * The replay's devtools drawer is a tab strip — Network is selected by default,
 * so on a freshly-opened replay the console rows are NOT in the DOM at all. The
 * probe therefore activates the Console tab itself rather than making the caller
 * click it; otherwise the first `cloud_console_logs` of every session silently
 * scrapes the network panel instead.
 *
 * The rows live in a react-virtualized list (only ~19 of them exist at a time),
 * so the container still has to be scrolled end to end.
 */
function findConsolePanelSrc() {
  return `
  function scrollables(root) {
    return Array.prototype.slice.call((root || document).querySelectorAll('*')).filter(function (el) {
      return el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 100;
    });
  }
  function activateConsoleTab() {
    var tab = document.querySelector('[role=tab][aria-controls=console-tabpanel]')
      || document.querySelector('[data-pendo*="console-tab"]')
      || document.querySelector('button#console[role=tab]');
    if (!tab) {
      // The whole drawer may be collapsed; opening it is the caller's job, but
      // say so rather than reporting a missing panel.
      return { tabFound: false, activated: false, drawerPresent: !!document.querySelector('[data-cy=devtools-container],[data-cy=devtools-header]') };
    }
    if (tab.getAttribute('aria-selected') === 'true') return { tabFound: true, activated: false, alreadyActive: true };
    tab.click();
    return { tabFound: true, activated: true };
  }
  function virtualRows(container) {
    // Preferred: the list's own row hook.
    var hooked = Array.prototype.slice.call(container.querySelectorAll('[data-cy^="virtualized-item-"]'));
    if (hooked.length) return hooked;
    // Fallback: any absolutely-positioned inline-styled row, which is how both
    // react-virtualized and react-window lay rows out.
    var cands = Array.prototype.slice.call(container.querySelectorAll('[style]')).filter(function (el) {
      var s = el.style;
      if (s.position !== 'absolute') return false;
      return !!s.top || (s.transform || '').indexOf('translate') === 0;
    });
    // A row can itself contain absolutely-positioned children (badges, icons).
    // Real rows are siblings, so keep only the largest same-parent group.
    var groups = new Map();
    for (var i = 0; i < cands.length; i++) {
      var p = cands[i].parentElement;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(cands[i]);
    }
    var best = [];
    groups.forEach(function (list) { if (list.length > best.length) best = list; });
    return best;
  }
  function findConsolePanel(grep) {
    // 1. The tab panel the Console tab controls — the precise, stable answer.
    var panel = document.querySelector('#console-tabpanel')
      || document.querySelector('[id$="console-tabpanel"]');
    if (panel) {
      var inner = panel.querySelector('.ReactVirtualized__List, .ReactVirtualized__Grid');
      if (inner) return { el: inner, via: 'console-tabpanel/virtualized-list' };
      var within = scrollables(panel);
      if (within.length) return { el: within[0], via: 'console-tabpanel/scrollable' };
    }

    var all = scrollables();
    // 2. A console-labelled region containing a scrollable.
    var regions = Array.prototype.slice.call(document.querySelectorAll(
      '[data-cy*="console"],[class*="console"],[aria-label*="onsole"]'
    ));
    for (var i = 0; i < regions.length; i++) {
      for (var j = 0; j < all.length; j++) {
        if (regions[i] === all[j] || regions[i].contains(all[j])) {
          return { el: all[j], via: 'console-region' };
        }
      }
    }
    // 3. With a grep, the container with the most matches (precise when it applies).
    if (grep) {
      var re = null;
      try { re = new RegExp(grep, 'gi'); } catch (e) { re = null; }
      if (re) {
        var best = null, bestCount = 0;
        for (var k = 0; k < all.length; k++) {
          var c = (all[k].innerText.match(re) || []).length;
          if (c > bestCount) { bestCount = c; best = all[k]; }
        }
        if (best) return { el: best, via: 'grep-match-count' };
      }
    }
    // 4. The container with the most virtualised rows. Requires more than one
    //    row: a single "row" is the signal that we found some other list (the
    //    test tree) rather than the console.
    var byRows = null, bestRows = 1;
    for (var m = 0; m < all.length; m++) {
      var n = virtualRows(all[m]).length;
      if (n > bestRows) { bestRows = n; byRows = all[m]; }
    }
    if (byRows) return { el: byRows, via: 'most-virtual-rows' };
    // 5. Last resort: the deepest-scrolling container. Required, not decorative —
    //    if the list stops using inline row offsets there are no virtual rows to
    //    count, and without this the innerText-stitch strategy could never run.
    var byDepth = null, bestDepth = 0;
    for (var d = 0; d < all.length; d++) {
      if (all[d].scrollHeight > bestDepth) { bestDepth = all[d].scrollHeight; byDepth = all[d]; }
    }
    if (byDepth) return { el: byDepth, via: 'deepest-scrollable' };
    return { el: null, via: null, scrollables: all.length };
  }`;
}

// Prepend page-side helper sources into a probe body. `fn` must start its body
// with the marker comment `/*__HELPERS__*/`.
function withHelpers(fn, ...helperSrcs) {
  const src = fn.toString();
  if (!src.includes('/*__HELPERS__*/')) {
    throw new Error('probe is missing the /*__HELPERS__*/ marker');
  }
  return src.replace('/*__HELPERS__*/', helperSrcs.join('\n'));
}

function exprWithHelpers(fn, helperSrcs, ...args) {
  return `(${withHelpers(fn, ...helperSrcs)}).apply(null, ${JSON.stringify(args)})`;
}

// ───────────────────────────────── probes ─────────────────────────────────

// Where are we, and does this look like a replay page we can drive?
function pageInfoProbe() {
  /*__HELPERS__*/
  var scrubber = findScrubber();
  var frame = findAppFrame();
  return {
    url: location.href,
    title: document.title,
    isCypressCloud: /cloud\.cypress\.io/.test(location.hostname),
    isReplay: !!scrubber.el,
    scrubberVia: scrubber.via,
    appFrameVia: frame.via,
    // A profile with no session cookie does not just show a Cypress login form —
    // it is redirected out to the identity provider (GitHub OAuth, SSO), so the
    // host is no longer cloud.cypress.io at all. Detecting that here means one
    // clear "log in once" message instead of every downstream probe reporting a
    // missing selector.
    looksLoggedOut: /\/login|\/signin|\/authorize/.test(location.pathname)
      || /authenticate\.cypress\.io|github\.com|okta|auth0|login\.microsoftonline/.test(location.hostname)
      || !!document.querySelector('input[type=password]'),
    authHost: location.hostname,
  };
}

const PAGE_INFO = () => exprWithHelpers(pageInfoProbe, [findScrubberSrc(), findAppFrameSrc()]);

// Scrubber bounds/position plus app-frame scroll metrics: everything needed to
// choose a seek target or a scroll offset.
function timelineProbe() {
  /*__HELPERS__*/
  var s = findScrubber();
  if (!s.el) return { error: 'no-scrubber', rangeInputs: s.candidates, url: location.href };
  var min = Number(s.el.min), max = Number(s.el.max), value = Number(s.el.value);
  var span = max - min;
  var f = findAppFrame();
  var doc = null;
  try { doc = f.el && f.el.contentDocument; } catch (e) { doc = null; }
  var se = doc && doc.scrollingElement;
  var rect = f.el ? f.el.getBoundingClientRect() : null;
  return {
    scrubber: {
      min: min, max: max, value: value, via: s.via,
      durationSec: span > 0 ? Number((span / 1000).toFixed(2)) : 0,
      positionSec: Number(((value - min) / 1000).toFixed(2)),
      fraction: span > 0 ? Number(((value - min) / span).toFixed(4)) : 0,
    },
    app: se
      ? { scrollTop: se.scrollTop, scrollHeight: se.scrollHeight, clientHeight: se.clientHeight, via: f.via }
      : null,
    appFrameRect: rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : null,
  };
}

const TIMELINE = () => exprWithHelpers(timelineProbe, [findScrubberSrc(), findAppFrameSrc()]);

// Rect of the app iframe, used to clip a screenshot to just the app.
function appRectProbe() {
  /*__HELPERS__*/
  var f = findAppFrame();
  if (!f.el) return null;
  var r = f.el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  return {
    x: Math.round(r.x), y: Math.round(r.y),
    width: Math.round(r.width), height: Math.round(r.height),
    scale: 1,
  };
}

const APP_RECT = () => exprWithHelpers(appRectProbe, [findAppFrameSrc()]);

/*
 * Scroll the app-under-test frame.
 *
 * Scrolling stays a page-side probe (unlike seeking, which needs trusted pointer
 * events — see cloud-seek.js) because the app frame is same-origin, so driving
 * its scrollingElement directly works and is exact.
 *
 * The assignment is repeated because the replay can restore the previous scroll
 * position on a rAF after a re-render; one write frequently does not stick.
 */
async function scrollAppProbe(opts) {
  /*__HELPERS__*/
  var f = findAppFrame();
  var doc = null;
  try { doc = f.el && f.el.contentDocument; } catch (e) { doc = null; }
  var se = doc && doc.scrollingElement;
  if (!se) return { error: 'no-app-frame', appFrameVia: f.via, iframes: f.iframes };
  for (var i = 0; i < 4; i++) {
    se.scrollTop = opts.scrollTo != null ? opts.scrollTo : se.scrollTop + opts.scrollBy;
    await new Promise(function (r) { setTimeout(r, 120); });
  }
  return { scrollTop: se.scrollTop, scrollHeight: se.scrollHeight, clientHeight: se.clientHeight, via: f.via };
}

const scrollAppExpr = (opts) => exprWithHelpers(scrollAppProbe, [findAppFrameSrc()], opts);

// ───────────────────── command log (time-travel by step) ─────────────────────
/*
 * Test Replay renders the command log with the SAME private reporter classes as
 * the local Cypress runner — `.command-wrapper`, `.command-state-failed`,
 * `.command-is-pinned` — so the shape here deliberately matches the local
 * `get_test_commands` / `step_to` tools.
 *
 * Two differences from the local runner, both measured live:
 *   • The list is NOT virtualised here (one `.runnable` scroller holds every
 *     row), so a single pass reads the whole log — no scroll-sampling.
 *   • `.command-number` does not exist; the number lives in a
 *     `.command-number-column` child.
 */
function commandsSrc() {
  return `
  function cmdRows() {
    return Array.prototype.slice.call(document.querySelectorAll('.command-wrapper'));
  }
  function cmdState(w) {
    var c = w.className || '';
    if (/command-state-failed/.test(c)) return 'failed';
    if (/command-state-passed/.test(c)) return 'passed';
    if (/command-state-pending/.test(c)) return 'pending';
    return 'unknown';
  }
  function cmdText(w, sel) {
    var e = w.querySelector(sel);
    return e ? (e.innerText || '').replace(/\\s+/g, ' ').trim() : null;
  }
  function cmdInfo(w, i) {
    return {
      index: i,
      number: cmdText(w, '.command-number-column, .command-number'),
      method: cmdText(w, '.command-method, [class*="command-method"]'),
      message: cmdText(w, '.command-message, [class*="command-message"]'),
      state: cmdState(w),
      isPinned: /command-is-pinned/.test(w.className || ''),
    };
  }
  // Pinning is driven by an onClick on '.command-wrapper-container'; clicking
  // '.command-wrapper' itself does nothing because the event bubbles up past
  // the handler. Same quirk as the local runner.
  function pinTarget(w) {
    return w.querySelector('.command-wrapper-container') || w.querySelector('.command-pin-target') || w;
  }`;
}

function commandsProbe() {
  /*__HELPERS__*/
  var rows = cmdRows();
  if (!rows.length) {
    return {
      error: 'no-command-log',
      hasCommandLogsRoot: !!document.querySelector('[data-cy=CommandLogs]'),
      url: location.href,
    };
  }
  return {
    total: rows.length,
    pinnedIndex: rows.findIndex(function (w) { return /command-is-pinned/.test(w.className || ''); }),
    commands: rows.map(cmdInfo),
  };
}

const COMMANDS = () => exprWithHelpers(commandsProbe, [commandsSrc()]);

/*
 * Scroll a command into view and click it, which pins its snapshot so the app
 * frame renders the DOM as it was at that step.
 *
 * Clicking an ALREADY-pinned row toggles the pin off, so an existing pin on the
 * target is left alone rather than clicked again — otherwise "pin step 8" twice
 * would leave nothing pinned.
 *
 * A scripted `.click()` is enough here: React's onClick fires for untrusted
 * click events. (Contrast the timeline scrubber, which needs trusted pointer
 * events — but for a different reason: there the problem is React re-rendering
 * a controlled input's value, not event delivery. See cloud-seek.js.)
 */
async function pinCommandProbe(opts) {
  /*__HELPERS__*/
  var rows = cmdRows();
  if (!rows.length) return { error: 'no-command-log' };
  if (opts.index < 0 || opts.index >= rows.length) {
    return { error: 'index-out-of-range', index: opts.index, total: rows.length };
  }
  var w = rows[opts.index];
  var already = /command-is-pinned/.test(w.className || '');

  if (opts.scrollIntoView && w.scrollIntoView) {
    w.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise(function (r) { setTimeout(r, 150); });
  }
  if (!already) {
    pinTarget(w).click();
    await new Promise(function (r) { setTimeout(r, opts.waitMs); });
  }

  // Re-query: the reporter can re-render and invalidate the earlier reference.
  var after = cmdRows();
  var pinnedIndex = after.findIndex(function (x) { return /command-is-pinned/.test(x.className || ''); });
  return {
    requestedIndex: opts.index,
    pinnedIndex: pinnedIndex,
    alreadyPinned: already,
    pinned: pinnedIndex >= 0 ? cmdInfo(after[pinnedIndex], pinnedIndex) : null,
    total: after.length,
  };
}

const pinCommandExpr = (opts) => exprWithHelpers(pinCommandProbe, [commandsSrc()], opts);

// ───────────────────── test list (switch which test replays) ─────────────────

function testsSrc() {
  return `
  function testRows() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-cy=parent-test-row-wrapper]'));
  }
  function testInfo(w, i) {
    var frags = Array.prototype.slice.call(w.querySelectorAll('[data-cy=test-title-fragment]'))
      .map(function (f) { return (f.innerText || '').replace(/\\s+/g, ' ').trim(); })
      .filter(Boolean);
    // The status is an icon, not text: its data-cy carries the state
    // (passed-icon / status-icon-failed / …).
    var icon = w.querySelector('[data-cy$="-icon"], [data-cy^="status-icon-"]');
    var status = icon ? (icon.getAttribute('data-cy') || '').replace(/(^status-icon-|-icon$)/g, '') : null;
    return {
      index: i,
      suite: frags.length > 1 ? frags.slice(0, -1).join(' > ') : null,
      title: frags.length ? frags[frags.length - 1] : (w.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      status: status,
      hasReplay: !!w.querySelector('[data-cy=artifact-controls_replay]'),
    };
  }`;
}

function testsProbe() {
  /*__HELPERS__*/
  var rows = testRows();
  if (!rows.length) return { error: 'no-test-rows', url: location.href };
  return { total: rows.length, tests: rows.map(testInfo) };
}

const TESTS = () => exprWithHelpers(testsProbe, [testsSrc()]);

// Click a test row's "Test Replay" button. The load is asynchronous and can take
// well over five seconds (measured), so the caller polls REPLAY_STATE rather
// than trusting this to have finished.
function selectTestProbe(opts) {
  /*__HELPERS__*/
  var rows = testRows();
  if (!rows.length) return { error: 'no-test-rows' };
  if (opts.index < 0 || opts.index >= rows.length) {
    return { error: 'index-out-of-range', index: opts.index, total: rows.length };
  }
  var w = rows[opts.index];
  var btn = w.querySelector('[data-cy=artifact-controls_replay]');
  if (!btn) return { error: 'no-replay-button', test: testInfo(w, opts.index) };
  if (w.scrollIntoView) w.scrollIntoView({ block: 'center', inline: 'nearest' });
  btn.click();
  return { clicked: true, test: testInfo(w, opts.index) };
}

const selectTestExpr = (opts) => exprWithHelpers(selectTestProbe, [testsSrc()], opts);

// Cheap readiness poll: is a replay open, for which test, and how long is it?
const REPLAY_STATE = () => `(() => {
  var h = document.querySelector('[data-cy=test-drawer-header-title], [data-cy=test-drawer-header__title]');
  var t = document.querySelector('[data-cy=TimerDisplay]');
  var i = document.querySelector('[data-cy=scrubber-container] input[type=range]')
    || document.querySelector('input[class*="scrubber-input"]');
  return {
    replayOpen: !!document.querySelector('[data-cy=test-replay-container]'),
    header: h ? (h.innerText || '').replace(/\\s+/g, ' ').trim() : null,
    timer: t ? (t.innerText || '').replace(/\\s+/g, ' ').trim() : null,
    hasScrubber: !!i,
    durationSec: i ? Number(((Number(i.max) - Number(i.min)) / 1000).toFixed(2)) : null,
    commandCount: document.querySelectorAll('.command-wrapper').length,
  };
})()`;

/*
 * Read every console row out of the virtualised panel.
 *
 * Only ~19 rows exist in the DOM at once, so the panel is scrolled top to bottom
 * and sampled at each step. Three reconstruction strategies, best first:
 *
 *   1. `data-cy-event-id` — the list stamps each console entry with a unique
 *      event id and a `data-cy-event-start` epoch-ms timestamp. The id is exact
 *      identity (so repeated log text is never wrongly collapsed) and the
 *      timestamp shares its clock with the timeline scrubber, which is what lets
 *      each returned line carry the `fraction` you can hand straight to a seek.
 *
 *   2. Row offset — key each row by its inline top/translateY px. Also a stable
 *      identity across scroll positions, but carries no timestamp.
 *
 *   3. innerText stitch — no positioned rows at all: snapshot text at each step
 *      and stitch consecutive snapshots on their longest overlapping run of
 *      lines. Order-preserving, unlike the set-dedupe of the original script,
 *      which dropped genuinely repeated lines.
 */
async function consoleProbe(opts) {
  /*__HELPERS__*/
  var tab = activateConsoleTab();
  if (tab.activated) await new Promise(function (r) { setTimeout(r, opts.tabWaitMs); });

  var panel = findConsolePanel(opts.grep);
  if (!panel.el) {
    return {
      error: 'no-console-panel',
      consoleTab: tab,
      scrollables: panel.scrollables,
      url: location.href,
    };
  }
  var el = panel.el;

  // The scrubber shares its clock with each row's data-cy-event-start, so run
  // bounds convert an absolute log timestamp into a seekable fraction.
  var bounds = null;
  var rangeEl = document.querySelector('[data-cy=scrubber-container] input[type=range]')
    || document.querySelector('input[class*="scrubber-input"]');
  if (rangeEl && Number(rangeEl.max) > Number(rangeEl.min)) {
    bounds = { min: Number(rangeEl.min), max: Number(rangeEl.max) };
  }

  function offsetOf(row) {
    if (row.style && row.style.top) return parseFloat(row.style.top);
    var m = ((row.style && row.style.transform) || '').match(/translate(?:Y|3d)?\(([-\d.]+)px/);
    return m ? parseFloat(m[1]) : NaN;
  }
  function eventNode(row) {
    if (row.getAttribute && row.getAttribute('data-cy-event-id') != null) return row;
    return row.querySelector ? row.querySelector('[data-cy-event-id]') : null;
  }

  var byKey = new Map();
  var textSnaps = [];
  var sawEventIds = false;

  function sample() {
    var rows = virtualRows(el);
    for (var i = 0; i < rows.length; i++) {
      var text = (rows[i].innerText || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      var off = offsetOf(rows[i]);
      var ev = eventNode(rows[i]);
      var id = ev ? ev.getAttribute('data-cy-event-id') : null;
      var ts = ev ? Number(ev.getAttribute('data-cy-event-start')) : NaN;
      if (id != null) sawEventIds = true;
      var key = id != null ? 'e' + id : (isFinite(off) ? 'o' + off : null);
      if (key == null) continue;
      byKey.set(key, { text: text, ts: isFinite(ts) ? ts : null, off: isFinite(off) ? off : null });
    }
    textSnaps.push(el.innerText);
  }

  el.scrollTop = 0;
  await new Promise(function (r) { setTimeout(r, 200); });

  var last = -1;
  var steps = 0;
  for (var i = 0; i < opts.maxScrollSteps; i++) {
    sample();
    steps++;
    var atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    if (atEnd || (el.scrollTop === last && i > 2)) { sample(); break; }
    last = el.scrollTop;
    el.scrollTop = Math.min(el.scrollTop + Math.floor(el.clientHeight * 0.7), el.scrollHeight);
    await new Promise(function (r) { setTimeout(r, opts.stepDelayMs); });
  }

  var entries, strategy;
  if (byKey.size) {
    strategy = sawEventIds ? 'event-id' : 'virtual-row-offset';
    // Sort by row offset: it IS the list's own rendering order, and unlike the
    // timestamp it is present on every row.
    entries = Array.from(byKey.values()).sort(function (a, b) {
      if (a.off != null && b.off != null) return a.off - b.off;
      return (a.ts || 0) - (b.ts || 0);
    }).map(function (v) {
      var out = { text: v.text };
      if (v.ts != null && bounds) {
        out.tSec = Number(((v.ts - bounds.min) / 1000).toFixed(2));
        out.fraction = Number(((v.ts - bounds.min) / (bounds.max - bounds.min)).toFixed(4));
      }
      return out;
    });
  } else {
    strategy = 'innertext-stitch';
    var acc = [];
    for (var s = 0; s < textSnaps.length; s++) {
      var lines = textSnaps[s].split('\n').map(function (x) { return x.replace(/\s+/g, ' ').trim(); })
        .filter(function (x) { return x.length > 0; });
      if (!acc.length) { acc = lines; continue; }
      var maxK = Math.min(acc.length, lines.length), k = maxK, matched0 = 0;
      for (; k > 0; k--) {
        var ok = true;
        for (var q = 0; q < k; q++) {
          if (acc[acc.length - k + q] !== lines[q]) { ok = false; break; }
        }
        if (ok) { matched0 = k; break; }
      }
      acc = acc.concat(lines.slice(matched0));
    }
    entries = acc.map(function (t) { return { text: t }; });
  }

  var total = entries.length;
  if (opts.grep) {
    var re;
    try { re = new RegExp(opts.grep, 'i'); } catch (e) { return { error: 'bad-grep', grep: opts.grep }; }
    entries = entries.filter(function (x) { return re.test(x.text); });
  }
  var matched = entries.length;
  if (opts.limit && entries.length > opts.limit) entries = entries.slice(-opts.limit);

  return {
    panelVia: panel.via,
    consoleTab: tab,
    strategy: strategy,
    hasTimestamps: !!(bounds && sawEventIds),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollSteps: steps,
    totalRows: total,
    matchedRows: matched,
    returnedRows: entries.length,
    entries: entries,
  };
}

const consoleExpr = (opts) =>
  exprWithHelpers(consoleProbe, [findConsolePanelSrc()], opts);

module.exports = {
  expr,
  PAGE_INFO,
  TIMELINE,
  APP_RECT,
  scrollAppExpr,
  consoleExpr,
  COMMANDS,
  pinCommandExpr,
  TESTS,
  selectTestExpr,
  REPLAY_STATE,
  // exported for unit tests
  _internals: { withHelpers, findScrubberSrc, findAppFrameSrc, findConsolePanelSrc, commandsSrc, testsSrc },
};
