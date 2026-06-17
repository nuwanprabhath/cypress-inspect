const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { writeSession, clearSession, detectChromePortFromProcesses } = require('./session');

function findCypressBin(cwd) {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'cypress');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Shared launch path: resolve the cypress bin, spawn it with the given
// sub-command args, scrape the Chrome CDP port from the debug logs, and keep the
// session file pointed at the latest browser. Used by both `open` and `run`.
async function launch(subArgs) {
  const cwd = process.cwd();
  const bin = findCypressBin(cwd);
  const cmd = bin || 'npx';
  const args = bin ? subArgs : ['cypress', ...subArgs];

  const env = {
    ...process.env,
    DEBUG: [process.env.DEBUG, 'cypress:server:browsers*'].filter(Boolean).join(','),
    FORCE_COLOR: '0',
  };

  console.error(`[cypress-inspect] Launching: ${cmd} ${args.join(' ')}`);
  console.error('[cypress-inspect] Waiting for Cypress to open a browser to discover CDP port...');

  const child = spawn(cmd, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });

  // Cypress prints `DevTools listening on ws://127.0.0.1:PORT/...` for its OWN
  // Electron app (the launchpad/specs UI). When the user picks Chrome and a
  // spec, a SEPARATE Chrome is launched and its port is announced via
  // `cypress:server:browsers:cri-client` / `chrome` debug logs. We want the
  // second one. Strategy: ignore the bare "DevTools listening on" line; only
  // match Cypress's debug output; always update the session when a new port
  // appears (so we track the latest launched browser).
  let currentPort = null;

  const onData = (chunk, fd) => {
    const text = chunk.toString();
    if (fd === 'stdout') process.stdout.write(chunk);
    else process.stderr.write(chunk);

    // Skip lines that are *only* the Electron app's own DevTools banner.
    const cleaned = text.replace(/DevTools listening on ws:\/\/[^\s]+/g, '');

    const matches = [];
    let m;
    const portRe = /(?:cri-client|browsers:chrome|debugging port)[^\n]*?(?:port[:= ]\s*|--remote-debugging-port[= ])(\d{2,6})/gi;
    while ((m = portRe.exec(cleaned)) !== null) matches.push(Number(m[1]));
    // Standalone `--remote-debugging-port=NNN` in Chrome arg dumps.
    const argRe = /--remote-debugging-port[= ](\d{2,6})/g;
    while ((m = argRe.exec(cleaned)) !== null) matches.push(Number(m[1]));

    for (const port of matches) {
      if (port === currentPort) continue;
      currentPort = port;
      console.error(`[cypress-inspect] Detected CDP port: ${port}`);
      writeSession({ port, pid: child.pid, cwd, startedAt: Date.now() }).catch(() => {});
    }
  };

  child.stdout.on('data', (c) => onData(c, 'stdout'));
  child.stderr.on('data', (c) => onData(c, 'stderr'));

  // Fallback: if the debug-log regex never fires (e.g. Cypress changed its log
  // format), poll for a Cypress-managed Chrome process every 5 s and write the
  // session from the process list. Stop once a port has been found.
  const pollTimer = setInterval(() => {
    if (currentPort != null) { clearInterval(pollTimer); return; }
    const port = detectChromePortFromProcesses();
    if (port && port !== currentPort) {
      currentPort = port;
      console.error(`[cypress-inspect] Detected CDP port via process scan: ${port}`);
      writeSession({ port, pid: child.pid, cwd, startedAt: Date.now() }).catch(() => {});
      clearInterval(pollTimer);
    }
  }, 5000);

  const cleanup = async () => {
    clearInterval(pollTimer);
    await clearSession();
  };
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));

  await new Promise((resolve) => {
    child.on('exit', async (code) => {
      await cleanup();
      console.error(`[cypress-inspect] Cypress exited with code ${code}`);
      resolve();
      process.exit(code ?? 0);
    });
  });
}

// Does `extraArgs` already contain the given flag (e.g. '--browser')?
function hasFlag(extraArgs, flag) {
  return extraArgs.some((a) => a === flag || a.startsWith(flag + '='));
}

// Ensure `numTestsKeptInMemory=50` is set WITHOUT emitting a second --config
// (Cypress honours only the last --config, so a duplicate would clobber ours).
// Call AFTER all user args are in `subArgs` so we can merge into their --config.
function ensureKeptInMemory(subArgs) {
  if (subArgs.some((a) => /numTestsKeptInMemory/.test(a))) return; // already set
  // Merge into the LAST --config (the one Cypress will actually honour).
  let last = -1;
  for (let i = 0; i < subArgs.length; i++) if (subArgs[i] === '--config') last = i;
  if (last >= 0 && typeof subArgs[last + 1] === 'string') {
    subArgs[last + 1] = subArgs[last + 1] + ',numTestsKeptInMemory=50';
  } else {
    subArgs.push('--config', 'numTestsKeptInMemory=50');
  }
}

// `cypress open` — the interactive runner. Default, fully supported.
async function runOpen(extraArgs = []) {
  const subArgs = ['open', ...extraArgs];
  if (!hasFlag(extraArgs, '--browser')) subArgs.push('--browser', 'chrome');
  return launch(subArgs);
}

// `cypress run` — EXPERIMENTAL, opt-in via the `run` subcommand only.
// Default `cypress run` is headless and exits when done (and sets
// numTestsKeptInMemory=0), which leaves nothing to inspect. To make a run
// inspectable we force a kept-open, headed browser that retains snapshots:
//   --headed     keep a real Chrome with the reporter DOM + AUT iframe
//   --no-exit    keep the runner/browser alive after the spec finishes
//   --browser chrome   (CDP attach target; same as open mode)
//   --config numTestsKeptInMemory=50   stop Cypress GC'ing the command log /
//                                       time-travel snapshots (default is 0 in run)
// All of these are skipped if the user already supplied them via `extraArgs`.
async function runRun(extraArgs = []) {
  const subArgs = ['run'];
  if (!hasFlag(extraArgs, '--headed')) subArgs.push('--headed');
  if (!hasFlag(extraArgs, '--no-exit')) subArgs.push('--no-exit');
  if (!hasFlag(extraArgs, '--browser')) subArgs.push('--browser', 'chrome');
  subArgs.push(...extraArgs);
  ensureKeptInMemory(subArgs); // merge into the user's --config if present

  console.error('[cypress-inspect] ⚠ run mode is EXPERIMENTAL. Drawbacks:');
  console.error('[cypress-inspect]   • Multi-spec runs leave only the LAST spec inspectable — pass `--spec <one>`.');
  console.error('[cypress-inspect]   • `rerun_spec` cannot re-trigger a run-mode spec (no restart UI); re-launch instead.');
  console.error('[cypress-inspect]   • Kept open via --no-exit; close the browser/Ctrl-C when done.');
  if (hasFlag(extraArgs, '--browser') && !extraArgs.includes('chrome')) {
    console.error('[cypress-inspect]   • ⚠ CDP attach needs Chrome — a non-Chrome --browser will not be inspectable.');
  }
  if (!hasFlag(extraArgs, '--spec')) {
    console.error('[cypress-inspect] Tip: add `-- --spec <path>` to inspect a single spec.');
  }
  return launch(subArgs);
}

module.exports = { runOpen, runRun };
