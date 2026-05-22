const CDP = require('chrome-remote-interface');

// Ring buffer of recent console messages across all attached targets.
const MAX_LOGS = 5000;
const MAX_NET = 2000;

class CdpClient {
  constructor() {
    this.port = null;
    this.targets = new Map(); // targetId -> { client, info, kind, contexts }
    this.logs = [];
    this.network = new Map(); // requestId -> entry
    this.netOrder = []; // requestIds in arrival order (for ring buffer)
    this.lastError = null;
    this.refreshTimer = null;
    this.attachedAt = null;
    this.totalLogsSeen = 0;
    this.totalNetSeen = 0;
  }

  async attach(port) {
    // Idempotent: if we're already attached (possibly to a stale port) tear
    // it down first so a re-attach to a freshly-launched Chrome process is a
    // single call from the caller's perspective.
    if (this.refreshTimer || this.targets.size) await this.detach();
    this.port = port;
    this.attachedAt = Date.now();
    this.lastError = null;
    await this.refreshTargets();
    this.refreshTimer = setInterval(() => this.refreshTargets().catch(() => {}), 2000);
  }

  async detach() {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    for (const [, t] of this.targets) {
      try { await t.client.close(); } catch {}
    }
    this.targets.clear();
    this.port = null;
    // Preserve the log / network buffers across re-attach — those are the
    // agent's history and dropping them would be surprising. attachedAt is
    // updated on the next attach() call.
  }

  classify(info) {
    const url = info.url || '';
    if (/\/__(?:\/|launchpad|cypress)/.test(url)) return 'runner';
    if (url.startsWith('chrome://') || url.startsWith('devtools://')) return 'system';
    if (info.type === 'iframe') return 'aut';
    if (/^https?:\/\//.test(url)) return 'aut';
    return 'system';
  }

  async refreshTargets() {
    if (!this.port) return;
    let list;
    try {
      list = await CDP.List({ port: this.port });
    } catch (err) {
      this.lastError = String(err.message || err);
      return;
    }
    const seen = new Set();
    for (const info of list) {
      if (info.type !== 'page' && info.type !== 'iframe') continue;
      const kind = this.classify(info);
      if (kind === 'system') continue;
      seen.add(info.id);
      if (this.targets.has(info.id)) {
        this.targets.get(info.id).info = info;
        continue;
      }
      await this.attachTarget(info, kind);
    }
    for (const id of [...this.targets.keys()]) {
      if (!seen.has(id)) {
        try { await this.targets.get(id).client.close(); } catch {}
        this.targets.delete(id);
      }
    }
  }

  async attachTarget(info, kind) {
    try {
      const client = await CDP({ target: info.webSocketDebuggerUrl, local: false });
      const { Runtime, Log, Page, Network } = client;
      await Runtime.enable();
      await Log.enable().catch(() => {});
      await Page.enable().catch(() => {});
      await Network.enable().catch(() => {});

      const record = { client, info, kind, contexts: new Map() };
      this.targets.set(info.id, record);

      // Track execution contexts (one per frame). Cypress wraps console.* in
      // the AUT iframe so Runtime.consoleAPICalled may not fire for that frame
      // — exposing the context list helps diagnose silent capture.
      Runtime.executionContextCreated?.(({ context }) => {
        record.contexts.set(context.id, {
          id: context.id,
          origin: context.origin,
          name: context.name,
          uniqueId: context.uniqueId,
          auxData: context.auxData,
        });
      });
      Runtime.executionContextDestroyed?.(({ executionContextId }) => {
        record.contexts.delete(executionContextId);
      });

      Runtime.consoleAPICalled(({ type, args, timestamp, stackTrace, executionContextId }) => {
        this.totalLogsSeen++;
        const text = (args || []).map(argToString).join(' ');
        this.pushLog({
          ts: Math.round(timestamp || Date.now()),
          level: type,
          text,
          url: stackTrace?.callFrames?.[0]?.url,
          kind,
          targetId: info.id,
          executionContextId,
        });
      });
      Runtime.exceptionThrown(({ exceptionDetails, timestamp }) => {
        this.totalLogsSeen++;
        this.pushLog({
          ts: Math.round(timestamp || Date.now()),
          level: 'exception',
          text: exceptionDetails?.exception?.description || exceptionDetails?.text || 'Uncaught exception',
          url: exceptionDetails?.url,
          kind,
          targetId: info.id,
          executionContextId: exceptionDetails?.executionContextId,
        });
      });
      Log.entryAdded?.(({ entry }) => {
        this.totalLogsSeen++;
        this.pushLog({
          ts: entry.timestamp || Date.now(),
          level: entry.level || 'log',
          text: entry.text,
          url: entry.url,
          kind,
          targetId: info.id,
        });
      });

      // Network capture — we record only the fields useful for debugging
      // (method, URL, status, mime, duration, failure reason). Body is
      // deliberately NOT fetched: response bodies can be enormous and would
      // dominate the ring buffer. Callers wanting a body can use `eval`.
      Network.requestWillBeSent?.((params) => {
        this.totalNetSeen++;
        const id = params.requestId;
        const r = params.request || {};
        const entry = {
          id,
          ts: Math.round((params.timestamp || 0) * 1000) || Date.now(),
          method: r.method || null,
          url: r.url || null,
          resourceType: params.type || null,
          initiator: params.initiator?.type || null,
          kind,
          targetId: info.id,
          status: null,
          statusText: null,
          mime: null,
          fromCache: false,
          failed: false,
          failureText: null,
          durationMs: null,
        };
        this.pushNet(entry);
      });
      Network.responseReceived?.(({ requestId, response, timestamp }) => {
        const e = this.network.get(requestId);
        if (!e) return;
        e.status = response.status;
        e.statusText = response.statusText;
        e.mime = response.mimeType;
        e.fromCache = !!response.fromDiskCache;
        if (timestamp && e.ts) e.durationMs = Math.max(0, Math.round(timestamp * 1000) - e.ts);
      });
      Network.loadingFailed?.(({ requestId, errorText, canceled, blockedReason }) => {
        const e = this.network.get(requestId);
        if (!e) return;
        e.failed = true;
        e.failureText = errorText || blockedReason || (canceled ? 'canceled' : 'unknown');
      });

      client.on('disconnect', () => {
        this.targets.delete(info.id);
      });
    } catch (err) {
      this.lastError = `attach ${info.url}: ${err.message}`;
    }
  }

  pushLog(entry) {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  pushNet(entry) {
    this.network.set(entry.id, entry);
    this.netOrder.push(entry.id);
    if (this.netOrder.length > MAX_NET) {
      const drop = this.netOrder.shift();
      this.network.delete(drop);
    }
  }

  getNetworkLogs({ grep, since, limit = 100, statusMin, statusMax, failedOnly } = {}) {
    let out = this.netOrder.map((id) => this.network.get(id)).filter(Boolean);
    if (since) out = out.filter((e) => e.ts >= since);
    if (statusMin != null) out = out.filter((e) => e.status != null && e.status >= statusMin);
    if (statusMax != null) out = out.filter((e) => e.status != null && e.status <= statusMax);
    if (failedOnly) out = out.filter((e) => e.failed || (e.status && e.status >= 400));
    if (grep) {
      const re = new RegExp(grep, 'i');
      out = out.filter((e) => re.test(e.url || ''));
    }
    return out.slice(-limit);
  }

  getLogs({ level, since, kind, limit = 200, grep } = {}) {
    let out = this.logs;
    if (level) out = out.filter((l) => l.level === level);
    if (kind) out = out.filter((l) => l.kind === kind);
    if (since) out = out.filter((l) => l.ts >= since);
    if (grep) {
      const re = new RegExp(grep, 'i');
      out = out.filter((l) => re.test(l.text));
    }
    return out.slice(-limit);
  }

  // The spec runner page hosts `window.Cypress` AND the AUT iframe. We always
  // evaluate Cypress-related code on the runner target; for AUT DOM we walk
  // into `iframe.aut-iframe.contentDocument` from there.
  pickRunnerTarget() {
    const all = [...this.targets.values()];
    const specRunner = all.find((t) => /\/__\/#\/specs/.test(t.info.url || ''));
    if (specRunner) return specRunner;
    const anyRunner = all.find((t) => t.kind === 'runner' && t.info.type === 'page');
    if (anyRunner) return anyRunner;
    return all.find((t) => t.info.type === 'page') || all[0];
  }

  async evalOnRunner(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const target = this.pickRunnerTarget();
    if (!target) throw new Error('No CDP target available (is `cypress-inspect open` running and a spec selected?)');
    const { Runtime } = target.client;
    const res = await Runtime.evaluate({
      expression,
      awaitPromise,
      returnByValue,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(msg);
    }
    return res.result?.value;
  }

  async screenshot({ kind = 'runner', clip } = {}) {
    const target = this.pickRunnerTarget();
    if (!target) throw new Error('No CDP target available');
    const { Page } = target.client;
    const opts = { format: 'png' };
    if (clip) opts.clip = clip;
    const res = await Page.captureScreenshot(opts);
    return res.data;
  }

  listTargets() {
    return [...this.targets.values()].map((t) => ({
      id: t.info.id,
      type: t.info.type,
      url: t.info.url,
      title: t.info.title,
      kind: t.kind,
      isSpecRunner: /\/__\/#\/specs/.test(t.info.url || ''),
      executionContexts: [...t.contexts.values()],
    }));
  }

  // Buffer + capture-state diagnostics. Used so callers can distinguish
  // "no logs matched the filter" from "console capture is broken".
  bufferStatus() {
    const contexts = [];
    for (const t of this.targets.values()) {
      for (const c of t.contexts.values()) {
        contexts.push({ targetId: t.info.id, kind: t.kind, ...c });
      }
    }
    return {
      attachedAt: this.attachedAt,
      capturedSinceMs: this.attachedAt ? Date.now() - this.attachedAt : null,
      totalEventsSeen: this.totalLogsSeen,
      bufferedCount: this.logs.length,
      totalNetSeen: this.totalNetSeen,
      bufferedNetCount: this.network.size,
      attachedTargets: this.targets.size,
      attachedContexts: contexts.length,
      contexts,
    };
  }
}

function argToString(arg) {
  if (arg.value !== undefined) return safeStringify(arg.value);
  if (arg.unserializableValue) return String(arg.unserializableValue);
  if (arg.description) return arg.description;
  return arg.type || '';
}
function safeStringify(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { CdpClient };
