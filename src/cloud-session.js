const fs = require('fs');
const path = require('path');
const os = require('os');

// Cloud mode is deliberately isolated from `cypress-inspect open`: a separate
// session file, a separate Chrome process, a separate profile. Both modes can
// therefore be live at the same time without either clobbering the other's port.
const DIR = path.join(os.homedir(), '.cypress-inspect');
const FILE = path.join(DIR, 'cloud-session.json');
const PROFILE_DIR = path.join(DIR, 'cloud-profile');

// Not 9222: that is the port people use when they start their own Chrome with
// --remote-debugging-port by hand, and attaching to the wrong browser is a
// confusing failure. Cypress picks random high ports for its own test browser,
// so a fixed port here cannot collide with `open` mode either.
const DEFAULT_PORT = 9333;

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

async function writeCloudSession(data) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2));
}

async function readCloudSession() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data?.port) return data;
  } catch {}
  return null;
}

async function clearCloudSession() {
  try { fs.unlinkSync(FILE); } catch {}
}

// A session file can outlive the browser it describes (SIGKILL, a crash, a
// reboot). Every caller therefore checks liveness over HTTP rather than trusting
// the file — `/json/version` is the cheapest endpoint CDP exposes.
async function isCdpAlive(port, timeoutMs = 1500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function printCloudSession(s) {
  if (!s) {
    console.log('No active cloud session. Run `cypress-inspect cloud` first.');
    return;
  }
  console.log(JSON.stringify(s, null, 2));
}

module.exports = {
  writeCloudSession,
  readCloudSession,
  clearCloudSession,
  printCloudSession,
  isCdpAlive,
  FILE,
  PROFILE_DIR,
  DEFAULT_PORT,
};
