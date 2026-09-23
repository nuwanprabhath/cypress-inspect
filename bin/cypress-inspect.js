#!/usr/bin/env node
const { runOpen, runRun } = require('../src/launcher');
const { runCloud } = require('../src/cloud-launcher');
const { runTom } = require('../src/tom-cli');
const { runMcp } = require('../src/mcp-server');
const { readSession, printSession } = require('../src/session');
const { readCloudSession, printCloudSession } = require('../src/cloud-session');

// Strip a leading `--` separator so `cypress-inspect run -- --spec x` forwards
// `--spec x` to Cypress without the separator.
const [, , cmd, ...restRaw] = process.argv;
const rest = restRaw[0] === '--' ? restRaw.slice(1) : restRaw;

async function main() {
  switch (cmd) {
    case 'open':
      return runOpen(rest);
    case 'run':
      return runRun(rest);
    case 'cloud':
      return runCloud(rest);
    case 'tom':
      return runTom(rest);
    case 'mcp':
      return runMcp(rest);
    case 'status':
      printSession(await readSession());
      console.log('\n--- cloud ---');
      printCloudSession(await readCloudSession());
      return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return;
    default:
      console.error('Unknown command: ' + cmd + '\n');
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  const lines = [
    'cypress-inspect - debug Cypress failures from an MCP agent',
    '',
    'USAGE',
    '  cypress-inspect open [-- <cypress args>]   Launch `cypress open` with CDP attached (default, fully supported)',
    '  cypress-inspect run  [-- <cypress args>]   Launch `cypress run` kept-open for inspection (EXPERIMENTAL)',
    '  cypress-inspect cloud [url] [--port N] [--headless]',
    '                                            Launch a CDP-enabled browser for Cypress Cloud Test Replay',
    '  cypress-inspect tom <cmd> [job|url]        Debug a CI failure from Tom\'s Allure pipeline reporter (see `tom help`)',
    '  cypress-inspect mcp                        Run MCP server over stdio',
    '  cypress-inspect status                     Show current session info (local + cloud)',
    '',
    'EXAMPLES',
    '  # In your webapp dir:',
    '  cypress-inspect open',
    '  # In another terminal (or via your agent MCP config):',
    '  cypress-inspect mcp',
    '',
    '  # Inspect a single spec in run mode (headed, kept open, snapshots retained):',
    '  cypress-inspect run -- --spec test/cypress/integration/run/my-spec.cy.js',
    '',
    'CLOUD MODE — for failures that only reproduce in CI',
    '  When a spec fails only in the pipeline, the evidence lives in Cypress Cloud',
    '  Test Replay, not in a local runner. `cypress-inspect cloud` opens a separate',
    '  Chrome with CDP enabled and a PERSISTENT profile (~/.cypress-inspect/cloud-profile),',
    '  so you log in to cloud.cypress.io once. Paste a Test Replay link (or pass it as',
    '  an argument) and the agent can read the recorded console output and take',
    '  screenshots at any point on the timeline via the cloud_* MCP tools.',
    '',
    '  It is fully isolated from `open`/`run` — separate browser, separate session',
    '  file, fixed port 9333 — so both can run at the same time.',
    '',
    '  --headless runs it with no window, for agents and unattended use. It cannot sign',
    '  you in: sign in once with a headed `cypress-inspect cloud`, then the persistent',
    '  profile carries the session over. For the MCP server, set',
    '  CYPRESS_INSPECT_CLOUD_HEADLESS=1 to make any auto-launched browser headless.',
    '',
    '    cypress-inspect cloud',
    '    cypress-inspect cloud "https://cloud.cypress.io/projects/…/replay?…"',
    '    cypress-inspect cloud --port 9444        # a second, independent browser',
    '    cypress-inspect cloud --headless         # no window (sign in headed once first)',
    '    cypress-inspect cloud --headless --window-size=1280,900',
    '    CHROME_PATH=/path/to/chrome cypress-inspect cloud',
    '',
    'RUN MODE (EXPERIMENTAL) — forces --headed --no-exit --browser chrome',
    '  --config numTestsKeptInMemory=50 so the command log / time-travel snapshots',
    '  survive for inspection. Drawbacks: multi-spec runs leave only the last spec',
    '  inspectable (use --spec); `rerun_spec` cannot re-trigger a run-mode spec.',
    '',
    'CONFIGURE FOR CLAUDE CODE (.mcp.json):',
    '  {',
    '    "mcpServers": {',
    '      "cypress-inspect": {',
    '        "command": "node",',
    '        "args": ["/abs/path/to/cypress-inspect/bin/cypress-inspect.js", "mcp"]',
    '      }',
    '    }',
    '  }',
  ];
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
