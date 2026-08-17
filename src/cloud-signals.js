/*
 * High-signal lines hiding in a replay's console.
 *
 * A 200-to-800 row console holds a handful of lines that actually explain a
 * CI-only failure, and they are easy to walk straight past. Real example, found
 * by eye rather than by tooling in a run whose reported failure was a plain
 * 30-second `cy.get` timeout:
 *
 *   Uncaught exception caught by Cypress: … ResizeObserver loop completed with
 *   undelivered notifications … Cypress will automatically fail the current test.
 *
 * That reframes the failure entirely — from "the element never rendered" to
 * "Cypress aborted the test on a benign browser warning". This mirrors the
 * `flakeSignals` the local-runner tools already produce.
 *
 * Each pattern says what it MEANS, not just that it matched, because "matched a
 * regex" is not a diagnosis.
 */

const SIGNALS = [
  {
    id: 'uncaught-exception',
    re: /Uncaught exception caught by Cypress|originated from your application code/i,
    severity: 'high',
    explain: 'Cypress fails a test on any uncaught app exception. This may be the real cause, even when the reported error is a later timeout.',
  },
  {
    id: 'resize-observer-loop',
    re: /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i,
    severity: 'high',
    explain: 'A benign browser warning that Cypress nonetheless treats as a test-failing uncaught exception. Classic CI-only flake — it needs contention to appear. Suppress via an `uncaught:exception` handler if it is not a real bug.',
  },
  {
    id: 'unhandled-rejection',
    re: /Unhandled (promise )?rejection/i,
    severity: 'high',
    explain: 'A promise rejected with nobody listening; Cypress may fail the test on it.',
  },
  {
    id: 'random-item-fallback',
    re: /WARNING:.*random item|selecting random item/i,
    severity: 'medium',
    explain: 'A dropdown helper fell back to picking an arbitrary item, so the value differs between runs — a common source of assertions that pass locally and fail in CI.',
  },
  {
    id: 'still-loading',
    re: /is still loading|still populating/i,
    severity: 'medium',
    explain: 'The app was waiting on data when the test moved on or timed out — points at slowness rather than a broken assertion.',
  },
  {
    id: 'retry-exhausted',
    re: /did not reach expected count|Timed out retrying/i,
    severity: 'medium',
    explain: 'A retry loop gave up. Usually a timing/slowness problem rather than a logic error.',
  },
  {
    id: 'app-error',
    re: /\b(TypeError|ReferenceError|SyntaxError)\b|Cannot read propert/i,
    severity: 'high',
    explain: 'A JavaScript error from the application itself.',
  },
];

/*
 * Group matching console rows by signal.
 *
 * Rows are counted and a few samples kept, rather than every match returned: a
 * loop can emit the same warning hundreds of times, and a tool that floods the
 * response with them buries the thing it was meant to highlight.
 */
function findSignals(entries, { samplesPerSignal = 3 } = {}) {
  const out = [];
  for (const sig of SIGNALS) {
    const hits = entries.filter((e) => sig.re.test(e.text || ''));
    if (!hits.length) continue;
    out.push({
      id: sig.id,
      severity: sig.severity,
      explain: sig.explain,
      count: hits.length,
      firstAtSec: hits[0].tSec ?? null,
      lastAtSec: hits[hits.length - 1].tSec ?? null,
      samples: hits.slice(0, samplesPerSignal).map((h) => ({
        tSec: h.tSec ?? null,
        fraction: h.fraction ?? null,
        text: (h.text || '').slice(0, 300),
      })),
    });
  }
  // Highest severity first, then most frequent — the order you would read them.
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.count - a.count));
}

module.exports = { findSignals, SIGNALS };
