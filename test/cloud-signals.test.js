const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findSignals } = require('../src/cloud-signals');
const { noiseOf } = require('../src/cloud-network');

// Verbatim from a real replay console, where the REPORTED failure was a plain
// 30-second `cy.get` timeout — the line that actually explains it was buried
// among 205 rows.
const REAL_ROWS = [
  { tSec: 7.88, fraction: 0.16, text: 'Checking if models are still populating: plot-definition-survey, plot-visit' },
  { tSec: 14.65, fraction: 0.31, text: 'Current user is: 2' },
  { tSec: 45.09, fraction: 0.96, text: 'Uncaught exception caught by Cypress: Error: The following error originated from your application code, not from Cypress. > ResizeObserver loop completed with undelivered notifications.' },
  { tSec: 45.43, fraction: 0.97, text: 'COMMAND:START | THE DISMISS SHOULD BE GONE.' },
];

test('the line that explains the failure is lifted out of the console', () => {
  const sigs = findSignals(REAL_ROWS);
  const ids = sigs.map((s) => s.id);
  assert.ok(ids.includes('resize-observer-loop'));
  assert.ok(ids.includes('uncaught-exception'));
  // High severity must sort first — it is the one worth reading.
  assert.equal(sigs[0].severity, 'high');
});

test('a signal carries when it happened, so it can be seeked to', () => {
  const [first] = findSignals(REAL_ROWS);
  assert.equal(first.firstAtSec, 45.09);
  assert.equal(first.samples[0].fraction, 0.96);
});

test('a repeated warning is counted, not repeated hundreds of times', () => {
  const noisy = Array.from({ length: 200 }, (_, i) => ({ tSec: i, fraction: i / 200, text: 'WARNING: selecting random item from dropdown' }));
  const [sig] = findSignals(noisy);
  assert.equal(sig.id, 'random-item-fallback');
  assert.equal(sig.count, 200);
  assert.equal(sig.samples.length, 3, 'samples must be capped so the signal is not buried in its own output');
  assert.equal(sig.lastAtSec, 199);
});

test('an ordinary console produces no signals', () => {
  assert.deepEqual(findSignals([{ tSec: 1, text: 'Loading store auth' }, { tSec: 2, text: 'alreadyExposed? true' }]), []);
  assert.deepEqual(findSignals([]), []);
});

test('every signal explains what it means, not just that it matched', () => {
  for (const s of findSignals(REAL_ROWS)) {
    assert.ok(s.explain && s.explain.length > 30, `${s.id} must say what it means`);
  }
});

// ── network noise ───────────────────────────────────────────────────────────

test('telemetry that fails by design is recognised as noise', () => {
  // Every run examined had `failedOnly` return nothing but these.
  const sentry = noiseOf({ path: '?sentry_version=7&sentry_key=examplePublicKey&sentry_client=sentry.javascript.vue%2F8.55.2', method: 'POST' });
  assert.equal(sentry.id, 'sentry');
  assert.match(sentry.why, /placeholder DSN/);
  assert.equal(noiseOf({ path: 'https://o0.ingest.sentry.io/api/0/envelope/', method: 'POST' }).id, 'sentry');
});

test('real application traffic is never mistaken for noise', () => {
  // The bar for suppression must be high — hiding a genuine 500 would be far
  // worse than showing a Sentry 400.
  for (const path of [
    'http://core:1337/api/basal-area-dbh-measure-surveys/bulk?api-version=v2',
    'plot-visits?use-cache=false&hash=abc&api-version=v2',
    '/api/mint-identifier',
    '_health',
  ]) {
    assert.equal(noiseOf({ path, method: 'POST' }), null, `${path} must not be suppressed`);
  }
});
