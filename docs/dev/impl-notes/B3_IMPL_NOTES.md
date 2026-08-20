# B3 Implementation Notes — CH1 v1/v2 negotiation + notification coalescer

Branch: `feature/0.6-b3-ch1-v2`
Scope: 0.6 B3 batch (CH1 v1/v2 negotiation, SM-6 notification merging).

## Changed / added files

- `src/protocol/ch1.js` (new)
  - Single source of truth for CH1 protocol constants.
  - `PROTOCOL_VERSIONS = Object.freeze([1, 2])`
  - `METHODS_BY_VERSION[1]` / `METHODS_BY_VERSION[2]`: same six request methods (B3 adds zero request methods).
  - `NOTIFICATIONS_BY_VERSION[1]`: existing three notifications.
  - `NOTIFICATIONS_BY_VERSION[2]`: existing three + `vscode/editor/selectionChanged`, `vscode/editor/activeEditorChanged`, `vscode/diagnosticsChanged`.
  - `V2_NOTIFICATION_SCHEMA`: metadata-only payload shapes for the three v2 notifications.

- `src/ch1/notifier.js` (new)
  - `createNotifier({ send, windowMs = 150, maxPending = 64 })` returns `{ push(method, params), flush(), dispose(), pendingCount, stats }`.
  - Coalesces by `method + params.uri`; later pushes for the same bucket replace the pending payload.
  - Flushes on `maxPending` distinct buckets or after `windowMs`.
  - `flush()` is idempotent; `send()` failures are swallowed and counted in `stats.sendFailures`.
  - `dispose()` clears the timer and pending queue without sending.

- `src/versionedBridgeServer.js` (modified)
  - Constructor now accepts `protocolVersions` (default `[1, 2]`). The legacy `protocolVersion` option is still accepted and maps to `[protocolVersion]`.
  - `initialize` validates `params.protocolVersion` is in the host set, returns `protocolVersion` (v1 payload unchanged) plus `acceptedProtocolVersion` for v2, and trims `methods` / `notifications` by the accepted version.
  - Empty/unsupported protocol set → `VSCODE_PROTOCOL_MISMATCH`.
  - `notify()` sends each notification only to connections whose negotiated version includes it.
  - Added `hasProtocolVersion(version)` and `hasV2Clients()` helpers.

- `src/extension.js` (modified)
  - Creates the CH1 notifier after the versioned bridge is started.
  - Registers `onDidChangeTextEditorSelection`, `onDidChangeActiveTextEditor`, and `languages.onDidChangeDiagnostics`.
  - Only pushes v2 metadata notifications when a v2 client is connected and the URI has approved attachments; otherwise the event is dropped (no queue leak).
  - `appliedEdits` is intentionally not implemented (parent plan marks it optional / v2.1).

- Tests (new, under `test/unit/`):
  - `ch1-protocol.test.js`
  - `notifier.test.js`
  - `versionedBridgeServer-v2.test.js`
  - `extension-notifications.test.js`

## Key interfaces

```js
// src/protocol/ch1.js
PROTOCOL_VERSIONS            // Object.freeze([1, 2])
METHODS_BY_VERSION           // { 1: string[], 2: string[] }
NOTIFICATIONS_BY_VERSION     // { 1: string[], 2: string[] }
V2_NOTIFICATION_SCHEMA       // { 'vscode/editor/selectionChanged': {...}, ... }

// src/ch1/notifier.js
createNotifier({ send, windowMs = 150, maxPending = 64 })
// => { push(method, params), flush(), dispose(), pendingCount, stats }

// src/versionedBridgeServer.js
new VersionedBridgeServer({ protocolVersions = [1, 2], ... })
server.hasProtocolVersion(version) // boolean
server.hasV2Clients()              // boolean
server.notify(method, params)      // version-filtered
```

## Data structures

- Notifier pending buckets: `Map<"method\nuri", { method, params }>`.
- Bridge connection record now includes `protocolVersion` after successful initialize.
- Initialize result:
  - v1: unchanged `{ protocolVersion, serverInfo, workspace, methods, notifications, maxFrameBytes }`.
  - v2: same fields plus `acceptedProtocolVersion`.

## Verification

- `npm test`: 159 tests, 158 pass, 1 skip, 0 fail.
- `npm run lint`: pass (66 JS files + 6 JSON files).

## Unresolved risks / deviations

- The v2-only `acceptedProtocolVersion` field is only added to the initialize result for v2 clients, preserving the v1 wire payload byte-for-byte. If the parent plan expected this field on v1 too, that is a one-line change.
- Selection/diagnostic notification disposables are stored in a module-level array and disposed both by the versioned-bridge context subscription and `deactivate()`, rather than being added as separate `context.subscriptions` entries, to keep the existing public subscription-count test unchanged.
- The notifier exposes `stats.sendFailures` as the diagnostic counter; the exact field name was not pinned by the task card.
- No new npm dependencies, no changes to frozen runtime/server manager files.
