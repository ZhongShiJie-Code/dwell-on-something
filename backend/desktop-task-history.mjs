import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const profileRoot = path.resolve(process.env.DWELL_CLAUDE_PROFILE || path.join(os.homedir(), 'Library/Application Support/Claude-3p'));
const explicitTaskFile = process.env.DWELL_CLAUDE_TASKS_FILE || '';
const stateDir = path.resolve(process.env.DWELL_TASK_STATE_DIR || path.join(os.homedir(), 'Library/Application Support/dwell/task-runs'));
const TASK_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RUN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;
const auditCache = new Map();

function iso(value) {
  if (!value) return null;
  const number = Number(value);
  const date = Number.isFinite(number)
    ? new Date(number < 10_000_000_000 ? number * 1000 : number)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clip(value, limit = 1200) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

async function firstTaskFile() {
  if (explicitTaskFile) return explicitTaskFile;
  const root = path.join(profileRoot, 'local-agent-mode-sessions');
  let sessions = [];
  try { sessions = await fsp.readdir(root, { withFileTypes: true }); } catch { return ''; }
  for (const session of sessions.filter(item => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const candidate = path.join(root, session.name, '00000000', 'scheduled-tasks.json');
    try { if ((await fsp.stat(candidate)).isFile()) return candidate; } catch {}
  }
  return '';
}

function outputLabel(file, root) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') ? relative : path.basename(file);
}

async function outputFiles(root) {
  const files = [];
  async function walk(dir, depth = 0) {
    if (depth > 2 || files.length >= 40) return;
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= 40) break;
      if (entry.name.startsWith('.')) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target, depth + 1);
      else if (entry.isFile()) {
        let stat;
        try { stat = await fsp.stat(target); } catch { continue; }
        files.push({ name: outputLabel(target, root), size: stat.size, updatedAt: stat.mtime.toISOString() });
      }
    }
  }
  await walk(root);
  return files;
}

function toolDetail(part) {
  const input = part?.input && typeof part.input === 'object' ? part.input : {};
  const candidate = input.script_path || input.file_path || input.path || input.command || input.query || input.url || input.subject || '';
  return clip(candidate || JSON.stringify(input), 500);
}

async function parseDesktopAudit(sessionDir, metadata, includeSteps) {
  const auditFile = path.join(sessionDir, 'audit.jsonl');
  let stat;
  try { stat = await fsp.stat(auditFile); } catch {
    return {
      startedAt: iso(metadata.createdAt), completedAt: null, status: 'unknown', summary: '',
      steps: [], outputs: await outputFiles(path.join(sessionDir, 'outputs')),
    };
  }
  const cacheKey = `${stat.size}:${stat.mtimeMs}:${includeSteps ? 'detail' : 'summary'}`;
  const cached = auditCache.get(auditFile);
  if (cached?.key === cacheKey) return cached.value;

  let text = '';
  try { text = await fsp.readFile(auditFile, 'utf8'); } catch {}
  let startedAt = iso(metadata.createdAt);
  let completedAt = null;
  let status = 'running';
  let summary = '';
  const steps = [];
  const toolSteps = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = iso(row.timestamp || row._audit_timestamp);
    startedAt ||= at;
    const content = Array.isArray(row.message?.content) ? row.message.content : [];
    if (row.type === 'assistant') {
      for (const part of content) {
        if (part?.type === 'text' && part.text) {
          summary = clip(part.text, 2400);
          if (includeSteps) steps.push({ type: 'message', title: '运行说明', detail: clip(part.text), at, status: 'done' });
        } else if (part?.type === 'thinking' && part.thinking && includeSteps) {
          steps.push({ type: 'thinking', title: '思考', detail: clip(part.thinking, 900), at, status: 'done' });
        } else if (part?.type === 'tool_use' && part.name && includeSteps) {
          const step = { type: 'tool', title: String(part.name).replace(/^mcp__host-scheduled-tasks__/, ''), detail: toolDetail(part), at, status: 'running', toolId: part.id || '' };
          steps.push(step);
          if (part.id) toolSteps.set(part.id, step);
        }
      }
    } else if (row.type === 'user' && includeSteps) {
      for (const part of content) {
        if (part?.type !== 'tool_result') continue;
        const step = toolSteps.get(part.tool_use_id);
        if (!step) continue;
        step.status = part.is_error ? 'failed' : 'done';
        if (part.is_error) step.detail = [step.detail, clip(typeof part.content === 'string' ? part.content : JSON.stringify(part.content), 700)].filter(Boolean).join('\n');
      }
    } else if (row.type === 'result') {
      completedAt = at || completedAt;
      status = row.is_error || row.subtype === 'error' ? 'failed' : 'success';
      if (row.result) summary = clip(row.result, 2400);
    }
  }
  if (!completedAt && stat.mtimeMs < Date.now() - 30 * 60 * 1000) status = 'interrupted';
  if (status === 'success') {
    for (const step of steps) if (step.status === 'running') step.status = 'done';
  }
  const value = {
    startedAt, completedAt, status, summary,
    steps: includeSteps ? steps.slice(-120) : [],
    outputs: await outputFiles(path.join(sessionDir, 'outputs')),
  };
  auditCache.set(auditFile, { key: cacheKey, value });
  return value;
}

function normalizeDwellRun(taskId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startedAt = iso(raw.startedAt || raw.queuedAt);
  if (!startedAt) return null;
  const runId = RUN_RE.test(String(raw.runId || ''))
    ? String(raw.runId)
    : `mobile_legacy_${Date.parse(startedAt) || 0}`;
  let status = ['queued', 'running', 'success', 'failed', 'interrupted'].includes(raw.status) ? raw.status : (raw.result || 'unknown');
  if (['queued', 'running'].includes(status) && Number(raw.pid) > 0) {
    try { process.kill(Number(raw.pid), 0); } catch { status = 'interrupted'; }
  }
  const events = Array.isArray(raw.events) ? raw.events.slice(-120) : [];
  const terminal = !['queued', 'running'].includes(status);
  return {
    id: runId,
    taskId,
    source: 'dwell-mobile',
    sourceLabel: '手机运行',
    startedAt,
    completedAt: iso(raw.completedAt),
    status,
    summary: clip(raw.summary || raw.error || (status === 'interrupted' ? '这次运行已经中断' : ''), 2400),
    steps: events.map((item, index) => ({
      type: item.type || 'event', title: String(item.title || '运行进度'), detail: clip(item.detail || '', 1200),
      at: iso(item.at), status: item.status === 'running' && (terminal || index < events.length - 1) ? 'done' : (item.status || 'done'),
    })),
    outputs: Array.isArray(raw.outputs) ? raw.outputs.slice(0, 40).map(item => typeof item === 'string' ? { name: path.basename(item), path: item } : item) : [],
  };
}

async function dwellRuns(taskId) {
  const byId = new Map();
  const historyDir = path.join(stateDir, 'history', taskId);
  let entries = [];
  try { entries = await fsp.readdir(historyDir, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const run = normalizeDwellRun(taskId, await readJson(path.join(historyDir, entry.name)));
    if (run) byId.set(run.id, run);
  }
  const latest = normalizeDwellRun(taskId, await readJson(path.join(stateDir, `${taskId}.json`)));
  if (latest) byId.set(latest.id, latest);
  return [...byId.values()];
}

async function resolveDesktopSessionDir(root, sessionId) {
  const normalized = String(sessionId || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(normalized)) return path.join(root, '__missing__');
  const shortId = normalized.replace(/^local_/, '').slice(0, 8);
  for (const candidate of [...new Set([normalized, shortId].filter(Boolean))]) {
    const candidateDir = path.join(root, candidate);
    try {
      if ((await fsp.stat(candidateDir)).isDirectory()) return candidateDir;
    } catch {}
  }
  return path.join(root, normalized);
}

async function desktopRuns(taskId, includeSteps) {
  const taskFile = await firstTaskFile();
  if (!taskFile) return [];
  const root = path.dirname(taskFile);
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^local_[0-9a-f-]+\.json$/i.test(entry.name)) continue;
    const metadata = await readJson(path.join(root, entry.name));
    if (String(metadata?.scheduledTaskId || '') !== taskId) continue;
    const sessionId = String(metadata.sessionId || entry.name.slice(0, -5));
    const sessionDir = await resolveDesktopSessionDir(root, sessionId);
    const audit = await parseDesktopAudit(sessionDir, metadata, includeSteps);
    runs.push({
      id: `desktop_${sessionId.replace(/^local_/, '')}`,
      taskId,
      source: 'claude-desktop',
      sourceLabel: 'Claude Desktop',
      sessionId,
      ...audit,
    });
  }
  return runs;
}

export async function listTaskRuns(taskId, options = {}) {
  if (!TASK_RE.test(String(taskId || ''))) return [];
  const includeSteps = !!options.includeSteps;
  const runs = [...await dwellRuns(taskId), ...await desktopRuns(taskId, includeSteps)];
  return runs.sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
}

export async function taskRunDetail(taskId, runId) {
  if (!TASK_RE.test(String(taskId || '')) || !RUN_RE.test(String(runId || ''))) return null;
  const runs = await listTaskRuns(taskId, { includeSteps: true });
  return runs.find(run => run.id === runId) || null;
}

export async function recentCompletedTaskRuns(taskIds, limit = 120) {
  const all = [];
  for (const taskId of taskIds.filter(id => TASK_RE.test(String(id || '')))) {
    for (const run of await listTaskRuns(String(taskId))) {
      if (run.completedAt && ['success', 'failed', 'interrupted'].includes(run.status)) all.push(run);
    }
  }
  return all.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt)).slice(0, limit);
}
