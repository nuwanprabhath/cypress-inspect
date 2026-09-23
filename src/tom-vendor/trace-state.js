// VENDORED from ternandsparrow/paratoo-fdcp @ feat/allure-viewer 420bffc8b4
//   paratoo-webapp/test-reporting/viewer/lib/trace-state.js
// Do not edit here: re-vendor with `cypress-inspect tom vendor` so this stays
// byte-identical to the decoder the pipeline reporter itself runs.

/**
 * The app's own state, out of a trace's cypress-extra.json: what the Pinia
 * stores held at each action, where the app was, what it wrote to disk, and
 * what the browser environment looked like.
 *
 * PURE. No node, no DOM, no fetch. Two programs call it and they are on
 * different sides of the wire: plugin.mjs packs the sidecars at generate time,
 * and app/trace.js reconstructs a row's state in the browser -- including for
 * a trace it decoded itself, where there are no sidecars at all. So the same
 * file has to run unmodified in both, exactly as lib/read-trace.js does.
 *
 * WHAT IS CAPTURED, and it is not a snapshot per action:
 *
 *   storesFinal   every store as of the LAST captured action, whole
 *   stores        per action, the paths that changed and their before/after
 *
 * so the state at an earlier action is the final state with the later diffs
 * undone. Backwards rather than forwards from a baseline because the
 * recorder's trimLog evicts rows from the FRONT of the command log: the
 * earliest rows are the ones that go missing, and the final state is the one
 * thing always present.
 *
 * TWO ORDERS, and they are not the same order.
 *
 *   display   the action list, sorted by startTime, which is the viewer's own
 *             rule (see read-trace.js). An assertion row is emitted when the
 *             command that owns it ENDS, so its start can precede the row
 *             before it.
 *   replay    ascending callId. The diffs were computed in that order, each
 *             against the previous capture, so replaying in display order
 *             applies them against the wrong base.
 *
 * Which is why every action carries its `call` number through from
 * read-trace.js rather than anything here deriving one from an index.
 */

/* ---- packing, at generate time ---------------------------------------- */

/**
 * Each action's facts, run-length encoded against the DISPLAY order.
 *
 * A run is `[firstIndex, facts]`, and `facts` is null where the rows have
 * none -- an assertion row, which the capture skips. Lookup is the last run
 * at or before the index.
 *
 * Encoded rather than stored per row because this file is fetched EAGERLY,
 * with the action list, so that the strip paints on the first click with no
 * request of its own; and because the facts barely move. Measured on four
 * real traces: 411 rows collapse to 16 runs and 2966 rows to 111, which is
 * 1.15MB of repeated route and lsKeys arrays down to 42KB. Route, focus and
 * the open portals change when the app changes, which is the only time a
 * reader stepping through the rows sees anything new.
 *
 * Compared by JSON text. The objects come straight out of one JSON.parse, so
 * key order is the capture's and is stable for identical readings.
 */
export function packFacts(actions) {
  const runs = []
  let previous
  for (let i = 0; i < actions.length; i++) {
    const facts = actions[i].facts ?? null
    const text = JSON.stringify(facts)
    if (text !== previous) {
      runs.push([i, facts])
      previous = text
    }
  }
  // A whole trace with no facts anywhere is one run of null, which is a lie
  // worth not telling: it reads as "every row was an assertion". The absence
  // of the key says the run did not record them.
  if (runs.length === 1 && runs[0][1] === null) return null
  return runs
}

/** The facts at a display index, or null where that row has none. */
export function factsAt(runs, index) {
  if (!runs || !runs.length || index < 0) return null
  let low = 0
  let high = runs.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (runs[mid][0] <= index) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  return found === -1 ? null : runs[found][1]
}

/**
 * The store diffs, keyed by call NUMBER rather than by the `call@<n>` string
 * the capture writes, and the highest number either the diffs or the actions
 * reach.
 *
 * Keyed by call and not by display index on purpose: the capture can hold a
 * diff for an action the trace itself no longer carries, because trimLog and
 * the diff budget evict independently. Those rows still have to be undone on
 * the way back, so they cannot be dropped for having no row to sit on.
 *
 * Three-valued, and the three are kept apart all the way to the pane: a key
 * absent means the action changed no store, an explicit null means it changed
 * something and the budget dropped the record -- a hole, not an empty change
 * list -- and an array is the real thing.
 */
export function packStores(raw, actions) {
  const stores = {}
  let last = 0
  for (const key of Object.keys(raw ?? {})) {
    const n = callNumber(key)
    if (n === null) continue
    stores[n] = raw[key]
    if (n > last) last = n
  }
  for (const action of actions) if (action.call > last) last = action.call
  return { stores, last }
}

/** `call@37` -> 37. Null for anything that is not one, rather than NaN. */
export function callNumber(id) {
  const m = /^call@(\d+)$/.exec(String(id ?? ''))
  return m ? Number(m[1]) : null
}

/* ---- walking a tagged tree -------------------------------------------- */
/*
 * `storesFinal` is serializeArg's tagged shape, the same one the console pane
 * and the arguments pane already render: an object node holds [key, value]
 * PAIRS and an array node holds values, so none of it can be indexed the way a
 * plain object can.
 */

const child = (node, key) =>
  node?.t === 'object' ? (node.v.find(([k]) => k === key) ?? [])[1]
  : node?.t === 'array' ? node.v[Number(key)]
  : undefined

/** The node a dotted path names, walking every segment but the last. */
function parent(root, parts) {
  let node = root
  for (let i = 0; i < parts.length - 1; i++) node = child(node, parts[i])
  return node
}

function setPath(root, path, value) {
  const parts = path.split('.')
  const node = parent(root, parts)
  const last = parts[parts.length - 1]
  if (node?.t === 'array') node.v[Number(last)] = value
  else if (node?.t === 'object') {
    const pair = node.v.find(([k]) => k === last)
    if (pair) pair[1] = value
    else node.v.push([last, value])
  }
}

function deletePath(root, path) {
  const parts = path.split('.')
  const node = parent(root, parts)
  const last = parts[parts.length - 1]
  if (node?.t === 'array') node.v.splice(Number(last), 1)
  else if (node?.t === 'object') {
    const at = node.v.findIndex(([k]) => k === last)
    if (at !== -1) node.v.splice(at, 1)
  }
}

/** Structural, because every edit below is in place and the cache is shared. */
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)))

/* ---- reconstruction ---------------------------------------------------- */

/**
 * One action's changes applied or undone, in place.
 *
 * The direction decides the order WITHIN the row as well as which side of the
 * change is used: the diff emits array indices ascending, so undoing them
 * descending is what lets an array that grew shrink from its end rather than
 * from under the indices still to be undone.
 */
function apply(state, entry, undo) {
  for (const { store, changes } of entry) {
    const root = state[store]
    if (!root) continue
    const ordered = undo ? [...changes].reverse() : changes
    for (const change of ordered) {
      const side = undo ? 'before' : 'after'
      // CLONED, and this is not defensive tidiness. The value goes into a
      // state the next step then edits in place, so putting the diff's own
      // object there hands the replay a reference INTO its own source data:
      // undoing `collections.4` removed at call@422 spliced that entry's
      // `before` into the tree, and undoing the `collections.4.plot-visit`
      // addition at call@346 one step later deleted plot-visit out of the
      // diff itself. Every later reconstruction then replayed corrupted
      // input, and the damage was invisible -- each walk succeeded, and the
      // state it produced was simply missing a key the app had.
      if (side in change) setPath(root, change.path, clone(change[side]))
      else deletePath(root, change.path)
    }
  }
}

/**
 * A cursor over the replay, so stepping through the rows costs one row at a
 * time rather than a walk from the end on every click.
 *
 * `at` is the call number the held state is correct for. Moving down undoes
 * the rows in between and moving up redoes them, which is the same work in
 * either direction; without the second half, a reader stepping FORWARD would
 * restart from the final state on every click, which on the stress trace is
 * 41 rows of diff re-applied to answer a question about the next one.
 */
export function replayer(state) {
  const { stores, storesFinal, last } = state
  // The holes, ascending. A null entry is a change whose record the budget
  // dropped, so nothing below it can be reconstructed: the nearest one ABOVE
  // the wanted action is as far back as the walk can honestly go.
  const holes = Object.keys(stores)
    .filter((n) => stores[n] === null)
    .map(Number)
    .sort((a, b) => a - b)
  let held = clone(storesFinal)
  let at = last

  return function stateAt(call) {
    // A hole is the ONLY thing that floors the walk. The oldest action
    // carrying a diff does not, which is a deliberate departure from the
    // handover note: an absent key is the contract's way of saying the action
    // changed nothing, so everything below the first recorded change is
    // exactly known rather than merely anchored. Flooring there would have
    // marked 57 of the submit fixture's 444 rows partial -- its first diff is
    // at call@58 -- and a note that says "as of a later action" on a row whose
    // state is precise is the one thing this pane must not do.
    const hole = holes.find((n) => n > call && n <= last)
    const target = Math.max(call, hole ?? 0)

    if (target < at) {
      for (let n = at; n > target; n--) {
        const entry = stores[n]
        if (entry) apply(held, entry, true)
      }
    } else if (target > at) {
      for (let n = at + 1; n <= target; n++) {
        const entry = stores[n]
        if (entry) apply(held, entry, false)
      }
    }
    at = target

    return {
      state: held,
      anchor: target,
      // The answer is not the action asked for: a dropped diff between the two
      // means this tree belongs to `anchor`, and the pane says so rather than
      // showing a state that silently belongs to a different moment.
      partial: target > call,
    }
  }
}

/* ---- the environment samples ------------------------------------------ */

/**
 * The sample that describes a moment: the newest reading taken at or before
 * it.
 *
 * The samples are taken on a clock inside a requestIdleCallback and are NOT
 * joined to an action by the capture, so this is the join, and it can fail in
 * two ways that are worth telling apart. `ahead` is a test shorter than one
 * sample interval, where the only reading was taken after the action and is
 * evidence about later; null is a trace with no readings at all.
 */
export function sampleAt(samples, time) {
  if (!samples || !samples.length || !time) return null
  let found = null
  for (const sample of samples) {
    if (sample.at <= time && (!found || sample.at > found.at)) found = sample
  }
  if (found) return { sample: found, ahead: false, age: time - found.at }
  const first = samples.reduce((a, b) => (a.at <= b.at ? a : b))
  return { sample: first, ahead: true, age: first.at - time }
}
