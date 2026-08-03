// Tool registration runs only inside runMcp(), so a bad identifier in a
// registerTool call cannot be caught by requiring the module — it needs the
// server actually started. This smoke test does that over stdio.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const path = require('node:path');

function spawnAndList(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const bin = path.join(__dirname, '..', 'bin', 'cypress-inspect.js');
    const p = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timed out; stderr: ${err}`)); }, timeoutMs);
    p.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.id === 2 && j.result?.tools) {
            clearTimeout(timer);
            p.kill();
            resolve({ tools: j.result.tools, stderr: err });
          }
        } catch {}
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    const send = (o) => p.stdin.write(`${JSON.stringify(o)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 400);
  });
}

// Spawn the server ONCE and share it: `node --test test/*.test.js` runs files in
// parallel, and one child process per test was slow enough under that load to
// trip the timeout even though every test passed in isolation.
let cached = null;
const listTools = () => (cached ||= spawnAndList());

test('every tool registers without throwing, and the server stays clean on stderr', async () => {
  const { tools, stderr } = await listTools();
  assert.ok(tools.length > 30, `expected the full tool set, got ${tools.length}`);
  assert.equal(stderr.trim(), '', `server logged to stderr: ${stderr}`);
});

test('build-health tooling is exposed and rerun_spec can opt out of it', async () => {
  const { tools } = await listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.ok(byName.check_app_health, 'check_app_health must be registered');
  assert.equal(byName.check_app_health.annotations?.readOnlyHint, true);
  assert.ok(byName.rerun_spec.inputSchema.properties.skipHealthCheck, 'rerun_spec must accept skipHealthCheck');
  assert.match(byName.rerun_spec.description, /BUILD SAFETY/);
});

test('check_app_health description matches what the probe actually returns', () => {
  // A stale description is a silent trap: it sent agents looking for `aut.blank`
  // and `assets` on a payload that has neither, and credited the discarded
  // runner-side fetch that this tool exists to avoid.
  const probe = require('../src/cypress-probe');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
  const desc = src.split("'check_app_health'")[1].split('inputSchema')[0];
  for (const field of ['mounted', 'entryScripts', 'appOrigin', 'indeterminate', 'contentType', 'isJs']) {
    assert.ok(desc.includes(field), `description must document the \`${field}\` field it returns`);
    assert.ok(probe.APP_HEALTH.includes(field), `probe must actually return \`${field}\``);
  }
  assert.ok(!/`assets`|`aut\.blank`|`document`/.test(desc), 'description must not reference fields from the discarded implementation');
});

test('wait_for_completion waits out the queued bucket, not just unknown', () => {
  // Cypress 15 marks not-yet-run tests `runnable-processing`, which normalises to
  // `queued` instead of `unknown`. Omitting it here would report a run as
  // complete the moment the first test finishes.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
  const matches = src.match(/\(c\.queued \|\| 0\) === 0|\(counts\.queued \|\| 0\) === 0/g) || [];
  assert.ok(matches.length >= 2, `queued must gate both the poll loop and finishedCleanly, found ${matches.length}`);
});

test('package version, server version and changelog stay in sync', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const serverSrc = fs.readFileSync(path.join(root, 'src', 'mcp-server.js'), 'utf8');
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

  const serverVersion = serverSrc.match(/name: 'cypress-inspect', version: '([^']+)'/)?.[1];
  assert.equal(serverVersion, pkg, 'McpServer version must match package.json');

  const topEntry = changelog.match(/^## (\S+)/m)?.[1];
  assert.equal(topEntry, pkg, 'newest CHANGELOG entry must match package.json');
});
