# src/protocol

## Responsibility

Protocol contract layer (Shared Kernel / Contracts module) for the dsh-vs-sidebar extension. This folder is the single source of truth for the wire protocol spoken between the VS Code extension host and the DSH Webview/sidebar. It defines two independent contract families:

- **webview.js** — the low-level message envelope protocol over the VS Code webview `postMessage` bridge: channel names, protocol versions, message types, request-id grammar, and predicate/constructor functions for each message shape.
- **ch1.js** — the higher-level "CH1" versioned JSON-RPC-style contract: which protocol versions exist (1–3), which request methods and server-push notifications each version supports, the metadata-only v2 notification payload schema, and a validator enforcing it.

Both modules are pure, dependency-free Plain Old JavaScript with **no VS Code API usage and no runtime dependencies**, so they can be imported safely by both the extension host and generated Webview shell scripts.

## Design Patterns

- **Single Source of Truth / Constants module**: all channel/version/type literals are declared once here (`CHANNELS`, `VERSIONS`, `MESSAGE_TYPES`, `PROTOCOL_VERSIONS`) instead of being re-declared at call sites.
- **Specification Pattern (validation predicates)**: `isBridgeRequest`, `isBridgeResult`, `isThreadAttach`, `isThreadResult`, `isHello`, `isReady`, `hasValidRequestId` — pure boolean guards that encapsulate message-shape rules.
- **Factory Method**: `helloMessage()` / `readyMessage()` construct handshake messages with sensible defaults (version, capabilities).
- **Immutability via `Object.freeze`**: every exported constant table (method lists, notification lists, schema) is deeply frozen so the contract cannot be mutated at runtime.
- **Schema Validation / Whitelist enforcement**: `validateV2NotificationParams(method, params)` with `V2_NOTIFICATION_SCHEMA` and `matchesWireType` — closed-world validation that rejects missing fields, wrong wire types, and any undeclared field (preventing document-text smuggling through the metadata channel).
- **Versioned capability tables**: `METHODS_BY_VERSION` / `NOTIFICATIONS_BY_VERSION` — cumulative, append-only version layering (v2 extends v1, v3 extends v2).
- **Regex grammar**: `REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/` shared by shell, extension-host parsers, and the DSH client so malformed ids are dropped before forwarding.

### Key exported API

**webview.js**: `CHANNELS` (`dsh-vscode-interaction`, `dsh-vscode-thread`), `VERSIONS` (both 1), `MESSAGE_TYPES` (`dshBridge`, `dshBridgeResult`, `dshThreadAttach`, `dshThreadAttachResult`, `dshWebviewHello`, `dshWebviewReady`), `REQUEST_ID`, `hasValidRequestId`, `isBridgeRequest`, `isBridgeResult`, `isThreadAttach`, `isThreadResult`, `isHello`, `isReady`, `helloMessage`, `readyMessage`.

**ch1.js**: `PROTOCOL_VERSIONS` = [1, 2, 3]; `METHODS_V1/V2/V3` (v1/v2: 6 editor/workspace/extensions methods; v3 adds ~28 terminal/tasks/debug/git/editor/progress/statusbar/output/confirm/changes/mcp methods); `NOTIFICATIONS_V1/V2/V3` (v1: `vscode/contextChanged`, `vscode/providerStatesChanged`, `vscode/workspaceChanged`; v2 adds `selectionChanged`, `activeEditorChanged`, `diagnosticsChanged`; v3 adds `vscode/dshEditObserved`); `METHODS_BY_VERSION`, `NOTIFICATIONS_BY_VERSION`, `V2_NOTIFICATION_SCHEMA`, `validateV2NotificationParams`.

## Data & Control Flow

This layer produces and validates data; it owns no state and no I/O.

**Inbound (webview → extension host)**: raw `postMessage` payloads arrive at the extension host's message parsers (`src/webviewMessages.js`, `src/interactionBridge.js`, `src/threadAttachment.js`), which call the `is*` predicates to classify and drop malformed messages before any side effect. A valid bridge request must match type `dshBridge` + channel `dsh-vscode-interaction` + version 1 + valid requestId + non-empty string `method` + object `params`. Results flow back as `dshBridgeResult` carrying the same requestId and an `ok` boolean.

**Handshake lifecycle**: the shell sends `dshWebviewHello` (built via `helloMessage()`, optionally advertising capabilities); the host responds/acknowledges with `dshWebviewReady` (`readyMessage()`) — both on the interaction channel, unconstrained by requestId.

**Thread attachment**: a separate channel `dsh-vscode-thread` carries `dshThreadAttach` (requestId + text) and `dshThreadAttachResult` (requestId + ok), decoupled from the general interaction channel.

**CH1 version negotiation**: the initialize handshake advertises `PROTOCOL_VERSIONS`; the host serves the negotiated version's method table (`METHODS_BY_VERSION`). Only methods with a registered live handler are advertised to DSH tool registration, so unimplemented v3 entries never reach a tool. Requests dispatch to methods like `vscode/editor/open`, `vscode/debug/start`, `vscode/mcp/callTool`; server-push notifications (`vscode/diagnosticsChanged`, `vscode/dshEditObserved`, etc.) flow host→client with metadata-only payloads. `validateV2NotificationParams` runs on v2+ notification params before dispatch: it throws `TypeError` on missing/mistyped/undeclared fields — notably rejecting `content`/`body` fields so document text cannot bypass the metadata channel. `vscode/dshEditObserved` (v3+) is fired by the DSH plugin after an edit/write tool pre-execute with payload `{tool, path, sessionId, size, truncated}`.

## Integration Points

**Dependencies (imports)**: none — both files import nothing (zero runtime dependencies, no VS Code API), by explicit design.

**Consumers (who imports this folder)**:
- `src/webviewMessages.js`, `src/interactionBridge.js`, `src/threadAttachment.js` — extension-host message parsing/routing (webview.js contract).
- `src/webviewHtml.js` — injects protocol constants into the generated Webview shell.
- `src/versionedBridgeServer.js`, `src/ch1/notifier.js` — CH1 versioned bridge server and notification validation (ch1.js contract).
- `scripts/check-package-contents.js` — packaging checks referencing both modules.
- Tests: `test/contracts.test.js`, `test/versionedBridgeServer.test.js`, `test/versionedBridgeCross.test.js`, `test/versionedBridgeServer-dshEditObserved.test.js`, `test/unit/bridgeV3.test.js`, `test/unit/ch1-protocol.test.js`, `test/unit/webviewB2QA.test.js`, `test/unit/webviewProtocol.test.js`.

**Named events/channels/methods**: channels `dsh-vscode-interaction` / `dsh-vscode-thread`; message types `dshBridge`, `dshBridgeResult`, `dshThreadAttach`, `dshThreadAttachResult`, `dshWebviewHello`, `dshWebviewReady`; CH1 method namespaces `vscode/editor/*`, `vscode/workspace/*`, `vscode/extensions/*`, `vscode/terminal/*`, `vscode/tasks/*`, `vscode/debug/*`, `vscode/git/*`, `vscode/progress/*`, `vscode/statusbar/*`, `vscode/output/*`, `vscode/confirm/*`, `vscode/changes/*`, `vscode/mcp/*`, `vscode/window/*`; notifications `vscode/contextChanged`, `vscode/providerStatesChanged`, `vscode/workspaceChanged`, `vscode/editor/selectionChanged`, `vscode/editor/activeEditorChanged`, `vscode/diagnosticsChanged`, `vscode/dshEditObserved`.

## Files

- **webview.js** (~140 lines) — Frozen constants (channels, versions, message types), request-id regex, `is*` shape predicates, and `helloMessage`/`readyMessage` factories for the webview postMessage envelope protocol.
- **ch1.js** (~171 lines) — CH1 versioned contract: protocol versions 1–3, per-version request-method and notification tables, frozen v2 metadata-only notification schema, and `validateV2NotificationParams` whitelist validator.
- **codemap.md** — this documentation file.
