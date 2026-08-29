#!/usr/bin/env node

/*
 * dwell backend
 *
 * Local service for the mobile/web client. Structured state lives in SQLite;
 * Markdown and uploaded files stay on disk. No credentials are bundled in the
 * repository.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { listDesktopTasks, controlDesktopTask, desktopTaskDetail, desktopTaskRunDetail } from './desktop-tasks.mjs';
import { recentCompletedTaskRuns } from './desktop-task-history.mjs';
import { listClaudeCodeChats, loadClaudeCodeChat } from './claude-history.mjs';
import { openDwellDatabase } from './db/database.mjs';
import { createFcmSender } from './services/fcm-sender.mjs';
import { createFcmDispatcher } from './services/fcm-dispatcher.mjs';
import { sanitizedChildEnv, claudeChildEnv } from './child-env.mjs';
import { visibleMessagePartsFromAssistant } from './message-parts.mjs';

let webpush = null;
try { ({ default: webpush } = await import('web-push')); } catch { /* optional until npm install */ }

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const DATA_DIR = path.resolve(process.env.DWELL_DATA_DIR || path.join(HERE, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const NEWS_DIR = path.join(DATA_DIR, 'news');
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const HOST = process.env.DWELL_HOST || '0.0.0.0';
const PORT = Number(process.env.DWELL_PORT || 8787);
const WORKSPACE = path.resolve(process.env.DWELL_WORKSPACE || ROOT);
const STORY_DIR = path.join(WORKSPACE, 'story');
const NIGHT_DIR = path.join(WORKSPACE, 'night');

function resolveClaudeExecutable() {
  if (process.env.DWELL_CLAUDE_BIN) return process.env.DWELL_CLAUDE_BIN;
  const candidates = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'claude')),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(process.env.HOME || '', '.local/bin/claude'),
    path.join(process.env.HOME || '', '.npm-global/bin/claude'),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return 'claude';
}

const CLAUDE_BIN = resolveClaudeExecutable();
const CLAUDE_TIMEOUT_MS = Number(process.env.DWELL_CLAUDE_TIMEOUT_MS || 15 * 60 * 1000);
const CLAUDE_BARE = process.env.DWELL_CLAUDE_BARE === '1';
const CLAUDE_SAFE_MODE = process.env.DWELL_CLAUDE_SAFE_MODE !== '0';
const CLAUDE_MODEL_OVERRIDE = String(process.env.DWELL_CLAUDE_MODEL || '').trim();
const GONG_MODEL = process.env.DWELL_GONG_MODEL || 'haiku';
const PERMISSION_MODE = process.env.DWELL_PERMISSION_MODE || 'acceptEdits';
const AUTH_TOKEN = process.env.DWELL_AUTH_TOKEN || '';
const SERVER_VERSION = '0.6.1';
const FCM_PACKAGE_NAME = 'com.xinwithyu.dwell';
const MAX_BODY = 16 * 1024 * 1024;
const MAX_TEXT = 600_000;
const MAX_UPLOAD_CHUNK = 4 * 1024 * 1024;
const MAX_UPLOAD_CHUNKS = 32;

const files = { favlines: path.join(DATA_DIR, 'favlines.md') };

const defaultState = {
  model: 'default',
  effort: 'high',
  activeChatId: 'main',
  armed: false,
  busy: false,
  sessionId: null,
  startedAt: Math.floor(Date.now() / 1000),
  apiMode: 'subscription',
  toolAccess: 'Auto',
  wakeOn: false,
  wakeNight: '',
  wakeCount: 0,
  wakeLast: 0,
  lastUserAt: 0,
  healthToken: '',
  health: { device: '', metrics: {}, history: {}, at: 0 },
  usage: { days: {}, last: {} },
  gongSessionId: null,
};

let state;
let messages = [];
let chats = [];
let notes = { gu: [], her: [] };
let todos = { mine: [], hers: [] };
let calendar = { events: [], period: { days: {} } };
let musicCache = new Map();
let diary = [];
let whisper = [];
let wall = [];
let nook = { books: [], progress: {}, annotations: {} };
let subscriptions = [];
let apiAuth = { mode: 'subscription', base: '', models: {} };
let gong = [];
let feedback = {};
let persistQueue = Promise.resolve();
let nextSeq = 0;
let activeRun = null;
let server;
let database;
let fcmDispatcher;
const fcmSender = createFcmSender();
const events = [];
const EVENT_LIMIT = 5000;
const sseClients = new Set();
const SSE_HEARTBEAT_MS = 15_000;

function now() { return Math.floor(Date.now() / 1000); }
function id(prefix = 'id') { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return clone(fallback); }
}

function cnDate(sec = now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000));
}

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function validNookSlug(value) {
  const text = String(value || '');
  return /^[\w\u4e00-\u9fff-]{1,180}$/u.test(text)
    && !['__proto__', 'prototype', 'constructor'].includes(text);
}

function cnClock(sec = now()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sec * 1000));
}

async function readDirSafe(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function loadStoryBricks() {
  const out = [];
  for (const entry of await readDirSafe(STORY_DIR)) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const date = entry.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) continue;
    let text = '';
    try { text = await fsp.readFile(path.join(STORY_DIR, entry.name), 'utf8'); } catch { continue; }
    for (const segment of text.split(/\n-{3,}\n/)) {
      const strength = segment.match(/情绪强度\s*[:：]\s*(\d)/)?.[1];
      const valence = segment.match(/效价\s*[:：]\s*([+-]?\d+)/)?.[1];
      const arousal = segment.match(/唤醒度\s*[:：]\s*(\d)/)?.[1];
      if (strength == null || valence == null || arousal == null) continue;
      const lines = segment.split('\n').map(x => x.trim()).filter(Boolean);
      const title = lines.find(x => !/^日期?[:：]/.test(x) && !/^>/.test(x) && !/^(关键词|她的情绪|我的情绪|情绪强度|效价|唤醒度)\s*[:：]/.test(x)) || '';
      const keywords = lines.find(x => /^关键词\s*[:：]/.test(x))?.replace(/^关键词\s*[:：]\s*/, '') || '';
      out.push({ date, title: title.slice(0, 80), s: Number(strength), v: Number(valence), a: Number(arousal), kw: keywords, text: segment.trim() });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

async function loadBookIndex() {
  const books = [];
  for (const entry of await readDirSafe(BOOKS_DIR)) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    let text;
    try { text = await fsp.readFile(path.join(BOOKS_DIR, entry.name), 'utf8'); } catch { continue; }
    const slug = entry.name.replace(/\.md$/i, '').replace(/[^\w\u4e00-\u9fff-]+/g, '-');
    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug;
    const chunks = text.split(/^##\s+/m).slice(1);
    const chapters = chunks.length ? chunks.map(chunk => {
      const lines = chunk.split('\n');
      return { title: lines.shift()?.trim() || '未命名', text: lines.join('\n').trim() };
    }) : [{ title, text: text.trim() }];
    books.push({ slug, title, chapters: chapters.map(x => x.title) });
    nook._content ||= {};
    nook._content[slug] = chapters;
  }
  return books;
}

async function musicInfo(songId) {
  const sid = String(songId || '').replace(/\D/g, '');
  if (!sid) return { ok: false };
  if (musicCache.has(sid)) return musicCache.get(sid);
  try {
    const response = await fetch(`https://music.163.com/api/song/detail?ids=%5B${sid}%5D`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' }, signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    const song = data.songs?.[0];
    if (!song) return { ok: false, id: sid };
    const result = { ok: true, id: sid, name: song.name || '', artist: (song.artists || []).map(x => x.name).join('/') || '', album: song.album?.name || '', pic: song.album?.picUrl || '', sec: Math.round(Number(song.duration || 0) / 1000) };
    musicCache.set(sid, result);
    return result;
  } catch { return { ok: false, id: sid }; }
}

async function pushToSubscribers(title, body) {
  if (!webpush || !subscriptions.length) return { sent: 0, skipped: subscriptions.length };
  const pub = vapidPublicKey();
  try { webpush.setVapidDetails(process.env.DWELL_VAPID_EMAIL || 'mailto:dwell@localhost', state.vapidPrivate, pub); } catch { return { sent: 0, skipped: subscriptions.length }; }
  let sent = 0;
  const dead = [];
  for (const subscription of subscriptions) {
    try { await webpush.sendNotification(subscription, JSON.stringify({ title, body, url: './' })); sent += 1; }
    catch (error) { if (error.statusCode === 404 || error.statusCode === 410) dead.push(subscription.endpoint); }
  }
  if (dead.length) { subscriptions = subscriptions.filter(item => !dead.includes(item.endpoint)); await persistAll(); }
  return { sent, skipped: subscriptions.length - sent };
}

function notificationAt(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : now();
}

function notificationEnvelope(notification, deviceId = '') {
  const notificationId = Number(notification.notification_id || notification.id);
  return {
    notification_epoch: database.notificationEpoch(),
    device_id: deviceId,
    id: notificationId,
    notification_id: notificationId,
    kind: notification.kind,
    title: String(notification.title || 'Claude Cli').slice(0, 64),
    body: String(notification.body || '').slice(0, 64),
    route: String(notification.route || '').slice(0, 1024),
    at: Number(notification.at) || now(),
  };
}

function emitDurableNotification(notification) {
  const envelope = notificationEnvelope(notification);
  emit({ type: 'notification', notification: envelope });
  notifyWaiters();
  return envelope;
}

async function recordChatNotification(message, run = null) {
  if (message?.kind !== 'gu' || !message.seq || !run) return 0;
  if (!run.completedSuccessfully || run.verificationStatus !== 'verified' || !isCurrentRun(run)) return 0;
  const sender = await fcmSender.status();
  if (!isCurrentRun(run)) return 0;
  const result = database.commitAssistantCompletion({
    attemptId: run?.attemptId || `message:${message.seq}`,
    chatId: String(message.chatId || state.activeChatId || ''),
    messageSeq: Number(message.seq),
    completedAt: Number(message.at) || now(),
    routeFingerprint: run?.routeFingerprint || 'unknown',
    metadata: {
      requested_model: run?.requestedModel || modelForCli(state.model) || state.model,
      cli_init_model: run?.cliInitModel || '',
      observed_runtime_model: run?.observedModel || '',
      provider: run?.provider || 'claude-code',
      attempt_id: run?.attemptId || '',
      route_fingerprint: run?.routeFingerprint || '',
      verification_status: run?.verificationStatus || 'unverified',
    },
    senderEnabled: sender.enabled && sender.configured,
    senderPackageName: sender.package_name,
    senderFirebaseAppId: sender.android_app_id,
    event: {
      eventKey: `chat:${message.seq}`,
      kind: 'chat',
      title: 'Claude Cli',
      body: '回答已完成',
      at: Number(message.at) || now(),
      route: `chat/${encodeURIComponent(message.chatId || state.activeChatId || '')}`,
    },
    ttlSeconds: 3600,
  });
  if (result.created && result.notification) emitDurableNotification(result.notification);
  return Number(result.notification?.notification_id || result.notification?.id || 0);
}

async function syncNotificationFeed() {
  const taskView = await listDesktopTasks();
  const taskNames = new Map((taskView.items || []).map(task => [task.id, task.name || task.id]));
  const taskRuns = await recentCompletedTaskRuns([...taskNames.keys()]);
  const sender = await fcmSender.status();
  const added = [];
  for (const run of [...taskRuns].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))) {
    const status = ['success', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? run.status : 'interrupted';
    const title = status === 'success' ? '已完成' : status === 'failed' ? '运行失败' : status === 'cancelled' ? '已取消' : '已中断';
    const result = database.observeTaskRunAndCreateNotification({
      taskId: String(run.taskId), runId: String(run.id), observedAt: notificationAt(run.completedAt),
      observation: { status, completed_at: run.completedAt, source: run.source || '' },
      senderEnabled: sender.enabled && sender.configured,
    senderPackageName: sender.package_name,
    senderFirebaseAppId: sender.android_app_id,
      ttlSeconds: 86400,
      event: {
        eventKey: `task:${run.taskId}:${run.id}`, kind: 'task', title,
        body: '任务运行已结束', at: notificationAt(run.completedAt),
        route: `task/${encodeURIComponent(run.taskId)}/${encodeURIComponent(run.id)}`,
      },
    });
    if (result.created && result.notification) added.push(emitDurableNotification(result.notification));
  }
  return added;
}

function normalizeHealth(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const incoming = source.metrics && typeof source.metrics === 'object' ? source.metrics : source;
  const aliases = { resting_hr: 'resting_heart_rate', sleep: 'sleep_hours', steps_count: 'steps' };
  const metrics = {};
  for (const [key, value] of Object.entries(incoming)) {
    const target = aliases[key] || key;
    if (['device', 'at', 'timestamp', 'history', 'metrics', 'token'].includes(target)) continue;
    if (value == null || typeof value === 'object' && value.value == null) continue;
    const item = typeof value === 'object' ? { ...value } : { value };
    item.value = item.value ?? value;
    item.unit ||= '';
    item.freshness = 'live';
    item.age_seconds = 0;
    metrics[target] = item;
  }
  return {
    device: String(source.device || source.source || '').slice(0, 120),
    metrics,
    history: source.history && typeof source.history === 'object' ? source.history : {},
    at: now(),
  };
}

function healthView() {
  const data = state.health || defaultState.health;
  const age = Math.max(0, now() - Number(data.at || 0));
  const freshness = !data.at ? 'no_data' : age < 3600 ? 'recent' : 'stale';
  const metrics = Object.fromEntries(Object.entries(data.metrics || {}).map(([key, item]) => [key, { ...item, freshness, age_seconds: age }]));
  return { ok: true, connected: !!data.at, device: data.device || '快捷指令', freshness, age_seconds: age, metrics, history: data.history || [] };
}

function vapidPublicKey() {
  if (state.vapidPublic) return state.vapidPublic;
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  state.vapidPrivate = ecdh.getPrivateKey().toString('base64url');
  state.vapidPublic = ecdh.getPublicKey().toString('base64url');
  queuePersist(() => database.saveState(clone(state)));
  return state.vapidPublic;
}

async function readNews(date = '') {
  const entries = (await readDirSafe(NEWS_DIR)).filter(x => x.isFile() && /\.md$/i.test(x.name)).map(x => x.name).sort().reverse();
  const dates = entries.map(name => name.match(/(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean).sort().reverse();
  const chosen = date || dates[0];
  if (!chosen) return { ok: false, dates: [] };
  const file = entries.find(name => name.includes(chosen));
  if (!file) return { ok: false, dates };
  return { ok: true, date: chosen, dates, text: await fsp.readFile(path.join(NEWS_DIR, file), 'utf8') };
}

async function readNight() {
  const dirs = [NIGHT_DIR, path.join(DATA_DIR, 'night')];
  const out = [];
  for (const dir of dirs) for (const entry of await readDirSafe(dir)) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const date = entry.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) continue;
    let text; try { text = await fsp.readFile(path.join(dir, entry.name), 'utf8'); } catch { continue; }
    let item = null; const items = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(\d{2}:\d{2})\s+(.+)$/);
      if (match) { item = { t: match[1], text: match[2].trim() }; items.push(item); }
      else if (item && line.trim()) item.text += `\n${line.trim()}`;
    }
    if (items.length) out.push({ date, items });
  }
  const unique = new Map(out.map(x => [x.date, x]));
  return [...unique.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function queuePersist(task) {
  persistQueue = persistQueue.then(task).catch(error => {
    console.error('[dwell] persist failed:', error.message);
  });
  return persistQueue;
}

async function persistAll() {
  const snapshot = clone({
    state, chats, notes, todos, calendar, diary, whisper, wall, nook, subscriptions, apiAuth, gong, feedback,
  });
  return queuePersist(() => database.saveSnapshot(snapshot));
}

function isCurrentRun(run) {
  return !!run && activeRun === run && !run.stopped && !run.superseded && !run.timedOut;
}

function routeFingerprint(provider, requestedModel, route = '') {
  return crypto.createHash('sha256')
    .update(`${String(provider || '')}|${String(requestedModel || '')}|${String(route || '')}`)
    .digest('hex').slice(0, 32);
}

function observeRunModel(run, candidate, source = 'runtime') {
  const observed = String(candidate || '').trim().slice(0, 200);
  if (!run || !observed) return;
  run.observedModel = observed;
  run.modelObservationSource = String(source || 'runtime').slice(0, 40);
  run.verificationStatus = 'verified';
}

async function appendMessage(record, chatId = state.activeChatId, run = null) {
  if (run && !isCurrentRun(run)) return null;
  const item = { seq: ++nextSeq, at: now(), chatId, ...record };
  messages.push(item);
  if (item.kind === 'me') state.lastUserAt = item.at;
  queuePersist(() => {
    if (run && !isCurrentRun(run)) return;
    database.appendMessage(item);
  });
  return item;
}

function canonicalEvent(event, cursor) {
  const chatId = event.chat_id || activeRun?.chatId || state.activeChatId || '';
  const base = { id: cursor, at: now(), chat_id: chatId };
  if (event.type === 'echo') return { ...base, type: 'message.created', data: { role: 'user', message_id: event.seq || null, text: event.text || '', at: event.at || now() } };
  if (event.type === 'stream_event') {
    const delta = event.event?.delta || {};
    if (delta.type === 'thinking_delta') return { ...base, type: 'thought.delta', data: { text: String(delta.thinking || '') } };
    if (delta.type === 'text_delta') return { ...base, type: 'assistant.delta', data: { text: String(delta.text || ''), synthetic: !!event.synthetic } };
  }
  if (event.type === 'assistant') return {
    ...base,
    type: 'assistant.message',
    data: { message_id: event.dwell_message_id || null, at: event.dwell_at || now(), message: event.message || {} },
  };
  if (event.type === 'result') return {
    ...base,
    type: event.is_error ? 'assistant.failed' : 'assistant.completed',
    data: { error: !!event.is_error, text: String(event.result || ''), notification_id: event.notification_id || 0 },
  };
  if (event.type === 'system') {
    const names = {
      newchat: 'chat.started', stopped: 'assistant.stopped', model: 'model.changed',
      regenerate: 'assistant.regenerated', switched: 'chat.switched', restart: 'backend.restarted',
    };
    return { ...base, type: names[event.subtype] || 'system.event', data: { ...event, type: undefined } };
  }
  if (event.type === 'notification') return { ...base, type: 'notification.created', data: event.notification || event };
  if (event.type === 'task') return { ...base, type: `task.${event.subtype || 'updated'}`, data: event.task || event };
  return { ...base, type: 'claude.event', data: event };
}

function writeSse(res, event) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch { return false; }
}

function sseEventForClient(event, deviceId) {
  if (event?.type !== 'notification.created') return event;
  return {
    ...event,
    data: { ...event.data, device_id: String(deviceId || '') },
  };
}

function broadcastSse(event) {
  for (const client of [...sseClients]) {
    const visible = sseEventForClient(event, client.deviceId);
    if (!writeSse(client.res, visible)) sseClients.delete(client);
  }
}

function emit(event, run = null) {
  if (run && !isCurrentRun(run)) return null;
  const cursor = ++nextSeq;
  const canonical = canonicalEvent(event, cursor);
  const item = { ...event, _cursor: cursor, _v2: canonical };
  events.push(item);
  if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
  broadcastSse(canonical);
  return item;
}

function serveEventStream(req, res, url, origin, deviceId) {
  const requested = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);
  const since = Number.isFinite(requested) && requested > 0 ? requested : 0;
  res.writeHead(200, {
    ...headers(origin),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.flushHeaders?.();
  const earliest = events[0]?._cursor || nextSeq;
  if (since > 0 && since < earliest - 1) {
    writeSse(res, { id: nextSeq, at: now(), chat_id: state.activeChatId || '', type: 'resync.required', data: { reason: 'cursor_expired' } });
  } else {
    for (const event of events) {
      if (event._cursor > since) writeSse(res, sseEventForClient(event._v2, deviceId));
    }
  }
  const client = { res, deviceId: String(deviceId || '') };
  sseClients.add(client);
  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return cleanup();
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { cleanup(); }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();
  const cleanup = () => { clearInterval(heartbeat); sseClients.delete(client); };
  req.once('close', cleanup);
  res.once('close', cleanup);
}

function notifyWaiters() {
  for (const waiter of waiters.splice(0)) waiter();
}

const waiters = [];

function waitForEvent(timeoutMs = 25000) {
  return new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const index = waiters.indexOf(finish);
      if (index >= 0) waiters.splice(index, 1);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    waiters.push(finish);
  });
}

async function load() {
  await Promise.all([ensureDir(UPLOAD_DIR), ensureDir(NEWS_DIR), ensureDir(BOOKS_DIR)]);
  database = await openDwellDatabase({
    dataDir: DATA_DIR,
    defaults: { state: defaultState, apiAuth: { mode: 'subscription', base: '', models: {} } },
  });
  fcmDispatcher = createFcmDispatcher({
    database,
    sender: fcmSender,
    onError: error => console.error('[dwell] fcm dispatcher:', error.message),
  });
  if (database.migration) console.log(`[dwell] migrated legacy data to SQLite; backup: ${database.migration.backup}`);
  const stored = database.loadSnapshot();
  state = { ...defaultState, ...(stored.state || {}) };
  state.health = { ...defaultState.health, ...(state.health || {}) };
  state.usage = { ...defaultState.usage, ...(state.usage || {}) };
  state.usage.days ||= {};
  state.usage.last ||= {};
  state.healthToken = state.healthToken || process.env.DWELL_HEALTH_TOKEN || crypto.randomBytes(18).toString('base64url');
  chats = stored.chats || [];
  notes = stored.notes || { gu: [], her: [] };
  todos = stored.todos || { mine: [], hers: [] };
  todos = { mine: todos.mine || [], hers: todos.hers || todos.yours || [] };
  calendar = stored.calendar || { events: [], period: { days: {} } };
  calendar.events ||= [];
  calendar.period ||= { days: {} };
  calendar.period.days ||= {};
  diary = stored.diary || [];
  whisper = stored.whisper || [];
  wall = stored.wall || [];
  nook = stored.nook || { books: [], progress: {}, annotations: {} };
  subscriptions = stored.subscriptions || [];
  apiAuth = stored.apiAuth || { mode: 'subscription', base: '', models: {} };
  const availableModelIds = new Set(modelCatalog().items.map(item => item.id));
  if (!availableModelIds.has(state.model)) state.model = modelCatalog().items[0]?.id || 'default';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(state.effort)) state.effort = 'high';
  gong = stored.gong || [];
  feedback = stored.feedback || {};
  messages = stored.messages || [];
  nextSeq = Math.max(
    messages.reduce((n, item) => Math.max(n, Number(item.seq) || 0), 0),
    database.latestNotificationId(),
  );
  if (!chats.length) {
    chats = [{ id: 'main', name: 'ShiJie', created: now(), last: now(), preview: '', current: true, archived: false, sessionId: null }];
  }
  if (!chats.some(chat => chat.id === state.activeChatId)) state.activeChatId = chats[0].id;
  let active = chats.find(chat => chat.id === state.activeChatId);
  if (active?.archived) {
    active = chats.find(chat => !chat.archived);
    if (!active) {
      active = chats.find(chat => chat.id === state.activeChatId) || chats[0];
      state.armed = true;
    }
    if (active) state.activeChatId = active.id;
  }
  if (active && !active.sessionId && state.sessionId) active.sessionId = state.sessionId;
  state.sessionId = state.armed ? null : (active?.sessionId || null);
  chats = chats.map(chat => ({ ...chat, current: !state.armed && chat.id === state.activeChatId }));
  const legacyChatId = chats.find(chat => chat.id === 'main')?.id || state.activeChatId;
  let migratedMessages = false;
  messages = messages.map(message => {
    if (message.chatId) return message;
    migratedMessages = true;
    return { ...message, chatId: legacyChatId };
  });
  if (migratedMessages) database.replaceMessages(messages);
  state.busy = false;
  state.startedAt = now();
  if (!state.lastUserAt) state.lastUserAt = messages.filter(x => x.kind === 'me').reduce((n, x) => Math.max(n, x.at || 0), 0);
  await persistAll();
}

function safePath(root, requested = '') {
  const clean = String(requested || '').replaceAll('\\', '/');
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('invalid path');
  return resolved;
}

async function safeRealPath(root, requested = '') {
  const candidate = safePath(root, requested);
  const [realRoot, realCandidate] = await Promise.all([fsp.realpath(root), fsp.realpath(candidate)]);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) throw new Error('invalid path');
  return realCandidate;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  })[ext] || 'application/octet-stream';
}

function headers(origin) {
  const allowed = String(process.env.DWELL_ALLOW_ORIGINS || 'https://appassets.androidplatform.net,null')
    .split(',').map(value => value.trim()).filter(Boolean);
  const allowOrigin = origin && allowed.includes(origin) ? origin : (!origin ? allowed[0] : 'null');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Dwell-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

function send(res, status, body, extra = {}) {
  const payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  const type = Buffer.isBuffer(payload) ? 'application/octet-stream' : (typeof payload === 'string' && extra.contentType ? extra.contentType : 'application/json; charset=utf-8');
  res.writeHead(status, { ...headers(extra.origin), 'Content-Type': type, ...extra.headers });
  res.end(payload);
}

function ok(res, body = { ok: true }, origin) { send(res, 200, body, { origin }); }
function bad(res, status, error, origin, detail = '') { send(res, status, { ok: false, error, ...(detail ? { detail } : {}) }, { origin }); }

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function requestToken(req) {
  return String(req.headers.authorization || '').replace(/^(?:Bearer|DwellDevice)\s+/i, '')
    || String(req.headers['x-dwell-token'] || '');
}

const deviceTouchAt = new Map();
function authenticate(req, { allowOpenLegacy = false } = {}) {
  const token = requestToken(req);
  if (AUTH_TOKEN && token && safeEqual(token, AUTH_TOKEN)) return { kind: 'legacy', deviceId: 'legacy' };
  if (token) {
    const device = database.activeDeviceByTokenHash(tokenHash(token));
    if (device) {
      const at = now();
      if (at - Number(deviceTouchAt.get(device.id) || 0) > 60) {
        database.touchDevice(device.id, at);
        deviceTouchAt.set(device.id, at);
      }
      return { kind: 'device', deviceId: device.id, device };
    }
  }
  if (!AUTH_TOKEN && allowOpenLegacy) return { kind: 'open', deviceId: 'legacy-open' };
  return null;
}

function localRequest(req) {
  const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

async function bodyBuffer(req, limit = MAX_BODY) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) { req.destroy(); throw new Error('request too large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function bodyJson(req) {
  const raw = await bodyBuffer(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('invalid json'); }
}

function recordUsage(raw = {}, cost = 0, failed = false, run = null) {
  if (run && !isCurrentRun(run)) return;
  const input = Number(raw.input_tokens ?? raw.prompt_tokens ?? 0) || 0;
  const output = Number(raw.output_tokens ?? raw.completion_tokens ?? 0) || 0;
  const cacheRead = Number(raw.cache_read_input_tokens ?? raw.cache_read_tokens ?? 0) || 0;
  const cacheWrite = Number(raw.cache_creation_input_tokens ?? raw.cache_write_tokens ?? 0) || 0;
  const day = cnDate();
  const current = state.usage.days[day] || { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  current.requests += 1;
  current.errors += failed ? 1 : 0;
  current.input += input;
  current.output += output;
  current.cacheRead += cacheRead;
  current.cacheWrite += cacheWrite;
  current.cost += Number(cost || 0) || 0;
  state.usage.days[day] = current;
  state.usage.last = {
    input,
    output,
    cacheRead,
    cacheWrite,
    at: now(),
    model: run?.observedModel || '',
    requested_model: run?.requestedModel || '',
    cli_init_model: run?.cliInitModel || '',
    observed_runtime_model: run?.observedModel || '',
    provider: run?.provider || '',
    attempt_id: run?.attemptId || '',
    route_fingerprint: run?.routeFingerprint || '',
    verification_status: run?.verificationStatus || 'unverified',
  };
  const keep = Object.keys(state.usage.days).sort().slice(-35);
  state.usage.days = Object.fromEntries(keep.map(key => [key, state.usage.days[key]]));
  queuePersist(() => database.saveState(clone(state)));
}

function contextView() {
  const measured = Number(state.usage.last?.input || 0);
  const current = messages.filter(item => item.chatId === state.activeChatId);
  const estimated = Math.round(JSON.stringify(current).length / 4);
  const used = Math.max(measured, estimated);
  const window = 200000;
  return {
    ok: true,
    used,
    max: window,
    window,
    pct: Math.min(100, Math.round(used / window * 100)),
    model: state.usage.last?.observed_runtime_model || state.usage.last?.model || '',
  };
}

function usageView() {
  const today = state.usage.days[cnDate()] || { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const totalTokens = today.input + today.output + today.cacheRead + today.cacheWrite;
  const requestPct = Math.min(100, Math.round(today.requests / 50 * 100));
  const tokenPct = Math.min(100, Math.round(totalTokens / 200000 * 100));
  return { ok: true, local: true, sections: [{ label: '本机今天的实际记录', bars: [
    { name: '请求次数', pct: requestPct, reset: `${today.requests} 次 · 失败 ${today.errors} 次 · 每天 0 点重新计数` },
    { name: 'Token 流量', pct: tokenPct, reset: `输入 ${today.input} · 输出 ${today.output} · 缓存读取 ${today.cacheRead}` },
  ] }] };
}

async function connectorItems() {
  const mode = CLAUDE_SAFE_MODE ? '安全模式 · 本机工具' : CLAUDE_BARE ? 'bare 模式' : 'hooks/MCP 已启用';
  const items = [{ name: 'Claude Code CLI', status: `${CLAUDE_BIN} · ${mode}${CLAUDE_MODEL_OVERRIDE ? ` · ${CLAUDE_MODEL_OVERRIDE}` : ''}` }];
  if (apiAuth.mode === 'api' && apiAuth.base) items.push({ name: '备用 API', status: apiAuth.base });
  try {
    const data = JSON.parse(await fsp.readFile(path.join(WORKSPACE, '.mcp.json'), 'utf8'));
    for (const name of Object.keys(data.mcpServers || {})) items.push({ name, status: CLAUDE_SAFE_MODE || CLAUDE_BARE ? '已配置 · 手机安全模式未加载' : '项目 MCP' });
  } catch {}
  return items;
}

function permissionMode() {
  if (state.toolAccess === 'Ask') return 'manual';
  if (state.toolAccess === 'Plan') return 'plan';
  return PERMISSION_MODE;
}

function chatRecord(chatId = state.activeChatId) {
  return chats.find(chat => chat.id === chatId) || null;
}

function activeChatRecord() {
  return chatRecord();
}

function modelForCli(model) {
  if (CLAUDE_MODEL_OVERRIDE) return CLAUDE_MODEL_OVERRIDE;
  const value = String(model || '').replace(/\[1m\]$/, '').toLowerCase();
  if (!value || value === 'default') return undefined;
  if (value === 'fable' || value.includes('fable')) return 'fable';
  if (value.includes('opus')) return 'opus';
  if (value.includes('haiku')) return 'haiku';
  if (value.includes('sonnet')) return 'sonnet';
  return undefined;
}

function modelCatalog() {
  if (apiAuth.mode === 'api' && apiAuth.base) {
    const configured = String(apiAuth.models?.model_opus || process.env.DWELL_API_MODEL || '').trim();
    const items = configured ? [{ id: configured, name: configured.replace(/^~/, ''), desc: '当前备用 API 已验证并配置的模型' }] : [];
    return {
      provider: '备用 API',
      locked: items.length <= 1,
      supportsEffort: false,
      items,
      resolved: configured,
    };
  }
  if (CLAUDE_MODEL_OVERRIDE) {
    return {
      provider: 'Claude Code CLI',
      locked: true,
      supportsEffort: true,
      items: [{ id: CLAUDE_MODEL_OVERRIDE, name: CLAUDE_MODEL_OVERRIDE, desc: '由 Mac 环境变量 DWELL_CLAUDE_MODEL 固定' }],
      resolved: CLAUDE_MODEL_OVERRIDE,
    };
  }
  return {
    provider: 'Claude Code CLI',
    locked: false,
    supportsEffort: true,
    items: [
      { id: 'default', name: 'Mac 默认模型', desc: '跟随这台 Mac 上 Claude Code 的当前默认配置' },
      { id: 'fable', name: 'Fable', desc: 'Claude Code 官方模型别名' },
      { id: 'opus', name: 'Opus', desc: 'Claude Code 官方模型别名' },
      { id: 'sonnet', name: 'Sonnet', desc: 'Claude Code 官方模型别名' },
      { id: 'haiku', name: 'Haiku', desc: 'Claude Code 官方模型别名' },
    ],
    resolved: modelForCli(state?.model) || 'Claude Code 默认配置',
  };
}

function modelFamily(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('haiku')) return 'haiku';
  if (normalized.includes('fable')) return 'fable';
  return normalized;
}

function modelRouteStatus(requestedModel, observedModel, verificationStatus) {
  if (verificationStatus !== 'verified' || !observedModel) return 'unverified';
  const requested = modelFamily(requestedModel);
  const observed = modelFamily(observedModel);
  if (!requested || requested === 'default') return 'unverified';
  return requested === observed ? 'matched' : 'mismatch';
}

function modelView() {
  const catalog = modelCatalog();
  const selected = catalog.items.some(item => item.id === state.model) ? state.model : (catalog.items[0]?.id || '');
  const last = state.usage.last || {};
  const requestedModel = String(last.requested_model || modelForCli(state.model) || state.model || '').trim();
  const preVerificationModel = String(last.cli_init_model || '').trim();
  const observedRuntimeModel = String(last.observed_runtime_model || last.model || '').trim();
  const verificationStatus = String(last.verification_status || (observedRuntimeModel ? 'verified' : 'unverified'));
  return {
    ok: true,
    model: selected,
    runtime: observedRuntimeModel,
    requested_model: requestedModel,
    pre_verification_model: preVerificationModel,
    observed_runtime_model: observedRuntimeModel,
    route_status: modelRouteStatus(requestedModel, observedRuntimeModel, verificationStatus),
    verification_status: verificationStatus,
    effort: state.effort,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    ...catalog,
  };
}

async function attachmentPrompt(attachments = []) {
  const parts = [];
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'text' && item.text) {
      parts.push(`\n--- 附件 ${item.name || 'text'} ---\n${String(item.text).slice(0, 200_000)}\n--- 附件结束 ---`);
    } else if (item.kind === 'image' && item.data) {
      const mime = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(item.media_type) ? item.media_type : 'image/jpeg';
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[mime];
      const original = path.basename(String(item.name || 'image')).replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
      const name = `${crypto.randomUUID()}-${original}${path.extname(original) ? '' : ext}`;
      const file = path.join(UPLOAD_DIR, name);
      const raw = Buffer.from(String(item.data), 'base64');
      if (!raw.length || raw.length > 12 * 1024 * 1024) throw new Error('图片为空或超过 12 MB');
      await fsp.writeFile(file, raw, { mode: 0o600 });
      parts.push(`\n用户附了一张图片：${file}\n请按需读取并分析。`);
    } else if (item.path) {
      const file = safePath(UPLOAD_DIR, path.basename(String(item.path)));
      parts.push(`\n用户附了文件：${file}`);
    }
  }
  return parts.join('\n');
}

function providerSpec(base) {
  const root = String(base || '').trim().replace(/\/+$/, '');
  const isAnthropic = /anthropic\.com/i.test(root) || /\/messages$/i.test(root);
  const isOpenRouter = /openrouter\.ai/i.test(root);
  if (isAnthropic) {
    const apiRoot = root.replace(/\/messages$/i, '').replace(/\/v1$/i, '');
    return { kind: 'anthropic', endpoint: `${apiRoot}/v1/messages`, models: `${apiRoot}/v1/models` };
  }
  const apiRoot = root.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '').replace(/\/v1$/i, '');
  const prefix = isOpenRouter && !/\/api$/i.test(apiRoot) ? `${apiRoot}/api` : apiRoot;
  return { kind: 'openai', endpoint: `${prefix}/v1/chat/completions`, models: `${prefix}/v1/models` };
}

function providerHeaders(kind, token, stream = true) {
  const out = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' };
  if (!token) return out;
  if (kind === 'anthropic') {
    out['x-api-key'] = token;
    out['anthropic-version'] = '2023-06-01';
  } else out.Authorization = `Bearer ${token}`;
  return out;
}

function providerContent(kind, prompt, attachments = []) {
  let text = prompt || '请看看附件。';
  const images = [];
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'text' && item.text) text += `\n\n--- 附件 ${item.name || 'text'} ---\n${String(item.text).slice(0, 200_000)}\n--- 附件结束 ---`;
    if (item.kind === 'image' && item.data) images.push(item);
    if (item.path) text += `\n\n用户附了本机文件 ${item.name || item.path}；远程 API 不能直接读取这个本机路径。`;
  }
  if (!images.length) return text;
  if (kind === 'anthropic') return [
    { type: 'text', text },
    ...images.map(item => ({ type: 'image', source: { type: 'base64', media_type: item.media_type || 'image/jpeg', data: item.data } })),
  ];
  return [
    { type: 'text', text },
    ...images.map(item => ({ type: 'image_url', image_url: { url: `data:${item.media_type || 'image/jpeg'};base64,${item.data}` } })),
  ];
}

function providerMessages(kind, prompt, attachments, chatId = '', beforeSeq = Number.MAX_SAFE_INTEGER) {
  const history = [];
  if (chatId) {
    const source = messages.filter(item => item.chatId === chatId && item.seq < beforeSeq && ['me', 'gu'].includes(item.kind) && item.text);
    let remaining = 60_000;
    for (let i = source.length - 1; i >= 0 && history.length < 30 && remaining > 0; i -= 1) {
      const raw = String(source[i].text || '');
      const text = raw.length > remaining ? raw.slice(-remaining) : raw;
      history.unshift({ role: source[i].kind === 'me' ? 'user' : 'assistant', content: text });
      remaining -= text.length;
    }
    while (history.at(-1)?.role === 'user') history.pop();
  }
  const merged = [];
  for (const item of history) {
    const previous = merged[merged.length - 1];
    if (previous?.role === item.role) previous.content += `\n\n${item.content}`;
    else merged.push({ ...item });
  }
  const current = providerContent(kind, prompt, attachments);
  const previous = merged[merged.length - 1];
  if (previous?.role === 'user') {
    if (Array.isArray(current)) {
      const firstText = current.find(item => item.type === 'text');
      if (firstText) firstText.text = `${previous.content}\n\n${firstText.text}`;
      merged.pop();
      merged.push({ role: 'user', content: current });
    } else previous.content += `\n\n${current}`;
  } else merged.push({ role: 'user', content: current });
  return merged;
}

function cliArgs(prompt, firstTurn, chatId = state.activeChatId, sessionOverride = '', workingDirectory = WORKSPACE) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-mode', permissionMode(), '--add-dir', workingDirectory];
  if (workingDirectory !== WORKSPACE) args.push('--add-dir', WORKSPACE);
  if (CLAUDE_SAFE_MODE) args.push('--safe-mode', '--no-chrome');
  if (CLAUDE_BARE) args.push('--bare');
  const cliModel = modelForCli(state.model);
  if (cliModel) args.push('--model', cliModel);
  if (state.effort) args.push('--effort', state.effort);
  const sessionId = sessionOverride || chatRecord(chatId)?.sessionId || (chatId === state.activeChatId ? state.sessionId : null);
  if (sessionId && !firstTurn) args.push('--resume', sessionId);
  else if (sessionId && firstTurn) args.push('--session-id', sessionId);
  return args;
}

function providerRequest(base, prompt, attachments = [], stream = true, modelOverride = '', run = null) {
  const spec = providerSpec(base);
  const configuredModel = modelOverride || state.model || apiAuth.models?.model_opus || process.env.DWELL_API_MODEL;
  const model = spec.kind === 'openai' ? String(configuredModel).replace(/^~/, '') : configuredModel;
  return {
    ...spec,
    body: {
      model,
      messages: providerMessages(spec.kind, prompt, attachments, run?.chatId, run?.userSeq),
      stream,
      max_tokens: 4096,
      ...(stream && spec.kind === 'openai' ? { stream_options: { include_usage: true } } : {}),
    },
  };
}

function providerResponseText(kind, data) {
  if (kind === 'anthropic') {
    return (data.content || []).filter(item => item?.type === 'text').map(item => item.text || '').join('');
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => typeof item === 'string' ? item : item?.text || '').join('');
  return '';
}

function providerErrorText(data) {
  const error = data?.error;
  if (!error) return '';
  if (typeof error === 'string') return error;
  return String(error.message || error.type || '备用 API 返回错误');
}

function assistantMetadata(run) {
  return {
    ...(Number.isFinite(run.userSeq) && run.userSeq < Number.MAX_SAFE_INTEGER ? { replyTo: run.userSeq } : {}),
    ...(run.variantOf ? { variantOf: run.variantOf, version: run.variantVersion } : {}),
  };
}

async function runApiProvider(prompt, attachments, run) {
  const request = providerRequest(apiAuth.base, prompt, attachments, true, '', run);
  run.provider = `api-${request.kind}`;
  run.requestedModel = String(request.body.model || '').slice(0, 200);
  run.routeFingerprint = routeFingerprint(run.provider, run.requestedModel, request.endpoint);
  const headers = providerHeaders(request.kind, apiAuth.token, true);
  run.controller = new AbortController();
  run.timeout = setTimeout(() => {
    run.timedOut = true;
    run.controller?.abort();
  }, CLAUDE_TIMEOUT_MS);
  run.timeout.unref();
  const response = await fetch(request.endpoint, { method: 'POST', headers, body: JSON.stringify(request.body), signal: run.controller.signal });
  if (!response.ok) throw new Error(`${request.endpoint} · ${response.status} ${(await response.text()).slice(0, 500)}`);
  if (!String(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
    const raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { throw new Error('备用 API 返回的不是 JSON 或 SSE'); }
    if (!isCurrentRun(run)) return;
    observeRunModel(run, data.model || data.model_id, 'provider_response');
    const providerError = providerErrorText(data);
    if (providerError) throw new Error(providerError);
    const text = providerResponseText(request.kind, data).trim();
    if (!text) throw new Error('备用 API 没有返回文本');
    if (text) {
      await emitProgressiveText(text, run);
      if (!isCurrentRun(run)) return;
      const saved = await appendMessage({ kind: 'gu', text, ...assistantMetadata(run) }, run.chatId, run);
      if (!saved || !isCurrentRun(run)) return;
      run.lastMessageSeq = saved.seq;
      run.finalMessage = saved;
      emit({ type: 'assistant', message: { content: [{ type: 'text', text }] }, dwell_message_id: saved.seq, dwell_at: saved.at }, run);
    }
    recordUsage(data.usage || {}, 0, false, run);
    run.hadResult = true;
    run.resultHasText = true;
    run.resultError = false;
    run.completedSuccessfully = !!run.finalMessage
      && !run.timedOut
      && !run.stopped
      && !run.superseded
      && run.verificationStatus === 'verified'
      && isCurrentRun(run);
    if (run.completedSuccessfully) run.notificationId = await recordChatNotification(run.finalMessage, run);
    emit({ type: 'result', is_error: false, result: text, notification_id: run.notificationId || 0 }, run);
    notifyWaiters();
    return;
  }
  let buffer = '', text = '', usage = {}, streamCompleted = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const feed = raw => {
    if (!isCurrentRun(run)) return;
    buffer += raw;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim();
      if (!value) continue;
      if (value === '[DONE]') { streamCompleted = true; continue; }
      let data; try { data = JSON.parse(value); } catch { continue; }
      observeRunModel(run, data.model || data.model_id || data.message?.model, 'provider_stream');
      const providerError = providerErrorText(data);
      if (providerError) { run.providerError = providerError; continue; }
      if (data.usage) usage = { ...usage, ...data.usage };
      if (data.message?.usage) usage = { ...usage, ...data.message.usage };
      if (data.type === 'message_stop' || data.type === 'message_end' || data.event === 'message_stop') streamCompleted = true;
      const choice = data.choices?.[0];
      if (choice?.finish_reason != null) streamCompleted = true;
      let delta = '';
      if (request.kind === 'anthropic') delta = data.delta?.text || '';
      else delta = choice?.delta?.content || '';
      if (!delta) continue;
      text += delta;
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } }, run);
      notifyWaiters();
    }
  };
  while (true) { const part = await reader.read(); if (part.done) break; feed(decoder.decode(part.value, { stream: true })); }
  feed(`${decoder.decode()}\n`);
  if (!isCurrentRun(run)) return;
  if (run.providerError) throw new Error(run.providerError);
  if (!streamCompleted) throw new Error('备用 API 流没有终止事件');
  if (!text.trim()) throw new Error('备用 API 没有返回文本');
  if (text.trim()) {
    const saved = await appendMessage({ kind: 'gu', text: text.trim(), ...assistantMetadata(run) }, run.chatId, run);
    if (!saved || !isCurrentRun(run)) return;
    run.lastMessageSeq = saved.seq;
    run.finalMessage = saved;
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: text.trim() }] }, dwell_message_id: saved.seq, dwell_at: saved.at }, run);
  }
  recordUsage(usage, 0, false, run);
  run.hadResult = true;
  run.resultHasText = true;
  run.resultError = false;
  run.completedSuccessfully = !!run.finalMessage
    && !run.timedOut
    && !run.stopped
    && !run.superseded
    && run.verificationStatus === 'verified'
    && isCurrentRun(run);
  if (run.completedSuccessfully) run.notificationId = await recordChatNotification(run.finalMessage, run);
  emit({ type: 'result', is_error: false, result: text.trim(), notification_id: run.notificationId || 0 }, run);
  notifyWaiters();
}

async function providerOnce(prompt) {
  const request = providerRequest(apiAuth.base, prompt, [], false);
  const response = await fetch(request.endpoint, {
    method: 'POST',
    headers: providerHeaders(request.kind, apiAuth.token, false),
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(Math.min(CLAUDE_TIMEOUT_MS, 180000)),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${request.endpoint} · ${response.status} ${raw.slice(0, 500)}`);
  let data; try { data = JSON.parse(raw); } catch { throw new Error('备用 API 返回的不是 JSON'); }
  const providerError = providerErrorText(data);
  if (providerError) throw new Error(providerError);
  const text = providerResponseText(request.kind, data);
  if (!text.trim()) throw new Error('备用 API 没有返回文本');
  recordUsage(data.usage || {}, 0, false);
  return text.trim();
}

async function claudeOnce(prompt) {
  const first = !state.gongSessionId;
  const sessionId = state.gongSessionId || crypto.randomUUID();
  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'dontAsk', '--add-dir', WORKSPACE, '--model', GONG_MODEL];
  if (CLAUDE_BARE) args.push('--bare');
  if (first) args.push('--session-id', sessionId);
  else args.push('--resume', sessionId);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(CLAUDE_BIN, args, {
      cwd: WORKSPACE,
      env: claudeChildEnv({ executionPath: CLAUDE_BIN, explicit: { NO_COLOR: '1' } }),
      timeout: Math.min(CLAUDE_TIMEOUT_MS, 180000),
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    recordUsage({}, 0, true);
    const stderr = String(error.stderr || '').trim();
    const suffix = error.code ? `（退出码 ${error.code}）` : error.signal ? `（信号 ${error.signal}）` : '';
    throw new Error(stderr ? stderr.slice(-1200) : `另一位没有应声${suffix}`);
  }
  let data; try { data = JSON.parse(stdout); } catch { throw new Error('另一位返回的数据读不懂'); }
  state.gongSessionId = data.session_id || sessionId;
  recordUsage(data.usage || {}, data.total_cost_usd || 0, !!data.is_error);
  if (data.is_error) throw new Error(data.result || '另一位没有应声');
  return String(data.result || '').trim();
}

async function talkToGong(text) {
  const prompt = `你住在 dwell 的另一间房。你和主助手相互独立，不冒充主助手。自然、简洁地回复用户。\n\n用户：${text}`;
  return apiAuth.mode === 'api' && apiAuth.base ? providerOnce(prompt) : claudeOnce(prompt);
}

async function emitProgressiveText(text, run) {
  const value = String(text || '');
  if (!value || run.timedOut || !isCurrentRun(run)) return;
  const chunkSize = Math.max(12, Math.ceil(value.length / 220));
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    if (run.timedOut || !isCurrentRun(run)) return;
    const chunk = value.slice(offset, offset + chunkSize);
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } }, synthetic: true }, run);
    notifyWaiters();
    if (offset + chunkSize < value.length) await new Promise(resolve => setTimeout(resolve, 16));
  }
}

async function runClaude(prompt, attachments, run) {
  run.provider = 'claude-code';
  run.requestedModel = String(modelForCli(state.model) || state.model || 'default').slice(0, 200);
  run.routeFingerprint = routeFingerprint(run.provider, run.requestedModel, CLAUDE_BIN);
  const chat = chatRecord(run.chatId);
  const priorSession = chat?.sessionId || '';
  const firstTurn = !priorSession;
  run.sessionId = priorSession || crypto.randomUUID();
  const fullPrompt = `${prompt || '请看看附件。'}${await attachmentPrompt(attachments)}`;
  let workingDirectory = WORKSPACE;
  if (chat?.source === 'claude-code' && chat.cwd && path.isAbsolute(chat.cwd)) {
    try { if ((await fsp.stat(chat.cwd)).isDirectory()) workingDirectory = chat.cwd; } catch {}
  }
  if (!isCurrentRun(run)) return;
  const child = spawn(CLAUDE_BIN, cliArgs(fullPrompt, firstTurn, run.chatId, run.sessionId, workingDirectory), {
    cwd: workingDirectory,
    env: claudeChildEnv({ executionPath: CLAUDE_BIN, explicit: { NO_COLOR: '1' } }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run.child = child;
  run.started = Date.now();
  let spawnError = null;
  child.on('error', error => { spawnError ||= error; });
  const stderr = [];
  child.stderr.on('data', chunk => {
    const text = String(chunk);
    if (stderr.join('').length < 12_000) stderr.push(text);
  });

  let finalText = '';
  let finalThinking = '';
  let sawAssistant = false;
  let sawTextDelta = false;
  let usageRecorded = false;
  const lines = readline.createInterface({ input: child.stdout });
  let lineQueue = Promise.resolve();
  const processLine = async line => {
    if (!line.trim()) return;
    let data;
    try { data = JSON.parse(line); } catch { return; }
    if (run.timedOut || !isCurrentRun(run)) return;
    const observedCandidate = data.model || data.model_id || data.message?.model;
    if (data.type === 'system' && data.subtype === 'init') {
      run.cliInitModel = String(observedCandidate || '').trim().slice(0, 200);
      observeRunModel(run, observedCandidate, 'cli_init');
    } else {
      observeRunModel(run, observedCandidate, data.type === 'result' ? 'cli_result' : 'cli_runtime');
    }
    if (data.session_id && ((data.type === 'system' && data.subtype === 'init') || data.type === 'result')) {
      run.sessionId = data.session_id;
      if (state.activeChatId === run.chatId) state.sessionId = data.session_id;
      const chat = chatRecord(run.chatId);
      if (chat) chat.sessionId = data.session_id;
      queuePersist(() => database.saveState(clone(state)));
    }
    if (data.type === 'result') {
      run.hadResult = true;
      const hasResultText = typeof data.result === 'string' && data.result.trim().length > 0;
      run.resultHasText = hasResultText;
      run.resultError = !!data.is_error || !hasResultText;
      const errorDetail = Array.isArray(data.errors)
        ? data.errors.filter(item => item && !String(item).startsWith('[ede_diagnostic]')).join('；')
        : '';
      run.resultEvent = data.is_error
        ? (data.result ? data : { ...data, result: errorDetail || `Claude Code 没有完成这次请求（${data.subtype || '执行错误'}）` })
        : (hasResultText
          ? data
          : { ...data, is_error: true, result: errorDetail || 'Claude Code 没有返回最终结果' });
      recordUsage(data.usage || {}, data.total_cost_usd || 0, run.resultError, run);
      usageRecorded = true;
    }
    if (data.type === 'result' && typeof data.result === 'string' && data.result.trim()) finalText = data.result.trim();
    if (data.type === 'stream_event') {
      const delta = data.event?.delta || {};
      if (delta.type === 'text_delta') { finalText += String(delta.text || ''); sawTextDelta = true; }
      if (delta.type === 'thinking_delta') finalThinking += String(delta.thinking || '');
    }
    if (data.type === 'assistant') {
      sawAssistant = true;
      for (const part of visibleMessagePartsFromAssistant(data.message)) {
        if (!isCurrentRun(run)) return;
        if (part.kind === 'think' && part.text) {
          await appendMessage(part, run.chatId, run);
          if (!isCurrentRun(run)) return;
        }
        if (part.kind === 'gu' && part.text) {
          if (!sawTextDelta) await emitProgressiveText(part.text, run);
          if (!isCurrentRun(run)) return;
          const saved = await appendMessage({ ...part, ...assistantMetadata(run) }, run.chatId, run);
          if (!saved || !isCurrentRun(run)) return;
          run.lastMessageSeq = saved.seq;
          run.finalMessage = saved;
          data.dwell_message_id = saved.seq;
          data.dwell_at = saved.at;
        }
      }
    }
    const visible = data.type === 'stream_event' || data.type === 'assistant' || data.type === 'user'
      || (data.type === 'system' && ['init', 'newchat', 'switched', 'stopped', 'restart', 'model'].includes(data.subtype));
    if (visible && isCurrentRun(run)) { emit(data, run); notifyWaiters(); }
  };
  lines.on('line', line => { lineQueue = lineQueue.then(() => processLine(line)); });

  const timeout = setTimeout(() => {
    if (child.exitCode === null) {
      run.timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    }
  }, CLAUDE_TIMEOUT_MS);

  await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timeout);
  await lineQueue;
  lines.close();
  if (run.superseded || run.stopped || activeRun !== run) return;
  if (firstTurn && !run.timedOut && !spawnError && child.exitCode === 0 && !run.resultError) {
    const chat = chatRecord(run.chatId);
    if (chat && !chat.sessionId) chat.sessionId = run.sessionId;
    if (state.activeChatId === run.chatId) state.sessionId = run.sessionId;
  }
  if (!run.timedOut && finalThinking.trim()) {
    await appendMessage({ kind: 'think', text: finalThinking.trim() }, run.chatId, run);
    if (!isCurrentRun(run)) return;
  }
  if (!run.timedOut && !run.finalMessage && !run.resultError && run.resultHasText && finalText.trim()) {
    const saved = await appendMessage({ kind: 'gu', text: finalText.trim(), ...assistantMetadata(run) }, run.chatId, run);
    if (!saved || !isCurrentRun(run)) return;
    run.lastMessageSeq = saved.seq;
    run.finalMessage = saved;
  }
  const processFailure = spawnError || child.exitCode !== 0 || run.timedOut;
  if (processFailure && !run.resultError) {
    run.hadResult = true;
    const detail = run.timedOut
      ? 'Claude Code 请求超时'
      : spawnError
        ? `Claude Code 启动失败：${spawnError.message || '找不到可执行程序'}`
        : stderr.join('').trim() || `claude exited with code ${child.exitCode}`;
    run.resultError = true;
    run.resultEvent = { type: 'result', is_error: true, result: detail.slice(-4000) };
  }
  if (!run.resultEvent && processFailure) {
    const detail = run.timedOut
      ? 'Claude Code 请求超时'
      : spawnError
        ? `Claude Code 启动失败：${spawnError.message || '找不到可执行程序'}`
        : stderr.join('').trim() || `claude exited with code ${child.exitCode}`;
    run.hadResult = true;
    run.resultError = true;
    run.resultEvent = { type: 'result', is_error: true, result: detail.slice(-4000) };
    if (!usageRecorded) recordUsage({}, 0, true, run);
  }
  const successful = isCurrentRun(run)
    && !run.timedOut
    && !run.stopped
    && !run.superseded
    && child.exitCode === 0
    && !spawnError
    && run.hadResult
    && run.resultHasText
    && !run.resultError
    && !!run.finalMessage?.text?.trim()
    && run.verificationStatus === 'verified';
  run.completedSuccessfully = successful;
  if (successful) run.notificationId = await recordChatNotification(run.finalMessage, run);
  if (run.resultEvent && (isCurrentRun(run) || run.timedOut)) {
    emit(
      { ...run.resultEvent, notification_id: run.notificationId || 0 },
      run.timedOut ? null : run,
    );
    notifyWaiters();
  }
  if (run.completedSuccessfully && isCurrentRun(run) && run.silent && run.finalMessage?.text?.trim()) {
    await pushToSubscribers('dwell', run.finalMessage.text.slice(0, 240));
  }
}

function stopRun() {
  if (!activeRun) return false;
  const run = activeRun;
  run.stopped = true;
  if (state) state.busy = false;
  if (run.controller) run.controller.abort();
  if (run.child) {
    const child = run.child;
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000).unref();
  }
  // Notify immediately instead of waiting for a provider/CLI close event. This keeps
  // clients from being stuck in the busy state when the child ignores SIGTERM.
  if (!run.superseded && !run.stopNotified) {
    run.stopNotified = true;
    emit({ type: 'system', subtype: 'stopped', text: '（我停下了）' });
    notifyWaiters();
  }
  return true;
}

function wakeView() {
  return { ok: true, on: !!state.wakeOn, count: Number(state.wakeCount || 0), max: 2, room: state.wakeOn ? '省' : '停' };
}

async function wakeTick() {
  if (!state.wakeOn || activeRun || state.armed) return;
  const hourMinute = Number(cnClock().replace(':', ''));
  if (!(hourMinute >= 2330 || hourMinute < 630)) return;
  const night = cnDate(now() - 12 * 3600);
  if (state.wakeNight !== night) { state.wakeNight = night; state.wakeCount = 0; state.wakeLast = 0; }
  if (state.wakeCount >= 2 || (state.wakeLast && now() - state.wakeLast < 190 * 60)) return;
  if (state.lastUserAt && now() - state.lastUserAt < 40 * 60) return;
  state.wakeCount += 1;
  state.wakeLast = now();
  await persistAll();
  await startTurn(`【心跳】没人叫你，这是你自己的时间（今晚第 ${state.wakeCount} 次，最多两次）。挑一件事做，一次只做一件。做完在夜记里留几句。`, [], { silent: true });
}

async function startTurn(text, attachments = [], options = {}) {
  if (activeRun) { activeRun.superseded = true; stopRun(); }
  const userText = String(text || '').trim();
  await syncNotificationFeed();
  if (state.armed) {
    state.armed = false;
    state.sessionId = null;
    state.activeChatId = id('chat');
    chats = chats.map(chat => ({ ...chat, current: false }));
    const firstLine = userText.split(/\r?\n/).find(Boolean) || '新会话';
    const name = firstLine.replace(/\s+/g, ' ').trim().slice(0, 42) || '新会话';
    chats.unshift({ id: state.activeChatId, name, created: now(), last: now(), preview: '', current: true, archived: false, sessionId: null });
    emit({ type: 'system', subtype: 'newchat', text: '（新窗口开好了）' });
  }
  const baseRunnerText = options.regenerate
    ? `请重新生成对用户上一条问题的回答。不要提及“重新生成”，不要复述旧答案；重新组织思路并直接给出完整答案。\n\n用户上一条问题：\n${userText}`
    : userText;
  const runnerText = options.webSearch
    ? `${baseRunnerText || '请看看附件。'}\n\n[用户已开启 Web search。需要最新或外部信息时，请使用可用的网页搜索工具并说明来源；如果当前通道没有搜索工具，请明确说不能实时搜索。]`
    : baseRunnerText;
  const turnChatId = state.activeChatId;
  let userMessage = null;
  if (!options.silent && options.recordUser !== false) {
    userMessage = await appendMessage({ kind: 'me', text: userText || '（附件）' }, turnChatId);
    emit({ type: 'echo', text: userText || '（附件）', at: userMessage.at, seq: userMessage.seq });
  }
  const chat = chatRecord(turnChatId);
  if (chat) { chat.last = now(); chat.preview = userText || '（附件）'; }
  state.busy = true;
  await persistAll();
  const run = {
    attemptId: crypto.randomUUID(),
    child: null, controller: null, timeout: null, timedOut: false, stopped: false,
    superseded: false, silent: !!options.silent, started: Date.now(), chatId: turnChatId,
    userSeq: userMessage?.seq || Number(options.userSeq) || Number.MAX_SAFE_INTEGER,
    notificationId: 0,
    requestedModel: '', cliInitModel: '', observedModel: '', provider: '', routeFingerprint: '',
    verificationStatus: 'unverified', finalMessage: null, completedSuccessfully: false,
    hadResult: false, resultError: false, resultHasText: false,
    variantOf: Number(options.variantOf) || 0,
    variantVersion: Number(options.variantVersion) || 0,
  };
  activeRun = run;
  const runner = apiAuth.mode === 'api' && apiAuth.base ? runApiProvider : runClaude;
  runner(runnerText, attachments, run).catch(error => {
    if (run.superseded || activeRun !== run) return;
    if (run.stopped) {
      run.hadResult = true;
      run.completedSuccessfully = false;
      run.stopNotified = true;
      emit({ type: 'system', subtype: 'stopped', text: '（我停下了）' });
      notifyWaiters();
      return;
    }
    recordUsage({}, 0, true, run);
    run.hadResult = true;
    run.resultError = true;
    run.completedSuccessfully = false;
    const timeoutMessage = run.provider.startsWith('api-') ? '备用 API 请求超时' : 'Claude Code 请求超时';
    emit(
      { type: 'result', is_error: true, result: run.timedOut ? timeoutMessage : (error.message || 'Claude Code 没有启动') },
      run.timedOut ? null : run,
    );
    notifyWaiters();
  }).finally(async () => {
    if (run.timeout) clearTimeout(run.timeout);
    if (activeRun !== run) return;
    if (run.stopped && !run.superseded && !run.stopNotified) {
      run.hadResult = true;
      run.completedSuccessfully = false;
      emit({ type: 'system', subtype: 'stopped', text: '（我停下了）' });
      notifyWaiters();
    }
    if (!run.hadResult && !run.stopped && !run.superseded) {
      run.hadResult = true;
      run.resultError = true;
      run.completedSuccessfully = false;
      emit(
        { type: 'result', is_error: true, result: 'Claude Code 没有返回最终结果' },
        run.timedOut ? null : run,
      );
      notifyWaiters();
    }
    activeRun = null;
    state.busy = false;
    const runChat = chatRecord(run.chatId);
    if (runChat) runChat.last = now();
    await persistAll();
  });
}

async function chatItems(scope = 'all') {
  const normalizedScope = scope === 'box' ? 'archived' : scope;
  const populatedChats = new Set(messages.map(message => message.chatId).filter(Boolean));
  const local = chats
    .filter(chat => {
      if (normalizedScope === 'live' && chat.archived) return false;
      if (normalizedScope === 'archived' && !chat.archived) return false;
      return !!chat.preview || populatedChats.has(chat.id) || (!state.armed && chat.id === state.activeChatId);
    })
    .sort((a, b) => Number(b.last || b.created || 0) - Number(a.last || a.created || 0))
    .map(chat => ({ ...chat, source: chat.source || 'dwell', sourceLabel: chat.source === 'claude-code' ? 'Mac' : '', current: !state.armed && chat.id === state.activeChatId }));
  if (normalizedScope === 'archived') return local;
  const external = await listClaudeCodeChats(chats.map(chat => chat.sessionId).filter(Boolean));
  return [...local, ...external]
    .sort((a, b) => Number(b.last || b.created || 0) - Number(a.last || a.created || 0));
}

async function importClaudeCodeHistory(externalId) {
  const source = await loadClaudeCodeChat(externalId);
  if (!source) return null;
  let chat = chats.find(item => item.sessionId === source.sessionId);
  if (!chat) {
    chat = {
      id: `cc_${source.sessionId}`,
      name: source.name,
      created: source.created,
      last: source.last,
      preview: source.preview,
      current: false,
      archived: false,
      sessionId: source.sessionId,
      source: 'claude-code',
      cwd: source.cwd,
    };
    chats.push(chat);
  } else {
    chat.name ||= source.name;
    chat.preview ||= source.preview;
    chat.created ||= source.created;
    chat.last = Math.max(Number(chat.last || 0), Number(source.last || 0));
    chat.source = 'claude-code';
    chat.cwd ||= source.cwd;
  }
  const known = new Set(messages.filter(item => item.chatId === chat.id && item.sourceUuid).map(item => item.sourceUuid));
  let changed = false;
  for (const record of source.messages) {
    if (known.has(record.sourceUuid)) continue;
    messages.push({ seq: ++nextSeq, chatId: chat.id, ...record });
    known.add(record.sourceUuid);
    changed = true;
  }
  if (changed) database.replaceMessages(messages);
  return chat;
}

function currentMessages(before, limit) {
  const sorted = messages.filter(item => item.chatId === state.activeChatId).sort((a, b) => a.seq - b.seq);
  const filtered = before ? sorted.filter(item => item.seq < before) : sorted;
  const msgs = filtered.slice(-limit).map(item => ({ ...item, feedback: feedback[String(item.seq)] || '' }));
  return { msgs, more: filtered.length > msgs.length, upto: sorted.reduce((n, item) => Math.max(n, item.seq), 0) };
}

async function git(args) {
  return execFileAsync('git', args, {
    cwd: WORKSPACE,
    env: sanitizedChildEnv({ executionPath: 'git' }),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10000,
  });
}

async function repoLog(url) {
  const n = Math.min(Math.max(Number(url.searchParams.get('n') || 60), 1), 100);
  const skip = Math.max(Number(url.searchParams.get('skip') || 0), 0);
  const { stdout } = await git(['log', '--date-order', `--skip=${skip}`, `-n`, String(n), '--pretty=format:%H%x09%ct%x09%s']);
  const lines = stdout.split('\n').filter(Boolean);
  const items = [];
  for (const line of lines) {
    const [h, t, ...subject] = line.split('\t');
    let filesOut = '';
    try { filesOut = (await git(['show', '--format=', '--name-status', h])).stdout; } catch {}
    const f = filesOut.split('\n').filter(Boolean).map(row => {
      const p = row.split('\t');
      return { s: p[0]?.[0] || 'M', p: p[p.length - 1] || '' };
    }).filter(item => item.p);
    items.push({ h: h.slice(0, 12), t: Number(t), s: subject.join('\t'), b: '', f });
  }
  let total = items.length;
  try { total = Number((await git(['rev-list', '--count', 'HEAD'])).stdout.trim()) || total; } catch {}
  return { ok: true, total, skip, items };
}

async function repoTree(rel) {
  const dir = await safeRealPath(WORKSPACE, rel);
  const list = await fsp.readdir(dir, { withFileTypes: true });
  const hidden = new Set(['.git', 'node_modules', '.gradle', 'build', 'dist']);
  const items = [];
  for (const entry of list) {
    if (hidden.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) items.push({ n: entry.name, d: true, z: 0 });
    else { const st = await fsp.stat(full); items.push({ n: entry.name, d: false, z: st.size }); }
  }
  items.sort((a, b) => Number(b.d) - Number(a.d) || a.n.localeCompare(b.n));
  return { ok: true, path: rel, items };
}

async function repoFile(rel) {
  const file = await safeRealPath(WORKSPACE, rel);
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error('not a file');
  const raw = await fsp.readFile(file);
  const cut = raw.length > MAX_TEXT;
  return { ok: true, path: rel, size: stat.size, cut, text: raw.subarray(0, MAX_TEXT).toString('utf8') };
}

async function handleNook(method, parts, req) {
  if (parts[1] === 'books' && method === 'GET') { nook.books = await loadBookIndex(); return nook.books; }
  if (parts[1] === 'progress' && method === 'GET') return nook.progress || {};
  if (parts[1] === 'progress' && method === 'POST') {
    const data = await bodyJson(req); const slug = String(data.slug || '');
    if (!validNookSlug(slug)) return { ok: false, error: 'invalid_slug' };
    nook.progress[slug] = { ch: Math.max(0, Number(data.ch) || 0), page: Math.max(0, Number(data.page) || 0), mode: Math.max(0, Number(data.mode) || 0), at: now() };
    await persistAll(); return nook.progress;
  }
  if (parts[1] === 'chapter' && method === 'GET') {
    const slug = decodeURIComponent(parts[2] || ''); const index = Number(parts[3] || 0);
    if (!validNookSlug(slug) || !Number.isInteger(index) || index < 0) return { error: 'not_found' };
    const books = await loadBookIndex();
    const book = books.find(item => item.slug === slug);
    const chapters = nook._content?.[slug] || [];
    if (!book || !chapters[index]) return { error: 'not_found' };
    return { book: book.title, title: chapters[index].title || `第 ${index + 1} 节`, text: chapters[index].text || '', index, total: chapters.length, chapters: chapters.map(item => item.title || '') };
  }
  if (parts[1] === 'annotations') {
    const slug = decodeURIComponent(parts[2] || ''); const ch = Number(parts[3] || 0); const key = `${slug}/${ch}`;
    if (!validNookSlug(slug) || !Number.isInteger(ch) || ch < 0) return { ok: false, error: 'invalid_location' };
    if (method === 'GET') return nook.annotations[key] || [];
    if (method === 'POST' && parts[4] && parts[5] === 'reply') { const item = (nook.annotations[key] || []).find(x => x.id === parts[4]); if (!item) throw new Error('not found'); const data = await bodyJson(req); (item.replies ||= []).push({ id: id('reply'), text: String(data.text || '').slice(0, 2000), who: data.who || 'user', ts: new Date().toLocaleString('zh-CN') }); await persistAll(); return item; }
    if (method === 'POST') { const data = await bodyJson(req); const item = { id: id('anno'), anchor: String(data.anchor || '').slice(0, 280), note: String(data.note || '').slice(0, 2000), who: data.who || 'user', ts: new Date().toLocaleString('zh-CN'), replies: [], at: now() }; (nook.annotations[key] ||= []).push(item); await persistAll(); return item; }
  }
  return { ok: false, error: 'not_found' };
}

function messagesForChat(chatId, before = 0, limit = 200) {
  const sorted = messages.filter(item => item.chatId === chatId).sort((a, b) => a.seq - b.seq);
  const filtered = before ? sorted.filter(item => item.seq < before) : sorted;
  const page = filtered.slice(-Math.min(Math.max(Number(limit) || 200, 1), 400));
  return {
    ok: true,
    chat_id: chatId,
    items: page.map(item => ({ ...item, feedback: feedback[String(item.seq)] || '' })),
    more: filtered.length > page.length,
    next_before: page[0]?.seq || 0,
    upto: sorted.at(-1)?.seq || 0,
  };
}

function pairingCodeHash(code) {
  return crypto.createHash('sha256').update(`dwell-pair-v1:${code}`).digest('hex');
}

function mutationId(data) {
  const value = String(data?.mutation_id || '').trim();
  return /^[a-zA-Z0-9:_-]{8,120}$/.test(value) ? value : '';
}

async function withMutationReceipt(auth, data, operation) {
  const key = mutationId(data);
  if (!key) return operation();
  const previous = database.mutationReceipt(key, auth.deviceId);
  if (previous) return { ...previous, replayed: true };
  const result = await operation();
  database.saveMutationReceipt({ mutationId: key, deviceId: auth.deviceId, createdAt: now(), result });
  return result;
}

async function beginRegeneration(target) {
  const explicitReply = Number(target.replyTo) || 0;
  const previous = explicitReply
    ? messages.find(item => item.seq === explicitReply && item.chatId === target.chatId && item.kind === 'me')
    : messages.filter(item => item.chatId === target.chatId && item.kind === 'me' && item.seq < target.seq).at(-1);
  if (!previous) return { ok: false, status: 400, error: 'original_prompt_not_found' };
  const root = Number(target.variantOf) || Number(target.seq);
  const versions = messages
    .filter(item => item.chatId === target.chatId && (Number(item.seq) === root || Number(item.variantOf) === root))
    .map(item => Number(item.version) || (Number(item.seq) === root ? 1 : 0));
  const version = Math.max(1, ...versions) + 1;
  const chat = chatRecord(target.chatId);
  if (chat) chat.sessionId = null;
  if (state.activeChatId === target.chatId) state.sessionId = null;
  await persistAll();
  emit({ type: 'system', subtype: 'regenerate', chat_id: target.chatId, message_id: root, version });
  notifyWaiters();
  await startTurn(previous.text, [], {
    webSearch: false, recordUser: false, regenerate: true, userSeq: previous.seq,
    variantOf: root, variantVersion: version,
  });
  return { ok: true, source_message_id: root, version };
}

async function handleApiV2(req, res, url, origin, auth) {
  const method = req.method || 'GET';
  const pathname = url.pathname.replace(/^\/api\/v2\/?/, '').replace(/\/$/, '');
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const route = parts.join('/');

  if (method === 'GET' && route === 'health') {
    return ok(res, { ok: true, service: 'dwell', api: 2, version: SERVER_VERSION, alive: true }, origin);
  }
  if (method === 'POST' && route === 'pairing/code') {
    if (!localRequest(req) && auth?.kind !== 'legacy') return bad(res, 403, 'local_request_required', origin);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = now() + 5 * 60;
    database.createPairingCode({ codeHash: pairingCodeHash(code), expiresAt });
    return ok(res, { ok: true, code, expires_at: expiresAt, expires_in: 300 }, origin);
  }
  if (method === 'POST' && route === 'pair') {
    const data = await bodyJson(req);
    const code = String(data.code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) return bad(res, 400, 'invalid_pairing_code', origin);
    const at = now();
    if (!database.consumePairingCode({ codeHash: pairingCodeHash(code), usedAt: at })) {
      return bad(res, 401, 'pairing_code_expired_or_used', origin);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const device = {
      id: id('device'),
      name: String(data.name || 'Android').trim().slice(0, 60) || 'Android',
      tokenHash: tokenHash(token),
      publicKey: String(data.public_key || '').slice(0, 1000),
      createdAt: at,
      lastSeenAt: at,
    };
    database.addDevice(device);
    return ok(res, { ok: true, device: { id: device.id, name: device.name, created_at: at }, token }, origin);
  }
  if (!auth) return bad(res, 401, 'device_pairing_required', origin);

  if (method === 'GET' && route === 'events') return serveEventStream(req, res, url, origin, auth.deviceId);
  if (method === 'GET' && route === 'bootstrap') {
    return ok(res, {
      ok: true,
      version: SERVER_VERSION,
      server_time: now(),
      device_id: auth.deviceId,
      notification_epoch: database.notificationEpoch(),
      status: { busy: !!activeRun || !!state.busy, armed: !!state.armed, active_chat_id: state.activeChatId, workspace: WORKSPACE, claude: CLAUDE_BIN },
      model: modelView(),
      chats: await chatItems('all'),
      messages: messagesForChat(state.activeChatId, 0, 120),
      capabilities: { sse: true, pairing: true, tasks: true, voice: 'android-native', notifications: 'durable', fcm: (await fcmSender.status()).enabled },
    }, origin);
  }
  if (method === 'GET' && route === 'notifications/baseline') {
    const baseline = database.notificationBaseline();
    return ok(res, { ok: true, device_id: auth.deviceId, notification_epoch: baseline.notificationEpoch, latest: baseline.latest }, origin);
  }
  if (method === 'PUT' && route === 'devices/me/push-token') {
    if (auth.kind !== 'device') return bad(res, 403, 'device_auth_required', origin);
    const data = await bodyJson(req);
    const provider = String(data.provider || '');
    const token = String(data.token || '');
    const packageName = String(data.package_name || '');
    const appVersion = String(data.app_version || '');
    const firebaseAppId = String(data.firebase_app_id || '');
    if (provider !== 'fcm') return bad(res, 400, 'invalid_push_provider', origin);
    if (!token || /[\x00-\x1f\x7f]/.test(token) || Buffer.byteLength(token, 'utf8') > 4096) return bad(res, 400, 'invalid_push_token', origin);
    if (packageName !== FCM_PACKAGE_NAME) return bad(res, 400, 'invalid_package_name', origin);
    if (!appVersion || Buffer.byteLength(appVersion, 'utf8') > 64) return bad(res, 400, 'invalid_app_version', origin);
    if (!firebaseAppId || Buffer.byteLength(firebaseAppId, 'utf8') > 256) return bad(res, 400, 'invalid_firebase_app_id', origin);
    const sender = await fcmSender.status();
    const senderBinding = fcmSender.validateBinding({ packageName, firebaseAppId }, sender);
    if (!senderBinding.ok) return bad(res, 400, senderBinding.code, origin);
    const binding = database.registerPushToken({
      deviceId: auth.deviceId, token, tokenHash: tokenHash(token), packageName,
      appVersion, firebaseAppId, at: now(),
    });
    if (!binding.ok) return bad(res, 409, binding.error, origin);
    return ok(res, {
      ok: true, device_id: auth.deviceId, registered: true, new_binding: !!binding.newBinding,
      sender: { enabled: sender.enabled, configured: sender.configured, health: sender.health, project_match: sender.project_match },
    }, origin);
  }
  if (method === 'DELETE' && route === 'devices/me/push-token') {
    if (auth.kind !== 'device') return bad(res, 403, 'device_auth_required', origin);
    database.unregisterPushToken(auth.deviceId, now());
    return ok(res, { ok: true, registered: false }, origin);
  }
  if (method === 'GET' && route === 'devices/me/push-status') {
    if (auth.kind !== 'device') return bad(res, 403, 'device_auth_required', origin);
    const sender = await fcmSender.status();
    const status = database.pushStatus(auth.deviceId);
    return ok(res, {
      ok: true, device_id: auth.deviceId, registered: status.registered,
      sender: { enabled: sender.enabled, configured: sender.configured, health: sender.health, project_match: sender.project_match },
      token: status.token, pending: status.pending,
    }, origin);
  }
  if (method === 'GET' && route === 'devices') return ok(res, { ok: true, items: database.listDevices() }, origin);
  if (method === 'POST' && parts[0] === 'devices' && parts[2] === 'revoke') {
    const target = parts[1];
    if (auth.kind === 'device' && target !== auth.deviceId) return bad(res, 403, 'cannot_revoke_other_device', origin);
    return ok(res, { ok: true, revoked: database.revokeDevice(target, now()) }, origin);
  }
  if (method === 'GET' && route === 'chats') {
    return ok(res, { ok: true, active_chat_id: state.activeChatId, armed: !!state.armed, items: await chatItems(url.searchParams.get('scope') || 'all') }, origin);
  }
  if (method === 'GET' && parts[0] === 'chats' && parts[2] === 'messages') {
    let chat = chats.find(item => item.id === parts[1]);
    if (!chat && parts[1].startsWith('claude:')) chat = await importClaudeCodeHistory(parts[1]);
    if (!chat) return bad(res, 404, 'chat_not_found', origin);
    return ok(res, messagesForChat(chat.id, Number(url.searchParams.get('before') || 0), Number(url.searchParams.get('limit') || 200)), origin);
  }
  if (method === 'POST' && parts[0] === 'chats' && parts[2] === 'activate') {
    let chat = chats.find(item => item.id === parts[1]);
    if (!chat && parts[1].startsWith('claude:')) chat = await importClaudeCodeHistory(parts[1]);
    if (!chat) return bad(res, 404, 'chat_not_found', origin);
    if (activeRun && activeRun.chatId !== chat.id) { activeRun.superseded = true; stopRun(); }
    state.armed = false;
    state.activeChatId = chat.id;
    state.sessionId = chat.sessionId || null;
    chats = chats.map(item => ({ ...item, current: item.id === chat.id }));
    await persistAll();
    emit({ type: 'system', subtype: 'switched', chat_id: chat.id });
    return ok(res, { ok: true, chat, messages: messagesForChat(chat.id, 0, 200) }, origin);
  }
  if (method === 'POST' && route === 'chats/new') {
    const data = await bodyJson(req);
    const result = await withMutationReceipt(auth, data, async () => {
      if (activeRun) { activeRun.superseded = true; stopRun(); }
      state.armed = true;
      state.sessionId = null;
      chats = chats.map(chat => ({ ...chat, current: false }));
      await persistAll();
      return { ok: true, armed: true };
    });
    return ok(res, result, origin);
  }
  if (method === 'POST' && route === 'chat/send') {
    const data = await bodyJson(req);
    const result = await withMutationReceipt(auth, data, async () => {
      const text = String(data.text || '').trim();
      if (!text && !(data.attachments || []).length) return { ok: false, error: 'empty_message' };
      await startTurn(text, data.attachments || [], { webSearch: !!data.web_search });
      return { ok: true, accepted_at: now(), chat_id: state.activeChatId };
    });
    return result.ok === false ? bad(res, 400, result.error, origin) : ok(res, result, origin);
  }
  if (method === 'POST' && route === 'chat/stop') return ok(res, { ok: true, stopped: stopRun() }, origin);
  if (method === 'POST' && route === 'chat/regenerate') {
    const data = await bodyJson(req);
    const target = messages.find(item => String(item.seq) === String(data.message_id || '') && item.kind === 'gu');
    if (!target) return bad(res, 404, 'message_not_found', origin);
    if (activeRun) return bad(res, 409, 'busy', origin);
    const result = await withMutationReceipt(auth, data, () => beginRegeneration(target));
    return result.ok ? ok(res, result, origin) : bad(res, result.status || 400, result.error, origin);
  }
  if (method === 'POST' && route === 'message-feedback') {
    const data = await bodyJson(req);
    const messageId = String(data.message_id || '');
    const value = ['', 'up', 'down'].includes(String(data.value || '')) ? String(data.value || '') : '';
    const message = messages.find(item => String(item.seq) === messageId && item.kind === 'gu');
    if (!message) return bad(res, 404, 'message_not_found', origin);
    if (value) feedback[messageId] = value;
    else delete feedback[messageId];
    await persistAll();
    emit({ type: 'system', subtype: 'feedback', chat_id: message.chatId, message_id: message.seq, value });
    return ok(res, { ok: true, message_id: message.seq, value }, origin);
  }
  if (method === 'POST' && parts[0] === 'chats' && parts.length === 2) {
    const data = await bodyJson(req);
    let chat = chats.find(item => item.id === parts[1]);
    if (!chat && parts[1].startsWith('claude:')) chat = await importClaudeCodeHistory(parts[1]);
    if (!chat) return bad(res, 404, 'chat_not_found', origin);
    if (data.action === 'rename') {
      const name = String(data.name || '').trim().slice(0, 80);
      if (!name) return bad(res, 400, 'name_required', origin);
      chat.name = name;
    } else if (data.action === 'archive' || data.action === 'restore') {
      chat.archived = data.action === 'archive';
      if (chat.archived && chat.id === state.activeChatId && !state.armed) {
        if (activeRun?.chatId === chat.id) { activeRun.superseded = true; stopRun(); }
        state.armed = true;
        state.sessionId = null;
      }
    } else {
      return bad(res, 400, 'unsupported_chat_action', origin);
    }
    chat.last = Math.max(Number(chat.last || 0), now());
    chats = chats.map(item => ({ ...item, current: !state.armed && item.id === state.activeChatId }));
    await persistAll();
    emit({ type: 'system', subtype: 'chat_updated', chat_id: chat.id, action: data.action });
    return ok(res, { ok: true, active_chat_id: state.activeChatId, armed: !!state.armed, items: await chatItems('all') }, origin);
  }
  if (method === 'GET' && route === 'model') return ok(res, modelView(), origin);
  if (method === 'POST' && route === 'model') {
    const data = await bodyJson(req);
    const catalog = modelCatalog();
    const nextModel = String(data.model || state.model).slice(0, 200);
    const nextEffort = String(data.effort || state.effort);
    if (!catalog.items.some(item => item.id === nextModel)) return bad(res, 400, 'model_not_available', origin);
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(nextEffort)) return bad(res, 400, 'effort_not_available', origin);
    const changed = nextModel !== state.model || nextEffort !== state.effort;
    state.model = nextModel;
    state.effort = nextEffort;
    if (changed) {
      const chat = activeChatRecord();
      if (chat) chat.sessionId = null;
      state.sessionId = null;
      emit({ type: 'system', subtype: 'model', model: state.model, effort: state.effort });
    }
    await persistAll();
    return ok(res, modelView(), origin);
  }
  if (method === 'GET' && route === 'tasks') return ok(res, await listDesktopTasks(), origin);
  if (method === 'GET' && parts[0] === 'tasks' && parts.length === 2) {
    const result = await desktopTaskDetail(parts[1]);
    return result.ok ? ok(res, result, origin) : bad(res, result.status || 404, result.error, origin);
  }
  if (method === 'GET' && parts[0] === 'tasks' && parts[2] === 'runs' && parts.length === 4) {
    const result = await desktopTaskRunDetail(parts[1], parts[3]);
    return result.ok ? ok(res, result, origin) : bad(res, result.status || 404, result.error, origin);
  }
  if (method === 'POST' && parts[0] === 'tasks' && parts[2] === 'actions' && parts.length === 4) {
    const result = await controlDesktopTask(parts[3], parts[1]);
    if (!result.ok) return bad(res, result.status || 502, result.error, origin, result.detail || '');
    emit({ type: 'task', subtype: 'updated', task: { id: parts[1], action: parts[3], result } });
    return ok(res, result, origin);
  }
  if (method === 'GET' && route === 'notifications') {
    await syncNotificationFeed();
    const sinceRaw = url.searchParams.get('since');
    const limitRaw = url.searchParams.get('limit');
    const orderRaw = url.searchParams.get('order');
    if ((sinceRaw != null && !/^\\d+$/.test(sinceRaw)) || (sinceRaw != null && Number(sinceRaw) > Number.MAX_SAFE_INTEGER)) return bad(res, 400, 'invalid_pagination', origin);
    if ((limitRaw != null && !/^\\d+$/.test(limitRaw)) || (limitRaw != null && (Number(limitRaw) < 1 || Number(limitRaw) > 100))) return bad(res, 400, 'invalid_pagination', origin);
    if (orderRaw != null && orderRaw !== 'asc') return bad(res, 400, 'invalid_pagination', origin);
    const since = Number(sinceRaw || 0);
    const limit = Number(limitRaw || 50);
    const ordered = orderRaw === 'asc';
    const page = database.listNotificationsAfter({ since, limit, order: ordered ? 'asc' : 'desc' });
    const items = (ordered ? page.items : page.items.reverse()).map(item => notificationEnvelope(item, auth?.deviceId || ''));
    return ok(res, {
      ok: true, notification_epoch: database.notificationEpoch(), next: ordered ? page.next : page.latest,
      latest: page.latest, has_more: ordered ? page.hasMore : false, items,
    }, origin);
  }
  return bad(res, 404, 'not_found', origin);
}

async function handleApi(req, res, url, origin, auth = null) {
  const method = req.method || 'GET';
  const pathname = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const parts = pathname.split('/').filter(Boolean);
  const route = parts.join('/');

  if (method === 'GET' && route === 'health') return ok(res, { ok: true, service: 'dwell', version: SERVER_VERSION, alive: true }, origin);
  if (method === 'GET' && route === 'status') return ok(res, { ok: true, alive: true, backend: 'claude-code', version: SERVER_VERSION, since: state.startedAt, busy: !!activeRun || !!state.busy, armed: !!state.armed, wake: wakeView(), workspace: WORKSPACE, claude: CLAUDE_BIN }, origin);
  if (route === 'messages' && method === 'GET') return ok(res, currentMessages(url.searchParams.get('before') ? Number(url.searchParams.get('before')) : 0, Math.min(Number(url.searchParams.get('limit') || 400), 400)), origin);
  if (route === 'said' && method === 'GET') return ok(res, currentMessages('', Math.min(Number(url.searchParams.get('limit') || 400), 400)), origin);
  if (route === 'message-feedback' && method === 'POST') {
    const data = await bodyJson(req);
    const messageId = String(data.message_id || '');
    const value = ['', 'up', 'down'].includes(String(data.value || '')) ? String(data.value || '') : '';
    const message = messages.find(item => String(item.seq) === messageId && item.kind === 'gu');
    if (!message) return bad(res, 404, 'message_not_found', origin);
    if (value) feedback[messageId] = value;
    else delete feedback[messageId];
    await persistAll();
    return ok(res, { ok: true, message_id: message.seq, value: feedback[messageId] || '' }, origin);
  }
  if (route === 'retry' && method === 'POST') {
    const data = await bodyJson(req);
    const target = messages.find(item => String(item.seq) === String(data.message_id || '') && item.kind === 'gu');
    if (!target) return bad(res, 404, 'message_not_found', origin);
    if (activeRun) return bad(res, 409, 'busy', origin);
    const result = await beginRegeneration(target);
    return result.ok ? ok(res, result, origin) : bad(res, result.status || 400, result.error, origin);
  }
  if (route === 'desktop-tasks' && method === 'GET') return ok(res, await listDesktopTasks(), origin);
  if (parts[0] === 'desktop-tasks' && parts.length === 2 && method === 'GET') {
    const result = await desktopTaskDetail(parts[1]);
    if (!result.ok) return bad(res, result.status || 404, result.error, origin);
    return ok(res, result, origin);
  }
  if (parts[0] === 'desktop-tasks' && parts[2] === 'runs' && parts.length === 4 && method === 'GET') {
    const result = await desktopTaskRunDetail(parts[1], parts[3]);
    if (!result.ok) return bad(res, result.status || 404, result.error, origin);
    return ok(res, result, origin);
  }
  if (parts[0] === 'desktop-tasks' && parts.length === 3 && method === 'POST') {
    const result = await controlDesktopTask(parts[2], parts[1]);
    if (!result.ok) return bad(res, result.status || 502, result.error, origin, result.detail || '');
    return ok(res, result, origin);
  }
  if (route === 'poll' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const get = () => events.filter(item => item._cursor > since).map(({ _cursor, _v2, ...event }) => event);
    let fresh = get();
    if (!fresh.length && url.searchParams.get('wait') !== '0') {
      await waitForEvent();
      fresh = get();
    }
    return ok(res, { ok: true, next: nextSeq, ver: SERVER_VERSION, events: fresh }, origin);
  }
  if (route === 'send' && method === 'POST') { const data = await bodyJson(req); await startTurn(data.text, data.attachments || [], { webSearch: !!data.web_search }); return ok(res, { ok: true }, origin); }
  if (route === 'stop' && method === 'POST') { const stopped = stopRun(); return ok(res, { ok: true, stopped }, origin); }
  if (route === 'model' && method === 'GET') return ok(res, modelView(), origin);
  if (route === 'model' && method === 'POST') {
    const data = await bodyJson(req);
    const catalog = modelCatalog();
    const nextModel = data.model ? String(data.model).slice(0, 200) : state.model;
    const nextEffort = data.effort ? String(data.effort) : state.effort;
    if (!catalog.items.some(item => item.id === nextModel)) return bad(res, 400, 'model_not_available', origin);
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(nextEffort)) return bad(res, 400, 'effort_not_available', origin);
    const changed = nextModel !== state.model || nextEffort !== state.effort;
    state.model = nextModel;
    state.effort = nextEffort;
    if (changed) {
      const chat = activeChatRecord();
      if (chat) chat.sessionId = null;
      state.sessionId = null;
      emit({ type: 'system', subtype: 'model', model: state.model, effort: state.effort });
      notifyWaiters();
    }
    await persistAll();
    return ok(res, modelView(), origin);
  }
  if (route === 'context' && method === 'GET') return ok(res, contextView(), origin);
  if (route === 'usage' && method === 'GET') return ok(res, usageView(), origin);
  if (route === 'projects' && method === 'GET') return ok(res, { ok: true, items: [{ id: 'current', name: path.basename(WORKSPACE), path: WORKSPACE, current: true }] }, origin);
  if (route === 'tool-access' && method === 'GET') return ok(res, { ok: true, mode: state.toolAccess || 'Auto', items: ['Auto', 'Ask', 'Plan'] }, origin);
  if (route === 'tool-access' && method === 'POST') { const data = await bodyJson(req); const mode = ['Auto', 'Ask', 'Plan'].includes(data.mode) ? data.mode : 'Auto'; state.toolAccess = mode; await persistAll(); return ok(res, { ok: true, mode, items: ['Auto', 'Ask', 'Plan'] }, origin); }
  if (route === 'connectors' && method === 'GET') return ok(res, { ok: true, items: await connectorItems() }, origin);
  if (route === 'newchat' && method === 'POST') {
    const data = await bodyJson(req);
    const arm = !!data.arm;
    if (arm && activeRun) { activeRun.superseded = true; stopRun(); }
    state.armed = arm;
    state.sessionId = arm ? null : (activeChatRecord()?.sessionId || null);
    chats = chats.map(chat => ({ ...chat, current: !arm && chat.id === state.activeChatId }));
    await persistAll();
    return ok(res, { ok: true, armed: state.armed }, origin);
  }
  if (route === 'chats' && method === 'GET') return ok(res, { ok: true, items: await chatItems(url.searchParams.get('scope') || 'all'), armed: !!state.armed }, origin);
  if (route === 'chats' && method === 'POST') {
    const data = await bodyJson(req);
    const target = data.id === 'CURRENT' ? state.activeChatId : String(data.id || '');
    let chat = chats.find(item => item.id === target);
    if (!chat && data.action === 'switch' && target.startsWith('claude:')) chat = await importClaudeCodeHistory(target);
    const results = [];
    const setArchived = (item, archived) => {
      if (!item) return false;
      item.archived = archived;
      item.last = Math.max(Number(item.last || 0), now());
      if (archived && item.id === state.activeChatId && !state.armed) {
        if (activeRun?.chatId === item.id) { activeRun.superseded = true; stopRun(); }
        state.armed = true;
        state.sessionId = null;
      }
      return true;
    };

    if (data.action === 'rename' && chat) {
      const name = String(data.name || '').trim().slice(0, 80);
      if (name) chat.name = name;
    }
    if (data.action === 'archive') setArchived(chat, data.on === undefined ? true : !!data.on);
    if (data.action === 'restore') setArchived(chat, false);
    if (data.action === 'bulkArchive' || data.action === 'bulkRestore') {
      const archived = data.action === 'bulkArchive';
      const ids = [...new Set((Array.isArray(data.ids) ? data.ids : []).map(value => String(value || '')).filter(Boolean))].slice(0, 200);
      for (const chatId of ids) {
        const item = chats.find(candidate => candidate.id === chatId);
        const success = setArchived(item, archived);
        results.push({ id: chatId, ok: success, error: success ? '' : 'not_found' });
      }
    }
    if (data.action === 'switch' && chat) {
      if (activeRun && activeRun.chatId !== chat.id) { activeRun.superseded = true; stopRun(); }
      state.armed = false;
      state.activeChatId = chat.id;
      state.sessionId = chat.sessionId || null;
    }
    chats = chats.map(item => ({ ...item, current: !state.armed && item.id === state.activeChatId }));
    await persistAll();
    return ok(res, { ok: true, armed: !!state.armed, results, items: await chatItems('all') }, origin);
  }
  if (route === 'notes' && method === 'GET') return ok(res, notes, origin);
  if (route === 'notes' && method === 'POST') { const data = await bodyJson(req); if (data.action === 'add') (notes[data.who === 'gu' ? 'gu' : 'her'] ||= []).unshift({ id: id('note'), who: data.who, text: String(data.text || '').slice(0, 800), at: now(), boxed: false }); if (data.action === 'box') { const list = notes[data.who] || []; const item = list.find(x => x.id === data.id); if (item) item.boxed = !item.boxed; } if (data.action === 'del') notes.her = notes.her.filter(x => x.id !== data.id); await persistAll(); return ok(res, notes, origin); }
  if (route === 'find' && method === 'GET') { const q = String(url.searchParams.get('q') || '').trim().toLowerCase(); const corpus = [...messages.map(x => ({ kind: x.kind === 'me' ? '我' : '聊天', date: new Date(x.at * 1000).toLocaleDateString('zh-CN'), snippet: x.text || x.extra || '' })), ...diary.map(x => ({ kind: '日记', date: x.date || '', snippet: x.text || '' })), ...wall.map(x => ({ kind: '墙', date: x.date || '', snippet: `${x.title || ''} ${x.text || ''}` }))]; return ok(res, { ok: true, hits: q ? corpus.filter(x => x.snippet.toLowerCase().includes(q)).slice(0, 80) : [] }, origin); }
  if (route === 'todos' && method === 'GET') return ok(res, { ok: true, ...todos }, origin);
  if (route === 'todos' && method === 'POST') {
    const data = await bodyJson(req);
    const side = data.side || data.list || (data.who === 'hers' ? 'hers' : data.who === 'yours' ? 'hers' : 'mine');
    const key = side === 'hers' || side === 'yours' ? 'hers' : 'mine';
    const list = todos[key] ||= [];
    if (data.action === 'add') list.push({ id: id('todo'), text: String(data.text || '').slice(0, 300), done: false, at: data.at || '', fixed: !!data.fixed, by: data.by || (key === 'hers' ? 'her' : 'gu'), created: now() });
    if (data.action === 'toggle') { const item = list.find(x => x.id === data.id); if (item) item.done = !item.done; }
    if (data.action === 'del') todos[key] = list.filter(x => x.id !== data.id);
    if (data.action === 'edit') {
      const item = list.find(x => x.id === data.id);
      if (item) {
        const text = String(data.text || '').trim();
        if (!text) return bad(res, 400, 'empty_todo', origin);
        item.text = text.slice(0, 300);
        item.at = String(data.at || '').slice(0, 5);
        item.fixed = !!data.fixed;
        item.updated = now();
      }
    }
    await persistAll(); return ok(res, { ok: true, ...todos }, origin);
  }
  if (route === 'cal' && method === 'GET') return ok(res, { ok: true, cal: calendar, predict: null }, origin);
  if (route === 'cal' && method === 'POST') {
    const data = await bodyJson(req);
    if (data.action === 'add_event') (calendar.events ||= []).push({ id: id('event'), date: data.date, text: String(data.text || '').slice(0, 200), time: data.time || '', yearly: !!data.yearly, type: data.special ? 'special' : 'normal' });
    if (data.action === 'del_event') calendar.events = calendar.events.filter(x => x.id !== data.id);
    if (data.action === 'day_record' || data.action === 'set_mood') { const day = data.date || cnDate(); calendar.period.days[day] = { ...(calendar.period.days[day] || {}), mood: String(data.mood || ''), note: String(data.note || '').slice(0, 1000), at: now() }; }
    await persistAll(); return ok(res, { ok: true, cal: calendar, predict: null }, origin);
  }
  if (route === 'whisper' && method === 'GET') return ok(res, { items: whisper }, origin);
  if (route === 'whisper' && method === 'POST') { const data = await bodyJson(req); whisper.push({ id: id('whisper'), who: 'her', text: String(data.text || '').slice(0, 2000), at: now() }); await persistAll(); return ok(res, { ok: true, items: whisper }, origin); }
  if (route === 'herdiary' && method === 'GET') return ok(res, { items: diary }, origin);
  if (route === 'herdiary' && method === 'POST') { const data = await bodyJson(req); if (data.action === 'add') diary.unshift({ id: id('diary'), text: String(data.text || '').slice(0, 4000), at: now() }); if (data.action === 'del') diary = diary.filter(x => x.id !== data.id); await persistAll(); return ok(res, { ok: true, items: diary }, origin); }
  if (route === 'favlines' && method === 'GET') {
    let text = ''; try { text = await fsp.readFile(files.favlines, 'utf8'); } catch {}
    return ok(res, { ok: true, text: text.slice(0, MAX_TEXT) }, origin);
  }
  if (route === 'favlines' && method === 'POST') {
    const data = await bodyJson(req);
    await fsp.writeFile(files.favlines, String(data.text || '').slice(0, MAX_TEXT), { mode: 0o600 });
    return ok(res, { ok: true }, origin);
  }
  if (route === 'wall' && method === 'GET') { const bricks = await loadStoryBricks(); return ok(res, { ok: true, bricks: bricks.length ? bricks : wall }, origin); }
  if (route === 'dreams' && method === 'GET') return ok(res, { items: await readJson(path.join(DATA_DIR, 'dreams.json'), []) }, origin);
  if (route === 'night' && method === 'GET') return ok(res, { days: await readNight() }, origin);
  if (route === 'gong' && method === 'GET') return ok(res, { ok: true, msgs: gong.slice(-200) }, origin);
  if (route === 'gong' && method === 'POST') {
    const data = await bodyJson(req); const text = String(data.text || '').trim().slice(0, 12000);
    if (!text) return bad(res, 400, 'empty_message', origin);
    gong.push({ id: id('gong'), role: 'her', text, at: now() });
    const reply = await talkToGong(text);
    gong.push({ id: id('gong'), role: 'gong', text: reply || '（另一位没有说话）', at: now() });
    if (gong.length > 400) gong = gong.slice(-400);
    await persistAll();
    return ok(res, { ok: true, reply, think: '' }, origin);
  }
  if (route === 'news' && method === 'GET') {
    const date = url.searchParams.get('date') || '';
    if (date && !validDate(date)) return bad(res, 400, 'invalid_date', origin);
    return ok(res, await readNews(date), origin);
  }
  if (route === 'news' && method === 'POST') {
    const data = await bodyJson(req); const date = String(data.date || cnDate());
    if (!validDate(date)) return bad(res, 400, 'invalid_date', origin);
    await ensureDir(NEWS_DIR);
    await fsp.writeFile(path.join(NEWS_DIR, `日报-${date}.md`), String(data.text || '').slice(0, MAX_TEXT), { mode: 0o600 });
    return ok(res, await readNews(date), origin);
  }
  if (route === 'health' && method === 'POST') {
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-health-token'] || req.headers['x-dwell-health-token'];
    if (supplied !== state.healthToken) return bad(res, 401, 'invalid_health_token', origin);
    const raw = await bodyJson(req);
    state.health = normalizeHealth(raw);
    await persistAll();
    return ok(res, { ok: true, at: state.health.at }, origin);
  }
  if (route === 'watch' && method === 'GET') return ok(res, healthView(), origin);
  if (route === 'watchkey' && method === 'GET') return ok(res, { ok: true, url: `http://${req.headers.host || '127.0.0.1:' + PORT}/api/health`, token: state.healthToken }, origin);
  if (route === 'pushkey' && method === 'GET') return ok(res, { ok: true, key: vapidPublicKey() }, origin);
  if (route === 'subscribe' && method === 'POST') { const data = await bodyJson(req); subscriptions = subscriptions.filter(x => x.endpoint !== data.endpoint); subscriptions.push({ endpoint: data.endpoint, keys: data.keys || {}, at: now() }); await persistAll(); return ok(res, { ok: true }, origin); }
  if (route === 'push' && method === 'POST') { const data = await bodyJson(req); return ok(res, { ok: true, ...(await pushToSubscribers(String(data.title || 'dwell'), String(data.body || '他在这里。'))) }, origin); }
  if (route === 'notifications' && method === 'GET') {
    const since = Math.max(Number(url.searchParams.get('since') || 0), 0);
    await syncNotificationFeed();
    const page = database.listNotificationsAfter({ since, limit: 30, order: 'desc' });
    return ok(res, {
      ok: true, notification_epoch: database.notificationEpoch(), next: page.latest,
      items: page.items.reverse().map(item => notificationEnvelope(item, auth?.deviceId || '')),
    }, origin);
  }
  if (route === 'wake' && method === 'GET') return ok(res, wakeView(), origin);
  if (route === 'wake' && method === 'POST') { const data = await bodyJson(req); state.wakeOn = !!data.on; await persistAll(); return ok(res, wakeView(), origin); }
  if (route === 'rewake' && method === 'POST') { await startTurn('【重新唤醒】你刚才可能卡住了。恢复上下文后只说一句你现在在做什么。', [], { silent: true }); return ok(res, { ok: true }, origin); }
  if (route === 'authmode' && method === 'GET') return ok(res, { ok: true, mode: apiAuth.mode || 'subscription', base: apiAuth.base || '官方直连', models: apiAuth.models || {} }, origin);
  if (route === 'apiconf' && method === 'POST') {
    const data = await bodyJson(req);
    if (data.clear) {
      apiAuth = { mode: 'subscription', base: '', models: {} };
      state.model = 'default';
    } else {
      const base = String(data.base || '').trim().replace(/\/+$/, '');
      const model = String(data.model_opus || '').trim();
      let parsed;
      try { parsed = new URL(base); } catch { return bad(res, 400, 'invalid_api_base', origin); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return bad(res, 400, 'invalid_api_base', origin);
      if (!model) return bad(res, 400, 'missing_api_model', origin);
      apiAuth = {
        mode: 'api',
        base: base.slice(0, 300),
        token: String(data.token || apiAuth.token || '').slice(0, 500),
        models: { model_opus: model.slice(0, 200) },
      };
      state.model = apiAuth.models.model_opus;
    }
    state.sessionId = null;
    const chat = activeChatRecord();
    if (chat) chat.sessionId = null;
    await persistAll();
    return ok(res, { ok: true, mode: apiAuth.mode, base: apiAuth.base, model: modelView() }, origin);
  }
  if (route === 'apitest' && method === 'POST') {
    const data = await bodyJson(req); const base = String(data.base || '').trim();
    let parsed; try { parsed = new URL(base); } catch { return ok(res, { ok: false, code: 'invalid_url', detail: '接口地址不是有效的 http(s) URL', url: base }, origin); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return ok(res, { ok: false, code: 'invalid_url', detail: '接口地址只支持 http 或 https', url: base }, origin);
    const sameProvider = base.replace(/\/+$/, '') === String(apiAuth.base || '').replace(/\/+$/, '');
    const model = String(data.model_opus || (sameProvider ? apiAuth.models?.model_opus : '') || '').trim();
    if (!model) return ok(res, { ok: false, code: 'missing_model', detail: '请填写这个接口使用的准确模型 ID', url: base }, origin);
    const request = providerRequest(base, '只回复 OK', [], false, model);
    const target = request.endpoint;
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: providerHeaders(request.kind, data.token || (sameProvider ? apiAuth.token : '') || '', false),
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(15000),
      });
      const raw = await response.text(); let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
      const reply = providerResponseText(request.kind, parsed).trim();
      return ok(res, { ok: response.ok && !!reply, model: parsed.model || request.body.model || '', reply: reply.slice(0, 120), url: target, code: String(response.status), detail: response.ok && reply ? '' : raw.slice(0, 500) }, origin);
    } catch (error) { return ok(res, { ok: false, url: target, code: 'network', detail: error.message }, origin); }
  }
  if (route.startsWith('nook')) { const result = await handleNook(method, parts, req); return ok(res, result, origin); }
  if (route === 'repo/log' && method === 'GET') return ok(res, await repoLog(url), origin);
  if (route === 'repo/show' && method === 'GET') { const h = String(url.searchParams.get('h') || ''); if (!/^[0-9a-f]{7,40}$/i.test(h)) throw new Error('invalid commit'); const diff = (await git(['show', '--format=', '--no-ext-diff', '--unified=3', h])).stdout; return ok(res, { ok: true, diff: diff.slice(0, 800_000) }, origin); }
  if (route === 'repo/tree' && method === 'GET') return ok(res, await repoTree(url.searchParams.get('p') || ''), origin);
  if (route === 'repo/file' && method === 'GET') return ok(res, await repoFile(url.searchParams.get('p') || ''), origin);
  if (route === 'music' && method === 'GET') return ok(res, await musicInfo(url.searchParams.get('id') || ''), origin);
  if (route === 'upload' && method === 'POST') {
    const name = path.basename(String(url.searchParams.get('name') || 'upload.bin')).slice(0, 180);
    const idx = Number(url.searchParams.get('idx') || 0);
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_UPLOAD_CHUNKS) return bad(res, 413, 'upload_too_large', origin);
    const done = url.searchParams.get('done') === '1';
    const uploadId = String(url.searchParams.get('uid') || name).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    const dir = path.join(UPLOAD_DIR, `.parts-${crypto.createHash('sha256').update(uploadId || name).digest('hex').slice(0, 20)}`);
    await ensureDir(dir);
    const part = await bodyBuffer(req, MAX_UPLOAD_CHUNK);
    await fsp.writeFile(path.join(dir, `${idx}.part`), part, { mode: 0o600 });
    if (done) {
      const pieces = (await fsp.readdir(dir)).filter(x => /^\d+\.part$/.test(x)).sort((a, b) => Number(a) - Number(b));
      if (pieces.length !== idx + 1 || pieces.some((piece, i) => Number(piece.replace('.part', '')) !== i)) throw new Error('upload chunks incomplete');
      const total = (await Promise.all(pieces.map(piece => fsp.stat(path.join(dir, piece))))).reduce((sum, stat) => sum + stat.size, 0);
      if (total > MAX_UPLOAD_CHUNK * MAX_UPLOAD_CHUNKS) { await fsp.rm(dir, { recursive: true, force: true }); return bad(res, 413, 'upload_too_large', origin); }
      const target = path.join(UPLOAD_DIR, `${crypto.randomUUID()}-${name}`);
      await fsp.writeFile(target, '', { mode: 0o600 });
      try {
        for (const piece of pieces) await fsp.appendFile(target, await fsp.readFile(path.join(dir, piece)));
      } catch (error) {
        await fsp.rm(target, { force: true });
        throw error;
      }
      await fsp.rm(dir, { recursive: true, force: true });
      return ok(res, { ok: true, name, path: path.basename(target) }, origin);
    }
    return ok(res, { ok: true, idx }, origin);
  }
  if (route === 'file' && method === 'GET') {
    const name = path.basename(String(url.searchParams.get('name') || ''));
    if (!name) return bad(res, 404, 'not_found', origin);
    const file = safePath(UPLOAD_DIR, name); const stat = await fsp.stat(file); if (!stat.isFile()) throw new Error('not found');
    const stream = fs.createReadStream(file); res.writeHead(200, { ...headers(origin), 'Content-Type': contentType(file), 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }); stream.pipe(res); return;
  }
  return bad(res, 404, 'not_found', origin);
}

async function serveStatic(req, res, url, origin) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return bad(res, 405, 'method_not_allowed', origin);
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\//, ''));
  let file;
  try { file = safePath(WEB_ROOT, rel); } catch { return bad(res, 400, 'invalid_path', origin); }
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not file');
    res.writeHead(200, { ...headers(origin), 'Content-Type': contentType(file), 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch { bad(res, 404, 'not_found', origin); }
}

async function handle(req, res) {
  const origin = req.headers.origin || '';
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, headers(origin)); return res.end(); }
  const independentHealthUpload = req.method === 'POST' && url.pathname.replace(/\/$/, '') === '/api/health';
  try {
    if (url.pathname.startsWith('/api/v2/')) {
      const publicV2 = new Set(['/api/v2/health', '/api/v2/pair']);
      const auth = authenticate(req);
      if (!publicV2.has(url.pathname.replace(/\/$/, '')) && url.pathname.replace(/\/$/, '') !== '/api/v2/pairing/code' && !auth) {
        return bad(res, 401, 'device_pairing_required', origin);
      }
      return await handleApiV2(req, res, url, origin, auth);
    }
    const legacyAuth = url.pathname.startsWith('/api/') && !independentHealthUpload
      ? authenticate(req, { allowOpenLegacy: true })
      : null;
    if (url.pathname.startsWith('/api/') && !independentHealthUpload && !legacyAuth) {
      return bad(res, 401, 'unauthorized', origin);
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, origin, legacyAuth);
    return await serveStatic(req, res, url, origin);
  } catch (error) {
    console.error('[dwell]', req.method, url.pathname, error.message);
    const status = error.message === 'invalid json' ? 400 : error.message === 'request too large' ? 413 : 500;
    return bad(res, status, status === 413 ? 'request_too_large' : 'server_error', origin, error.message);
  }
}

await load();
await fcmDispatcher.start();
const wakeTimer = setInterval(() => { wakeTick().catch(error => console.error('[dwell] wake:', error.message)); }, 90 * 1000);
wakeTimer.unref();
const notificationTimer = setInterval(() => {
  syncNotificationFeed().catch(error => console.error('[dwell] notifications:', error.message));
}, 45 * 1000);
notificationTimer.unref();
server = http.createServer((req, res) => { handle(req, res).catch(error => { console.error('[dwell] unhandled:', error); if (!res.headersSent) bad(res, 500, 'server_error', req.headers.origin || ''); }); });
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 30 * 1000;
server.listen(PORT, HOST, () => {
  console.log(`[dwell] http://${HOST}:${PORT}`);
  console.log(`[dwell] workspace: ${WORKSPACE}`);
  console.log(`[dwell] Claude Code: ${CLAUDE_BIN}`);
  if (AUTH_TOKEN) console.log('[dwell] request auth: enabled');
});

async function shutdown(signal) {
  console.log(`[dwell] ${signal}, stopping`);
  clearInterval(wakeTimer);
  clearInterval(notificationTimer);
  for (const client of sseClients) {
    try { client.res.end(); } catch {}
  }
  sseClients.clear();
  stopRun();
  await persistQueue;
  try { await fcmDispatcher?.stop(); } catch (error) { console.error('[dwell] fcm dispatcher stop:', error.message); }
  try { await fcmSender.close(); } catch (error) { console.error('[dwell] fcm sender close:', error.message); }
  try { database?.close(); } catch (error) { console.error('[dwell] sqlite close:', error.message); }
  server?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
