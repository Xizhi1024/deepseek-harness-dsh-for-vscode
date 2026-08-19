'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  STARTUP_ERRORS,
  isRetryableStartupError,
  renderStartupError,
  startupErrorTable,
} = require('../../src/startupErrors');

const root = path.resolve(__dirname, '../..');

function readBundle(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'l10n', name), 'utf8'));
}

function fakeLoc(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

test('startup error table defines retryable/template/diagnoseHint for every code', () => {
  const codes = Object.keys(STARTUP_ERRORS);
  assert.ok(codes.length >= 13, 'taxonomy should contain the frozen startup code set');
  for (const code of codes) {
    const def = STARTUP_ERRORS[code];
    assert.equal(typeof def.retryable, 'boolean', `${code}.retryable must be boolean`);
    assert.equal(typeof def.template, 'string', `${code}.template must be string`);
    assert.ok(def.template.length > 0, `${code}.template must not be empty`);
    assert.equal(typeof def.diagnoseHint, 'string', `${code}.diagnoseHint must be string`);
    assert.ok(def.diagnoseHint.length > 0, `${code}.diagnoseHint must not be empty`);
  }
});

test('SPAWN_EXITED_EARLY is retryable and HEALTH_TIMEOUT carries a restart hint', () => {
  assert.equal(STARTUP_ERRORS.SPAWN_EXITED_EARLY.retryable, true);
  assert.match(STARTUP_ERRORS.HEALTH_TIMEOUT.diagnoseHint, /restart/i);
});

test('configuration-only startup codes stay non-retryable', () => {
  assert.equal(isRetryableStartupError({ code: 'AUTOSTART_DISABLED' }), false);
  assert.equal(isRetryableStartupError({ code: 'CONFIG_HOST_UNSUPPORTED' }), false);
  assert.equal(isRetryableStartupError({ code: 'CONFIG_PORT_INVALID' }), false);
  assert.equal(isRetryableStartupError({ code: 'CONFIG_PACKAGE_ROOT_INVALID' }), false);
  assert.equal(isRetryableStartupError({ code: 'CONFIG_NODE_PATH_INVALID' }), false);
  assert.equal(isRetryableStartupError({ code: 'CONFIG_HOME_PATH_INVALID' }), false);
  assert.equal(isRetryableStartupError({ code: 'CONFIG_PROFILE_INVALID' }), false);
});

test('runtime/spawn/health codes and unknown errors stay retryable', () => {
  assert.equal(isRetryableStartupError({ code: 'RUNTIME_NOT_INSTALLED' }), true);
  assert.equal(isRetryableStartupError({ code: 'RUNTIME_NODE_MISSING' }), true);
  assert.equal(isRetryableStartupError({ code: 'NO_FREE_PORT' }), true);
  assert.equal(isRetryableStartupError({ code: 'SPAWN_ERROR' }), true);
  assert.equal(isRetryableStartupError({ code: 'SPAWN_EXITED_EARLY' }), true);
  assert.equal(isRetryableStartupError({ code: 'HEALTH_TIMEOUT' }), true);
  assert.equal(isRetryableStartupError({ code: 'BRIDGE_INIT_TIMEOUT' }), true);
  assert.equal(isRetryableStartupError(new Error('download failed')), true);
  assert.equal(isRetryableStartupError(undefined), true);
});

test('renderStartupError uses taxonomy template and appends underlying message only when different', () => {
  const known = new Error('Invalid dsh.port "99999"; expected an integer from 1 to 65535');
  known.code = 'CONFIG_PORT_INVALID';
  known.params = { port: 99999 };
  assert.equal(
    renderStartupError(known, fakeLoc),
    'Invalid dsh.port "99999"; expected an integer from 1 to 65535'
  );

  const withDetail = new Error('dsh.local.packageRoot must be absolute (Windows drive-letter path on win32)');
  withDetail.code = 'CONFIG_PACKAGE_ROOT_INVALID';
  withDetail.params = { path: 'relative/path' };
  assert.equal(
    renderStartupError(withDetail, fakeLoc),
    'Invalid dsh.local.packageRoot: relative/path — dsh.local.packageRoot must be absolute (Windows drive-letter path on win32)'
  );
});

test('renderStartupError falls back to original text for unknown codes', () => {
  const unknown = new Error('some raw startup failure');
  assert.equal(renderStartupError(unknown, fakeLoc), 'some raw startup failure');
  assert.equal(renderStartupError(undefined, fakeLoc), 'undefined');
});

test('startupErrorTable emits one line per code', () => {
  const table = startupErrorTable();
  const lines = table.split('\n').filter(Boolean);
  assert.equal(lines.length, Object.keys(STARTUP_ERRORS).length);
  for (const code of Object.keys(STARTUP_ERRORS)) {
    assert.ok(lines.some((line) => line.startsWith(`${code}:`)), `table must include ${code}`);
  }
});

test('every startup error template is present in both l10n bundles', () => {
  const en = readBundle('bundle.l10n.json');
  const zh = readBundle('bundle.l10n.zh-cn.json');
  for (const code of Object.keys(STARTUP_ERRORS)) {
    const template = STARTUP_ERRORS[code].template;
    assert.ok(Object.prototype.hasOwnProperty.call(en, template), `en bundle missing ${code} template`);
    assert.ok(Object.prototype.hasOwnProperty.call(zh, template), `zh-cn bundle missing ${code} template`);
  }
});
