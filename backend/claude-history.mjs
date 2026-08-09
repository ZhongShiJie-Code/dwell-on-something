import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const claudeRoot = path.resolve(process.env.DWELL_CLAUDE_HISTORY_ROOT || path.join(os.homedir(), '.claude'));
const historyFile = path.join(claudeRoot, 'history.jsonl');
const projectsRoot = path.join(claudeRoot, 'projects');
const EXTERNAL_PREFIX = 'claude:';
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let fileCache = { at: 0, files: new Map() };
const jsonlCache = new Map();

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function usefulPrompt(value) {
  const text = cleanText(value);
  if (!text || text.startsWith('/') || text.startsWith('<command-') || text.startsWith('<local-command-')) return '';
  return text;
}

function unixSeconds(value, fallback = 0) {
  if (typeof value === 'number') return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback;
}

async function readJsonl(file) {
  try {
    const stat = await fsp.stat(file);
    const key = `${stat.size}:${stat.mtimeMs}`;
    const cached = jsonlCache.get(file);
    if (cached?.key === key) return cached.rows;
    const text = await fsp.readFile(file, 'utf8');
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
    jsonlCache.set(file, { key, rows });
    if (jsonlCache.size > 180) jsonlCache.delete(jsonlCache.keys().next().value);
    return rows;
  } catch { return []; }
}

async function indexedSessionFiles() {
  const current = Date.now();
  if (current - fileCache.at < 5000) return fileCache.files;
  const files = new Map();
  let dirs = [];
  try { dirs = await fsp.readdir(projectsRoot, { withFileTypes: true }); } catch {}
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let names = [];
    try { names = await fsp.readdir(path.join(projectsRoot, dir.name), { withFileTypes: true }); } catch { continue; }
    for (const item of names) {
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
      const sessionId = item.name.slice(0, -6);
      if (!SESSION_RE.test(sessionId)) continue;
      files.set(sessionId, path.join(projectsRoot, dir.name, item.name));
    }
  }
  fileCache = { at: current, files };
  return files;
}

function contentParts(message) {
  const content = message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function userText(row) {
  if (row?.isMeta || row?.isReplay) return '';
  const text = contentParts(row?.message)
    .filter(part => part?.type === 'text')
    .map(part => part.text || '')
    .join('\n');
  return usefulPrompt(text);
}

function assistantRecords(row) {
  const out = [];
  contentParts(row?.message).forEach((part, index) => {
    if (part?.type === 'text' && cleanText(part.text)) {
      out.push({ key: `${row.uuid || row.timestamp || 'assistant'}:${index}`, kind: 'gu', text: String(part.text).trim() });
    } else if (part?.type === 'thinking' && cleanText(part.thinking)) {
      out.push({ key: `${row.uuid || row.timestamp || 'thinking'}:${index}`, kind: 'think', text: String(part.thinking).trim() });
    } else if (part?.type === 'tool_use' && part.name) {
      out.push({ key: `${row.uuid || row.timestamp || 'tool'}:${index}`, kind: 'tool', text: String(part.name), extra: '{}' });
    }
  });
  return out;
}

async function historyGroups(files) {
  const rows = await readJsonl(historyFile);
  const groups = new Map();
  for (const row of rows) {
    const sessionId = String(row.sessionId || '');
    if (!SESSION_RE.test(sessionId) || !files.has(sessionId)) continue;
    const prompt = usefulPrompt(row.display);
    const stamp = unixSeconds(row.timestamp);
    const group = groups.get(sessionId) || {
      sessionId, project: String(row.project || ''), created: stamp, last: stamp,
      first: '', preview: '',
    };
    if (stamp) {
      group.created = group.created ? Math.min(group.created, stamp) : stamp;
      group.last = Math.max(group.last || 0, stamp);
    }
    if (prompt) {
      group.first ||= prompt;
      group.preview = prompt;
    }
    if (row.project) group.project = String(row.project);
    groups.set(sessionId, group);
  }
  return groups;
}

async function sessionMeta(sessionId, file, history = null) {
  const rows = await readJsonl(file);
  let cwd = history?.project || '';
  let title = '';
  let preview = history?.preview || '';
  let created = history?.created || 0;
  let last = history?.last || 0;
  let visibleCount = 0;
  for (const row of rows) {
    cwd ||= String(row.cwd || '');
    const stamp = unixSeconds(row.timestamp);
    if (stamp) {
      created = created ? Math.min(created, stamp) : stamp;
      last = Math.max(last, stamp);
    }
    if (row.type === 'custom-title') title = cleanText(row.customTitle || row.title || row.name) || title;
    if (row.type === 'user') {
      const text = userText(row);
      if (text) { title ||= text; preview = text; visibleCount += 1; }
    }
    if (row.type === 'assistant') {
      const text = assistantRecords(row).filter(item => item.kind === 'gu').map(item => item.text).join(' ');
      if (text) { preview = cleanText(text); visibleCount += 1; }
    }
  }
  title ||= history?.first || preview || path.basename(cwd || 'Claude Code');
  return {
    id: `${EXTERNAL_PREFIX}${sessionId}`,
    sessionId,
    name: cleanText(title).slice(0, 80) || 'Claude Code 会话',
    preview: cleanText(preview).slice(0, 160),
    created: created || last || Math.floor(Date.now() / 1000),
    last: last || created || Math.floor(Date.now() / 1000),
    cwd,
    source: 'claude-code',
    sourceLabel: 'Mac',
    archived: false,
    current: false,
    readOnly: false,
    visibleCount,
  };
}

export async function listClaudeCodeChats(existingSessionIds = []) {
  const files = await indexedSessionFiles();
  const groups = await historyGroups(files);
  const existing = new Set(existingSessionIds.filter(Boolean).map(String));
  const candidates = [...groups.values()]
    .filter(item => !existing.has(item.sessionId))
    .sort((a, b) => Number(b.last || 0) - Number(a.last || 0))
    .slice(0, 120);
  const items = [];
  for (const candidate of candidates) {
    const file = files.get(candidate.sessionId);
    if (!file) continue;
    const meta = await sessionMeta(candidate.sessionId, file, candidate);
    if (meta.visibleCount) items.push(meta);
  }
  return items;
}

export async function loadClaudeCodeChat(externalId) {
  const value = String(externalId || '');
  const sessionId = value.startsWith(EXTERNAL_PREFIX) ? value.slice(EXTERNAL_PREFIX.length) : value;
  if (!SESSION_RE.test(sessionId)) return null;
  const files = await indexedSessionFiles();
  const file = files.get(sessionId);
  if (!file) return null;
  const groups = await historyGroups(files);
  const meta = await sessionMeta(sessionId, file, groups.get(sessionId));
  const rows = await readJsonl(file);
  const seen = new Set();
  const records = [];
  for (const row of rows) {
    if (row.type === 'user') {
      const text = userText(row);
      const key = `${row.uuid || row.timestamp || 'user'}:0`;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      records.push({ sourceUuid: key, at: unixSeconds(row.timestamp, meta.created), kind: 'me', text });
    } else if (row.type === 'assistant') {
      for (const record of assistantRecords(row)) {
        if (seen.has(record.key)) continue;
        seen.add(record.key);
        records.push({ sourceUuid: record.key, at: unixSeconds(row.timestamp, meta.created), kind: record.kind, text: record.text, ...(record.extra ? { extra: record.extra } : {}) });
      }
    }
  }
  records.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  return { ...meta, messages: records.slice(-1200) };
}
