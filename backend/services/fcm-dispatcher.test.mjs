import assert from 'node:assert/strict';
import test from 'node:test';
import { createFcmDispatcher, retryAt, retryDelay } from './fcm-dispatcher.mjs';

function fakeRow(overrides = {}) {
  return {
    notificationId: 7,
    deviceId: 'device-1',
    token: 'opaque-test-token',
    tokenHash: 'hash-test-token',
    tokenGeneration: 1,
    kind: 'chat',
    attempts: 0,
    createdAt: 100,
    expiresAt: 1000,
    notification: { kind: 'chat', title: 'dwell', body: '完成', route: 'chat/main', at: 100 },
    ...overrides,
  };
}

function fakeDatabase({ rows = [fakeRow()], cancelPushDeliveries = () => 0 } = {}) {
  return {
    cancelled: [],
    recovered: [],
    completed: [],
    retried: [],
    errors: [],
    recoverExpiredPushLeases(at) { this.recovered.push(at); return 0; },
    claimPushDeliveries() { return rows; },
    cancelPushDeliveries(at) { this.cancelled.push(at); return cancelPushDeliveries(at); },
    expirePushDelivery() { return true; },
    markPushTokenSuccess() { return true; },
    completePushDelivery(input) { this.completed.push(input); return true; },
    recordPushTokenError(input) { this.errors.push(input); return true; },
    removeInvalidPushToken() { return false; },
    quarantinePushToken() { return true; },
    retryPushDelivery(input) { this.retried.push(input); return true; },
    notificationEpoch() { return 'epoch-test'; },
  };
}

test('random zero is the retry-delay lower bound', () => {
  assert.equal(retryDelay('chat', 1, () => 0), 27);
  assert.equal(retryDelay('chat', 1, () => 0.5), 30);
  assert.equal(retryDelay('chat', 1, () => 1), 33);
});

test('retryAt uses createdAt as an absolute schedule base', () => {
  assert.equal(retryAt({ kind: 'chat', attempts: 1, createdAt: 100 }, 500, () => 0.5), 500);
  assert.equal(retryAt({ kind: 'chat', attempts: 1, createdAt: 100 }, 120, () => 0.5), 130);
});

test('sender-wide unavailability cancels the outbox without a token retry', async () => {
  const database = fakeDatabase();
  const sender = {
    status: async () => ({ enabled: true, configured: true, project_match: true }),
    send: async () => ({ ok: false, class: 'sender_unavailable', code: 'firebase_admin_unavailable' }),
  };
  const dispatcher = createFcmDispatcher({ database, sender, clock: () => 100_000 });
  const result = await dispatcher.tick();
  assert.equal(result.results[0].state, 'unavailable');
  assert.equal(database.cancelled.length, 1);
  assert.equal(database.retried.length, 0);
  assert.equal(database.errors.length, 0);
});

test('expired delivery is fenced before sender invocation', async () => {
  const database = fakeDatabase({ rows: [fakeRow({ expiresAt: 99 })] });
  let sends = 0;
  const sender = {
    status: async () => ({ enabled: true, configured: true, project_match: true }),
    send: async () => { sends += 1; return { ok: true }; },
  };
  const dispatcher = createFcmDispatcher({ database, sender, clock: () => 100_000 });
  const result = await dispatcher.tick();
  assert.equal(result.results[0].state, 'expired');
  assert.equal(sends, 0);
});
