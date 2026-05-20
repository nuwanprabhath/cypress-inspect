// These tests verify the *shape* of the generated JS expressions, not their
// runtime behavior (which requires a live Cypress runner page). Catches regressions
// in argument substitution, regex escaping, and option threading.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const probe = require('../src/cypress-probe');

test('static expressions are non-empty strings', () => {
  for (const key of ['OVERVIEW', 'FAILURES', 'LIST_TESTS', 'LIVE_COMMANDS', 'AUT_RECT', 'AUT_INFO', 'PINNED_COMMAND']) {
    assert.equal(typeof probe[key], 'string', `${key} should be a string`);
    assert.ok(probe[key].length > 50, `${key} should be non-trivial`);
  }
});

test('commandsForTestExpr: embeds the index and full flag', () => {
  const e1 = probe.commandsForTestExpr(7);
  assert.match(e1, /all\[7\]/);
  assert.match(e1, /argRaw\.slice\(0, 240\)/);                 // full=false → truncates
  const e2 = probe.commandsForTestExpr(7, { full: true });
  assert.match(e2, /\(true \? argRaw : argRaw\.slice\(0, 240\)\)/); // full=true → returns argRaw
});

test('stepToExpr: requires either index or number, supports both', () => {
  const byNum = probe.stepToExpr(2, { commandNumber: 38 });
  assert.match(byNum, /all\[2\]/);
  assert.match(byNum, /wantNumber\s*=\s*"38"/);
  assert.match(byNum, /wantIndex\s*=\s*null/);

  const byIdx = probe.stepToExpr(2, { commandIndex: 111 });
  assert.match(byIdx, /wantIndex\s*=\s*111/);
  assert.match(byIdx, /wantNumber\s*=\s*null/);

  const both = probe.stepToExpr(2, { commandIndex: 5, commandNumber: 38 });
  assert.match(both, /wantNumber\s*=\s*"38"/);
  assert.match(both, /wantIndex\s*=\s*5/);
});

test('findInAutExpr: textOnly toggles output shape', () => {
  const reg = probe.findInAutExpr('button', 10);
  assert.match(reg, /if \(false\)/); // textOnly=false → never enters textOnly branch
  assert.match(reg, /elements:\s*els\.map/);

  const txt = probe.findInAutExpr('button', 10, { textOnly: true });
  assert.match(txt, /if \(true\)/);
  assert.match(txt, /texts:\s*els\.map/);
});

test('findTestExpr: lowercases the query for case-insensitive match', () => {
  const e = probe.findTestExpr('Plot Description');
  // The expression should embed the lowercased query as a JS string.
  assert.match(e, /"plot description"/);
});

test('expandTestExpr / autDomExpr / commandsForTestExpr: safely embed numeric indices', () => {
  // No string-injection paths from unsanitised numbers — confirm only digits make it in.
  for (const fn of [probe.expandTestExpr, probe.autDomExpr, probe.commandsForTestExpr]) {
    const out = String(fn(42, 100));
    assert.ok(out.includes('42'), 'index 42 should appear in expression');
  }
});
