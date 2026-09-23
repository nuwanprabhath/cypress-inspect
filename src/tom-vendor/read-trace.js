// VENDORED from ternandsparrow/paratoo-fdcp @ feat/allure-viewer 420bffc8b4
//   paratoo-webapp/test-reporting/viewer/lib/read-trace.js
// Do not edit here: re-vendor with `cypress-inspect tom vendor` so this stays
// byte-identical to the decoder the pipeline reporter itself runs.

/**
 * Reading a trace zip: the action windows, the console and the network rows
 * the trace page joins to the viewer's own selection.
 *
 * This is the expensive half of generating a report (unzipping a trace and
 * parsing its whole action list), so it is done once per trace and the result
 * feeds both the sidecar and the arguments file. See plugin.mjs.
 *
 * Imports the bare specifier so this file runs unmodified in both places that
 * need it: under Node (plugin.mjs's local generate), it resolves through
 * node_modules same as any other package; in the browser (app/trace.js,
 * decoding a pipeline artifact's trace with no sidecar to read), an import map
 * in app/trace.html points the same specifier at the vendored lib/zip.min.js.
 */

import * as zip from '@zip.js/zip.js'

import { TRACE_ZIP } from './paths.js'
import { callNumber, packFacts, packStores } from './trace-state.js'

/** The viewer's zip.js keeps a worker pool alive, which would hold the CLI open. */
export const terminateWorkers = () => zip.terminateWorkers()


/**
 * The Network tab's rows, out of `trace.network`.
 *
 * These are the same HAR entries the viewer resolves a snapshot's assets
 * through, which is why they are read here instead of out of a second verbatim
 * copy in the sidecar: an exchange is mostly its bodies, and a response body is
 * already stored once, in `resources/<sha1>`. Only the entries pw-trace.js
 * marked `_cypressExchange` are traffic the test made; the rest are the fonts,
 * images and the one stylesheet the frames asked for, which this pane is not
 * about.
 *
 * Insertion order, which is the order network-log.js recorded them in. The rows
 * are matched to a command by their `data-t` time and not by index, so this is
 * presentation only.
 *
 * `schemaVersion`, `request.query` and the bodies' `encoding` are deliberately
 * not carried across: nothing on the page reads any of them, and the encoding
 * is a constant.
 *
 * Do not justify dropping the query by saying it shows up in the url instead.
 * It does not show up anywhere: buildNetwork labels a row `host + pathname`,
 * and a browser check of a real trace found no query string in the pane at all,
 * not in a label and not in the expanded view. The reason to drop it is that it
 * has no reader, and that redacting it is item 1.2's job in network-log.js
 * rather than something to replicate into a second file.
 */
async function readExchanges(byName) {
  const source = byName.get(TRACE_ZIP.network)
  if (!source) return []
  const rows = []
  // Resource name -> the body objects waiting on its text. A list, because two
  // identical responses share one resource: the pair of 400s on the spec this
  // was written against did exactly that.
  const wanted = new Map()

  for (const line of (await source.getData(new zip.TextWriter())).split('\n')) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const snapshot = event.type === 'resource-snapshot' ? event.snapshot : null
    if (!snapshot?._cypressExchange) continue

    const request = snapshot.request ?? {}
    const response = snapshot.response ?? {}
    const content = response.content ?? {}
    const parsed = Date.parse(snapshot.startedDateTime)
    const start = Number.isFinite(parsed) ? parsed : 0
    const row = {
      start,
      stop: start + (Number.isFinite(snapshot.time) ? snapshot.time : 0),
      request: {
        method: request.method,
        url: request.url,
        headers: request.headers ?? [],
        // The request body has no resources/ entry: HAR's postData is the only
        // place it exists now.
        ...(request.postData
          ? {
              body: {
                contentType: request.postData.mimeType,
                value: request.postData.text,
                size: request.bodySize,
                truncated: Boolean(request.postData._truncated),
              },
            }
          : {}),
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers ?? [],
      },
    }
    if (content._sha1) {
      // `size` is the pre-cap length, which is the number the panel prints when
      // the body is truncated. The text itself is one resources/ member away
      // and filled in below, in one pass over the ones actually referenced.
      const body = {
        contentType: content.mimeType,
        value: '',
        size: content.size,
        truncated: Boolean(content._truncated),
      }
      row.response.body = body
      const name = `resources/${content._sha1}`
      const waiting = wanted.get(name)
      if (waiting) waiting.push(body)
      else wanted.set(name, [body])
    }
    rows.push(row)
  }

  for (const [name, waiting] of wanted) {
    const resource = byName.get(name)
    if (!resource) continue
    const text = await resource.getData(new zip.TextWriter())
    for (const body of waiting) body.value = text
  }
  return rows
}

/**
 * The app's own state, split the way the two sidecars are fetched.
 *
 * EAGER, returned beside the action list because every row has one and the
 * facts strip has to paint on the first click with no request of its own:
 * `facts`, run-length encoded (see packFacts), and `writes`, which is counts
 * only and measured at 9.5KB on the fattest fixture.
 *
 * LAZY, returned as `state` and written to its own file: the store diffs, the
 * final state to replay back from, the shapes and the environment samples.
 * ~100KB on the stress trace, needed only once someone opens the pane.
 *
 * `null` for `state` means the trace predates the recorder, which the pane has
 * to be able to say: a blank tree reads as "the stores were empty" and sends
 * the reader hunting a bug in the app.
 */
function appState(extra, actions) {
  const writes = {}
  actions.forEach((action, i) => {
    if ('writes' in action) writes[i] = action.writes
  })
  const facts = packFacts(actions)
  if (!extra.storesFinal) return { facts, writes, state: null }
  const { stores, last } = packStores(extra.stores, actions)
  return {
    facts,
    writes,
    state: {
      stores,
      last,
      storesFinal: extra.storesFinal,
      // A store that degraded to `summary` or `shape` is not the whole state,
      // and the pane labels it so that a reader does not take a summary for
      // the thing itself. `auth` is always `shape`, so no credential value is
      // ever captured whatever that store grows to hold.
      storeShapes: extra.storeShapes ?? [],
      samples: extra.samples ?? [],
    },
  }
}

/**
 * Each action in a trace, with its window in epoch milliseconds.
 *
 * before/after carry monotonic times, the page's own joins are epoch. frame-snapshot
 * carries the same moment on both clocks, so one snapshot fixes the offset for
 * the whole trace.
 */
export async function readTrace(bytes) {
  const reader = new zip.ZipReader(new zip.Uint8ArrayReader(new Uint8Array(bytes)))
  try {
    const byName = new Map(
      (await reader.getEntries()).map((e) => [e.filename, e]),
    )

    // Written by plugins/allure/pw-trace.js, which rides it along in the trace zip so
    // the two cannot be separated. Absent from any trace built before that.
    const extraEntry = byName.get(TRACE_ZIP.extra)
    let extra = { console: [] }
    if (extraEntry) {
      try {
        extra = JSON.parse(await extraEntry.getData(new zip.TextWriter()))
      } catch {
        // A malformed sidecar costs the console tab and the arguments pane. The
        // network tab is read from trace.network and survives it.
      }
    }

    const exchanges = await readExchanges(byName)

    const entry = byName.get(TRACE_ZIP.events)
    if (!entry) return { actions: [], console: extra.console ?? [], exchanges, facts: null, writes: {}, state: null }

    const byId = new Map()
    const withSnapshot = new Set()
    const carried = new Set()
    let offset = null
    for (const line of (await entry.getData(new zip.TextWriter())).split('\n')) {
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'before') {
        // `args` is sparse and three-valued, which the pane needs kept apart:
        // absent means the command took no arguments, null means the byte
        // budget spent them, and an array is the real thing.
        const hasArgs = extra.args && Object.prototype.hasOwnProperty.call(extra.args, event.callId)
        byId.set(event.callId, {
          id: event.callId,
          // The callId as a number, carried rather than derived later. It is
          // the REPLAY order for the store diffs, and the action list is
          // sorted by start below, which is a different order; see
          // trace-state.js. Deriving one from the other afterwards is the
          // mistake that misaligns the pane without reordering the page.
          call: callNumber(event.callId) ?? 0,
          title: event.title,
          start: event.startTime,
          stop: event.startTime,
          failed: false,
          ...(hasArgs ? { args: extra.args[event.callId] } : {}),
          // Whole, not diffed, and absent on an assertion row. Attached here
          // and packed after the sort, because the run-length encoding below
          // is against DISPLAY order.
          ...(extra.facts && event.callId in extra.facts ? { facts: extra.facts[event.callId] } : {}),
          ...(extra.writes && event.callId in extra.writes ? { writes: extra.writes[event.callId] } : {}),
        })
      } else if (event.type === 'after') {
        const action = byId.get(event.callId)
        if (action) {
          action.stop = event.endTime
          action.failed = Boolean(event.error)
          // The error itself, and not only the boolean drawn from it. The row
          // was marked red and then the message was dropped on the floor, so
          // the pane had nothing to show but the test's single top-level error
          // -- which says what went wrong somewhere in the test, not what this
          // step was doing when it did. Flat { name, message, stack }; see
          // pw-trace.js.
          if (event.error) action.error = event.error
          // An afterSnapshot naming someone else's frame: a DOM-inert command
          // showing the last real snapshot. See pw-trace.js.
          if (event.afterSnapshot && event.afterSnapshot !== 'after@' + event.callId) {
            carried.add(event.callId)
          }
        }
      } else if (event.type === 'frame-snapshot') {
        const { wallTime, timestamp, callId } = event.snapshot ?? {}
        if (offset === null && Number.isFinite(wallTime) && Number.isFinite(timestamp)) {
          offset = wallTime - timestamp
        }
        // Only some commands carry a DOM: the action list is the whole command
        // log, the frames are the ring buffer's last few. Marked so the page can
        // explain a blank snapshot rather than leaving it looking broken.
        if (callId) withSnapshot.add(callId)
      }
    }

    // Sorted by start, because that is the viewer's own rule, not ours:
    //
    //     .sort((e, t) => t.parentId === e.callId ? -1
    //       : e.parentId === t.callId ? 1
    //       : e.startTime - t.startTime)
    //
    // in playwright-core 1.62.1's trace model, and a plain start sort again in
    // its service worker. Neither of ours carries a parentId, so start is the
    // whole key. This used to rely on insertion order instead, which held only
    // because a row per command happens to be emitted in start order; an
    // assertion row is emitted when the command that owns it ends, which is not
    // the same thing. Getting this wrong does not reorder the page, it
    // MISALIGNS it: the selected row is matched to a window by index.
    //
    // Stable in V8 either side, so rows that share a start keep emission order
    // here and in the viewer alike.
    const sorted = [...byId.values()].sort((a, b) => a.start - b.start)
    // Packed off the SORTED list, before the map below drops the two raw keys
    // again: the run-length encoding is against display order, which is what
    // the pane looks a row up by, and the actions themselves carry neither
    // across the wire -- facts go into the eager sidecar deduplicated and
    // writes into it keyed by index, so a copy on every row would be the
    // 1.15MB this is here to avoid.
    const app = appState(extra, sorted)
    const actions = sorted.map((action) => ({
      title: action.title,
      failed: action.failed,
      start: Math.round(action.start + (offset ?? 0)),
      stop: Math.round(action.stop + (offset ?? 0)),
      // Without a snapshot there is no epoch anchor, so the windows are
      // monotonic and cannot be joined. Say so rather than joining nonsense.
      anchored: offset !== null,
      snapshot: withSnapshot.has(action.id),
      carried: carried.has(action.id),
      // Name and message, not the stack. The stack is nearly all framework
      // frames for an assertion, and for a thrown error the test's own trace is
      // already on data.error -- storing it twice is what this file keeps
      // arguing against. Spread so a row without one carries no key at all.
      ...(action.error
        ? { error: { name: action.error.name, message: action.error.message } }
        : {}),
      // Spread, not a plain field: the pane tells three states apart and the
      // absent one has to stay absent. `args: undefined` would survive this map
      // and then vanish in JSON.stringify, which lands on the same place as
      // "took no arguments" -- but only by accident, and not for a command whose
      // args the budget dropped, which must arrive as an explicit null.
      ...('args' in action ? { args: action.args } : {}),
      // The replay order for the store diffs. Kept on the row because display
      // order is the sort above and they are not the same order.
      call: action.call,
    }))
    return { actions, console: extra.console ?? [], exchanges, ...app }
  } finally {
    await reader.close()
  }
}
