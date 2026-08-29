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

async function readSseEvent(response, predicate, timeoutMs = 5000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const read = (async () => {
    while (true) {
      const part = await reader.read();
      if (part.done) throw new Error('SSE stream closed before the expected event');
      buffer += decoder.decode(part.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const eventType = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || '';
        const dataText = block.match(/^data:\s*(.+)$/m)?.[1] || '';
        if (!dataText) continue;
        let data;
        try { data = JSON.parse(dataText); } catch { continue; }
        if (predicate({ eventType, data })) return { eventType, data };
      }
    }
  })();
  read.catch(() => {});
  try {
    return await Promise.race([
      read,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for SSE event')), timeoutMs)),
    ]);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

test('v2 pairing, cached history, feedback, chat actions, model and mutation replay', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dwell-v2-test-'));
  const dataDir = path.join(root, 'data');
  const taskStateDir = path.join(root, 'task-runs');
  const taskFile = path.join(root, 'tasks.json');
  await fsp.mkdir(taskStateDir, { recursive: true });
  await fsp.writeFile(taskFile, JSON.stringify([{ id: 'task-sse', title: 'SSE test task', enabled: true }]));
  await fsp.writeFile(path.join(taskStateDir, 'task-sse.json'), JSON.stringify({
    runId: 'run-1', startedAt: '2026-08-24T00:00:00.000Z', completedAt: '2026-08-24T00:00:01.000Z', status: 'success', summary: 'first run',
  }));
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
      DWELL_CLAUDE_TASKS_FILE: taskFile,
      DWELL_FCM_ENABLED: '0',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      DWELL_FCM_PROJECT_ID: '',
      DWELL_FCM_ANDROID_APP_ID: '',
      DWELL_AUTH_TOKEN: '',
      DWELL_HEALTH_TOKEN: '',
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

  const preflight = await fetch(base + '/api/v2/devices/me/push-token', {
    method: 'OPTIONS',
    headers: { Origin: 'https://appassets.androidplatform.net', 'Access-Control-Request-Method': 'PUT' },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /PUT/);
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /DELETE/);

  const literalControlText = await jsonRequest(base, '/api/v2/devices/me/push-token', {
    method: 'PUT', headers, body: JSON.stringify({
      provider: 'fcm', token: '\\u0000-literal', package_name: 'com.xinwithyu.dwell',
      app_version: '0.6.1', firebase_app_id: '1:test:android:test',
    }),
  });
  assert.equal(literalControlText.response.status, 200, JSON.stringify(literalControlText.data));
  assert.equal(literalControlText.data.registered, true);

  const actualControl = await jsonRequest(base, '/api/v2/devices/me/push-token', {
    method: 'PUT', headers, body: JSON.stringify({
      provider: 'fcm', token: String.fromCharCode(0) + '-real', package_name: 'com.xinwithyu.dwell',
      app_version: '0.6.1', firebase_app_id: '1:test:android:test',
    }),
  });
  assert.equal(actualControl.response.status, 400);
  assert.equal(actualControl.data.error, 'invalid_push_token');

  const bootstrap = await jsonRequest(base, '/api/v2/bootstrap', { headers });
  assert.equal(bootstrap.data.version, '0.6.1');
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
  assert.equal(typeof selected.data.requested_model, 'string');
  assert.equal(typeof selected.data.pre_verification_model, 'string');
  assert.equal(typeof selected.data.observed_runtime_model, 'string');
  assert.equal(selected.data.route_status, 'unverified');

  const mutation = 'android:test-replay-0001';
  const first = await jsonRequest(base, '/api/v2/chats/new', { method: 'POST', headers, body: JSON.stringify({ mutation_id: mutation }) });
  const replay = await jsonRequest(base, '/api/v2/chats/new', { method: 'POST', headers, body: JSON.stringify({ mutation_id: mutation }) });
  assert.notEqual(first.data.replayed, true);
  assert.equal(replay.data.replayed, true);

  await jsonRequest(base, '/api/v2/chat/send', {
    method: 'POST', headers, body: JSON.stringify({ text: 'trigger replay notification' }),
  });
  const replayStream = await fetch(`${base}/api/v2/events?since=0`, { headers });
  const replayEvent = await readSseEvent(
    replayStream,
    item => item.eventType === 'notification.created' && item.data.data?.route === 'task/task-sse/run-1',
  );
  assert.equal(replayEvent.data.data.device_id, pairResult.data.device.id);

  const rawPoll = await jsonRequest(base, '/api/poll?since=0&wait=0', { headers });
  const rawNotification = rawPoll.data.events.find(item => item.type === 'notification');
  assert.ok(rawNotification);
  assert.equal(rawNotification.notification.device_id, '');
  const cursor = rawPoll.data.next;

  const secondCode = await jsonRequest(base, '/api/v2/pairing/code', { method: 'POST', body: '{}' });
  const secondPair = await jsonRequest(base, '/api/v2/pair', {
    method: 'POST', body: JSON.stringify({ code: secondCode.data.code, name: 'Second Android test' }),
  });
  const secondHeaders = { Authorization: `DwellDevice ${secondPair.data.token}` };
  const liveA = await fetch(`${base}/api/v2/events?since=${cursor}`, { headers });
  const liveB = await fetch(`${base}/api/v2/events?since=${cursor}`, { headers: secondHeaders });
  await fsp.writeFile(path.join(taskStateDir, 'task-sse.json'), JSON.stringify({
    runId: 'run-2', startedAt: '2026-08-24T00:01:00.000Z', completedAt: new Date().toISOString(), status: 'success', summary: 'second run',
  }));
  await jsonRequest(base, '/api/v2/chat/send', {
    method: 'POST', headers, body: JSON.stringify({ text: 'trigger live notification' }),
  });
  const [liveEventA, liveEventB] = await Promise.all([
    readSseEvent(liveA, item => item.eventType === 'notification.created' && item.data.data?.route === 'task/task-sse/run-2'),
    readSseEvent(liveB, item => item.eventType === 'notification.created' && item.data.data?.route === 'task/task-sse/run-2'),
  ]);
  assert.equal(liveEventA.data.data.device_id, pairResult.data.device.id);
  assert.equal(liveEventB.data.data.device_id, secondPair.data.device.id);
  assert.notEqual(liveEventA.data.data.device_id, liveEventB.data.data.device_id);
});
