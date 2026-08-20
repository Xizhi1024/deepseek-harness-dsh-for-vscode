# B4 Implementation Notes — 0.6 manifest shell + command thin shell + dsh.addFileToThread

Branch: `feature/0.6-b4-shell`

## Scope

This batch adds:

1. Manifest shell: `dsh.addFileToThread` command declaration, activation event,
   editor-title-context / explorer-context menu entries, and the
   `dsh.focusSidebar` keybinding (`ctrl+alt+b`).
2. Command thin-shell scaffolding: `src/commands/shell.js`.
3. First command using the shell: `dsh.addFileToThread`, implemented in
   `src/commands/addFileToThread.js`.
4. `formatFileAttachment()` in `src/threadAttachment.js` (file link, no line
   range, same `dsh-vscode.invalid/attachment/ctx-N` protocol).
5. Tests for manifest contracts, command shell NullAdapter / real-adapter
   paths, and addFileToThread end-to-end with a fake coordinator.

## Changed files

Modified:

- `package.json` — command/activation/keybinding/menu contributions.
- `package.nls.json`, `package.nls.zh-cn.json` — new command title.
- `l10n/bundle.l10n.json`, `l10n/bundle.l10n.zh-cn.json` — new runtime strings.
- `src/extension.js` — wire `dsh.addFileToThread` through the command shell.
- `src/threadAttachment.js` — added `formatFileAttachment`.
- `test/contracts.test.js` — menu/keybinding/command/activation assertions.
- `test/extension.test.js` — updated registered command list / subscription count.
- `test/threadAttachment.test.js` — file-attachment formatter tests.

Added:

- `src/commands/shell.js`
- `src/commands/addFileToThread.js`
- `test/unit/commands.test.js`
- `test/unit/addFileToThread.test.js`
- `B4_IMPL_NOTES.md`

## Interface signatures

- `createCommandShell({ router }) -> { register(vscode, commandId, capabilityId, run) }`
  - `router.get(capabilityId)` must return an adapter, or `NullAdapter` /
    `null` / `undefined` to indicate unavailable.
  - When unavailable, the shell calls
    `vscode.window.showInformationMessage('Capability unavailable')` and does
    not invoke `run`.
  - `run(...args)` is invoked after a non-null adapter is resolved.
- `NullAdapter` — frozen sentinel exported by `src/commands/shell.js`.
- `createAddFileToThreadCommand({ vscode, editorContext, coordinator, formatFileAttachment, waitForResolvedView, ensureConnected, loc? }) -> async () => {}`
  - Flow: `editorContext.attachActiveFile()` →
    `formatFileAttachment(attachment, attachment.document.uri)` →
    `coordinator.request(view.webview, text)`.
  - Focuses the DSH sidebar and waits for the resolved Webview before posting.
- `formatFileAttachment(attachment, label) -> string`
  - Requires `attachment.kind === 'active-file'`, a `ctx-N` id, and string content.
  - Produces `[<filename>](https://dsh-vscode.invalid/attachment/<id>)` with no
    line range.

## Data structures

- Router adapters are opaque to the shell. This batch uses a placeholder router
  in `src/extension.js` that returns `{ id: 'dsh.addFileToThread' }` for the one
  capability and `NullAdapter` for everything else.
- File attachments are the existing `editorContext.attachActiveFile()` shape:
  `{ id, kind: 'active-file', document: { uri, ... }, content, createdAt }`.

## Verification

- `npm run lint` — passed.
- `npm test` — 156 tests, 155 pass, 1 skip, 0 fail.
- `npm run test:package` — passed.

## Risks / deviations

- DSH-side `@mention` rendering is explicitly out of scope; only the draft file
  link and click-to-open-in-current-window behavior are promised.
- The extension.js router is a minimal placeholder until the real detection /
  adapter layer lands in a later batch; existing 12 commands remain direct and
  are not migrated.
- Manual F5 verification (right-click menu, keybinding) still needs a human run;
  automated tests cover manifest contracts and command behavior with fakes.
- The `ctrl+alt+b` keybinding follows the task card; users with an existing
  binding for that chord may need to resolve the conflict in VS Code.
