"use strict";

const { createPortError, LIMITS } = require('../protocol/runtime');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function createTranscriptState() {
  return freeze({ records: [], hasMore: false, sourceCursor: null, activeAttempts: [], turn: null });
}

function invalid(message) { throw createPortError('RESYNC_REQUIRED', message, { retryable: true }); }

/** Pure projection of the current bounded window. Older consumer history is never mutated. */
function reduceSessionUpdate(state, update) {
  const next = {
    ...state,
    records: [...state.records],
    activeAttempts: state.activeAttempts.map((attempt) => ({ ...attempt })),
  };
  if (update.kind === 'snapshot') {
    if (new Set(update.records.map((record) => record.id)).size !== update.records.length) invalid('Duplicate snapshot records');
    return freeze({ records: structuredClone(update.records), hasMore: update.hasMore,
      sourceCursor: update.sourceCursor, activeAttempts: [], turn: null });
  }
  if (update.kind === 'durable') {
    if (!/^\d+$/.test(update.durableSeq)) invalid('Invalid durable sequence');
    if (state.sourceCursor !== null && /^\d+$/.test(state.sourceCursor)
        && BigInt(update.durableSeq) <= BigInt(state.sourceCursor)) return state;
    for (const change of update.changes) {
      const id = change.op === 'upsert' ? change.record.id : change.id;
      const index = next.records.findIndex((record) => record.id === id);
      if (change.op === 'remove') {
        if (index === -1) invalid('Removal outside the active window');
        next.records.splice(index, 1);
      } else if (change.op === 'upsert') {
        const record = structuredClone(change.record);
        if (index === -1) next.records.push(record);
        else next.records[index] = record;
      } else invalid('Unknown record operation');
    }
    if (next.records.length > LIMITS.maxMessages) {
      next.records.splice(0, next.records.length - LIMITS.maxMessages);
      next.hasMore = true;
    }
    next.sourceCursor = update.durableSeq;
  } else if (update.kind === 'assistant-start') {
    const prior = next.activeAttempts.find((attempt) => attempt.attemptId === update.attemptId);
    if (prior && prior.revision >= update.revision) invalid('Repeated or stale assistant revision');
    next.activeAttempts = next.activeAttempts.filter((attempt) => attempt.attemptId !== update.attemptId);
    next.activeAttempts.push({ attemptId: update.attemptId, revision: update.revision, nextIndex: 0, answer: '', reasoning: '' });
  } else if (update.kind === 'assistant-chunk') {
    const attempt = next.activeAttempts.find((candidate) => candidate.attemptId === update.attemptId && candidate.revision === update.revision);
    if (!attempt || attempt.nextIndex !== update.index) invalid('Assistant chunk gap');
    attempt[update.channel] += update.text;
    attempt.nextIndex++;
  } else if (update.kind === 'assistant-end') {
    const index = next.activeAttempts.findIndex((attempt) => attempt.attemptId === update.attemptId && attempt.revision === update.revision);
    if (index === -1) invalid('Assistant end without a matching attempt');
    next.activeAttempts.splice(index, 1);
    // An attempt ending does not mean a turn completed.
  } else if (update.kind === 'turn-state') {
    next.turn = { clientRequestId: update.clientRequestId, state: update.state };
  } else if (update.kind === 'resync-required') invalid('Runtime requested a fresh snapshot');
  else if (update.kind !== 'edit-observation') invalid('Unknown session update');
  return freeze(next);
}

module.exports = { createTranscriptState, reduceSessionUpdate };
