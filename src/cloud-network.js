/*
 * The replay's recorded network activity.
 *
 * Listing is kept deliberately compact — a single test can issue hundreds of
 * requests, and most debugging starts with "which call failed", not with every
 * payload. Bodies are fetched one row at a time by `detail()`, because reading a
 * payload means expanding that row in the UI and Cypress Cloud renders response
 * bodies lazily.
 */

const probe = require('./cloud-probe');

// The UI's own sub-filters. Applying one narrows the list before it is scraped,
// which matters when a test made 400 requests and you want the 3 that 500'd.
const FILTER_TABS = { all: 'all', errors: 'errors', fetchXhr: 'fetch' };

function isErrorStatus(status) {
  const n = Number(status);
  return Number.isFinite(n) && n >= 400;
}

async function listNetwork(cloud, { grep, failedOnly, fetchXhrOnly, limit = 100, offset = 0 } = {}) {
  const filterTab = failedOnly ? FILTER_TABS.errors : fetchXhrOnly ? FILTER_TABS.fetchXhr : FILTER_TABS.all;
  const raw = await cloud.evaluate(probe.networkListExpr({
    filterTab,
    tabWaitMs: 1200,
    maxScrollSteps: 400,
    stepDelayMs: 90,
  }));
  if (raw?.error) return raw;

  let items = raw.items;
  if (grep) {
    let re;
    try { re = new RegExp(grep, 'i'); } catch { return { error: 'bad-grep', grep }; }
    items = items.filter((i) => re.test(`${i.method || ''} ${i.path || ''} ${i.status || ''}`));
  }
  // Belt and braces: the Errors tab should already have narrowed to failures,
  // but a status check here means `failedOnly` still means what it says even if
  // that tab ever changes meaning.
  if (failedOnly) items = items.filter((i) => isErrorStatus(i.status));

  const matched = items.length;
  return {
    networkTab: raw.networkTab,
    filterTab,
    total: raw.total,
    matched,
    offset,
    returned: Math.min(Math.max(matched - offset, 0), limit),
    items: items.slice(offset, offset + limit),
  };
}

/*
 * Read one request's payload.
 *
 * Addressed by `rowId` (the row's `data-cy`, e.g. `devtool-network-item-19`)
 * rather than a positional index, because the list is virtualised: position N in
 * a previous listing is not position N in the DOM now. The rowId is stable, and
 * an unrendered one produces an explicit error naming the fix instead of
 * silently returning a different request's body.
 */
async function networkDetail(cloud, { rowId } = {}) {
  if (!rowId) return { error: 'no-row-id', hint: 'Pass `rowId` from a `cloud_network_logs` row (e.g. "devtool-network-item-19").' };
  const res = await cloud.evaluate(probe.networkDetailExpr({
    rowId,
    tabWaitMs: 1000,
    expandWaitMs: 1000,
  }));
  return res;
}

module.exports = { listNetwork, networkDetail, isErrorStatus, FILTER_TABS };
