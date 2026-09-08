# src/detection

## Responsibility

This directory implements the plugin **detection layer** (the "0.6 detection layer" per inline docs): it determines, for each entry of the plugin catalog, whether a plugin is `active`, `installed-disabled`, `absent`, `unknown`, or `failed`, based on evidence gathered by pluggable read-only probes. It is a pure Node.js module with no VS Code API dependency — all filesystem access is confined to the DSH home profile directory, making the layer independently testable and usable from synchronous diagnostic consumers.

## Design Patterns

- **Factory + handle object**: `createPluginDetector({ catalog, probes, now, home })` returns a detector handle exposing `detect`, `detectSync`, `invalidate`, `snapshot`, and a `lastInvalidation` getter. The factory normalizes its `catalog` argument (accepts either a catalog object or a zero-arg `catalogSnapshot()` function) into a canonical shape with `revision`/`categories`/`entries`.
- **Strategy pattern (probes)**: detection delegates to an array of interchangeable probe functions (`probes = [profileProbe]` by default). Each probe takes `{ dshHome, packageId }` and returns a frozen `ProbeResult`; throwing probes are contained and converted to `failed` evidence.
- **Value object with immutability**: `probeResult(source, state, detail)` constructs frozen, validated `ProbeResult` records; `deepFreeze` recursively freezes every `Detected` result and snapshot. `PROBE_SOURCES` (`inventory | settings | profile | behavior`) and `PROBE_STATES` (`active | installed-disabled | absent | unknown`) are frozen constant arrays acting as enums.
- **Memoization with cache key + in-flight deduplication**: results are cached per `entryId` keyed by `dshHome + '\0' + catalogRevision`; concurrent `detect()` calls for the same entry share one in-flight Promise.
- **Async-over-sync seam (facade for sync consumers)**: `detect(entryId, { signal })` is the primary async contract, implemented as `Promise.resolve().then(() => detectSync(entryId))`, because the diagnostic consumer (`buildPluginSummary`, `providerDetector`'s `diagnosticSnapshot`) is synchronous.
- **State machine / evidence aggregation**: detected state is reduced from accumulated probe evidence with priority: probe error → `failed`; any `inventory`/`behavior` probe `active` → `active` (only state where `effective: true`); else any `installed-disabled`; else any `absent`; else `unknown`.

## Data & Control Flow

**Entry**: a caller (e.g. `src/providerDetector.js`) creates a detector with a plugin catalog and optionally a DSH home path, then calls `detect()`/`detectSync(entryId)` or `snapshot()`.

1. `detectSync(entryId, homeOverride?)` computes the effective home, derives the cache key, and returns the cached frozen result on a key match.
2. The entry is looked up in `resolvedCatalog.entries` by `id`; a missing entry short-circuits to a frozen `{ state: 'unknown', evidence: [], effective: false }` (still cached).
3. For each `packageId` in the entry's `packageIds`, each probe is invoked with `{ dshHome, packageId }`. Probe results are pushed onto `evidence`; a thrown probe sets `probeError` and appends a synthetic `probeResult('profile', 'unknown', 'probe error: ...')`.
4. The state-reduction precedence runs (see state machine above) and the frozen `Detected` object is cached and returned.
5. `detect(entryId, { signal })`: returns an immediate frozen `unknown` result if the AbortSignal is already aborted; otherwise deduplicates via the `inflight` map and resolves to `detectSync`'s result, removing itself from `inflight` in `finally`.
6. `snapshot()` maps `detectSync` over every catalog entry and returns a deep-frozen `{ dshHome, revision, entries }` aggregate.
7. `invalidate(reason)` clears `cache` and `inflight` and records `lastInvalidation = { reason, at: now() }` (timestamp injected via the `now` option — a test seam).

**Probe internals (`profileProbe`)**: validates `dshHome`/`packageId`, then synchronously reads `$DSH_HOME/profiles/web/package.json` and `cordis.patch.yml`. `hasDisabledPatchEntry` line-parses the YAML (no YAML library) to find the entry with `- id: <packageId>` and its `disabled: true|false` line. Decision: disabled patch entry → `installed-disabled`; declared in `dependencies` without a disabled patch → `unknown` (runtime activity not confirmable at L3); both files readable but undeclared → `absent`; missing home/files or any read/parse error → `unknown`. The probe never throws — all errors are caught and returned as `unknown` results.

**Exit**: frozen `Detected` objects leave the module toward diagnostic summaries; no state mutates outside the detector handle's internal `cache`/`inflight`/`lastInvalidation`.

## Integration Points

**Dependencies (imports)**:
- `pluginDetector.js` → `./probeTypes` (`probeResult`), `./profileProbe` (`profileProbe`).
- `profileProbe.js` → `node:fs`, `node:path`, `./probeTypes` (`probeResult`).
- `probeTypes.js` → no imports (leaf module).
- No VS Code API and no third-party dependencies.

**Consumers (importers, found via grep in `src/`)**:
- `src/providerDetector.js` imports `createPluginDetector` from `./detection/pluginDetector` and `profileProbe` from `./detection/profileProbe`, wiring them with the plugin catalog snapshot and `buildPluginSummary` for diagnostic snapshots.

## Files

- **pluginDetector.js** (~212 lines) — Detector factory (`createPluginDetector`) with probe-strategy aggregation, state machine, cache/in-flight memoization, `detect`/`detectSync`/`invalidate`/`snapshot` API, and deep-frozen results.
- **probeTypes.js** (~41 lines) — Frozen `PROBE_SOURCES`/`PROBE_STATES` constants and the validated `probeResult(source, state, detail)` value-object constructor.
- **profileProbe.js** (~110 lines) — Read-only L3 profile probe (`profileProbe`) plus `hasDisabledPatchEntry` YAML line-parser; inspects `profiles/web/package.json` and `cordis.patch.yml`, never throws.
