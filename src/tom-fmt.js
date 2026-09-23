// Formatting for `cypress-inspect tom` — the Allure/"Tom's pipeline reporter"
// mode. Kept separate from every other mode's formatting on purpose: nothing
// here is shared with the local or cloud probes.

/**
 * Render one captured argument, in the reporter's typed `{ t, v }` encoding,
 * as a single compact line.
 *
 * The seven `t` values are every one that occurs across a full cypress-setup
 * shard (77 traces, 3166 actions, 2343 console lines, surveyed 2026-09-23):
 * string, primitive, object, array, function, jquery, node. Anything else is
 * rendered by its tag rather than dropped, so a new type shows up as
 * `<new-type:…>` instead of vanishing.
 *
 * `depth` bounds nesting and `budget` bounds total characters: a console line
 * can carry a whole Pinia store (`authStore:` + the store object), which is
 * useless at full length in a terminal.
 */
function renderArg(node, { depth = 3, budget = 400 } = {}) {
  let used = 0
  const clip = (s) => {
    if (used >= budget) return ''
    const room = budget - used
    const out = s.length > room ? s.slice(0, room) + '…' : s
    used += out.length
    return out
  }
  const walk = (n, d) => {
    if (n == null) return 'undefined'
    if (typeof n !== 'object' || !('t' in n)) return JSON.stringify(n)
    switch (n.t) {
      case 'string':
        return JSON.stringify(n.v)
      case 'primitive':
        return String(n.v)
      case 'function':
        return `ƒ ${n.v}`
      case 'jquery':
      case 'node':
        return String(n.v)
      case 'array': {
        if (d <= 0) return `[…${(n.v || []).length}]`
        return '[' + (n.v || []).map((x) => walk(x, d - 1)).join(', ') + ']'
      }
      case 'object': {
        const entries = n.v || []
        if (d <= 0) return `{…${entries.length}}`
        return '{' + entries.map(([k, v]) => `${k}: ${walk(v, d - 1)}`).join(', ') + '}'
      }
      default:
        return `<${n.t}:${JSON.stringify(n.v).slice(0, 40)}>`
    }
  }
  return clip(walk(node, depth))
}

/** A list of args, space-joined, the way a console line or command reads. */
function renderArgs(args, opts) {
  if (args === null) return '(args dropped: trace byte budget)'
  if (!Array.isArray(args)) return ''
  return args.map((a) => renderArg(a, opts)).join(' ')
}

/** Epoch ms → HH:MM:SS.mmm, local time. */
function clock(ms) {
  if (!Number.isFinite(ms)) return '--:--:--.---'
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** Milliseconds → a short human duration. */
function dur(ms) {
  if (!Number.isFinite(ms)) return '?'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  return `${m}m ${Math.round((ms % 60000) / 1000)}s`
}

/** Bytes → kB / MB. */
function size(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} kB`
}

/** Offset of `ms` from `origin`, as `+12.3s`. The trace reads best relative to its test's start. */
function rel(ms, origin) {
  if (!Number.isFinite(ms) || !Number.isFinite(origin)) return ''
  const d = ms - origin
  return (d < 0 ? '-' : '+') + (Math.abs(d) / 1000).toFixed(1).padStart(5) + 's'
}

/**
 * A URL made readable. This app's list endpoints carry 60+ repeated
 * `prot_uuids[n]=…` params ahead of the one that decides the response
 * (`hash=`), so a raw URL buries the evidence at the far end of a 3 kB line.
 *
 * Repeated `name[n]` params collapse to `name[…62]`; the host is dropped to its
 * path (every host here is a redacted `external-xxxxxx` alias anyway); and the
 * params that carry meaning are kept verbatim.
 */
const KEY_PARAMS = new Set(['hash', 'use-cache', 'api-version', 'populate', 'filters', 'page', 'pageSize', 'sort'])
function compactUrl(url, { keepHost = false } = {}) {
  let u
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const arrays = new Map()
  const plain = []
  for (const [k, v] of u.searchParams) {
    const m = k.match(/^([^[]+)\[\d+\]$/)
    if (m) {
      const a = arrays.get(m[1]) || { n: 0, first: v }
      a.n++
      arrays.set(m[1], a)
    } else plain.push([k, v])
  }
  const parts = []
  for (const [name, a] of arrays) parts.push(a.n === 1 ? `${name}[0]=${a.first}` : `${name}[…${a.n}]`)
  for (const [k, v] of plain) {
    if (KEY_PARAMS.has(k) || v.length <= 40) parts.push(`${k}=${v}`)
    else parts.push(`${k}=${v.slice(0, 12)}…`)
  }
  const base = (keepHost ? u.host : '') + u.pathname
  return parts.length ? `${base}?${parts.join('&')}` : base
}

/** Every value of one query param, so two requests can be diffed on it. */
function queryParam(url, name) {
  try {
    return new URL(url).searchParams.get(name)
  } catch {
    return null
  }
}

module.exports = { renderArg, renderArgs, clock, dur, size, rel, compactUrl, queryParam }
