# B0 Implementation Notes — Catalog & Adapter Contract

Branch: `feature/0.6-b0-catalog-contract`
Baseline: `e766ad7`
Lane: `D:\Coding\DSH\dsh-vs-sidebar\.slim\worktrees\b0`

## Scope

This batch lands the classification catalog and adapter contract as pure
CommonJS modules, an L3 profile probe, a plugin detector with a synchronous
seam, a diagnostic summary, and one real consumer (`dsh.diagnose` summary via
`src/providerDetector.js`).

## Changed files

- `src/providerDetector.js` — added `dshPlugins` to `diagnosticSnapshot()`.
  Existing fields and synchronous behavior are unchanged.
- `test/providerDetector.test.js` — added two tests for `dshPlugins` shape and
  null-home behavior.

## New files

- `src/catalog/catalogSchema.js`
  - `assertCatalog(input)` — hand-written validator; throws `TypeError`.
  - `catalogRevision(catalog)` — sha256 hex of `JSON.stringify(catalog)`.
  - `detailsUri` is optional; when present it must pass the capabilityCatalog
    whitelist (`https://` or `vscode:extension/<publisher>.<name>`).
- `src/catalog/pluginCatalog.js`
  - 7 categories: `core`, `ai-cap`, `editor`, `context`, `security`, `ops-ui`, `external`.
  - 7 entries: `mcp-manager`, `skill-manager`, `plugin-marketplace`, `at-file`, `git`, `test`, `checkpoint`.
  - Exports: `catalogSnapshot()`, `byCapability(id)`, `byPackage(packageId)`,
    `entriesForCategory(id)`, `catalogRevision()`.
  - `packageIds` use only verified evidence from the task card; `git` is empty
    with an `// unverified` comment.
- `src/adapters/contract.js`
  - `class CapabilityAdapter` with `static capabilityId`, idempotent
    `attach(surface)` / `detach()`, and default `probe(surface)` returning
    `{ ok: true }`.
  - `nullAdapter(capabilityId)` returns a `NullAdapter` instance whose methods
    are no-ops / return empty results.
  - `AdapterState = Object.freeze({ DETACHED, ATTACHING, ATTACHED, DEGRADED })`.
- `src/detection/probeTypes.js`
  - `ProbeSource` / `ProbeResult` documented as type unions; runtime exports
    `PROBE_SOURCES`, `PROBE_STATES`, and frozen `probeResult(...)` factory.
- `src/detection/profileProbe.js`
  - `profileProbe({ dshHome, packageId })` reads
    `$DSH_HOME/profiles/web/package.json` and `cordis.patch.yml` with
    `fs.readFileSync` and simple line-based YAML parsing. Never throws.
- `src/detection/pluginDetector.js`
  - `createPluginDetector({ catalog, probes = [profileProbe], now, home })`.
  - Returns `detect(entryId, { signal })`, `detectSync(entryId, homeOverride?)`,
    `invalidate(reason)`, `snapshot()`, `catalog`, and `lastInvalidation`.
  - `detect()` is `Promise.resolve(detectSync(entryId))`; `detectSync` is the
    synchronous seam required by `providerDetector.diagnosticSnapshot`.
  - State decision and cache behavior follow the task card.
- `src/diagnose/pluginSummary.js`
  - `buildPluginSummary({ detector, home })` returns
    `{ revision, scanned, states: { active, disabled, absent, unknown } }`.
- `test/unit/catalogSchema.test.js`
- `test/unit/pluginCatalog.test.js`
- `test/unit/contract.test.js`
- `test/unit/profileProbe.test.js`
- `test/unit/pluginDetector.test.js`
- `test/unit/pluginSummary.test.js`

## Interface signatures

```js
// catalogSchema
assertCatalog(input) // void, throws TypeError
catalogRevision(catalog) // string

// pluginCatalog
catalogSnapshot() // deep-frozen { revision, categories, entries }
byCapability(id) // object[] frozen entry copies
byPackage(packageId) // object[] frozen entry copies
entriesForCategory(id) // object[] frozen entry copies
catalogRevision() // string

// adapters/contract
class CapabilityAdapter { static capabilityId; attach(surface); detach(); probe(surface); }
nullAdapter(capabilityId) // NullAdapter
AdapterState // frozen enum

// detection/probeTypes
probeResult(source, state, detail) // frozen ProbeResult

// detection/profileProbe
profileProbe({ dshHome, packageId }) // frozen ProbeResult

// detection/pluginDetector
createPluginDetector({ catalog, probes?, now?, home? })
  // -> { detect(entryId, {signal?}), detectSync(entryId, homeOverride?), invalidate(reason), snapshot(), catalog, lastInvalidation }

// diagnose/pluginSummary
buildPluginSummary({ detector, home }) // { revision, scanned, states }
```

## Data structures

- Catalog entry:
  `{ id, category, packageIds: string[], capabilities: string[], required: boolean, adapter: string, fallback: string, probe: { inventory: boolean, settingsNamespace?, behavior? }, integrationMode: 'manual-assist', compatibility: 'unknown', reason: 'interface audit pending (G3)', detailsUri? }`
- ProbeResult:
  `{ source: 'inventory'|'settings'|'profile'|'behavior', state: 'active'|'installed-disabled'|'absent'|'unknown', detail: string }`
- Detected:
  `{ entryId, state: 'unknown'|'absent'|'installed-disabled'|'active'|'failed', evidence: ProbeResult[], effective: boolean }`
- Snapshot:
  `{ dshHome, revision, entries: Detected[] }`

## Verification

- Full test suite via in-process Node test runner:
  `node --test --test-isolation=none "test/*.test.js" "test/unit/*.test.js"`
  - 184 tests, 183 pass, 1 skip, 0 fail.
  - Baseline was 145 tests / 144 pass / 1 skip; this batch adds 39 tests.
- Static checks (manual equivalent of `npm run lint`):
  - `node --check` passed for every JS file under `src`, `test`, `scripts`.
  - All 6 JSON files parsed successfully.
- `npm test` and `npm run lint` could not be executed as-is in this sandbox
  because `node --test` / `scripts/lint.js` spawn child processes with piped
  stdio and the sandbox returns `EPERM`; the in-process equivalent above is the
  authoritative local verification used here.

## Unresolved risks / deviations

- `createPluginDetector` accepts an additional `home` option (and
  `detectSync` accepts an optional `homeOverride`) even though the task-card
  shorthand omitted it. This is required so `profileProbe` can receive the
  DSH home while keeping `buildPluginSummary({ detector, home })` synchronous.
- `adapter` values are set to the entry id and `fallback` to `''` because the
  task card did not specify concrete adapter/fallback ids for B0. These fields
  are contract placeholders pending SM-3b adapter routing.
- Capability ids for entries other than `mcp-manager` were chosen conservatively
  from the entry names (e.g. `skill.manage`, `plugin.browse`) and are not part
  of the verified evidence; they are catalog data, not D-side API calls.
- `plugin-marketplace` uses `dshmarket` as the installed package id;
  `dsh-plugin-marketplace` is the disabled patch entry name and is noted in a
  code comment.
- `NullAdapter.probe()` returns `{}` (empty result) per the "no-op/empty result"
  contract wording.
