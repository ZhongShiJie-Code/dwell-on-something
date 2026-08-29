const LEASE_SECONDS = 120;
const CLAIM_LIMIT = 100;
const RETRY_OFFSETS = {
  chat: [0, 30, 120, 600, 1800],
  task: [0, 30, 120, 600, 1800, 7200],
};

function currentSecond(clock) {
  return Math.floor(Number(clock()) / 1000);
}

function retryDelay(kind, attempts, random) {
  const offsets = RETRY_OFFSETS[kind] || RETRY_OFFSETS.task;
  const index = Math.max(0, Number(attempts) || 0);
  if (index >= offsets.length) return null;
  let delay = offsets[index];
  if (index === 1) {
    const sampled = Number(random());
    const normalized = Number.isFinite(sampled) ? Math.max(0, Math.min(1, sampled)) : 0.5;
    delay *= 0.9 + normalized * 0.2;
  }
  return Math.max(0, Math.round(delay));
}

function retryAt(row, at, random) {
  const delay = retryDelay(row.kind, row.attempts, random);
  if (delay == null) return null;
  return Math.max(at, Number(row.createdAt) + delay);
}

function payloadFor(database, row) {
  const notification = row.notification || {};
  return {
    v: '1',
    notification_epoch: database.notificationEpoch(),
    device_id: String(row.deviceId),
    notification_id: String(row.notificationId),
    kind: String(row.kind || notification.kind || ''),
    title: String(notification.title || 'Claude Cli'),
    body: String(notification.body || ''),
    route: String(notification.route || row.route || ''),
    at: String(Number(notification.at || row.at) || 0),
  };
}

function isPayloadError(result) {
  return String(result?.code || '').startsWith('invalid_fcm_') || result?.code === 'payload_too_large';
}

export function createFcmDispatcher({
  database,
  sender,
  workerId = `fcm-${process.pid}`,
  intervalMs = 15_000,
  leaseSeconds = LEASE_SECONDS,
  claimLimit = CLAIM_LIMIT,
  clock = () => Date.now(),
  random = Math.random,
  onError = () => {},
} = {}) {
  if (!database || !sender) throw new TypeError('database and sender are required');
  let timer = null;
  let running = false;
  let inFlight = null;

  async function sendOne(row) {
    const at = currentSecond(clock);
    const remainingMs = (Number(row.expiresAt) - at) * 1000;
    if (remainingMs <= 0) {
      database.expirePushDelivery({
        notificationId: row.notificationId, deviceId: row.deviceId, leaseToken: row.leaseToken, at,
      });
      return { state: 'expired', notificationId: row.notificationId, deviceId: row.deviceId };
    }

    let result;
    try {
      result = await sender.send({ token: row.token, data: payloadFor(database, row), ttlMs: remainingMs });
    } catch (error) {
      result = { ok: false, class: 'sender_error', code: String(error?.code || error?.message || 'sender_error').slice(0, 100) };
    }

    if (result?.ok) {
      database.markPushTokenSuccess({
        deviceId: row.deviceId, tokenGeneration: row.tokenGeneration, tokenHash: row.tokenHash, at,
      });
      const completed = database.completePushDelivery({
        notificationId: row.notificationId, deviceId: row.deviceId, leaseToken: row.leaseToken, at,
      });
      return { state: completed ? 'sent' : 'fenced', notificationId: row.notificationId, deviceId: row.deviceId };
    }

    const code = String(result?.code || 'send_failed').slice(0, 100);
    if (result?.class === 'sender_unavailable') {
      database.cancelPushDeliveries(at);
      return { state: 'unavailable', notificationId: row.notificationId, deviceId: row.deviceId };
    }
    database.recordPushTokenError({
      deviceId: row.deviceId, tokenGeneration: row.tokenGeneration, tokenHash: row.tokenHash, errorCode: code, at,
    });

    if (result?.class === 'invalid_token') {
      const removed = database.removeInvalidPushToken({
        deviceId: row.deviceId, tokenGeneration: row.tokenGeneration, tokenHash: row.tokenHash, at,
      });
      if (!removed) {
        const nextAttemptAt = retryAt(row, at, random);
        database.retryPushDelivery({
          notificationId: row.notificationId, deviceId: row.deviceId, leaseToken: row.leaseToken,
          errorCode: code, nextAttemptAt: nextAttemptAt ?? at, dead: nextAttemptAt == null, at,
        });
        return { state: nextAttemptAt == null ? 'dead' : 'retry', notificationId: row.notificationId, deviceId: row.deviceId };
      }
      return { state: 'token_removed', notificationId: row.notificationId, deviceId: row.deviceId };
    }

    if (result?.class === 'credential_mismatch') {
      database.quarantinePushToken({
        deviceId: row.deviceId, tokenGeneration: row.tokenGeneration, tokenHash: row.tokenHash, code, at,
      });
      database.retryPushDelivery({
        notificationId: row.notificationId, deviceId: row.deviceId, leaseToken: row.leaseToken,
        errorCode: code, nextAttemptAt: at, dead: true, at,
      });
      return { state: 'dead', notificationId: row.notificationId, deviceId: row.deviceId };
    }

    const nextAttemptAt = isPayloadError(result) ? null : retryAt(row, at, random);
    database.retryPushDelivery({
      notificationId: row.notificationId, deviceId: row.deviceId, leaseToken: row.leaseToken,
      errorCode: code, nextAttemptAt: nextAttemptAt ?? at, dead: nextAttemptAt == null, at,
    });
    return { state: nextAttemptAt == null ? 'dead' : 'retry', notificationId: row.notificationId, deviceId: row.deviceId };
  }

  async function tick() {
    if (!running) return { claimed: 0, completed: 0 };
    let status;
    try {
      status = await sender.status();
    } catch (error) {
      onError(error);
      return { claimed: 0, completed: 0, statusError: true };
    }
    const active = !!status?.enabled && !!status?.configured && status?.project_match !== false;
    const at = currentSecond(clock);
    if (!active) {
      const cancelled = database.cancelPushDeliveries(at);
      return { claimed: 0, completed: 0, cancelled };
    }

    database.recoverExpiredPushLeases(at);
    const claimed = database.claimPushDeliveries({
      workerId,
      limit: claimLimit,
      at,
      leaseSeconds,
      packageName: status.package_name,
      firebaseAppId: status.android_app_id,
    });
    const results = [];
    for (const row of claimed) results.push(await sendOne(row));
    return {
      claimed: claimed.length,
      completed: results.filter(result => result.state === 'sent').length,
      results,
    };
  }

  async function runTick() {
    if (!running || inFlight) return;
    inFlight = tick().catch(error => {
      onError(error);
      return { claimed: 0, completed: 0, error: true };
    }).finally(() => { inFlight = null; });
    await inFlight;
  }

  return {
    async start() {
      if (running) return;
      running = true;
      await runTick();
      timer = setInterval(() => { runTick().catch(onError); }, intervalMs);
      timer.unref?.();
    },
    async tick() {
      if (!running) running = true;
      return tick();
    },
    async stop({ cancel = false } = {}) {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight;
      if (cancel) database.cancelPushDeliveries(currentSecond(clock));
    },
  };
}

export { RETRY_OFFSETS, retryAt, retryDelay, payloadFor };
