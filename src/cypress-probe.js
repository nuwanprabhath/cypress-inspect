// Self-contained JS expressions evaluated in the Cypress spec-runner page.
// All assume `window.Cypress` exists on the runner (Cypress >= 12).

// Returns spec, current/last test, totals, first-failure summary. One-call orientation.
const OVERVIEW = `(() => {
  try {
    const C = window.Cypress;
    const spec = C && C.spec ? { name: C.spec.name, relative: C.spec.relative, absolute: C.spec.absolute } : null;

    // Reporter totals via DOM badge or attempt-state classes.
    const allTests = [...document.querySelectorAll('.test.runnable')];
    const counts = { total: allTests.length, passed: 0, failed: 0, pending: 0, running: 0, unknown: 0 };
    const tests = allTests.map((el) => {
      const stateMatch = el.className.match(/runnable-(passed|failed|pending|running)/);
      const state = stateMatch ? stateMatch[1] : 'unknown';
      counts[state in counts ? state : 'unknown']++;
      const titleEl = el.querySelector(':scope > .collapsible-header-wrapper .runnable-title, :scope .runnable-title');
      let title = titleEl ? titleEl.innerText.split('\\n')[0].trim() : null;
      // Walk up to collect suite ancestry
      const suites = [];
      let p = el.parentElement;
      while (p) {
        if (p.classList && p.classList.contains('suite')) {
          const st = p.querySelector(':scope > .collapsible-header-wrapper .runnable-title');
          if (st) suites.unshift(st.innerText.split('\\n')[0].trim());
        }
        p = p.parentElement;
      }
      return { state, title, suites };
    });

    const failed = tests.filter(t => t.state === 'failed');
    let firstFailure = null;
    if (failed.length) {
      const idx = tests.findIndex(t => t === failed[0]);
      const el = allTests[idx];
      const errEl = el.querySelector('.runnable-err-message, [class*="runnable-err-message"]');
      const stackEl = el.querySelector('.runnable-err-stack-trace, [class*="runnable-err-stack"]');
      const codeFrameEl = el.querySelector('.runnable-err-code-frame, [class*="code-frame"]');
      firstFailure = {
        suites: failed[0].suites,
        title: failed[0].title,
        message: errEl ? errEl.innerText.slice(0, 4000) : null,
        stack: stackEl ? stackEl.innerText.slice(0, 4000) : null,
        codeFrame: codeFrameEl ? codeFrameEl.innerText.slice(0, 2000) : null,
      };
    }

    const liveRunner = C && C.mocha && C.mocha.getRunner && C.mocha.getRunner();
    const liveTest = liveRunner && liveRunner.test ? {
      title: liveRunner.test.title,
      state: liveRunner.test.state,
      duration: liveRunner.test.duration,
    } : null;

    // Detect at-risk commands: active command has consumed >50% of its timeout budget.
    let slowCommands = null;
    try {
      const now = Date.now();
      const q = (C.cy && C.cy.queue && (C.cy.queue.get ? C.cy.queue.get() : C.cy.queue)) || [];
      const atRisk = q.reduce((acc, c, i) => {
        const a = c.attributes || c;
        if (a.state !== 'active') return acc;
        const timeout = a.options && a.options.timeout != null ? a.options.timeout : null;
        const startedAt = a.startedAt || null;
        if (!timeout || !startedAt) return acc;
        const elapsedMs = now - new Date(startedAt).getTime();
        const pct = Math.round(elapsedMs / timeout * 100);
        if (pct >= 50) acc.push({ index: i, name: a.name, elapsedMs, timeout, budgetUsedPct: pct });
        return acc;
      }, []);
      if (atRisk.length > 0) slowCommands = atRisk;
    } catch (_) {}

    return { spec, counts, firstFailure, liveTest, slowCommands };
  } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
})()`;

// Returns every failed test with full error + suite ancestry.
const FAILURES = `(() => {
  try {
    const allTests = [...document.querySelectorAll('.test.runnable')];
    const out = [];
    allTests.forEach((el, idx) => {
      if (!/runnable-failed/.test(el.className)) return;
      const titleEl = el.querySelector(':scope > .collapsible-header-wrapper .runnable-title, :scope .runnable-title');
      const title = titleEl ? titleEl.innerText.split('\\n')[0].trim() : null;
      const suites = [];
      let p = el.parentElement;
      while (p) {
        if (p.classList && p.classList.contains('suite')) {
          const st = p.querySelector(':scope > .collapsible-header-wrapper .runnable-title');
          if (st) suites.unshift(st.innerText.split('\\n')[0].trim());
        }
        p = p.parentElement;
      }
      const errEl = el.querySelector('.runnable-err-message, [class*="runnable-err-message"]');
      const stackEl = el.querySelector('.runnable-err-stack-trace, [class*="runnable-err-stack"]');
      const codeFrameEl = el.querySelector('.runnable-err-code-frame, [class*="code-frame"]');
      // Locate the failed command's DOM index in this test panel.
      const wrappers = [...el.querySelectorAll('.command-wrapper, [class*="command-wrapper"]')];
      let relatedCommandIndex = null;
      let relatedCommandNumber = null;
      let relatedCommandText = null;
      const failedWrapperIdx = wrappers.findIndex((w) => /command-state-failed/.test(w.className || ''));
      if (failedWrapperIdx >= 0) {
        relatedCommandIndex = failedWrapperIdx;
        const numEl = wrappers[failedWrapperIdx].querySelector('.command-number, [class*="command-number"]');
        if (numEl) relatedCommandNumber = numEl.innerText.trim();
        relatedCommandText = wrappers[failedWrapperIdx].innerText.trim().slice(0, 240);
      }
      out.push({
        index: idx,
        suites,
        title,
        message: errEl ? errEl.innerText.slice(0, 4000) : null,
        stack: stackEl ? stackEl.innerText.slice(0, 4000) : null,
        codeFrame: codeFrameEl ? codeFrameEl.innerText.slice(0, 2000) : null,
        relatedCommandIndex,
        relatedCommandNumber,
        relatedCommandText,
      });
    });
    return { count: out.length, failures: out };
  } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
})()`;

// Lightweight test list — state + title + suite path. Use for orientation.
const LIST_TESTS = `(() => {
  try {
    const all = [...document.querySelectorAll('.test.runnable')];
    return all.map((el, idx) => {
      const stateMatch = el.className.match(/runnable-(passed|failed|pending|running)/);
      const titleEl = el.querySelector(':scope > .collapsible-header-wrapper .runnable-title, :scope .runnable-title');
      const suites = [];
      let p = el.parentElement;
      while (p) {
        if (p.classList && p.classList.contains('suite')) {
          const st = p.querySelector(':scope > .collapsible-header-wrapper .runnable-title');
          if (st) suites.unshift(st.innerText.split('\\n')[0].trim());
        }
        p = p.parentElement;
      }
      return {
        index: idx,
        state: stateMatch ? stateMatch[1] : 'unknown',
        title: titleEl ? titleEl.innerText.split('\\n')[0].trim() : null,
        suites,
      };
    });
  } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
})()`;

// Commands logged for the test at reporter index. Reads the rendered DOM
// (works for finished tests; for the currently running test, Cypress.cy.queue
// is also available via getLiveCommands).
function commandsForTestExpr(testIndex, { full = false, argMaxBytes = 240, textMaxBytes = 300 } = {}) {
  return `(() => {
    try {
      const all = [...document.querySelectorAll('.test.runnable')];
      const el = all[${testIndex}];
      if (!el) return { error: 'No test at index ${testIndex}', total: all.length };
      const wrappers = [...el.querySelectorAll('.command-wrapper, [class*="command-wrapper"]')];
      const seenNumbers = new Map(); // displayed reporter number -> first DOM index
      const cmds = wrappers.map((w, i) => {
        const cls = w.className || '';
        const stateMatch = cls.match(/command-state-(\\w+)/);
        const nameEl = w.querySelector('.command-method, [class*="command-method"]');
        const argEl = w.querySelector('.command-message, [class*="command-message"]');
        const numEl = w.querySelector('.command-number, [class*="command-number"]');
        const number = numEl ? numEl.innerText.trim() : null;
        const argRaw = argEl ? argEl.innerText.trim() : null;
        const textRaw = w.innerText.trim();
        const argTrunc = ${full ? 'false' : true};
        const out = {
          index: i,
          number,
          name: nameEl ? nameEl.innerText.trim() : null,
          arg: argRaw == null ? null : (${full} ? argRaw : argRaw.slice(0, ${argMaxBytes})),
          argTruncated: !${full} && !!argRaw && argRaw.length > ${argMaxBytes},
          argLength: argRaw == null ? 0 : argRaw.length,
          state: stateMatch ? stateMatch[1] : null,
          text: ${full} ? textRaw : textRaw.slice(0, ${textMaxBytes}),
          textTruncated: !${full} && textRaw.length > ${textMaxBytes},
        };
        if (number && !seenNumbers.has(number)) seenNumbers.set(number, i);
        return out;
      });
      const titleEl = el.querySelector(':scope > .collapsible-header-wrapper .runnable-title, :scope .runnable-title');
      // Cypress renders one logical "command N" as multiple wrapper rows (parent + children).
      // Provide a map so callers can quickly resolve displayed number -> first DOM index.
      const numberToIndex = {};
      for (const [n, i] of seenNumbers.entries()) numberToIndex[n] = i;
      return {
        testTitle: titleEl ? titleEl.innerText.split('\\n')[0].trim() : null,
        commandCount: cmds.length,
        uniqueCommandNumbers: seenNumbers.size,
        numberToIndex,
        commands: cmds,
      };
    } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
  })()`;
}

// Live queue from Cypress.cy.queue — only meaningful for the in-flight test.
// Function-valued args (coverage callbacks, .then handlers, etc.) are
// reduced to a one-line summary — the source body is rarely useful and can
// dominate the payload (~40 KB for one coverage plugin).
// Optional: pass summarize=true for a collapsed view (active + next assertion + large-timeout cmds).
function liveCommandsExpr({ summarize: doSummarize = false } = {}) {
  return `(() => {
  try {
    const C = window.Cypress;
    if (!C || !C.cy) return { error: 'No active Cypress.cy on runner' };
    const queue = (C.cy.queue && (C.cy.queue.get ? C.cy.queue.get() : C.cy.queue)) || [];
    const now = Date.now();
    const LARGE_TIMEOUT_MS = 30000;
    const summarizeArg = (x) => {
      if (typeof x === 'function') return '[Function: ' + (x.name || 'anonymous') + ']';
      if (typeof x === 'string') return x.slice(0, 240);
      try {
        const s = JSON.stringify(x, (k, v) => typeof v === 'function' ? '[Function: ' + (v.name || 'anonymous') + ']' : v);
        return s == null ? String(x).slice(0, 240) : s.slice(0, 240);
      } catch { return String(x).slice(0, 240); }
    };
    let activeIndex = -1;
    const commands = queue.map((c, i) => {
      const a = c.attributes || c;
      const opts = a.options || {};
      const timeout = opts.timeout != null ? opts.timeout : null;
      const startedAt = a.startedAt || null;
      const isActive = a.state === 'active';
      if (isActive && activeIndex === -1) activeIndex = i;
      const elapsedMs = isActive && startedAt ? now - new Date(startedAt).getTime() : null;
      const row = {
        index: i,
        name: a.name,
        args: (a.args || []).map(summarizeArg),
        state: a.state,
        type: a.type,
      };
      if (isActive) row.active = true;
      if (timeout != null) row.timeout = timeout;
      if (elapsedMs != null) row.elapsedMs = elapsedMs;
      if (timeout != null && elapsedMs != null) row.timeoutBudgetUsedPct = Math.round(elapsedMs / timeout * 100);
      if (timeout != null && timeout > LARGE_TIMEOUT_MS) row.suspiciouslyLargeTimeout = true;
      return row;
    });
    if (${doSummarize}) {
      const active = activeIndex >= 0 ? commands[activeIndex] : null;
      const nextAssertion = commands.slice(activeIndex + 1).find(r => r.name === 'assert' || r.name === 'should');
      const largeTOCmds = commands.filter(r => r.suspiciouslyLargeTimeout && r.index !== activeIndex);
      return {
        totalCommands: commands.length,
        activeIndex,
        active,
        nextAssertion: nextAssertion || null,
        suspiciouslyLargeTimeoutCommands: largeTOCmds,
      };
    }
    return { totalCommands: commands.length, activeIndex, commands };
  } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
})()`;
}
// Convenience: full (non-summarized) live commands, backward-compatible export.
const LIVE_COMMANDS = liveCommandsExpr({ summarize: false });

// Click on a specific command in a specific test panel to time-travel. Caller
// may pass either commandIndex (raw DOM position 0..N) OR commandNumber (the
// displayed reporter number, e.g. "38"). When both are given commandNumber wins.
function stepToExpr(testIndex, { commandIndex, commandNumber } = {}) {
  return `(() => {
    const all = [...document.querySelectorAll('.test.runnable')];
    const el = all[${testIndex}];
    if (!el) return { ok: false, reason: 'No test at index ${testIndex}', total: all.length };
    const header = el.querySelector(':scope > .collapsible-header-wrapper');
    const expanded = el.classList.contains('is-open');
    if (header && !expanded) header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const wrappers = [...el.querySelectorAll('.command-wrapper, [class*="command-wrapper"]')];
    let target = null;
    let resolvedFrom = null;
    const wantNumber = ${commandNumber == null ? 'null' : JSON.stringify(String(commandNumber))};
    const wantIndex = ${commandIndex == null ? 'null' : Number(commandIndex)};
    if (wantNumber != null) {
      target = wrappers.find((w) => {
        const n = w.querySelector('.command-number, [class*="command-number"]');
        return n && n.innerText.trim() === wantNumber;
      });
      resolvedFrom = 'commandNumber';
    }
    if (!target && wantIndex != null) {
      target = wrappers[wantIndex];
      resolvedFrom = 'commandIndex';
    }
    if (!target) return {
      ok: false,
      reason: 'No command found by commandNumber=' + wantNumber + ' / commandIndex=' + wantIndex,
      total: wrappers.length,
    };
    target.scrollIntoView({ block: 'center' });
    ['mouseover','mousedown','mouseup','click'].forEach(t =>
      target.dispatchEvent(new MouseEvent(t, { bubbles: true }))
    );
    const numEl = target.querySelector('.command-number, [class*="command-number"]');
    return {
      ok: true,
      testIndex: ${testIndex},
      resolvedFrom,
      pinnedNumber: numEl ? numEl.innerText.trim() : null,
      pinnedIndex: wrappers.indexOf(target),
      text: target.innerText.trim().slice(0, 240),
    };
  })()`;
}

// AUT iframe DOM — `iframe.aut-iframe.contentDocument` is same-origin so we can read it from the runner.
function autDomExpr(selector, maxBytes) {
  const sel = selector ? JSON.stringify(selector) : 'null';
  return `(() => {
    const aut = document.querySelector('iframe.aut-iframe');
    if (!aut || !aut.contentDocument) return { error: 'AUT iframe not found or not same-origin' };
    const doc = aut.contentDocument;
    const root = ${sel} ? doc.querySelector(${sel}) : doc.documentElement;
    if (!root) return { error: 'Selector not found in AUT' };
    const html = root.outerHTML || '';
    const max = ${maxBytes};
    return { url: aut.src, length: html.length, html: html.length > max ? html.slice(0, max) + '\\n... [truncated]' : html };
  })()`;
}

// Find tests by partial title match (case-insensitive). Returns matches with index/state/title.
function findTestExpr(query) {
  return `(() => {
    try {
      const q = ${JSON.stringify(String(query).toLowerCase())};
      const all = [...document.querySelectorAll('.test.runnable')];
      const out = [];
      all.forEach((el, i) => {
        const titleEl = el.querySelector(':scope > .collapsible-header-wrapper .runnable-title, :scope .runnable-title');
        const title = titleEl ? titleEl.innerText.split('\\n')[0].trim() : '';
        if (title.toLowerCase().includes(q)) {
          const stateMatch = el.className.match(/runnable-(passed|failed|pending|running)/);
          out.push({ index: i, state: stateMatch ? stateMatch[1] : 'unknown', title });
        }
      });
      return out;
    } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
  })()`;
}

// Structured query against the AUT DOM. Returns a small JSON summary instead of
// the giant outerHTML — much easier for an agent than scrolling raw HTML.
// When `textOnly` is set, returns just the full (untruncated) text of each match,
// dropping tag/attrs/visibility overhead. Good for extracting summary widgets.
function findInAutExpr(selector, limit, { textOnly = false, textMaxBytes = 240 } = {}) {
  return `(() => {
    try {
      const aut = document.querySelector('iframe.aut-iframe');
      if (!aut || !aut.contentDocument) return { error: 'AUT iframe not found' };
      const doc = aut.contentDocument;
      const all = doc.querySelectorAll(${JSON.stringify(selector)});
      const els = [...all].slice(0, ${limit});
      if (${textOnly}) {
        return {
          url: aut.src,
          count: all.length,
          truncated: all.length > ${limit},
          texts: els.map((el) => (el.innerText || el.textContent || '').trim()),
        };
      }
      return {
        url: aut.src,
        count: all.length,
        truncated: all.length > ${limit},
        elements: els.map((el) => {
          const attrs = {};
          for (const a of el.attributes) attrs[a.name] = a.value;
          const fullText = (el.innerText || el.textContent || '').trim();
          return {
            tag: el.tagName.toLowerCase(),
            attrs,
            text: fullText.slice(0, ${textMaxBytes}),
            textTruncated: fullText.length > ${textMaxBytes},
            textLength: fullText.length,
            value: el.value === undefined ? null : String(el.value).slice(0, ${textMaxBytes}),
            disabled: !!el.disabled,
            visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          };
        }),
      };
    } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
  })()`;
}

// Current URL of the AUT and a few useful globals.
const AUT_INFO = `(() => {
  const aut = document.querySelector('iframe.aut-iframe');
  if (!aut || !aut.contentDocument) return { error: 'AUT iframe not found' };
  const w = aut.contentWindow;
  return {
    src: aut.src,
    location: w && w.location ? { href: w.location.href, pathname: w.location.pathname, hash: w.location.hash, search: w.location.search } : null,
    title: aut.contentDocument.title,
    readyState: aut.contentDocument.readyState,
    online: w && typeof w.navigator !== 'undefined' ? w.navigator.onLine : null,
  };
})()`;

// Expand a test panel (the .collapsible-header-wrapper toggles open).
function expandTestExpr(testIndex) {
  return `(() => {
    const all = [...document.querySelectorAll('.test.runnable')];
    const el = all[${testIndex}];
    if (!el) return { ok: false, reason: 'No test at index ${testIndex}', total: all.length };
    const wasOpen = el.classList.contains('is-open');
    if (!wasOpen) {
      const header = el.querySelector(':scope > .collapsible-header-wrapper');
      if (header) header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    el.scrollIntoView({ block: 'center' });
    return { ok: true, wasAlreadyOpen: wasOpen, index: ${testIndex} };
  })()`;
}

// Which command is currently pinned (i.e. has command-state-pinned or
// .command-pinned class). Useful after step_to to verify the snapshot.
const PINNED_COMMAND = `(() => {
  const pinned = document.querySelector('[class*="command-pinned"], .command-wrapper.is-pinned, .command-wrapper.command-pinned');
  if (!pinned) return null;
  const nameEl = pinned.querySelector('.command-method, [class*="command-method"]');
  const argEl = pinned.querySelector('.command-message, [class*="command-message"]');
  const numEl = pinned.querySelector('.command-number, [class*="command-number"]');
  return {
    number: numEl ? numEl.innerText.trim() : null,
    name: nameEl ? nameEl.innerText.trim() : null,
    arg: argEl ? argEl.innerText.trim().slice(0, 240) : null,
    text: pinned.innerText.trim().slice(0, 240),
  };
})()`;

// Walk every test's command-log entries and return any row whose text matches
// /WARNING:/i. Cypress wraps console.* in the AUT iframe and routes calls into
// its reporter, so the CDP console buffer often misses these — the reporter
// rows are the canonical source. Each result carries enough context (testIndex,
// command number) for an agent to navigate back to the source.
const REPORTER_WARNINGS = `(() => {
  try {
    const allTests = [...document.querySelectorAll('.test.runnable')];
    const out = [];
    allTests.forEach((testEl, testIndex) => {
      const titleEl = testEl.querySelector(':scope > .collapsible-header-wrapper .runnable-title, :scope .runnable-title');
      const testTitle = titleEl ? titleEl.innerText.split('\\n')[0].trim() : null;
      const wrappers = testEl.querySelectorAll('.command-wrapper, [class*="command-wrapper"]');
      wrappers.forEach((w) => {
        const text = (w.innerText || '').trim();
        if (!/WARNING:/i.test(text)) return;
        const numEl = w.querySelector('.command-number, [class*="command-number"]');
        out.push({
          testIndex,
          testTitle,
          commandNumber: numEl ? numEl.innerText.trim() : null,
          text: text.slice(0, 500),
        });
      });
    });
    return out;
  } catch (e) { return []; }
})()`;

// Bounding box of the AUT iframe (for screenshot clipping).
const AUT_RECT = `(() => {
  const aut = document.querySelector('iframe.aut-iframe');
  if (!aut) return null;
  const r = aut.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
})()`;

// Compact commands view — one row per UNIQUE command number with state +
// name + truncated arg. Designed for triage: an agent can scan 200 commands
// in a few KB instead of the 70K+ that the full wrapper view costs.
function commandsSummaryForTestExpr(testIndex) {
  return `(() => {
    try {
      const all = [...document.querySelectorAll('.test.runnable')];
      const el = all[${testIndex}];
      if (!el) return { error: 'No test at index ${testIndex}', total: all.length };
      const wrappers = [...el.querySelectorAll('.command-wrapper, [class*="command-wrapper"]')];
      const byNumber = new Map();
      wrappers.forEach((w, i) => {
        const numEl = w.querySelector('.command-number, [class*="command-number"]');
        const number = numEl ? numEl.innerText.trim() : '';
        if (!number || byNumber.has(number)) return;
        const cls = w.className || '';
        const stateMatch = cls.match(/command-state-(\\w+)/);
        const nameEl = w.querySelector('.command-method, [class*="command-method"]');
        const argEl = w.querySelector('.command-message, [class*="command-message"]');
        const argRaw = argEl ? argEl.innerText.trim() : null;
        byNumber.set(number, {
          number,
          index: i,
          name: nameEl ? nameEl.innerText.trim() : null,
          arg: argRaw == null ? null : argRaw.slice(0, 80),
          argLength: argRaw == null ? 0 : argRaw.length,
          state: stateMatch ? stateMatch[1] : null,
        });
      });
      const titleEl = el.querySelector(':scope > .collapsible-header-wrapper .runnable-title, :scope .runnable-title');
      const commands = [...byNumber.values()];
      const failedIdx = commands.findIndex((c) => c.state === 'failed');
      return {
        testTitle: titleEl ? titleEl.innerText.split('\\n')[0].trim() : null,
        wrapperRowCount: wrappers.length,
        commandCount: commands.length,
        firstFailedNumber: failedIdx >= 0 ? commands[failedIdx].number : null,
        commands,
      };
    } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
  })()`;
}

// Paged version of commandsForTestExpr — returns wrappers[start .. start+size].
function commandsPagedForTestExpr(testIndex, { page = 0, pageSize = 50, full = false, argMaxBytes = 240, textMaxBytes = 300 } = {}) {
  const start = page * pageSize;
  return `(() => {
    try {
      const all = [...document.querySelectorAll('.test.runnable')];
      const el = all[${testIndex}];
      if (!el) return { error: 'No test at index ${testIndex}', total: all.length };
      const wrappers = [...el.querySelectorAll('.command-wrapper, [class*="command-wrapper"]')];
      const total = wrappers.length;
      const start = ${start};
      const end = Math.min(start + ${pageSize}, total);
      const slice = wrappers.slice(start, end);
      const cmds = slice.map((w, j) => {
        const i = start + j;
        const cls = w.className || '';
        const stateMatch = cls.match(/command-state-(\\w+)/);
        const nameEl = w.querySelector('.command-method, [class*="command-method"]');
        const argEl = w.querySelector('.command-message, [class*="command-message"]');
        const numEl = w.querySelector('.command-number, [class*="command-number"]');
        const argRaw = argEl ? argEl.innerText.trim() : null;
        const textRaw = w.innerText.trim();
        return {
          index: i,
          number: numEl ? numEl.innerText.trim() : null,
          name: nameEl ? nameEl.innerText.trim() : null,
          arg: argRaw == null ? null : (${full} ? argRaw : argRaw.slice(0, ${argMaxBytes})),
          argTruncated: !${full} && !!argRaw && argRaw.length > ${argMaxBytes},
          argLength: argRaw == null ? 0 : argRaw.length,
          state: stateMatch ? stateMatch[1] : null,
          text: ${full} ? textRaw : textRaw.slice(0, ${textMaxBytes}),
          textTruncated: !${full} && textRaw.length > ${textMaxBytes},
        };
      });
      return {
        page: ${page},
        pageSize: ${pageSize},
        start, end, total,
        hasMore: end < total,
        commands: cmds,
      };
    } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
  })()`;
}

// Commands around an anchor — "what ran just before / after the failed
// command". `anchor` is a wrapper DOM index. Two modes:
//   • mode='logical' (default) — `before`/`after` count LOGICAL commands
//     (unique reporter numbers). Cypress renders one logical command as 2-3
//     wrapper rows (parent + retries), so wrapper-based slicing exaggerates
//     the window on retried chains. Logical mode is what humans expect.
//   • mode='wrappers' — raw DOM-row counting. Use only if you need exact
//     wrapper rows (e.g. for parent-row vs child-row diagnostics).
function commandsAroundExpr(testIndex, anchor, before = 5, after = 5, { argMaxBytes = 240, textMaxBytes = 300, mode = 'logical' } = {}) {
  return `(() => {
    try {
      const all = [...document.querySelectorAll('.test.runnable')];
      const el = all[${testIndex}];
      if (!el) return { error: 'No test at index ${testIndex}', total: all.length };
      const wrappers = [...el.querySelectorAll('.command-wrapper, [class*="command-wrapper"]')];
      const anchor = ${anchor};
      const before = ${before};
      const after = ${after};
      const mode = ${JSON.stringify(mode)};
      let lo, hi;
      if (mode === 'logical') {
        // Build a list of unique reporter numbers in DOM order.
        const numberAt = wrappers.map((w) => {
          const n = w.querySelector('.command-number, [class*="command-number"]');
          return n ? n.innerText.trim() : '';
        });
        const uniqueNumbers = [];
        const firstIdxOfNumber = new Map();
        const lastIdxOfNumber = new Map();
        numberAt.forEach((num, i) => {
          if (!num) return;
          if (!firstIdxOfNumber.has(num)) { firstIdxOfNumber.set(num, i); uniqueNumbers.push(num); }
          lastIdxOfNumber.set(num, i);
        });
        const anchorNumber = numberAt[anchor] || null;
        const anchorLogicalIdx = anchorNumber != null ? uniqueNumbers.indexOf(anchorNumber) : -1;
        if (anchorLogicalIdx < 0) {
          // Anchor wrapper has no number (rare). Fall back to wrapper slicing.
          lo = Math.max(0, anchor - before);
          hi = Math.min(wrappers.length, anchor + after + 1);
        } else {
          const loLogical = Math.max(0, anchorLogicalIdx - before);
          const hiLogical = Math.min(uniqueNumbers.length - 1, anchorLogicalIdx + after);
          lo = firstIdxOfNumber.get(uniqueNumbers[loLogical]);
          hi = lastIdxOfNumber.get(uniqueNumbers[hiLogical]) + 1;
        }
      } else {
        lo = Math.max(0, anchor - before);
        hi = Math.min(wrappers.length, anchor + after + 1);
      }
      const cmds = wrappers.slice(lo, hi).map((w, j) => {
        const i = lo + j;
        const cls = w.className || '';
        const stateMatch = cls.match(/command-state-(\\w+)/);
        const nameEl = w.querySelector('.command-method, [class*="command-method"]');
        const argEl = w.querySelector('.command-message, [class*="command-message"]');
        const numEl = w.querySelector('.command-number, [class*="command-number"]');
        const argRaw = argEl ? argEl.innerText.trim() : null;
        const textRaw = w.innerText.trim();
        return {
          index: i,
          isAnchor: i === anchor,
          number: numEl ? numEl.innerText.trim() : null,
          name: nameEl ? nameEl.innerText.trim() : null,
          arg: argRaw == null ? null : argRaw.slice(0, ${argMaxBytes}),
          argLength: argRaw == null ? 0 : argRaw.length,
          state: stateMatch ? stateMatch[1] : null,
          text: textRaw.slice(0, ${textMaxBytes}),
        };
      });
      return { anchor, before, after, mode, lo, hi, total: wrappers.length, commands: cmds };
    } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
  })()`;
}

// AUT-iframe storage snapshot: localStorage + sessionStorage + IndexedDB
// database names. IndexedDB.databases() is async, so we mark this expression
// as awaitPromise=true on the evaluator side.
const STORAGE_SNAPSHOT = `(async () => {
  try {
    const aut = document.querySelector('iframe.aut-iframe');
    if (!aut || !aut.contentWindow) return { error: 'AUT iframe not found' };
    const w = aut.contentWindow;
    const ls = {};
    try {
      for (let i = 0; i < w.localStorage.length; i++) {
        const k = w.localStorage.key(i);
        const v = w.localStorage.getItem(k);
        ls[k] = (v || '').length > 1000 ? v.slice(0, 1000) + '... [truncated]' : v;
      }
    } catch (e) { ls.__error = String(e && e.message || e); }
    const ss = {};
    try {
      for (let i = 0; i < w.sessionStorage.length; i++) {
        const k = w.sessionStorage.key(i);
        const v = w.sessionStorage.getItem(k);
        ss[k] = (v || '').length > 1000 ? v.slice(0, 1000) + '... [truncated]' : v;
      }
    } catch (e) { ss.__error = String(e && e.message || e); }
    let dbs = null;
    try {
      if (w.indexedDB && typeof w.indexedDB.databases === 'function') {
        dbs = await w.indexedDB.databases();
      }
    } catch (e) { dbs = { error: String(e && e.message || e) }; }
    let cookies = null;
    try { cookies = aut.contentDocument.cookie || ''; } catch (e) { cookies = String(e && e.message || e); }
    return {
      url: aut.src,
      localStorage: ls,
      localStorageKeys: Object.keys(ls).length,
      sessionStorage: ss,
      sessionStorageKeys: Object.keys(ss).length,
      indexedDB: dbs,
      cookies,
    };
  } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
})()`;

// Clear browser state for the AUT iframe. Best-effort: clears localStorage,
// sessionStorage, cookies (path=/ on current host), and deletes IndexedDB
// databases (with optional skip list). Returns the names of what was cleared
// AND what was skipped.
function clearAppStateExpr({ skipDatabases = [], skipLocalStorage = false, skipSessionStorage = false, skipCookies = false } = {}) {
  return `(async () => {
    const skipDb = new Set(${JSON.stringify(skipDatabases)});
    const report = { localStorage: 0, sessionStorage: 0, cookies: 0, databasesDeleted: [], databasesSkipped: [], errors: [] };
    try {
      // Use AUT iframe when present (normal mid-run case). Fall back to the
      // runner window itself — same origin as the app, so localStorage /
      // IndexedDB are identical. This allows clearing when the spec runner
      // has navigated away to the specs list and the AUT iframe is gone.
      const aut = document.querySelector('iframe.aut-iframe');
      const w = (aut && aut.contentWindow) || window;
      const d = (aut && aut.contentDocument) || document;
      if (!w) return { error: 'AUT iframe not found' };
      if (!${skipLocalStorage}) {
        try { report.localStorage = w.localStorage.length; w.localStorage.clear(); } catch (e) { report.errors.push('localStorage: ' + e.message); }
      }
      if (!${skipSessionStorage}) {
        try { report.sessionStorage = w.sessionStorage.length; w.sessionStorage.clear(); } catch (e) { report.errors.push('sessionStorage: ' + e.message); }
      }
      if (!${skipCookies}) {
        try {
          const cookies = (d.cookie || '').split(';');
          report.cookies = cookies.filter(Boolean).length;
          for (const c of cookies) {
            const name = c.split('=')[0].trim();
            if (!name) continue;
            d.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;';
          }
        } catch (e) { report.errors.push('cookies: ' + e.message); }
      }
      try {
        if (w.indexedDB && typeof w.indexedDB.databases === 'function') {
          const dbs = await w.indexedDB.databases();
          for (const db of dbs) {
            if (!db.name) continue;
            if (skipDb.has(db.name)) { report.databasesSkipped.push(db.name); continue; }
            await new Promise((resolve) => {
              const req = w.indexedDB.deleteDatabase(db.name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            });
            report.databasesDeleted.push(db.name);
          }
        }
      } catch (e) { report.errors.push('indexedDB: ' + e.message); }
      return report;
    } catch (e) { return { error: String(e && e.stack || e && e.message || e), report }; }
  })()`;
}

// Back-compat: callers using the constant still get the no-args behaviour.
const CLEAR_APP_STATE = clearAppStateExpr();

// Reload the currently-running spec — same effect as clicking the reporter's
// "Rerun all tests" affordance. Cypress doesn't expose a "rerun failed only"
// API, so this is the full-spec rerun.
//
// Strategy order (cheapest first):
//   1. Find and click the reporter's restart button. Cypress 15's reporter
//      header has an icon button labelled "Run All Tests" / "Restart". Class
//      names vary across point releases — match defensively on aria-label,
//      title, button text, and class.
//   2. Try `Cypress.action('runner:restart')` and `Cypress.emit('restart')` —
//      these don't actually work in Cypress 15 (the runner's event manager
//      is not `window.Cypress`), but they're cheap and harmless to try.
//   3. If `forceReload`, do `window.location.reload()`.
//
// Returns `{ ok, via, ... }`. The MCP tool wraps this in a verification loop
// that checks the reporter state actually changed, so a `ok: true` that
// didn't actually do anything is caught on the server side.
function rerunSpecExpr({ forceReload = false } = {}) {
  return `(() => {
    try {
      if (${forceReload}) {
        window.location.reload();
        return { ok: true, via: 'location.reload (forced)' };
      }
      // 1. Click the reporter's restart button.
      const candidates = [...document.querySelectorAll('button, [role="button"], [class*="restart"], [class*="rerun"], [class*="run-all"]')];
      const restartBtn = candidates.find((b) => {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const title = (b.getAttribute('title') || '').toLowerCase();
        const text = ((b.innerText || b.textContent) || '').toLowerCase();
        const cls = (b.className || '').toString().toLowerCase();
        const haystack = aria + ' ' + title + ' ' + text;
        if (/restart|rerun|run all tests|re-run/.test(haystack)) return true;
        if (/restart|rerun/.test(cls)) return true;
        return false;
      });
      if (restartBtn) {
        restartBtn.scrollIntoView({ block: 'center' });
        ['mouseover','mousedown','mouseup','click'].forEach(t =>
          restartBtn.dispatchEvent(new MouseEvent(t, { bubbles: true }))
        );
        const label = restartBtn.getAttribute('aria-label')
          || restartBtn.getAttribute('title')
          || (restartBtn.innerText || '').trim().slice(0, 40)
          || (restartBtn.className || '').toString().slice(0, 60);
        return { ok: true, via: 'click: ' + label };
      }
      // 2. Cypress event APIs (often a no-op in current versions but cheap).
      if (window.Cypress) {
        try { window.Cypress.action && window.Cypress.action('runner:restart'); } catch (e) {}
        try { window.Cypress.emit && window.Cypress.emit('restart'); } catch (e) {}
        // We can't tell if these did anything — the wrapping MCP tool verifies.
        return { ok: true, via: 'Cypress.action/emit (unverified)', warning: 'No restart button found in reporter DOM; the Cypress event APIs may or may not be wired up. The tool will verify via reporter state.' };
      }
      return { ok: false, via: null, hint: 'No restart button found and window.Cypress unavailable. Retry with { forceReload: true } for a hard page reload.' };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  })()`;
}

const RERUN_SPEC = rerunSpecExpr();

// Open an IndexedDB database in the AUT iframe and either list its object
// stores OR dump records from one store. Designed for the PouchDB / offline-
// store debugging case: "what's actually queued / cached?". Each record's
// value is JSON-stringified and clipped to `valueMaxBytes` to keep the
// payload sane.
function getIndexedDbExpr(dbName, { store = null, limit = 25, valueMaxBytes = 2000 } = {}) {
  return `(async () => {
    try {
      const aut = document.querySelector('iframe.aut-iframe');
      if (!aut || !aut.contentWindow) return { error: 'AUT iframe not found' };
      const w = aut.contentWindow;
      if (!w.indexedDB) return { error: 'indexedDB not available on AUT' };
      const db = await new Promise((res, rej) => {
        const req = w.indexedDB.open(${JSON.stringify(dbName)});
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        req.onblocked = () => rej(new Error('open blocked'));
      });
      const stores = [...db.objectStoreNames];
      const wanted = ${JSON.stringify(store)};
      if (!wanted) {
        // Just list stores + record count per store.
        const summary = [];
        for (const name of stores) {
          try {
            const tx = db.transaction(name, 'readonly');
            const s = tx.objectStore(name);
            const count = await new Promise((res, rej) => {
              const r = s.count();
              r.onsuccess = () => res(r.result);
              r.onerror = () => rej(r.error);
            });
            summary.push({ name, count, keyPath: s.keyPath, autoIncrement: s.autoIncrement });
          } catch (e) { summary.push({ name, error: String(e && e.message || e) }); }
        }
        db.close();
        return { db: ${JSON.stringify(dbName)}, version: db.version, stores: summary };
      }
      if (!stores.includes(wanted)) {
        db.close();
        return { error: 'No such object store: ' + wanted, availableStores: stores };
      }
      const records = [];
      let truncatedAt = null;
      await new Promise((res, rej) => {
        const tx = db.transaction(wanted, 'readonly');
        const s = tx.objectStore(wanted);
        const cur = s.openCursor();
        cur.onerror = () => rej(cur.error);
        cur.onsuccess = (ev) => {
          const c = ev.target.result;
          if (!c) return res();
          if (records.length >= ${limit}) { truncatedAt = records.length; return res(); }
          let v = c.value;
          try { v = JSON.stringify(v); } catch (e) { v = String(v); }
          if (v && v.length > ${valueMaxBytes}) { v = v.slice(0, ${valueMaxBytes}) + '... [truncated]'; }
          records.push({ key: c.primaryKey, value: v });
          c.continue();
        };
      });
      db.close();
      return { db: ${JSON.stringify(dbName)}, store: wanted, returned: records.length, truncatedAt, records };
    } catch (e) { return { error: String(e && e.stack || e && e.message || e) }; }
  })()`;
}

module.exports = {
  OVERVIEW,
  FAILURES,
  LIST_TESTS,
  LIVE_COMMANDS,
  liveCommandsExpr,
  AUT_RECT,
  AUT_INFO,
  PINNED_COMMAND,
  REPORTER_WARNINGS,
  STORAGE_SNAPSHOT,
  CLEAR_APP_STATE,
  RERUN_SPEC,
  commandsForTestExpr,
  commandsSummaryForTestExpr,
  commandsPagedForTestExpr,
  commandsAroundExpr,
  getIndexedDbExpr,
  rerunSpecExpr,
  clearAppStateExpr,
  stepToExpr,
  autDomExpr,
  findTestExpr,
  findInAutExpr,
  expandTestExpr,
};
