#!/usr/bin/env node
const { runOpen } = require('../src/launcher');
const { runMcp } = require('../src/mcp-server');
const { readSession, printSession } = require('../src/session');

const [, , cmd, ...rest] = process.argv;

async function main() {
  switch (cmd) {
    case 'open':
      return runOpen(rest);
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
    '  cypress-inspect open [-- <cypress args>]   Launch Cypress with CDP attached',
    '  cypress-inspect mcp                        Run MCP server over stdio',
    '  cypress-inspect status                     Show current session info',
    '',
    'EXAMPLES',
    '  # In your webapp dir:',
    '  cypress-inspect open',
    '  # In another terminal (or via your agent MCP config):',
    '  cypress-inspect mcp',
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
