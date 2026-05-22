const assert = require('node:assert/strict');
const { test } = require('node:test');
const { analyzeSpec, classifySelector } = require('../src/spec-analysis');

function findRule(smells, rule) {
  return smells.filter((s) => s.rule === rule);
}

test('classifySelector: data-cy is clean', () => {
  assert.equal(classifySelector('[data-cy="submit"]'), null);
  assert.equal(classifySelector('[data-testid=login]'), null);
});

test('classifySelector: flags single class / nth-child / bare tag', () => {
  assert.equal(classifySelector('.btn').severity, 'warn');
  assert.equal(classifySelector('li:nth-child(2)').severity, 'warn');
  assert.equal(classifySelector('button').severity, 'info');
  assert.equal(classifySelector('#submit').severity, 'info');
});

test('analyzeSpec: detects hardcoded cy.wait(<number>)', () => {
  const src = `it('x', () => { cy.wait(2000); cy.get('[data-cy=ok]').should('exist'); });`;
  const out = analyzeSpec(src);
  const waits = findRule(out.smells, 'hardcoded-wait');
  assert.equal(waits.length, 1);
  assert.match(waits[0].message, /Hardcoded waits/);
});

test('analyzeSpec: cy.wait("@alias") is NOT flagged', () => {
  const src = `it('x', () => { cy.wait('@xhr').its('response').should('exist'); });`;
  const out = analyzeSpec(src);
  assert.equal(findRule(out.smells, 'hardcoded-wait').length, 0);
});

test('analyzeSpec: brittle selectors flagged for class / nth-child', () => {
  const src = `
    it('x', () => {
      cy.get('.btn').click();
      cy.find('li:nth-child(2)').should('be.visible');
      cy.get('[data-cy=ok]').should('exist');
    });
  `;
  const out = analyzeSpec(src);
  const sel = findRule(out.smells, 'brittle-selector');
  assert.equal(sel.length, 2);
  const selectors = sel.map((s) => s.selector).sort();
  assert.deepEqual(selectors, ['.btn', 'li:nth-child(2)']);
});

test('analyzeSpec: missing-assertion when it() body has no assertion', () => {
  const src = `it('does a thing', () => { cy.get('[data-cy=x]').click(); });`;
  const out = analyzeSpec(src);
  assert.equal(findRule(out.smells, 'missing-assertion').length, 1);
});

test('analyzeSpec: cy.contains counts as an assertion', () => {
  const src = `it('y', () => { cy.contains('Welcome'); });`;
  const out = analyzeSpec(src);
  assert.equal(findRule(out.smells, 'missing-assertion').length, 0);
});

test('analyzeSpec: detects null-helper-arg (random-dropdown trigger)', () => {
  const src = `it('z', () => { cy.selectFromDropdown('structural_formation', null); cy.get('[data-cy=ok]').should('exist'); });`;
  const out = analyzeSpec(src);
  assert.equal(findRule(out.smells, 'null-helper-arg').length, 1);
});

test('analyzeSpec: flags await on cy.* chain', () => {
  const src = `it('a', async () => { await cy.get('[data-cy=x]'); });`;
  const out = analyzeSpec(src);
  const await_ = findRule(out.smells, 'await-on-cypress');
  assert.equal(await_.length, 1);
  assert.equal(await_[0].severity, 'error');
});

test('analyzeSpec: flags it.only / describe.only', () => {
  const src = `describe.only('s', () => { it.only('t', () => { expect(1).to.eq(1); }); });`;
  const out = analyzeSpec(src);
  assert.equal(findRule(out.smells, 'focused-test').length, 2);
});

test('analyzeSpec: comments and strings do not produce false positives', () => {
  const src = `
    // cy.wait(1000) is bad — example only
    it('x', () => {
      const note = 'cy.wait(500) in a string';
      cy.get('[data-cy=x]').should('exist');
    });
  `;
  const out = analyzeSpec(src);
  // String literals get preserved, so the literal IS picked up — that's fine,
  // but the comment must be stripped.
  const waits = findRule(out.smells, 'hardcoded-wait');
  // Only the string-literal one, NOT the comment one.
  assert.equal(waits.length, 1);
  assert.match(waits[0].snippet, /in a string/);
});

test('analyzeSpec: ui-only-setup flagged for many clicks before assertion', () => {
  const src = `
    it('login via UI', () => {
      cy.get('[data-cy=u]').type('a');
      cy.get('[data-cy=p]').type('b');
      cy.get('[data-cy=b1]').click();
      cy.get('[data-cy=b2]').click();
      cy.get('[data-cy=b3]').click();
      cy.get('[data-cy=b4]').click();
      cy.get('[data-cy=ok]').should('exist');
    });
  `;
  const out = analyzeSpec(src);
  assert.equal(findRule(out.smells, 'ui-only-setup').length, 1);
});

test('analyzeSpec: ui-only-setup NOT flagged when cy.session is used', () => {
  const src = `
    it('login via session', () => {
      cy.session('user', () => {
        cy.get('[data-cy=u]').type('a');
        cy.get('[data-cy=p]').type('b');
        cy.get('[data-cy=b1]').click();
        cy.get('[data-cy=b2]').click();
        cy.get('[data-cy=b3]').click();
        cy.get('[data-cy=b4]').click();
      });
      cy.get('[data-cy=ok]').should('exist');
    });
  `;
  const out = analyzeSpec(src);
  assert.equal(findRule(out.smells, 'ui-only-setup').length, 0);
});

test('analyzeSpec: overlong-test flagged when body exceeds maxTestLines', () => {
  const body = Array.from({ length: 30 }, (_, i) => `      cy.get('[data-cy=x${i}]').click();`).join('\n');
  const src = `it('huge', () => {\n${body}\n      cy.get('[data-cy=ok]').should('exist');\n    });`;
  const out = analyzeSpec(src, { maxTestLines: 10 });
  const long = findRule(out.smells, 'overlong-test');
  assert.equal(long.length, 1);
  assert.ok(long[0].lineCount > 10);
});

test('analyzeSpec: summary counts every rule type', () => {
  const src = `it('x', () => { cy.wait(100); cy.get('.btn').click(); });`;
  const out = analyzeSpec(src);
  assert.equal(out.summary['hardcoded-wait'], 1);
  assert.equal(out.summary['brittle-selector'], 1);
  assert.equal(out.summary['missing-assertion'], 1);
});

test('analyzeSpec: returns tests list with title + line range', () => {
  const src = `it('alpha', () => { expect(1).to.eq(1); });\nit('beta', () => { expect(2).to.eq(2); });`;
  const out = analyzeSpec(src);
  assert.equal(out.tests.length, 2);
  assert.equal(out.tests[0].title, 'alpha');
  assert.equal(out.tests[1].title, 'beta');
});

test('analyzeSpec: non-string source is handled gracefully', () => {
  const out = analyzeSpec(null);
  assert.ok(out.error);
  assert.deepEqual(out.smells, []);
});
