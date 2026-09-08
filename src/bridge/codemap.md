# src/bridge

## Responsibility

Server-side RPC handler factory for the v3a runtime bridge between the DSH host agent and the VS Code extension host. The single module exports `createV3Handlers(deps)`, which builds a map of method names (`vscode/terminal/create`, `vscode/changes/push`, `vscode/debug/*`, `vscode/mcp/*`, …) to async handler functions `(params, { signal }) => result`. Handlers wrap the VS Code API (`vscode.window`, `vscode.workspace`, `vscode.tasks`, `vscode.debug`, `vscode.extensions`, and the built-in `vscode.git` extension) behind validated, rate-limited, consent-gated tool surfaces. Errors are thrown as `Error` objects carrying a machine-readable `bridgeCode` (e.g. `VSCODE_TERMINAL_NOT_FOUND`, `VSCODE_CALL_EXPORT_TIMEOUT`).

## Design Patterns

- **Handler-map / dispatch table**: `createV3Handlers` returns `{ methodName: handler }`; the caller (extension.js) mounts it on the bridge transport and advertises mounted methods at initialize time.
- **Capability-based feature gating (policy-as-configuration)**: handlers exist only when a `getFlag(key)` setting is enabled. Consent gates (`dsh.bridge.terminal`, `dsh.bridge.ui`, `dsh.bridge.editorRead`) and L2 feature gates (`dsh.features.call-export`, `dsh.features.changes-review`, `dsh.features.mcp-consume`) conditionally register methods; unmounted methods never reach the advertisement, so DSH registers no tool.
- **Dependency injection via facade**: all VS Code access goes through an injected `vscode` facade (plus `appendOutputLine`, `getMcpManager`, `callExportJournal`), making handlers unit-testable without a live VS Code (see `test/unit/bridgeV3.test.js`).
- **Lazy resolver with graceful degradation**: `getMcpManager` resolves the MCP manager lazily; degraded (null) construction yields a visible `VSCODE_MCP_UNAVAILABLE` error instead of hiding the method. The proposed `onDidWriteTerminalData` API is probed with try/catch around both property access and subscription, degrading to a sendText-echo ring buffer.
- **Bounded resource pools / ring buffer**: per-terminal output ring (`RING_BYTES` = 8 KiB), `MAX_TERMINALS` = 8, `MAX_PROGRESS` = 2 with 120 s auto-end, `MAX_BREAKPOINTS` = 50, `MAX_FIND_FILES` = 500 with 5 s timeout and default exclude glob.
- **Timeout utilities**: `withTimeout` (undefined = dismissed, used for confirm prompts) and `callWithTimeout` (sentinel rejection, used for extension export calls).
- **Fail-closed consent**: `vscode/confirm/ask` treats timeout/dismissal as denial; `vscode/extensions/callExport` uses a modal Allow Once / Allow Session / Reject prompt with a per-session approval `Set` keyed by \`extensionId\\0method\`, plus a best-effort journal (`summarizeArgs` + `isJsonRoundTripLossless` argument validation).
- **Guard clauses / param validation**: `requireString`, `isRecord`, `v3Error` centralize input checking with `VSCODE_INVALID_PARAMS`.
- **1-based to 0-based coordinate translation** at the breakpoint boundary (bridge speaks 1-based lines/columns; `vscode.Position` is 0-based).

## Data & Control Flow

Inbound: DSH host → transport (mounted in extension.js \`activate\`) → `handlers[method](params)` → VS Code API → result JSON back to DSH.

Key sequences:

- **Terminal**: \`terminal/create\` makes a \`Terminal\`, stores \`{ terminal, ring }\` in a Map under id \`t<n>\`; \`terminal/sendText\` calls \`Terminal.sendText\` and appends the echoed text to the ring; if \`onDidWriteTerminalData\` is entitled, real process output is also mirrored into the ring (terminal-instance matched); \`terminal/read\` concatenates the ring and returns the last \`maxBytes\` with a \`truncated\` flag.
- **Tasks/Debug**: \`tasks/list\` filters \`fetchTasks()\` to \`source === 'Workspace'\`; \`tasks/run\` matches by name then \`executeTask\`. \`debug/start\` parses each workspace folder's \`.vscode/launch.json\` directly, matches by name, calls \`startDebugging\`; \`debug/getStack\` issues \`session.customRequest('stackTrace')\`; breakpoints use the official \`addBreakpoints\`/\`removeBreakpoints\` with \`SourceBreakpoint\` construction (never DAP \`setBreakpoints\`, to preserve UI bookkeeping).
- **Editor**: \`editor/getState\` returns metadata only (uri, languageId, dirty, selection); \`editor/read\` (consent-gated) opens a document by uri or reads the active editor and returns full text.
- **Changes/push** (L2): \`validateWireEdits\` checks structure → \`assertEditsWithinDocuments\` rejects out-of-range coordinates before writing → \`tracker.snapshotBefore\` → \`tracker.applyEdits\` → \`tracker.record\` journals a before-snapshot with status \`accepted\`; returns \`{ applied, changeIds }\`. Permission is single-sourced from the DSH sandbox (legacy \`mode\` field validated for shape only, ignored).
- **callExport** (L2): validate extensionId (publisher.name regex), method length, args JSON round-trip → consent check (session approval set, else modal prompt, 120 s timeout = reject) → activate extension → invoke export method under 30 s \`callWithTimeout\` → journal success/failure summary.
- **Git**: \`git/getStatus\` / \`git/getDiff\` lazily activate the built-in \`vscode.git\` extension and read \`repo.state.workingTreeChanges\` / \`repo.diffWithHEAD(pathspec)\`.
- **Progress**: \`withProgress\` promise held open by a resolver; \`progress/report\` forwards message/increment; \`progress/end\` or a 120 s timer resolves it (auto-end).
- **State transitions**: terminal Map grows to \`MAX_TERMINALS\` then throws \`VSCODE_TERMINAL_LIMIT\`; progress handles cycle created → auto-ended; sessionApprovals set grows monotonically per (extension, method) pair.

## Integration Points

Dependencies (imports):

- \`node:assert\` (\`deepStrictEqual\` for JSON round-trip checks)
- \`../changeTracker\` — \`createChangeTracker\`, \`validateWireEdits\`, \`assertEditsWithinDocuments\`, \`MAX_LABEL_CHARS\` (edit validation, snapshots, journaling for \`changes/push\`)
- Injected at construction: the \`vscode\` facade, \`getFlag\` settings reader, \`appendOutputLine\` (DSH OutputChannel sink), \`changeTracker\`, \`mcpManager\`/\`getMcpManager\` (lazy MCP manager), \`callExportJournal\` (\`{ record(entry) }\` sink, wired by E-T2b)

Consumers:

- \`src/extension.js\` — calls \`createV3Handlers({...})\` during activation (L0/L2 lifeline), wiring \`appendOutputLine: appendDiagnostic\`, \`getMcpManager\`, and the callExport journal instance
- \`test/unit/bridgeV3.test.js\` — unit tests importing \`createV3Handlers\` and the exported limit constants
- \`src/commands/ctrlIEdit.js\` — documents cross-references to \`MAX_FIND_FILES\` and the 120 s dismissal behavior

## Files

- \`v3.js\` (~843 lines) — the entire v3a bridge: `createV3Handlers` factory building all consent/feature-gated `vscode/*` RPC handlers over the injected VS Code facade, with timeout/limit helpers and exported guard constants.
- \`codemap.md\` (~this file) — folder architecture map.
