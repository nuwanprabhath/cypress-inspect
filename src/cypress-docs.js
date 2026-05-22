// Cypress documentation lookup. The Cypress docs site ships an LLM-friendly
// mirror at https://docs.cypress.io/llm/markdown/<path>.md, advertised by
// /llms.txt. Letting the agent fetch the canonical doc for a command beats it
// guessing from memory.
//
// We expose two surfaces:
//   * docHintForCommand(name) — pure helper returning a doc URL. Used to
//     annotate failures with a link to the failed command's API page so the
//     agent can verify behaviour without a tool call.
//   * fetchCypressDoc(topic) — fetches the LLM-markdown for a topic. Async,
//     requires network. Falls back to the HTML page if the /llm mirror 404s.

const LLM_BASE = 'https://docs.cypress.io/llm/markdown';
const HTML_BASE = 'https://docs.cypress.io';

// Curated map of well-known cy.* commands → docs path. This catches the
// long-tail of names that don't follow a guessable scheme, and short-circuits
// the resolver for the common case.
const COMMAND_PATH = {
  visit: '/api/commands/visit',
  get: '/api/commands/get',
  find: '/api/commands/find',
  contains: '/api/commands/contains',
  click: '/api/commands/click',
  type: '/api/commands/type',
  intercept: '/api/commands/intercept',
  wait: '/api/commands/wait',
  request: '/api/commands/request',
  session: '/api/commands/session',
  fixture: '/api/commands/fixture',
  task: '/api/commands/task',
  exec: '/api/commands/exec',
  invoke: '/api/commands/invoke',
  its: '/api/commands/its',
  then: '/api/commands/then',
  wrap: '/api/commands/wrap',
  should: '/api/commands/should',
  and: '/api/commands/and',
  as: '/api/commands/as',
  within: '/api/commands/within',
  reload: '/api/commands/reload',
  go: '/api/commands/go',
  go_back: '/api/commands/go',
  go_forward: '/api/commands/go',
  url: '/api/commands/url',
  hash: '/api/commands/hash',
  location: '/api/commands/location',
  title: '/api/commands/title',
  window: '/api/commands/window',
  document: '/api/commands/document',
  clearcookies: '/api/commands/clearcookies',
  setcookie: '/api/commands/setcookie',
  getcookie: '/api/commands/getcookie',
  clearlocalstorage: '/api/commands/clearlocalstorage',
  screenshot: '/api/commands/screenshot',
  scrollto: '/api/commands/scrollto',
  scrollintoview: '/api/commands/scrollintoview',
  trigger: '/api/commands/trigger',
  select: '/api/commands/select',
  selectfile: '/api/commands/selectfile',
  check: '/api/commands/check',
  uncheck: '/api/commands/uncheck',
  clear: '/api/commands/clear',
  blur: '/api/commands/blur',
  focus: '/api/commands/focus',
  focused: '/api/commands/focused',
  submit: '/api/commands/submit',
  spread: '/api/commands/spread',
  each: '/api/commands/each',
  filter: '/api/commands/filter',
  first: '/api/commands/first',
  last: '/api/commands/last',
  eq: '/api/commands/eq',
  next: '/api/commands/next',
  nextall: '/api/commands/nextall',
  nextuntil: '/api/commands/nextuntil',
  prev: '/api/commands/prev',
  prevall: '/api/commands/prevall',
  prevuntil: '/api/commands/prevuntil',
  parent: '/api/commands/parent',
  parents: '/api/commands/parents',
  parentsuntil: '/api/commands/parentsuntil',
  children: '/api/commands/children',
  siblings: '/api/commands/siblings',
  closest: '/api/commands/closest',
  pause: '/api/commands/pause',
  debug: '/api/commands/debug',
  log: '/api/commands/log',
  origin: '/api/commands/origin',
  mount: '/api/commands/mount',
};

// Some topics are guides, not commands. Map common shorthand to guide paths.
const GUIDE_PATH = {
  retries: '/guides/core-concepts/retry-ability',
  retryability: '/guides/core-concepts/retry-ability',
  selectors: '/guides/references/best-practices#Selecting-Elements',
  'best-practices': '/guides/references/best-practices',
  authentication: '/guides/end-to-end-testing/auth0-authentication',
  network: '/guides/guides/network-requests',
  variables: '/guides/core-concepts/variables-and-aliases',
  aliases: '/guides/core-concepts/variables-and-aliases',
  fixtures: '/guides/core-concepts/test-runner#Fixtures',
  flake: '/guides/core-concepts/retry-ability',
  flakiness: '/guides/core-concepts/retry-ability',
  ci: '/guides/continuous-integration/introduction',
};

// Normalise "cy.intercept", "Cy.Intercept", "intercept()", "cy intercept",
// "INTERCEPT" → "intercept".
function normalise(query) {
  if (typeof query !== 'string') return '';
  return query
    .toLowerCase()
    .replace(/^cy[\s.]+/, '')
    .replace(/\(.*$/, '')
    .replace(/[^a-z0-9_-]+/g, '')
    .trim();
}

// Return the canonical Cypress docs URL for a cy.<command> name, or null if
// the name isn't a known command. Pure / synchronous — safe to call from
// failure-annotation paths.
function docHintForCommand(name) {
  const key = normalise(name);
  if (!key) return null;
  if (COMMAND_PATH[key]) return `${HTML_BASE}${COMMAND_PATH[key]}`;
  return null;
}

// Resolve an arbitrary topic to one or more candidate doc paths. Returns an
// array of { kind, url, llmUrl } so the caller can try them in order.
function resolveDocPath(topic) {
  const key = normalise(topic);
  if (!key) return [];
  const out = [];
  if (COMMAND_PATH[key]) {
    out.push({
      kind: 'command',
      url: `${HTML_BASE}${COMMAND_PATH[key]}`,
      llmUrl: `${LLM_BASE}${COMMAND_PATH[key]}.md`,
    });
  }
  if (GUIDE_PATH[key]) {
    out.push({
      kind: 'guide',
      url: `${HTML_BASE}${GUIDE_PATH[key]}`,
      llmUrl: `${LLM_BASE}${GUIDE_PATH[key]}.md`,
    });
  }
  // Generic last-resort guess: try /api/commands/<key>
  if (out.length === 0) {
    out.push({
      kind: 'guess',
      url: `${HTML_BASE}/api/commands/${key}`,
      llmUrl: `${LLM_BASE}/api/commands/${key}.md`,
    });
  }
  return out;
}

// Extract every `cy.<command>` mentioned in a failure message / stack so we
// can attach docs hints to it. Returns deduped command names in order seen.
function extractCyCommands(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const seen = new Set();
  const out = [];
  const re = /\bcy\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// Build the docs-hint list for a failure: every cy.<command> mentioned in the
// message OR stack, mapped to its docs URL when known.
function docsHintsForFailure(failure) {
  if (!failure) return [];
  const haystack = [failure.message, failure.stack, failure.codeFrame]
    .filter(Boolean)
    .join('\n');
  const out = [];
  for (const cmd of extractCyCommands(haystack)) {
    const url = docHintForCommand(cmd);
    if (url) out.push({ command: `cy.${cmd}`, url });
  }
  return out;
}

// Fetch the markdown for a topic via the /llm mirror. Falls back to the HTML
// URL (just returns the URL — fetching HTML and returning raw HTML is rarely
// useful to an agent; the URL is the signal). Returns
// `{ topic, kind, url, markdown? }`.
async function fetchCypressDoc(topic, { fetchImpl = globalThis.fetch } = {}) {
  const candidates = resolveDocPath(topic);
  if (candidates.length === 0) {
    return { topic, error: `Could not resolve topic "${topic}" to a Cypress docs path.` };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      topic,
      error: 'global fetch unavailable — this Node version is too old (need 18+).',
      candidates,
    };
  }
  const errors = [];
  for (const c of candidates) {
    try {
      const res = await fetchImpl(c.llmUrl, { redirect: 'follow' });
      if (res.ok) {
        const markdown = await res.text();
        return { topic, kind: c.kind, url: c.url, llmUrl: c.llmUrl, markdown };
      }
      errors.push({ url: c.llmUrl, status: res.status });
    } catch (err) {
      errors.push({ url: c.llmUrl, error: err.message });
    }
  }
  return {
    topic,
    error: `No /llm/markdown mirror found for "${topic}".`,
    candidates,
    attempts: errors,
  };
}

module.exports = {
  docHintForCommand,
  resolveDocPath,
  extractCyCommands,
  docsHintsForFailure,
  fetchCypressDoc,
  LLM_BASE,
  HTML_BASE,
};
