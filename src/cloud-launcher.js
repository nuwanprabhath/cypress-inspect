const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  writeCloudSession,
  clearCloudSession,
  readCloudSession,
  isCdpAlive,
  PROFILE_DIR,
  DEFAULT_PORT,
} = require('./cloud-session');

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const LINUX_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
];
const WIN_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

// Resolve a Chrome/Chromium executable. `CHROME_PATH` wins so anyone on an
// unusual install (Homebrew cask, Flatpak, a pinned version) has an escape
// hatch instead of a hardcoded-path bug report.
function findChrome(env = process.env, platform = process.platform) {
  if (env.CHROME_PATH) {
    if (!fs.existsSync(env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH is set to "${env.CHROME_PATH}" but that file does not exist.`);
    }
    return env.CHROME_PATH;
  }
  const absolute = platform === 'darwin' ? MAC_CANDIDATES : platform === 'win32' ? WIN_CANDIDATES : [];
  for (const c of absolute) if (fs.existsSync(c)) return c;
  if (platform === 'linux') {
    for (const name of LINUX_CANDIDATES) {
      try {
        const found = execFileSync('which', [name], { encoding: 'utf8', timeout: 3000 }).trim();
        if (found) return found;
      } catch {}
    }
  }
  throw new Error(
    'Could not find Google Chrome or Chromium. Set CHROME_PATH to the executable, e.g.\n' +
    '  CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" cypress-inspect cloud',
  );
}

// Note the flags NOT here: no --remote-allow-origins. That flag disables the
// Origin check on the debugging WebSocket, which is what stops arbitrary web
// pages from driving this browser — and this browser holds a logged-in Cypress
// Cloud session. chrome-remote-interface sends no Origin header, so it connects
// without the flag.
function buildChromeArgs({ port, profileDir, url }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ];
  if (url) args.push(url);
  return args;
}

function parseCloudArgs(argv = []) {
  const opts = { port: DEFAULT_PORT, profileDir: PROFILE_DIR, url: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice('--port='.length));
    else if (a === '--profile') opts.profileDir = path.resolve(argv[++i]);
    else if (a.startsWith('--profile=')) opts.profileDir = path.resolve(a.slice('--profile='.length));
    else if (!a.startsWith('-')) opts.url = a;
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  opts.looksShellSplit = looksShellSplit(opts.url);
  return opts;
}

// An unquoted URL is split by the shell on every `&`, so only the part up to the
// first one reaches us and the rest run as background jobs. A Cypress Cloud
// replay link always carries several query parameters, so a single-parameter one
// is very likely a casualty of that — worth a warning, not an error, since it is
// a guess about the user's shell.
function looksShellSplit(url) {
  if (!url) return false;
  return /cloud\.cypress\.io/.test(url) && url.includes('?') && !url.includes('&');
}

function banner(port, url) {
  const lines = [
    '',
    '[cypress-inspect] Cloud debug browser ready.',
    `[cypress-inspect]   CDP port : ${port}`,
    `[cypress-inspect]   Profile  : persistent — your cloud.cypress.io login is remembered`,
    '',
    '[cypress-inspect] Next:',
  ];
  if (!url) {
    lines.push('[cypress-inspect]   1. Paste your Cypress Cloud replay link into the browser');
    lines.push('[cypress-inspect]      (or ask the agent: cloud_open { url: "..." })');
  } else {
    lines.push(`[cypress-inspect]   1. Opened ${url}`);
  }
  lines.push('[cypress-inspect]   2. Ask your agent to call cloud_status, then cloud_console_logs / cloud_seek / cloud_screenshot');
  lines.push('[cypress-inspect]');
  lines.push('[cypress-inspect] This runs alongside `cypress-inspect open` — separate browser, separate session.');
  lines.push('[cypress-inspect] Close the browser or press Ctrl-C to end the session.');
  lines.push('');
  return lines.join('\n');
}

async function runCloud(argv = []) {
  const { port, profileDir, url, looksShellSplit: split } = parseCloudArgs(argv);

  if (split) {
    console.error('[cypress-inspect] ⚠ That URL has only one query parameter, which usually means the shell');
    console.error('[cypress-inspect]   split it on `&` and ran the rest as background jobs. Quote it:');
    console.error('[cypress-inspect]     cypress-inspect cloud "https://cloud.cypress.io/…/replay?actions=…&att=1&…"');
    console.error('[cypress-inspect]   Continuing with the truncated URL; the replay may not load.');
  }

  // Chrome refuses a second --remote-debugging-port for a profile that is
  // already open: the new process hands the URL to the running instance and
  // exits immediately, which would leave us waiting on a dead child. So if a
  // browser is already listening, reuse it rather than fighting it.
  const alive = await isCdpAlive(port);
  if (alive) {
    const existing = await readCloudSession();
    console.error(`[cypress-inspect] A cloud debug browser is already listening on port ${port} (${alive.Browser || 'Chrome'}).`);
    const { CloudCdp } = require('./cloud-cdp');
    const cdp = new CloudCdp(port);
    try {
      // A live debugging port does not imply a live window: on macOS, closing
      // the last Chrome window leaves the process (and this port) running with
      // zero page targets. Open a tab rather than telling the user to relaunch
      // a browser that is already up.
      const hadTab = (await cdp.listTargets()).length > 0;
      if (url) {
        const nav = await cdp.navigate(url);
        console.error(`[cypress-inspect] ${nav.openedNewTab ? 'Opened a new tab at' : 'Navigated the existing browser to'} ${url}`);
      } else if (!hadTab) {
        await cdp.openTab('https://cloud.cypress.io/');
        console.error('[cypress-inspect] It had no open windows, so a new tab was opened. Paste your replay link there.');
      }
    } finally {
      await cdp.close();
    }
    if (!existing) await writeCloudSession({ port, profileDir, startedAt: Date.now(), adopted: true });
    console.error('[cypress-inspect] Reusing it. Pass `--port <n>` if you want a second, independent one.');
    return;
  }

  const chrome = findChrome();
  fs.mkdirSync(profileDir, { recursive: true });
  const args = buildChromeArgs({ port, profileDir, url });

  console.error(`[cypress-inspect] Launching cloud debug browser: ${chrome}`);
  const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Chrome is chatty on stderr even when healthy, so its output is buffered and
  // only replayed if the launch actually fails.
  let stderrTail = '';
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-4000); });
  child.stdout.on('data', () => {});
  child.on('error', (err) => {
    console.error(`[cypress-inspect] Failed to launch Chrome: ${err.message}`);
  });

  const ready = await waitForCdp(port, child);
  if (!ready) {
    console.error(`[cypress-inspect] Chrome did not open a debugging port on ${port} within 20s.`);
    if (stderrTail.trim()) console.error(`[cypress-inspect] Chrome stderr:\n${stderrTail.trim()}`);
    try { child.kill(); } catch {}
    process.exit(1);
  }

  await writeCloudSession({ port, profileDir, pid: child.pid, startedAt: Date.now(), url: url || null });
  console.error(banner(port, url));

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));

  await new Promise((resolve) => {
    child.on('exit', async (code) => {
      await clearCloudSession();
      console.error(`[cypress-inspect] Cloud debug browser exited (code ${code}).`);
      resolve();
      process.exit(code ?? 0);
    });
  });
}

async function waitForCdp(port, child, timeoutMs = 20000, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.on('exit', () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) return null;
    const v = await isCdpAlive(port, 1000);
    if (v) return v;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

module.exports = { runCloud, findChrome, buildChromeArgs, parseCloudArgs };
