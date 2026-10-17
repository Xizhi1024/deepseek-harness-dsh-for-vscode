# runtime-integration/

## Responsibility

Vendored DSH integration packages copied by `src/dshIntegration.js` into the selected profile during runtime preparation. The current package is `dsh-vscode-integration@0.11.1`, bundled with extension 1.2.2 candidate. This directory contains no independent runtime entry point.

## Version and data boundaries

- Target: exact DSH `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-rc.1` and `0.2.1-rc.2` (per-version adapters); legacy: exact `0.1.2-rc.1`. Unverified versions do not acquire managed integration capabilities.
- Target preparation uses a profile suffix per version (`-dsh020rc1` / `-dsh020rc2`). Plugin configuration is separated; home-level sessions and credentials remain shared when the home is shared.
- Source bytes are synchronized before the owned child starts. Activation without runtime selection does not overwrite a profile.
- Packaging and synchronization allowlists cover host modules, shared contracts and flat browser chunks. A candidate artifact is not a Marketplace release.

## Integration points

- `src/dshIntegration.js`: content-aware copy, integration manifest/version and foreign-file cleanup.
- `src/runtime/supervisor.js`: preparation, owned process lifecycle and authenticated readiness.
- `scripts/check-package-contents.js`: packaging contract.
- [Integration package map](dsh-vscode-integration/codemap.md): facade, exact upstream adapter, browser bridge and legacy path.
- [Final validation handoff](../HANDOFF-1.2.0-VALIDATION.md): current acceptance evidence and remaining limitations.

Sprint 1 (2026-10-17): exact RC window and source/package hashes are in `evidence/sprint1/release-window.json`; API declaration diffs and real runtime probes are in `evidence/sprint1/`. Installation/UI results are reported separately from runtime contract probes.
