# Repository Atlas: DeepSeek Harness for VS Code

## Scope and status

Plain CommonJS extension host, zero npm dependencies, VS Code desktop ≥ 1.106. Extension **1.2.0 candidate** bundles **dsh-vscode-integration 0.10.0**. Runtime selection is exact: target DSH `0.2.0-rc.1`, legacy `0.1.2-rc.1`; unknown versions do not inherit integration support.

The candidate includes the 1.1.8 watcher, focus and search fixes. Runtime/browser probes have passed search/IME, prompt/cancel/tools, 601-second steady-state and ten start/stop cycles. Installed-VSIX validation is in progress; [final validation handoff](HANDOFF-1.2.0-VALIDATION.md) controls acceptance claims.

## Entry points

- `package.json` → `src/extension.js`: activation, feature assembly, commands, runtime and surface lifecycle.
- `runtime-integration/dsh-vscode-integration/package.json` → `lib/index.js`: DSH host plugin.
- Integration `lib/client.js`: browser entry; loads flat `client.dsh020rc1.js` and `client.sessionBridge.js` through the upstream module loader.
- Integration `contracts/runtime-v1.json`, `session-bridge-v1.json`, `validate.cjs`: versioned wire contracts and validation; host re-export in `src/protocol/runtime.js`.

## Architecture and ownership

1. **Runtime**: `src/runtime/{identity,compatibility,supervisor,client}.js` own exact identity, child Node checks, preparation, authentication, lifecycle and facade transport. Existing resolver/provisioner/serverManager modules provide runtime discovery and process operations. Target profile adds `-dsh020rc1`; profiles separate plugin configuration, not home-level sessions or credentials.
2. **Session**: `src/session/{feedHub,transcript,coordinator,browserProxy}.js` own shared subscriptions, snapshot reconciliation, temporary/durable text, workspace membership, visible target identity and attachment tickets. Domain wrappers use injected target APIs, retaining their legacy signatures.
3. **Target host adapter**: integration `runtimeFacade.js` exposes authenticated `/api/vscode/v1`; `adapters/dsh020rc1.js` maps public session/workspace controllers and exact source events. It does not mount the legacy REST translation layer.
4. **Browser surface**: `webviewHtml.js` owns the iframe shell identity/origin checks; the flat client chunks adapt public DSH UI services and handle versioned messages. Navigation changes sessions without replacing the iframe. Attachments target only the main Conversation; expanded internal rightbar refuses insertion (A07 partial).
5. **Changes/chat**: confirmed tool evidence flows through `editEventProjector` into persistent `changeTracker` and snapshot-aware `changeTree`. Unknown filesystem changes remain external. `@dsh` uses progress for temporary generation and appends committed text only; native DSH UI streams normally.
6. **Existing bridges/features**: CH1 tool bridge, textDocumentBridge, authenticated web proxy, feature registry, LM/FIM/MCP and editor/terminal/UI functions retain separate responsibilities. Optional configuration is not a claim of target certification.

DI factories, frozen values, bounded queues, fail-closed validation and explicit disposal remain the implementation conventions.

## Directory map

| Directory | Responsibility | Map |
|---|---|---|
| `src/` | Host composition and domain services | [Map](src/codemap.md) |
| `src/runtime/` | Exact runtime identity, supervisor and facade client | Host map |
| `src/session/` | Transcript/feed/coordinator/browser proxy | Host map |
| `src/protocol/` | Protocol contracts and shared validator boundary | [Map](src/protocol/codemap.md) |
| `src/bridge/` | CH1 v3 handlers | [Map](src/bridge/codemap.md) |
| `src/ch1/` | Bounded notification coalescing | [Map](src/ch1/codemap.md) |
| `src/ch2/` | Workspace wrapper and legacy transport | [Map](src/ch2/codemap.md) |
| `src/context/` | Workspace binding and focus state | [Map](src/context/codemap.md) |
| `src/commands/` | Injected command implementations | [Map](src/commands/codemap.md) |
| `src/adapters/` | Optional capability abstractions | [Map](src/adapters/codemap.md) |
| `src/catalog/` | Plugin catalog | [Map](src/catalog/codemap.md) |
| `src/detection/` | Plugin/profile detection | [Map](src/detection/codemap.md) |
| `src/diagnose/` | Diagnostics | [Map](src/diagnose/codemap.md) |
| `src/mcp/` | MCP consumption | [Map](src/mcp/codemap.md) |
| `runtime-integration/` | Vendored package synchronization | [Map](runtime-integration/codemap.md) |
| Integration package | DSH host/browser adapters | [Map](runtime-integration/dsh-vscode-integration/codemap.md) |

## Verification and boundaries

- Planned next work: [full IDE experience](PLAN-FULL-IDE-EXPERIENCE.md) and [profile/plugin contracts](PLAN-VSCODE-PROFILE-PLUGIN-CONTRACTS.md). These specify settings-controlled profile startup, plugin feature switches, plugin-owned DSH UI and new IDE services; they are not implemented capabilities.

- `npm run check:w0`: lint, unit tests, package and secrets gates; `scripts/probe-dsh020rc1.js` exercises an isolated real runtime.
- [Architecture contracts](PLAN-1.2.0-ARCHITECTURE-CONTRACTS.md), [implementation plan](PLAN-1.2.0-DSH-0.2.0-rc.1.md), [host mapping evidence](HANDOFF-1.2.0-HOST-CONTRACTS.md), [final validation](HANDOFF-1.2.0-VALIDATION.md).
- Non-text file/image prompt upload, FIM and the complete optional-feature matrix are not certified. Candidate builds and installed-state tests do not imply Marketplace publication or replacement of the user's daily installation.
