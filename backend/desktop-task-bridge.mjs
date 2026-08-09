#!/usr/bin/env node

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const profileRoot = path.resolve(process.env.DWELL_CLAUDE_PROFILE || path.join(os.homedir(), 'Library/Application Support/Claude-3p'));
const explicitTaskFile = process.env.DWELL_CLAUDE_TASKS_FILE || '';
const stateDir = path.resolve(process.env.DWELL_TASK_STATE_DIR || path.join(os.homedir(), 'Library/Application Support/dwell/task-runs'));
const claudeBin = process.env.DWELL_CLAUDE_BIN || 'claude';
const hostTasksMcp = process.env.DWELL_HOST_TASKS_MCP || path.join(os.homedir(), '.claude/host-scheduled-tasks-mcp.mjs');
const nodeBin = process.env.DWELL_HOST_NODE_BIN || '/usr/local/bin/node';
const workerFile = fileURLToPath(import.meta.url);
const TASK_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

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

async function readTasks() {
  const file = await firstTaskFile();
  if (!file) throw new Error('tasks_file_not_found');
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  const tasks = Array.isArray(parsed) ? parsed : parsed.scheduledTasks;
  if (!Array.isArray(tasks)) throw new Error('tasks_file_invalid');
  return { file, parsed, tasks };
}

function stateFile(taskId) {
  if (!TASK_RE.test(taskId)) throw new Error('invalid_task_id');
  return path.join(stateDir, `${taskId}.json`);
}

async function writeState(taskId, data) {
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = stateFile(taskId);
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file);
}

async function readState(taskId) {
  try { return JSON.parse(await fsp.readFile(stateFile(taskId), 'utf8')); } catch { return {}; }
}

async function updateEnabled(taskId, enabled) {
  const raw = await readTasks();
  const task = raw.tasks.find(item => String(item?.id || '') === taskId);
  if (!task) throw new Error('task_not_found');
  if (task.enabled === enabled) return { changed: false, enabled };
  const stat = await fsp.stat(raw.file);
  const backup = `${raw.file}.dwell-backup`;
  await fsp.copyFile(raw.file, backup);
  await fsp.chmod(backup, stat.mode & 0o777);
  task.enabled = enabled;
  const temp = `${raw.file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(raw.parsed, null, 2)}\n`, { mode: stat.mode & 0o777 });
  await fsp.rename(temp, raw.file);
  return { changed: true, enabled, backup };
}

function existingDirectories(task) {
  const values = [
    task.filePath ? path.dirname(task.filePath) : '',
    ...(Array.isArray(task.userSelectedFolders) ? task.userSelectedFolders : []),
    ...(Array.isArray(task.userSelectedFiles) ? task.userSelectedFiles.map(file => path.dirname(file)) : []),
  ];
  return [...new Set(values.filter(value => value && path.isAbsolute(value) && fs.existsSync(value)))];
}

function promptValue(prompt, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = "^\\s*(?:[-*]\\s*)?[`\"']?" + escaped + "[`\"']?\\s*[:：]\\s*[`\"']?([^\\n`\"']+)";
  const match = String(prompt || '').match(new RegExp(pattern, 'mi'));
  return match ? match[1].trim().replace(/[，。；;,]+$/, '').trim() : '';
}

function toolText(result) {
  return result?.content?.map(item => item?.text || '').join('\n').trim() || '';
}

function jsonFromTool(result) {
  const value = toolText(result);
  try { return JSON.parse(value); } catch { return {}; }
}

function declaredHostScripts(prompt) {
  const text = String(prompt || '');
  const found = [];
  const add = value => {
    const clean = String(value || '').trim().replace(/[，。；;,]+$/, '');
    if (!clean || !path.isAbsolute(clean) || !/\.(?:mjs|js|py|sh)$/i.test(clean) || found.includes(clean)) return;
    found.push(clean);
  };
  for (const line of text.split(/\r?\n/)) {
    const explicit = line.match(/^\s*(?:[-*]\s*)?[`\"']?script_path[`\"']?\s*[:：]\s*[`\"']?([^\s`\"']+)/i);
    if (explicit) add(explicit[1]);
  }
  const absolute = /\/Users\/tom\/(?:\.hermes|Documents\/(?:Codex|Claude))\/[^\s`\"'<>|]+?\.(?:mjs|js|py|sh)\b/g;
  for (const match of text.matchAll(absolute)) add(match[0]);
  return found;
}

async function callHostTaskTool(name, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [hostTasksMcp], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let buffer = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      if (error) reject(error); else resolve(result);
    };
    child.stderr.on('data', chunk => { if (stderr.length < 64_000) stderr += String(chunk); });
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response.id !== 2) continue;
        if (response.error) return finish(new Error(response.error.message || 'host_task_failed'));
        if (response.result?.isError) {
          const detail = response.result?.content?.map(item => item?.text || '').join('\n');
          return finish(new Error(detail || 'host_task_failed'));
        }
        return finish(null, response.result || {});
      }
    });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (!settled) finish(new Error(stderr.trim() || `host_tasks_mcp_exited_${code}`));
    });
    timer = setTimeout(() => finish(new Error('host_task_timeout')), Math.min(Math.max(timeoutMs + 15_000, 30_000), 915_000));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dwell', version: '0.4.5' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}

async function runDirectHostTask(taskId, prompt) {
  const text = String(prompt || '');
  if (text.includes('mcp__host-scheduled-tasks__run_negative_review_report')) {
    const started = await callHostTaskTool('run_negative_review_report', {}, 30_000);
    const startDetail = jsonFromTool(started);
    const jobId = String(startDetail.job_id || '');
    if (!jobId) throw new Error(toolText(started).slice(-600) || 'negative_review_job_id_missing');
    const waited = await callHostTaskTool('wait_negative_review_report', { job_id: jobId }, 60_000);
    const detail = jsonFromTool(waited);
    return { summary: String(detail.summary || detail.status || detail.wait_status || toolText(waited) || `差评日报已启动：${jobId}`).slice(0, 600) };
  }
  if (text.includes('mcp__host-scheduled-tasks__run_negative_review_precheck')) {
    const result = await callHostTaskTool('run_negative_review_precheck', {}, 60_000);
    const detail = jsonFromTool(result);
    return { summary: String(detail.overall ? `登录态检查：${detail.overall}` : toolText(result) || '登录态检查已完成').slice(0, 600) };
  }
  if (!text.includes('mcp__host-scheduled-tasks__run_host_script')) return null;
  if (taskId === 'table-login-recovery') throw new Error('该任务需要先选择任务与平台，请在 Mac Claude 中指定后运行');
  const scriptPaths = declaredHostScripts(text).filter(file => fs.existsSync(file));
  if (!scriptPaths.length) return null;
  const explicitCwd = promptValue(text, 'cwd');
  const explicitTimeout = Number(promptValue(text, 'timeout_ms') || 0);
  const completed = [];
  for (const scriptPath of scriptPaths) {
    const isSharedWorkspace = scriptPath.includes('/.hermes/shared/workspace/scripts/');
    const cwd = explicitCwd && path.isAbsolute(explicitCwd)
      ? explicitCwd
      : isSharedWorkspace ? path.join(os.homedir(), '.hermes/shared/workspace') : path.dirname(scriptPath);
    const timeout = explicitTimeout || (/check|precheck/i.test(path.basename(scriptPath)) ? 300_000 : isSharedWorkspace ? 900_000 : 300_000);
    const result = await callHostTaskTool('run_host_script', {
      script_path: scriptPath,
      cwd,
      timeout_ms: Math.min(Math.max(timeout, 1000), 900000),
    }, timeout);
    const detail = jsonFromTool(result);
    if (detail.status && detail.status !== 'succeeded') throw new Error(toolText(result).slice(-600) || `${path.basename(scriptPath)}_failed`);
    completed.push(path.basename(scriptPath));
  }
  return { summary: completed.length === 1 ? `主机脚本已完成：${completed[0]}` : `已依次完成 ${completed.length} 个主机脚本` };
}

async function runWorker(taskId) {
  const raw = await readTasks();
  const task = raw.tasks.find(item => String(item?.id || '') === taskId);
  if (!task) throw new Error('task_not_found');
  if (!task.filePath || !fs.existsSync(task.filePath)) throw new Error('task_prompt_not_found');
  const prompt = await fsp.readFile(task.filePath, 'utf8');
  const startedAt = new Date().toISOString();
  await writeState(taskId, { taskId, status: 'running', pid: process.pid, startedAt, result: 'running' });

  const direct = await runDirectHostTask(taskId, prompt);
  if (direct) {
    await writeState(taskId, {
      taskId,
      status: 'success',
      result: 'success',
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: 0,
      summary: direct.summary,
    });
    return;
  }

  const mcpConfig = JSON.stringify({
    mcpServers: {
      'host-scheduled-tasks': { command: nodeBin, args: [hostTasksMcp] },
    },
  });
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--permission-mode', ['auto', 'acceptEdits', 'dontAsk', 'plan'].includes(task.permissionMode) ? task.permissionMode : 'dontAsk',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config', mcpConfig,
  ];
  if (task.model) args.push('--model', String(task.model));
  const allowed = (Array.isArray(task.approvedPermissions) ? task.approvedPermissions : [])
    .map(item => String(item?.toolName || '')).filter(Boolean);
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  for (const dir of existingDirectories(task)) args.push('--add-dir', dir);

  const child = spawn(claudeBin, args, {
    cwd: task.filePath ? path.dirname(task.filePath) : os.homedir(),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => { if (stdout.join('').length < 2_000_000) stdout.push(String(chunk)); });
  child.stderr.on('data', chunk => { if (stderr.join('').length < 128_000) stderr.push(String(chunk)); });
  const timeout = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
  }, Number(process.env.DWELL_TASK_TIMEOUT_MS || 15 * 60 * 1000));
  const exitCode = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timeout);
  const completedAt = new Date().toISOString();
  let summary = '';
  try {
    const result = JSON.parse(stdout.join('') || '{}');
    summary = String(result.result || '').trim().slice(0, 600);
  } catch { summary = stdout.join('').trim().slice(-600); }
  const error = stderr.join('').trim().slice(-1200);
  const success = exitCode === 0;
  await writeState(taskId, {
    taskId,
    status: success ? 'success' : 'failed',
    result: success ? 'success' : 'failed',
    startedAt,
    completedAt,
    exitCode,
    summary: summary || (success ? '任务已完成' : ''),
    ...(success || !error ? {} : { error }),
  });
}

async function queueRun(taskId) {
  const raw = await readTasks();
  if (!raw.tasks.some(item => String(item?.id || '') === taskId)) throw new Error('task_not_found');
  const current = await readState(taskId);
  if (['queued', 'running'].includes(current.status)) {
    try { process.kill(Number(current.pid), 0); return { queued: false, alreadyRunning: true }; } catch {}
  }
  await writeState(taskId, { taskId, status: 'queued', result: 'running', queuedAt: new Date().toISOString() });
  const child = spawn(process.execPath, [workerFile, '--worker', taskId], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  await writeState(taskId, { taskId, status: 'queued', result: 'running', queuedAt: new Date().toISOString(), pid: child.pid });
  return { queued: true, pid: child.pid };
}

async function main() {
  if (process.argv[2] === '--worker') {
    const taskId = String(process.argv[3] || '');
    try { await runWorker(taskId); } catch (error) {
      await writeState(taskId, { taskId, status: 'failed', result: 'failed', completedAt: new Date().toISOString(), error: String(error.message || error).slice(0, 1200) });
    }
    return;
  }
  let request;
  try { request = JSON.parse(process.argv[2] || '{}'); } catch { return print({ ok: false, error: 'invalid_request' }); }
  const action = String(request.action || '');
  const taskId = String(request.task_id || '');
  if (!TASK_RE.test(taskId) || !['run', 'pause', 'resume'].includes(action)) return print({ ok: false, error: 'invalid_action' });
  try {
    if (action === 'run') return print({ ok: true, action, task_id: taskId, ...(await queueRun(taskId)) });
    const changed = await updateEnabled(taskId, action === 'resume');
    return print({ ok: true, action, task_id: taskId, ...changed });
  } catch (error) {
    return print({ ok: false, error: String(error.message || error) });
  }
}

await main();
