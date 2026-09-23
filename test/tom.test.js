// `cypress-inspect tom` — the Allure / Tom's-pipeline-reporter mode.
//
// Each test pins a behaviour that mattered while debugging a real CI failure
// (1_refresh-data.cy.js, pipeline 2873429626, job 16669680637). Fixtures are
// synthetic but shaped exactly like the real artifact, so the suite needs no
// cache and no network.

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { renderArg, renderArgs, compactUrl, queryParam } = require('../src/tom-fmt')
const store = require('../src/tom-store')
const trace = require('../src/tom-trace')
const { errorHead } = require('../src/tom-cli')

// --- arg rendering ---------------------------------------------------------

test('renderArg covers every { t, v } type a real shard produced', () => {
  // The seven types are the complete set across 77 traces / 3166 actions.
  assert.equal(renderArg({ t: 'string', v: '*' }), '"*"')
  assert.equal(renderArg({ t: 'primitive', v: 'true' }), 'true')
  assert.equal(renderArg({ t: 'function', v: 'saveCoverageObject' }), 'ƒ saveCoverageObject')
  assert.equal(renderArg({ t: 'jquery', v: 'jQuery(1)' }), 'jQuery(1)')
  assert.equal(renderArg({ t: 'node', v: '<div#q-app>' }), '<div#q-app>')
  assert.equal(
    renderArg({ t: 'object', v: [['url', { t: 'string', v: '*' }], ['middleware', { t: 'primitive', v: 'true' }]] }),
    '{url: "*", middleware: true}',
  )
  assert.equal(renderArg({ t: 'array', v: [{ t: 'primitive', v: '1' }, { t: 'primitive', v: '2' }] }), '[1, 2]')
})

test('an unknown arg type is shown by its tag, never dropped', () => {
  assert.match(renderArg({ t: 'bigint', v: '9' }), /^<bigint:/)
})

test('renderArg respects its character budget', () => {
  const huge = { t: 'string', v: 'x'.repeat(5000) }
  assert.ok(renderArg(huge, { budget: 50 }).length <= 51)
})

test('null args mean the byte budget spent them, which is not "no args"', () => {
  // read-trace.js keeps absent / null / array distinct; null must not render as empty.
  assert.match(renderArgs(null), /dropped/)
  assert.equal(renderArgs(undefined), '')
})

// --- URLs ------------------------------------------------------------------

const REFRESH_URL =
  'http://external-c5d495/api/plot-layouts?use-cache=false&project_ids[0]=1' +
  Array.from({ length: 62 }, (_, i) => `&prot_uuids[${i}]=00000000-0000-0000-0000-${String(i).padStart(12, '0')}`).join('') +
  '&hash=c3de41eb608dc687e91af19b99894769&api-version=v2'

test('compactUrl collapses repeated array params and keeps hash verbatim', () => {
  // The raw URL buried `hash=` — the one param that decides the response —
  // behind 62 prot_uuids. Two refreshes sending the SAME hash was the finding.
  const c = compactUrl(REFRESH_URL)
  assert.match(c, /prot_uuids\[…62\]/)
  assert.match(c, /hash=c3de41eb608dc687e91af19b99894769/)
  assert.ok(c.length < 200, `still ${c.length} chars`)
  assert.ok(!c.includes('external-c5d495'), 'the redacted host alias is noise')
})

test('queryParam reads one param for diffing two requests', () => {
  assert.equal(queryParam(REFRESH_URL, 'hash'), 'c3de41eb608dc687e91af19b99894769')
  assert.equal(queryParam('not a url', 'hash'), null)
})

// --- ids and URLs in, job / test out --------------------------------------

test('parseJob and parseTestParam read the reporter link the user pastes', () => {
  const link =
    'https://ternandsparrow.gitlab.io/paratoo-fdcp/toms-world-famous-paratoo-pipeline-report/' +
    '?pipeline=2873429626&job=16669680637&test=2fde0e88d2459e270fd78ba34ff13743'
  assert.equal(store.parseJob(link), '16669680637')
  assert.equal(store.parsePipeline(link), '2873429626')
  assert.equal(store.parseTestParam(link), '2fde0e88d2459e270fd78ba34ff13743')
  assert.equal(store.parseJob('https://gitlab.com/ternandsparrow/paratoo-fdcp/-/jobs/16669680637'), '16669680637')
  assert.equal(store.parseJob('16669680637'), '16669680637')
})

// --- DOM snapshots ---------------------------------------------------------

test('back-references resolve against the earlier snapshot, in post-order', () => {
  // Playwright dedups a later snapshot as [[k, i]]: node i of the snapshot k
  // before it, indexed in POST-order (children before parent). A wrong index
  // produces a plausible but wrong DOM, silently.
  const s0 = { html: ['BODY', {}, ['P', { 'data-cy': 'a' }, 'hello'], ['SPAN', {}, 'x']] }
  // post-order of s0: 'hello'(0) P(1) 'x'(2) SPAN(3) BODY(4)
  const s1 = { html: ['BODY', {}, [[1, 1]], ['I', {}, 'new']] }
  const resolved = trace._resolveTree([s0, s1], 1)
  assert.deepEqual(resolved, ['BODY', {}, ['P', { 'data-cy': 'a' }, 'hello'], ['I', {}, 'new']])
  // and a nested reference resolves through its own snapshot's history
  const s2 = { html: ['BODY', {}, [[2, 3]]] } // 2 back = s0, node 3 = SPAN
  assert.deepEqual(trace._resolveTree([s0, s1, s2], 2), ['BODY', {}, ['SPAN', {}, 'x']])
})

test('an out-of-range back-reference is marked, not guessed', () => {
  const s0 = { html: ['BODY', {}] }
  const s1 = { html: ['BODY', {}, [[5, 0]]] }
  assert.deepEqual(trace._resolveTree([s0, s1], 1), ['BODY', {}, '[unresolved ref]'])
})

test('find labels a TEXT match so it is never read as the selector being present', () => {
  // The near-miss: "Kitchen Sink TEST Project" matched p[data-cy=currentProject]
  // by its text, on a page where Cypress had correctly found no
  // [data-cy="Kitchen Sink TEST Project"]. Unlabelled, that reads as the
  // opposite of the truth.
  const tree = ['BODY', {}, ['P', { 'data-cy': 'currentProject' }, 'Kitchen Sink TEST Project']]
  const bySelector = trace.find(tree, '[data-cy="Kitchen Sink TEST Project"]')
  assert.equal(bySelector.length, 0, 'the card selector really is absent')
  const byText = trace.find(tree, 'Kitchen Sink TEST Project')
  assert.equal(byText.length, 1)
  assert.match(byText[0].on, /TEXT only/)
})

test('find matches data-cy exactly when given the selector form', () => {
  const tree = ['BODY', {}, ['DIV', { 'data-cy': 'barcodeReaderDialog' }], ['DIV', { 'data-cy': 'barcodeReaderDialogX' }]]
  const hits = trace.find(tree, '[data-cy="barcodeReaderDialog"]')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].on, 'data-cy (exact)')
})

test('pageState answers "where was the app" from a snapshot', () => {
  const snap = {
    frameUrl: 'http://external-77e7a4/workflow/12',
    tree: ['BODY', {},
      ['DIV', { 'data-cy': 'protocolTitle' }, 'Floristics - Enhanced'],
      ['P', { 'data-cy': 'currentProject' }, 'Kitchen Sink TEST Project'],
      ['DIV', { 'data-cy': 'barcodeReaderDialog' }],
    ],
  }
  const st = trace.pageState(snap)
  assert.equal(st.url, '/workflow/12')
  assert.equal(st.protocol, 'Floristics - Enhanced')
  assert.equal(st.project, 'Kitchen Sink TEST Project')
  assert.deepEqual(st.dialogs, ['barcodeReaderDialog'])
})

test('toHtml inlines the stylesheet, rewrites url()s, drops scripts', () => {
  const assets = new Map([
    ['/__cypress_trace__/styles.css', { mime: 'text/css', css: 'body{background:url("/img/banner.jpg")}' }],
    ['/img/banner.jpg', { mime: 'image/jpeg', uri: 'data:image/jpeg;base64,AAAA' }],
  ])
  const tree = ['HTML', {}, ['HEAD', {}, ['LINK', { rel: 'stylesheet', href: 'http://external-x/__cypress_trace__/styles.css' }]],
    ['BODY', {}, ['SCRIPT', {}, 'alert(1)'], ['IMG', { src: 'http://external-x/img/banner.jpg' }]]]
  const html = trace.toHtml(tree, assets)
  assert.ok(!html.includes('alert(1)'), 'a snapshot must never run its scripts')
  assert.ok(!html.includes('<link'), 'the stylesheet is inlined, not linked')
  assert.match(html, /<style>body\{background:url\("data:image\/jpeg;base64,AAAA"\)\}<\/style>/)
  assert.match(html, /<img src="data:image\/jpeg;base64,AAAA">/)
})

// --- error heads -----------------------------------------------------------

test('errorHead summarises an embedded findings array instead of printing "["', () => {
  // The suite's custom assertions dump JSON after a colon; as a first line that
  // was a bare "Bad data found in …: [".
  const findings = [
    { model: 'plot-layout', reason: 'hash not nil' },
    { model: 'plot-layout', reason: 'data not empty' },
    { model: 'plot-visit', reason: 'hash not nil' },
  ]
  const t = { error: { message: `Bad data found in second prepare for offline's response: ${JSON.stringify(findings, null, 2)}\n\n--- CASCADE ORIGIN ---` } }
  const head = errorHead(t)
  assert.match(head, /3 findings/)
  assert.match(head, /2 models/)
  assert.match(head, /"hash not nil" ×2/)
  assert.ok(!/:\s*\[\s*$/.test(head))
})

test('errorHead falls back to the first line for an ordinary error', () => {
  assert.equal(errorHead({ error: { message: 'Timed out retrying after 60000ms\nmore' } }), 'Timed out retrying after 60000ms')
})

// --- service logs ----------------------------------------------------------

test('readLog parses docker-compose + strapi lines, and logDigest groups them', () => {
  // The root cause lived here: core warned on every hash write that url_hash
  // had no TTL and was defaulting to 300s.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-log-'))
  const f = path.join(dir, 'core.log')
  const line = (ts, lvl, msg) => `paratoo_p1_core_test  | ${ts}  [26-09-23 02:44:02] \x1b[33m${lvl}\x1b[39m : ${msg}`
  fs.writeFileSync(f, [
    line('2026-09-23T02:44:02.280918102Z', 'warn', "No specific TTL found for tag: 'url_hash' in env 'REDIS_TTL'. Defaulting to 300s."),
    line('2026-09-23T02:44:09.277020681Z', 'warn', "No specific TTL found for tag: 'url_hash' in env 'REDIS_TTL'. Defaulting to 300s."),
    line('2026-09-23T02:44:10.000000000Z', 'info', 'Checking permissions for endpoint: /plot-layouts'),
    'a line docker did not prefix',
  ].join('\n'))
  const rows = store.readLog(f)
  assert.equal(rows.length, 3, 'unprefixed lines are skipped')
  assert.equal(rows[0].level, 'warn')
  assert.ok(!rows[0].msg.includes('\x1b'), 'ANSI stripped')
  assert.equal(rows[0].t, Date.parse('2026-09-23T02:44:02.280Z'))
  const digest = store.logDigest(rows)
  assert.equal(digest.length, 1, 'info is excluded by default; the two warns are one message')
  assert.equal(digest[0].n, 2)
  assert.match(digest[0].sample, /url_hash/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('logDigest normalises ids and numbers so one message counts once', () => {
  const rows = [
    { t: 1, level: 'warn', msg: 'Could not find existing record at index: 1, falling back to create.' },
    { t: 2, level: 'warn', msg: 'Could not find existing record at index: 27, falling back to create.' },
  ]
  assert.equal(store.logDigest(rows).length, 1)
})
