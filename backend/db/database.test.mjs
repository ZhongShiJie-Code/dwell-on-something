import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDwellDatabase, SCHEMA_VERSION } from './database.mjs';

async function writeJson(dir, name, value) {
  await fsp.writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dwell-db-test-'));
  await writeJson(dir, 'state.json', {
    model: 'default', activeChatId: 'chat-1', notifications: {
      initialized: true, next: 9, chatMax: 2, taskSeen: {},
      items: [{ id: 9, kind: 'chat', key: 'chat:2', at: 20, route: 'chat/chat-1', body: '回答' }],
    },
  });
  await writeJson(dir, 'chats.json', [{ id: 'chat-1', name: '测试', created: 10, last: 20, current: true, archived: false }]);
  const messages = options.duplicate
    ? [{ seq: 1, chatId: 'chat-1', at: 10, kind: 'me', text: '问题' }, { seq: 1, chatId: 'chat-1', at: 20, kind: 'gu', text: '重复' }]
    : [{ seq: 1, chatId: 'chat-1', at: 10, kind: 'me', text: '问题' }, { seq: 2, chatId: 'chat-1', at: 20, kind: 'gu', text: '回答' }];
  await fsp.writeFile(path.join(dir, 'messages.jsonl'), `${messages.map(JSON.stringify).join('\n')}\n`);
  await writeJson(dir, 'notes.json', { gu: [{ id: 'note-1', text: '纸条' }], her: [] });
  await writeJson(dir, 'todos.json', { mine: [{ id: 'todo-1', text: '事项' }], hers: [] });
  await writeJson(dir, 'calendar.json', { events: [{ id: 'event-1', date: '2026-08-13', text: '日程' }], period: { days: { '2026-08-13': { mood: '平静' } } } });
  await writeJson(dir, 'diary.json', [{ id: 'diary-1', text: '日记' }]);
  await writeJson(dir, 'whisper.json', [{ id: 'whisper-1', text: '悄悄话' }]);
  await writeJson(dir, 'wall.json', [{ id: 'wall-1', title: '墙' }]);
  await writeJson(dir, 'nook.json', {
    books: [{ slug: 'book-1', title: '书' }], progress: { 'book-1': { ch: 2 } },
    annotations: { 'book-1:2': [{ id: 'annotation-1', note: '批注' }] },
  });
  await writeJson(dir, 'subscriptions.json', [{ endpoint: 'https://push.example/1', keys: {} }]);
  await writeJson(dir, 'api-auth.json', { mode: 'subscription', base: '', models: {} });
  await writeJson(dir, 'gong.json', [{ id: 'gong-1', text: '另一位' }]);
  await writeJson(dir, 'message-feedback.json', options.duplicate ? {} : { 2: 'up', ...(options.staleFeedback ? { 999: 'down' } : {}) });
  return dir;
}

async function existingV1Fixture({ schemaVersion = 1, malformedObservations = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dwell-v1-test-'));
  const dbPath = path.join(dir, 'dwell.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
    CREATE TABLE chats (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL DEFAULT 0,
      last INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL DEFAULT '', current INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, session_id TEXT, source TEXT, cwd TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', extra TEXT, source_uuid TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE message_feedback (message_seq INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT '', event_key TEXT,
      at INTEGER NOT NULL DEFAULT 0, route TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL
    );
    CREATE INDEX idx_notification_events_at ON notification_events(at DESC);
    CREATE TABLE paired_devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER
    );
  `);
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(schemaVersion));
  db.prepare('INSERT INTO app_state(id, payload) VALUES(1, ?)').run(JSON.stringify({
    model: 'default', notifications: {
      initialized: true, next: 10, chatMax: 8,
      taskSeen: { 'task-old:run-old': '2026-08-23T00:00:00.000Z' },
      items: [{ id: 9, kind: 'chat', key: 'chat:9', at: 20, route: 'chat/chat-1', body: '回答' }],
    },
  }));
  db.prepare('INSERT INTO chats(id, name, created, last, preview, current, archived, session_id, source, cwd, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('chat-1', '测试', 10, 20, '回答', 1, 0, 'session-v1', null, null, JSON.stringify({ id: 'chat-1', name: '测试', created: 10, last: 20, preview: '回答', current: true, archived: false, sessionId: 'session-v1' }));
  db.prepare('INSERT INTO messages(seq, chat_id, at, kind, text, extra, source_uuid, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
    .run(1, 'chat-1', 10, 'me', '问题', null, null, JSON.stringify({ seq: 1, chatId: 'chat-1', at: 10, kind: 'me', text: '问题' }));
  db.prepare('INSERT INTO messages(seq, chat_id, at, kind, text, extra, source_uuid, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
    .run(2, 'chat-1', 20, 'gu', '回答', null, null, JSON.stringify({ seq: 2, chatId: 'chat-1', at: 20, kind: 'gu', text: '回答' }));
  db.prepare('INSERT INTO notification_events(id, kind, event_key, at, route, payload) VALUES(?, ?, ?, ?, ?, ?)')
    .run(3, 'chat', 'duplicate-key', 10, 'chat/chat-1', JSON.stringify({ id: 3, kind: 'chat', key: 'duplicate-key' }));
  db.prepare('INSERT INTO notification_events(id, kind, event_key, at, route, payload) VALUES(?, ?, ?, ?, ?, ?)')
    .run(4, 'chat', 'duplicate-key', 11, 'chat/chat-1', JSON.stringify({ id: 4, kind: 'chat', key: 'duplicate-key' }));
  db.prepare('INSERT INTO notification_events(id, kind, event_key, at, route, payload) VALUES(?, ?, ?, ?, ?, ?)')
    .run(8, 'task', null, 12, 'task/task-old/run-old', JSON.stringify({ id: 8, kind: 'task' }));
  if (malformedObservations) db.exec('CREATE TABLE task_run_observations (task_id TEXT, run_id TEXT, observed_at INTEGER, PRIMARY KEY(task_id, run_id))');
  db.close();
  return { dir, dbPath };
}

test('migrates legacy data into SQLite, backs it up, and persists snapshots', async t => {
  const dir = await fixture();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const defaults = { state: { effort: 'high' }, apiAuth: { mode: 'subscription', base: '', models: {} } };
  const database = await openDwellDatabase({ dataDir: dir, defaults });
  assert.equal(database.migration?.schemaVersion, SCHEMA_VERSION);
  assert.equal(database.migration?.ok, true);
  assert.equal(database.migration?.expected.messages, 2);
  assert.deepEqual(database.migration?.actual, database.migration?.expected);
  assert.equal((await fsp.stat(path.join(database.migration.backup, 'messages.jsonl'))).isFile(), true);

  const snapshot = database.loadSnapshot();
  assert.equal(snapshot.state.effort, 'high');
  assert.equal(snapshot.chats[0].id, 'chat-1');
  assert.deepEqual(snapshot.messages.map(item => item.text), ['问题', '回答']);
  assert.equal(snapshot.feedback['2'], 'up');
  assert.equal(snapshot.todos.mine[0].text, '事项');
  assert.equal(snapshot.calendar.period.days['2026-08-13'].mood, '平静');
  assert.equal(snapshot.nook.annotations['book-1:2'][0].note, '批注');

  snapshot.todos.mine.push({ id: 'todo-2', text: '新增' });
  database.saveSnapshot(snapshot);
  database.appendMessage({ seq: 3, chatId: 'chat-1', at: 30, kind: 'me', text: '继续' });
  assert.equal(database.loadSnapshot().todos.mine.length, 2);
  assert.equal(database.loadSnapshot().messages.at(-1).text, '继续');

  const codeHash = 'hash-1';
  database.createPairingCode({ codeHash, expiresAt: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(database.consumePairingCode({ codeHash, usedAt: Math.floor(Date.now() / 1000) }), true);
  assert.equal(database.consumePairingCode({ codeHash, usedAt: Math.floor(Date.now() / 1000) }), false);
  database.addDevice({ id: 'device-1', name: 'S25+', tokenHash: 'token-hash', publicKey: '', createdAt: 1, lastSeenAt: 1 });
  assert.equal(database.activeDeviceByTokenHash('token-hash').name, 'S25+');
  database.saveMutationReceipt({ mutationId: 'mutation-1', deviceId: 'device-1', createdAt: 2, result: { ok: true, id: 7 } });
  assert.deepEqual(database.mutationReceipt('mutation-1', 'device-1'), { ok: true, id: 7 });
  assert.equal(database.mutationReceipt('mutation-1', 'another-device'), null);
  assert.equal(database.revokeDevice('device-1', 3), true);
  assert.equal(database.activeDeviceByTokenHash('token-hash'), null);
  database.close();

  const reopened = await openDwellDatabase({ dataDir: dir, defaults });
  assert.equal(reopened.migration, null);
  assert.equal(reopened.loadSnapshot().messages.length, 3);
  reopened.close();
});

test('ignores stale legacy feedback whose message was removed', async t => {
  const dir = await fixture({ staleFeedback: true });
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const database = await openDwellDatabase({ dataDir: dir, defaults: { state: {}, apiAuth: {} } });
  assert.deepEqual(database.loadSnapshot().feedback, { 2: 'up' });
  database.close();
});

test('failed migration leaves legacy files and does not install a partial database', async t => {
  const dir = await fixture({ duplicate: true });
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await assert.rejects(openDwellDatabase({ dataDir: dir, defaults: { state: {}, apiAuth: {} } }), /UNIQUE constraint failed/);
  await assert.rejects(fsp.stat(path.join(dir, 'dwell.sqlite')));
  assert.equal((await fsp.readFile(path.join(dir, 'messages.jsonl'), 'utf8')).split('\n').filter(Boolean).length, 2);
  const reports = [];
  for (const entry of await fsp.readdir(path.join(dir, 'backups'))) {
    const report = JSON.parse(await fsp.readFile(path.join(dir, 'backups', entry, 'migration-report.json'), 'utf8'));
    reports.push(report);
  }
  assert.equal(reports.some(report => report.ok === false), true);
});

test('migrates an existing v1 database with durable notification identity and WAL-safe backup', async t => {
  const { dir, dbPath } = await existingV1Fixture();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const database = await openDwellDatabase({ dataDir: dir, defaults: { state: { effort: 'high' }, apiAuth: {} } });
  let closed = false;
  const closeDatabase = () => {
    if (!closed) {
      database.close();
      closed = true;
    }
  };
  t.after(closeDatabase);

  assert.equal(database.migration?.ok, true);
  assert.equal(database.migration?.schemaVersion, SCHEMA_VERSION);
  assert.equal(database.notificationBaseline().latest, 9);
  assert.match(database.notificationEpoch(), /^[0-9a-f-]{36}$/);
  assert.deepEqual(database.listNotificationsAfter({ since: 0, limit: 10 }).items.map(item => item.notification_id), [3, 8, 9]);
  assert.deepEqual(database.listNotificationsAfter({ since: 0, limit: 10 }).items.map(item => item.key), ['duplicate-key', null, 'chat:9']);
  assert.equal(database.loadSnapshot().state.notifications, undefined);

  const backupStat = await fsp.stat(database.migration.backupPath);
  assert.equal(backupStat.mode & 0o077, 0);
  const backup = new Database(database.migration.backupPath, { readonly: true });
  try {
    assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM notification_events').get().count, 3);
  } finally {
    backup.close();
  }

  const migrated = new Database(dbPath, { readonly: true });
  try {
    assert.equal(migrated.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '2');
    assert.equal(migrated.prepare('SELECT value FROM meta WHERE key = ?').get('migrated_from').value, '1');
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM notification_events').get().count, 3);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM task_run_observations').get().count, 1);
    assert.equal(migrated.prepare('SELECT observed_at FROM task_run_observations WHERE task_id = ? AND run_id = ?').get('task-old', 'run-old').observed_at, Math.floor(Date.parse('2026-08-23T00:00:00.000Z') / 1000));
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'notification_events_v1'").get().count, 0);
    assert.equal(migrated.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload.includes('notifications'), false);
  } finally {
    migrated.close();
  }

  closeDatabase();
  const reopened = await openDwellDatabase({ dataDir: dir, defaults: { state: {}, apiAuth: {} } });
  assert.equal(reopened.migration, null);
  assert.equal(reopened.latestNotificationId(), 9);
  assert.deepEqual(reopened.listNotificationsAfter({ since: 0, limit: 10 }).items.map(item => item.notification_id), [3, 8, 9]);
  reopened.close();
});

test('rolls back a failed existing-v1 migration without replacing the original database', async t => {
  const { dir, dbPath } = await existingV1Fixture({ malformedObservations: true });
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    openDwellDatabase({ dataDir: dir, defaults: { state: {}, apiAuth: {} } }),
    /no column named payload/,
  );

  const original = new Database(dbPath, { readonly: true });
  try {
    assert.equal(original.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '1');
    assert.equal(original.prepare('SELECT COUNT(*) AS count FROM notification_events').get().count, 3);
    assert.equal(original.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'notification_events_v1'").get().count, 0);
    assert.equal(original.prepare('PRAGMA table_info(task_run_observations)').all().some(column => column.name === 'payload'), false);
  } finally {
    original.close();
  }

  const reports = [];
  for (const entry of await fsp.readdir(path.join(dir, 'backups'))) {
    const reportPath = path.join(dir, 'backups', entry, 'migration-report.json');
    try { reports.push(JSON.parse(await fsp.readFile(reportPath, 'utf8'))); } catch {}
  }
  assert.equal(reports.some(report => report.ok === false && report.schemaVersion === SCHEMA_VERSION), true);
});

test('rejects an existing database with a higher schema version without modifying it', async t => {
  const { dir, dbPath } = await existingV1Fixture({ schemaVersion: 99 });
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    openDwellDatabase({ dataDir: dir, defaults: { state: {}, apiAuth: {} } }),
    /unsupported dwell database schema 99/,
  );

  const database = new Database(dbPath, { readonly: true });
  try {
    assert.equal(database.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '99');
    assert.equal(database.prepare('SELECT 1 FROM meta WHERE key = ?').get('notification_epoch'), undefined);
  } finally {
    database.close();
  }
});

test('fences push delivery creation, claiming, and registration across device revocation', async t => {
  const dir = await fixture();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const database = await openDwellDatabase({ dataDir: dir, defaults: { state: {}, apiAuth: {} } });
  const packageName = 'com.xinwithyu.dwell';
  const firebaseAppId = '1:test:android:test';
  database.addDevice({ id: 'device-active', name: 'Active', tokenHash: 'device-token-active', publicKey: '', createdAt: 1, lastSeenAt: 1 });
  database.addDevice({ id: 'device-other', name: 'Other', tokenHash: 'device-token-other', publicKey: '', createdAt: 1, lastSeenAt: 1 });
  assert.deepEqual(database.registerPushToken({
    deviceId: 'device-active', token: 'fcm-active', tokenHash: 'hash-active',
    packageName, firebaseAppId, appVersion: '1', at: 10,
  }), { ok: true, newBinding: true, generation: 1 });
  assert.deepEqual(database.registerPushToken({
    deviceId: 'device-other', token: 'fcm-other', tokenHash: 'hash-other',
    packageName: 'wrong.package', firebaseAppId: 'wrong-app', appVersion: '1', at: 10,
  }), { ok: true, newBinding: true, generation: 1 });
  const notification = database.createNotification({
    eventKey: 'chat:device-fence', kind: 'chat', title: 'Claude Cli', body: '回答已完成',
    at: 100, route: 'chat/main',
  }, {
    senderEnabled: true,
    senderPackageName: packageName,
    senderFirebaseAppId: firebaseAppId,
    createdAt: 100,
  });
  assert.equal(notification.deliveries.length, 1);
  assert.equal(notification.deliveries[0].deviceId, 'device-active');
  const claimed = database.claimPushDeliveries({
    workerId: 'test', at: 100, packageName, firebaseAppId,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].notification.id, notification.notification.notification_id);
  assert.equal(claimed[0].notification.notification_id, notification.notification.notification_id);
  assert.equal(database.revokeDevice('device-active', 101), true);
  assert.equal(database.pushStatus('device-active').registered, false);
  assert.deepEqual(database.claimPushDeliveries({ workerId: 'test-2', at: 101, packageName, firebaseAppId }), []);
  assert.deepEqual(database.registerPushToken({
    deviceId: 'device-active', token: 'fcm-new', tokenHash: 'hash-new',
    packageName, firebaseAppId, appVersion: '1', at: 102,
  }), { ok: false, error: 'device_not_active' });
  database.close();

  const raw = new Database(path.join(dir, 'dwell.sqlite'), { readonly: true });
  try {
    const delivery = raw.prepare('SELECT state, lease_token, lease_until, created_at, expires_at FROM push_deliveries WHERE device_id = ?').get('device-active');
    assert.deepEqual(delivery, {
      state: 'cancelled', lease_token: null, lease_until: null, created_at: 100, expires_at: 3700,
    });
  } finally {
    raw.close();
  }
});
