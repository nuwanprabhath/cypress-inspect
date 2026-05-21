# cypress-inspect

Debug Cypress test failures from an LLM agent (Claude Code, Claude Desktop, VS Code, Cursor — anything with an MCP client).

Gives the agent the same toolkit a human uses when staring at a failing `cypress open`: read console, see screenshots, list the command log, click back through previous steps, inspect the DOM at any step, see all failures with their errors.

It works by attaching to Cypress's test browser via the Chrome DevTools Protocol. **No changes to your project's Cypress config are required.**

## How it works

`cypress-inspect open` wraps `cypress open`, turns on Cypress's internal browser debug logging, and scrapes the test-browser's CDP port out of stdout. The port + project cwd are written to `~/.cypress-inspect/session.json`.

`cypress-inspect mcp` runs an MCP server over stdio. It reads the session file, attaches to that CDP port, watches for console events, and exposes a curated toolset to the agent — most of which are short reads against the running spec runner's DOM and `window.Cypress`.

> **Cypress 15 architecture note:** `cypress open` launches an Electron App first (the project picker / launchpad). When you pick "Chrome", Cypress spawns a *separate* Chrome process for the spec. cypress-inspect discards the Electron port and locks onto the Chrome process. `Cypress.cy`, `Cypress.mocha`, and the reporter UI all live on the spec-runner page; the app-under-test is a same-origin iframe (`iframe.aut-iframe`) inside it.

## Install

```bash
git clone <this repo> ~/projects/pet-projects/cypress-inspect
cd ~/projects/pet-projects/cypress-inspect
npm install
```

### Claude Code

Register globally (works across all worktrees and projects):

```bash
claude mcp add --scope user cypress-inspect \
  node /absolute/path/to/cypress-inspect/bin/cypress-inspect.js mcp
```

Verify with `claude mcp list` and `/mcp` inside a Claude session.

### VS Code Copilot (GitHub Copilot Chat)

VS Code reads MCP server definitions from a `.vscode/mcp.json` file at the workspace root, or from your user settings. Choose the scope that fits.

**Workspace-level** (committed to the repo — good for teams):

Create `.vscode/mcp.json` in your webapp project:

```json
{
  "servers": {
    "cypress-inspect": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/cypress-inspect/bin/cypress-inspect.js", "mcp"]
    }
  }
}
```

**User-level** (applies to every workspace you open):

Open VS Code settings (`Cmd+,`), switch to JSON (`Open User Settings (JSON)`), and add:

```json
{
  "mcp": {
    "servers": {
      "cypress-inspect": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/cypress-inspect/bin/cypress-inspect.js", "mcp"]
      }
    }
  }
}
```

After saving, open Copilot Chat, switch to **Agent mode** (`@` → select the agent), and the `cypress-inspect` tools will appear in the tool picker. You can also reference them explicitly: `Use cypress-inspect get_overview to show me the failing tests.`

## Use

1. In your webapp project, launch Cypress through the wrapper:

   ```bash
   cd ~/projects/my-webapp
   cypress-inspect open
   # or: cypress-inspect open -- --e2e --browser chrome
   ```

   The Cypress App opens. Pick a browser → pick a spec. You'll see a line like:

   ```
   [cypress-inspect] Detected CDP port: 49948
   ```

2. In your agent, ask it to investigate. A good starter prompt:

   > "A Cypress test failed. Use cypress-inspect to debug it. Start with `get_overview`, then `get_failures` for the full list, then `step_to` and `get_dom` to inspect the state at the failing command."

## Tools (v0.6)

### Orientation
| Tool | Use |
| --- | --- |
| `status` | Session info + attached CDP targets. Always call if something returns "no Cypress". |
| `get_overview` | **Start here.** Spec file, pass/fail/pending counts, first failure (title + suite + error + stack + code frame), live test if any. |
| `get_failures` `{ dedupe? }` | All failed tests with error/stack/code-frame. Auto-tags `rootCause: true` on the first failure + `looksLikeCascade` / `cascadeOf` on downstream ones. Each failure also includes `relatedCommandIndex` / `relatedCommandNumber` pointing at the failed command in the reporter so the agent can `step_to` directly. Compare-style errors are parsed into `parsedDiff.diffs: [{ path, pathSegments, expected, actual }]`. Top-level `flakeSignals` is populated from TWO sources merged by id: the CDP console buffer **and** the reporter command-log (`/WARNING:/i` rows) — important because Cypress wraps `console.*` in the AUT iframe so the CDP buffer often misses warnings. Matching IDs also attach to the root failure. `dedupe: true` adds `rootCauses: [<index>]` and splits cascading failures into a separate array. |
| `parse_compare_error` `{ message }` | Standalone parser for "Compare - FAILURES" / "InProgress Summary Widget comparison failed" strings. Returns `{ summary: { failed, total }, diffs: [...] }`. |
| `list_tests` | Lightweight list of every test with state + title + suite ancestry. Use returned `index` with the next two tools. |
| `find_test` `{ query }` | Partial-title search across tests. Returns matches with index + state. Faster than scanning `list_tests`. |

### Command log
| Tool | Use |
| --- | --- |
| `get_test_commands` `{ index, full? }` | Commands rendered for the test at that reporter index. Each entry has `number` (display, may repeat across rows), `index` (unique DOM position), plus `argTruncated`/`argLength` markers. `full: true` returns untruncated args + text. Response also includes `numberToIndex` to resolve a displayed reporter number to a DOM index. |
| `get_live_commands` | `Cypress.cy.queue` for the in-flight test only. |
| `step_to` `{ testIndex, commandIndex \| commandNumber }` | Time-travel: pin the AUT snapshot to that command. Prefer `commandNumber` (the visible reporter number) — it's what humans see. Falls back to `commandIndex` (raw DOM position) when you need to disambiguate duplicated rows. Expands the panel if collapsed. |
| `expand_test` `{ index }` | Open a test panel without pinning a command. Useful when you just want to read commands or the error block. |
| `get_pinned_command` | Returns which command is currently pinned (driving the AUT snapshot). Sanity check after `step_to`. |

### Console / visual / DOM
| Tool | Use |
| --- | --- |
| `get_console_logs` `{ level?, grep?, since?, limit? }` | Buffered console events since the MCP server attached. Response always includes a capture-status header (`attached Xs ago, N events seen, M buffered, K contexts on T target(s)`); when the buffer is empty, full diagnostics are returned so callers can distinguish "nothing matched the filter" from "capture is broken". |
| `screenshot` `{ kind?: 'full' \| 'aut' }` | PNG of the whole runner viewport, or just the AUT iframe. |
| `list_saved_screenshots` / `read_saved_screenshot` | Cypress's `cypress/screenshots/` artifacts (relevant for `cypress run` mode). |
| `get_dom` `{ selector?, maxBytes? }` | Rendered HTML of the AUT iframe at the currently-pinned snapshot. |
| `find_in_aut` `{ selector, limit?, textOnly? }` | Run a CSS selector against the AUT. Default: compact JSON per match (tag, attrs, text, textTruncated, textLength, value, visible, disabled). `textOnly: true` returns just the **full untruncated text** of each match — best for summary widgets or anything where you only care what the user reads. |
| `get_aut_info` | AUT iframe src + location (href/pathname/hash/search) + document.title + readyState + navigator.onLine. Also returns a `capture` block with attached targets, execution contexts (with origin / aux frame data), and total events seen — useful for diagnosing why a console.* call might not be reaching the buffer. |

### Escape hatch
| Tool | Use |
| --- | --- |
| `eval` `{ expression }` | Arbitrary JS on the spec-runner page (where `window.Cypress`, the reporter DOM, and the AUT iframe all live). Use when the curated tools don't cover something. |

## Suggested debug flow for the agent

```
1. status              → confirm spec runner target present
2. get_overview        → spec + first failure + counts
3. get_failures        → if more than one failed, get them all
4. list_tests          → find the index of a specific test you want to dig into
5. get_test_commands i → see the command list, find the failed command's index
6. step_to i j         → pin the AUT to that step
7. get_dom + screenshot aut → see what the app looked like at that step
8. get_console_logs grep:"error" → cross-reference any browser errors
```

## Limitations / caveats

- **Cypress version**: written and verified against Cypress 15. Reporter class names (`.test.runnable.runnable-failed`, `.command-wrapper`, `.runnable-err-message`, etc.) are private to Cypress and may shift across versions — if a tool returns empty/`total: 0`, run the `eval` tool to discover the new class names and either tell the user or open a PR to `src/cypress-probe.js`.
- **`cypress open` with Chrome only**. Electron mode's CDP port isn't announced the same way. Pass `--browser chrome` (the wrapper adds it automatically).
- **Port-scrape fragility**: detection relies on Cypress's `cypress:server:browsers*` debug strings. If those change, you'll see no `[cypress-inspect] Detected CDP port:` line.
- **Console buffer is in-memory, capped at 5,000 entries**. Logs from before the MCP server attached are not captured. Best practice: start the MCP server, then run the failing spec.
- **No write tools.** The plugin is read-only by design — it scrapes/clicks the runner UI, never modifies your project files or Cypress config.

## Inspirations

- [`cypress-log-to-output`](https://github.com/flotwig/cypress-log-to-output) — captures browser console via CDP for `cypress run`.
- [`cypress-terminal-report`](https://github.com/archfz/cypress-terminal-report) — pipes logs to the terminal during CI.

`cypress-inspect` is closer to `cypress-log-to-output` in approach (CDP, no plugin install) but oriented at interactive `cypress open` and an MCP agent rather than CI output.
