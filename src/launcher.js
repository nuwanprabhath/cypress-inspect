const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { writeSession, clearSession } = require('./session');

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

async function runOpen(extraArgs) {
  const cwd = process.cwd();
  const bin = findCypressBin(cwd);
  const cmd = bin || 'npx';
  const args = bin ? ['open', ...extraArgs] : ['cypress', 'open', ...extraArgs];

  if (!args.includes('--browser')) {
    args.push('--browser', 'chrome');
  }

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

  const cleanup = async () => {
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

module.exports = { runOpen };
