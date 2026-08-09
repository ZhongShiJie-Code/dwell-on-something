#!/usr/bin/env node

/*
 * dwell backend
 *
 * A dependency-free local service for the mobile/web client.  It deliberately
 * keeps the transport small: JSON/JSONL on disk, native fetch, and the
 * Claude Code CLI already installed on the Mac.  No credentials are bundled
 * in the repository.
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
const CLAUDE_BIN = process.env.DWELL_CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.DWELL_CLAUDE_TIMEOUT_MS || 15 * 60 * 1000);
const CLAUDE_BARE = process.env.DWELL_CLAUDE_BARE !== '0';
const PERMISSION_MODE = process.env.DWELL_PERMISSION_MODE || 'acceptEdits';
const AUTH_TOKEN = process.env.DWELL_AUTH_TOKEN || '';
const SERVER_VERSION = '0.4.0';
const MAX_BODY = 16 * 1024 * 1024;
const MAX_TEXT = 600_000;

const files = {
  state: path.join(DATA_DIR, 'state.json'),
  messages: path.join(DATA_DIR, 'messages.jsonl'),
  chats: path.join(DATA_DIR, 'chats.json'),
  notes: path.join(DATA_DIR, 'notes.json'),
  todos: path.join(DATA_DIR, 'todos.json'),
  calendar: path.join(DATA_DIR, 'calendar.json'),
  diary: path.join(DATA_DIR, 'diary.json'),
  whisper: path.join(DATA_DIR, 'whisper.json'),
  wall: path.join(DATA_DIR, 'wall.json'),
  nook: path.join(DATA_DIR, 'nook.json'),
  subscriptions: path.join(DATA_DIR, 'subscriptions.json'),
  apiAuth: path.join(DATA_DIR, 'api-auth.json'),
};

const defaultState = {
  model: 'claude-sonnet-5',
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
let persistQueue = Promise.resolve();
let nextSeq = 0;
let activeRun = null;
let server;
const events = [];
const EVENT_LIMIT = 5000;

function now() { return Math.floor(Date.now() / 1000); }
function id(prefix = 'id') { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return clone(fallback); }
}

async function readJsonl(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { return []; }
}

function cnDate(sec = now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000));
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
    const response = await fetch(`https://music.163.com/api/song/detail?ids=%5B${sid}%5D`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } });
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
  queuePersist(() => atomicJson(files.state, state));
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

async function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, file);
}

async function persistAll() {
  const snapshot = clone({
    state, chats, notes, todos, calendar, diary, whisper, wall, nook, subscriptions, apiAuth,
  });
  return queuePersist(async () => {
    await Promise.all([
      atomicJson(files.state, snapshot.state),
      atomicJson(files.chats, snapshot.chats),
      atomicJson(files.notes, snapshot.notes),
      atomicJson(files.todos, snapshot.todos),
      atomicJson(files.calendar, snapshot.calendar),
      atomicJson(files.diary, snapshot.diary),
      atomicJson(files.whisper, snapshot.whisper),
      atomicJson(files.wall, snapshot.wall),
      atomicJson(files.nook, snapshot.nook),
      atomicJson(files.subscriptions, snapshot.subscriptions),
      atomicJson(files.apiAuth, snapshot.apiAuth),
    ]);
  });
}

async function appendMessage(record) {
  const item = { seq: ++nextSeq, at: now(), ...record };
  messages.push(item);
  if (item.kind === 'me') state.lastUserAt = item.at;
  const line = JSON.stringify(item) + '\n';
  queuePersist(() => fsp.appendFile(files.messages, line, { mode: 0o600 }));
  return item;
}

function emit(event) {
  const item = { ...event, _cursor: ++nextSeq };
  events.push(item);
  if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
  return item;
}

function notifyWaiters() {
  for (const waiter of waiters.splice(0)) waiter();
}

const waiters = [];

async function load() {
  await Promise.all([ensureDir(UPLOAD_DIR), ensureDir(NEWS_DIR), ensureDir(BOOKS_DIR)]);
  state = { ...defaultState, ...(await readJson(files.state, {})) };
  state.health = { ...defaultState.health, ...(state.health || {}) };
  state.healthToken = state.healthToken || process.env.DWELL_HEALTH_TOKEN || crypto.randomBytes(18).toString('base64url');
  chats = await readJson(files.chats, []);
  notes = await readJson(files.notes, { gu: [], her: [] });
  todos = await readJson(files.todos, { mine: [], hers: [] });
  todos = { mine: todos.mine || [], hers: todos.hers || todos.yours || [] };
  calendar = await readJson(files.calendar, { events: [], period: { days: {} } });
  calendar.events ||= [];
  calendar.period ||= { days: {} };
  calendar.period.days ||= {};
  diary = await readJson(files.diary, []);
  whisper = await readJson(files.whisper, []);
  wall = await readJson(files.wall, []);
  nook = await readJson(files.nook, { books: [], progress: {}, annotations: {} });
  subscriptions = await readJson(files.subscriptions, []);
  apiAuth = await readJson(files.apiAuth, { mode: 'subscription', base: '', models: {} });
  messages = await readJsonl(files.messages);
  nextSeq = messages.reduce((n, item) => Math.max(n, Number(item.seq) || 0), 0);
  if (!chats.length) {
    chats = [{ id: 'main', name: 'ShiJie', created: now(), last: now(), preview: '', current: true, archived: false }];
  }
  if (!chats.some(chat => chat.id === state.activeChatId)) state.activeChatId = chats[0].id;
  chats = chats.map(chat => ({ ...chat, current: chat.id === state.activeChatId }));
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
  const allowed = process.env.DWELL_ALLOW_ORIGINS || '*';
  return {
    'Access-Control-Allow-Origin': allowed === '*' ? '*' : (origin && allowed.split(',').map(x => x.trim()).includes(origin) ? origin : allowed.split(',')[0]),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Dwell-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
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

function authorized(req) {
  if (!AUTH_TOKEN) return true;
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-dwell-token'];
  return token === AUTH_TOKEN;
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

function jsonFetch(url, options = {}) {
  return fetch(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
}

function modelForCli(model) {
  const value = String(model || '').replace(/\[1m\]$/, '').toLowerCase();
  if (value.includes('opus')) return 'opus';
  if (value.includes('haiku')) return 'haiku';
  if (value.includes('sonnet')) return 'sonnet';
  return undefined;
}

function attachmentPrompt(attachments = []) {
  const parts = [];
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'text' && item.text) {
      parts.push(`\n--- 附件 ${item.name || 'text'} ---\n${String(item.text).slice(0, 200_000)}\n--- 附件结束 ---`);
    } else if (item.kind === 'image' && item.name) {
      parts.push(`\n用户附了一张图片，文件名是 ${item.name}。如果需要，请读取后分析。`);
    } else if (item.path) {
      parts.push(`\n用户附了文件：${item.path}`);
    }
  }
  return parts.join('\n');
}

function cliArgs(prompt, firstTurn) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-mode', PERMISSION_MODE, '--add-dir', WORKSPACE];
  if (CLAUDE_BARE) args.push('--bare');
  const cliModel = modelForCli(state.model);
  if (cliModel) args.push('--model', cliModel);
  if (state.effort) args.push('--effort', state.effort);
  if (state.sessionId && !firstTurn) args.push('--resume', state.sessionId);
  else if (state.sessionId && firstTurn) args.push('--session-id', state.sessionId);
  return args;
}

function providerRequest(base, prompt) {
  const root = String(base || '').replace(/\/$/, '');
  const openRouter = /openrouter\.ai/i.test(root) || /chat\/completions/i.test(root);
  if (openRouter) {
    const endpoint = /chat\/completions$/i.test(root) ? root : `${root.replace(/\/v1$/, '')}/v1/chat/completions`;
    return { kind: 'openai', endpoint, body: { model: apiAuth.models?.model_opus || state.model, messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 4096 } };
  }
  const endpoint = /\/messages$/i.test(root) ? root : `${root}/messages`;
  return { kind: 'anthropic', endpoint, body: { model: apiAuth.models?.model_opus || state.model, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: prompt }] } };
}

async function runApiProvider(prompt, attachments, run) {
  const request = providerRequest(apiAuth.base, `${prompt || '请看看附件。'}${attachmentPrompt(attachments)}`);
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (apiAuth.token) {
    headers.Authorization = `Bearer ${apiAuth.token}`;
    if (request.kind === 'anthropic') headers['x-api-key'] = apiAuth.token;
  }
  const response = await fetch(request.endpoint, { method: 'POST', headers, body: JSON.stringify(request.body) });
  if (!response.ok) throw new Error(`${request.endpoint} · ${response.status} ${(await response.text()).slice(0, 500)}`);
  let buffer = '', text = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const feed = raw => {
    buffer += raw;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim(); if (!value || value === '[DONE]') continue;
      let data; try { data = JSON.parse(value); } catch { continue; }
      let delta = '';
      if (request.kind === 'anthropic') delta = data.delta?.text || '';
      else delta = data.choices?.[0]?.delta?.content || '';
      if (!delta) continue;
      text += delta;
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } });
      notifyWaiters();
    }
  };
  while (true) { const part = await reader.read(); if (part.done) break; feed(decoder.decode(part.value, { stream: true })); }
  feed(decoder.decode());
  if (text.trim()) {
    await appendMessage({ kind: 'gu', text: text.trim() });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: text.trim() }] } });
  }
  run.hadResult = true;
  emit({ type: 'result', is_error: false, result: text.trim() });
  notifyWaiters();
}

function ensureSessionId() {
  if (!state.sessionId) state.sessionId = crypto.randomUUID();
  return state.sessionId;
}

function messagePartsFromAssistant(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.map(part => {
    if (part.type === 'text') return { kind: 'gu', text: String(part.text || '') };
    if (part.type === 'thinking') return { kind: 'think', text: String(part.thinking || '') };
    if (part.type === 'tool_use') return { kind: 'tool', text: String(part.name || 'Tool'), extra: JSON.stringify(part.input || {}) };
    return null;
  }).filter(item => item && (item.text || item.kind === 'tool'));
}

async function runClaude(prompt, attachments, run) {
  const firstTurn = !state.sessionId;
  ensureSessionId();
  const fullPrompt = `${prompt || '请看看附件。'}${attachmentPrompt(attachments)}`;
  const child = spawn(CLAUDE_BIN, cliArgs(fullPrompt, firstTurn), {
    cwd: WORKSPACE,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run.child = child;
  run.started = Date.now();
  const stderr = [];
  child.stderr.on('data', chunk => {
    const text = String(chunk);
    if (stderr.join('').length < 12_000) stderr.push(text);
  });

  let finalText = '';
  let finalThinking = '';
  let sawAssistant = false;
  const lines = readline.createInterface({ input: child.stdout });
  let lineQueue = Promise.resolve();
  const processLine = async line => {
    if (!line.trim()) return;
    let data;
    try { data = JSON.parse(line); } catch { return; }
    if (data.type === 'system' && data.subtype === 'init' && data.session_id) {
      state.sessionId = data.session_id;
      queuePersist(() => atomicJson(files.state, state));
    }
    if (data.type === 'result') run.hadResult = true;
    if (data.type === 'result' && typeof data.result === 'string' && data.result.trim()) finalText = data.result.trim();
    if (data.type === 'stream_event') {
      const delta = data.event?.delta || {};
      if (delta.type === 'text_delta') finalText += String(delta.text || '');
      if (delta.type === 'thinking_delta') finalThinking += String(delta.thinking || '');
    }
    if (data.type === 'assistant') {
      sawAssistant = true;
      for (const part of messagePartsFromAssistant(data.message)) {
        if (part.kind === 'think' && part.text) await appendMessage(part);
        if (part.kind === 'gu' && part.text) await appendMessage(part);
        if (part.kind === 'tool') await appendMessage(part);
      }
    }
    emit(data);
    notifyWaiters();
  };
  lines.on('line', line => { lineQueue = lineQueue.then(() => processLine(line)); });

  const timeout = setTimeout(() => {
    if (!child.killed) child.kill('SIGTERM');
    setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000).unref();
  }, CLAUDE_TIMEOUT_MS);

  await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timeout);
  await lineQueue;
  lines.close();
  if (!sawAssistant && finalText.trim()) await appendMessage({ kind: 'gu', text: finalText.trim() });
  if (!sawAssistant && finalThinking.trim()) await appendMessage({ kind: 'think', text: finalThinking.trim() });
  if (run.silent && finalText.trim() && !run.stopped) await pushToSubscribers('dwell', finalText.slice(0, 240));
  if (child.exitCode !== 0 && !run.stopped) {
    const detail = stderr.join('').trim() || `claude exited with code ${child.exitCode}`;
    run.hadResult = true;
    emit({ type: 'result', is_error: true, result: detail.slice(-4000) });
    notifyWaiters();
  }
}

function stopRun() {
  if (!activeRun?.child) return false;
  activeRun.stopped = true;
  activeRun.child.kill('SIGTERM');
  setTimeout(() => { if (activeRun?.child && !activeRun.child.killed) activeRun.child.kill('SIGKILL'); }, 2000).unref();
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
  if (activeRun) stopRun();
  if (state.armed) {
    state.armed = false;
    state.sessionId = null;
    state.activeChatId = id('chat');
    chats = chats.map(chat => ({ ...chat, current: false }));
    chats.unshift({ id: state.activeChatId, name: 'ShiJie', created: now(), last: now(), preview: '', current: true, archived: false });
    emit({ type: 'system', subtype: 'newchat', text: '（新窗口开好了）' });
  }
  const userText = String(text || '').trim();
  if (!options.silent) {
    await appendMessage({ kind: 'me', text: userText || '（附件）' });
    emit({ type: 'echo', text: userText || '（附件）' });
  }
  const chat = chats.find(item => item.id === state.activeChatId);
  if (chat) { chat.last = now(); chat.preview = userText || '（附件）'; }
  state.busy = true;
  await persistAll();
  const run = { child: null, stopped: false, silent: !!options.silent, started: Date.now() };
  activeRun = run;
  const runner = apiAuth.mode === 'api' && apiAuth.base ? runApiProvider : runClaude;
  runner(userText, attachments, run).catch(error => {
    emit({ type: 'result', is_error: true, result: error.message || 'Claude Code 没有启动' });
    notifyWaiters();
  }).finally(async () => {
    if (activeRun === run) activeRun = null;
    state.busy = false;
    const current = chats.find(item => item.id === state.activeChatId);
    if (current) current.last = now();
    await persistAll();
    if (!run.hadResult) { emit({ type: 'result', is_error: false, result: '' }); notifyWaiters(); }
  });
}

function chatItems(scope) {
  return chats
    .filter(chat => scope === 'box' ? chat.archived : !chat.archived)
    .map(chat => ({ ...chat, current: chat.id === state.activeChatId }));
}

function currentMessages(before, limit) {
  const sorted = messages.slice().sort((a, b) => a.seq - b.seq);
  const filtered = before ? sorted.filter(item => item.seq < before) : sorted;
  const msgs = filtered.slice(-limit);
  return { msgs, more: filtered.length > msgs.length, upto: messages.reduce((n, item) => Math.max(n, item.seq), 0) };
}

async function git(args) {
  return execFileAsync('git', args, { cwd: WORKSPACE, maxBuffer: 8 * 1024 * 1024, timeout: 10000 });
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
  const dir = safePath(WORKSPACE, rel);
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
  const file = safePath(WORKSPACE, rel);
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
    const data = await bodyJson(req); nook.progress[data.slug || ''] = { ch: Number(data.ch) || 0, page: Number(data.page) || 0, mode: Number(data.mode) || 0, at: now() }; await persistAll(); return nook.progress;
  }
  if (parts[1] === 'chapter' && method === 'GET') {
    const slug = decodeURIComponent(parts[2] || ''); const index = Number(parts[3] || 0);
    const books = await loadBookIndex();
    const book = books.find(item => item.slug === slug);
    const chapters = nook._content?.[slug] || [];
    if (!book || !chapters[index]) return { error: 'not_found' };
    return { book: book.title, title: chapters[index].title || `第 ${index + 1} 节`, text: chapters[index].text || '', index, total: chapters.length, chapters: chapters.map(item => item.title || '') };
  }
  if (parts[1] === 'annotations') {
    const slug = decodeURIComponent(parts[2] || ''); const ch = Number(parts[3] || 0); const key = `${slug}/${ch}`;
    if (method === 'GET') return nook.annotations[key] || [];
    if (method === 'POST' && parts[4] && parts[5] === 'reply') { const item = (nook.annotations[key] || []).find(x => x.id === parts[4]); if (!item) throw new Error('not found'); const data = await bodyJson(req); (item.replies ||= []).push({ id: id('reply'), text: String(data.text || '').slice(0, 2000), who: data.who || 'user', ts: new Date().toLocaleString('zh-CN') }); await persistAll(); return item; }
    if (method === 'POST') { const data = await bodyJson(req); const item = { id: id('anno'), anchor: String(data.anchor || '').slice(0, 280), note: String(data.note || '').slice(0, 2000), who: data.who || 'user', ts: new Date().toLocaleString('zh-CN'), replies: [], at: now() }; (nook.annotations[key] ||= []).push(item); await persistAll(); return item; }
  }
  return { ok: false, error: 'not_found' };
}

async function handleApi(req, res, url, origin) {
  const method = req.method || 'GET';
  const pathname = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const parts = pathname.split('/').filter(Boolean);
  const route = parts.join('/');

  if (method === 'GET' && route === 'health') return ok(res, { ok: true, service: 'dwell', version: SERVER_VERSION, alive: true }, origin);
  if (method === 'GET' && route === 'status') return ok(res, { ok: true, alive: true, backend: 'claude-code', version: SERVER_VERSION, since: state.startedAt, busy: !!activeRun || !!state.busy, armed: !!state.armed, wake: wakeView(), workspace: WORKSPACE, claude: CLAUDE_BIN }, origin);
  if (route === 'messages' && method === 'GET') return ok(res, currentMessages(url.searchParams.get('before') ? Number(url.searchParams.get('before')) : 0, Math.min(Number(url.searchParams.get('limit') || 400), 400)), origin);
  if (route === 'said' && method === 'GET') return ok(res, currentMessages('', Math.min(Number(url.searchParams.get('limit') || 400), 400)), origin);
  if (route === 'poll' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const get = () => events.filter(item => item._cursor > since).map(({ _cursor, ...event }) => event);
    let fresh = get();
    if (!fresh.length && url.searchParams.get('wait') !== '0') {
      await new Promise(resolve => { const timer = setTimeout(resolve, 25000); waiters.push(() => { clearTimeout(timer); resolve(); }); });
      fresh = get();
    }
    return ok(res, { ok: true, next: nextSeq, ver: SERVER_VERSION, events: fresh }, origin);
  }
  if (route === 'send' && method === 'POST') { const data = await bodyJson(req); await startTurn(data.text, data.attachments || []); return ok(res, { ok: true }, origin); }
  if (route === 'stop' && method === 'POST') { const stopped = stopRun(); return ok(res, { ok: true, stopped }, origin); }
  if (route === 'model' && method === 'GET') return ok(res, { ok: true, model: state.model, effort: state.effort }, origin);
  if (route === 'model' && method === 'POST') { const data = await bodyJson(req); if (data.model) state.model = String(data.model).slice(0, 100); if (data.effort) state.effort = String(data.effort); state.sessionId = null; await persistAll(); return ok(res, { ok: true, model: state.model, effort: state.effort }, origin); }
  if (route === 'context' && method === 'GET') { const used = Math.round(JSON.stringify(messages).length / 4); return ok(res, { ok: true, used, max: 200000 }, origin); }
  if (route === 'usage' && method === 'GET') return ok(res, { ok: true, items: [] }, origin);
  if (route === 'projects' && method === 'GET') return ok(res, { ok: true, items: [] }, origin);
  if (route === 'tool-access' && method === 'GET') return ok(res, { ok: true, mode: state.toolAccess || 'Auto' }, origin);
  if (route === 'connectors' && method === 'GET') return ok(res, { ok: true, items: [] }, origin);
  if (route === 'newchat' && method === 'POST') { const data = await bodyJson(req); state.armed = !!data.arm; if (!state.armed) state.sessionId = null; await persistAll(); return ok(res, { ok: true, armed: state.armed }, origin); }
  if (route === 'chats' && method === 'GET') return ok(res, { ok: true, items: chatItems(url.searchParams.get('scope') || 'live') }, origin);
  if (route === 'chats' && method === 'POST') {
    const data = await bodyJson(req); const target = data.id === 'CURRENT' ? state.activeChatId : data.id; const chat = chats.find(item => item.id === target);
    if (data.action === 'rename' && chat) chat.name = String(data.name || '').slice(0, 80);
    if (data.action === 'archive' && chat) chat.archived = !!data.on;
    if (data.action === 'switch' && chat && !chat.archived) { state.activeChatId = chat.id; state.sessionId = null; chats = chats.map(item => ({ ...item, current: item.id === chat.id })); }
    await persistAll(); return ok(res, { ok: true, items: chatItems('live') }, origin);
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
  if (route === 'favlines' && method === 'GET') return ok(res, { ok: true, text: '' }, origin);
  if (route === 'wall' && method === 'GET') { const bricks = await loadStoryBricks(); return ok(res, { ok: true, bricks: bricks.length ? bricks : wall }, origin); }
  if (route === 'dreams' && method === 'GET') return ok(res, { items: await readJson(path.join(DATA_DIR, 'dreams.json'), []) }, origin);
  if (route === 'night' && method === 'GET') return ok(res, { days: await readNight() }, origin);
  if (route === 'gong' && method === 'GET') return ok(res, { msgs: [] }, origin);
  if (route === 'gong' && method === 'POST') { const data = await bodyJson(req); return ok(res, { ok: true, reply: '另一间房还没有接入助手。', think: '' }, origin); }
  if (route === 'news' && method === 'GET') return ok(res, await readNews(url.searchParams.get('date') || ''), origin);
  if (route === 'news' && method === 'POST') { const data = await bodyJson(req); const date = data.date || cnDate(); await ensureDir(NEWS_DIR); await fsp.writeFile(path.join(NEWS_DIR, `日报-${date}.md`), String(data.text || ''), { mode: 0o600 }); return ok(res, await readNews(date), origin); }
  if (route === 'health' && method === 'POST') {
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-health-token'] || req.headers['x-dwell-health-token'];
    if (supplied !== state.healthToken) return bad(res, 401, 'invalid_health_token', origin);
    const raw = await bodyJson(req);
    state.health = normalizeHealth(raw);
    await persistAll();
    return ok(res, { ok: true, at: state.health.at }, origin);
  }
  if (route === 'health' && method === 'GET') return ok(res, healthView(), origin);
  if (route === 'watch' && method === 'GET') return ok(res, healthView(), origin);
  if (route === 'watchkey' && method === 'GET') return ok(res, { ok: true, url: `http://${req.headers.host || '127.0.0.1:' + PORT}/api/health`, token: state.healthToken }, origin);
  if (route === 'pushkey' && method === 'GET') return ok(res, { ok: true, key: vapidPublicKey() }, origin);
  if (route === 'subscribe' && method === 'POST') { const data = await bodyJson(req); subscriptions = subscriptions.filter(x => x.endpoint !== data.endpoint); subscriptions.push({ endpoint: data.endpoint, keys: data.keys || {}, at: now() }); await persistAll(); return ok(res, { ok: true }, origin); }
  if (route === 'push' && method === 'POST') { const data = await bodyJson(req); return ok(res, { ok: true, ...(await pushToSubscribers(String(data.title || 'dwell'), String(data.body || '他在这里。'))) }, origin); }
  if (route === 'wake' && method === 'GET') return ok(res, wakeView(), origin);
  if (route === 'wake' && method === 'POST') { const data = await bodyJson(req); state.wakeOn = !!data.on; await persistAll(); return ok(res, wakeView(), origin); }
  if (route === 'rewake' && method === 'POST') { await startTurn('【重新唤醒】你刚才可能卡住了。恢复上下文后只说一句你现在在做什么。', [], { silent: true }); return ok(res, { ok: true }, origin); }
  if (route === 'authmode' && method === 'GET') return ok(res, { ok: true, mode: apiAuth.mode || 'subscription', base: apiAuth.base || '官方直连', models: apiAuth.models || {} }, origin);
  if (route === 'apiconf' && method === 'POST') {
    const data = await bodyJson(req);
    if (data.clear) {
      apiAuth = { mode: 'subscription', base: '', models: {} };
    } else {
      apiAuth = {
        mode: 'api',
        base: String(data.base || '').slice(0, 300),
        token: String(data.token || apiAuth.token || '').slice(0, 500),
        models: { model_opus: String(data.model_opus || '').slice(0, 200) },
      };
    }
    await persistAll();
    return ok(res, { ok: true, mode: apiAuth.mode, base: apiAuth.base }, origin);
  }
  if (route === 'apitest' && method === 'POST') { const data = await bodyJson(req); const target = String(data.base || '').replace(/\/$/, '') + '/models'; try { const response = await jsonFetch(target, { headers: data.token ? { Authorization: `Bearer ${data.token}` } : {} }); return ok(res, { ok: response.ok, model: response.ok ? 'reachable' : '', url: target, code: String(response.status), detail: (await response.text()).slice(0, 500) }, origin); } catch (error) { return ok(res, { ok: false, url: target, code: 'network', detail: error.message }, origin); } }
  if (route.startsWith('nook')) { const result = await handleNook(method, parts, req); return ok(res, result, origin); }
  if (route === 'repo/log' && method === 'GET') return ok(res, await repoLog(url), origin);
  if (route === 'repo/show' && method === 'GET') { const h = String(url.searchParams.get('h') || ''); if (!/^[0-9a-f]{7,40}$/i.test(h)) throw new Error('invalid commit'); const diff = (await git(['show', '--format=', '--no-ext-diff', '--unified=3', h])).stdout; return ok(res, { ok: true, diff: diff.slice(0, 800_000) }, origin); }
  if (route === 'repo/tree' && method === 'GET') return ok(res, await repoTree(url.searchParams.get('p') || ''), origin);
  if (route === 'repo/file' && method === 'GET') return ok(res, await repoFile(url.searchParams.get('p') || ''), origin);
  if (route === 'music' && method === 'GET') return ok(res, await musicInfo(url.searchParams.get('id') || ''), origin);
  if (route === 'upload' && method === 'POST') {
    const name = path.basename(String(url.searchParams.get('name') || 'upload.bin')).slice(0, 180);
    const idx = Math.max(Number(url.searchParams.get('idx') || 0), 0);
    const done = url.searchParams.get('done') === '1';
    const dir = path.join(UPLOAD_DIR, crypto.createHash('sha256').update(name).digest('hex').slice(0, 16));
    await ensureDir(dir);
    const part = await bodyBuffer(req, 8 * 1024 * 1024);
    await fsp.writeFile(path.join(dir, `${idx}.part`), part, { mode: 0o600 });
    if (done) {
      const pieces = (await fsp.readdir(dir)).filter(x => /^\d+\.part$/.test(x)).sort((a, b) => Number(a) - Number(b));
      const target = path.join(UPLOAD_DIR, `${crypto.randomUUID()}-${name}`);
      const out = fs.createWriteStream(target, { mode: 0o600 });
      for (const piece of pieces) await new Promise((resolve, reject) => { const input = fs.createReadStream(path.join(dir, piece)); input.on('error', reject); input.on('end', resolve); input.pipe(out, { end: false }); });
      await new Promise(resolve => out.end(resolve));
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
  if (!authorized(req)) return bad(res, 401, 'unauthorized', origin);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, origin);
    return await serveStatic(req, res, url, origin);
  } catch (error) {
    console.error('[dwell]', req.method, url.pathname, error.message);
    return bad(res, error.message === 'invalid json' ? 400 : 500, 'server_error', origin, error.message);
  }
}

await load();
const wakeTimer = setInterval(() => { wakeTick().catch(error => console.error('[dwell] wake:', error.message)); }, 90 * 1000);
wakeTimer.unref();
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
  stopRun();
  await persistQueue;
  server?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
