# Sprint 1 build and Windows G1 acceptance

**Result:** B01–B04 complete; E01, E02 and G1 pass for the recorded Windows x64 core configuration. S2/G2 and later stages remain untested. Machine-readable results and artifact identity are in [validation.json](validation.json).

| Slot | Exact RC release | Installed native UI / E01 | Isolation and recovery / E02 |
|---|---|---|---|
| T0 | 0.2.1-rc.2 | PASS | PASS |
| T1 | 0.2.1-rc.1 | PASS | PASS |
| T2 | 0.2.0-rc.2 | PASS | PASS |
| T3 | 0.2.0-rc.1 | PASS | PASS |

The user selected this RC channel window on 2026-10-17. Official npm metadata had `next=0.2.1-rc.2` and `latest=0.2.0-rc.2`; launch uses exact versions, never floating tags. [release-window.json](release-window.json) includes publication times, official source tags/SHAs and npm package integrity.

## Candidate and source

- Extension **1.2.2**, integration **0.11.1**; VS Code **1.133.0**, Windows x64, extension-host Node **24.18.0**; component probes use Node **24.11.1**.
- VSIX: `D:/Coding/DSH/sprint1-runtime/dsh-vs-sidebar-1.2.2-sprint1.vsix` (1,827,994 bytes).
- SHA-256: `d106db6fe6002da176503b016a91dc16cbcb64cf0189a165ce265bc3fa91de2e`.
- Implementation commit: `372ee107d7d661268099bc253950825791dcde01`, branch `sprint1/native-four-runtime`, worktree `D:/Coding/DSH/worktrees/dsh-vscode-s1`.
- Baseline: `f6d568ae35fb89b02b3a5399e18751991c73b2b3`; the original `adapt/dsh-0.2.0-rc.2` checkout and its planning WIP are preserved. The source is locally committed; nothing was pushed, published or installed into the daily VS Code profile.

Each installed product was discovered from an isolated VSIX installation. The development-extension path contains only an empty acceptance driver. All 136 installed file bodies match that VSIX, and its manifest matches except VS Code installation metadata. Of those bodies, 134 match the working source exactly; vsce transforms the packaged README and changelog and renames `LICENSE` to `LICENSE.txt`. All packaged code matches the implementation source.

## Changes

Host resolution, integration factories, runtime/session contracts and both browser handshake layers now recognize all four exact identities. Each release gets a separate profile. Mixed runtime/adapter pairs and undeclared versions fail closed. Public DSH services and the native iframe remain the integration surface.

Managed RC releases refuse an empty workspace before profile preparation or child launch, avoiding an inherited extension-host working directory. Reopening/rechecking a live target preserves its iframe, Session epoch and ready status indicator.

Real installation exposed an omitted `0.2.1` identity table in `client.sessionBridge.js`; that independent chunk is now covered by actual handshake assertions for every RC. The browser manifest also declares its consumed public right-sidebar dependency. Early failed installation runs remain in the isolated runtime directory; they are not counted as passing evidence.

## Community skill and upstream diff

The [official community discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5120) links the [oh-my-dsh upgrade skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/ef075767b476e8000c716a18f848028eebcd5aef/skills/plugin-upgrade) and [william-jin-cmu upgrade skill](https://github.com/william-jin-cmu/dsh-plugin-upgrade/tree/9ea56c1340080dcec7e18934c18ddd33c39e814b), including `scripts/diff-api.sh`. We followed their baseline/touchpoint/diff/real-load workflow. The first skill has no `0.2.1` migration cards; [community-planner.json](community-planner.json) records that gap.

The Windows equivalent, `scripts/diff-runtime-api.js`, compares full declaration inventories and package manifests for eight consumed public packages. Adjacent changes are **5**, **72**, and **0** declaration files: [020rc1→020rc2](diff-020rc1-020rc2/api.diff), [020rc2→021rc1](diff-020rc2-021rc1/api.diff), [021rc1→021rc2](diff-021rc1-021rc2/api.diff). Zero declaration changes does not mean zero implementation changes. Session-create returns the actual/reused blank Session identity; projection results gain migration discriminants; workspace streams gain `replace` events. S1 already consumes the returned Session identity, does not call projections, and closes the opening workspace baseline. Later feature-specific API additions remain for S2+.

## Evidence and verification boundary

- `npm run check:w0`: **893 pass, 1 skip, 0 fail**; lint **208 JavaScript / 6 JSON**; packaging and secrets gates pass. Integration tests: **181 pass, 0 fail**.
- `runtime-<version>.json`: real isolated startup/authentication, workspace and Session identity, streaming, active cancellation, real read/write/edit tools and owned process exit. The LlmAdapter is a deterministic local fixture, not a production model service.
- `paired-<version>.json` and its two `installed-<version>-a/b.json` records: two actual installed Code windows per RC; distinct workspace, process, endpoint and Session; real panel close/reopen and native iframe reload; ordinary native composer messages. After the complete A Code process exits, B still sends and receives through its own native UI. Every owned runtime is stopped.
- `lifecycle-<version>.json`: ten real start/stop cycles per RC, two owned runtimes and a test-authorized borrower, no borrower cleanup side effects, and unknown-version/missing-Node failure before preparation/spawn.
- `reconnect-<version>.json`: two deliberate real SSE cuts recover into fresh snapshot epochs with one owned process; final consumer disposal leaves no transport/retry timer. This short reconnect test is not the separate ten-minute resource soak.
- Empty-window refusal is a DI Host test for each exact RC; it asserts the visible error page, zero child launches/preparations and no generated profile. It is not a claim that four additional empty native Code windows were manually exercised.
- Light and dark themes are checked in the paired native frames. Screenshots use a **maximized native auxiliary bar**, with the optional changes-review pane disabled only in the acceptance fixture. Clicks are DOM-dispatched into native controls; the composer receives keyboard input. Pointer geometry, the default narrow sidebar, full keyboard/IME/accessibility usability and compact layout remain outside this G1 result.
- Served browser bodies match the installed VSIX after removing only DSH's official separator/source-map transport trailer; raw response hashes are retained separately. Native UI results are not inferred from HTTP-only probes.

S1 does not certify S2 selection links, complete optional IDE capabilities, full Agent flows, production model service, macOS/Linux/Remote behavior, Node/Renode/STM32 debug, or Marketplace publication. No personal profile, credentials or historical Session is migrated. Next task: **S2 V01**.
