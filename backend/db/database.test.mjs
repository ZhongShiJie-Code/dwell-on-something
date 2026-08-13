import assert from 'node:assert/strict';
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
