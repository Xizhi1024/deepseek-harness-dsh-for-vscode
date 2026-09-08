# src/ch1

## Responsibility

**Service Layer — outbound notification coalescing service.** This directory contains the CH1 v2 metadata-notification coalescer (`notifier.js`, spec SM-6). It sits between the VS Code extension's event sources (editor selection, active editor, diagnostics) and the versioned bridge transport, converting bursts of metadata-only notifications into at most one wire notification per `method + uri` bucket per coalescing window. It owns no transport itself: it validates, buffers, deduplicates, and flushes to an injected `send` sink.

## Design Patterns

- **Factory (Module-level)**: `createNotifier({ send, windowMs = 150, maxPending = 64 })` is the sole export; it constructs and returns a frozen facade object. Throws `TypeError` on a missing `send` function, non-finite/negative `windowMs`, or non-integer `maxPending < 1`.
- **Facade**: the returned `Object.freeze({ push, flush, dispose, get pendingCount, get stats })` hides the internal `pending` Map, timer, and counters.
- **Strategy / Dependency Injection**: the delivery behavior is injected as the `send(method, params)` callback; the notifier is transport-agnostic (send may be sync or return a thenable).
- **Debounced batching (timer window + size-triggered flush)**: a single `setTimeout(windowMs)` (unref'd when available) schedules a flush; reaching `maxPending` distinct buckets flushes immediately.
- **Last-write-wins coalescing keyed by `pendingKey(method, params)` = `method + "\n" + uri`** — a later `push` for the same method+uri replaces the earlier pending params.
- **Guard clauses / re-entrancy protection**: `flush()` is a no-op when `disposed`, already `flushing`, or `pending.size === 0`; `push` throws on invalid method/params and is a silent no-op after dispose.
- **Schema validation at the boundary**: for methods present in `V2_NOTIFICATION_SCHEMA` (imported from `../protocol/ch1`), `push` calls `validateV2NotificationParams` before buffering.

## Data & Control Flow

**Inbound**: callers call `push(method, params)` with a non-empty string method and a plain object params. Known v2 notification methods are validated against `V2_NOTIFICATION_SCHEMA`. The item is keyed by `method + uri` (uri taken from `params.uri`, default `''`) and stored in the `pending` Map (replacing any prior entry for the same key). Then either:
- `pending.size >= maxPending` → immediate `flush()`, or
- `scheduleFlush()` → single `setTimeout(flush, windowMs)` with `unref()` where supported.

**Outbound**: `flush()` clears the timer, snapshots and clears `pending`, increments `flushCount`, and iterates items in insertion order calling `send(item.method, item.params)`. Sync returns and resolved promises increment `stats.sent`; thrown errors and rejected promises increment `stats.sendFailures` (errors never propagate out of flush). Promise settlement updates stats asynchronously.

**State transitions**: `fresh → (push/flush cycles) → disposed`. `dispose()` sets `disposed = true`, clears the timer, counts leftover entries into `stats.dropped`, and empties the map; all subsequent `push`/`flush` calls are no-ops.

**Concrete wiring (in `src/extension.js`)**: `activate` creates the notifier with `send: (method, params) => versionedBridge?.notify?.(method, params)` (~line 1817). The wrapper `pushV2Notification(method, params)` drops events when no v2 client has completed `initialize` (`hasV2Bridge()`), then pushes. Producer events: `vscode/editor/selectionChanged`, `vscode/editor/activeEditorChanged`, `vscode/diagnosticsChanged`. Disposal is registered in `context.subscriptions` and on teardown paths (extension.js ~lines 1828, 1935).

## Integration Points

**Dependencies (imports)**:
- `../protocol/ch1` → `V2_NOTIFICATION_SCHEMA`, `validateV2NotificationParams` (protocol contract module; `src/protocol/ch1` has its own mapper).

**Consumers (importers)**:
- `src/extension.js` — requires `createNotifier` from `./ch1/notifier` and wires it to `VersionedBridgeServer.notify` for v2 metadata notifications.
- `test/unit/notifier.test.js` and `test/unit/b3-qa-notifier.test.js` — unit tests driving the notifier with fake `send` sinks.
- `scripts/check-package-contents.js` — packaging allowlist references `src/ch1/notifier.js`.

**APIs / events surfaced**: `createNotifier`; notifier instance API `push(method, params)`, `flush()`, `dispose()`, `pendingCount`, `stats { sent, sendFailures, flushCount, dropped }`. Consumed protocol notification methods (emitted through the injected sink): `vscode/editor/selectionChanged`, `vscode/editor/activeEditorChanged`, `vscode/diagnosticsChanged`.

## Files

- `notifier.js` (~149 lines) — CH1 v2 notification coalescer factory: validates params, deduplicates by method+uri, flushes on window timeout or maxPending, tracks send/flush/drop stats, freezes its facade API.
- `codemap.md` — this map.
