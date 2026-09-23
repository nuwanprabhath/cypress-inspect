// `cypress-inspect tom` — debug a CI Cypress failure from the Allure artifacts
// Tom's pipeline reporter leaves behind (feat/allure-core + feat/allure-viewer).
//
// A CLI rather than MCP tools, on purpose: every command reads local files and
// reloads on each run, so the tool can be changed mid-investigation and the
// next command uses the change. MCP tools only reload on server reconnect.
//
// Fully isolated from `open` / `run` / `cloud`: own modules (tom-*.js), own
// cache (~/.cypress-inspect/tom-cache), no browser, no session file.

const fs = require('fs')
const path = require('path')
const store = require('./tom-store')
const trace = require('./tom-trace')
const { renderArgs, clock, dur, size, rel, compactUrl } = require('./tom-fmt')

const LAST = () => path.join(store.CACHE_ROOT, 'LAST')
const REPORTER = 'https://ternandsparrow.gitlab.io/paratoo-fdcp/toms-world-famous-paratoo-pipeline-report/'

// --- args ------------------------------------------------------------------

function parse(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      if (v !== undefined) flags[k] = v
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else pos.push(a)
  }
  // The job is whichever positional parses as one (a bare id, or any URL
  // carrying /jobs/N or job=N). Remaining positionals keep their order.
  let job = flags.job ? store.parseJob(flags.job) : null
  let testFromUrl = null
  const rest = []
  for (const p of pos) {
    const j = !job && store.parseJob(p)
    if (j) {
      job = j
      testFromUrl = store.parseTestParam(p)
    } else rest.push(p)
  }
  return { job, rest, flags, testFromUrl }
}

/**
 * The job to use: the one passed, else the one remembered from the last run.
 *
 * Both cases are announced on stderr (stdout stays clean for piping). Passing
 * a job to ONE command also makes it the default for the NEXT, and silently
 * that bit during triage: a comparison against an older job switched the
 * default, and the next lookup ran against the wrong artifact and reported
 * "no test matches" for a test that was right there in the intended job.
 */
function jobOrLast(job) {
  const prev = fs.existsSync(LAST()) ? fs.readFileSync(LAST(), 'utf8').trim() : null
  if (job) {
    fs.mkdirSync(store.CACHE_ROOT, { recursive: true })
    fs.writeFileSync(LAST(), String(job))
    if (prev && prev !== String(job)) process.stderr.write(`job ${job}   (remembered job changed: ${prev} → ${job})\n`)
    return String(job)
  }
  if (prev) {
    process.stderr.write(`job ${prev}   (remembered from the last command; pass a job id or URL to change it)\n`)
    return prev
  }
  throw new Error('no job: pass a job id or a reporter/GitLab URL once, then it is remembered')
}

const out = (s = '') => process.stdout.write(s + '\n')
const statusMark = (s) => ({ failed: '✗', broken: '!', passed: '✓', skipped: '·' })[s] || '?'

// --- helpers shared by commands --------------------------------------------

function openJob(args) {
  const job = jobOrLast(args.job)
  const dir = store.ensureJob(job, { refresh: Boolean(args.flags.refresh), log: (m) => process.stderr.write(m + '\n') })
  return { job, dir }
}

function pickTest(dir, args, at = 0) {
  const q = args.testFromUrl || args.rest[at]
  return store.resolveTest(dir, q)
}

async function traceFor(dir, t) {
  const a = store.traceOf(dir, t)
  if (!a) throw new Error(`test ${t.id.slice(0, 8)} has no trace attachment (only failing/broken tests usually carry one)`)
  if (!fs.existsSync(a.path)) throw new Error(`trace attachment missing on disk: ${a.path}`)
  return { att: a, data: await trace.decode(a.path) }
}

/**
 * The first useful line of an error. Custom assertions in this suite dump a
 * JSON array of findings after a colon ("Bad data found in …: [ {model,
 * reason}, … ]"), which as a first line reads as a bare "[" — so an embedded
 * array is parsed and summarised by its most common fields instead.
 */
function errorHead(t, lines = 1) {
  const msg = t.error?.message || ''
  const at = msg.search(/:\s*\[\s*\{/)
  if (at > 0) {
    const lead = msg.slice(0, at).trim()
    const end = msg.indexOf('\n]', at)
    try {
      const arr = JSON.parse(msg.slice(msg.indexOf('[', at), end > 0 ? end + 2 : undefined))
      if (Array.isArray(arr) && arr.length) {
        const count = (k) => {
          const m = new Map()
          for (const x of arr) if (x && x[k] != null) m.set(x[k], (m.get(x[k]) || 0) + 1)
          return [...m].sort((a, b) => b[1] - a[1])
        }
        const models = count('model')
        const reasons = count('reason')
        const bits = [`${arr.length} findings`]
        if (models.length) bits.push(`${models.length} models (${models.slice(0, 4).map(([k]) => k).join(', ')}${models.length > 4 ? ', …' : ''})`)
        if (reasons.length) bits.push(reasons.slice(0, 3).map(([k, n]) => `"${k}" ×${n}`).join(', '))
        return `${lead}: ${bits.join('; ')}`
      }
    } catch {}
  }
  return msg.split('\n').filter((l) => l.trim()).slice(0, lines).join(' ⏎ ')
}


/**
 * Screenshot a standalone HTML file in a throwaway headless Chrome, over CDP.
 *
 * NOT Chrome's one-shot `--screenshot` flag: that captures independently of
 * script-driven scrolling, so on any scrolled frame every `position: fixed`
 * element (this app's header, its dialogs) lands at its document offset over a
 * blank page. Found by rendering a stable frame at scroll 693 and seeing the
 * header 693px down. Scrolled frames are the common case, so this scrolls
 * first and then captures the viewport the way Playwright and Puppeteer do.
 *
 * A fresh --user-data-dir every time, so a browser the user already has open
 * is never handed the job.
 */
async function screenshotHtml(htmlPath, pngPath, { width = 768, height = 1024, scrollTop = 0 } = {}) {
  const os = require('os')
  const { spawn } = require('child_process')
  const CDP = require('chrome-remote-interface')
  const { findChrome } = require('./cloud-launcher')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-render-'))
  const chrome = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    // --remote-debugging-port=0 picks a free port and writes it here.
    const portFile = path.join(profile, 'DevToolsActivePort')
    const t0 = Date.now()
    while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').includes('\n')) {
      if (Date.now() - t0 > 20000) throw new Error('headless Chrome did not start within 20s')
      await new Promise((r) => setTimeout(r, 50))
    }
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0])
    const client = await CDP({ port })
    try {
      const { Page, Runtime, Emulation } = client
      await Page.enable()
      await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false })
      const loaded = Page.loadEventFired()
      await Page.navigate({ url: 'file://' + htmlPath })
      await loaded
      // fonts are inlined data: URIs; wait for them so text is not drawn in a fallback face
      await Runtime.evaluate({ expression: 'document.fonts ? document.fonts.ready.then(() => 1) : 1', awaitPromise: true })
      if (scrollTop) await Runtime.evaluate({ expression: `scrollTo(0, ${Number(scrollTop)})` })
      // two frames, so layout settles after the scroll before the capture
      await Runtime.evaluate({ expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true })
      const { data } = await Page.captureScreenshot({ format: 'png' })
      fs.writeFileSync(pngPath, Buffer.from(data, 'base64'))
    } finally {
      await client.close()
    }
  } finally {
    chrome.kill('SIGKILL')
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

// --- commands --------------------------------------------------------------

const commands = {}

commands.fetch = async (args) => {
  const job = jobOrLast(args.job)
  const dir = store.ensureJob(job, { refresh: true, log: (m) => process.stderr.write(m + '\n') })
  out(`cached: ${dir}`)
}

/** The first thing to run: counts, then every failure in execution order. */
commands.summary = async (args) => {
  const { job, dir } = openJob(args)
  const all = store.listAll(dir)
  const by = {}
  for (const r of all) by[r.status] = (by[r.status] || 0) + 1
  const bad = all.filter((r) => store.BAD.has(r.status))
  const retries = all.filter((r) => r.isRetry).length
  out(`job ${job}   ${all.length - retries} tests${retries ? ` + ${retries} retry attempts` : ''}   ` + Object.entries(by).map(([k, v]) => `${k} ${v}`).join('  '))
  if (retries) out(`          (counts include retry attempts; the report's own statistic counts each test once)`)
  out(`reporter  ${REPORTER}?job=${job}`)
  if (!bad.length) return out('\nno failed or broken tests. A red shard with none broke OUTSIDE a test: read the job log.')
  out(`\n${bad.length} failing, in EXECUTION order (the first is usually the cause, later ones often cascades):\n`)
  const t0 = bad[0].start
  bad.forEach((r, i) => {
    const t = store.loadTest(dir, r.id)
    out(`${String(i + 1).padStart(2)}. ${statusMark(r.status)} ${r.status.padEnd(6)} ${rel(r.start, t0)}  ${r.id.slice(0, 8)}  ${dur(r.duration).padStart(6)}  ${r.spec?.split('/').pop()}`)
    out(`      ${r.suite} > ${r.name}${r.isRetry ? '   (retry attempt)' : ''}`)
    out(`      ${errorHead(t, 1).slice(0, 180)}`)
  })
  const logs = store.serviceLogs(job)
  if (logs.core) {
    const top = store.logDigest(store.readLog(logs.core)).slice(0, 4)
    if (top.length) {
      out(`\nloudest core warnings this run (tom log core --digest for all):`)
      top.forEach((g) => out(`  ${String(g.n).padStart(5)}×  ${g.level.padEnd(5)} ${g.sample.slice(0, 150)}`))
    }
  }
  out(`\nnext:  tom test <id>      tom timeline      tom where <id>      tom log core --at <id>`)
}

/** Tests in execution order, optionally filtered. */
commands.list = async (args) => {
  const { dir } = openJob(args)
  let rows = store.listAll(dir)
  if (args.flags.status) rows = rows.filter((r) => String(args.flags.status).split(',').includes(r.status))
  if (args.flags.spec) rows = rows.filter((r) => (r.spec || '').includes(args.flags.spec))
  if (args.flags.grep) {
    const re = new RegExp(args.flags.grep, 'i')
    rows = rows.filter((r) => re.test(`${r.suite} ${r.name}`))
  }
  const limit = Number(args.flags.limit || 200)
  rows.slice(0, limit).forEach((r) => out(`${statusMark(r.status)} ${r.id.slice(0, 8)} ${dur(r.duration).padStart(6)}  ${(r.spec || '').split('/').pop()} :: ${r.suite} > ${r.name}`))
  if (rows.length > limit) out(`… ${rows.length - limit} more (--limit)`)
}

/**
 * The failures around one spec, in time order, with the passing tests between
 * them. This is the cascade view: with testIsolation off, a test that leaves
 * the app on the wrong page fails every test after it, and those later
 * failures carry an error that says nothing about why.
 */
commands.timeline = async (args) => {
  const { dir } = openJob(args)
  const all = store.listAll(dir)
  const bad = all.filter((r) => store.BAD.has(r.status))
  const specs = args.flags.spec ? [args.flags.spec] : [...new Set(bad.map((r) => r.spec))]
  for (const spec of specs) {
    const rows = all.filter((r) => (r.spec || '').includes(spec))
    if (!rows.length) continue
    out(`\n${spec}   (${rows.length} results)`)
    const t0 = rows[0].start
    let firstBad = true
    for (const r of rows) {
      const isBad = store.BAD.has(r.status)
      const tag = isBad && firstBad ? '  ◀ FIRST FAILURE' : isBad ? '  ◀ after the first failure' : ''
      if (isBad) firstBad = false
      if (r.status === 'skipped' && !args.flags.skipped) continue
      out(`  ${statusMark(r.status)} ${rel(r.start, t0)} ${dur(r.duration).padStart(6)}  ${r.id.slice(0, 8)}  ${r.suite} > ${r.name}${tag}`)
    }
    const skipped = rows.filter((r) => r.status === 'skipped').length
    if (skipped && !args.flags.skipped) out(`  · ${skipped} skipped (--skipped to show)`)
  }
}

/** One test's result: error in full, attachments, and where to look next. */
commands.test = async (args) => {
  const { job, dir } = openJob(args)
  const t = pickTest(dir, args)
  out(`${statusMark(t.status)} ${t.status}   ${t.id}`)
  out(`spec    ${store.specOf(t)}`)
  out(`test    ${(t.labels || []).find((l) => l.name === 'parentSuite')?.value || ''} > ${t.name}`)
  out(`time    ${clock(t.start)} → ${clock(t.stop)}   ${dur(t.duration)}${t.isRetry ? '   RETRY ATTEMPT' : ''}${t.retriesCount ? `   retries: ${t.retriesCount}` : ''}`)
  out(`page    ${REPORTER}?job=${job}&test=${t.id}`)
  if (t.error?.message) {
    out('\n--- error ---')
    out(t.error.message.trim())
  }
  const atts = store.attachmentsOf(dir, t)
  if (atts.length) {
    out('\n--- attachments ---')
    for (const a of atts) out(`  ${size(a.size).padStart(8)}  ${(a.type || '').replace('application/vnd.allure.', '')}  ${a.name}${a.missing ? '  (MISSING)' : ''}\n            ${a.path}`)
  }
  out(`\nnext:  tom steps ${t.id.slice(0, 8)}    tom console ${t.id.slice(0, 8)}    tom network ${t.id.slice(0, 8)}`)
}

/** The command log, one line per action. */
commands.steps = async (args) => {
  const { dir } = openJob(args)
  const t = pickTest(dir, args)
  const { data } = await traceFor(dir, t)
  const acts = data.actions
  const t0 = acts[0]?.start
  const failIdx = acts.findIndex((a) => a.failed)
  let from = 0
  let to = acts.length
  if (args.flags.around) {
    const c = args.flags.around === true ? failIdx : Number(args.flags.around)
    const w = Number(args.flags.window || 15)
    from = Math.max(0, c - w)
    to = Math.min(acts.length, c + w + 1)
  }
  out(`${t.name}   ${acts.length} actions${failIdx >= 0 ? `, first failure at #${failIdx}` : ''}   (■ = has its own DOM snapshot)`)
  if (acts.length && !args.flags.around && acts.length > 60) out(`tip: --around to centre on the failure`)
  for (let i = from; i < to; i++) {
    const a = acts[i]
    const mark = a.failed ? '✗' : ' '
    const snap = a.snapshot ? '■' : ' '
    const argTxt = args.flags.args === false ? '' : renderArgs(a.args, { depth: 2, budget: 110 })
    out(`${mark}${snap}${String(i).padStart(4)} ${rel(a.start, t0)} ${dur(a.stop - a.start).padStart(6)}  ${a.title}${argTxt ? '  ' + argTxt : ''}`)
    if (a.failed && a.error) out(`            └ ${a.error.name}: ${(a.error.message || '').split('\n')[0].slice(0, 160)}`)
  }
  out(`\nnext:  tom step ${t.id.slice(0, 8)} <n>    tom dom ${t.id.slice(0, 8)} <n>`)
}

/** Everything about one action: args, error, and the console + network inside its window. */
commands.step = async (args) => {
  const { dir } = openJob(args)
  const t = pickTest(dir, args)
  const n = Number(args.rest[1])
  const { att, data } = await traceFor(dir, t)
  const a = data.actions[n]
  if (!a) throw new Error(`no action #${n} (this trace has ${data.actions.length})`)
  const t0 = data.actions[0].start
  out(`#${n}  ${a.title}${a.failed ? '   ✗ FAILED' : ''}`)
  out(`at    ${clock(a.start)} (${rel(a.start, t0)})   took ${dur(a.stop - a.start)}`)
  if ('args' in a) out(`args  ${renderArgs(a.args, { depth: 6, budget: 4000 })}`)
  if (a.error) out(`error ${a.error.name}: ${a.error.message}`)
  // A small margin: a request a command causes can land a few ms after the
  // command's own window closes.
  const pad = Number(args.flags.pad || 250)
  const inWin = (x) => x >= a.start - pad && x <= a.stop + pad
  const con = data.console.filter((c) => inWin(c.time))
  const net = data.exchanges.filter((e) => inWin(e.start) || (e.start <= a.start && e.stop >= a.start))
  out(`\n--- console in window (${con.length}) ---`)
  con.forEach((c) => out(`  ${clock(c.time)} ${String(c.messageType).padEnd(5)} ${renderArgs(c.args, { depth: 2, budget: 220 })}`))
  out(`--- network in window (${net.length}) ---`)
  net.forEach((e) => out(`  ${clock(e.start)} ${e.response.status} ${e.request.method} ${compactUrl(e.request.url)}`))
  const snaps = await trace.snapshots(att.path)
  const { snap, how } = trace.snapshotFor(snaps, a)
  out(`--- DOM: ${how}${snap ? `   url ${snap.frameUrl}` : ''} ---`)
  if (snap) out(`  ${trace.dataCyOf(snap.tree).length} data-cy elements   → tom dom ${t.id.slice(0, 8)} ${n} --cy`)
}

commands.console = async (args) => {
  const { dir } = openJob(args)
  const t = pickTest(dir, args)
  const { data } = await traceFor(dir, t)
  let rows = data.console
  if (args.flags.level) rows = rows.filter((c) => String(args.flags.level).split(',').includes(c.messageType))
  if (args.flags.grep) {
    const re = new RegExp(args.flags.grep, 'i')
    rows = rows.filter((c) => re.test(renderArgs(c.args, { depth: 6, budget: 100000 })))
  }
  const budget = Number(args.flags.width || 300)
  const t0 = data.actions[0]?.start
  out(`${rows.length} of ${data.console.length} console lines`)
  rows.forEach((c) => out(`${rel(c.time, t0)} ${String(c.messageType).padEnd(5)} ${renderArgs(c.args, { depth: Number(args.flags.depth || 2), budget })}`))
}

commands.network = async (args) => {
  const { dir } = openJob(args)
  const t = pickTest(dir, args)
  const { data } = await traceFor(dir, t)
  let rows = data.exchanges
  if (args.flags.failed) rows = rows.filter((e) => !(e.response.status >= 200 && e.response.status < 400))
  if (args.flags.grep) {
    const re = new RegExp(args.flags.grep, 'i')
    rows = rows.filter((e) => re.test(`${e.request.method} ${e.request.url} ${e.response.status}`))
  }
  const t0 = data.actions[0]?.start
  out(`${rows.length} of ${data.exchanges.length} exchanges`)
  rows.forEach((e, i) => {
    const url = args.flags.raw ? e.request.url : compactUrl(e.request.url)
    const rsz = e.response.body ? ` ${size(e.response.body.size)}` : ''
    out(`${String(i).padStart(3)} ${rel(e.start, t0)} ${dur(e.stop - e.start).padStart(6)} ${String(e.response.status).padEnd(3)} ${e.request.method.padEnd(6)}${rsz.padStart(8)}  ${url}`)
    if (args.flags.body) {
      if (e.request.body?.value) out(`      req  ${e.request.body.value.slice(0, Number(args.flags.body) || 600)}`)
      if (e.response.body?.value) out(`      resp ${e.response.body.value.slice(0, Number(args.flags.body) || 600)}`)
    }
  })
}

/** The DOM at one step. */
commands.dom = async (args) => {
  const { dir } = openJob(args)
  const t = pickTest(dir, args)
  const n = args.rest[1] === undefined ? null : Number(args.rest[1])
  const { att, data } = await traceFor(dir, t)
  const idx = n === null ? data.actions.findIndex((a) => a.failed) : n
  const a = data.actions[idx]
  if (!a) throw new Error(`no action #${idx}`)
  const snaps = await trace.snapshots(att.path)
  const { snap, how } = trace.snapshotFor(snaps, a)
  out(`#${idx} ${a.title}   DOM: ${how}`)
  if (!snap) return
  out(`url ${snap.frameUrl}`)
  if (args.flags.find) {
    const hits = trace.find(snap.tree, String(args.flags.find))
    out(`\nfind "${args.flags.find}": ${hits.length} match${hits.length === 1 ? '' : 'es'}`)
    hits.slice(0, 40).forEach((h) => out(`  [${h.on}]  ${h.path}   ${JSON.stringify(h.text)}`))
    if (!hits.length && !/data-cy|^#/.test(String(args.flags.find))) out(`  (tip: for a "never found" error, query the exact selector, e.g. --find '[data-cy="x"]')`)
    return
  }
  if (args.flags.text) return out('\n' + trace.textOf(snap.tree))
  const lines = trace.outline(snap.tree, { onlyDataCy: Boolean(args.flags.cy), maxLines: Number(args.flags.lines || 250) })
  out('')
  lines.forEach((l) => out(l))
}

/**
 * Where the app was at a step — route, protocol, project, open dialogs — in
 * one line. Default step: the failing one. The first question for any
 * "never found" failure is whether the app was on the page the test assumed.
 */
commands.where = async (args) => {
  const { dir } = openJob(args)
  const t = pickTest(dir, args)
  const { att, data } = await traceFor(dir, t)
  const n = args.rest[1] === undefined ? data.actions.findIndex((a) => a.failed) : Number(args.rest[1])
  const a = data.actions[n >= 0 ? n : data.actions.length - 1]
  const snaps = await trace.snapshots(att.path)
  const { snap, how } = trace.snapshotFor(snaps, a)
  const st = trace.pageState(snap)
  out(`#${n} ${a.title}   (DOM: ${how})`)
  if (!st) return out('no DOM snapshot at or before this step')
  out(`url       ${st.url}`)
  if (st.protocol) out(`protocol  ${st.protocol}`)
  if (st.project) out(`project   ${st.project}`)
  if (st.plot) out(`plot      ${st.plot}`)
  if (st.visit) out(`visit     ${st.visit}`)
  out(`dialogs   ${st.dialogs.length ? st.dialogs.join(', ') : 'none open'}`)
  out(`data-cy   ${st.dataCyCount} elements   → tom dom ${t.id.slice(0, 8)} ${n} --cy`)
}

/**
 * A service log, joined to a test by time. `--at <test>` limits it to that
 * test's run window; `--digest` groups warnings/errors instead of listing
 * lines. This is the view that found the 1_refresh-data root cause.
 */
commands.log = async (args) => {
  const { job, dir } = openJob(args)
  const logs = store.serviceLogs(job)
  const which = args.rest[0] || 'core'
  if (!logs[which]) {
    const avail = Object.keys(logs)
    throw new Error(avail.length ? `no ${which} log; this job has: ${avail.join(', ')}` : 'this job captured no service logs (no diagnostics.tar.gz)')
  }
  let rows = store.readLog(logs[which])
  const day = rows[0] ? new Date(rows[0].t).toISOString().slice(0, 10) : null
  let win = ''
  if (args.flags.at) {
    const t = store.resolveTest(dir, args.flags.at)
    const pad = Number(args.flags.pad || 2000)
    rows = rows.filter((r) => r.t >= t.start - pad && r.t <= t.stop + pad)
    win = `   window: ${t.name} (${clock(t.start)}–${clock(t.stop)} local)`
  }
  if (args.flags.from && day) rows = rows.filter((r) => r.t >= Date.parse(`${day}T${args.flags.from}Z`))
  if (args.flags.to && day) rows = rows.filter((r) => r.t <= Date.parse(`${day}T${args.flags.to}Z`))
  if (args.flags.level) rows = rows.filter((r) => String(args.flags.level).split(',').includes(r.level))
  if (args.flags.grep) {
    const re = new RegExp(args.flags.grep, 'i')
    rows = rows.filter((r) => re.test(r.msg))
  }
  if (args.flags.digest) {
    const levels = args.flags.level ? String(args.flags.level).split(',') : ['warn', 'error']
    const groups = store.logDigest(rows, { levels })
    out(`${which}.log  ${groups.length} distinct ${levels.join('/')} messages${win}   (times UTC)`)
    const top = args.flags.all ? groups.length : Number(args.flags.top || 30)
    groups.slice(0, top).forEach((g) => out(`${String(g.n).padStart(6)}×  ${g.level.padEnd(5)} ${new Date(g.first).toISOString().slice(11, 19)}–${new Date(g.last).toISOString().slice(11, 19)}  ${g.sample.slice(0, 160)}`))
    if (groups.length > top) out(`… ${groups.length - top} rarer messages (--top N, or --all)`)
    return
  }
  const limit = Number(args.flags.limit || 200)
  out(`${which}.log  ${rows.length} lines${win}   (times UTC)`)
  rows.slice(0, limit).forEach((r) => out(`${new Date(r.t).toISOString().slice(11, 23)} ${r.level.padEnd(5)} ${r.msg.slice(0, Number(args.flags.width || 220))}`))
  if (rows.length > limit) out(`… ${rows.length - limit} more (--limit, --grep, --digest)`)
}

/**
 * Two tests' network, paired by endpoint. For a "same action, different
 * outcome" failure this is the answer in one screen: the 1_refresh-data bug
 * was two refreshes sending the SAME `hash=` and getting 6 kB vs 100 kB back.
 * Pairs by method + path (query ignored), in order, and flags every column
 * that differs.
 */
commands.diff = async (args) => {
  const { dir } = openJob(args)
  const [qa, qb] = args.rest
  if (!qa || !qb) throw new Error('usage: tom diff <testA> <testB> [--grep re] [--all]')
  const A = store.resolveTest(dir, qa)
  const B = store.resolveTest(dir, qb)
  const da = (await traceFor(dir, A)).data
  const db = (await traceFor(dir, B)).data
  const keyOf = (e) => {
    try {
      return `${e.request.method} ${new URL(e.request.url).pathname}`
    } catch {
      return `${e.request.method} ${e.request.url}`
    }
  }
  const group = (xs) => {
    const m = new Map()
    for (const e of xs) {
      const k = keyOf(e)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(e)
    }
    return m
  }
  const ga = group(da.exchanges)
  const gb = group(db.exchanges)
  const re = args.flags.grep ? new RegExp(args.flags.grep, 'i') : null
  const hashOf = (e) => {
    try {
      return new URL(e.request.url).searchParams.get('hash')
    } catch {
      return null
    }
  }
  out(`A ${A.id.slice(0, 8)} ${A.name}  (${da.exchanges.length} exchanges)`)
  out(`B ${B.id.slice(0, 8)} ${B.name}  (${db.exchanges.length} exchanges)\n`)
  let shown = 0
  for (const k of [...new Set([...ga.keys(), ...gb.keys()])]) {
    if (re && !re.test(k)) continue
    const xa = ga.get(k) || []
    const xb = gb.get(k) || []
    for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
      const a = xa[i]
      const b = xb[i]
      const sa = a?.response.body?.size
      const sb = b?.response.body?.size
      const diffs = []
      if (!a || !b) diffs.push(!a ? 'only in B' : 'only in A')
      else {
        if (a.response.status !== b.response.status) diffs.push(`status ${a.response.status}→${b.response.status}`)
        if (hashOf(a) !== hashOf(b)) diffs.push('hash sent differs')
        if (Number.isFinite(sa) && Number.isFinite(sb) && Math.abs(sa - sb) > Math.max(2048, 0.25 * Math.min(sa, sb))) diffs.push(`body ${size(sa)}→${size(sb)}`)
        if (b.response.body?.truncated && !a.response.body?.truncated) diffs.push('B body TRUNCATED')
      }
      if (!diffs.length && !args.flags.all) continue
      shown++
      const h = hashOf(a || b)
      const same = a && b && hashOf(a) === hashOf(b)
      out(`${diffs.length ? '≠' : '='} ${k}${h ? `   hash=${h.slice(0, 10)}${same ? ' (SAME in both)' : ''}` : ''}`)
      out(`    A ${a ? `${a.response.status} ${size(sa)}` : '—'}      B ${b ? `${b.response.status} ${size(sb)}` : '—'}      ${diffs.join(', ')}`)
    }
  }
  if (!shown) out(args.flags.all ? 'no exchanges' : 'no differences (--all to list identical pairs)')
}

/**
 * Render the DOM at a step to a PNG, offline, from the trace alone.
 *
 * The trace carries its own stylesheet, fonts and images (resources/<sha1>), so
 * the snapshot is serialised to standalone HTML with every asset inlined and
 * screenshotted by a throwaway headless Chrome. No web reporter, no network,
 * and it works on a cached artifact after the job's own has expired.
 *
 * The one thing text views cannot show is geometry — an overlay covering a
 * button, a dialog mid-animation — which is exactly what a rendered frame is for.
 */
commands.render = async (args) => {
  const { job, dir } = openJob(args)
  const t = pickTest(dir, args)
  const { att, data } = await traceFor(dir, t)
  const n = args.rest[1] === undefined ? data.actions.findIndex((a) => a.failed) : Number(args.rest[1])
  const a = data.actions[n]
  if (!a) throw new Error(`no action #${n}`)
  const snaps = await trace.snapshots(att.path)
  const { snap, how } = trace.snapshotFor(snaps, a)
  if (!snap) throw new Error(`#${n}: no DOM snapshot at or before this step`)
  const assets = await trace.assetsOf(att.path)
  const html = trace.toHtml(snap.tree, assets, { scrollTop: snap.scrollTop })
  const outDir = path.join(store.CACHE_ROOT, String(job), 'renders')
  fs.mkdirSync(outDir, { recursive: true })
  const base = path.join(outDir, `${t.id.slice(0, 8)}-${String(n).padStart(4, '0')}`)
  fs.writeFileSync(base + '.html', html)
  const png = args.flags.out ? path.resolve(String(args.flags.out)) : base + '.png'
  const vw = snap.viewport?.width || 768
  const vh = snap.viewport?.height || 1024
  await screenshotHtml(base + '.html', png, { width: vw, height: vh, scrollTop: snap.scrollTop })
  const st = trace.pageState(snap)
  // Frames caught mid-transition (a dialog opening/closing) freeze one instant
  // of a JS-driven animation, so they can differ slightly from what a live
  // browser drew. Flagged so a picture is not over-trusted; the DOM views
  // (tom where / tom dom) are exact either way.
  const transitional = []
  const scan = (x) => {
    if (!Array.isArray(x) || typeof x[0] !== 'string') return
    const c = String((x[1] || {}).class || '')
    if (/-(enter|leave)-active\b/.test(c)) transitional.push(c.match(/q-transition--[\w-]+-(enter|leave)-active/)?.[0] || 'transition')
    for (let i = 2; i < x.length; i++) scan(x[i])
  }
  scan(snap.tree)
  out(`#${n} ${a.title}   (DOM: ${how})`)
  if (transitional.length) out(`note  frame is mid-transition (${[...new Set(transitional)].join(', ')}); the DOM views are exact, the picture is one frozen instant`)
  out(`page  ${st?.url}${st?.protocol ? '   ' + st.protocol : ''}${st?.dialogs.length ? '   dialogs: ' + st.dialogs.join(', ') : ''}`)
  out(`size  ${vw}×${vh}${snap.scrollTop ? `, scrolled ${snap.scrollTop}px` : ''}   assets inlined: ${assets.size}`)
  out(png)
}

/** Screenshot paths — view them with any image reader. */
commands.shot = async (args) => {
  const { dir } = openJob(args)
  const t = pickTest(dir, args)
  const shots = store.attachmentsOf(dir, t).filter((a) => /^image\//.test(a.type || ''))
  if (!shots.length) return out('no screenshots on this test')
  shots.forEach((s) => out(s.path))
}

/** A pipeline's jobs, INCLUDING retried attempts, with their status. */
commands.jobs = async (args) => {
  const p = store.parsePipeline(args.rest[0] || args.flags.pipeline)
  if (!p) throw new Error('usage: tom jobs <pipeline id or url>')
  const jobs = store.pipelineJobs(p)
  jobs.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
  for (const j of jobs) {
    const cached = store.isCached(j.id) ? ' [cached]' : ''
    out(`${String(j.id).padEnd(12)} ${j.status.padEnd(9)} ${String(j.duration ? dur(j.duration * 1000) : '-').padStart(7)}  ${j.name}${j.retried ? '   (retried)' : ''}${j.failure_reason && j.status === 'failed' ? `   ${j.failure_reason}` : ''}${cached}`)
  }
}

function help() {
  out(`cypress-inspect tom — debug a CI Cypress failure from Tom's Allure pipeline reporter

Reads the job artifact directly (allure/ JSON + Playwright-format trace zips).
No browser. The job is remembered after the first command, so it is optional
afterwards. <test> is a test id, id prefix, name substring, or a reporter URL.

  tom summary [job|url]          counts + every failure in EXECUTION order
  tom timeline [--spec x]        failures in context: what passed between them (cascades)
  tom list [--status s] [--spec x] [--grep re]
  tom test <test>                full error, attachments, reporter link
  tom steps <test> [--around [n]] [--window 15]
  tom step <test> <n>            one action: args, error, console + network in its window
  tom console <test> [--level error,warn] [--grep re] [--width 300]
  tom network <test> [--failed] [--grep re] [--body [n]]
  tom dom <test> [n] [--cy] [--find q] [--text]   DOM at step n (default: the failing one)
  tom where <test> [n]           where the app was: route, protocol, project, open dialogs
  tom diff <testA> <testB>       network paired by endpoint; flags status / hash / body-size changes
  tom log [core|org|webapp] [--at <test>] [--digest] [--grep re] [--level warn,error]
                                 server logs from diagnostics.tar.gz, joined to a test by time
  tom render <test> [n] [--out f] render the DOM at step n to a PNG, offline (default: failing step)
  tom shot <test>                screenshot paths
  tom jobs <pipeline>            jobs incl. retried attempts
  tom fetch [job]                re-download the artifact

cache ${store.CACHE_ROOT}`)
}

async function runTom(argv) {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help') return help()
  const fn = commands[cmd]
  if (!fn) {
    help()
    throw new Error(`unknown tom command: ${cmd}`)
  }
  try {
    await fn(parse(rest))
  } finally {
    await trace.done()
  }
}

module.exports = { runTom, commands, parse, errorHead, jobOrLast }
