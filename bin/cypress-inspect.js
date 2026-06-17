#!/usr/bin/env node
const { runOpen, runRun } = require('../src/launcher');
const { runMcp } = require('../src/mcp-server');
const { readSession, printSession } = require('../src/session');

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
    case 'mcp':
      return runMcp(rest);
    case 'status':
      return printSession(await readSession());
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
    '  cypress-inspect mcp                        Run MCP server over stdio',
    '  cypress-inspect status                     Show current session info',
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
