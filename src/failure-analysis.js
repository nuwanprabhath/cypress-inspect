const { docsHintsForFailure } = require('./cypress-docs');

// Post-processors for the raw `failures` payload returned by cypress-probe.

// Parse Cypress-style "Compare" assertion errors (e.g. "InProgress Summary
// Widget comparison failed") into a structured list of {path, expected, actual,
// kind}. The error message contains repeated blocks like:
//
//   Value mismatch at path 'Plot Description Enhanced.Structural Formation': string vs string (value_mismatch)]
//   Path: Plot Description Enhanced,Structural Formation
//   Expected: "ICFE (Isolated clumps of ferns)"
//   Actual: "STG (Sparse tussock grassland)"
//
// Also captures the FAILURES summary line if present.
function parseCompareError(message) {
  if (!message || typeof message !== 'string') return null;
  if (!/comparison failed/i.test(message) && !/Compare - FAILURES/i.test(message)) return null;

  const summaryMatch = message.match(/FAILURES:\s*(\d+)\/(\d+)\s*result\(s\)\s*failed/i);
  const diffs = [];
  // Match blocks: Path:, Expected:, Actual: in order. Each may be quoted.
  // Each block is `Path: ...\nExpected: ...\nActual: ...` on consecutive lines.
  // Use end-of-line anchors instead of a lookahead so the last block (followed
  // by stack/code-frame, not another "Path:") still parses.
  const blockRe = /Path:\s*([^\n]+)\nExpected:\s*([^\n]+)\nActual:\s*([^\n]+)/g;
  let m;
  while ((m = blockRe.exec(message)) !== null) {
    const path = m[1].trim();
    // Cypress emits paths as comma-joined (e.g. "Plot Description,Structural Formation").
    // Some are dot-joined depending on the source. Split on commas first, then dots.
    const pathSegments = path.includes(',')
      ? path.split(',').map((s) => s.trim()).filter(Boolean)
      : path.split('.').map((s) => s.trim()).filter(Boolean);
    diffs.push({
      path,
      pathSegments,
      expected: unquote(m[2].trim()),
      actual: unquote(m[3].trim()),
    });
  }
  return {
    kind: 'compare',
    summary: summaryMatch ? { failed: +summaryMatch[1], total: +summaryMatch[2] } : null,
    diffs,
  };
}

function unquote(s) {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

// Heuristic: mark a failure as a likely cascade from an earlier one.
// Cypress emits these patterns when a test panics out:
//   - "Cypress test was stopped while running this command."
//   - "Timed out retrying after Xms: Expected to find element: ..."
//     (often shows up because the previous test left the app in the wrong state)
//   - "expected { ... } to deeply equal { ... }" on auth/session context
// We do NOT mark the first failure as cascade, ever — it's the root.
function annotateCascades(failures) {
  if (!failures || failures.length === 0) return failures;
  const cascadePatterns = [
    /Cypress test was stopped while running/i,
    /Timed out retrying after \d+ms/i,
    /expected\s+\{[^}]*\}\s+to deeply equal/i,
  ];
  const rootIndex = 0;
  return failures.map((f, i) => {
    if (i === rootIndex) return { ...f, rootCause: true };
    const looksLikeCascade = cascadePatterns.some((re) => re.test(f.message || ''));
    return looksLikeCascade
      ? { ...f, looksLikeCascade: true, cascadeOf: failures[rootIndex].index ?? rootIndex }
      : f;
  });
}

// Known Cypress / test-helper console warnings that strongly predict a
// particular class of flake. Scanning the in-memory console buffer for these
// at `get_failures` time lets an agent see "this failure correlates with a
// random selection" without a second round-trip to get_console_logs.
const FLAKE_PATTERNS = [
  {
    id: 'random_dropdown_selection',
    pattern: /WARNING:\s*selecting random item from dropdown/i,
    explain: 'A call to selectFromDropdown received nil/null for the item to select, which makes it pick a random option. If the expected value is fixed (e.g. in a fixture), the assertion will flake with a different "actual" value each run.',
  },
  {
    id: 'no_search_query_for_dropdown',
    pattern: /WARNING:\s*no search query provided for dropdown/i,
    explain: 'selectFromDropdown opened a large dropdown without a search query — Cypress may click the wrong option if multiple labels share a substring. Pass a third argument as a search query.',
  },
];

function scanFlakeSignals(logs, { source = 'console' } = {}) {
  if (!Array.isArray(logs) || logs.length === 0) return [];
  const out = [];
  for (const { id, pattern, explain } of FLAKE_PATTERNS) {
    const hits = logs.filter((l) => pattern.test(l.text || ''));
    if (hits.length) {
      out.push({
        id,
        explain,
        source,
        count: hits.length,
        firstOccurrence: hits[0],
        sample: (hits[0].text || '').slice(0, 240),
      });
    }
  }
  return out;
}

function mergeFlakeSignals(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const sig of list) {
      const existing = byId.get(sig.id);
      if (!existing) {
        byId.set(sig.id, { ...sig, sources: [sig.source].filter(Boolean) });
      } else {
        existing.count += sig.count;
        if (sig.source && !existing.sources.includes(sig.source)) existing.sources.push(sig.source);
      }
    }
  }
  // Drop the per-entry `source` since we have `sources` aggregated.
  return [...byId.values()].map((s) => { const { source, ...rest } = s; return rest; });
}

// Augment a get_failures payload with parsed diffs, cascade annotations, and
// optional flake signals scanned from a console log buffer (pass `logs`).
function augmentFailures(payload, { dedupe = false, logs = null, reporterWarnings = null } = {}) {
  if (!payload || !Array.isArray(payload.failures)) return payload;
  let failures = payload.failures.map((f) => {
    const parsed = parseCompareError(f.message);
    const next = parsed ? { ...f, parsedDiff: parsed } : { ...f };
    const hints = docsHintsForFailure(next);
    if (hints.length) next.cypressDocsHints = hints;
    return next;
  });
  failures = annotateCascades(failures);

  const consoleSignals = logs ? scanFlakeSignals(logs, { source: 'console' }) : [];
  const reporterSignals = reporterWarnings
    ? scanFlakeSignals(reporterWarnings, { source: 'reporter' })
    : [];
  const flakeSignals = mergeFlakeSignals(consoleSignals, reporterSignals);
  // Attach the flake signals as a hint on the root-cause failure, since they
  // typically explain the root, not the cascades.
  if (flakeSignals.length) {
    failures = failures.map((f) =>
      f.rootCause ? { ...f, flakeSignals: flakeSignals.map((s) => s.id) } : f,
    );
  }

  if (dedupe) {
    const root = failures.filter((f) => f.rootCause);
    const cascades = failures.filter((f) => f.looksLikeCascade);
    const other = failures.filter((f) => !f.rootCause && !f.looksLikeCascade);
    return {
      count: failures.length,
      rootCount: root.length,
      cascadeCount: cascades.length,
      independentCount: other.length,
      rootCauses: root.map((f) => f.index),
      flakeSignals,
      failures: [...root, ...other],
      cascadingFailures: cascades.map((f) => ({
        index: f.index,
        title: f.title,
        cascadeOf: f.cascadeOf,
        firstLineOfMessage: (f.message || '').split('\n')[0],
      })),
    };
  }
  return { ...payload, failures, flakeSignals };
}

module.exports = {
  parseCompareError,
  annotateCascades,
  augmentFailures,
  scanFlakeSignals,
  mergeFlakeSignals,
  FLAKE_PATTERNS,
};
