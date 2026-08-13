import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;
const LEGACY_FILES = [
  'state.json', 'messages.jsonl', 'chats.json', 'notes.json', 'todos.json',
  'calendar.json', 'diary.json', 'whisper.json', 'wall.json', 'nook.json',
  'subscriptions.json', 'api-auth.json', 'gong.json', 'message-feedback.json',
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function json(value) {
  return JSON.stringify(value == null ? null : value);
}

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return clone(fallback); }
}

async function exists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return clone(fallback); }
}

async function readJsonl(file) {
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* Preserve all valid rows before an interrupted tail. */ }
  }
  return rows;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function schema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL DEFAULT 0,
      last INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '',
      current INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      source TEXT,
      cwd TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chats_last ON chats(last DESC);
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      at INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      extra TEXT,
      source_uuid TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_uuid ON messages(source_uuid) WHERE source_uuid IS NOT NULL AND source_uuid <> '';
    CREATE TABLE IF NOT EXISTS message_feedback (
      message_seq INTEGER PRIMARY KEY,
      value TEXT NOT NULL,
      FOREIGN KEY(message_seq) REFERENCES messages(seq) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      bucket TEXT NOT NULL,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_bucket_position ON notes(bucket, position);
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      bucket TEXT NOT NULL,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todos_bucket_position ON todos(bucket, position);
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_days (
      day TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS diary_entries (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whisper_entries (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wall_entries (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nook_books (
      slug TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nook_progress (
      slug TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nook_annotations (
      annotation_key TEXT NOT NULL,
      id TEXT NOT NULL,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(annotation_key, id)
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      endpoint TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gong_messages (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_events (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT '',
      event_key TEXT,
      at INTEGER NOT NULL DEFAULT 0,
      route TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_events_at ON notification_events(at DESC);
    CREATE TABLE IF NOT EXISTS paired_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mutation_receipts (
      mutation_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_run_snapshots (
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(task_id, run_id)
    );
  `);
}

function stableLegacyId(prefix, bucket, position, item) {
  if (item?.id) return String(item.id);
  const digest = crypto.createHash('sha256').update(json(item)).digest('hex').slice(0, 14);
  return `${prefix}_legacy_${bucket}_${position}_${digest}`;
}

function insertSnapshot(db, snapshot) {
  const replaceMessages = Object.prototype.hasOwnProperty.call(snapshot, 'messages');
  const state = snapshot.state || {};
  const chats = Array.isArray(snapshot.chats) ? snapshot.chats : [];
  const messages = replaceMessages && Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const notes = snapshot.notes || { gu: [], her: [] };
  const todos = snapshot.todos || { mine: [], hers: [] };
  const calendar = snapshot.calendar || { events: [], period: { days: {} } };
  const diary = Array.isArray(snapshot.diary) ? snapshot.diary : [];
  const whisper = Array.isArray(snapshot.whisper) ? snapshot.whisper : [];
  const wall = Array.isArray(snapshot.wall) ? snapshot.wall : [];
  const nook = snapshot.nook || { books: [], progress: {}, annotations: {} };
  const subscriptions = Array.isArray(snapshot.subscriptions) ? snapshot.subscriptions : [];
  const apiAuth = snapshot.apiAuth || { mode: 'subscription', base: '', models: {} };
  const gong = Array.isArray(snapshot.gong) ? snapshot.gong : [];
  const feedback = snapshot.feedback || {};

  const clearTables = [
    'app_state', 'chats', 'message_feedback', 'notes', 'todos',
    'calendar_events', 'calendar_days', 'diary_entries', 'whisper_entries',
    'wall_entries', 'nook_books', 'nook_progress', 'nook_annotations',
    'subscriptions', 'api_auth', 'gong_messages', 'notification_events',
  ];
  if (replaceMessages) clearTables.push('messages');
  for (const table of clearTables) db.prepare(`DELETE FROM ${table}`).run();

  db.prepare('INSERT INTO app_state(id, payload) VALUES(1, ?)').run(json(state));
  const insertChat = db.prepare(`
    INSERT INTO chats(id, name, created, last, preview, current, archived, session_id, source, cwd, payload)
    VALUES(@id, @name, @created, @last, @preview, @current, @archived, @session_id, @source, @cwd, @payload)
  `);
  for (const chat of chats) insertChat.run({
    id: String(chat.id), name: String(chat.name || ''), created: Number(chat.created) || 0,
    last: Number(chat.last) || 0, preview: String(chat.preview || ''), current: chat.current ? 1 : 0,
    archived: chat.archived ? 1 : 0, session_id: chat.sessionId || null, source: chat.source || null,
    cwd: chat.cwd || null, payload: json(chat),
  });

  if (replaceMessages) {
    const insertMessage = db.prepare(`
      INSERT INTO messages(seq, chat_id, at, kind, text, extra, source_uuid, payload)
      VALUES(@seq, @chat_id, @at, @kind, @text, @extra, @source_uuid, @payload)
    `);
    for (const message of messages) insertMessage.run({
      seq: Number(message.seq), chat_id: String(message.chatId || ''), at: Number(message.at) || 0,
      kind: String(message.kind || 'system'), text: String(message.text || ''), extra: message.extra == null ? null : String(message.extra),
      source_uuid: message.sourceUuid || null, payload: json(message),
    });
  }
  const insertFeedback = db.prepare('INSERT INTO message_feedback(message_seq, value) VALUES(?, ?)');
  const messageIds = new Set(replaceMessages
    ? messages.map(item => Number(item.seq))
    : db.prepare('SELECT seq FROM messages').all().map(item => Number(item.seq)));
  for (const [seq, value] of Object.entries(feedback)) if (messageIds.has(Number(seq))) insertFeedback.run(Number(seq), String(value));

  const insertPositioned = (table, prefix, buckets) => {
    const statement = db.prepare(`INSERT INTO ${table}(id, bucket, position, payload) VALUES(?, ?, ?, ?)`);
    for (const [bucket, values] of Object.entries(buckets)) {
      for (const [position, item] of (Array.isArray(values) ? values : []).entries()) {
        const value = { ...item, id: stableLegacyId(prefix, bucket, position, item) };
        statement.run(value.id, bucket, position, json(value));
      }
    }
  };
  insertPositioned('notes', 'note', { gu: notes.gu || [], her: notes.her || [] });
  insertPositioned('todos', 'todo', { mine: todos.mine || [], hers: todos.hers || todos.yours || [] });

  const insertOrdered = (table, prefix, values) => {
    const statement = db.prepare(`INSERT INTO ${table}(id, position, payload) VALUES(?, ?, ?)`);
    for (const [position, item] of (Array.isArray(values) ? values : []).entries()) {
      const value = { ...item, id: stableLegacyId(prefix, 'all', position, item) };
      statement.run(value.id, position, json(value));
    }
  };
  insertOrdered('calendar_events', 'event', calendar.events || []);
  const insertDay = db.prepare('INSERT INTO calendar_days(day, payload) VALUES(?, ?)');
  for (const [day, value] of Object.entries(calendar.period?.days || {})) insertDay.run(day, json(value));
  insertOrdered('diary_entries', 'diary', diary);
  insertOrdered('whisper_entries', 'whisper', whisper);
  insertOrdered('wall_entries', 'wall', wall);

  const insertBook = db.prepare('INSERT INTO nook_books(slug, position, payload) VALUES(?, ?, ?)');
  for (const [position, item] of (nook.books || []).entries()) {
    const slug = String(item.slug || item.id || stableLegacyId('book', 'all', position, item));
    insertBook.run(slug, position, json({ ...item, slug }));
  }
  const insertProgress = db.prepare('INSERT INTO nook_progress(slug, payload) VALUES(?, ?)');
  for (const [slug, value] of Object.entries(nook.progress || {})) insertProgress.run(slug, json(value));
  const insertAnnotation = db.prepare('INSERT INTO nook_annotations(annotation_key, id, position, payload) VALUES(?, ?, ?, ?)');
  for (const [key, values] of Object.entries(nook.annotations || {})) {
    for (const [position, item] of (Array.isArray(values) ? values : []).entries()) {
      const id = stableLegacyId('annotation', key, position, item);
      insertAnnotation.run(key, id, position, json({ ...item, id }));
    }
  }

  const insertSubscription = db.prepare('INSERT INTO subscriptions(endpoint, payload) VALUES(?, ?)');
  for (const item of subscriptions) if (item?.endpoint) insertSubscription.run(String(item.endpoint), json(item));
  db.prepare('INSERT INTO api_auth(id, payload) VALUES(1, ?)').run(json(apiAuth));
  insertOrdered('gong_messages', 'gong', gong);

  const insertNotification = db.prepare('INSERT INTO notification_events(id, kind, event_key, at, route, payload) VALUES(?, ?, ?, ?, ?, ?)');
  for (const item of state.notifications?.items || []) insertNotification.run(
    Number(item.id), String(item.kind || ''), item.key || null, Number(item.at) || 0, String(item.route || ''), json(item),
  );
}

function rowsAsObjects(db, table, order = 'position ASC') {
  return db.prepare(`SELECT payload FROM ${table} ORDER BY ${order}`).all().map(row => parse(row.payload, {}));
}

function loadSnapshot(db, defaults = {}) {
  const stateRow = db.prepare('SELECT payload FROM app_state WHERE id = 1').get();
  const authRow = db.prepare('SELECT payload FROM api_auth WHERE id = 1').get();
  const state = parse(stateRow?.payload, defaults.state || {});
  const chats = rowsAsObjects(db, 'chats', 'last DESC, id ASC');
  const messages = rowsAsObjects(db, 'messages', 'seq ASC');
  const bucketed = table => {
    const out = {};
    for (const row of db.prepare(`SELECT bucket, payload FROM ${table} ORDER BY bucket, position`).all()) (out[row.bucket] ||= []).push(parse(row.payload, {}));
    return out;
  };
  const notes = { gu: [], her: [], ...bucketed('notes') };
  const todoRows = bucketed('todos');
  const todos = { mine: todoRows.mine || [], hers: todoRows.hers || todoRows.yours || [] };
  const calendar = { events: rowsAsObjects(db, 'calendar_events'), period: { days: {} } };
  for (const row of db.prepare('SELECT day, payload FROM calendar_days ORDER BY day').all()) calendar.period.days[row.day] = parse(row.payload, {});
  const diary = rowsAsObjects(db, 'diary_entries');
  const whisper = rowsAsObjects(db, 'whisper_entries');
  const wall = rowsAsObjects(db, 'wall_entries');
  const nook = { books: rowsAsObjects(db, 'nook_books'), progress: {}, annotations: {} };
  for (const row of db.prepare('SELECT slug, payload FROM nook_progress ORDER BY slug').all()) nook.progress[row.slug] = parse(row.payload, {});
  for (const row of db.prepare('SELECT annotation_key, payload FROM nook_annotations ORDER BY annotation_key, position').all()) {
    (nook.annotations[row.annotation_key] ||= []).push(parse(row.payload, {}));
  }
  const subscriptions = rowsAsObjects(db, 'subscriptions', 'endpoint ASC');
  const apiAuth = parse(authRow?.payload, defaults.apiAuth || { mode: 'subscription', base: '', models: {} });
  const gong = rowsAsObjects(db, 'gong_messages');
  const feedback = Object.fromEntries(db.prepare('SELECT message_seq, value FROM message_feedback').all().map(row => [String(row.message_seq), row.value]));
  return { state, chats, messages, notes, todos, calendar, diary, whisper, wall, nook, subscriptions, apiAuth, gong, feedback };
}

function snapshotCounts(snapshot) {
  const annotations = Object.values(snapshot.nook?.annotations || {}).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
  const messageIds = new Set((snapshot.messages || []).map(item => Number(item.seq)));
  return {
    chats: snapshot.chats?.length || 0,
    messages: snapshot.messages?.length || 0,
    notes: (snapshot.notes?.gu?.length || 0) + (snapshot.notes?.her?.length || 0),
    todos: (snapshot.todos?.mine?.length || 0) + (snapshot.todos?.hers?.length || snapshot.todos?.yours?.length || 0),
    calendarEvents: snapshot.calendar?.events?.length || 0,
    calendarDays: Object.keys(snapshot.calendar?.period?.days || {}).length,
    diary: snapshot.diary?.length || 0,
    whisper: snapshot.whisper?.length || 0,
    wall: snapshot.wall?.length || 0,
    nookBooks: snapshot.nook?.books?.length || 0,
    nookProgress: Object.keys(snapshot.nook?.progress || {}).length,
    nookAnnotations: annotations,
    subscriptions: snapshot.subscriptions?.length || 0,
    gong: snapshot.gong?.length || 0,
    // Old builds could leave a feedback entry behind after a message branch was
    // regenerated. The SQLite foreign key intentionally rejects those stale
    // rows, so migration validation counts only feedback that still has a
    // corresponding message.
    feedback: Object.keys(snapshot.feedback || {}).filter(seq => messageIds.has(Number(seq))).length,
    maxMessageSeq: (snapshot.messages || []).reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0),
  };
}

function sameCounts(a, b) {
  return Object.keys(a).every(key => Number(a[key]) === Number(b[key]));
}

async function legacySnapshot(dataDir, defaults) {
  return {
    state: { ...(defaults.state || {}), ...(await readJson(path.join(dataDir, 'state.json'), {})) },
    chats: await readJson(path.join(dataDir, 'chats.json'), []),
    messages: await readJsonl(path.join(dataDir, 'messages.jsonl')),
    notes: await readJson(path.join(dataDir, 'notes.json'), { gu: [], her: [] }),
    todos: await readJson(path.join(dataDir, 'todos.json'), { mine: [], hers: [] }),
    calendar: await readJson(path.join(dataDir, 'calendar.json'), { events: [], period: { days: {} } }),
    diary: await readJson(path.join(dataDir, 'diary.json'), []),
    whisper: await readJson(path.join(dataDir, 'whisper.json'), []),
    wall: await readJson(path.join(dataDir, 'wall.json'), []),
    nook: await readJson(path.join(dataDir, 'nook.json'), { books: [], progress: {}, annotations: {} }),
    subscriptions: await readJson(path.join(dataDir, 'subscriptions.json'), []),
    apiAuth: await readJson(path.join(dataDir, 'api-auth.json'), defaults.apiAuth || { mode: 'subscription', base: '', models: {} }),
    gong: await readJson(path.join(dataDir, 'gong.json'), []),
    feedback: await readJson(path.join(dataDir, 'message-feedback.json'), {}),
  };
}

async function backupLegacy(dataDir) {
  const backupDir = path.join(dataDir, 'backups', `pre-v060-${timestampSlug()}`);
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const name of LEGACY_FILES) {
    const source = path.join(dataDir, name);
    if (!(await exists(source))) continue;
    await fsp.copyFile(source, path.join(backupDir, name));
    copied.push(name);
  }
  return { backupDir, copied };
}

async function migrate(dataDir, dbPath, defaults) {
  const source = await legacySnapshot(dataDir, defaults);
  const expected = snapshotCounts(source);
  const { backupDir, copied } = await backupLegacy(dataDir);
  const tempPath = `${dbPath}.migrating-${process.pid}-${Date.now()}`;
  let db;
  try {
    db = new Database(tempPath);
    schema(db);
    db.transaction(() => {
      insertSnapshot(db, source);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(SCHEMA_VERSION));
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('legacy_migrated_at', new Date().toISOString());
    })();
    const actual = snapshotCounts(loadSnapshot(db, defaults));
    if (!sameCounts(expected, actual)) throw new Error(`migration count mismatch: expected=${json(expected)} actual=${json(actual)}`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
    await fsp.rename(tempPath, dbPath);
    const report = {
      ok: true, schemaVersion: SCHEMA_VERSION, migratedAt: new Date().toISOString(),
      database: dbPath, backup: backupDir, copied, expected, actual,
    };
    await fsp.writeFile(path.join(backupDir, 'migration-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } catch (error) {
    try { db?.close(); } catch {}
    await fsp.rm(tempPath, { force: true });
    const report = { ok: false, schemaVersion: SCHEMA_VERSION, failedAt: new Date().toISOString(), database: dbPath, backup: backupDir, copied, expected, error: error.message };
    await fsp.writeFile(path.join(backupDir, 'migration-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    throw error;
  }
}

export async function openDwellDatabase({ dataDir, defaults = {} }) {
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, 'dwell.sqlite');
  let migration = null;
  if (!(await exists(dbPath))) migration = await migrate(dataDir, dbPath, defaults);
  const db = new Database(dbPath);
  schema(db);
  const version = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value || 0);
  if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`unsupported dwell database schema ${version}; expected ${SCHEMA_VERSION}`);
  }

  const saveTransaction = db.transaction(snapshot => insertSnapshot(db, snapshot));
  const replaceMessagesTransaction = db.transaction(messages => {
    const oldFeedback = db.prepare('SELECT message_seq, value FROM message_feedback').all();
    db.prepare('DELETE FROM messages').run();
    const insert = db.prepare('INSERT INTO messages(seq, chat_id, at, kind, text, extra, source_uuid, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
    for (const message of messages) insert.run(
      Number(message.seq), String(message.chatId || ''), Number(message.at) || 0, String(message.kind || 'system'),
      String(message.text || ''), message.extra == null ? null : String(message.extra), message.sourceUuid || null, json(message),
    );
    const valid = new Set(messages.map(item => Number(item.seq)));
    const restore = db.prepare('INSERT OR REPLACE INTO message_feedback(message_seq, value) VALUES(?, ?)');
    for (const row of oldFeedback) if (valid.has(Number(row.message_seq))) restore.run(Number(row.message_seq), row.value);
  });

  return {
    path: dbPath,
    migration,
    loadSnapshot: () => loadSnapshot(db, defaults),
    counts: () => snapshotCounts(loadSnapshot(db, defaults)),
    saveSnapshot(snapshot) { saveTransaction.immediate(snapshot); },
    saveState(state) { db.prepare('INSERT OR REPLACE INTO app_state(id, payload) VALUES(1, ?)').run(json(state)); },
    appendMessage(message) {
      db.prepare(`
        INSERT INTO messages(seq, chat_id, at, kind, text, extra, source_uuid, payload)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(Number(message.seq), String(message.chatId || ''), Number(message.at) || 0, String(message.kind || 'system'), String(message.text || ''), message.extra == null ? null : String(message.extra), message.sourceUuid || null, json(message));
    },
    replaceMessages(messages) { replaceMessagesTransaction.immediate(messages); },
    createPairingCode({ codeHash, expiresAt }) {
      db.prepare('DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(Math.floor(Date.now() / 1000));
      db.prepare('INSERT OR REPLACE INTO pairing_codes(code_hash, expires_at, used_at) VALUES(?, ?, NULL)').run(codeHash, expiresAt);
    },
    consumePairingCode({ codeHash, usedAt }) {
      const result = db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?').run(usedAt, codeHash, usedAt);
      return result.changes === 1;
    },
    addDevice(device) {
      db.prepare(`INSERT INTO paired_devices(id, name, token_hash, public_key, created_at, last_seen_at, revoked_at)
        VALUES(@id, @name, @tokenHash, @publicKey, @createdAt, @lastSeenAt, NULL)`).run(device);
    },
    activeDeviceByTokenHash(tokenHash) {
      return db.prepare('SELECT id, name, public_key AS publicKey, created_at AS createdAt, last_seen_at AS lastSeenAt FROM paired_devices WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash) || null;
    },
    touchDevice(id, at) { db.prepare('UPDATE paired_devices SET last_seen_at = ? WHERE id = ?').run(at, id); },
    listDevices() { return db.prepare('SELECT id, name, public_key AS publicKey, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM paired_devices ORDER BY created_at DESC').all(); },
    revokeDevice(id, at) { return db.prepare('UPDATE paired_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id).changes === 1; },
    mutationReceipt(mutationId, deviceId) {
      const row = db.prepare('SELECT result FROM mutation_receipts WHERE mutation_id = ? AND device_id = ?').get(mutationId, deviceId);
      return row ? parse(row.result, null) : null;
    },
    saveMutationReceipt({ mutationId, deviceId, createdAt, result }) {
      db.prepare(`INSERT OR REPLACE INTO mutation_receipts(mutation_id, device_id, created_at, result)
        VALUES(?, ?, ?, ?)`).run(mutationId, deviceId, createdAt, json(result));
      db.prepare('DELETE FROM mutation_receipts WHERE created_at < ?').run(createdAt - 7 * 24 * 60 * 60);
    },
    close() { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); },
  };
}

export async function inspectLegacyMigration(dataDir, defaults = {}) {
  return snapshotCounts(await legacySnapshot(dataDir, defaults));
}
