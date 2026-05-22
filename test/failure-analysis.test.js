const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseCompareError, annotateCascades, augmentFailures, scanFlakeSignals } = require('../src/failure-analysis');

const COMPARE_MSG = `InProgress Summary Widget comparison failed

Compare - FAILURES
=========================

FAILURES: 1/47 result(s) failed validation

Value mismatch at path 'Plot Description Enhanced.Structural Formation': string vs string (value_mismatch)]
Summary: undefined/undefined paths failed (undefined)
Path: Plot Description Enhanced,Structural Formation
Expected: "ICFE (Isolated clumps of ferns)"
Actual: "STG (Sparse tussock grassland)"
test/cypress/support/commands.js:642:31
  640 |                   // .throw() will only throw if there are failures.`;

const TWO_DIFF_MSG = `Compare - FAILURES

FAILURES: 2/10 result(s) failed validation

Path: A.B
Expected: "x"
Actual: "y"
Path: C.D
Expected: 1
Actual: 2
Stack trace`;

test('parseCompareError: returns null for non-Compare messages', () => {
  assert.equal(parseCompareError(''), null);
  assert.equal(parseCompareError(null), null);
  assert.equal(parseCompareError('expected foo to equal bar'), null);
});

test('parseCompareError: extracts summary and a single diff', () => {
  const r = parseCompareError(COMPARE_MSG);
  assert.ok(r);
  assert.equal(r.kind, 'compare');
  assert.deepEqual(r.summary, { failed: 1, total: 47 });
  assert.equal(r.diffs.length, 1);
  assert.equal(r.diffs[0].path, 'Plot Description Enhanced,Structural Formation');
  assert.equal(r.diffs[0].expected, 'ICFE (Isolated clumps of ferns)');
  assert.equal(r.diffs[0].actual, 'STG (Sparse tussock grassland)');
});

test('parseCompareError: extracts multiple diffs', () => {
  const r = parseCompareError(TWO_DIFF_MSG);
  assert.equal(r.diffs.length, 2);
  assert.equal(r.diffs[0].path, 'A.B');
  assert.equal(r.diffs[1].path, 'C.D');
  assert.equal(r.diffs[1].expected, '1');
  assert.equal(r.diffs[1].actual, '2');
});

test('annotateCascades: first failure is rootCause, never cascade', () => {
  const out = annotateCascades([
    { index: 0, message: 'whatever' },
    { index: 1, message: 'Timed out retrying after 10000ms: Expected to find element X' },
  ]);
  assert.equal(out[0].rootCause, true);
  assert.equal(out[0].looksLikeCascade, undefined);
  assert.equal(out[1].looksLikeCascade, true);
  assert.equal(out[1].cascadeOf, 0);
});

test('annotateCascades: recognises stop / timeout / deep-equal patterns', () => {
  const out = annotateCascades([
    { index: 5, message: 'real error' },
    { index: 6, message: 'Timed out retrying after 4000ms' },
    { index: 7, message: 'Cypress test was stopped while running this command.' },
    { index: 8, message: 'expected { Object (a, b) } to deeply equal { Object (b, a) }' },
    { index: 9, message: 'something unrelated' },
  ]);
  assert.equal(out[0].rootCause, true);
  for (const i of [1, 2, 3]) assert.equal(out[i].looksLikeCascade, true, `index ${i} should be cascade`);
  assert.equal(out[4].looksLikeCascade, undefined);
});

test('annotateCascades: empty or single-failure input', () => {
  assert.deepEqual(annotateCascades([]), []);
  const one = annotateCascades([{ index: 0, message: 'lol' }]);
  assert.equal(one[0].rootCause, true);
});

test('augmentFailures: attaches parsedDiff when message is a Compare error', () => {
  const out = augmentFailures({
    failures: [
      { index: 9, title: 't', message: COMPARE_MSG },
      { index: 10, title: 'u', message: 'totally unrelated thing' },
    ],
  });
  assert.ok(out.failures[0].parsedDiff);
  assert.equal(out.failures[0].parsedDiff.diffs[0].path, 'Plot Description Enhanced,Structural Formation');
  assert.equal(out.failures[1].parsedDiff, undefined);
});

test('augmentFailures: dedupe splits root + cascades', () => {
  const out = augmentFailures(
    {
      failures: [
        { index: 9, title: 'root', message: COMPARE_MSG },
        { index: 10, title: 'casc1', message: 'Timed out retrying after 10000ms' },
        { index: 11, title: 'casc2', message: 'Cypress test was stopped while running this command.' },
        { index: 12, title: 'independent', message: 'a wholly different error' },
      ],
    },
    { dedupe: true },
  );
  assert.equal(out.rootCount, 1);
  assert.equal(out.cascadeCount, 2);
  assert.equal(out.independentCount, 1);
  assert.equal(out.failures.length, 2); // root + independent
  assert.equal(out.cascadingFailures.length, 2);
  assert.equal(out.cascadingFailures[0].cascadeOf, 9);
});

test('augmentFailures: handles missing failures array gracefully', () => {
  assert.deepEqual(augmentFailures(null), null);
  assert.deepEqual(augmentFailures({}), {});
});

test('parseCompareError: includes pathSegments alongside path (comma-joined)', () => {
  const r = parseCompareError(COMPARE_MSG);
  assert.deepEqual(r.diffs[0].pathSegments, ['Plot Description Enhanced', 'Structural Formation']);
});

test('parseCompareError: pathSegments split on dots when no commas', () => {
  const msg = `Compare - FAILURES\nPath: a.b.c\nExpected: 1\nActual: 2`;
  const r = parseCompareError(msg);
  assert.deepEqual(r.diffs[0].pathSegments, ['a', 'b', 'c']);
});

test('scanFlakeSignals: detects "random item from dropdown"', () => {
  const logs = [
    { text: 'something else' },
    { text: 'WARNING: selecting random item from dropdown - this can lead to flaky tests' },
  ];
  const sig = scanFlakeSignals(logs);
  assert.equal(sig.length, 1);
  assert.equal(sig[0].id, 'random_dropdown_selection');
  assert.equal(sig[0].count, 1);
});

test('scanFlakeSignals: detects "no search query"', () => {
  const sig = scanFlakeSignals([{ text: 'WARNING: no search query provided for dropdown' }]);
  assert.equal(sig.length, 1);
  assert.equal(sig[0].id, 'no_search_query_for_dropdown');
});

test('scanFlakeSignals: empty / non-array inputs are safe', () => {
  assert.deepEqual(scanFlakeSignals([]), []);
  assert.deepEqual(scanFlakeSignals(null), []);
  assert.deepEqual(scanFlakeSignals(undefined), []);
});

test('augmentFailures: attaches flakeSignals to root failure', () => {
  const out = augmentFailures(
    { failures: [{ index: 9, title: 'r', message: COMPARE_MSG }] },
    { logs: [{ text: 'WARNING: selecting random item from dropdown' }] },
  );
  assert.deepEqual(out.failures[0].flakeSignals, ['random_dropdown_selection']);
  assert.equal(out.flakeSignals.length, 1);
});

test('augmentFailures: reporterWarnings is a flake-signal source (Cypress wraps console.*)', () => {
  // The CDP console buffer is empty, but the reporter captured the warning.
  // The merged flakeSignals should still detect random_dropdown_selection.
  const out = augmentFailures(
    { failures: [{ index: 9, title: 'r', message: 'something' }] },
    {
      logs: [],
      reporterWarnings: [
        { text: 'WARNING: selecting random item from dropdown - flake risk', testIndex: 9, commandNumber: '111' },
      ],
    },
  );
  assert.equal(out.flakeSignals.length, 1);
  assert.equal(out.flakeSignals[0].id, 'random_dropdown_selection');
  assert.deepEqual(out.flakeSignals[0].sources, ['reporter']);
  assert.deepEqual(out.failures[0].flakeSignals, ['random_dropdown_selection']);
});

test('augmentFailures: console + reporter signals merge by id with both sources listed', () => {
  const out = augmentFailures(
    { failures: [{ index: 9, message: 'x' }] },
    {
      logs: [{ text: 'WARNING: selecting random item from dropdown' }],
      reporterWarnings: [{ text: 'WARNING: selecting random item from dropdown' }],
    },
  );
  assert.equal(out.flakeSignals.length, 1);
  assert.equal(out.flakeSignals[0].count, 2);
  assert.deepEqual(out.flakeSignals[0].sources.sort(), ['console', 'reporter']);
});

test('augmentFailures: attaches cypressDocsHints when message mentions cy.<command>', () => {
  const out = augmentFailures({
    failures: [
      { index: 0, message: 'Timed out retrying after 4000ms: expected cy.get() to find element', stack: 'at cy.intercept (x:1)' },
      { index: 1, message: 'unrelated error', stack: '' },
    ],
  });
  const hints = out.failures[0].cypressDocsHints;
  assert.ok(Array.isArray(hints));
  const cmds = hints.map((h) => h.command).sort();
  assert.deepEqual(cmds, ['cy.get', 'cy.intercept']);
  assert.equal(out.failures[1].cypressDocsHints, undefined);
});

test('augmentFailures dedupe: surfaces rootCauses[] and flakeSignals top-level', () => {
  const out = augmentFailures(
    {
      failures: [
        { index: 9, title: 'root', message: COMPARE_MSG },
        { index: 10, title: 'casc', message: 'Cypress test was stopped while running this command.' },
      ],
    },
    { dedupe: true, logs: [{ text: 'WARNING: selecting random item from dropdown' }] },
  );
  assert.deepEqual(out.rootCauses, [9]);
  assert.equal(out.flakeSignals[0].id, 'random_dropdown_selection');
});
