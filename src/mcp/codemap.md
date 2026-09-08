# src/mcp

## Responsibility

MCP (Model Context Protocol) **consume-side Service Layer** for the extension. This folder implements everything needed to discover, configure, authorize, connect to, and invoke third-party MCP servers (stdio child processes and streamable-HTTP/SSE endpoints) using JSON-RPC 2.0. It is deliberately UI-free and side-effect-free at construction time (comment in `manager.js`: "L0-safe: no UI registration, no spawn until the first listTools/callTool"); all VS Code surface area (`window.showInputBox`, `window.showWarningMessage`, `globalState`, `secretStorage`) is injected as a facade. `manager.js` acts as the single **Facade** the rest of the extension programs against; `transportStdio.js` and `transportHttp.js` are **Adapters** that normalize two wire transports behind one identical `{ start, request, dispose }` client contract.

## Design Patterns

- **Facade / Mediator** — `createMcpManager` (`manager.js`) owns config aggregation, consent, client lifecycle, pagination, and result capping behind `{ listServers, listTools, callTool, refresh, dispose }`.
- **Strategy (transport polymorphism)** — `ensureClient` picks `createStdioMcpClient` (`server.type === 'stdio'`) or `createHttpMcpClient` (`http`/`sse`); both return a frozen object with the same `start/request/dispose` shape.
- **Template-Method-ish shared core / composition** — `jsonRpc.js`'s `McpJsonRpcClient` is a shared newline-delimited JSON-RPC 2.0 client used by the stdio transport; the HTTP transport re-implements `request` over fetch because each HTTP request carries its own id.
- **Dependency Injection / Seams** — every factory takes injected seams: `spawn` (child_process), `fetchImpl` (fetch), `env`, `logger`, `secretStorage`, `loc` (localization), and a `vscode` facade object — making the modules unit-testable without VS Code.
- **Registry / Cache** — `manager.js` keeps `clients: Map`, `inputCaches: Map` (per-server input cache), `toolCounts: Map`, and `lastServers`.
- **Promise correlation table** — `McpJsonRpcClient.pending: Map<id, waiter>` matches responses to requests with per-request timers and AbortSignal listeners; `close()` fails all pending waiters.
- **Fail-closed timeouts** — `withTimeout` (in both `consent.js` and `manager.js`) resolves `undefined` after 120 s, treated as rejection/missing input.
- **Gate / Guard** — `createConsentGate` (`consent.js`) is a per-server first-use authorization gate persisted in `globalState` under `dsh.mcp.consentedServers`, revocable via the `dsh.mcp.forgetConsent` command.
- Key exported functions/classes: `mergeMcpSources`, `expandServer`, `normalizeServer` (config); `McpJsonRpcClient`, `McpRpcError` (jsonRpc); `createStdioMcpClient`; `createHttpMcpClient`, `parseSsePayload` (transportHttp); `createConsentGate` (consent); `createMcpManager`, `isSecretKeyName` (manager).

## Data & Control Flow

1. **Config aggregation** (`config.js`): `mergeMcpSources(sources)` merges ordered sources (user settings -> remote settings -> workspace settings -> `.vscode/mcp.json`, later wins, each override emits a diagnostic), normalizing each entry via `normalizeServer` (validates `command` for stdio, `url` for http/sse; deep-copies args/env/headers).
2. **Variable expansion** (`config.js`): `expandServer` walks all string fields (`serverFields`: command, url, cwd, args[], env{}, headers{}). `${env:NAME}` is expanded silently from the injected env; a missing var disables the server with reason `env-missing: ...`. `${input:name}` is resolved per (server, name) via the injected `askInput` (120 s fail-closed) and cached in the session `inputCache`; a missing input disables with `input-missing: ...`.
3. **Secret-aware prompting** (`manager.js` `askInput`): before prompting, the VS Code `secretStorage` is checked under the same key name (zero-typing, values shared with other extensions); `isSecretKeyName` (`/KEY|TOKEN|SECRET|PASSWORD/i`) enables password masking; successful prompts are written back to `secretStorage` best-effort.
4. **Listing** (`manager.listServers`): `getSources()` -> `loadServers()` -> each server annotated with state `ready` / `consent-required` / `disabled` / `error` plus `reason` and cached `toolCount`.
5. **Consent gate** (`consent.js` `ensureConsent`): if the name is not already in `globalState['dsh.mcp.consentedServers']`, shows a modal `showWarningMessage` ("DSH wants to use the MCP server ...") with Allow/Reject, 120 s fail-closed; Allow persists the name.
6. **Connection** (`manager.ensureClient`): lazily creates the transport client on first `listTools`/`callTool` and calls `start()`, which sends the MCP `initialize` request (protocol `2024-11-05`, clientInfo `dsh-vs-sidebar 0.6.0`); stdio then sends `notifications/initialized`.
7. **stdio transport** (`transportStdio.js`): spawns the server command (merged env, optional cwd, `windowsHide`), pipes stdin/stdout into `McpJsonRpcClient` (one JSON-RPC frame per line); stderr is logged; child exit closes the RPC client and rejects pending requests. Timeouts: 60 s for `tools/call`, 15 s otherwise. AbortSignal cancellation sends `notifications/cancelled`.
8. **HTTP transport** (`transportHttp.js`): one POST per request with `Accept: application/json, text/event-stream`; captures `Mcp-Session-Id` from responses and replays it on subsequent requests; parses SSE `data:` lines when the content type is `text/event-stream` and picks the message whose id matches. Errors map to `McpRpcError` codes (`MCP_HTTP_ERROR`, `MCP_PROTOCOL_ERROR`, ...).
9. **Tool listing** (`manager.listTools`): paginates `tools/list` following `nextCursor`, caches the count in `toolCounts`; on transport error it disposes and evicts the client and returns a structured error object (never throws).
10. **Tool calls** (`manager.callTool`): re-checks consent (throws error with code `MCP_CONSENT_REQUIRED`), sends `tools/call` (60 s), normalizes the result into an MCP content payload, and caps the JSON-serialized result at `MAX_RESULT_BYTES` (1 MiB), returning `{ content, truncated: true, isError }` when oversized.
11. **Teardown**: `refresh()` disposes all clients and clears caches/`lastServers` (wired to `dsh.mcp.refresh`); `dispose()` additionally sets `disposed = true` so later calls short-circuit.

## Integration Points

- **Dependencies (imports)**: only intra-folder requires — `manager.js` -> `./config`, `./transportStdio.js`, `./transportHttp.js`; `transportStdio.js` -> `./jsonRpc`; `transportHttp.js` -> `./jsonRpc` (`McpRpcError` only). `config.js` and `consent.js` are dependency-free. External integrations are injected: Node `child_process.spawn` seam, `fetch` seam, `process.env`, and the VS Code API facade (`window.showInputBox`, `window.showWarningMessage`, `globalState`, `secretStorage`).
- **Consumers**: `src/extension.js` is the sole importer — it requires `createMcpManager` from `./mcp/manager` and `createConsentGate` from `./mcp/consent`, wires them together (the manager receives the consent gate, `getSources`, spawn, fetch, secretStorage, logger), stores the manager in `services.mcpManager`, and passes `getMcpManager` into `src/bridge/v3.js` (`createV3Handlers`), which exposes the MCP handlers behind the harness `vscode_mcp_list_tools` / `vscode_mcp_call_tool` tools. No subfolders of `src/mcp` currently exist.
- **Commands**: `dsh.mcp.refresh` (calls `mcpManager.refresh()` when the `mcp-consume` feature flag is on) and `dsh.mcp.forgetConsent` (QuickPick over `consentGate.list()`, then `consentGate.forget(name)` + refresh).
- **State keys / protocols**: `globalState['dsh.mcp.consentedServers']`; secretStorage keys equal to env-style key names (e.g. `OPENAI_API_KEY`); MCP protocol version `2024-11-05`; settings key `mcp.servers` and workspace file `.vscode/mcp.json` (`{ "servers": { ... } }`, VS Code MCP shape).

## Files

- `config.js` (~240 lines) — Pure config layer: merges ordered MCP server sources, normalizes/validates records, expands `${env:}`/`${input:}` variables with prompt-and-cache semantics.
- `jsonRpc.js` (~146 lines) — Shared newline-delimited JSON-RPC 2.0 client core (`McpJsonRpcClient`): request-id correlation, timeouts, AbortSignal cancellation, error type `McpRpcError`.
- `transportHttp.js` (~123 lines) — Streamable-HTTP/SSE MCP client factory: one POST per request, `Mcp-Session-Id` echo, SSE `data:` parsing; exports `parseSsePayload`.
- `transportStdio.js` (~81 lines) — stdio MCP client factory: spawns the server process, bridges stdin/stdout to `McpJsonRpcClient`, initialize handshake, kill-on-dispose.
- `consent.js` (~107 lines) — Per-server first-use consent gate persisted in `globalState`; fail-closed modal prompt (120 s) and `forget`/`list` for revocation.
- `manager.js` (~258 lines) — Facade/aggregator: source loading, secretStorage-backed input prompts, consent checks, lazy transport selection, paginated `tools/list`, 1 MiB-capped `tools/call`, refresh/dispose.
