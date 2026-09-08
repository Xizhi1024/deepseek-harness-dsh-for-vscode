# src/catalog

## Responsibility

Configuration/Validation Layer for the extension-side plugin classification catalog (DSH 0.6). The folder holds two cooperating modules:

- `catalogSchema.js` — a schema validator (Guard Clause / fail-fast validation service) that asserts the structural shape and invariants of any candidate catalog object, plus a content-hash helper for revision stamps.
- `pluginCatalog.js` — an immutable, in-memory data catalog (read-only Repository / Registry) that is the extension's single source of truth for which DSH plugins can be classified and detected, exposing frozen query functions.

There is no I/O, no VS Code API usage, and no TypeScript build; this is plain Node.js CommonJS used as a shared static data + validation module.

## Design Patterns

- **Singleton / frozen module constant**: `PLUGIN_CATALOG` is created once at module load via `freezeCatalog(deepFreeze(...))` (recursive `Object.freeze`), then self-validated with `assertCatalog(PLUGIN_CATALOG)` before export — fail-fast at require time, not at first use.
- **Immutability / defensive copying (snapshot pattern)**: `catalogSnapshot()` returns a freshly built, deeply frozen copy so consumers can never mutate the shared registry; `cloneEntry` copies and re-freezes nested arrays (`packageIds`, `capabilities`) and `probe`.
- **Guard Clause validation**: `assertCatalog` / `assertCategory` / `assertEntry` throw `TypeError` on the first invalid field with precise, index-labeled paths (e.g. `CATALOG.entries[3].probe.inventory`). The schema intentionally pins `integrationMode === 'manual-assist'`, `compatibility === 'unknown'`, and requires a `reason` string (audit-pending marker "G3").
- **Registry with query API**: exported lookups `byCapability(capabilityId)`, `byPackage(packageId)`, `entriesForCategory(categoryId)` all filter over `catalogSnapshot().entries`; non-string input yields `[]`.
- **Content-addressed revision**: `catalogRevision(catalog)` computes a lowercase-hex SHA-256 of `JSON.stringify(catalog)` via `node:crypto`; `pluginCatalog.js` re-exports `catalogRevision()` returning the precomputed `PLUGIN_CATALOG.revision`.
- **Delegated validation / whitelist reuse**: `catalogSchema.js` imports `isAllowedDetailsUri` from `../capabilityCatalog` to enforce the shared https:// or `vscode:extension/<publisher>.<name>` URI whitelist, while keeping `detailsUri` optional (plugins may have no details page yet).

Key exported functions:

- `catalogSchema.js`: `assertCatalog(input)`, `catalogRevision(catalog)`
- `pluginCatalog.js`: `PLUGIN_CATALOG`, `catalogSnapshot()`, `byCapability(id)`, `byPackage(id)`, `entriesForCategory(id)`, `catalogRevision()`

## Data & Control Flow

Load-time sequence in `pluginCatalog.js`:

1. CATEGORIES (7: `core` hard, plus `ai-cap`, `editor`, `context`, `security`, `ops-ui`, `external` soft) and ENTRIES (7 entries: `mcp-manager`, `skill-manager`, `plugin-marketplace` (package `dshmarket`), `at-file`, `git` (empty `packageIds`, unverified), `test`, `checkpoint`) are defined as literals.
2. `schemaCatalogRevision({ categories, entries })` hashes the content into `revision`.
3. `freezeCatalog` deep-freezes `{ revision, categories, entries }` into `PLUGIN_CATALOG`.
4. `assertCatalog(PLUGIN_CATALOG)` re-validates the assembled object (revision is a non-empty string, category uniqueness, `hard` boolean with `core === true` invariant, entry shape, category references, non-empty `capabilities`, `probe` shape, pinned enum fields, optional `detailsUri` whitelist); any violation throws at require time.
5. `module.exports` publishes the frozen catalog plus query helpers.

Runtime data flow: consumers call `catalogSnapshot()` / query helpers, which rebuild frozen copies on each call; lookups match on capability ids (`mcp.consume`), package ids (`dsh-mcp-manager`), or category ids (`ai-cap`). `adapter` names a CapabilityAdapter contract id for downstream routing; `fallback` is empty pending a future slice; `probe.inventory` (plus optional `settingsNamespace` / `behavior`) drives inventory probing by the detection layer. Data leaves the folder only as frozen plain objects; no state transitions occur after load.

In the extension itself, `src/providerDetector.js` requires `catalogSnapshot` and embeds `catalog: pluginCatalogSnapshot()` into its result payload (line ~218).

## Integration Points

Dependencies (imports):

- `pluginCatalog.js` → `./catalogSchema` (`assertCatalog`, `catalogRevision`)
- `catalogSchema.js` → `node:crypto` (SHA-256) and `../capabilityCatalog` (`isAllowedDetailsUri` — shared URI whitelist)

Consumers (who imports this folder):

- `src/providerDetector.js` — imports `catalogSnapshot` from `./catalog/pluginCatalog`; the primary extension consumer feeding provider detection results.
- `test/unit/catalogSchema.test.js` — unit tests for `assertCatalog` / `catalogRevision`.
- `test/unit/pluginCatalog.test.js` — unit tests for the exported catalog API.
- `scripts/check-package-contents.js` — packaging allowlist pins both files (`src/catalog/catalogSchema.js`, `src/catalog/pluginCatalog.js`) as shipped files.

No VS Code events, commands, or extension APIs are used here; integration is purely via CommonJS require and frozen data objects (capability ids like `mcp.consume`, adapter contract ids like `mcp-manager`).

## Files

- `catalogSchema.js` — Fail-fast schema validator for catalog objects plus SHA-256 revision hashing; enforces category/entry invariants and the detailsUri whitelist. (~193 lines)
- `pluginCatalog.js` — Immutable 0.6 plugin classification registry (7 categories, 7 entries) with frozen snapshot and capability/package/category query helpers, self-validated at load. (~225 lines)
