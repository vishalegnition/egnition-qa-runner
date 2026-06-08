/** In-memory pending test runs and captured Shopify sessions (MVP). */

import crypto from 'crypto';

const pending = new Map();
const sessions = new Map();

const TTL_MS = 30 * 60 * 1000;

export function createPendingRun({ app, cycleId, slackChannel, slackUser }) {
  const runId = crypto.randomUUID();
  pending.set(runId, {
    runId,
    app,
    cycleId,
    slackChannel,
    slackUser,
    status: 'awaiting_auth',
    createdAt: Date.now(),
  });
  return runId;
}

export function getPendingRun(runId) {
  return pending.get(runId);
}

export function updatePendingRun(runId, patch) {
  const run = pending.get(runId);
  if (!run) return null;
  Object.assign(run, patch);
  pending.set(runId, run);
  return run;
}

export function storeSession(runId, storageStateBase64) {
  sessions.set(runId, {
    storageStateBase64,
    createdAt: Date.now(),
    used: false,
  });
}

export function consumeSession(runId) {
  const s = sessions.get(runId);
  if (!s || s.used) return null;
  s.used = true;
  sessions.set(runId, s);
  return s.storageStateBase64;
}

export function cleanupExpired() {
  const now = Date.now();
  for (const [id, run] of pending) {
    if (now - run.createdAt > TTL_MS) pending.delete(id);
  }
  for (const [id, s] of sessions) {
    if (now - s.createdAt > TTL_MS) sessions.delete(id);
  }
}

setInterval(cleanupExpired, 5 * 60 * 1000);
