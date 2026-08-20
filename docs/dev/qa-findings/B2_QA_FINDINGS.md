# B2 QA Findings — 0.6 B2 Batch Test Reinforcement

> **Status: fixed in 0.6.0 (release/0.6.0).** The two findings below were
> resolved together with the protocol request-id hardening; the previously
> skipped tests in `test/unit/webviewB2QA.test.js` are enabled and passing.

Branch: `qa/0.6-b2-test`
Base commit: `24c07bc` (master `c327e10` contains B0+B1+B2)
Scope: test-only reinforcement per plan §5.2 QA-T. No product code (`src/**`,
`runtime-integration/**`) was modified.

## Summary

- New test file: `test/unit/webviewB2QA.test.js` (17 tests, 15 pass, 2 skipped).
- The two skipped tests encode product findings below.
- No existing test expectations were changed.

---

## B2-01: framePage forwards `dshBridge` with overlong/NUL requestId to VS Code

**Severity:** Medium (malicious iframe content can push malformed bridge requests
into the extension host; extension-host parser currently rejects them, but the
shell should not be a forwarding hole).

**现象 (Phenomenon)**
The shell `framePage` message listener only checks `type === 'dshBridge'`,
`channel === CHANNELS.INTERACTION`, and `version === VERSIONS.INTERACTION`. It
does not validate `requestId`. A message from the frame with an overlong
(`>200`) or NUL-containing `requestId` is forwarded to `vscode.postMessage`.

**复现 (Reproduction)**
1. Run the `framePage` inline script in a VM harness (see
   `test/unit/webviewB2QA.test.js`).
2. Fire a window message with:
   - `source === frame.contentWindow`
   - `origin === DSH_ORIGIN`
   - data `{ type: 'dshBridge', channel: 'dsh-vscode-interaction', version: 1, requestId: 'x'.repeat(201), method: 'clipboard/writeText', params: { text: 'x' } }`
3. Assertion `postedToVscode.length === 0` fails; the shell posts the message.

**建议 (Suggested fix)**
- Validate bridge messages at the shell before forwarding, ideally by reusing
  `protocol.isBridgeRequest()` plus the existing `REQUEST_ID` rule
  (`^[A-Za-z0-9_-]{1,100}$`) used by `interactionBridge.js` /
  `threadAttachment.js`.
- Consider moving the request-id validation into `src/protocol/webview.js` so
  shell and client share the same rule.

**Test:** `B2 QA framePage rejects overlong/NUL bridge request ids without
forwarding` is skipped with `QA finding B2-01`.

---

## B2-02: client replies with a failure `THREAD_ATTACH_RESULT` for overlong/NUL requestId

**Severity:** Low-Medium (malformed parent message trivially triggers an echo
response; no pending map entry is created, but it violates "malicious messages
are silently rejected").

**现象 (Phenomenon)**
In `runtime-integration/dsh-vscode-integration/lib/client.js`,
`handleThreadAttach` does not validate `requestId` before starting work. When
`requestId` is overlong (`>200`) or contains NUL, `attachToDraft` throws
`Invalid DSH thread request id`, and the client posts a
`dshThreadAttachResult` with `ok: false` and the same invalid `requestId` back
to the parent.

**复现 (Reproduction)**
1. Load `client.js` with `dsh_embed=vscode` and apply it in a VM harness.
2. From `window.parent`, send:
   - `{ type: 'dshThreadAttach', channel: 'dsh-vscode-thread', version: 1, requestId: 'x'.repeat(201), text: 'selected code' }`
3. The client posts a `dshThreadAttachResult` to the parent, instead of
   ignoring the message.

**建议 (Suggested fix)**
- Add the same `REQUEST_ID` check (`/^[A-Za-z0-9_-]{1,100}$/`) at the top of
  `handleThreadAttach` (or before `threadRequests.set`).
- Return early / ignore malformed thread-attach messages without posting a
  result, matching the "reject silently" policy for other malformed messages.

**Test:** `B2 QA client rejects overlong/NUL THREAD_ATTACH request ids without
sending a result` is skipped with `QA finding B2-02`.

---

## Not considered product bugs

- `client.js` keeps protocol channel/version literals because it is a separate
  DSH runtime browser module; it has comments/back-compat notes and matches
  the orchestration ruling.
- The 2s no-READY path intentionally degrades to v1 passthrough (orchestration
  ruling), so this QA pass treats it as expected behavior.
- `helloMessage`/`readyMessage` accept non-1 versions as builders; consumers
  explicitly report/ignore unsupported versions at the boundary. No change
  recommended for this QA-T pass.