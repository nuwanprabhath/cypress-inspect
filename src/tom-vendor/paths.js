// VENDORED from ternandsparrow/paratoo-fdcp @ feat/allure-viewer 420bffc8b4
//   paratoo-webapp/test-reporting/viewer/lib/paths.js
// Do not edit here: re-vendor with `cypress-inspect tom vendor` so this stays
// byte-identical to the decoder the pipeline reporter itself runs.

/**
 * Where everything in the report lives, spelled once.
 *
 * Three programs compute these paths: the plugin, which writes the files; the
 * trace page, which loads its zip and sidecars relative to itself; and the
 * fetcher, which asks a job artifact for the same files by name and rewrites a
 * shard's index to point at them. allure-flaky.js writes a fourth, the
 * per-test link into the report. They used to agree by having been typed the
 * same way in eight places, and a layout change in any one of them would have
 * surfaced as a silently blank viewer somewhere else.
 *
 * Two tables, for the two places a path can be spelled from.
 */

/** The plugin's own directory under the report root, and the Allure report's. */
export const TRACE_VIEWER = 'trace-viewer'
export const AWESOME = 'awesome'

/**
 * What is INSIDE a Playwright trace zip.
 *
 * Playwright's format, not ours: capture/plugin/pw-trace.js writes these names
 * because the bundled viewer reads them, and lib/read-trace.js reads them back.
 * Spelled here because a third reader now needs them too -- the pipeline
 * fetcher, deciding whether a dropped zip IS a trace -- and three copies of a
 * filename that belongs to somebody else is three places to miss.
 *
 * pw-trace.js does NOT import this: it is CommonJS, loaded by the Cypress
 * config under node. Its copy is the one to keep in step by hand.
 */
export const TRACE_ZIP = {
  /** JSONL: one context-options header, then before/after and frame-snapshot events. */
  events: 'trace.trace',
  /** JSONL: resource-snapshot events wrapping HAR entries. */
  network: 'trace.network',
  /** Ours, ridden along in the zip: the console lines and each action's arguments. */
  extra: 'cypress-extra.json',
  /** Bodies the snapshots reference, stored once under their sha1. */
  resources: 'resources/',
}

/**
 * Inside trace-viewer/. This is what the plugin writes, and it is what a trace
 * page loads against: the page shell carries <base href="../">, so a page at
 * test/<slug>.html (or the fetcher's copy at test/trace.html, one level down
 * for the same reason) resolves these against the directory above it.
 */
export const TRACE = {
  index: 'index.html',
  manifest: 'tests.json',
  data: (id) => `data/${id}.json`,
  /** Written only when some action carried arguments, so this can 404. */
  args: (id) => `data/${id}.args.json`,
  /**
   * The app's Pinia stores: the diff per action, the final state to replay
   * back from, and the environment samples. Written only when the trace was
   * captured by a run that recorded them, so this can 404 for an older trace
   * -- which the State pane reports as a different thing from "the stores
   * never changed". See app/trace.js.
   */
  state: (id) => `data/${id}.state.json`,
  page: (slug) => `test/${slug}.html`,
  /** The uuid page: a redirect stub kept so old links still resolve. */
  stub: (uuid) => `${uuid}.html`,
  /** Where the fetcher build puts the unparameterised shell: one level down, like a page. */
  shell: 'test/trace.html',
}

/** From inside trace-viewer/ back up to the report root. */
export const UP = '../'

/**
 * Where the report sits INSIDE a CI job's artifact, with its trailing slash.
 *
 * Not the report's own layout: this is the directory the pipeline copies it
 * into, decided by helper-scripts/ci/ci-cypress-after.sh and named in
 * .gitlab-ci.yml's `artifacts: paths`. Two programs prefix it -- the fetcher,
 * asking the artifact API for one file, and artifact-sw.js, matching the
 * requests it proxies -- and they are only correct while they agree.
 *
 * They did not. Renaming this directory meant editing fourteen string
 * literals in one file and five in another, and the aggregate's two match
 * patterns were missed: every merged widget silently fell through to one
 * shard's copy. Hence one name.
 */
export const ARTIFACT = 'allure/'

/**
 * From the report root. The fetcher prefixes each with `allure/` to name it
 * inside a job artifact; allure-flaky.js prefixes the published report's URL.
 *
 * `nested` is whether the awesome plugin wrote under `awesome/`, which only
 * happens when a config registers it alongside another plugin. This repo's
 * own local generate (test-reporting/report/allurerc.mjs) registers
 * `trace-viewer` too, so `plugin.mjs` always reads `nested = true` (the
 * default, unpassed). The collection branch that actually produces CI's
 * reports registers `awesome` alone, so the pipeline fetcher, reading THAT
 * output, passes `false` at every call.
 */
export const REPORT = {
  traceIndex: `${TRACE_VIEWER}/${TRACE.index}`,
  manifest: `${TRACE_VIEWER}/${TRACE.manifest}`,
  traceData: (id) => `${TRACE_VIEWER}/${TRACE.data(id)}`,
  traceArgs: (id) => `${TRACE_VIEWER}/${TRACE.args(id)}`,
  traceState: (id) => `${TRACE_VIEWER}/${TRACE.state(id)}`,
  tracePage: (slug) => `${TRACE_VIEWER}/${TRACE.page(slug)}`,
  traceStub: (uuid) => `${TRACE_VIEWER}/${TRACE.stub(uuid)}`,
  /** A viewer asset (viewer/, lib/ or app/) as the plugin wrote it. */
  asset: (file) => `${TRACE_VIEWER}/${file}`,
  allureIndex: (nested = true) => `${nested ? `${AWESOME}/` : ''}index.html`,
  /**
   * Allure's own copy of an attachment, which is the trace zip the page loads.
   * Its path comes from the attachment's id and ext at generate time, so a
   * layout change in the awesome plugin surfaces as a named missing file in
   * the trace page's diagnose() rather than as a silently blank viewer.
   */
  attachment: (id, ext, nested = true) => `${nested ? `${AWESOME}/` : ''}data/attachments/${id}${ext}`,
  /**
   * One of the awesome plugin's widget files.
   *
   * NONE OF THESE PATHS ARE OURS. The whole tree under AWESOME is written by
   * allure-core and its awesome plugin, at whatever version this repo has
   * installed, and this project runs no tests of its own to notice a change.
   * So every reader spells them through here, and a layout change surfaces as
   * ONE name to fix and as a named missing file at view time, rather than as
   * a pane that is silently blank or an archive classified as "not a report".
   */
  widget: (name, nested = true) => `${nested ? `${AWESOME}/` : ''}widgets/${name}.json`,
  /** 55 bytes, and the cheapest proof a report exists at all. */
  statistic: (nested = true) => REPORT.widget('statistic', nested),
  testResults: 'test-results.json',
  perTest: (nodeId, nested = true) => `${nested ? `${AWESOME}/` : ''}data/test-results/${nodeId}.json`,
  /** Everything above but the attachments, in one zip. helper-scripts/ci/report-pack.mjs writes it. */
  pack: 'report.zip',
}

/**
 * The asset paths a shard's index page links, as a pattern the fetcher can
 * find in generated markup: viewer/, lib/ and app/ files, optionally written
 * from one level down.
 */
export const ASSET_LINK = /(href|src)="(?:\.\.\/)?((?:viewer|lib|app)\/[\w.-]+\.(?:css|js))"/g
