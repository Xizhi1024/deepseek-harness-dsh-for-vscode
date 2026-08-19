'use strict';

/**
 * C2 post-install onboarding wizard.
 *
 * First activation asks (once — gated by globalState key
 * `dsh.onboarding.done`) whether the user wants to run the setup wizard. The
 * wizard is a QuickPick/InputBox sequence; every implemented dsh.* setting is
 * written immediately through `workspace.getConfiguration().update` with the
 * Global target, and completion records the one-shot globalState gate so the
 * prompt never repeats. The `dsh.onboarding` command re-opens the same wizard
 * at any time.
 *
 * Nothing here calls `require('vscode')` at load time: all VS Code surfaces
 * arrive injected through the `workspace` adapter (the same seam
 * interactionBridge/extension.js use), so the module runs under node:test
 * without a real VS Code host.
 */

const ONBOARDING_DONE_KEY = 'dsh.onboarding.done';
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** True when a profile name is acceptable (pattern + not '.'/'..'). */
function isProfileNameValid(value) {
  return (
    typeof value === 'string' &&
    PROFILE_PATTERN.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function profileValidationError(value, loc) {
  if (isProfileNameValid(value)) return undefined;
  return loc(
    'Profile must be one to 64 characters matching [A-Za-z0-9._-] and must not be "." or "..".'
  );
}

/**
 * One QuickPick screen. `canPickMany` returns the selected items array,
 * otherwise a single item or null on dismiss (Esc) — null means "skip this
 * step, keep the current value".
 */
function showQuickPick(vscode, { title, placeholder, items, canPickMany = false }) {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick();
    pick.title = title;
    pick.placeholder = placeholder;
    pick.canPickMany = canPickMany;
    pick.items = items;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      pick.dispose();
    };
    pick.onDidAccept(() => {
      finish(canPickMany ? pick.selectedItems : pick.selectedItems[0] || null);
    });
    pick.onDidHide(() => finish(null));
    pick.show();
  });
}

/**
 * One InputBox screen. `validate` returns a localized error message (or
 * undefined); invalid input keeps the box open. Dismiss (Esc) resolves null —
 * the profile step then simply keeps its current value.
 */
function showInputBox(vscode, { title, prompt, value, validate }) {
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = title;
    box.prompt = prompt;
    box.value = value;
    box.placeholder = value;
    if (typeof validate === 'function' && typeof box.onDidChangeValue === 'function') {
      box.onDidChangeValue((input) => {
        box.validationMessage = validate(input) || undefined;
      });
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      box.dispose();
    };
    box.onDidAccept(() => {
      const message = typeof validate === 'function' ? validate(box.value) : undefined;
      if (message) {
        box.validationMessage = message;
        return; // keep the box open until the value is valid
      }
      finish(box.value);
    });
    box.onDidHide(() => finish(null));
    box.show();
  });
}

async function profileStep(vscode, loc, current) {
  return showInputBox(vscode, {
    title: loc('Step 1/6 · Profile'),
    prompt: loc(
      'DSH profile directory under the selected DSH home (default: web). Enter a name matching ^[A-Za-z0-9._-]{1,64}$ or press Esc to keep the current value. The change takes effect after reloading the VS Code window.'
    ),
    value: current,
    validate: (value) => profileValidationError(value, loc),
  });
}

async function autoStartStep(vscode, loc) {
  const items = [
    { id: true, label: loc('Yes — start the local DSH server when VS Code opens') },
    { id: false, label: loc('No — only reuse a DSH instance that is already running') },
  ];
  const selected = await showQuickPick(vscode, {
    title: loc('Step 2/6 · Auto-start'),
    placeholder: loc('Should the extension start DSH automatically at VS Code startup?'),
    items,
  });
  return selected === null ? null : selected.id;
}

async function closePolicyStep(vscode, loc) {
  const items = [
    { id: 'onVscodeExit', label: loc('onVscodeExit — stop only when VS Code exits') },
    { id: 'onViewClose', label: loc('onViewClose — also stop when the sidebar view is closed') },
    { id: 'never', label: loc('never — never stop automatically; use the Stop DSH Server command') },
  ];
  const selected = await showQuickPick(vscode, {
    title: loc('Step 3/6 · Close policy'),
    placeholder: loc('When should the extension stop its own DSH server?'),
    items,
  });
  return selected === null ? null : selected.id;
}

/**
 * Informational step (no key written): watchdog explanation + roadmap
 * placeholders for features that are not implemented in this release.
 */
async function infoStep(vscode, loc) {
  const items = [
    {
      id: 'watchdog',
      label: loc('Watchdog'),
      description: loc(
        'A watchdog prevents orphaned DSH servers after window/process crashes. It is configured through the DSH settings (dsh.autoStart, dsh.closePolicy, dsh.diagnose); this step changes nothing.'
      ),
    },
    {
      id: 'roadmap',
      label: loc('Coming in later releases'),
      description: loc(
        'Multi-instance windows, Tab completion, MCP integration, and model routing are planned for later releases and will be configurable here once available.'
      ),
    },
  ];
  await showQuickPick(vscode, {
    title: loc('Step 4/6 · Watchdog & roadmap'),
    placeholder: loc('Read the notes and press Enter to continue (nothing is changed).'),
    items,
  });
}

async function featureStep(vscode, loc, getSetting, featureSwitches) {
  const currentValues = {};
  const items = (featureSwitches || []).map((feature) => {
    const current = getSetting('features.' + feature.id, true) !== false;
    currentValues[feature.id] = current;
    return { id: feature.id, label: loc(feature.label), picked: current };
  });
  const next = { ...currentValues };
  const selected = await showQuickPick(vscode, {
    title: loc('Step 5/6 · Features'),
    placeholder: loc('Toggle DSH features (defaults to your current values) or press Esc to keep them unchanged.'),
    items,
    canPickMany: true,
  });
  if (selected === null) return { writes: [], next };
  const selectedIds = new Set(selected.map((entry) => entry.id));
  const writes = [];
  for (const item of items) {
    const value = selectedIds.has(item.id);
    next[item.id] = value;
    if (value !== currentValues[item.id]) writes.push({ id: item.id, value });
  }
  return { writes, next };
}

async function summaryStep(vscode, loc, summary) {
  const items = [
    { label: '$(check) ' + loc('Finish setup and apply my choices'), id: '__finish__' },
    { label: loc('Profile: {profile}', { profile: summary.profile }), id: 'profile' },
    {
      label: loc('Auto-start: {state}', { state: summary.autoStart ? loc('on') : loc('off') }),
      id: 'auto-start',
    },
    { label: loc('Close policy: {policy}', { policy: summary.policy }), id: 'close-policy' },
    { label: loc('Features: {features}', { features: summary.features }), id: 'features' },
    { label: loc('Watchdog: configured through DSH settings; nothing changed this run'), id: 'watchdog' },
  ];
  const selected = await showQuickPick(vscode, {
    title: loc('Step 6/6 · Review & finish'),
    placeholder: loc('Review your choices. Press Enter to finish, or Esc to cancel (you will be asked again on the next activation).'),
    items,
  });
  return selected !== null;
}

async function finishedMessage(vscode, loc, profileChanged) {
  const message = profileChanged
    ? loc(
        'DSH setup complete. The profile change takes effect after reloading the VS Code window. You can change any setting later in Settings (dsh.*) or run the "Set up DSH" command again.'
      )
    : loc(
        'DSH setup complete. You can change any setting later in Settings (dsh.*) or run the "Set up DSH" command again.'
      );
  await vscode.window.showInformationMessage(message);
}

/**
 * Run the multi-step wizard. Every accepted step writes its dsh.* setting
 * immediately (Global target). Skipping a step (Esc) keeps its current value;
 * the wizard always continues. Completing the final Summary step records
 * `dsh.onboarding.done = true`.
 *
 * @param {{ context: object, workspace: object }} deps
 *   context.globalState  — get/update for the one-shot `dsh.onboarding.done` gate
 *   workspace            — adapter: { vscode, loc, getSetting, updateSetting, featureSwitches }
 * @returns {Promise<{completed: boolean, changed: string[]}>}
 */
async function runOnboardingWizard({ context, workspace }) {
  const { vscode, loc, getSetting, updateSetting, featureSwitches } = workspace;
  const changed = [];

  const previousProfile = String(getSetting('profile', 'web') || 'web');
  const profile = await profileStep(vscode, loc, previousProfile);
  if (profile !== null) {
    changed.push('profile');
    await updateSetting('profile', profile);
  }

  const previousAutoStart = getSetting('autoStart', true) !== false;
  const autoStart = await autoStartStep(vscode, loc);
  if (autoStart !== null) {
    changed.push('autoStart');
    await updateSetting('autoStart', Boolean(autoStart));
  }

  const previousPolicy = String(getSetting('closePolicy', 'onVscodeExit') || 'onVscodeExit');
  const policy = await closePolicyStep(vscode, loc);
  if (policy !== null) {
    changed.push('closePolicy');
    await updateSetting('closePolicy', policy);
  }

  await infoStep(vscode, loc); // watchdog + roadmap: display only, no key

  const featureResult = await featureStep(vscode, loc, getSetting, featureSwitches);
  for (const entry of featureResult.writes) {
    changed.push('features.' + entry.id);
    await updateSetting('features.' + entry.id, entry.value);
  }

  const onFeatureLabels = (featureSwitches || [])
    .filter((feature) => featureResult.next[feature.id])
    .map((feature) => loc(feature.label));
  const confirmed = await summaryStep(vscode, loc, {
    profile: profile !== null ? profile : previousProfile,
    autoStart: autoStart !== null ? Boolean(autoStart) : previousAutoStart,
    policy: policy !== null ? policy : previousPolicy,
    features: onFeatureLabels.length > 0 ? onFeatureLabels.join(', ') : loc('none'),
  });
  if (!confirmed) return { completed: false, changed };

  await context.globalState.update(ONBOARDING_DONE_KEY, true);
  const profileChanged = profile !== null && profile !== previousProfile;
  await finishedMessage(vscode, loc, profileChanged);
  return { completed: true, changed };
}

/**
 * First-activation gate: only when `dsh.onboarding.done` is unset, ask once
 * whether to open the wizard. `Set up` runs the wizard, `Never` records the
 * gate as 'never', anything else (Not now / dismissed) leaves it for a later
 * activation. Returns a small audit object for tests.
 */
async function maybeOnboard({ vscode, context, loc, workspace }) {
  // Defensive like migrateLegacyHomeMode: a context without a functional
  // globalState (test hosts, early-teardown) simply skips the prompt.
  if (!context || !context.globalState || typeof context.globalState.get !== 'function') {
    return { prompted: false, reason: 'no-global-state' };
  }
  if (context.globalState.get(ONBOARDING_DONE_KEY)) {
    return { prompted: false, reason: 'already-done' };
  }
  const setUp = loc('Set up');
  const notNow = loc('Not now');
  const never = loc('Never');
  const answer = await vscode.window.showInformationMessage(
    loc('DSH is ready — set it up?'),
    setUp,
    notNow,
    never
  );
  if (answer === setUp) {
    await runOnboardingWizard({ context, workspace });
    return { prompted: true, choice: 'set-up' };
  }
  if (answer === never) {
    await context.globalState.update(ONBOARDING_DONE_KEY, 'never');
    return { prompted: true, choice: 'never' };
  }
  return { prompted: true, choice: 'not-now' };
}

module.exports = {
  ONBOARDING_DONE_KEY,
  isProfileNameValid,
  runOnboardingWizard,
  maybeOnboard,
};
