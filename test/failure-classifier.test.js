const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classifyFailure, classifyFailures } = require('../src/failure-classifier');

test('compare_diff: parsedDiff present → high confidence', () => {
  const r = classifyFailure({ parsedDiff: { diffs: [{ path: 'a' }, { path: 'b' }] } });
  assert.equal(r.category, 'compare_diff');
  assert.equal(r.confidence, 'high');
});

test('dropdown_ambiguity: flakeSignals includes random_dropdown_selection', () => {
  const r = classifyFailure({ flakeSignals: ['random_dropdown_selection'], message: 'whatever' });
  assert.equal(r.category, 'dropdown_ambiguity');
  assert.equal(r.confidence, 'high');
});

test('network_failure: 5xx in message', () => {
  const r = classifyFailure({ message: 'cy.request("/api/x") failed with status code 503' });
  assert.equal(r.category, 'network_failure');
});

test('route_mismatch: URL assertion in error', () => {
  const r = classifyFailure({ message: 'expected url to include "/dashboard" but got "/login"' });
  assert.equal(r.category, 'route_mismatch');
});

test('selector_not_found: never-found phrasing', () => {
  const r = classifyFailure({ message: 'Expected to find element: `[data-cy=submit]`, but never found it.' });
  assert.equal(r.category, 'selector_not_found');
});

test('timeout_cascade: looksLikeCascade=true → high confidence', () => {
  const r = classifyFailure({
    message: 'Cypress test was stopped while running this command.',
    looksLikeCascade: true,
    cascadeOf: 0,
  });
  assert.equal(r.category, 'timeout_cascade');
  assert.equal(r.confidence, 'high');
});

test('timeout_cascade: plain timeout without cascade → medium', () => {
  const r = classifyFailure({ message: 'Timed out retrying after 4000ms' });
  assert.equal(r.category, 'timeout_cascade');
  assert.equal(r.confidence, 'medium');
});

test('stale_local_state: deep-equal mismatch + session keywords', () => {
  const r = classifyFailure({
    message: 'expected { Object (token, user) } to deeply equal { Object (token, user) }',
    stack: 'at cy.session helper',
  });
  assert.equal(r.category, 'stale_local_state');
});

test('unknown: nothing matches', () => {
  const r = classifyFailure({ message: 'a wholly unrelated error' });
  assert.equal(r.category, 'unknown');
  assert.equal(r.confidence, 'low');
});

test('null / undefined input is safe', () => {
  assert.equal(classifyFailure(null).category, 'unknown');
  assert.equal(classifyFailure(undefined).category, 'unknown');
});

test('classifyFailures: attaches classification to every failure in payload', () => {
  const out = classifyFailures({
    failures: [
      { message: 'expected url to include "/x"' },
      { parsedDiff: { diffs: [{ path: 'a' }] } },
    ],
  });
  assert.equal(out.failures.length, 2);
  assert.equal(out.failures[0].classification.category, 'route_mismatch');
  assert.equal(out.failures[1].classification.category, 'compare_diff');
});

test('classifyFailures: null payload is returned unchanged', () => {
  assert.equal(classifyFailures(null), null);
});

test('augment integration: classification is attached after compare/cascade/flake', () => {
  // Mirror the order augmentFailures uses: parsedDiff > cascade > flake.
  const r = classifyFailure({
    message: 'InProgress Summary Widget comparison failed',
    parsedDiff: { diffs: [{ path: 'x' }] },
    looksLikeCascade: false,
    flakeSignals: ['random_dropdown_selection'],
  });
  // parsedDiff wins.
  assert.equal(r.category, 'compare_diff');
});
