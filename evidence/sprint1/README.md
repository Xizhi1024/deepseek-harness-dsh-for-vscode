# Sprint 1 — native embed and four exact RC versions

Implementation starts from `f6d568ae35fb89b02b3a5399e18751991c73b2b3` on the isolated `sprint1/native-four-runtime` branch. The original `adapt/dsh-0.2.0-rc.2` worktree and its planning WIP are preserved. [Baseline](baseline.json) records their identities and hashes.

## B01: fixed version window

The user selected the RC channel on 2026-10-17. T0 is `0.2.1-rc.2`; T1–T3 are `0.2.1-rc.1`, `0.2.0-rc.2`, `0.2.0-rc.1`. Alpha/beta releases are excluded. npm `latest` still pointed to `0.2.0-rc.2`; `next` pointed to `0.2.1-rc.2`. The candidate never resolves a floating tag during launch. [Release window](release-window.json) records official tag SHAs, package integrity, tarballs and publication times.

The retained feature baseline is the native iframe, authenticated runtime facade, workspace/session binding, watcher/focus/search behavior, prompt streaming/cancellation, editor/tool bridges and existing optional features. Compatibility work does not certify all optional features. Legacy `0.1.2-rc.1` remains available outside the four-version S1 certification window.

## Community upgrade method and diff

The [official community discussion #5120](https://github.com/deepseek-ai/deepseek-harness/discussions/5120) links [oh-my-dsh/plugin-upgrade](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/ef075767b476e8000c716a18f848028eebcd5aef/skills/plugin-upgrade) and [william-jin-cmu/dsh-plugin-upgrade](https://github.com/william-jin-cmu/dsh-plugin-upgrade/tree/9ea56c1340080dcec7e18934c18ddd33c39e814b). The latter includes `scripts/diff-api.sh`. We use the baseline → touchpoint inventory → exact published-package diff → real load/behavior workflow. The first skill has no 0.2.1 cards; [planner output](community-planner.json) explicitly records the unsupported corridor. Historical cards are not evidence of 0.2.1 compatibility.

`node scripts/diff-runtime-api.js <from-dsh-package-root> <to-dsh-package-root> <output-directory>` compares all declaration files, including additions/deletions, and package exports/dependencies/peers for eight consumed packages. The three adjacent RC edges are [0.2.0 rc.1→rc.2](diff-020rc1-020rc2/api.json), [0.2.0 rc.2→0.2.1 rc.1](diff-020rc2-021rc1/api.json), and [0.2.1 rc.1→rc.2](diff-021rc1-021rc2/api.json). Each has an adjacent `api.diff` file. Changed declaration counts are 5, 72 and 0; zero declarations does not imply zero runtime changes.

Relevant semantic review: Session creation may reuse only a blank Session and returns the actual identity; the integration already consumes the returned identity. Projection results gain a discriminant and migration hints; the S1 adapter does not call `projections()`. Workspace streams gain `replace` increments; S1 reads and closes the opening baseline only. Public browser session binding/layout/navigation and guarded insertion methods still exist. Draft reference/command metadata and access-aware UI additions are reserved for later feature-specific adaptation. Exact identities are added at Host, plugin, schema and browser handshake layers; unknown and mismatched pairs remain refused.

## Validation

Each `runtime-<version>.json` is a real isolated DSH runtime probe: startup/authentication, workspace and Session create/list/rename, feed reopen, deterministic streamed response, active cancel, real file tools, and owned-child termination. The model provider is a local fixture; DSH runtime, admission, tools and durable events are real. These probes do not prove installed UI, production model service or cross-platform behavior.

Installed VSIX/UI checks and final task status are recorded in `validation.json` and `REPORT.md` when run. S1 does not claim S2 selection-link delivery, compact UI, full IDE import, macOS certification, or Marketplace publication. No personal profile, credential or historical Session is migrated. Recovery consists of selecting the prior VSIX and the untouched original worktree; isolated test homes remain disposable.
