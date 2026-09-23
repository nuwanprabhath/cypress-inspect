// Trace layer for `cypress-inspect tom`.
//
// Two readers over one Playwright-format trace zip:
//
//   decode()     the action list, console and network, via the reporter's OWN
//                decoder (vendored in tom-vendor/, pinned). Reused rather than
//                rewritten because its comments are explicit that getting the
//                action sort wrong MISALIGNS rows instead of reordering them.
//
//   snapshots()  the DOM per command, which read-trace.js only flags the
//                presence of. Resolved here, including Playwright's
//                back-references, so a snapshot reads as a whole DOM.

const fs = require('fs')

let vendored = null
async function vendor() {
  if (!vendored) {
    const trace = await import('./tom-vendor/read-trace.js')
    const zip = await import('@zip.js/zip.js')
    vendored = { ...trace, zip }
  }
  return vendored
}

/** Release zip.js's worker pool, which otherwise holds the CLI open. */
async function done() {
  if (vendored) await vendored.terminateWorkers()
}

const decoded = new Map()
async function decode(zipPath) {
  if (!decoded.has(zipPath)) {
    const { readTrace } = await vendor()
    decoded.set(zipPath, await readTrace(fs.readFileSync(zipPath)))
  }
  return decoded.get(zipPath)
}

// --- DOM snapshots -------------------------------------------------------

const isRef = (n) => Array.isArray(n) && Array.isArray(n[0])
const isElem = (n) => Array.isArray(n) && typeof n[0] === 'string'

/**
 * Post-order node list of one snapshot, EXACTLY as Playwright's
 * snapshotRenderer builds it: children before their parent, text nodes
 * included, back-references excluded. A back-reference's nodeIndex points into
 * this list, so the traversal order is load-bearing.
 */
function nodesOf(snap) {
  if (!snap._nodes) {
    const nodes = []
    const visit = (n) => {
      if (typeof n === 'string') nodes.push(n)
      else if (isElem(n)) {
        for (let i = 2; i < n.length; i++) visit(n[i])
        nodes.push(n)
      }
    }
    visit(snap.html)
    snap._nodes = nodes
  }
  return snap._nodes
}

/**
 * Resolve every back-reference, producing a plain tree. `list` is the ordered
 * snapshot list for ONE frame and `idx` the snapshot being resolved, since a
 * reference is relative: `[[k, i]]` is node i of the snapshot k before this.
 */
function resolveTree(list, idx) {
  const walk = (n, at) => {
    if (typeof n === 'string') return n
    if (isRef(n)) {
      const target = at - n[0][0]
      if (target >= 0 && target <= at) {
        const nodes = nodesOf(list[target])
        const i = n[0][1]
        if (i >= 0 && i < nodes.length) return walk(nodes[i], target)
      }
      return '[unresolved ref]'
    }
    if (isElem(n)) {
      const out = [n[0], n[1] || {}]
      for (let i = 2; i < n.length; i++) out.push(walk(n[i], at))
      return out
    }
    return ''
  }
  return walk(list[idx].html, idx)
}

const snapCache = new Map()
/**
 * Every frame-snapshot in the trace, in event order, grouped per frame so
 * back-references resolve against the right history. Returns a flat list of
 * { callId, name, frameUrl, wallTime, tree }.
 */
async function snapshots(zipPath) {
  if (snapCache.has(zipPath)) return snapCache.get(zipPath)
  const { zip } = await vendor()
  const reader = new zip.ZipReader(new zip.Uint8ArrayReader(new Uint8Array(fs.readFileSync(zipPath))))
  const out = []
  try {
    const entry = (await reader.getEntries()).find((e) => e.filename === 'trace.trace')
    if (!entry) return out
    const perFrame = new Map()
    for (const line of (await entry.getData(new zip.TextWriter())).split('\n')) {
      if (!line) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.type !== 'frame-snapshot' || !ev.snapshot) continue
      const s = ev.snapshot
      const key = s.frameId || s.pageId || 'main'
      if (!perFrame.has(key)) perFrame.set(key, [])
      const list = perFrame.get(key)
      list.push(s)
      out.push({
        callId: s.callId,
        name: s.snapshotName,
        frameUrl: s.frameUrl,
        wallTime: s.wallTime,
        isMainFrame: s.isMainFrame,
        viewport: s.viewport,
        scrollTop: Number((isElem(s.html) && s.html[1] && s.html[1].__playwright_scroll_top_) || 0),
        // resolved lazily: most commands never ask for their DOM
        get tree() {
          return this._tree || (this._tree = resolveTree(list, list.indexOf(s)))
        },
      })
    }
  } finally {
    await reader.close()
  }
  snapCache.set(zipPath, out)
  return out
}

/**
 * The snapshot that shows a given action: its own `after`, else its `before`,
 * else the latest snapshot taken at or before the action ended. The last case
 * is the reporter's "carried" frame — a DOM-inert command shows the last real
 * DOM — and the result says which one it used.
 */
function snapshotFor(snaps, action) {
  const id = `call@${action.call}`
  const own = snaps.find((s) => s.name === `after@${id}`) || snaps.find((s) => s.name === `before@${id}`)
  if (own) return { snap: own, how: own.name.startsWith('after') ? 'own after' : 'own before' }
  let best = null
  for (const s of snaps) if (Number.isFinite(s.wallTime) && s.wallTime <= action.stop) best = s
  return best ? { snap: best, how: `carried from ${best.name}` } : { snap: null, how: 'no snapshot at or before this step' }
}

// --- views over a resolved tree -----------------------------------------

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'HEAD', 'LINK', 'META', 'BASE'])

/** Collapse whitespace in text. */
const squash = (s) => s.replace(/\s+/g, ' ').trim()

/**
 * An indented outline: tag, id, data-cy, and short text. The data-cy values
 * are the test suite's own selectors, so for a "never found" failure this is
 * the direct answer to "what WAS on the page".
 */
function outline(tree, { maxDepth = 40, maxLines = 400, onlyDataCy = false } = {}) {
  const lines = []
  const walk = (n, d) => {
    if (lines.length >= maxLines) return
    if (typeof n === 'string') return
    if (!isElem(n)) return
    const [tag, attrs] = n
    if (SKIP.has(tag)) return
    const cy = attrs['data-cy']
    const text = squash(
      n
        .slice(2)
        .filter((c) => typeof c === 'string')
        .join(' '),
    )
    const keep = onlyDataCy ? Boolean(cy) : Boolean(cy || attrs.id || text || d < 3)
    if (keep && d <= maxDepth) {
      const bits = [tag.toLowerCase()]
      if (attrs.id) bits.push('#' + attrs.id)
      if (cy) bits.push(`[data-cy="${cy}"]`)
      if (attrs.disabled != null || attrs['aria-disabled'] === 'true') bits.push('(disabled)')
      if (text) bits.push(JSON.stringify(text.length > 80 ? text.slice(0, 80) + '…' : text))
      lines.push('  '.repeat(onlyDataCy ? 0 : Math.min(d, 20)) + bits.join(' '))
    }
    for (let i = 2; i < n.length; i++) walk(n[i], d + 1)
  }
  walk(tree, 0)
  if (lines.length >= maxLines) lines.push(`… (truncated at ${maxLines} lines)`)
  return lines
}

/** All visible text, in document order. */
function textOf(tree) {
  const out = []
  const walk = (n) => {
    if (typeof n === 'string') {
      const s = squash(n)
      if (s) out.push(s)
      return
    }
    if (!isElem(n) || SKIP.has(n[0])) return
    for (let i = 2; i < n.length; i++) walk(n[i])
  }
  walk(tree)
  return out.join(' ')
}

/** Every element carrying data-cy, with its text. */
function dataCyOf(tree) {
  const out = []
  const walk = (n) => {
    if (!isElem(n) || SKIP.has(n[0])) return
    const cy = n[1]['data-cy']
    if (cy) out.push({ cy, tag: n[0].toLowerCase(), text: squash(textOf(n)).slice(0, 100) })
    for (let i = 2; i < n.length; i++) walk(n[i])
  }
  walk(tree)
  return out
}

/**
 * Elements matching a query, each labelled with WHAT it matched on.
 *
 *   [data-cy="x"]   exact data-cy attribute, the way Cypress means it
 *   #id             exact id
 *   anything else   exact data-cy, then data-cy substring, then exact text
 *
 * The label is load-bearing. A bare string used to match data-cy OR text
 * without saying which, and during the 1_refresh-data triage it reported
 * "Kitchen Sink TEST Project: 1 match" on a page where Cypress had correctly
 * found no `[data-cy="Kitchen Sink TEST Project"]` — the hit was the header
 * `p[data-cy="currentProject"]` whose TEXT is the project name. That reads as
 * "the element was there, Cypress is wrong" and is the opposite of the truth.
 * So a "never found" question must be asked with the selector form, and the
 * answer always says attribute or text.
 */
function find(tree, query) {
  const m = query.match(/data-cy\s*=\s*["']?([^"'\]]+)/)
  const cy = m ? m[1].replace(/\\/g, '') : null
  const id = !cy && query.startsWith('#') ? query.slice(1) : null
  const needle = query.toLowerCase()
  const out = []
  const walk = (n, trail) => {
    if (!isElem(n) || SKIP.has(n[0])) return
    const a = n[1]
    const here = [...trail, n[0].toLowerCase() + (a['data-cy'] ? `[data-cy="${a['data-cy']}"]` : '')]
    let on = null
    if (cy) on = a['data-cy'] === cy ? 'data-cy (exact)' : null
    else if (id) on = a.id === id ? 'id (exact)' : null
    else {
      const dcy = (a['data-cy'] || '').toLowerCase()
      if (dcy && dcy === needle) on = 'data-cy (exact)'
      else if (dcy && dcy.includes(needle)) on = 'data-cy (substring)'
      // The element's OWN text nodes, not its descendants': matching on
      // descendant text also hit every ancestor wrapper whose only content is
      // that one label, reporting <body> and each <div> around it. Caught by a
      // unit test, not by the live run, because <body> there held other text.
      else if (squash(n.slice(2).filter((c) => typeof c === 'string').join(' ')).toLowerCase() === needle) on = 'TEXT only — not a data-cy'
    }
    if (on) out.push({ on, tag: n[0].toLowerCase(), attrs: a, text: squash(textOf(n)).slice(0, 120), path: here.slice(-4).join(' > ') })
    for (let i = 2; i < n.length; i++) walk(n[i], here)
  }
  walk(tree, [])
  return out
}

/**
 * Where the app was: route, protocol, and any open dialog. Asked for every
 * failure during triage ("was it even on the right page?"), so it gets its own
 * one-line answer instead of an outline to read.
 */
function pageState(snap) {
  if (!snap) return null
  const cys = dataCyOf(snap.tree)
  const val = (k) => cys.find((c) => c.cy === k)?.text || null
  const dialogs = cys.filter((c) => /Dialog$|dialog/i.test(c.cy)).map((c) => c.cy)
  const url = (() => {
    try {
      return new URL(snap.frameUrl).pathname
    } catch {
      return snap.frameUrl
    }
  })()
  return {
    url,
    protocol: val('protocolTitle'),
    project: val('currentProject'),
    plot: val('currentPlot'),
    visit: val('currentVisit'),
    dialogs,
    dataCyCount: cys.length,
  }
}

// --- offline rendering -------------------------------------------------------

const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'])
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s) => escText(s).replace(/"/g, '&quot;')

/**
 * Every asset the frames requested, keyed by URL path, as a data: URI.
 *
 * The trace carries them itself: trace.network holds a resource-snapshot per
 * font / image / the one consolidated stylesheet, each pointing at
 * resources/<sha1>. Entries marked `_cypressExchange` are the test's own API
 * traffic, not page assets, and are skipped. Keyed by pathname because every
 * host in a CI trace is a redacted `external-xxxxxx` alias that resolves
 * nowhere.
 */
async function assetsOf(zipPath) {
  const { zip } = await vendor()
  const reader = new zip.ZipReader(new zip.Uint8ArrayReader(new Uint8Array(fs.readFileSync(zipPath))))
  const byPath = new Map()
  try {
    const entries = await reader.getEntries()
    const byName = new Map(entries.map((e) => [e.filename, e]))
    const net = byName.get('trace.network')
    if (!net) return byPath
    for (const line of (await net.getData(new zip.TextWriter())).split('\n')) {
      if (!line) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      const s = ev.snapshot
      if (!s || s._cypressExchange) continue
      const sha = s.response?.content?._sha1
      const mime = s.response?.content?.mimeType || 'application/octet-stream'
      const res = sha && byName.get(`resources/${sha}`)
      if (!res) continue
      let p
      try {
        p = new URL(s.request.url).pathname
      } catch {
        continue
      }
      if (mime.startsWith('text/css')) {
        byPath.set(p, { mime, css: await res.getData(new zip.TextWriter()) })
      } else {
        const bytes = await res.getData(new zip.Uint8ArrayWriter())
        byPath.set(p, { mime, uri: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` })
      }
    }
  } finally {
    await reader.close()
  }
  return byPath
}

/** Swap a URL for the trace's own copy of it, when the trace has one. */
function rewriteUrl(url, assets) {
  if (!url || url.startsWith('data:')) return url
  let p
  try {
    p = new URL(url, 'http://x').pathname
  } catch {
    return url
  }
  return assets.get(p)?.uri || url
}

/** Rewrite every `url(...)` in a stylesheet to the trace's data: copies. */
function rewriteCss(css, assets) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => `url("${rewriteUrl(u, assets)}")`)
}

/**
 * A resolved snapshot as standalone HTML: scripts dropped (nothing should run),
 * the stylesheet inlined with its url()s rewritten, every other asset a data:
 * URI, and the frame's own scroll position restored. The result renders with
 * no network access at all.
 */
function toHtml(tree, assets, { scrollTop = 0 } = {}) {
  const parts = []
  const walk = (n) => {
    if (typeof n === 'string') return parts.push(escText(n))
    if (!isElem(n)) return
    const [tag, attrs] = n
    if (tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'BASE') return
    if (tag === 'LINK' && /stylesheet/i.test(attrs.rel || '')) {
      let p = null
      try {
        p = new URL(attrs.href, 'http://x').pathname
      } catch {}
      const sheet = p && assets.get(p)
      if (sheet?.css) parts.push(`<style>${rewriteCss(sheet.css, assets)}</style>`)
      return
    }
    const lower = tag.toLowerCase()
    parts.push('<' + lower)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('__playwright')) continue
      let val = v
      if (k === 'src' || k === 'href' || k === 'poster') val = rewriteUrl(v, assets)
      else if (k === 'style') val = rewriteCss(String(v), assets)
      parts.push(` ${k}="${escAttr(val)}"`)
    }
    parts.push('>')
    if (VOID.has(tag)) return
    if (tag === 'STYLE') {
      for (let i = 2; i < n.length; i++) if (typeof n[i] === 'string') parts.push(rewriteCss(n[i], assets))
    } else for (let i = 2; i < n.length; i++) walk(n[i])
    parts.push(`</${lower}>`)
  }
  walk(tree)
  // A snapshot is one frozen instant, but the CSS still carries the
  // transitions and animations that were running at it. Rendered live they
  // replay from their start state — a Quasar dialog caught mid-`leave` draws
  // displaced — so they are switched off and every element draws where the
  // captured classes put it.
  const freeze = '<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>'
  const scroll = scrollTop ? `<script>addEventListener('load',()=>scrollTo(0,${Number(scrollTop)}))</script>` : ''
  return `<!doctype html>${parts.join('')}${freeze}${scroll}`
}

module.exports = { decode, done, snapshots, snapshotFor, outline, textOf, dataCyOf, find, pageState, assetsOf, toHtml, _resolveTree: resolveTree }
