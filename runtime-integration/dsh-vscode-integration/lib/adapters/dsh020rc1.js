import { randomUUID } from 'node:crypto';
import path from 'node:path';
import contract from '../../contracts/validate.cjs';

const { createPortError } = contract;
const fail = (message) => { throw createPortError('RESYNC_REQUIRED', message, { retryable: true }); };
const workspaceSummary = (item) => ({ id: item.workspaceId, rootPath: item.path, name: item.title ?? null });

/** Expand only the compact record vocabulary published by the pinned dsh-llm. */
export function expandCompactStream(records) {
  const chunks = [];
  for (const record of records) {
    if (record.type === 'chunk') chunks.push(record.chunk);
    else if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      if (!Array.isArray(record.texts) || record.texts.some((text) => typeof text !== 'string')) fail('Invalid compact text stream');
      for (const text of record.texts) chunks.push({ type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: record.index, text });
    } else if (record.type === 'tool-call-chunks') {
      if (!Array.isArray(record.args)) fail('Invalid compact tool stream');
      for (const argument of record.args) chunks.push({ type: 'tool-call-delta', index: record.index, argumentsDelta: argument });
    } else fail('Unsupported compact stream record');
    if (chunks.length > 100000) throw createPortError('BACKPRESSURE', 'Assistant baseline is too large');
  }
  return chunks;
}

function content(parts) {
  return (Array.isArray(parts) ? parts : []).map((part) => {
    if (part.type === 'text') return { kind: 'text', text: part.text };
    // Durable attachments have service-owned IDs, not authorized public URLs.
    return { kind: 'unsupported', mediaType: part.type || 'unknown', label: part.attachment?.name || `[${part.type || 'unsupported'}]` };
  });
}

function recordFor(event, toolCalls) {
  if (event.surfaceOp !== 'append') return null;
  const data = event.data;
  let kind;
  let message;
  let tool = null;
  if (event.type === 'user/message') { kind = 'user'; message = data; }
  else if (event.type === 'assistant/message') { kind = 'assistant'; message = data.message; }
  else if (event.type === 'tool/result') {
    kind = 'tool'; message = data.message;
    const call = toolCalls.get(message.toolCallId);
    tool = { callId: message.toolCallId, name: call?.name || 'unknown', state: message.isError ? 'failed' : 'succeeded' };
  } else return null;
  return { id: `event:${event.seq}`, kind, content: content(message.content),
    clientRequestId: message.source?.kind === 'user' && typeof message.source.rpcId === 'string' ? message.source.rpcId : null, tool };
}

export function createDsh020rc1Adapter({ ctx, runtimeInstanceId, integrationVersion, runtimeVersion }) {
  if (runtimeVersion !== '0.2.0-rc.1') throw createPortError('UNSUPPORTED_RUNTIME', 'The facade requires DSH 0.2.0-rc.1');
  const sessions = ctx.sessionController;
  const workspaces = ctx.workspaceController;
  const pendingRoots = new Map();
  async function workspaceBaseline(op) {
    const iterator = workspaces.follow(op.signal)[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (first.done || first.value.type !== 'baseline' || !Array.isArray(first.value.value.items)) fail('Workspace baseline unavailable');
      return first.value.value;
    } finally { await iterator.return?.(); }
  }
  async function listSessions(workspaceId, op) {
    const [value, baseline] = await Promise.all([sessions.list({}, op.signal), workspaceBaseline(op)]);
    return value.items.filter((item) => item.origin !== 'subagent').map((item) => {
      const workspace = baseline.items.find((candidate) => candidate.sessionIds.includes(item.sessionId));
      return { id: item.sessionId, workspaceId: workspace?.workspaceId ?? null,
        title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : null,
        updatedAt: Number.isSafeInteger(item.updatedAt) ? new Date(item.updatedAt).toISOString() : null };
    }).filter((item) => workspaceId === null || item.workspaceId === workspaceId);
  }
  async function ensureWorkspace(rootPath, op) {
    const normalized = path.resolve(rootPath);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const previous = pendingRoots.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      op.signal.throwIfAborted();
      const baseline = await workspaceBaseline(op);
      const found = baseline.items.find((item) => (process.platform === 'win32' ? path.resolve(item.path).toLowerCase() : path.resolve(item.path)) === key);
      if (found) return workspaceSummary(found);
      const result = await workspaces.create({ path: normalized });
      return workspaceSummary(result.workspace);
    });
    pendingRoots.set(key, task);
    try { return await task; }
    finally { if (pendingRoots.get(key) === task) pendingRoots.delete(key); }
  }
  async function openFeed(sessionId, op) {
    const controller = new AbortController();
    const abort = () => controller.abort(op.signal.reason);
    if (op.signal.aborted) abort(); else op.signal.addEventListener('abort', abort, { once: true });
    const upstream = sessions.follow({ address: { kind: 'session', sessionId }, maxMessages: 200, assistantStream: true }, controller.signal)[Symbol.asyncIterator]();
    const streamEpoch = randomUUID();
    let deliverySeq = 0;
    let sourceRevision = 0;
    let sourceCursor = -1;
    let active = null;
    let closed = false;
    let used = false;
    const toolCalls = new Map();
    let currentTurn = null;
    let requestIds = new Set();
    const wrap = (payload) => ({ ...payload, runtimeInstanceId, sessionId, streamEpoch, deliverySeq: ++deliverySeq });
    const correlated = () => requestIds.size === 1 ? [...requestIds][0] : null;
    function inspect(event) {
      if (event.type === 'turn/start') { currentTurn = event.data.turn; requestIds = new Set(); }
      if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source?.kind === 'user' && event.data.source.rpcId) requestIds.add(event.data.source.rpcId);
      if (event.type === 'tool/call') {
        if (toolCalls.size >= 256) throw createPortError('BACKPRESSURE', 'Too many unresolved tool calls');
        toolCalls.set(event.data.callId, event.data);
      }
    }
    function observation(event) {
      if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return null;
      const nested = event.type === 'tool/ptc-dispatch';
      const message = nested ? { toolCallId: event.data.subCallId, isError: event.data.isError } : event.data.message;
      const call = nested ? event.data : toolCalls.get(message.toolCallId);
      if (!nested) toolCalls.delete(message.toolCallId);
      if (!call || message.isError || !['edit', 'write'].includes(call.name)) return null;
      let args;
      try { args = nested ? call.arguments : JSON.parse(call.arguments); } catch { return null; }
      if (typeof args.file_path !== 'string' || !args.file_path) return null;
      return { observationId: `${sessionId}:${event.seq}:${message.toolCallId}`, runtimeInstanceId, sessionId,
        path: args.file_path, tool: call.name, phase: 'confirmed', origin: 'session-event', toolCallId: message.toolCallId,
        sourceDurableSeq: String(event.seq), beforeText: null };
    }
    function chunkPayload(chunk) {
      if (!active) fail('Assistant chunk without start');
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return null;
      if (typeof chunk.text !== 'string') fail('Invalid assistant text');
      return { kind: 'assistant-chunk', attemptId: active.id, revision: active.revision,
        index: active.normalizedIndex++, text: chunk.text, channel: chunk.type === 'text-delta' ? 'answer' : 'reasoning' };
    }
    async function close() {
      if (closed) return;
      closed = true;
      controller.abort();
      op.signal.removeEventListener('abort', abort);
      await upstream.return?.();
    }
    const opening = await upstream.next().catch(async (error) => { await close(); throw error; });
    if (opening.done || opening.value.type !== 'snapshot') { await close(); fail('Missing session snapshot'); }
    const first = opening.value;
    if (first.header.id !== sessionId) { await close(); fail('Session snapshot identity mismatch'); }
    async function* events() {
      try {
        const records = [];
        const historyObservations = [];
        let historicalTurn = null;
        for (const item of first.records) {
          inspect(item.event);
          if (item.event.type === 'turn/start') historicalTurn = { state: 'running', clientRequestId: null };
          if (historicalTurn && item.event.type === 'user/message') historicalTurn.clientRequestId = correlated();
          if (historicalTurn && item.event.type === 'turn/end') {
            const reason = item.event.data.reason.kind;
            historicalTurn.state = reason === 'completed' ? 'completed' : reason === 'aborted' ? 'cancelled' : 'failed';
            currentTurn = null;
          }
          const record = recordFor(item.event, toolCalls);
          if (record) records.push(record);
          const evidence = observation(item.event);
          if (evidence) historyObservations.push(evidence);
        }
        sourceCursor = first.cursor;
        yield wrap({ kind: 'snapshot', records: records.slice(-200), sourceCursor: first.cursor < 0 ? null : String(first.cursor),
          hasMore: first.hasMore || records.length > 200, window: { maxMessages: 200 } });
        // Historical evidence keeps durable identity; downstream deduplicates it.
        for (const evidence of historyObservations) yield wrap({ kind: 'edit-observation', observation: evidence });
        if (historicalTurn) yield wrap({ kind: 'turn-state', ...historicalTurn });
        sourceRevision = first.assistantStream?.revision ?? 0;
        const attempt = first.assistantStream?.activeAttempt;
        if (attempt) {
          active = { id: attempt.attemptId, revision: sourceRevision, sourceIndex: 0, normalizedIndex: 0,
            turn: attempt.turn, step: attempt.step, settlement: null };
          yield wrap({ kind: 'assistant-start', attemptId: active.id, revision: active.revision });
          const chunks = expandCompactStream(attempt.stream);
          if (chunks.length !== attempt.nextIndex) fail('Assistant opening index mismatch');
          for (const chunk of chunks) {
            active.sourceIndex++;
            const payload = chunkPayload(chunk);
            if (payload) yield wrap(payload);
          }
        }
        while (!closed) {
          const next = await upstream.next();
          if (next.done) break;
          const value = next.value;
          if (value.type === 'event') {
            const event = value.event;
            if (event.seq !== sourceCursor + 1) fail('Durable source sequence gap');
            sourceCursor = event.seq;
            inspect(event);
            const record = recordFor(event, toolCalls);
            if (active && ['assistant/message', 'assistant/attempt'].includes(event.type)
                && event.data.turn === active.turn && event.data.step === active.step) {
              active.settlement = { seq: event.seq, type: event.type };
              // Retire transient text before publishing its durable replacement.
              yield wrap({ kind: 'assistant-end', attemptId: active.id, revision: active.revision,
                outcome: 'committed', committedSeq: String(event.seq) });
            }
            // Replacements are model-surface decisions, not human transcript deletion.
            yield wrap({ kind: 'durable', durableSeq: String(event.seq), changes: record ? [{ op: 'upsert', record }] : [] });
            const evidence = observation(event);
            if (evidence) yield wrap({ kind: 'edit-observation', observation: evidence });
            if (event.type === 'turn/start') yield wrap({ kind: 'turn-state', clientRequestId: null, state: 'running' });
            if (event.type === 'user/message' && currentTurn !== null) yield wrap({ kind: 'turn-state', clientRequestId: correlated(), state: 'running' });
            if (event.type === 'turn/end') {
              const reason = event.data.reason.kind;
              const state = reason === 'completed' ? 'completed' : reason === 'aborted' ? 'cancelled' : 'failed';
              yield wrap({ kind: 'turn-state', clientRequestId: correlated(), state });
              currentTurn = null;
              requestIds = new Set();
            }
          } else if (value.type === 'assistant-stream') {
            const frame = value.frame;
            if (frame.revision !== sourceRevision + 1) fail('Assistant source revision gap');
            sourceRevision = frame.revision;
            if (frame.type === 'start') {
              if (active) fail('Overlapping assistant attempts');
              active = { id: frame.attemptId, revision: frame.revision, sourceIndex: 0, normalizedIndex: 0,
                turn: frame.turn, step: frame.step, settlement: null };
              yield wrap({ kind: 'assistant-start', attemptId: active.id, revision: active.revision });
            } else {
              if (!active || active.id !== frame.attemptId || frame.index !== active.sourceIndex) fail('Assistant source chunk gap');
              if (frame.type === 'chunk') {
                active.sourceIndex++;
                const payload = chunkPayload(frame.chunk);
                if (payload) yield wrap(payload);
              } else if (frame.type === 'end') {
                if (active.settlement) {
                  if (frame.outcome.kind !== 'committed' || frame.outcome.seq !== active.settlement.seq || frame.outcome.eventType !== active.settlement.type) fail('Assistant settlement mismatch');
                } else {
                  if (frame.outcome.kind === 'committed') fail('Assistant settlement was not observed');
                  yield wrap({ kind: 'assistant-end', attemptId: active.id, revision: active.revision,
                    outcome: 'abandoned', committedSeq: null });
                }
                active = null;
              } else fail('Unsupported assistant frame');
            }
          } else fail('Unsupported session frame');
        }
      } finally { await close(); }
    }
    return Object.freeze({ close, events: { [Symbol.asyncIterator]() {
      if (used) throw createPortError('CONFLICT', 'Session feed already consumed');
      used = true;
      return events();
    } } });
  }
  return Object.freeze({
    capabilities() {
      const available = { state: 'available' };
      return { protocolVersion: 1, adapterId: 'dsh-0.2.0-rc.1', runtimeVersion, integrationVersion,
        runtimeInstanceId, reconnectMode: 'snapshot-reconcile', features: {
          workspaces: available, sessions: available, prompt: available, follow: available, cancelSession: available,
          toolObservation: available,
          lmRoute: { state: 'unverified', reason: 'Optional LM routing requires separate provider validation' },
          fim: { state: 'unverified', reason: 'Optional FIM requires separate provider validation' },
        } };
    },
    listWorkspaces: async (op) => (await workspaceBaseline(op)).items.map(workspaceSummary),
    ensureWorkspace, listSessions, openFeed,
    async createSession(workspaceId, op) {
      op.signal.throwIfAborted();
      const result = await sessions.create({ workspaceId });
      return { id: result.sessionId, workspaceId, title: null, updatedAt: null };
    },
    async renameSession(sessionId, title, op) { op.signal.throwIfAborted(); await sessions.rename({ sessionId, title }); return null; },
    async submitPrompt(input, op) {
      if (input.content.some((part) => part.kind !== 'text')) throw createPortError('CAPABILITY_UNAVAILABLE', 'Prompt attachments require a verified upload receipt or image-byte mapping');
      const result = await sessions.prompt({ sessionId: input.sessionId, requestId: input.clientRequestId, mode: input.mode,
        content: input.content.map((part) => ({ type: 'text', text: part.text })) }, op.signal);
      if (result.accepted !== true) throw createPortError('OUTCOME_UNKNOWN', 'Prompt admission was not confirmed', { effect: 'unknown' });
      return { admission: 'accepted', clientRequestId: input.clientRequestId };
    },
    async cancelSession(sessionId, op) { op.signal.throwIfAborted(); sessions.cancel({ sessionId }); return { admission: 'accepted' }; },
  });
}
