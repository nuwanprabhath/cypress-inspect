const assert = require('node:assert/strict');
const { test } = require('node:test');

const { stripAnsi, extractRunUrls, parseGitlabJobUrl } = require('../src/ci-links');

// A GitLab trace is ANSI-coloured, and the escape codes land INSIDE the URL
// match. Taken verbatim from a real trace.
const REAL_TRACE_FRAGMENT = [
  '  Recorded Run: [34m[4mhttps://cloud.cypress.io/projects/6b9ofw/runs/12906[24m[39m',
  '  [90m│[39m Run URL: https://cloud.cypress.io/projects/6b9ofw/runs/12906[0m',
].join('\n');

test('ANSI escape codes are stripped before URLs are matched', () => {
  // Without this the match is `…/runs/12906[0m` — a URL that looks right
  // in a log and 404s in a browser.
  const urls = extractRunUrls(REAL_TRACE_FRAGMENT);
  assert.deepEqual(urls, ['https://cloud.cypress.io/projects/6b9ofw/runs/12906']);
  for (const u of urls) assert.ok(!/|\[\d+m/.test(u), `escape codes leaked into ${u}`);
});

test('stripAnsi leaves ordinary text alone', () => {
  assert.equal(stripAnsi('plain text'), 'plain text');
  assert.equal(stripAnsi('[31mred[0m'), 'red');
});

test('the most specific URL wins, so no extra navigation is needed', () => {
  const log = [
    'https://cloud.cypress.io/projects/abc/runs/1/overview',
    'https://cloud.cypress.io/projects/abc/runs/1',
    'https://cloud.cypress.io/projects/abc/runs/1/test-results/xyz/replay?att=1',
  ].join('\n');
  assert.match(extractRunUrls(log)[0], /\/replay/);
});

test('trailing punctuation from prose is trimmed off the URL', () => {
  assert.deepEqual(
    extractRunUrls('See the run (https://cloud.cypress.io/projects/abc/runs/7).'),
    ['https://cloud.cypress.io/projects/abc/runs/7'],
  );
});

test('a log with no Cypress run URL yields nothing rather than a bad guess', () => {
  assert.deepEqual(extractRunUrls('npm ERR! build failed\nhttps://example.com/x'), []);
  assert.deepEqual(extractRunUrls(''), []);
  assert.deepEqual(extractRunUrls(null), []);
});

test('duplicate mentions collapse to one URL', () => {
  const log = Array(5).fill('https://cloud.cypress.io/projects/abc/runs/9').join('\n');
  assert.equal(extractRunUrls(log).length, 1);
});

test('a GitLab job URL is parsed into the pieces the API needs', () => {
  const p = parseGitlabJobUrl('https://gitlab.com/ternandsparrow/paratoo-fdcp/-/jobs/15922202335');
  assert.equal(p.projectPath, 'ternandsparrow/paratoo-fdcp');
  assert.equal(p.jobId, '15922202335');
  // The v4 API needs the whole path encoded, slashes included.
  assert.equal(p.encodedProject, 'ternandsparrow%2Fparatoo-fdcp');
  assert.equal(p.host, 'https://gitlab.com');
});

test('nested groups and self-hosted hosts are handled', () => {
  const p = parseGitlabJobUrl('https://gitlab.example.com/group/sub/deeper/proj/-/jobs/42');
  assert.equal(p.projectPath, 'group/sub/deeper/proj');
  assert.equal(p.encodedProject, 'group%2Fsub%2Fdeeper%2Fproj');
  assert.equal(p.host, 'https://gitlab.example.com');
  assert.equal(p.jobId, '42');
});

test('a non-job URL is rejected with a usable message', () => {
  assert.equal(parseGitlabJobUrl('https://gitlab.com/group/proj').error, 'not-a-gitlab-job-url');
  assert.equal(parseGitlabJobUrl('not a url at all').error, 'not-a-url');
  // A pipeline URL is the easiest thing to confuse with a job URL.
  assert.equal(parseGitlabJobUrl('https://gitlab.com/g/p/-/pipelines/99').error, 'not-a-gitlab-job-url');
});
