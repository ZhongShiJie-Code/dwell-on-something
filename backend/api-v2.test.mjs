import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function jsonRequest(base, route, init = {}) {
  const response = await fetch(base + route, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  return { response, data };
}

async function waitForServer(base, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`backend exited with ${child.exitCode}`);
    try {
      const { response } = await jsonRequest(base, '/api/v2/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('backend did not become healthy');
}

test('v2 pairing, cached history, feedback, chat actions, model and mutation replay', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dwell-v2-test-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ activeChatId: 'main', armed: false, model: 'default', effort: 'high' }));
  await fsp.writeFile(path.join(dataDir, 'chats.json'), JSON.stringify([
    { id: 'main', name: '测试会话', created: 100, last: 102, preview: '原始回答', current: true, archived: false },
  ]));
  await fsp.writeFile(path.join(dataDir, 'messages.jsonl'), [
    { seq: 1, at: 101, chatId: 'main', kind: 'me', text: '原始问题' },
    { seq: 2, at: 102, chatId: 'main', kind: 'gu', text: '原始回答', replyTo: 1, version: 1 },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(here, 'server.mjs')], {
    cwd: here,
    env: {
      ...process.env,
      HOME: root,
      PATH: '/usr/bin:/bin',
      DWELL_HOST: '127.0.0.1',
      DWELL_PORT: String(port),
      DWELL_DATA_DIR: dataDir,
      DWELL_WORKSPACE: root,
      DWELL_CLAUDE_BIN: '/usr/bin/false',
      DWELL_TASK_STATE_DIR: path.join(root, 'task-runs'),
      DWELL_CLAUDE_TASKS_FILE: path.join(root, 'tasks.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

  await waitForServer(base, child);
  const codeResult = await jsonRequest(base, '/api/v2/pairing/code', { method: 'POST', body: '{}' });
  assert.equal(codeResult.response.status, 200, stderr);
  assert.match(codeResult.data.code, /^\d{6}$/);
  const pairResult = await jsonRequest(base, '/api/v2/pair', {
    method: 'POST', body: JSON.stringify({ code: codeResult.data.code, name: 'Android test' }),
  });
  assert.equal(pairResult.response.status, 200, stderr);
  const token = pairResult.data.token;
  assert.ok(token);
  const headers = { Authorization: `DwellDevice ${token}` };

  const bootstrap = await jsonRequest(base, '/api/v2/bootstrap', { headers });
  assert.equal(bootstrap.data.version, '0.6.0');
  assert.equal(bootstrap.data.messages.items.length, 2);
  assert.equal(bootstrap.data.messages.items[1].text, '原始回答');

  const feedback = await jsonRequest(base, '/api/v2/message-feedback', {
    method: 'POST', headers, body: JSON.stringify({ message_id: 2, value: 'up' }),
  });
  assert.equal(feedback.data.value, 'up');
  const messages = await jsonRequest(base, '/api/v2/chats/main/messages', { headers });
  assert.equal(messages.data.items.find(item => item.seq === 2).feedback, 'up');

  const archived = await jsonRequest(base, '/api/v2/chats/main', {
    method: 'POST', headers, body: JSON.stringify({ action: 'archive' }),
  });
  assert.equal(archived.data.items.find(item => item.id === 'main').archived, true);
  const restored = await jsonRequest(base, '/api/v2/chats/main', {
    method: 'POST', headers, body: JSON.stringify({ action: 'restore' }),
  });
  assert.equal(restored.data.items.find(item => item.id === 'main').archived, false);

  const selected = await jsonRequest(base, '/api/v2/model', {
    method: 'POST', headers, body: JSON.stringify({ model: 'sonnet', effort: 'medium' }),
  });
  assert.equal(selected.data.model, 'sonnet');
  assert.equal(selected.data.effort, 'medium');

  const mutation = 'android:test-replay-0001';
  const first = await jsonRequest(base, '/api/v2/chats/new', { method: 'POST', headers, body: JSON.stringify({ mutation_id: mutation }) });
  const replay = await jsonRequest(base, '/api/v2/chats/new', { method: 'POST', headers, body: JSON.stringify({ mutation_id: mutation }) });
  assert.notEqual(first.data.replayed, true);
  assert.equal(replay.data.replayed, true);
});
