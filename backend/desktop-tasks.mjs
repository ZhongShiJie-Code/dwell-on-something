import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const profileRoot = path.resolve(process.env.DWELL_CLAUDE_PROFILE || path.join(os.homedir(), 'Library/Application Support/Claude-3p'));
const explicitTaskFile = process.env.DWELL_CLAUDE_TASKS_FILE || '';
const controlBridge = process.env.DWELL_DESKTOP_TASKS_BRIDGE || '';
const taskStateDir = path.resolve(process.env.DWELL_TASK_STATE_DIR || path.join(os.homedir(), 'Library/Application Support/dwell/task-runs'));

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

function frontmatter(text, key) {
  const match = String(text || '').match(new RegExp('^' + key + '\\s*:\\s*(.+)$', 'mi'));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

async function descriptionFor(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return { name: frontmatter(text, 'name'), description: frontmatter(text, 'description') };
  } catch { return { name: '', description: '' }; }
}

function scheduleFor(task) {
  if (task.cronExpression) return task.cronExpression;
  if (task.fireAt) return `一次性 · ${task.fireAt}`;
  return '未设置周期';
}

async function readRaw() {
  const file = await firstTaskFile();
  if (!file) return { file: '', tasks: [] };
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return { file, tasks: Array.isArray(parsed) ? parsed : (Array.isArray(parsed.scheduledTasks) ? parsed.scheduledTasks : []) };
  } catch { return { file, tasks: [] }; }
}

async function runStateFor(taskId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(String(taskId || ''))) return {};
  try {
    const state = JSON.parse(await fsp.readFile(path.join(taskStateDir, `${taskId}.json`), 'utf8'));
    if (['queued', 'running'].includes(state.status) && Number(state.pid) > 0) {
      try { process.kill(Number(state.pid), 0); }
      catch { return { ...state, status: 'failed', result: 'failed', summary: '上次运行已中断' }; }
    }
    return state;
  }
  catch { return {}; }
}

export async function listDesktopTasks() {
  const raw = await readRaw();
  const items = [];
  for (const task of raw.tasks) {
    if (!task || !task.id) continue;
    const detail = await descriptionFor(task.filePath);
    const runState = await runStateFor(task.id);
    const running = ['queued', 'running'].includes(runState.status);
    items.push({
      id: String(task.id),
      name: detail.name || String(task.id),
      description: detail.description || 'Claude Desktop 定时任务',
      enabled: task.enabled !== false,
      schedule: scheduleFor(task),
      model: task.model || '',
      lastRunAt: runState.completedAt || runState.startedAt || task.lastRunAt || null,
      lastResult: running ? 'running' : (runState.result || task.lastResult || task.lastRunResult || 'unknown'),
      running,
      runSummary: runState.summary || runState.error || '',
    });
  }
  return {
    ok: true,
    source: raw.file ? 'claude-desktop' : 'unavailable',
    file: raw.file,
    control: controlBridge && fs.existsSync(controlBridge)
      ? { available: true, source: 'configured-bridge' }
      : { available: false, reason: 'desktop_control_unavailable' },
    items,
  };
}

export async function controlDesktopTask(action, taskId) {
  const view = await listDesktopTasks();
  const task = view.items.find(item => item.id === String(taskId));
  if (!task) return { ok: false, status: 404, error: 'task_not_found' };
  if (!controlBridge || !fs.existsSync(controlBridge)) return { ok: false, status: 503, error: 'desktop_control_unavailable' };
  try {
    const command = controlBridge.endsWith('.mjs') ? process.execPath : controlBridge;
    const args = controlBridge.endsWith('.mjs')
      ? [controlBridge, JSON.stringify({ action, task_id: task.id })]
      : [JSON.stringify({ action, task_id: task.id })];
    const { stdout } = await execFileAsync(command, args, {
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout || '{}');
    if (!result.ok) return { ok: false, status: 502, error: result.error || 'desktop_control_failed' };
    return { ...result, ok: true, action, task_id: task.id };
  } catch (error) {
    return { ok: false, status: 502, error: 'desktop_control_failed', detail: error.message };
  }
}
