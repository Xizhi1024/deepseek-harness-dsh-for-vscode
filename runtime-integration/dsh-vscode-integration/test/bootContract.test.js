import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inject, name } from '../lib/index.js';

// Boot contract: the host boots this package through the embed overlay's
// `insert` row, and cordis keeps a declared-but-missing injected service
// pending forever. On typert runtimes (dsh >= 0.1.3-alpha.2) no `apiProxy`
// service exists, so declaring it here used to fail the WHOLE boot
// ("1 entry did not activate"), the extension's self-heal restarted without
// the overlay, and the instance ran plugin-less — no dsh_session consumer,
// so a newly opened VS Code window's workspace never followed in the
// sidebar (live bug 2026-09-18). These assertions pin the fix.
test('inject never names a service the typert gateway does not provide', () => {
  assert.ok(!inject.includes('apiProxy'), 'apiProxy is gone on typert dsh; declaring it aborts the whole boot');
});

test('inject still declares every service the plugin construction paths touch', () => {
  // createBridgeTools needs ctx.tools.register, createLmRoutes needs ctx.llm,
  // and every route factory requires ctx.webServer.register.
  for (const service of ['tools', 'llm', 'webServer']) {
    assert.ok(inject.includes(service), `inject must include ${service}`);
  }
});

test('plugin identity is stable for the overlay insert row', () => {
  // The embed overlay inserts `- id: vscode-integration, name:
  // dsh-vscode-integration`; the loader resolves the row by package name.
  assert.equal(name, 'dsh-vscode-integration');
});
