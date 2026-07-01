# Changelog

## 0.10.0

### Added
- **MCP tool annotations on every tool.** Read-only tools carry `readOnlyHint: true`
  (clients may auto-approve them); `cypress_docs` also sets `openWorldHint: true`.
- **Human-approval gating for the action tools.** `clear_app_state`, `rerun_spec`, and
  `reset_and_rerun` are marked `destructiveHint: true` and their descriptions now begin
  with "⚠ REQUIRES HUMAN APPROVAL — do not run autonomously; confirm with the user before
  calling." so agents don't trigger spec runs or wipe app state on their own. `eval` is
  marked `readOnlyHint: false` (it can mutate) so clients prompt rather than auto-approve.

### Changed
- **Trimmed all 35 tool descriptions** to cut the per-request token cost of the tool
  definitions (~22 KB → ~15.5 KB of description text, ≈29% smaller) without dropping any
  parameter semantics or usage guidance. This payload is sent to the model on every
  request, so the saving applies session-wide.
- README: documented the annotation scheme, added "requires human approval" markers to
  the three action tools, bumped the tools heading to v0.10, and corrected the stale
  "No write tools" limitation note.
