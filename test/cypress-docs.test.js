const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  docHintForCommand,
  resolveDocPath,
  extractCyCommands,
  docsHintsForFailure,
  fetchCypressDoc,
  HTML_BASE,
} = require('../src/cypress-docs');

test('docHintForCommand: known command → docs URL', () => {
  assert.equal(docHintForCommand('intercept'), `${HTML_BASE}/api/commands/intercept`);
  assert.equal(docHintForCommand('cy.intercept'), `${HTML_BASE}/api/commands/intercept`);
  assert.equal(docHintForCommand('Cy.INTERCEPT()'), `${HTML_BASE}/api/commands/intercept`);
});

test('docHintForCommand: unknown command → null', () => {
  assert.equal(docHintForCommand('totallyMadeUpCommand'), null);
  assert.equal(docHintForCommand(''), null);
  assert.equal(docHintForCommand(null), null);
  assert.equal(docHintForCommand(undefined), null);
});

test('resolveDocPath: command first, then guide, else guess', () => {
  const cmd = resolveDocPath('intercept');
  assert.equal(cmd[0].kind, 'command');
  assert.ok(cmd[0].llmUrl.endsWith('/api/commands/intercept.md'));

  const guide = resolveDocPath('retries');
  assert.equal(guide[0].kind, 'guide');

  const guess = resolveDocPath('zzz-not-real');
  assert.equal(guess[0].kind, 'guess');
});

test('extractCyCommands: pulls cy.* names from text, deduped, lowercased', () => {
  const text = `at cy.click (commands.js:1)\nFailed cy.get('.x')\nthen cy.GET again, finally cy.intercept`;
  const out = extractCyCommands(text);
  assert.deepEqual(out, ['click', 'get', 'intercept']);
});

test('extractCyCommands: safe on empty / non-string', () => {
  assert.deepEqual(extractCyCommands(''), []);
  assert.deepEqual(extractCyCommands(null), []);
  assert.deepEqual(extractCyCommands(undefined), []);
});

test('docsHintsForFailure: maps every recognised cy.* to a docs URL', () => {
  const hints = docsHintsForFailure({
    message: 'Timed out retrying after 4000ms: cy.get() failed',
    stack: 'at cy.intercept (network.js:5)',
  });
  const names = hints.map((h) => h.command);
  assert.deepEqual(names.sort(), ['cy.get', 'cy.intercept']);
  for (const h of hints) assert.ok(h.url.startsWith(HTML_BASE));
});

test('docsHintsForFailure: ignores unknown commands', () => {
  const hints = docsHintsForFailure({ message: 'cy.totallyMadeUpThing failed' });
  assert.deepEqual(hints, []);
});

test('fetchCypressDoc: returns markdown when fetch returns ok', async () => {
  const fakeFetch = async (url) => ({
    ok: true,
    text: async () => `# Intercept docs\n(url: ${url})`,
  });
  const r = await fetchCypressDoc('intercept', { fetchImpl: fakeFetch });
  assert.equal(r.kind, 'command');
  assert.ok(r.markdown.startsWith('# Intercept docs'));
  assert.ok(r.url.endsWith('/api/commands/intercept'));
});

test('fetchCypressDoc: falls through candidates on 404, returns attempts on failure', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => '' });
  const r = await fetchCypressDoc('zzz-not-real', { fetchImpl: fakeFetch });
  assert.ok(r.error);
  assert.ok(Array.isArray(r.attempts));
  assert.equal(r.attempts[0].status, 404);
});

test('fetchCypressDoc: surfaces fetch unavailable cleanly', async () => {
  const r = await fetchCypressDoc('intercept', { fetchImpl: null });
  assert.ok(r.error.includes('fetch unavailable'));
});
