const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCloudArgs, buildChromeArgs, findChrome } = require('../src/cloud-launcher');
const { DEFAULT_PORT, PROFILE_DIR } = require('../src/cloud-session');

test('parseCloudArgs defaults to the isolated port and persistent profile', () => {
  const o = parseCloudArgs([]);
  assert.equal(o.port, DEFAULT_PORT);
  assert.equal(o.profileDir, PROFILE_DIR);
  assert.equal(o.url, null);
  // 9222 is what people use for a hand-started debug Chrome; picking it here
  // would make `cloud` silently drive the wrong browser.
  assert.notEqual(o.port, 9222);
});

test('parseCloudArgs takes a bare URL as the page to open', () => {
  const url = 'https://cloud.cypress.io/projects/6b9ofw/runs/12788/test-results/e43b3a32/replay?actions=%5B%5D&att=1';
  assert.equal(parseCloudArgs([url]).url, url);
  assert.equal(parseCloudArgs(['--port', '9444', url]).url, url);
  assert.equal(parseCloudArgs(['--port', '9444', url]).port, 9444);
});

test('parseCloudArgs accepts both `--flag value` and `--flag=value`', () => {
  assert.equal(parseCloudArgs(['--port=9500']).port, 9500);
  assert.equal(parseCloudArgs(['--profile=/tmp/p']).profileDir, path.resolve('/tmp/p'));
  assert.equal(parseCloudArgs(['--profile', '/tmp/p']).profileDir, path.resolve('/tmp/p'));
});

test('parseCloudArgs rejects a nonsense port instead of launching on NaN', () => {
  assert.throws(() => parseCloudArgs(['--port', 'abc']), /Invalid --port/);
  assert.throws(() => parseCloudArgs(['--port', '0']), /Invalid --port/);
  assert.throws(() => parseCloudArgs(['--port', '99999']), /Invalid --port/);
});

test('a URL the shell split on `&` is flagged', () => {
  // Unquoted, bash splits a replay link on every `&`: only the part up to the
  // first one arrives and the rest become background jobs. Real replay links
  // always carry several parameters, so one parameter means truncation.
  assert.equal(parseCloudArgs(['https://cloud.cypress.io/projects/x/runs/1/test-results/y/replay?actions=%5B%5D']).looksShellSplit, true);
  assert.equal(parseCloudArgs(['https://cloud.cypress.io/projects/x/runs/1/test-results/y/replay?actions=%5B%5D&att=1']).looksShellSplit, false);
  assert.equal(parseCloudArgs(['https://cloud.cypress.io/projects/x']).looksShellSplit, false);
  assert.equal(parseCloudArgs([]).looksShellSplit, false);
  // Not our URL shape — do not guess about other hosts.
  assert.equal(parseCloudArgs(['https://example.com/x?a=1']).looksShellSplit, false);
});

test('buildChromeArgs enables CDP on the requested port with an isolated profile', () => {
  const args = buildChromeArgs({ port: 9333, profileDir: '/tmp/prof', url: 'https://example.com' });
  assert.ok(args.includes('--remote-debugging-port=9333'));
  assert.ok(args.includes('--user-data-dir=/tmp/prof'));
  assert.equal(args[args.length - 1], 'https://example.com', 'the URL must be positional, after the flags');
});

test('buildChromeArgs omits the URL when none was given', () => {
  const args = buildChromeArgs({ port: 9333, profileDir: '/tmp/prof', url: null });
  assert.ok(!args.some((a) => /^https?:/.test(a)));
});

test('buildChromeArgs does not weaken the debugging-port Origin check', () => {
  // --remote-allow-origins=* lets any web page open a WebSocket to the debugging
  // port. This browser holds a logged-in cloud.cypress.io session, so that would
  // hand any visited page control of it. chrome-remote-interface sends no Origin
  // header and does not need the flag.
  const args = buildChromeArgs({ port: 9333, profileDir: '/tmp/prof', url: null });
  assert.ok(!args.some((a) => a.startsWith('--remote-allow-origins')));
});

test('findChrome honours CHROME_PATH and rejects a bad one loudly', () => {
  const real = path.join(os.tmpdir(), `fake-chrome-${process.pid}`);
  fs.writeFileSync(real, '');
  try {
    assert.equal(findChrome({ CHROME_PATH: real }, 'linux'), real);
    assert.throws(
      () => findChrome({ CHROME_PATH: '/nope/does/not/exist' }, 'darwin'),
      /CHROME_PATH is set/,
    );
  } finally {
    fs.unlinkSync(real);
  }
});

test('findChrome explains how to recover when no browser is installed', () => {
  // 'aix' hits neither the macOS absolute-path list nor the linux `which` probe.
  assert.throws(() => findChrome({}, 'aix'), /CHROME_PATH/);
});
