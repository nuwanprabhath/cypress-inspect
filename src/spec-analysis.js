// Static analysis for Cypress spec files. Codifies the smells enumerated in
// the cypress-io/ai-toolkit explain-test-rules:
//   - brittle selectors (no data-cy / data-test / data-testid)
//   - hardcoded cy.wait(<number>) waits
//   - missing assertions inside an it(...) body
//   - mixing async/sync code (await on a Cypress chain, returning a non-cy
//     Promise from .then)
//   - UI-only state setup (long login/setup via clicks instead of cy.session
//     or cy.request)
//   - overlong tests (heuristic, line count)
//   - random / null helper arguments — covers the same flake class our
//     runtime FLAKE_PATTERNS detect, but at the source.
//
// Returns a structured `{ smells: [...], summary: {...}, tests: [...] }` so
// the agent can correlate static smells with runtime failures.

function analyzeSpec(source, { path = null, maxTestLines = 80 } = {}) {
  if (typeof source !== 'string') {
    return { error: 'source must be a string', smells: [], summary: {}, tests: [] };
  }
  const lines = source.split('\n');
  const smells = [];

  const stripped = stripCommentsAndStrings(source);
  const stripLines = stripped.split('\n');

  // ── Per-line scans ────────────────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripLine = stripLines[i] || '';
    const lineNo = i + 1;

    // 1. hardcoded wait
    const waitMatch = stripLine.match(/\bcy\.wait\s*\(\s*(\d+)\s*\)/);
    if (waitMatch) {
      smells.push({
        rule: 'hardcoded-wait',
        severity: 'warn',
        line: lineNo,
        snippet: line.trim(),
        message: `cy.wait(${waitMatch[1]}) is a fixed-time wait. Prefer cy.intercept + cy.wait('@alias'), or assert on UI state. Hardcoded waits are the #1 source of flake.`,
      });
    }

    // 2. brittle selector — cy.get / cy.find with a non-data-cy string
    const selRe = /\bcy\.(?:get|find)\s*\(\s*(['"`])([^'"`]+)\1/g;
    let sm;
    while ((sm = selRe.exec(stripLine)) !== null) {
      const sel = sm[2];
      const smell = classifySelector(sel);
      if (smell) {
        smells.push({
          rule: 'brittle-selector',
          severity: smell.severity,
          line: lineNo,
          snippet: line.trim(),
          selector: sel,
          message: smell.message,
        });
      }
    }

    // 3. helper called with null — common pattern in selectFromDropdown(...,
    //    null) that triggers random selection. Pure heuristic.
    if (/\b(?:select(?:From)?Dropdown|select|pick)\s*\([^)]*,\s*null\s*[,)]/i.test(stripLine)) {
      smells.push({
        rule: 'null-helper-arg',
        severity: 'warn',
        line: lineNo,
        snippet: line.trim(),
        message: 'A dropdown/select helper was called with `null` as the item-to-select argument. Many such helpers fall back to a RANDOM selection in that branch — fixed-value assertions will flake. Pass an explicit value.',
      });
    }

    // 4. await on a cy.* chain (Cypress promises are not real Promises)
    if (/\bawait\s+cy\./.test(stripLine)) {
      smells.push({
        rule: 'await-on-cypress',
        severity: 'error',
        line: lineNo,
        snippet: line.trim(),
        message: 'Awaiting a `cy.*` chain mixes async/sync incorrectly. Cypress chains are not real Promises — use .then() / .should() to consume their value.',
      });
    }

    // 5. it.only / describe.only (focus left in)
    for (const _ of stripLine.matchAll(/\b(?:it|describe|context)\.only\s*\(/g)) {
      smells.push({
        rule: 'focused-test',
        severity: 'warn',
        line: lineNo,
        snippet: line.trim(),
        message: 'A focused .only() block is committed — every other test in this file will be skipped in CI.',
      });
    }

    // 6. skipped test (informational)
    for (const _ of stripLine.matchAll(/\b(?:it|describe|context)\.skip\s*\(/g)) {
      smells.push({
        rule: 'skipped-test',
        severity: 'info',
        line: lineNo,
        snippet: line.trim(),
        message: 'A .skip() block is committed — the test below is not running.',
      });
    }
  }

  // ── Per-test scans (needs block extraction) ───────────────────────────────
  const tests = extractTests(stripped, lines);
  for (const t of tests) {
    // missing-assertion: no .should, .contains (with assert form), expect(,
    // or .and inside the body.
    const body = t.body;
    const hasAssertion = /\.\s*should\s*\(/.test(body)
      || /\.\s*and\s*\(/.test(body)
      || /\bexpect\s*\(/.test(body)
      || /\bcy\.contains\s*\(/.test(body) // contains is assertion-like
      || /\bassert\s*[.(]/.test(body);
    if (!hasAssertion) {
      smells.push({
        rule: 'missing-assertion',
        severity: 'warn',
        line: t.startLine,
        snippet: `it(${JSON.stringify(t.title)}, ...)`,
        message: 'Test body has no .should/.and/expect/cy.contains/assert. The test may be passing only because Cypress did not throw — add an explicit assertion on the expected outcome.',
      });
    }

    // overlong-test: > maxTestLines
    if (t.endLine - t.startLine > maxTestLines) {
      smells.push({
        rule: 'overlong-test',
        severity: 'info',
        line: t.startLine,
        snippet: `it(${JSON.stringify(t.title)}, ...)`,
        lineCount: t.endLine - t.startLine,
        message: `Test is ${t.endLine - t.startLine} lines (>${maxTestLines}). Long tests are slow to debug and tend to mask root causes — split into focused tests where possible.`,
      });
    }

    // ui-only-state-setup: a high count of cy.get(...).click() before the
    //   first assertion — likely doing login/setup through the UI rather than
    //   cy.session / cy.request.
    const preAssertion = body.split(/\.\s*should\s*\(|\bexpect\s*\(/)[0] || body;
    const clickCount = (preAssertion.match(/\.\s*click\s*\(/g) || []).length;
    const typeCount = (preAssertion.match(/\.\s*type\s*\(/g) || []).length;
    if (clickCount + typeCount >= 6 && !/cy\.session\b|cy\.request\b/.test(body)) {
      smells.push({
        rule: 'ui-only-setup',
        severity: 'info',
        line: t.startLine,
        snippet: `it(${JSON.stringify(t.title)}, ...)`,
        message: `Test performs ${clickCount + typeCount} UI interactions before its first assertion with no cy.session/cy.request. Consider caching state via cy.session() or seeding via cy.request() — faster and less flaky.`,
      });
    }
  }

  const summary = countBy(smells, 'rule');
  return {
    path,
    smells,
    summary,
    tests: tests.map((t) => ({ title: t.title, startLine: t.startLine, endLine: t.endLine })),
  };
}

// Classify a selector string. Returns null if it's fine (data-cy*), or
// `{ severity, message }` describing the smell otherwise.
function classifySelector(sel) {
  if (/\[data-(?:cy|test|testid|qa)/.test(sel)) return null; // good
  if (/^@/.test(sel)) return null; // alias, fine
  if (/^[a-z]+$/i.test(sel)) {
    return { severity: 'info', message: `Selector "${sel}" is a bare tag — prefer [data-cy="…"] or a more specific selector.` };
  }
  if (/:nth-(?:child|of-type)\b/.test(sel)) {
    return { severity: 'warn', message: `Selector "${sel}" uses :nth-child/:nth-of-type — fragile against reordering. Use a data-cy attribute.` };
  }
  if (/^\.[a-zA-Z0-9_-]+$/.test(sel)) {
    return { severity: 'warn', message: `Selector "${sel}" is a single CSS class — fragile against styling refactors. Use [data-cy="…"].` };
  }
  if (/^#[a-zA-Z0-9_-]+$/.test(sel)) {
    return { severity: 'info', message: `Selector "${sel}" is an ID. IDs are OK if intentional, but [data-cy="…"] documents the test contract more clearly.` };
  }
  return null;
}

// Replace string-literal contents and comments with spaces so regex scans
// don't false-match keywords/selectors inside strings or comments.
// (We keep the quoting characters so column offsets are preserved.)
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    // line comment
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  '; i += 2;
      continue;
    }
    // strings — preserve the contents so selector regex still sees them
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) { out += src[i] + src[i + 1]; i += 2; continue; }
        if (src[i] === '\n') out += '\n';
        else out += src[i];
        i++;
      }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    out += ch; i++;
  }
  return out;
}

// Find every it(...) / it.only(...) block and return its body text plus line
// range. Brace-counting is intentionally simple — accepts both arrow and
// traditional function bodies. Skips it.skip(...).
function extractTests(stripped, originalLines) {
  const tests = [];
  const re = /\b(it|context|describe)(?:\.only)?\s*\(\s*(['"`])((?:\\\2|.)*?)\2\s*,\s*(?:async\s+)?(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    if (m[1] !== 'it') continue; // only test bodies for now
    const openIdx = re.lastIndex - 1; // points to {
    const closeIdx = findMatchingBrace(stripped, openIdx);
    if (closeIdx === -1) continue;
    const body = stripped.slice(openIdx + 1, closeIdx);
    const startLine = lineForOffset(stripped, m.index);
    const endLine = lineForOffset(stripped, closeIdx);
    tests.push({ title: m[3], body, startLine, endLine });
  }
  return tests;
}

function findMatchingBrace(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineForOffset(s, off) {
  let line = 1;
  for (let i = 0; i < off && i < s.length; i++) if (s[i] === '\n') line++;
  return line;
}

function countBy(arr, key) {
  const out = {};
  for (const x of arr) out[x[key]] = (out[x[key]] || 0) + 1;
  return out;
}

module.exports = {
  analyzeSpec,
  classifySelector,
  extractTests,
  stripCommentsAndStrings,
};
