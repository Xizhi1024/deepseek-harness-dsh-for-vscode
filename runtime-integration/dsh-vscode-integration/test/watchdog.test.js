import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateWatchdog,
  parseHeartbeat,
  readHeartbeat,
  createWatchdogMonitor,
} from '../lib/index.js';

const EXPIRY = 60 * 1000;
const NOW = 1_800_000_000_000;

function freshHeartbeat(overrides = {}) {
  return {
    ownerPid: 4242,
    windowId: 'w-1',
    ownerStartTs: 3_333_333_333,
    lastWriteMs: NOW - 1_000, // fresh (10s old heartbeat, well under 60s)
    ...overrides,
  };
}

function expiredHeartbeat(overrides = {}) {
  return {
    ownerPid: 4242,
    windowId: 'w-1',
    ownerStartTs: 3_333_333_333,
    lastWriteMs: NOW - EXPIRY - 5_000, // expired
    ...overrides,
  };
}

const base = {
  expectedWindowId: 'w-1',
  ppid: 4242,
  ppidExists: true,
  expiryMs: EXPIRY,
  now: NOW,
};

test('evaluateWatchdog: fresh heartbeat never exits, even when the ppid is dead', () => {
  const verdict = evaluateWatchdog({
    ...base,
    heartbeat: freshHeartbeat(),
    ppidExists: false,
  });
  assert.deepStrictEqual(verdict, { exit: false, reason: 'fresh' });
});

test('evaluateWatchdog: expired + ppid alive (owner match) never exits', () => {
  const verdict = evaluateWatchdog({
    ...base,
    heartbeat: expiredHeartbeat(),
    ppidExists: true,
    ppidStartTs: 3_333_333_333, // matches recorded owner start → owner alive
  });
  assert.deepStrictEqual(verdict, { exit: false, reason: 'owner-alive' });
});

test('evaluateWatchdog: expired + ppid dead exits', () => {
  const verdict = evaluateWatchdog({
    ...base,
    heartbeat: expiredHeartbeat(),
    ppidExists: false,
  });
  assert.deepStrictEqual(verdict, { exit: true, reason: 'ppid-dead' });
});

test('evaluateWatchdog: dual condition requires BOTH factors (expired only is not enough)', () => {
  // expired but ppid alive → wait; asserts the dual-condition guard shape.
  const verdict = evaluateWatchdog({
    ...base,
    heartbeat: expiredHeartbeat(),
    ppidExists: true,
    ppidStartTs: null,
  });
  assert.deepStrictEqual(verdict, { exit: false, reason: 'start-unknown' });
});

test('evaluateWatchdog: recorded owner pid replaced/reparented → exit (owner gone)', () => {
  const verdict = evaluateWatchdog({
    ...base,
    heartbeat: expiredHeartbeat({ ownerPid: 9999 }), // recorded owner no longer our parent
    ppid: 4242,
    ppidExists: true,
  });
  assert.deepStrictEqual(verdict, { exit: true, reason: 'owner-gone' });
});

test('evaluateWatchdog: PID reuse never exits (live pid with mismatched start time)', () => {
  const verdict = evaluateWatchdog({
    ...base,
    heartbeat: expiredHeartbeat(), // ownerStartTs 3333333333
    ppidExists: true,
    ppidStartTs: 7_777_777_777, // different real start → recycled pid
  });
  assert.deepStrictEqual(verdict, { exit: false, reason: 'pid-reuse' });
});

test('evaluateWatchdog: multi-window ownership — a foreign window heartbeat never keeps us from waiting', () => {
  const verdict = evaluateWatchdog({
    ...base,
    heartbeat: expiredHeartbeat({ windowId: 'w-OTHER' }),
    ppidExists: false, // even a dead ppid cannot override a foreign heartbeat
  });
  assert.deepStrictEqual(verdict, { exit: false, reason: 'window-mismatch' });
});

test('evaluateWatchdog: missing heartbeat + live ppid → wait (safe degradation)', () => {
  const verdict = evaluateWatchdog({ ...base, heartbeat: null, ppidExists: true });
  assert.deepStrictEqual(verdict, { exit: false, reason: 'owner-unknown' });
});

test('evaluateWatchdog: missing heartbeat + dead ppid → exit (dual-condition verdict)', () => {
  const verdict = evaluateWatchdog({ ...base, heartbeat: null, ppidExists: false });
  assert.deepStrictEqual(verdict, { exit: true, reason: 'ppid-dead' });
});

test('evaluateWatchdog: not configured (no window id) never exits', () => {
  const verdict = evaluateWatchdog({
    ...base,
    expectedWindowId: '',
    heartbeat: expiredHeartbeat(),
    ppidExists: false,
  });
  assert.deepStrictEqual(verdict, { exit: false, reason: 'not-configured' });
});

test('parseHeartbeat: valid payload, garbage and empty input', () => {
  assert.deepStrictEqual(parseHeartbeat(
    '{"ownerPid":5,"windowId":"w-1","ownerStartTs":123,"at":456}'
  ), {
    ownerPid: 5,
    windowId: 'w-1',
    ownerStartTs: 123,
    lastWriteMs: 456,
  });
  assert.strictEqual(parseHeartbeat('not json'), null);
  assert.strictEqual(parseHeartbeat(''), null);
  assert.strictEqual(parseHeartbeat(null), null);
  assert.deepStrictEqual(parseHeartbeat('{}'), {
    ownerPid: null,
    windowId: '',
    ownerStartTs: null,
    lastWriteMs: null,
  });
});

test('readHeartbeat: missing file is null (expired) and corrupt content degrades to expired with mtime fallback', () => {
  assert.strictEqual(readHeartbeat('C:/definitely/not/there.json', {
    statSyncFn: () => { throw new Error('ENOENT'); },
  }), null);

  const corrupt = readHeartbeat('/corrupt.json', {
    statSyncFn: () => ({ mtimeMs: 1000 }),
    readFileSyncFn: () => 'garbage{{{',
  });
  assert.deepStrictEqual(corrupt, { lastWriteMs: 1000 });
  assert.strictEqual(corrupt.ownerPid, undefined, 'corrupt payload must not carry fabricated identity');

  const healthy = readHeartbeat('/healthy.json', {
    statSyncFn: () => ({ mtimeMs: 999 }),
    readFileSyncFn: () => '{"ownerPid":5,"windowId":"w-1","ownerStartTs":123,"at":456}',
  });
  assert.deepStrictEqual(healthy, {
    ownerPid: 5,
    windowId: 'w-1',
    ownerStartTs: 123,
    lastWriteMs: 456,
  });
});

test('createWatchdogMonitor: DSH_VSCODE_WATCHDOG=off never starts the loop', () => {
  const exits = [];
  const monitor = createWatchdogMonitor({
    env: {
      DSH_VSCODE_WATCHDOG: 'off',
      DSH_VSCODE_HEARTBEAT_PATH: '/hb.json',
      DSH_VSCODE_WINDOW_ID: 'w-1',
    },
    onExit: (verdict) => exits.push(verdict),
  });
  monitor.start();
  assert.strictEqual(monitor.running, false, 'watchdog-off must not run');
  assert.strictEqual(monitor._timer, null, 'watchdog-off must not arm a timer');
  monitor.stop();
  assert.strictEqual(exits.length, 0);
});

test('createWatchdogMonitor: missing heartbeat path never starts the loop', () => {
  const exits = [];
  const monitor = createWatchdogMonitor({
    env: { DSH_VSCODE_WINDOW_ID: 'w-1' },
    onExit: () => exits.push(1),
  });
  monitor.start();
  assert.strictEqual(monitor.running, false);
  monitor.stop();
  assert.strictEqual(exits.length, 0);
});

test('createWatchdogMonitor: dual condition met (expired + ppid dead) exits once', (t) => {
  const exits = [];
  const monitor = createWatchdogMonitor({
    env: {
      DSH_VSCODE_HEARTBEAT_PATH: '/hb.json',
      DSH_VSCODE_WINDOW_ID: 'w-1',
    },
    ppid: 4242,
    readHeartbeatFn: () => expiredHeartbeat(),
    ppidExistsFn: () => false,
    intervalMs: 1_000_000, // oversized: only the immediate check may fire
    now: () => NOW,
    onExit: (verdict) => exits.push(verdict),
  });
  monitor.start();
  t.after(() => monitor.stop());
  assert.strictEqual(exits.length, 1);
  assert.deepStrictEqual(exits[0], { exit: true, reason: 'ppid-dead' });
  assert.strictEqual(monitor.running, false, 'exit must stop the monitor');
  assert.strictEqual(monitor._timer, null, 'exit must clear the timer');
});

test('createWatchdogMonitor: fresh heartbeat keeps the process alive (no exit, loop armed)', (t) => {
  const exits = [];
  const monitor = createWatchdogMonitor({
    env: {
      DSH_VSCODE_HEARTBEAT_PATH: '/hb.json',
      DSH_VSCODE_WINDOW_ID: 'w-1',
    },
    ppid: 4242,
    readHeartbeatFn: () => freshHeartbeat(),
    ppidExistsFn: () => false, // even a dead ppid does not exit while fresh
    intervalMs: 1_000_000,
    now: () => NOW,
    onExit: (verdict) => exits.push(verdict),
  });
  monitor.start();
  t.after(() => monitor.stop());
  assert.strictEqual(exits.length, 0);
  assert.strictEqual(monitor.running, true, 'loop must stay armed until stopped');
  assert.notStrictEqual(monitor._timer, null);
});
