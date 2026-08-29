import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 2;
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT '',
      event_key TEXT,
      at INTEGER NOT NULL DEFAULT 0,
      route TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_events_at ON notification_events(at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_event_key
      ON notification_events(event_key) WHERE event_key IS NOT NULL AND event_key <> '';
    CREATE TABLE IF NOT EXISTS task_run_observations (
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(task_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS assistant_turn_completions (
      attempt_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_seq INTEGER NOT NULL UNIQUE,
      completed_at INTEGER NOT NULL,
      route_fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS device_push_tokens (
      device_id TEXT PRIMARY KEY REFERENCES paired_devices(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      token_generation INTEGER NOT NULL DEFAULT 1,
      package_name TEXT NOT NULL,
      firebase_app_id TEXT NOT NULL,
      app_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_success_at INTEGER,
      last_error_code TEXT,
      last_error_at INTEGER,
      quarantined_at INTEGER,
      quarantine_code TEXT
    );
    CREATE TABLE IF NOT EXISTS push_deliveries (
      notification_id INTEGER NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('pending','sending','retry','sent','expired','cancelled','dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_until INTEGER,
      expires_at INTEGER NOT NULL,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER,
      PRIMARY KEY(notification_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_push_deliveries_due ON push_deliveries(state, next_attempt_at);
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

function sanitizeState(value) {
  const state = value && typeof value === 'object' ? clone(value) : {};
  // Durable notifications have their own tables. Never reintroduce the old
  // destructive state.notifications mirror through a snapshot write.
  delete state.notifications;
  return state;
}

function stableLegacyId(prefix, bucket, position, item) {
  if (item?.id) return String(item.id);
  const digest = crypto.createHash('sha256').update(json(item)).digest('hex').slice(0, 14);
  return `${prefix}_legacy_${bucket}_${position}_${digest}`;
}

function insertSnapshot(db, snapshot) {
  const replaceMessages = Object.prototype.hasOwnProperty.call(snapshot, 'messages');
  const legacyNotifications = snapshot.state?.notifications?.items || [];
  const state = sanitizeState(snapshot.state || {});
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
    'subscriptions', 'api_auth', 'gong_messages',
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

  if (legacyNotifications.length && !db.prepare('SELECT 1 FROM notification_events LIMIT 1').get()) {
    const insertNotification = db.prepare('INSERT OR IGNORE INTO notification_events(id, kind, event_key, at, route, payload) VALUES(?, ?, ?, ?, ?, ?)');
    for (const item of legacyNotifications) {
      const notificationId = Number(item.id);
      if (!Number.isSafeInteger(notificationId) || notificationId <= 0) continue;
      insertNotification.run(
        notificationId, String(item.kind || ''), item.key || null, Number(item.at) || 0,
        String(item.route || ''), json({ ...item, id: notificationId, notification_id: notificationId }),
      );
    }
  }
}

function rowsAsObjects(db, table, order = 'position ASC') {
  return db.prepare(`SELECT payload FROM ${table} ORDER BY ${order}`).all().map(row => parse(row.payload, {}));
}

function loadSnapshot(db, defaults = {}) {
  const stateRow = db.prepare('SELECT payload FROM app_state WHERE id = 1').get();
  const authRow = db.prepare('SELECT payload FROM api_auth WHERE id = 1').get();
  const state = sanitizeState(parse(stateRow?.payload, defaults.state || {}));
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

function notificationObject(row) {
  const value = parse(row.payload, {});
  const notificationId = Number(row.id);
  return {
    ...value,
    id: notificationId,
    notification_id: notificationId,
    kind: String(row.kind || value.kind || ''),
    key: row.event_key || value.key || null,
    at: Number(row.at) || Number(value.at) || 0,
    route: String(row.route || value.route || ''),
  };
}

function notificationRow(db, id) {
  const row = db.prepare('SELECT id, kind, event_key, at, route, payload FROM notification_events WHERE id = ?').get(id);
  return row ? notificationObject(row) : null;
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

async function syncFile(file) {
  const handle = await fsp.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(dir) {
  const handle = await fsp.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function consistentBackup(db, dbPath, backupDir) {
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)')?.[0] || {};
  if (Number(checkpoint.busy || 0) !== 0 || Number(checkpoint.log || 0) !== 0) {
    throw new Error(`database checkpoint busy: ${json(checkpoint)}`);
  }
  const readonly = new Database(dbPath, { readonly: true });
  try {
    const result = readonly.pragma('integrity_check', { simple: true });
    if (String(result).trim() !== 'ok') throw new Error(`database integrity check failed: ${String(result).slice(0, 200)}`);
  } finally { readonly.close(); }
  const backupPath = path.join(backupDir, 'dwell.sqlite');
  await db.backup(backupPath);
  await fsp.chmod(backupPath, 0o600);
  await syncFile(backupPath);
  await syncDirectory(backupDir);
  return backupPath;
}

function migrateLegacyNotificationState(db, legacyState) {
  const notificationState = legacyState?.notifications && typeof legacyState.notifications === 'object'
    ? legacyState.notifications : {};
  const observations = db.prepare(`
    INSERT OR IGNORE INTO task_run_observations(task_id, run_id, observed_at, payload)
    VALUES(?, ?, ?, ?)
  `);
  for (const [key, value] of Object.entries(notificationState.taskSeen || {})) {
    const separator = key.lastIndexOf(':');
    if (separator <= 0 || separator === key.length - 1) continue;
    const taskId = key.slice(0, separator);
    const runId = key.slice(separator + 1);
    const observedAt = Number(value) || Math.floor(Date.parse(String(value || '')) / 1000) || 0;
    observations.run(taskId, runId, observedAt, json({ migrated: true, completed_at: value }));
  }
  const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get();
  const state = parse(row?.payload, {});
  delete state.notifications;
  db.prepare('INSERT OR REPLACE INTO app_state(id, payload) VALUES(1, ?)').run(json(state));
  return { taskObservations: Object.keys(notificationState.taskSeen || {}).length };
}

async function migrateExistingDatabase(dataDir, dbPath, db, defaults) {
  const backupDir = path.join(dataDir, 'backups', `pre-v061-${timestampSlug()}`);
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  let backupPath;
  try {
    backupPath = await consistentBackup(db, dbPath, backupDir);
    const legacyState = parse(db.prepare('SELECT payload FROM app_state WHERE id = 1').get()?.payload, defaults.state || {});
    const legacyEvents = db.prepare('SELECT id, kind, event_key, at, route, payload FROM notification_events ORDER BY id ASC').all();
    const migrateTransaction = db.transaction(() => {
      db.exec('DROP INDEX IF EXISTS idx_notification_events_event_key');
      db.exec('DROP INDEX IF EXISTS idx_notification_events_at');
      db.exec('ALTER TABLE notification_events RENAME TO notification_events_v1');
      db.exec(`CREATE TABLE notification_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT '',
        event_key TEXT,
        at INTEGER NOT NULL DEFAULT 0,
        route TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL
      )`);
      db.exec('CREATE INDEX idx_notification_events_at ON notification_events(at DESC)');
      db.exec('CREATE UNIQUE INDEX idx_notification_events_event_key ON notification_events(event_key) WHERE event_key IS NOT NULL AND event_key <> \'\'');
      const insert = db.prepare('INSERT OR IGNORE INTO notification_events(id, kind, event_key, at, route, payload) VALUES(?, ?, ?, ?, ?, ?)');
      const keys = new Set();
      for (const row of legacyEvents) {
        const key = row.event_key ? String(row.event_key) : '';
        if (key && keys.has(key)) continue;
        if (key) keys.add(key);
        insert.run(Number(row.id), String(row.kind || ''), key || null, Number(row.at) || 0, String(row.route || ''), row.payload || '{}');
      }
      const stateNotifications = legacyState.notifications?.items || [];
      for (const item of stateNotifications) {
        const notificationId = Number(item.id);
        if (!Number.isSafeInteger(notificationId) || notificationId <= 0) continue;
        const key = item.key ? String(item.key) : null;
        if (key && db.prepare('SELECT 1 FROM notification_events WHERE event_key = ?').get(key)) continue;
        insert.run(notificationId, String(item.kind || ''), key, Number(item.at) || 0, String(item.route || ''), json({ ...item, id: notificationId, notification_id: notificationId }));
      }
      db.exec('DROP TABLE notification_events_v1');
      schema(db);
      migrateLegacyNotificationState(db, legacyState);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('notification_epoch', crypto.randomUUID());
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(SCHEMA_VERSION));
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('migrated_from', '1');
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('migrated_at', new Date().toISOString());
    });
    migrateTransaction.immediate();
    return { ok: true, schemaVersion: SCHEMA_VERSION, backup: backupDir, backupPath };
  } catch (error) {
    const report = { ok: false, schemaVersion: SCHEMA_VERSION, database: dbPath, backup: backupDir, backupPath: backupPath || '', error: error.message };
    await fsp.writeFile(path.join(backupDir, 'migration-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    throw error;
  }
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
    const freshTransaction = db.transaction(() => {
      insertSnapshot(db, source);
      migrateLegacyNotificationState(db, source.state);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('notification_epoch', crypto.randomUUID());
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(SCHEMA_VERSION));
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('legacy_migrated_at', new Date().toISOString());
    });
    freshTransaction.immediate();
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
  let version = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value || 0);
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`unsupported dwell database schema ${version}; expected at most ${SCHEMA_VERSION}`);
  }
  if (version === 1) {
    try {
      migration = await migrateExistingDatabase(dataDir, dbPath, db, defaults);
      version = SCHEMA_VERSION;
    } catch (error) {
      db.close();
      throw error;
    }
  } else {
    schema(db);
  }
  if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`unsupported dwell database schema ${version}; expected ${SCHEMA_VERSION}`);
  }
  if (!db.prepare('SELECT value FROM meta WHERE key = ?').get('notification_epoch')?.value) {
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('notification_epoch', crypto.randomUUID());
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

  const createNotificationInTransaction = (event, senderEnabled, ttlSeconds = 3600, senderBinding = {}) => {
    const senderPackageName = String(senderBinding.packageName || '');
    const senderFirebaseAppId = String(senderBinding.firebaseAppId || '');
    const eventKey = event.eventKey == null ? null : String(event.eventKey);
    if (eventKey) {
      const existing = db.prepare('SELECT id, kind, event_key, at, route, payload FROM notification_events WHERE event_key = ?').get(eventKey);
      if (existing) return { created: false, notification: notificationObject(existing), deliveries: [] };
    }
    const at = Number(event.at) || Math.floor(Date.now() / 1000);
    const createdAt = Number(senderBinding.createdAt) || Math.floor(Date.now() / 1000);
    const payload = {
      kind: String(event.kind || ''), key: eventKey, title: String(event.title || 'Claude Cli'),
      body: String(event.body || ''), route: String(event.route || ''), at,
    };
    const result = db.prepare(`INSERT INTO notification_events(kind, event_key, at, route, payload) VALUES(?, ?, ?, ?, ?)`)
      .run(payload.kind, eventKey, at, payload.route, json(payload));
    const notificationId = Number(result.lastInsertRowid);
    payload.id = notificationId;
    payload.notification_id = notificationId;
    db.prepare('UPDATE notification_events SET payload = ? WHERE id = ?').run(json(payload), notificationId);
    const deliveries = [];
    if (senderEnabled && senderPackageName && senderFirebaseAppId) {
      const expiry = createdAt + Math.max(1, Number(ttlSeconds) || 3600);
      const tokens = db.prepare(`SELECT device_id, token_generation, token_hash
        FROM device_push_tokens
        WHERE quarantined_at IS NULL
          AND package_name = ?
          AND firebase_app_id = ?
          AND device_id IN (SELECT id FROM paired_devices WHERE revoked_at IS NULL)`).all(
        senderPackageName, senderFirebaseAppId,
      );
      const insert = db.prepare(`INSERT OR IGNORE INTO push_deliveries(
        notification_id, device_id, state, attempts, next_attempt_at, lease_token, lease_until,
        expires_at, last_error_code, created_at, updated_at, sent_at
      ) VALUES(?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL, ?, ?, NULL)`);
      for (const token of tokens) {
        insert.run(notificationId, token.device_id, createdAt, expiry, createdAt, createdAt);
        deliveries.push({ deviceId: token.device_id, tokenGeneration: token.token_generation, tokenHash: token.token_hash });
      }
    }
    return { created: true, notification: notificationObject(db.prepare('SELECT id, kind, event_key, at, route, payload FROM notification_events WHERE id = ?').get(notificationId)), deliveries };
  };
  const createNotificationTransaction = db.transaction(createNotificationInTransaction);

  const registerPushTokenTransaction = db.transaction(input => {
    const at = Number(input.at) || Math.floor(Date.now() / 1000);
    const device = db.prepare('SELECT revoked_at FROM paired_devices WHERE id = ?').get(input.deviceId);
    if (!device || device.revoked_at != null) return { ok: false, error: 'device_not_active' };
    const existingToken = db.prepare('SELECT device_id FROM device_push_tokens WHERE token_hash = ?').get(input.tokenHash);
    if (existingToken && existingToken.device_id !== input.deviceId) {
      const owner = db.prepare('SELECT revoked_at FROM paired_devices WHERE id = ?').get(existingToken.device_id);
      if (!owner || owner.revoked_at == null) return { ok: false, error: 'push_token_bound_elsewhere' };
      db.prepare('DELETE FROM device_push_tokens WHERE device_id = ?').run(existingToken.device_id);
    }
    const current = db.prepare('SELECT * FROM device_push_tokens WHERE device_id = ?').get(input.deviceId);
    const newBinding = !current
      || current.token_hash !== input.tokenHash
      || current.package_name !== input.packageName
      || current.firebase_app_id !== input.firebaseAppId;
    const generation = newBinding ? (Number(current?.token_generation) || 0) + 1 : Number(current.token_generation);
    if (newBinding && current) db.prepare(`UPDATE push_deliveries SET state = 'cancelled', lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE device_id = ? AND state IN ('pending', 'retry', 'sending')`).run(at, input.deviceId);
    db.prepare(`INSERT INTO device_push_tokens(
      device_id, token, token_hash, token_generation, package_name, firebase_app_id, app_version,
      created_at, updated_at, last_success_at, last_error_code, last_error_at, quarantined_at, quarantine_code
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
    ON CONFLICT(device_id) DO UPDATE SET
      token = excluded.token, token_hash = excluded.token_hash, token_generation = excluded.token_generation,
      package_name = excluded.package_name, firebase_app_id = excluded.firebase_app_id, app_version = excluded.app_version,
      updated_at = excluded.updated_at, quarantined_at = NULL, quarantine_code = NULL`).run(
      input.deviceId, input.token, input.tokenHash, generation, input.packageName, input.firebaseAppId,
      input.appVersion, Number(current?.created_at) || at, at,
    );
    return { ok: true, newBinding, generation };
  });

  const commitAssistantTransaction = db.transaction(input => {
    const existing = db.prepare('SELECT attempt_id, chat_id, message_seq, completed_at, route_fingerprint, payload FROM assistant_turn_completions WHERE attempt_id = ?').get(input.attemptId);
    if (existing) {
      const eventRow = db.prepare('SELECT id, kind, event_key, at, route, payload FROM notification_events WHERE event_key = ?').get(`chat:${Number(existing.message_seq)}`);
      return { created: false, completion: existing, notification: eventRow ? notificationObject(eventRow) : null };
    }
    db.prepare(`INSERT INTO assistant_turn_completions(
      attempt_id, chat_id, message_seq, completed_at, route_fingerprint, payload
    ) VALUES(?, ?, ?, ?, ?, ?)`).run(
      input.attemptId, input.chatId, Number(input.messageSeq), Number(input.completedAt) || Math.floor(Date.now() / 1000),
      input.routeFingerprint || '', json(input.metadata || {}),
    );
    const result = createNotificationInTransaction(input.event, input.senderEnabled, input.ttlSeconds, {
      packageName: input.senderPackageName,
      firebaseAppId: input.senderFirebaseAppId,
      createdAt: input.createdAt,
    });
    return { created: true, completion: { attemptId: input.attemptId, messageSeq: Number(input.messageSeq) }, ...result };
  });

  return {
    path: dbPath,
    migration,
    loadSnapshot: () => loadSnapshot(db, defaults),
    notificationEpoch() {
      return String(db.prepare('SELECT value FROM meta WHERE key = ?').get('notification_epoch')?.value || '');
    },
    latestNotificationId() {
      return Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM notification_events').get()?.id || 0);
    },
    notificationBaseline() {
      return { notificationEpoch: String(db.prepare('SELECT value FROM meta WHERE key = ?').get('notification_epoch')?.value || ''), latest: Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM notification_events').get()?.id || 0) };
    },
    listNotificationsAfter({ since = 0, limit = 50, order = 'asc' } = {}) {
      const safeSince = Number(since) || 0;
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const rows = order === 'desc'
        ? db.prepare(`SELECT id, kind, event_key, at, route, payload FROM notification_events WHERE id > ? ORDER BY id DESC LIMIT ?`).all(safeSince, safeLimit)
        : db.prepare(`SELECT id, kind, event_key, at, route, payload FROM notification_events WHERE id > ? ORDER BY id ASC LIMIT ?`).all(safeSince, safeLimit + 1);
      const hasMore = order !== 'desc' && rows.length > safeLimit;
      const items = rows.slice(0, safeLimit).map(notificationObject);
      const latest = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM notification_events').get()?.id || 0);
      return { items, hasMore, next: items.length ? Number(items.at(-1).notification_id) : safeSince, latest };
    },
    createNotification(event, {
      senderEnabled = false,
      ttlSeconds = 3600,
      senderPackageName = '',
      senderFirebaseAppId = '',
      createdAt = 0,
    } = {}) {
      return createNotificationTransaction.immediate(event, senderEnabled, ttlSeconds, {
        packageName: senderPackageName,
        firebaseAppId: senderFirebaseAppId,
        createdAt,
      });
    },
    commitAssistantCompletion(input) {
      return commitAssistantTransaction.immediate(input);
    },
    observeTaskRunAndCreateNotification(input) {
      const transaction = db.transaction(value => {
        const inserted = db.prepare(`INSERT OR IGNORE INTO task_run_observations(task_id, run_id, observed_at, payload)
          VALUES(?, ?, ?, ?)`).run(value.taskId, value.runId, Number(value.observedAt) || Math.floor(Date.now() / 1000), json(value.observation || {}));
        if (!inserted.changes) return { created: false, notification: null };
        return createNotificationInTransaction(value.event, !!value.senderEnabled, Number(value.ttlSeconds) || 86400, {
          packageName: value.senderPackageName,
          firebaseAppId: value.senderFirebaseAppId,
          createdAt: value.createdAt,
        });
      });
      return transaction.immediate(input);
    },
    registerPushToken(input) {
      return registerPushTokenTransaction.immediate(input);
    },
    unregisterPushToken(deviceId, at = Math.floor(Date.now() / 1000)) {
      const transaction = db.transaction(id => {
        db.prepare('DELETE FROM device_push_tokens WHERE device_id = ?').run(id);
        return db.prepare(`UPDATE push_deliveries SET state = 'cancelled', lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE device_id = ? AND state IN ('pending', 'retry', 'sending')`).run(at, id).changes;
      });
      return transaction.immediate(deviceId);
    },
    pushStatus(deviceId) {
      const token = db.prepare(`SELECT updated_at AS updatedAt, last_success_at AS lastSuccessAt, last_error_code AS lastErrorCode,
        last_error_at AS lastErrorAt, quarantined_at AS quarantinedAt, quarantine_code AS quarantineCode
        FROM device_push_tokens WHERE device_id = ?`).get(deviceId) || null;
      const pending = Number(db.prepare(`SELECT COUNT(*) AS count FROM push_deliveries WHERE device_id = ? AND state IN ('pending', 'retry', 'sending')`).get(deviceId)?.count || 0);
      return { registered: !!token, token: token ? { ...token } : null, pending };
    },
    claimPushDeliveries({
      workerId,
      limit = 100,
      at = Math.floor(Date.now() / 1000),
      leaseSeconds = 120,
      packageName = '',
      firebaseAppId = '',
    } = {}) {
      const transaction = db.transaction(() => {
        db.prepare(`UPDATE push_deliveries SET state = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'retry' END,
          lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE state = 'sending' AND lease_until <= ?`).run(at, at, at);
        db.prepare(`UPDATE push_deliveries SET state = 'expired', updated_at = ?
          WHERE state IN ('pending', 'retry') AND expires_at <= ?`).run(at, at);
        const filters = [
          "d.state IN ('pending', 'retry')",
          'd.next_attempt_at <= ?',
          'd.expires_at > ?',
          't.quarantined_at IS NULL',
          'p.revoked_at IS NULL',
        ];
        const params = [at, at];
        if (String(packageName || '')) {
          filters.push('t.package_name = ?');
          params.push(String(packageName));
        }
        if (String(firebaseAppId || '')) {
          filters.push('t.firebase_app_id = ?');
          params.push(String(firebaseAppId));
        }
        params.push(Math.min(Math.max(Number(limit) || 100, 1), 100));
        const rows = db.prepare(`SELECT d.notification_id AS notificationId, d.device_id AS deviceId, d.attempts,
          d.created_at AS createdAt, d.expires_at AS expiresAt, t.token, t.token_hash AS tokenHash, t.token_generation AS tokenGeneration,
          e.id AS id, e.kind, e.event_key AS eventKey, e.at, e.route, e.payload
          FROM push_deliveries d JOIN device_push_tokens t ON t.device_id = d.device_id
          JOIN paired_devices p ON p.id = d.device_id
          JOIN notification_events e ON e.id = d.notification_id
          WHERE ${filters.join(' AND ')}
          ORDER BY d.next_attempt_at ASC, d.notification_id ASC LIMIT ?`).all(...params);
        const update = db.prepare(`UPDATE push_deliveries SET state = 'sending', attempts = attempts + 1,
          lease_token = ?, lease_until = ?, updated_at = ?
          WHERE notification_id = ? AND device_id = ? AND state IN ('pending', 'retry')`);
        return rows.filter(row => {
          const leaseToken = crypto.randomUUID();
          const changed = update.run(leaseToken, at + leaseSeconds, at, row.notificationId, row.deviceId).changes === 1;
          if (changed) { row.leaseToken = leaseToken; row.leaseUntil = at + leaseSeconds; row.attempts += 1; row.notification = notificationObject(row); }
          return changed;
        });
      });
      return transaction.immediate();
    },
    completePushDelivery({ notificationId, deviceId, leaseToken, at = Math.floor(Date.now() / 1000) }) {
      return db.prepare(`UPDATE push_deliveries SET state = 'sent', sent_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL,
        last_error_code = NULL WHERE notification_id = ? AND device_id = ? AND state = 'sending' AND lease_token = ?`).run(at, at, notificationId, deviceId, leaseToken).changes === 1;
    },
    retryPushDelivery({ notificationId, deviceId, leaseToken, errorCode = 'temporary', nextAttemptAt, dead = false, at = Math.floor(Date.now() / 1000) }) {
      const state = dead ? 'dead' : 'retry';
      return db.prepare(`UPDATE push_deliveries SET state = ?, next_attempt_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL,
        last_error_code = ? WHERE notification_id = ? AND device_id = ? AND state = 'sending' AND lease_token = ?`).run(
        state, Number(nextAttemptAt) || at, at, String(errorCode).slice(0, 100), notificationId, deviceId, leaseToken,
      ).changes === 1;
    },
    recoverExpiredPushLeases(at = Math.floor(Date.now() / 1000)) {
      return db.prepare(`UPDATE push_deliveries SET state = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'retry' END,
        lease_token = NULL, lease_until = NULL, updated_at = ? WHERE state = 'sending' AND lease_until <= ?`).run(at, at, at).changes;
    },
    expirePushDelivery({ notificationId, deviceId, leaseToken, at = Math.floor(Date.now() / 1000) }) {
      return db.prepare(`UPDATE push_deliveries SET state = 'expired', lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE notification_id = ? AND device_id = ? AND state = 'sending' AND lease_token = ?`).run(
        at, notificationId, deviceId, leaseToken,
      ).changes === 1;
    },
    cancelPushDeliveries(at = Math.floor(Date.now() / 1000)) {
      return db.prepare(`UPDATE push_deliveries SET state = 'cancelled', lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE state IN ('pending', 'retry', 'sending')`).run(at).changes;
    },
    markPushTokenSuccess({ deviceId, tokenGeneration, tokenHash, at = Math.floor(Date.now() / 1000) }) {
      return db.prepare(`UPDATE device_push_tokens SET last_success_at = ?, last_error_code = NULL, last_error_at = NULL, updated_at = ?
        WHERE device_id = ? AND token_generation = ? AND token_hash = ?`).run(
        at, at, deviceId, tokenGeneration, tokenHash,
      ).changes === 1;
    },
    recordPushTokenError({ deviceId, tokenGeneration, tokenHash, errorCode = 'send_failed', at = Math.floor(Date.now() / 1000) }) {
      const code = String(errorCode).slice(0, 100);
      return db.prepare(`UPDATE device_push_tokens SET last_error_code = ?, last_error_at = ?, updated_at = ?
        WHERE device_id = ? AND token_generation = ? AND token_hash = ?`).run(
        code, at, at, deviceId, tokenGeneration, tokenHash,
      ).changes === 1;
    },
    removeInvalidPushToken({ deviceId, tokenGeneration, tokenHash, at = Math.floor(Date.now() / 1000) }) {
      const transaction = db.transaction(() => {
        const result = db.prepare('DELETE FROM device_push_tokens WHERE device_id = ? AND token_generation = ? AND token_hash = ?')
          .run(deviceId, tokenGeneration, tokenHash);
        if (result.changes) db.prepare(`UPDATE push_deliveries SET state = 'cancelled', lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE device_id = ? AND state IN ('pending', 'retry', 'sending')`).run(at, deviceId);
        return result.changes;
      });
      return transaction.immediate();
    },
    quarantinePushToken({ deviceId, tokenGeneration, tokenHash, code = 'credential_mismatch', at = Math.floor(Date.now() / 1000) }) {
      return db.prepare(`UPDATE device_push_tokens SET quarantined_at = ?, quarantine_code = ?, last_error_code = ?, last_error_at = ?, updated_at = ?
        WHERE device_id = ? AND token_generation = ? AND token_hash = ?`).run(at, String(code).slice(0, 100), String(code).slice(0, 100), at, at, deviceId, tokenGeneration, tokenHash).changes === 1;
    },
    saveState(state) { db.prepare('INSERT OR REPLACE INTO app_state(id, payload) VALUES(1, ?)').run(json(sanitizeState(state))); },
    counts: () => snapshotCounts(loadSnapshot(db, defaults)),
    saveSnapshot(snapshot) { saveTransaction.immediate(snapshot); },
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
    revokeDevice(id, at) {
      const transaction = db.transaction(deviceId => {
        const result = db.prepare('UPDATE paired_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, deviceId);
        if (!result.changes) return false;
        db.prepare('DELETE FROM device_push_tokens WHERE device_id = ?').run(deviceId);
        db.prepare(`UPDATE push_deliveries SET state = 'cancelled', lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE device_id = ? AND state IN ('pending', 'retry', 'sending')`).run(at, deviceId);
        return true;
      });
      return transaction.immediate(id);
    },
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
