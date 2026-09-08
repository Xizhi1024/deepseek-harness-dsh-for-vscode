# src/adapters

## Responsibility

Adapter contract layer for the extension's 0.6 capability system. The directory
currently contains a single module, `contract.js`, that defines the base-class
contract every capability integration must satisfy. In architectural terms it is
the **port** half of a ports-and-adapters (hexagonal) design: it specifies the
interface (the port) that concrete capability adapters elsewhere in the codebase
implement. It also provides a **Null Object** implementation so callers never
have to branch on a missing adapter.

Despite the folder name, no concrete per-vendor adapters live directly in this
folder yet (the task brief mentions subfolders with their own mappers, but at
present `src/adapters` contains only `contract.js` and this codemap).

## Design Patterns

- **Adapter (contract / port):** `CapabilityAdapter` is the abstract-ish base
  class (plain ES class, no `extends` requirement enforced). Subclasses
  override the static `capabilityId` (e.g. `'mcp.consume'`-style capability
  ids) and optionally `attach`, `detach`, and `probe`.
- **Null Object Pattern:** `NullAdapter extends CapabilityAdapter` — its
  `attach`/`detach` are deliberate no-ops and `probe` returns `{}`. The
  exported factory `nullAdapter(capabilityId)` instantiates it for a specific
  capability id. Note: this is distinct from the frozen
  `NullAdapter` sentinel object in `src/commands/shell.js`.
- **Template Method (minimal):** the base class provides default
  implementations (idempotent attach/detach, always-ok probe) that subclasses
  override selectively.
- **State enumeration:** `AdapterState` is an `Object.freeze`-d constants map
  describing the adapter lifecycle: `detached`, `attaching`, `attached`,
  `degraded`.
- Exported API (`module.exports`): `AdapterState`, `CapabilityAdapter`,
  `NullAdapter`, `nullAdapter`.

## Data & Control Flow

- Construction: `new CapabilityAdapter()` (or a subclass) sets `_attached =
  false`, `_surface = null`, and resolves the instance field
  `capabilityId` from `constructor.capabilityId`.
- `attach(surface)`: if already `_attached`, returns immediately
  (idempotent); otherwise stores the host-supplied `surface` object and flips
  `_attached = true`. The surface is an opaque host handle provided by the
  integration layer — the contract does not introspect it.
- `detach()`: clears `_attached` and `_surface`; also idempotent.
- `probe(_surface)`: stateless readiness check returning `{ ok: true }` by
  default; concrete adapters may enrich the result object.
- `NullAdapter` bypasses the base bookkeeping entirely: `attach`/`detach`
  do nothing, `probe` returns `{}`, and the capability id is set per
  instance via the `nullAdapter(capabilityId)` factory.
- No events, timers, or async machinery: the module is synchronous, dependency-
  free, and side-effect-free apart from instance-state mutation.

## Integration Points

- **Dependencies:** none — `contract.js` imports nothing (only `'use
  strict'` and core JS). This makes the contract safe to require from any
  layer.
- **Consumers:**
  - `test/unit/contract.test.js` requires all four exports and asserts the
    frozen `AdapterState` map, idempotent attach/detach, default `probe`
    result, NullAdapter no-op behavior, and subclass `capabilityId`
    resolution.
  - `scripts/check-package-contents.js` lists `src/adapters/contract.js`
    in the packaged-files allowlist.
  - `src/catalog/pluginCatalog.js` documents that its `adapter` field names
    the `CapabilityAdapter` contract id for routing (conceptual consumer).
- **Related but separate:** `src/commands/shell.js` defines its own frozen
  `NullAdapter` sentinel (`{ id: 'null-adapter' }`) used by
  `createCommandShell` and `src/extension.js` to signal "capability
  unavailable" — it does not require this module.
- No VS Code commands, events, or configuration keys are touched by this
  directory.

## Files

- `contract.js` (~109 lines) — Adapter contract for the 0.6 capability
  layer: frozen `AdapterState` enum, idempotent `CapabilityAdapter` base
  class, `NullAdapter` Null Object, and the `nullAdapter(capabilityId)`
  factory.
