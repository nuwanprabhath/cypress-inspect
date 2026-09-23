// Data layer for `cypress-inspect tom`.
//
// Tom's pipeline reporter (feat/allure-core + feat/allure-viewer) leaves
// everything it knows about a CI run as JSON and trace zips inside the job's
// artifact, under `allure/`. Unlike Cypress Cloud there is nothing to scrape:
// the evidence is data. So this mode reads the artifact directly and never
// needs a browser for the common questions.
//
// Isolated from the local (`open`/`run`) and `cloud` modes: its own cache
// directory, its own modules, no shared session file.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const PROJECT = 'ternandsparrow%2Fparatoo-fdcp'
const API = `https://gitlab.com/api/v4/projects/${PROJECT}`
const CACHE_ROOT = process.env.CYPRESS_INSPECT_TOM_CACHE || path.join(os.homedir(), '.cypress-inspect', 'tom-cache')

const jobDir = (job) => path.join(CACHE_ROOT, String(job))
const allureDir = (job) => path.join(jobDir(job), 'extracted', 'allure')

/** A job id from a bare id or any GitLab / reporter URL that carries one. */
function parseJob(input) {
  if (input == null) return null
  const s = String(input)
  const m = s.match(/[?&]job=(\d+)/) || s.match(/\/jobs\/(\d+)/) || s.match(/^(\d{6,})$/)
  return m ? m[1] : null
}

/** A pipeline id from a bare id or a URL. */
function parsePipeline(input) {
  if (input == null) return null
  const s = String(input)
  const m = s.match(/[?&]pipeline=(\d+)/) || s.match(/\/pipelines\/(\d+)/) || s.match(/^(\d{6,})$/)
  return m ? m[1] : null
}

/** The reporter's `test=` param, if a URL carries one. */
function parseTestParam(input) {
  const m = input && String(input).match(/[?&]test=([0-9a-f]{32})/)
  return m ? m[1] : null
}

const isCached = (job) => fs.existsSync(path.join(allureDir(job), 'test-results.json'))

/**
 * Make sure a job's artifact is on disk and unpacked; return its `allure/` dir.
 *
 * Downloads the WHOLE artifact archive once, through the authenticated `glab`
 * CLI. This is deliberate rather than fetching file by file:
 *   - one request instead of hundreds, and ~13s for a 160 MB shard;
 *   - artifacts EXPIRE (a day, on this project), and a local copy is the only
 *     thing that survives that — debugging should never race the clock;
 *   - the anonymous per-file route works for allure/ but the job log and job
 *     metadata answer 401 without a token, so auth is needed anyway.
 */
function ensureJob(job, { refresh = false, log = () => {} } = {}) {
  if (!job) throw new Error('no job id')
  if (isCached(job) && !refresh) return allureDir(job)
  const dir = jobDir(job)
  fs.mkdirSync(dir, { recursive: true })
  const zip = path.join(dir, 'artifacts.zip')
  log(`downloading artifacts for job ${job} …`)
  const t0 = Date.now()
  let bytes
  try {
    bytes = execFileSync('glab', ['api', `projects/${PROJECT}/jobs/${job}/artifacts`], {
      maxBuffer: 2 * 1024 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const msg = String(e.stderr || e.message)
    if (/404|Not Found/i.test(msg)) {
      throw new Error(`job ${job} has no artifact (404). It may have expired, or the job produced none.`)
    }
    throw new Error(`glab artifact download failed: ${msg.slice(0, 300)}`)
  }
  fs.writeFileSync(zip, bytes)
  log(`  ${(bytes.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s, unpacking …`)
  const out = path.join(dir, 'extracted')
  fs.rmSync(out, { recursive: true, force: true })
  execFileSync('unzip', ['-q', '-o', zip, '-d', out], { stdio: ['ignore', 'ignore', 'pipe'] })
  if (!isCached(job)) {
    throw new Error(`job ${job}: artifact unpacked but has no allure/test-results.json — not a reporter shard?`)
  }
  return allureDir(job)
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

/**
 * `test-results.json` is `{ <env>: { <id>: {id, name, duration, status} } }`.
 * Flatten whatever the wrapper key is — it is Allure's, not ours.
 */
function loadIndex(dir) {
  const raw = readJson(path.join(dir, 'test-results.json'))
  const out = []
  const visit = (o) => {
    if (!o || typeof o !== 'object') return
    if (typeof o.id === 'string' && 'status' in o && 'name' in o) {
      out.push(o)
      return
    }
    for (const v of Object.values(o)) visit(v)
  }
  visit(raw)
  return out
}

const testCache = new Map()
function loadTest(dir, id) {
  const key = dir + '|' + id
  if (!testCache.has(key)) {
    const p = path.join(dir, 'data', 'test-results', id + '.json')
    if (!fs.existsSync(p)) return null
    testCache.set(key, readJson(p))
  }
  return testCache.get(key)
}

/** `monitor-webapp:test/cypress/…/x.cy.js#suite title` → the spec path. */
function specOf(t) {
  const m = t && t.fullName && t.fullName.match(/^[^:]*:([^#]+)#/)
  return m ? m[1] : null
}
const label = (t, name) => (t.labels || []).find((l) => l.name === name)?.value

/**
 * Every test result on disk, enriched and in EXECUTION order.
 *
 * Reads data/test-results/ rather than the index, because the index holds one
 * row per test while retries each get their own result file (403 files for
 * 395 tests on the shard this was written against). A retry that failed and a
 * retry that passed are both evidence.
 */
function listAll(dir) {
  const d = path.join(dir, 'data', 'test-results')
  const rows = []
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json')) continue
    const t = loadTest(dir, f.slice(0, -5))
    if (!t) continue
    rows.push({
      id: t.id,
      name: t.name,
      status: t.status,
      spec: specOf(t),
      suite: label(t, 'parentSuite') || label(t, 'suite') || '',
      order: t.order,
      start: t.start,
      stop: t.stop,
      duration: t.duration,
      isRetry: Boolean(t.isRetry),
      retriesCount: t.retriesCount || 0,
      flaky: Boolean(t.flaky),
      run: label(t, 'run'),
    })
  }
  rows.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || (a.order ?? 0) - (b.order ?? 0))
  return rows
}

const BAD = new Set(['failed', 'broken'])

/**
 * Resolve a test from an id, an id prefix, a reporter URL carrying `test=`, or
 * a case-insensitive substring of its name. Refuses to guess between several.
 */
function resolveTest(dir, query) {
  if (!query) throw new Error('which test? pass an id, id prefix, name substring, or reporter URL')
  const fromUrl = parseTestParam(query)
  const q = fromUrl || String(query)
  if (/^[0-9a-f]{32}$/.test(q)) {
    const t = loadTest(dir, q)
    if (!t) throw new Error(`no test result ${q} in this job`)
    return t
  }
  const all = listAll(dir)
  let hits = /^[0-9a-f]{4,31}$/.test(q) ? all.filter((r) => r.id.startsWith(q)) : []
  if (!hits.length) {
    const needle = q.toLowerCase()
    hits = all.filter((r) => `${r.suite} ${r.name}`.toLowerCase().includes(needle))
  }
  if (!hits.length) throw new Error(`no test matches "${q}"`)
  if (hits.length > 1) {
    // Prefer the failing one when a name is shared across retries — that is
    // nearly always what "the test" means during triage.
    const bad = hits.filter((r) => BAD.has(r.status))
    if (bad.length === 1) return loadTest(dir, bad[0].id)
    const lines = hits.slice(0, 12).map((r) => `  ${r.id.slice(0, 8)}  ${r.status.padEnd(7)} ${r.suite} > ${r.name}`)
    throw new Error(`"${q}" matches ${hits.length} tests, be more specific:\n${lines.join('\n')}`)
  }
  return loadTest(dir, hits[0].id)
}

/** A test's attachments resolved to files on disk. */
function attachmentsOf(dir, t) {
  const out = []
  const visit = (node) => {
    for (const a of node.attachments || []) {
      const l = a.link || a
      if (!l.id) continue
      out.push({
        name: l.name,
        type: l.contentType,
        ext: l.ext,
        size: l.contentLength,
        path: path.join(dir, 'data', 'attachments', l.id + (l.ext || '')),
        missing: Boolean(l.missed),
      })
    }
    for (const s of node.steps || []) visit(s)
  }
  visit(t)
  return out
}

const traceOf = (dir, t) => attachmentsOf(dir, t).find((a) => a.type === 'application/vnd.allure.playwright-trace') || null

/**
 * Every job of a pipeline, INCLUDING retried attempts.
 *
 * Without include_retried GitLab returns only the latest attempt per job, so a
 * shard that failed and then passed comes back green and the attempt that
 * carries the failure is silently absent.
 */
function pipelineJobs(pipeline) {
  const out = execFileSync(
    'glab',
    ['api', `projects/${PROJECT}/pipelines/${pipeline}/jobs?per_page=100&include_retried=true`],
    { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(out.toString())
}

// --- service logs ------------------------------------------------------------

/**
 * The server-side logs the job captured, from `diagnostics.tar.gz`.
 *
 * This is where the 1_refresh-data root cause was: core logged
 *   "No specific TTL found for tag: 'url_hash' in env 'REDIS_TTL'. Defaulting to 300s."
 * on every hash write, and nothing in the Allure report pointed at it. The
 * test result only showed the symptom (a second refresh returning data).
 * So the logs are extracted once and joined to tests by time.
 *
 * Returns { name -> path } for service-logs-* files, e.g. { core, org, webapp }.
 */
function serviceLogs(job) {
  const root = path.join(jobDir(job), 'extracted')
  const tgz = path.join(root, 'diagnostics.tar.gz')
  const out = path.join(root, 'diag')
  if (!fs.existsSync(path.join(out, 'diagnostics')) && fs.existsSync(tgz)) {
    fs.mkdirSync(out, { recursive: true })
    execFileSync('tar', ['xzf', tgz, '-C', out], { stdio: ['ignore', 'ignore', 'pipe'] })
  }
  const found = {}
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^service-logs-/.test(path.basename(d)) && e.name.endsWith('.log')) {
        found[e.name.replace(/\.log$/, '')] = p
      }
    }
  }
  walk(out)
  return found
}

/** Other diagnostics files worth knowing exist (container state, db dumps). */
function diagnosticsFiles(job) {
  const d = path.join(jobDir(job), 'extracted', 'diag', 'diagnostics')
  if (!fs.existsSync(d)) return []
  const out = []
  const walk = (x) => {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      const p = path.join(x, e.name)
      if (e.isDirectory()) walk(p)
      else out.push({ path: p, rel: path.relative(d, p), size: fs.statSync(p).size })
    }
  }
  walk(d)
  return out
}

// docker compose prefixes each line with "<container> | " then a nanosecond
// RFC3339 stamp; strapi then adds its own [yy-mm-dd hh:mm:ss] and a coloured level.
const LOG_LINE = /^(\S+)\s+\|\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

/** Parse a service log into { t (epoch ms), level, msg } rows. */
function readLog(file) {
  const rows = []
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = raw.match(LOG_LINE)
    if (!m) continue
    const body = m[3].replace(ANSI, '')
    const lv = body.match(/\]\s*(silly|debug|verbose|http|info|warn|error)\s*:/i) || body.match(/\b(WARN|ERROR|INFO|DEBUG)\b/)
    rows.push({
      t: Date.parse(m[2]),
      level: lv ? lv[1].toLowerCase() : '',
      msg: body.replace(/^\[\d{2}-\d{2}-\d{2} [\d:]+\]\s*/, '').replace(/^(silly|debug|verbose|http|info|warn|error)\s*:\s*/i, ''),
    })
  }
  return rows
}

/**
 * Distinct warn/error messages, counted — the fastest read of what a server
 * was complaining about all run. Numbers and hex ids are normalised out so a
 * message that differs only by an id counts as one.
 */
function logDigest(rows, { levels = ['warn', 'error'] } = {}) {
  const groups = new Map()
  for (const r of rows) {
    if (!levels.includes(r.level)) continue
    // Model names and routes vary per line and would make every message its
    // own group (3,448 groups from 9,253 lines on a real shard). Quoted tokens
    // are deliberately KEPT: 'url_hash' vs 'protocol' in the TTL warning is
    // exactly the distinction that found the root cause.
    const key = r.msg
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
      .replace(/\b[0-9a-f]{24,}\b/gi, '<hex>')
      .replace(/api::[\w.-]+/g, 'api::<model>')
      .replace(/(modelName|model|content-type|endpoint)\s*:\s*[\w./:-]+/gi, '$1: <x>')
      .replace(/(^|[\s(])\/[\w{}:.-]+(\/[\w{}:.-]+)+/g, '$1<path>')
      .replace(/\b(lut|lut_)[\w-]+/gi, '<lut>')
      .replace(/\d+(\.\d+)?/g, 'N')
      .slice(0, 200)
    const g = groups.get(key) || { key, level: r.level, n: 0, first: r.t, last: r.t, sample: r.msg }
    g.n++
    g.last = r.t
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.n - a.n)
}

module.exports = {
  serviceLogs,
  diagnosticsFiles,
  readLog,
  logDigest,
  API,
  CACHE_ROOT,
  parseJob,
  parsePipeline,
  parseTestParam,
  isCached,
  ensureJob,
  allureDir,
  loadIndex,
  loadTest,
  listAll,
  resolveTest,
  attachmentsOf,
  traceOf,
  specOf,
  pipelineJobs,
  BAD,
}
