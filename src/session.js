const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.cypress-inspect');
const FILE = path.join(DIR, 'session.json');

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

async function writeSession(data) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2));
}

async function readSession() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
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

module.exports = { writeSession, readSession, clearSession, printSession, FILE };
