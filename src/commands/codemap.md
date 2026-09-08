# src/commands

## Responsibility

Command-body factory layer for the DSH VS Code extension — a thin **Service Layer** sitting between VS Code command registration (the `dsh.*` palette/menus/keybindings surface, wired in `src/extension.js`) and the extension's domain services (editor-context attachment pool, thread-attachment coordinator, instance registry, server connection). Each module exports `create*Command(deps)` factory functions that return async command handlers after validating every injected dependency. `shell.js` additionally acts as a **uniform dispatch gate** ("capability gate") that resolves a capability adapter from a router before any command body runs.

## Design Patterns

- **Factory (dependency-injected command bodies):** `createAddFileToThreadCommand`, `createAddFolderToThreadCommand`, `createCleanupOrphansCommand`, `createCtrlIEditCommand`, `createCtrlKEditCommand` each take a `deps` object (vscode facade, editorContext, coordinator, formatters, waitForResolvedView, ensureConnected, loc) and return an async handler; unknown/missing deps fail fast with `TypeError` at factory time.
- **Facade:** every module receives the whole `vscode` API surface as an injected facade (never a direct `require('vscode')`), keeping bodies unit-testable with fake facades.
- **Null Object / NullAdapter sentinel:** `shell.js` exports `NullAdapter = Object.freeze({ id: 'null-adapter' })`; the shell treats it (plus `null`/`undefined`) as "capability unavailable" and short-circuits with an info message instead of running the body.
- **Strategy via router:** `createCommandShell({ router })` delegates adapter selection to an injected router's `get(capabilityId)`; the shell knows no concrete adapter.
- **Template method-like shared flow:** the add-file/add-folder/ctrlK/ctrlI commands all follow the same sequence (attach → focus sidebar → resolve view → ensure connected → format → `coordinator.request(webview, text)` → notify).
- **Fail-closed timeouts:** ctrlI (`CTRLI_TIMEOUT_MS = 120000`) dismisses the QuickPick without sending; ctrlK (`CTRLK_TIMEOUT_MS = 120000`) resolves the InputBox race to `undefined`; both abort silently rather than send a partial draft.
- **Graceful-degradation l10n:** each module has a `defaultLoc(template, params)` fallback doing `{param}` interpolation for tests/non-localized hosts; a real `loc` can be injected.
- Key exports: `createAddFileToThreadCommand`, `createAddFolderToThreadCommand`, `createCleanupOrphansCommand`, `createCtrlIEditCommand` (+ `CTRLI_MAX_FILES = 500`, `CTRLI_MAX_PICKED_FILES = 8`, `CTRLI_TIMEOUT_MS`), `createCtrlKEditCommand` (+ `CTRLK_TIMEOUT_MS`, `isNonEmptySelection`), `createCommandShell`, `NullAdapter`.

## Data & Control Flow

- **shell.js:** `shell.register(vscode, commandId, capabilityId, run)` → `vscode.commands.registerCommand`; on invocation: `router.get(capabilityId)` → if unavailable (NullAdapter/null/undefined) → `window.showInformationMessage('Capability unavailable')` (l10n-aware via `vscode.l10n?.t`) and return `undefined`; otherwise `run(...args)`.
- **dsh.addFileToThread:** `editorContext.attachActiveFile({ allowOutsideWorkspace: true })` → `workbench.view.extension.<CONTAINER_ID>` → `<VIEW_ID>.focus` → `waitForResolvedView()` → `ensureConnected()` → `formatFileAttachment(attachment, uri)` → `coordinator.request(view.webview, text)` → success/error toast. Errors are caught and shown via `showErrorMessage`.
- **dsh.addFolderToThread(uri):** same shape, but the Explorer passes the folder `Uri` as command arg; `editorContext.attachFolder(uri, { allowOutsideWorkspace: true })` attaches a bounded relative-path directory listing (never file contents) while the draft only gets a clickable folder link via `formatFolderAttachment`.
- **dsh.ctrlIEdit:** `workspace.findFiles('**/*', '**/node_modules/**', 500)` → multi-select QuickPick (accept/hide/120s-timeout Promise with `dispose()`) → cancel/empty/timeout ⇒ silent return; >8 picks ⇒ warning and abort → `editorContext.attachFiles(uris)` → per-file `formatFileAttachment` blocks joined under a localized header → prefer `focusedComposerWebview()`, else `waitForResolvedView()` webview → `ensureConnected()` → `coordinator.request(targetWebview, text)`.
- **dsh.ctrlKEdit:** requires a non-empty active selection (`isNonEmptySelection`: distinct start/end) else info message → `attachActiveSelection()` → `showInputBox` raced against a 120s timer; empty/cancelled ⇒ silent return → `ensureConnected()` → `formatSelectionAttachment` → draft string \`指令:\n<instruction>\n\n上下文:\n<context>\` → `focusedComposerWebview()` or `dsh.focusSidebar` + `waitForResolvedView()` → `coordinator.request`.
- **dsh.cleanupOrphans:** `registryFilePath()` → `listAliveEntries(file)` (empty ⇒ info toast) → for each entry skip this window's own `ownedPid()`, normalize host (`DEFAULT_HOST`) and validate port → `probeEntry(host, port)`; `reachable && isDsh` ⇒ action `stop` else `record` → multi-select QuickPick → for selected: `terminate(pid)` only for verified-DSH entries; all selected pids get `removeEntries(file, pids)` registry cleanup → summary info toast. Never kills a process that did not answer as DSH.

## Integration Points

- **Imports (dependencies):** `../types` in addFileToThread.js (`VIEW_ID`, `CONTAINER_ID`) and cleanupOrphans.js (`DEFAULT_HOST`). No npm dependencies anywhere; the `vscode` API is always injected, never required.
- **Injected collaborators (interfaces relied on):** `editorContext` (`attachActiveFile`, `attachFolder`, `attachFiles`, `attachActiveSelection`), thread-attachment `coordinator` (`request(webview, text)`), `formatFileAttachment`/`formatFolderAttachment`/`formatSelectionAttachment`, `waitForResolvedView`, `ensureConnected`, optional `focusedComposerWebview`, registry helpers (`listAliveEntries`, `probeEntry`, `terminate`, `removeEntries`, `ownedPid`, `registryFilePath`), router with `get(capabilityId)`.
- **Consumers:** `src/extension.js` requires all five modules (shell.js line 70, addFileToThread/cleanupOrphans/ctrlIEdit/ctrlKEdit lines 74–77) to build and register the `dsh.*` commands; unit tests in `test/unit/commands.test.js`, `addFileToThread.test.js`, `cleanupOrphans.test.js`, `ctrlIEdit.test.js`, `ctrlKEdit.test.js`; `scripts/check-package-contents.js` whitelists these files for packaging.
- **VS Code API surface used:** `commands.registerCommand`/`executeCommand` (incl. built-ins `workbench.view.extension.<id>`, `dsh.focusSidebar`), `window.createQuickPick` (`onDidAccept`/`onDidHide`/`dispose`), `window.showInputBox`, `window.show*Message`, `workspace.findFiles`, `workspace.getWorkspaceFolder`, `l10n.t`.
- **Commands contributed:** `dsh.addFileToThread`, `dsh.addFolderToThread` (Explorer context, folder Uri arg), `dsh.ctrlIEdit`, `dsh.ctrlKEdit` (no default keybinding), `dsh.cleanupOrphans`.

## Files

- `addFileToThread.js` (~163 lines) — factories for `dsh.addFileToThread` / `dsh.addFolderToThread`: attach active file or folder listing, focus sidebar, send formatted clickable link draft via the coordinator.
- `cleanupOrphans.js` (~150 lines) — factory for `dsh.cleanupOrphans`: multi-select cleanup of live-pid registry entries, probe-verified termination plus record-only removal.
- `ctrlIEdit.js` (~243 lines) — factory for `dsh.ctrlIEdit`: bounded workspace-file QuickPick (≤500 shown, 1–8 picked, 120s fail-closed), multi-file context draft to the coordinator.
- `ctrlKEdit.js` (~110 lines) — factory for `dsh.ctrlKEdit`: selection + timed instruction InputBox composed into a 指令/上下文 draft sent to the coordinator.
- `shell.js` (~68 lines) — capability-gated command shell (`NullAdapter` sentinel, router-based `register`) wrapping command bodies behind adapter availability.
