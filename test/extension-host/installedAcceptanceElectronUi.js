'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function verifyElectronUi({ playwrightModulePath, port, readyPath, continuePath, seededPath, releasePath, expected, runRoot, signal, runtimeVersion = '0.2.0-rc.1', scope = 'full', coordinationRoot, windowRole }) {
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
          await frame.evaluate(seeded => {
            const child = document.getElementById('active-frame')?.contentWindow;
            if (!child) return;
            if (!child.__dshAcceptanceObserved) {
              child.__dshAcceptanceObserved = true;
              child.addEventListener('message', event => {
                const m = event.data;
                if (m && m.channel === 'dsh-vscode-session' && ['hello-ack', 'targetChanged', 'result'].includes(m.type)) window.__dshAcceptanceEvents.push(m);
              });
            }
            const nativeFrame = child.document.getElementById('frame');
            if (seeded && nativeFrame && !child.__dshAcceptanceReloaded) {
              child.__dshAcceptanceReloaded = true;
              window.__dshAcceptanceEvents = [];
              // Reopen the real native iframe after installed exports seeded
              // two durable Sessions; observe its fresh generation handshake.
              nativeFrame.src = nativeFrame.src;
            }
          }, fs.existsSync(seededPath));
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
            if (await notice.isVisible()) await notice.dispatchEvent('click', {}, { timeout: 1000 });
            if (fs.existsSync(seededPath)) {
              const openSidebar = frame.getByRole('button', { name: 'Open sidebar', exact: true });
              if (await openSidebar.isVisible()) await openSidebar.dispatchEvent('click', {}, { timeout: 1000 });
              const alpha = frame.getByRole('treeitem').filter({ hasText: 'UI search alpha' });
              if (await alpha.isVisible()) await alpha.dispatchEvent('click', {}, { timeout: 1000 });
            }
          }
          const observed = await frame.evaluate(() => (window.__dshAcceptanceEvents || []).filter(m => m.type === 'hello-ack' || m.type === 'targetChanged'));
          const foundAck = observed.findLast(m => m.type === 'hello-ack');
          const foundTarget = observed.findLast(m => m.type === 'targetChanged' && m.target.state === 'known'
            && (!foundAck || m.surfaceEpoch === foundAck.surfaceEpoch));
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
    const responseHashes = {};
    for (const file of ['client.js', 'client.dsh020.js', 'client.sessionBridge.js']) {
      const source = await runtimeFrame.evaluate(async file => {
        const entry = window.__DSH_BOOT__?.entries.find(row => row.id === 'dsh-vscode-integration');
        const address = file === 'client.js' ? entry?.url : `/plugins/dsh-vscode-integration/${file}?rev=${entry?.rev}`;
        if (!address) throw new Error('Installed integration is missing from the native boot manifest');
        const response = await fetch(address);
        if (!response.ok) throw new Error(`Cannot fetch packaged ${file}: ${response.status} from ${location.origin}`);
        return response.text();
      }, file);
      fs.writeFileSync(path.join(runRoot, `served-${file}`), source);
      responseHashes[file] = createHash('sha256').update(source).digest('hex');
      // The official module server wraps a single main entry with a separator
      // and revisioned source-map trailer (buildComboScript/ comboScript).
      // Strip only that exact transport suffix; all packaged body bytes stay.
      const transportSuffix = file === 'client.js'
        ? /;\n\/\/# sourceMappingURL=\?\?dsh-vscode-integration\/client\.js\.map&rev=[a-f0-9]{12}\n$/
        : new RegExp(`;\\n//\\# sourceMappingURL=${file.replaceAll('.', '\\.')}\\.map\\?rev=[a-f0-9]{12}\\n$`);
      const packagedSource = source.replace(transportSuffix, '');
      const hash = createHash('sha256').update(packagedSource).digest('hex');
      assert.equal(hash, expected.files[`runtime-integration/dsh-vscode-integration/lib/${file}`], `Runtime served different packaged bytes: ${file}`);
      files[file] = hash;
    }
    const resources = await runtimeFrame.evaluate(() => performance.getEntriesByType('resource').map(r => new URL(r.name).pathname));
    for (const file of ['client.dsh020.js', 'client.sessionBridge.js']) assert.ok(resources.some(name => name.endsWith(`/${file}`)), `Chunk not loaded: ${file}`);
    await shellFrame.evaluate(() => { window.__vscodeEvents = window.__dshAcceptanceEvents; });
    const notice = runtimeFrame.getByRole('button', { name: /^(继续|Continue)$/ });
    if (await notice.isVisible()) await notice.dispatchEvent('click');
    const expandSidebar = runtimeFrame.getByRole('button', { name: /^(打开侧边栏|Open sidebar)$/ });
    if (await expandSidebar.isVisible()) await expandSidebar.dispatchEvent('click');
    const alpha = runtimeFrame.getByRole('treeitem').filter({ hasText: 'UI search alpha' });
    await alpha.waitFor({ timeout: 15000 }); await alpha.dispatchEvent('click');
    if (scope === 'basic') {
      const waitForPeer = async name => {
        const file = path.join(coordinationRoot, name);
        while (!fs.existsSync(file) && Date.now() < deadline) { signal?.throwIfAborted(); await pause(100); }
        assert.ok(fs.existsSync(file), `Peer window did not reach ${name}`);
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      };
      if (coordinationRoot) {
        const own = await waitForPeer(`${windowRole}-ready.json`);
        const peer = await waitForPeer(`${windowRole === 'a' ? 'b' : 'a'}-ready.json`);
        assert.notEqual(own.extensionHostPid, peer.extensionHostPid);
        assert.notDeepEqual(own.workspaceFolders, peer.workspaceFolders);
      }
      const collapseSidebar = runtimeFrame.getByRole('button', { name: 'Collapse sidebar', exact: true });
      if (await collapseSidebar.isVisible()) await collapseSidebar.dispatchEvent('click');
      const composer = runtimeFrame.locator('[role="textbox"][contenteditable="true"]').first();
      await composer.waitFor();
      await runtimeFrame.getByText('alpha beta', { exact: true }).first().waitFor({ timeout: 15000 });
      const before = await runtimeFrame.getByText('alpha beta', { exact: true }).count();
      await composer.fill('sprint1 ordinary message');
      await composer.press('Enter');
      await runtimeFrame.getByText('sprint1 ordinary message', { exact: true }).waitFor();
      const response = runtimeFrame.getByText('alpha beta', { exact: true }).nth(before);
      await response.waitFor({ timeout: 30000 });
      await response.scrollIntoViewIfNeeded({ timeout: 5000 });
      let pairedWindows;
      const nativeTheme = await runtimeFrame.evaluate(() => ({ source: document.documentElement.dataset.dsThemeSource, expected: new URLSearchParams(location.search).get('dsh_theme'), origin: location.origin }));
      assert.equal(nativeTheme.source, nativeTheme.expected);
      if (coordinationRoot) {
        fs.writeFileSync(path.join(coordinationRoot, `${windowRole}-ui.json`), JSON.stringify({ target, origin: nativeTheme.origin, completedAt: new Date().toISOString() }));
        const peer = await waitForPeer(`${windowRole === 'a' ? 'b' : 'a'}-ui.json`);
        assert.notEqual(peer.target.sessionId, target.sessionId);
        assert.notEqual(peer.origin, nativeTheme.origin);
        pairedWindows = { role: windowRole, separateWorkspacesAndProcesses: true, separateSessions: true };
        if (windowRole === 'b') {
          await waitForPeer('a-closed.json');
          const count = await runtimeFrame.getByText('alpha beta', { exact: true }).count();
          await composer.fill('window B survives window A close'); await composer.press('Enter');
          const afterClose = runtimeFrame.getByText('alpha beta', { exact: true }).nth(count);
          await afterClose.waitFor({ timeout: 30000 }); await afterClose.scrollIntoViewIfNeeded({ timeout: 5000 });
          pairedWindows.responseAfterPeerWindowClosed = true;
        }
      }
      await runtimeFrame.page().screenshot({ path: path.join(runRoot, 'installed-ui.png') });
      return { status: 'PASS', scope: 'S1 installed native iframe, exact handshake, packaged chunks and ordinary UI message/response',
        runtimeVersion: ack.runtimeVersion, adapterId: ack.adapterId, target, servedFileHashes: files, servedResponseHashes: responseHashes,
        byteComparison: 'Exact package bodies after excluding only official separator and revisioned source-map trailers',
        uiInputMethod: 'DOM-dispatched native controls and focused composer keyboard; pointer hit geometry is not certified',
        viewportProfile: 'Maximized native VS Code auxiliary bar; optional changes-review view disabled',
        ordinaryMessageResponse: true, nativeIframeReopened: true, nativeTheme, pairedWindows, localDeterministicProvider: true, screenshot: 'installed-ui.png' };
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
