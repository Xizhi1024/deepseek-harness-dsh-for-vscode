# B2 Implementation Notes — Webview Bridge Protocol Single Source + Optional Handshake

Branch: `feature/0.6-b2-webview-protocol`

## Scope

- Eliminated duplicate Webview bridge channel/version/message-type literals by
  adding `src/protocol/webview.js` as the single source for extension-host code.
- Added an optional `dshWebviewHello` / `dshWebviewReady` handshake between the
  VS Code shell iframe and the DSH client. The handshake is an enhancement, not
  a gate: v1 clients that never send hello keep the existing passthrough.
- Client-side bridge requests wait for READY (or a 2s old-shell fallback) before
  sending `dshBridge`, preserving v1 compatibility with older shells.

## Changed / Added Files

### Added

- `src/protocol/webview.js` — protocol constants, validators, and message builders.
- `test/unit/webviewProtocol.test.js` — protocol/constants, framePage handshake
  simulation, client handshake wait/degrade simulation.
- `B2_IMPL_NOTES.md` — this file.

### Modified

- `src/interactionBridge.js` — imports protocol constants/validators; export
  surface unchanged (`CHANNEL`, `VERSION`, etc.).
- `src/threadAttachment.js` — imports protocol constants/validators; export
  surface unchanged.
- `src/webviewHtml.js` — injects protocol constants into the frame page script;
  sends `dshWebviewReady` on iframe load; handles `dshWebviewHello`; reports
  version mismatch to the extension host; keeps v1 passthrough.
- `src/webviewMessages.js` — routes `dshWebviewHello` mismatch messages to an
  optional `handshakeError` handler; exports the shared constants for tests.
- `src/extension.js` — wires `handshakeError` to the VS Code status bar.
- `runtime-integration/dsh-vscode-integration/lib/client.js` — sends
  `dshWebviewHello` when enabled; waits for `dshWebviewReady` before `dshBridge`;
  falls back to v1 passthrough after 2s without READY.
- `l10n/bundle.l10n.json`, `l10n/bundle.l10n.zh-cn.json` — status-bar copy for
  bridge version mismatch.

## Public Signatures

### `src/protocol/webview.js`

```js
CHANNELS = Object.freeze({
  INTERACTION: 'dsh-vscode-interaction',
  THREAD: 'dsh-vscode-thread',
});

VERSIONS = Object.freeze({
  INTERACTION: 1,
  THREAD: 1,
});

MESSAGE_TYPES = Object.freeze({
  BRIDGE: 'dshBridge',
  BRIDGE_RESULT: 'dshBridgeResult',
  THREAD_ATTACH: 'dshThreadAttach',
  THREAD_ATTACH_RESULT: 'dshThreadAttachResult',
  HELLO: 'dshWebviewHello',
  READY: 'dshWebviewReady',
});

isBridgeRequest(msg) -> boolean
isBridgeResult(msg) -> boolean
isThreadAttach(msg) -> boolean
isThreadResult(msg) -> boolean
isHello(msg) -> boolean
isReady(msg) -> boolean
helloMessage(version = VERSIONS.INTERACTION, capabilities = {}) -> object
readyMessage(version = VERSIONS.INTERACTION, capabilities = {}) -> object
```

### `src/webviewMessages.js`

```js
createWebviewMessageHandler({
  openBrowser,
  retry,
  interaction?,
  threadResult?,
  handshakeError?,
}) -> (message) => boolean
```

## Data Structures / Message Shapes

- Bridge request:
  `{ type: 'dshBridge', channel: 'dsh-vscode-interaction', version: 1, requestId, method, params }`
- Bridge result:
  `{ type: 'dshBridgeResult', channel: 'dsh-vscode-interaction', version: 1, requestId, ok, error? }`
- Thread attach:
  `{ type: 'dshThreadAttach', channel: 'dsh-vscode-thread', version: 1, requestId, text }`
- Thread result:
  `{ type: 'dshThreadAttachResult', channel: 'dsh-vscode-thread', version: 1, requestId, ok, error? }`
- Hello:
  `{ type: 'dshWebviewHello', channel: 'dsh-vscode-interaction', version, capabilities }`
- Ready:
  `{ type: 'dshWebviewReady', channel: 'dsh-vscode-interaction', version, capabilities }`
- Version-mismatch report (shell -> extension host):
  `{ type: 'dshWebviewHello', channel: 'dsh-vscode-interaction', version, ok: false, error: 'Webview 桥版本不匹配' }`

## Verification

- `npm test`: 154 tests / 153 pass / 1 skip / 0 fail.
- `npm run lint`: static checks passed for 62 JavaScript files and 6 JSON files.

## Unresolved Risks / Notes

- `runtime-integration/dsh-vscode-integration/lib/client.js` is a separate
  browser module loaded by the DSH runtime, so it cannot `require()` the new
  `src/protocol/webview.js`. It still declares the same literal values; the
  single-source guarantee currently applies to the extension-host files.
- The 2s no-READY path intentionally degrades to v1 passthrough rather than
  failing closed, matching the old-shell compatibility requirement.
- No new runtime npm dependencies were added.
