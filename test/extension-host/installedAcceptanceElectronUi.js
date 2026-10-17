'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function verifyElectronUi({ playwrightModulePath, port, readyPath, continuePath, seededPath, releasePath, expected, runRoot, signal, runtimeVersion = '0.2.0-rc.1', scope = 'full' }) {
  const { chromium } = require(playwrightModulePath);
  let browser;
  const deadline = Date.now() + 210000;
  try {
    while (!browser && Date.now() < deadline) {
      signal?.throwIfAborted();
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 }); } catch { await pause(200); }
    }
    assert.ok(browser, 'Dedicated VS Code CDP endpoint did not start');
    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      window.__dshAcceptanceEvents = [];
      addEventListener('message', event => {
        const m = event.data;
        if (m && m.channel === 'dsh-vscode-session' && ['hello-ack', 'targetChanged', 'result'].includes(m.type)) window.__dshAcceptanceEvents.push(m);
      });
    });
    while (!fs.existsSync(readyPath) && Date.now() < deadline) { signal?.throwIfAborted(); await pause(100); }
    assert.ok(fs.existsSync(readyPath), 'Installed activation did not become ready');
    fs.writeFileSync(continuePath, 'continue');
    let runtimeFrame, shellFrame, ack, target;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      for (const page of context.pages()) for (const frame of page.frames()) {
        try {
          // VS Code document-writes the product shell into active-frame. That
          // same-origin child does not get CDP addInitScript callbacks.
          await frame.evaluate(() => {
            const child = document.getElementById('active-frame')?.contentWindow;
            if (!child || child.__dshAcceptanceObserved) return;
            child.__dshAcceptanceObserved = true;
            child.addEventListener('message', event => {
              const m = event.data;
              if (m && m.channel === 'dsh-vscode-session' && ['hello-ack', 'targetChanged', 'result'].includes(m.type)) window.__dshAcceptanceEvents.push(m);
            });
          });
          const address = new URL(frame.url());
          if (address.searchParams.get('dsh_runtime') === runtimeVersion && ['127.0.0.1', 'localhost'].includes(address.hostname)) runtimeFrame = frame;
          // Electron can expose a webview execution context before its Frame
          // navigation metadata updates. Inspect the actual document as well.
          const actualAddress = await frame.evaluate(() => location.href);
          const actual = new URL(actualAddress);
          if (actual.searchParams.get('dsh_runtime') === runtimeVersion && ['127.0.0.1', 'localhost'].includes(actual.hostname)) {
            runtimeFrame = frame;
            // The native preview consent and initial empty Session can defer
            // the main conversation target; interact before requiring one.
            const notice = frame.getByRole('button', { name: 'Continue', exact: true });
            if (await notice.isVisible()) await notice.click({ timeout: 1000 });
            if (fs.existsSync(seededPath)) {
              const openSidebar = frame.getByRole('button', { name: 'Open sidebar', exact: true });
              if (await openSidebar.isVisible()) await openSidebar.click({ timeout: 1000 });
              const alpha = frame.getByRole('treeitem').filter({ hasText: 'UI search alpha' });
              if (await alpha.isVisible()) await alpha.click({ timeout: 1000 });
            }
          }
          const observed = await frame.evaluate(() => (window.__dshAcceptanceEvents || []).filter(m => m.type === 'hello-ack' || m.type === 'targetChanged'));
          const foundAck = observed.find(m => m.type === 'hello-ack');
          const foundTarget = observed.findLast(m => m.type === 'targetChanged' && m.target.state === 'known');
          if (foundAck) { ack = foundAck; shellFrame = frame; }
          if (foundTarget) target = foundTarget.target;
        } catch { /* Frames are detached as the VS Code webview initializes. */ }
      }
      if (runtimeFrame && shellFrame && ack && target) break;
      await pause(150);
    }
    assert.ok(runtimeFrame && shellFrame && ack && target, 'Actual installed webview did not produce hello-ack and a known target');
    assert.equal(ack.runtimeVersion, runtimeVersion);
    assert.equal(ack.adapterId, `dsh-${runtimeVersion}`);
    while (!fs.existsSync(seededPath) && Date.now() < deadline) { signal?.throwIfAborted(); await pause(100); }
    assert.ok(fs.existsSync(seededPath), 'Installed exports did not seed the local-provider sessions');
    const files = {};
    for (const file of ['client.js', 'client.dsh020.js', 'client.sessionBridge.js']) {
      const source = await runtimeFrame.evaluate(async file => {
        const response = await fetch(`/plugins/dsh-vscode-integration/${file}`);
        if (!response.ok) throw new Error(`Cannot fetch packaged ${file}: ${response.status}`);
        return response.text();
      }, file);
      const hash = createHash('sha256').update(source).digest('hex');
      assert.equal(hash, expected.files[`runtime-integration/dsh-vscode-integration/lib/${file}`], `Runtime served different packaged bytes: ${file}`);
      files[file] = hash;
    }
    const resources = await runtimeFrame.evaluate(() => performance.getEntriesByType('resource').map(r => new URL(r.name).pathname));
    for (const file of ['client.dsh020.js', 'client.sessionBridge.js']) assert.ok(resources.some(name => name.endsWith(`/${file}`)), `Chunk not loaded: ${file}`);
    await shellFrame.evaluate(() => { window.__vscodeEvents = window.__dshAcceptanceEvents; });
    const notice = runtimeFrame.getByRole('button', { name: /^(继续|Continue)$/ });
    if (await notice.isVisible()) await notice.click();
    const expandSidebar = runtimeFrame.getByRole('button', { name: /^(打开侧边栏|Open sidebar)$/ });
    if (await expandSidebar.isVisible()) await expandSidebar.click();
    const alpha = runtimeFrame.getByRole('treeitem').filter({ hasText: 'UI search alpha' });
    await alpha.waitFor(); await alpha.click();
    if (scope === 'basic') {
      const composer = runtimeFrame.locator('[role="textbox"][contenteditable="true"]').first();
      await composer.waitFor();
      const before = await runtimeFrame.getByText('alpha beta', { exact: true }).count();
      await composer.fill('sprint1 ordinary message');
      await composer.press('Enter');
      await runtimeFrame.getByText('sprint1 ordinary message', { exact: true }).waitFor();
      await runtimeFrame.getByText('alpha beta', { exact: true }).nth(before).waitFor({ timeout: 30000 });
      await runtimeFrame.page().screenshot({ path: path.join(runRoot, 'installed-ui.png') });
      return { status: 'PASS', scope: 'S1 installed native iframe, exact handshake, packaged chunks and ordinary UI message/response',
        runtimeVersion: ack.runtimeVersion, adapterId: ack.adapterId, target, servedFileHashes: files,
        ordinaryMessageResponse: true, localDeterministicProvider: true, screenshot: 'installed-ui.png' };
    }
    // Resize the actual embedded iframe viewport inside the installed Code
    // webview. This does not claim native workbench sidebar drag coverage.
    const facade = {
      locator: () => ({ contentFrame: () => runtimeFrame }),
      evaluate: (...args) => shellFrame.evaluate(...args),
      waitForFunction: (...args) => shellFrame.waitForFunction(...args),
      context: () => context,
      setViewportSize: async ({ width, height }) => {
        await shellFrame.evaluate(({ width, height }) => { const frame = document.getElementById('frame'); frame.style.width = `${width}px`; frame.style.height = `${height}px`; }, { width, height });
        await runtimeFrame.waitForFunction(width => innerWidth === width, width);
      },
      screenshot: ({ path: file }) => runtimeFrame.page().screenshot({ path: path.join(runRoot, path.basename(file)) }),
    };
    const runProbe = name => {
      const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
      return new Function(`return (${source});`)()(facade);
    };
    const search = await runProbe('installedAcceptanceUiSearch.js');
    // Focus is in the real nested iframe; CDP sends native IME input there.
    facade.context = () => ({ newCDPSession: () => context.newCDPSession(runtimeFrame.page()) });
    const ime = await runProbe('installedAcceptanceUiIme.js');
    const insertion = await runProbe('installedAcceptanceUiInsertion.js');
    await runtimeFrame.page().screenshot({ path: path.join(runRoot, 'installed-ui.png') });
    return { status: 'PASS', scope: 'actual installed VS Code webview runtime, packaged chunk bytes, nonce handshake and observed main target',
      runtimeVersion: ack.runtimeVersion, adapterId: ack.adapterId, capabilities: ack.capabilities, target, servedFileHashes: files,
      search, ime, insertion, viewportMethod: 'actual embedded iframe viewport resized; native workbench drag not covered' };
  } finally {
    fs.writeFileSync(releasePath, 'release');
    // disconnect from CDP; test-electron and the extension own process teardown.
    if (browser?.isConnected()) await Promise.race([browser.close(), pause(3000)]);
  }
}
module.exports = { verifyElectronUi };
