# B3 QA Findings

> **Status: fixed in 0.6.0 (release/0.6.0).** `V2_NOTIFICATION_SCHEMA` is now
> enforced at both the `VersionedBridgeServer.notify()` and
> `createNotifier.push()` boundaries; the previously skipped tests in
> `test/unit/b3-qa-*.test.js` are enabled and passing.

Branch: `qa/0.6-b3-test`
Scope: CH1 v1/v2 negotiation, notifier, v2 metadata notifications.

## B3-01: `VersionedBridgeServer.notify` does not enforce `V2_NOTIFICATION_SCHEMA`

- **Phenomenon**: Calling `server.notify('vscode/editor/selectionChanged', { uri, version, attachmentIds, content: '...' })` (and equivalent `activeEditorChanged` / `diagnosticsChanged` payloads with a `content`/`body` field) sends the full payload to connected v2 clients. No rejection and no cropping occurs.
- **Repro**: Start `VersionedBridgeServer`, initialize a v2 client, then:
  ```js
  server.notify('vscode/editor/selectionChanged', {
    uri: 'file:///a.ts',
    version: 1,
    attachmentIds: ['ctx-1'],
    content: 'body should be rejected',
  });
  ```
  The v2 client receives a `vscode/editor/selectionChanged` notification whose `params` still contains `content`.
- **Expected**: `V2_NOTIFICATION_SCHEMA` is enforced at the `notify` boundary; payloads with disallowed `content`/`body` fields are rejected or cropped before being written, while legal metadata-only payloads continue to pass.
- **Suggested fix**: In `VersionedBridgeServer.notify` (or in a shared validator used by `notify`), validate v2-only notification params against `V2_NOTIFICATION_SCHEMA` before `_write`. The schema contract already exists in `src/protocol/ch1.js` but is currently not consulted at runtime.
- **QA tests**: `test/unit/b3-qa-versionedBridge.test.js` contains a skipped test (`QA finding B3-01`) that will run once enforcement is added.

## B3-02: `createNotifier.push` does not enforce `V2_NOTIFICATION_SCHEMA`

- **Phenomenon**: `createNotifier` accepts and flushes v2 notification payloads containing `content`/`body` fields. `push(method, params)` only checks that `params` is an object; it does not consult `V2_NOTIFICATION_SCHEMA`.
- **Repro**:
  ```js
  const notifier = createNotifier({ send: (m, p) => {} });
  notifier.push('vscode/editor/selectionChanged', {
    uri: 'file:///a.ts',
    version: 1,
    attachmentIds: ['ctx-1'],
    content: 'body should be rejected',
  });
  notifier.flush();
  // send sink receives the content field.
  ```
- **Expected**: Since notifier is the extension-side gateway for v2 metadata notifications, it should reject (or strip) payloads that violate the v2 metadata-only contract so invalid data never enters the coalescer.
- **Suggested fix**: Validate params against `V2_NOTIFICATION_SCHEMA[method]` in `push` before `pending.set`, or add a schema validator and call it from `push` and from `VersionedBridgeServer.notify`.
- **QA tests**: `test/unit/b3-qa-notifier.test.js` contains a skipped test (`QA finding B3-02`) that will run once enforcement is added.

## Verified areas

No other product bugs were found in the QA-T scope. The following behaviors pass on the current code:

- Missing initialize token follows the existing `VSCODE_AUTH_FAILED` path.
- Missing/non-integer/string `protocolVersion` is rejected with `VSCODE_PROTOCOL_MISMATCH`.
- Exact `maxFrameBytes` request frames are accepted and `maxFrameBytes + 1` frames are rejected for both v1 and v2 clients.
- v2-only metadata notifications reach v2 clients only; a mixed v1+v2 stream keeps legacy notifications flowing to both.
- Notifier dispose makes later `push`/`flush` a no-op without changing stats.
- Same method+uri push coalesces to the last params and flush empties the pending map.
- Extension deactivate clears notification subscriptions/notifier so later selection/diagnostics events do not send.