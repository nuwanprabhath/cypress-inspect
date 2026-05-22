// Stable taxonomy for Cypress failure causes. Pure, deterministic, scans
// only the data we already have (message, stack, codeFrame, parsedDiff,
// flakeSignals, looksLikeCascade). Returns one of:
//
//   - compare_diff           (fixture vs UI mismatch, e.g. our InProgress widget)
//   - dropdown_ambiguity     (random selection in selectFromDropdown)
//   - selector_not_found     ("never found element X" / brittle selector)
//   - route_mismatch         (URL / pathname / location assertion fail)
//   - network_failure        (intercept / request / 5xx / 4xx)
//   - timeout_cascade        (downstream timeout after a real failure)
//   - stale_local_state      (auth/session/local-storage drift)
//   - unknown                (everything else)
//
// Each result has `{ category, confidence: 'high'|'medium'|'low', explain,
// evidence }`. Evidence lists which signals matched so the agent can show its
// work to the user.

function classifyFailure(failure) {
  if (!failure || typeof failure !== 'object') return { category: 'unknown', confidence: 'low', explain: 'No failure provided.', evidence: [] };
  const msg = String(failure.message || '');
  const stack = String(failure.stack || '');
  const frame = String(failure.codeFrame || '');
  const all = `${msg}\n${stack}\n${frame}`;
  const flakeSignals = Array.isArray(failure.flakeSignals) ? failure.flakeSignals : [];
  const evidence = [];

  // 1. Compare diff — strongest signal we have.
  if (failure.parsedDiff && Array.isArray(failure.parsedDiff.diffs) && failure.parsedDiff.diffs.length) {
    return {
      category: 'compare_diff',
      confidence: 'high',
      explain: `${failure.parsedDiff.diffs.length} field(s) in a structural comparison did not match the expected fixture.`,
      evidence: ['parsedDiff present', `diffs=${failure.parsedDiff.diffs.length}`],
    };
  }

  // 2. Dropdown ambiguity — we have an explicit flake-signal taxonomy already.
  if (flakeSignals.includes('random_dropdown_selection') || flakeSignals.includes('no_search_query_for_dropdown')) {
    return {
      category: 'dropdown_ambiguity',
      confidence: 'high',
      explain: 'A dropdown helper was invoked without a fixed item — Cypress logged a WARNING about random selection or missing search query. The actual value will change run-to-run.',
      evidence: flakeSignals.map((s) => `flakeSignal:${s}`),
    };
  }

  // 3. Network failure
  if (/cy\.intercept|cy\.request|Network request failed|status code 5\d\d|status code 4\d\d|cors error|net::ERR|fetch failed/i.test(all)) {
    evidence.push('network keywords in error');
    return {
      category: 'network_failure',
      confidence: 'medium',
      explain: 'The error references a network operation (cy.intercept / cy.request / fetch / 4xx/5xx). Check `get_console_logs` for the failing request.',
      evidence,
    };
  }

  // 4. Route mismatch — assertions on URL/pathname/location/hash
  if (/expected.*url|expected.*pathname|cy\.url\(\)|cy\.location\(/i.test(all)) {
    evidence.push('URL/location assertion in error');
    return {
      category: 'route_mismatch',
      confidence: 'medium',
      explain: 'A URL or location assertion failed — the app likely navigated somewhere unexpected. Use `get_aut_info` to read the current location.',
      evidence,
    };
  }

  // 5. Selector not found — Cypress's canonical phrasing
  if (/(?:never found|expected to find|unable to find|find element|cy\.get|cy\.find).*?(?:never found|element|exist)/i.test(msg)
      || /Expected to find element/i.test(msg)) {
    evidence.push('"find element" / "never found" in message');
    // Try to pull the selector
    const selMatch = msg.match(/element[s]?:?\s*[`'"]?([^`'"\n)]+)[`'"]?/i);
    if (selMatch) evidence.push(`selector candidate: ${selMatch[1].slice(0, 80)}`);
    return {
      category: 'selector_not_found',
      confidence: 'medium',
      explain: 'A selector did not match in the DOM. Time-travel to the failing command with `step_to`, then `get_dom` / `find_in_aut` to see what actually rendered. Brittle selectors (no data-cy) are a frequent cause — try `analyze_spec`.',
      evidence,
    };
  }

  // 6. Timeout cascade — looksLikeCascade means upstream failure; otherwise
  //    a plain timeout that's the first failure.
  if (/Timed out retrying after \d+ms|Cypress test was stopped while running/i.test(msg)) {
    if (failure.looksLikeCascade) {
      return {
        category: 'timeout_cascade',
        confidence: 'high',
        explain: `This timeout looks like a downstream effect of an earlier failure (cascadeOf=${failure.cascadeOf}). Fix the root failure first.`,
        evidence: ['looksLikeCascade=true', 'timeout/stopped pattern'],
      };
    }
    return {
      category: 'timeout_cascade',
      confidence: 'medium',
      explain: 'A retry timed out. Either the expected DOM state never arrived (selector / app bug) or the assertion is wrong.',
      evidence: ['timeout/stopped pattern'],
    };
  }

  // 7. Stale local state — auth/session/local-storage flavored deep-equal failures
  if (/expected\s+\{[^}]*\}\s+to deeply equal/i.test(msg)
      && /(?:auth|session|user|token|localStorage|sessionStorage|stored|cache|model)/i.test(all)) {
    evidence.push('deep-equal mismatch');
    evidence.push('auth/session/storage keywords');
    return {
      category: 'stale_local_state',
      confidence: 'medium',
      explain: 'A deep-equal comparison on auth/session/storage-shaped data failed. State from a previous test (or run) may have leaked. Try `clear_app_state` then `rerun_spec`, or inspect with `get_storage`.',
      evidence,
    };
  }

  // 8. Default
  return {
    category: 'unknown',
    confidence: 'low',
    explain: 'No taxonomy rule matched. The error is likely application-specific — read the message and stack directly.',
    evidence: [],
  };
}

// Augment every failure in a payload with `classification: {...}`.
function classifyFailures(payload) {
  if (!payload || !Array.isArray(payload.failures)) return payload;
  return {
    ...payload,
    failures: payload.failures.map((f) => ({ ...f, classification: classifyFailure(f) })),
  };
}

module.exports = { classifyFailure, classifyFailures };
