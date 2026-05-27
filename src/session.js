const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DIR = path.join(os.homedir(), '.cypress-inspect');
const FILE = path.join(DIR, 'session.json');

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

async function writeSession(data) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2));
}

// Scan running processes for a Chrome instance launched by Cypress and return
// its CDP port. Works on macOS and Linux. This handles the case where the
// launcher's log-scraping regex failed to detect the port, or Cypress was
// launched independently without going through `cypress-inspect open`.
function detectChromePortFromProcesses() {
  // Linux fast path: read /proc/<pid>/cmdline directly. Chrome stores its
  // cmdline with spaces (not NUL) as separators, so we regex the raw string.
  if (process.platform === 'linux') {
    try {
      const pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
      for (const pid of pids) {
        let cmdline;
        try {
          // Read as latin1 to preserve all byte values faithfully
          cmdline = fs.readFileSync(`/proc/${pid}/cmdline`).toString('latin1');
        } catch {
          continue;
        }
        if (!cmdline.includes('chrome')) continue;
        if (!cmdline.includes('Cypress') || !cmdline.includes('user-data-dir')) continue;
        const m = cmdline.match(/--remote-debugging-port[= ](\d{2,6})/);
        if (!m) continue;
        const port = Number(m[1]);
        if (port > 0) return port;
      }
    } catch {}
  }

  // Cross-platform fallback via `ps` (covers macOS and Linux).
  // execFileSync with a fixed arg array — no shell, no injection surface.
  try {
    const out = execFileSync('ps', ['ax', '-o', 'command='], { encoding: 'utf8', timeout: 3000 });
    for (const line of out.split('\n')) {
      if (!line.includes('chrome') && !line.includes('Chrome')) continue;
      if (!line.includes('Cypress') || !line.includes('user-data-dir')) continue;
      const m = line.match(/--remote-debugging-port[= ](\d{2,6})/);
      if (!m) continue;
      const port = Number(m[1]);
      if (port > 0) return port;
    }
  } catch {}

  return null;
}

async function readSession() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data?.port) return data;
  } catch {}
  // Fallback: auto-detect from running processes so tools work even when the
  // launcher's log-scraping regex failed to write the session file.
  const port = detectChromePortFromProcesses();
  if (port) return { port, autoDetected: true };
  return null;
}

async function clearSession() {
  try { fs.unlinkSync(FILE); } catch {}
}

function printSession(s) {
  if (!s) {
    console.log('No active session. Run `cypress-inspect open` first.');
    return;
  }
  console.log(JSON.stringify(s, null, 2));
}

module.exports = { writeSession, readSession, clearSession, printSession, FILE, detectChromePortFromProcesses };
