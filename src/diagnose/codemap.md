# src/diagnose

## Responsibility

Diagnostics service layer for the extension's Diagnose feature. The two modules in this folder are pure, injection-based report builders: they turn raw runtime snapshots and a plugin detector catalog into structured, sectioned diagnostic data (service / bridge / compatibility / plugins / alerts) plus QuickPick presentation helpers. report.js deliberately keeps all I/O out ("no VS Code import here" beyond an injected vscode facade in the picker function); pluginSummary.js is a synchronous aggregator over the detector's detectSync seam. Subfolders of src/diagnose have their own mappers and are not covered here.

## Design Patterns

- **Facade / Dependency Injection**: buildDiagnoseReport accepts every input (snapshot, hostVersion, hostCapabilities, compat, runtimeIssues, featureFailures, selfHealCount, defaultTerminalProfile, platform, loc, now) as parameters with defaults — a pure function over injected ports, trivially unit-testable.
- **Strategy / injected localization & clock**: loc (template "{key}" interpolation via defaultLoc) and now (timestamp provider) are swappable strategies.
- **Adapter**: showDiagnoseQuickPick adapts the report model to the VS Code QuickPick UI through an injected vscode facade; it degrades to Promise.resolve(null) when the host lacks window.createQuickPick.
- **Observer**: subscribes to picker.onDidAccept / picker.onDidHide with a single-settlement finish guard (idempotent dispose + resolve), mirroring sessionNavigation.showSessionQuickPick's degradation contract.
- **Transformer / projection pipeline**: snapshot → normalized sub-objects (server, bridge, home, providers, dshPlugins) → alerts (rule evaluation) → sections → frozen report object with a parallel JSON projection for the DSH OutputChannel.
- **Lookup tables**: SECTION_LABELS and SEVERITY_PREFIX (codicon prefixes "$(info)", "$(warning)", "$(error)") as frozen maps.
- **Error taxonomy mapping**: humanizeError maps error codes through getStartupError to { text, hint, retryable }; isWslProfile regex-matches WSL distro shell names (wsl/ubuntu/debian/kali/suse/pengwin/oracle, case-insensitive).
- Exported API: report.js → buildDiagnoseReport, buildDiagnoseQuickPickItems, showDiagnoseQuickPick, humanizeError, isWslProfile; pluginSummary.js → buildPluginSummary.

## Data & Control Flow

**buildPluginSummary({ detector, home })** (pluginSummary.js):
1. Reads detector.catalog.entries (defensive: defaults to [] when detector/catalog is missing) and normalizes home to a string (empty string makes profile probes report unknown).
2. For each catalog entry, calls the detector's synchronous detectSync(entry.id, homePath) and tallies the returned state: active / installed-disabled→disabled / absent / default→unknown.
3. Returns { revision, scanned, states } — pure with respect to the detector; all I/O lives in the injected detector/probes.

**buildDiagnoseReport(...)** (report.js):
1. Normalizes the diagnosticSnapshot() output into snap sub-objects; counts installed providers (provider.installed).
2. Alert rule evaluation, in order: server-down (error, action dsh.restartServer); bridge-closed (warn, action workbench.action.reloadWindow); wsl-default-terminal (warn, only on platform === 'win32' with a WSL-looking default profile, action workbench.action.openSettings targeting terminal.integrated.defaultProfile.windows); per-failure feature-<id> alerts (each error passed through humanizeError; underivable errors are skipped); self-heal (info) when selfHealCount > 0.
3. Builds sections: service (server URL/owned/stopped, home mode+path, host version with chat/lm/mcp capability flags), bridge (listening port or closed), compat (dsh version with patch/theme/toolsV3 flags, plus runtime-issue flags supported/exportDoublePrefix/sparseProjectionTitles/moduleHmrWindowCrash when runtimeIssues.known), plugins (installed/total providers; catalog revision sliced to 8 chars with active/disabled/absent counts). An alerts section is appended only when alerts exist.
4. Composes a localized one-line summary and returns a frozen report { generatedAt, summary, sections, alerts, json }; json is a machine projection (host, boolean capabilities, compat booleans, defaultTerminalProfile, platform, alerts, raw snapshot) for the DSH OutputChannel.

**Presentation path**: buildDiagnoseQuickPickItems(report) flattens sections into items { separator?, label (with codicon severity prefix), detail ("detail — hint" joined), action }. showDiagnoseQuickPick(vscode, report) maps those into a real QuickPick (separators via QuickPickItemKind.Separator when available), records actionByIndex, shows the picker, and resolves { action } on accept or null on hide/cancel — settling exactly once and disposing the picker.

## Integration Points

**Dependencies (imports)**:
- report.js imports getStartupError from ../startupErrors (startup-error taxonomy for humanizeError); uses process.platform as a default. No other imports — deliberately VS Code-free.
- pluginSummary.js has zero imports; it operates on the detector object produced by createPluginDetector (src/providerDetector.js).

**Consumers (who imports these modules)**:
- src/extension.js requires { buildDiagnoseReport, showDiagnoseQuickPick } from ./diagnose/report — the dsh.diagnose command path builds the report from live snapshot/compat data and shows the QuickPick.
- src/providerDetector.js requires { buildPluginSummary } from ./diagnose/pluginSummary to fold plugin detection states into its snapshot (dshPlugins.states), which later feeds the plugins section of the diagnose report.
- Tests: test/unit/diagnoseReport.test.js and test/unit/pluginSummary.test.js; scripts/check-package-contents.js whitelists both files for packaging.

**Commands / APIs referenced in alert actions**: dsh.restartServer, workbench.action.reloadWindow, workbench.action.openSettings (targeting terminal.integrated.defaultProfile.windows); VS Code QuickPick API (window.createQuickPick, QuickPickItemKind.Separator, onDidAccept, onDidHide) via the injected vscode facade.

## Files

- pluginSummary.js (~61 lines): pure synchronous tally of plugin catalog detection states (active/disabled/absent/unknown) via the detector's detectSync seam; exports buildPluginSummary.
- report.js (~380 lines): builds the frozen sectioned Diagnose report with alerts, JSON projection, error humanization, WSL terminal detection, and QuickPick presentation/picker helpers; exports buildDiagnoseReport, buildDiagnoseQuickPickItems, showDiagnoseQuickPick, humanizeError, isWslProfile.
