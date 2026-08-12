const CDP = require('chrome-remote-interface');

/*
 * CDP access to the cloud-debug Chrome.
 *
 * Deliberately much thinner than `CdpClient`: there is nothing to buffer here.
 * The Cypress Cloud replay page renders a RECORDING of a console — those rows
 * are DOM, not live `Runtime.consoleAPICalled` events — so everything is a
 * pull-on-demand evaluate against whichever tab currently shows the replay.
 *
 * Target selection re-runs on every call. The user drives this browser by hand
 * (pasting links, opening tabs), so the "current" tab changes underneath us
 * constantly; re-picking is far more predictable than pinning one target at
 * connect time. Chrome lists targets most-recently-used first, so the first
 * cloud.cypress.io page is the one the user is looking at. The underlying
 * WebSocket is cached and only rebuilt when the picked target actually changes.
 */
class CloudCdp {
  constructor(port) {
    this.port = port;
    this.client = null;
    this.targetId = null;
  }

  async listTargets() {
    const list = await CDP.List({ port: this.port });
    return list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  }

  // Open a new tab in the running browser.
  //
  // Needed because a live debugging port does NOT imply a live page: on macOS,
  // closing the last Chrome window quits the windows but not the process, so the
  // port keeps answering with zero page targets. Rather than telling the user to
  // relaunch a browser that is already running, we just open them a tab.
  // Chrome ≥ 111 requires PUT on this endpoint.
  async openTab(url = 'about:blank') {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`Could not open a tab on the cloud debug browser (HTTP ${res.status}).`);
    const target = await res.json();
    this.targetId = null; // force ensure() to re-pick and reconnect
    return target;
  }

  pickTarget(pages) {
    return (
      pages.find((t) => /cloud\.cypress\.io/.test(t.url || '')) ||
      pages.find((t) => /cypress/i.test(t.title || '')) ||
      pages.find((t) => !/^(chrome|devtools):/.test(t.url || '')) ||
      pages[0] ||
      null
    );
  }

  async close() {
    if (this.client) {
      try { await this.client.close(); } catch {}
    }
    this.client = null;
    this.targetId = null;
  }

  // Returns { client, target }. Reuses the cached socket when the picked target
  // has not changed since the last call.
  async ensure() {
    const pages = await this.listTargets();
    const target = this.pickTarget(pages);
    if (!target) {
      throw new Error(
        `The cloud debug browser (port ${this.port}) is running but has no open tabs. ` +
        'On macOS, closing the last Chrome window quits the window but leaves the process alive. ' +
        'Run `cypress-inspect cloud "<replay url>"` to open one (quote the URL — the shell splits on `&`), ' +
        'or use `cloud_open { url }`.',
      );
    }
    if (this.client && this.targetId === target.id) return { client: this.client, target };
    await this.close();
    const client = await CDP({ target: target.webSocketDebuggerUrl, local: false });
    await client.Runtime.enable();
    await client.Page.enable().catch(() => {});
    client.on('disconnect', () => {
      if (this.targetId === target.id) { this.client = null; this.targetId = null; }
    });
    this.client = client;
    this.targetId = target.id;
    return { client, target };
  }

  // Retry once through a full reconnect on a dropped/refused socket. The user
  // navigating or Chrome discarding a tab mid-call surfaces exactly this way.
  async _withReconnect(fn) {
    try {
      const { client, target } = await this.ensure();
      return await fn(client, target);
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!/ECONNREFUSED|WebSocket is not open|not connected|connection closed|connection lost|socket hang up|disconnected|EPIPE|Target closed|No page target/i.test(msg)) {
        throw err;
      }
      await this.close();
      const { client, target } = await this.ensure();
      return await fn(client, target);
    }
  }

  async evaluate(expression) {
    return this._withReconnect(async (client) => {
      const res = await client.Runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error(d.exception?.description || d.text || 'evaluate failed');
      }
      return res.result?.value;
    });
  }

  // Trusted input events.
  //
  // Required, not a nicety: the replay scrubber is a CONTROLLED React input
  // whose value comes from player state, so assigning `.value` and dispatching
  // synthetic `input`/`change` events (what a page-side probe can do) is
  // ignored — React re-renders the old value straight back. Events dispatched
  // through the CDP Input domain are trusted and behave like a real user's,
  // which is the only thing that actually moves the replay.
  async dispatchMouse(params) {
    return this._withReconnect(async (client) => client.Input.dispatchMouseEvent(params));
  }

  // Press and release at a point, with a hover first and a nudge while held —
  // the sequence a real click produces, and what the scrubber needs to commit.
  async clickAt(x, y) {
    await this.dispatchMouse({ type: 'mouseMoved', x, y, buttons: 0 });
    await this.dispatchMouse({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.dispatchMouse({ type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await this.dispatchMouse({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  async screenshot({ clip, captureBeyondViewport = false } = {}) {
    return this._withReconnect(async (client) => {
      const opts = { format: 'png', captureBeyondViewport };
      if (clip) opts.clip = clip;
      const res = await client.Page.captureScreenshot(opts);
      return res.data;
    });
  }

  // Navigate and wait for the load event. Test Replay keeps loading data well
  // after `load`, so callers still poll `PAGE_INFO` for readiness rather than
  // treating this resolving as "the replay is ready".
  async navigate(url, { timeoutMs = 30000 } = {}) {
    // No tab to navigate? Open one directly at the URL — that is the user's
    // intent either way, and it makes `cloud_open` work on a browser whose last
    // window was closed.
    if ((await this.listTargets()).length === 0) {
      const target = await this.openTab(url);
      return { targetId: target.id, timedOut: false, openedNewTab: true };
    }
    return this._withReconnect(async (client, target) => {
      const loaded = new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        client.Page.loadEventFired(() => { clearTimeout(timer); resolve({ timedOut: false }); });
      });
      const nav = await client.Page.navigate({ url });
      if (nav.errorText) throw new Error(`navigate failed: ${nav.errorText}`);
      const { timedOut } = await loaded;
      return { targetId: target.id, timedOut };
    });
  }

  async currentTarget() {
    const { target } = await this.ensure();
    return { id: target.id, url: target.url, title: target.title };
  }
}

module.exports = { CloudCdp };
