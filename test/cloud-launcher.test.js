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

// ── headless mode ───────────────────────────────────────────────────────────

test('parseCloudArgs defaults to a headed browser', () => {
  assert.equal(parseCloudArgs([]).headless, false);
});

test('parseCloudArgs accepts --headless', () => {
  assert.equal(parseCloudArgs(['--headless']).headless, true);
  const url = 'https://cloud.cypress.io/projects/x/runs/1/test-results?a=1&b=2';
  const o = parseCloudArgs(['--headless', '--port=9444', url]);
  assert.equal(o.headless, true);
  assert.equal(o.port, 9444);
  assert.equal(o.url, url, '--headless must not be mistaken for the positional URL');
});

test('parseCloudArgs takes a --window-size and rejects a malformed one', () => {
  assert.equal(parseCloudArgs(['--window-size=1280,900']).windowSize, '1280,900');
  assert.equal(parseCloudArgs(['--window-size', '1280x900']).windowSize, '1280,900', 'WxH is accepted and normalised');
  assert.throws(() => parseCloudArgs(['--window-size', 'huge']), /Invalid --window-size/);
});

test('buildChromeArgs stays headed unless asked', () => {
  const args = buildChromeArgs({ port: 9333, profileDir: '/tmp/prof', url: null });
  assert.ok(!args.some((a) => a.startsWith('--headless')));
});

test('buildChromeArgs runs headless with an explicit window size', () => {
  // Headless Chrome defaults to 800x600. Cypress Cloud's run list, command log
  // and network panel are all virtualised, and the replay lays out against the
  // viewport — at 800x600 the scrapes do far more work and the replay is cramped.
  // So a headless browser must always be given a real window size.
  const args = buildChromeArgs({ port: 9333, profileDir: '/tmp/prof', url: null, headless: true });
  assert.ok(args.includes('--headless=new'), 'must use new headless, which supports Input/Page domains');
  assert.ok(args.some((a) => a.startsWith('--window-size=')));
  assert.ok(!args.includes('--window-size=800,600'));
});

test('buildChromeArgs honours a caller-supplied window size', () => {
  const args = buildChromeArgs({ port: 9333, profileDir: '/tmp/prof', url: null, headless: true, windowSize: '1280,900' });
  assert.ok(args.includes('--window-size=1280,900'));
});

test('headless does not disable the Chrome sandbox', () => {
  // CI containers running as root often need --no-sandbox, but adding it here
  // would silently weaken every headless run, including local ones, on a browser
  // holding a logged-in cloud.cypress.io session. Callers who need it must opt in.
  const args = buildChromeArgs({ port: 9333, profileDir: '/tmp/prof', url: null, headless: true });
  assert.ok(!args.includes('--no-sandbox'));
});

test('cloudLaunchOptionsFromEnv is headed unless the environment asks otherwise', () => {
  const { cloudLaunchOptionsFromEnv } = require('../src/cloud-launcher');
  assert.deepEqual(cloudLaunchOptionsFromEnv({}), { headless: false, windowSize: null });
  assert.equal(cloudLaunchOptionsFromEnv({ CYPRESS_INSPECT_CLOUD_HEADLESS: '0' }).headless, false);
  assert.equal(cloudLaunchOptionsFromEnv({ CYPRESS_INSPECT_CLOUD_HEADLESS: 'false' }).headless, false);
  assert.equal(cloudLaunchOptionsFromEnv({ CYPRESS_INSPECT_CLOUD_HEADLESS: '' }).headless, false);
});

test('cloudLaunchOptionsFromEnv turns headless on for a CI agent', () => {
  const { cloudLaunchOptionsFromEnv } = require('../src/cloud-launcher');
  assert.equal(cloudLaunchOptionsFromEnv({ CYPRESS_INSPECT_CLOUD_HEADLESS: '1' }).headless, true);
  assert.equal(cloudLaunchOptionsFromEnv({ CYPRESS_INSPECT_CLOUD_HEADLESS: 'true' }).headless, true);
  assert.equal(
    cloudLaunchOptionsFromEnv({ CYPRESS_INSPECT_CLOUD_HEADLESS: '1', CYPRESS_INSPECT_CLOUD_WINDOW_SIZE: '1280x900' }).windowSize,
    '1280,900',
  );
});

test('cloudLaunchOptionsFromEnv ignores a malformed window size rather than crashing the MCP server', () => {
  // This is read at tool-call time inside a long-lived stdio server; a bad env
  // var must not take the whole server down, so it falls back to the default.
  const { cloudLaunchOptionsFromEnv } = require('../src/cloud-launcher');
  assert.equal(cloudLaunchOptionsFromEnv({ CYPRESS_INSPECT_CLOUD_WINDOW_SIZE: 'huge' }).windowSize, null);
});
