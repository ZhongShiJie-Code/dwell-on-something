import assert from 'node:assert/strict';
import http from 'node:http';

const base = String(process.env.DWELL_SMOKE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const token = process.env.DWELL_SMOKE_TOKEN || '';

async function call(route, options = {}, expected = 200) {
  const headers = { ...(options.headers || {}) };
  if (token) headers['X-Dwell-Token'] = token;
  const response = await fetch(`${base}/api/${route}`, { ...options, headers });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`${route}: non-JSON response ${raw.slice(0, 200)}`); }
  assert.equal(response.status, expected, `${route}: HTTP ${response.status} ${raw.slice(0, 300)}`);
  return data;
}

const json = (body, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const health = await call('health');
assert.equal(health.ok, true);
assert.equal(health.version, '0.4.1');

const status = await call('status');
assert.equal(status.alive, true);
assert.equal(status.version, '0.4.1');

const context = await call('context');
assert.equal(context.ok, true);
assert.equal(typeof context.pct, 'number');
assert.equal(typeof context.window, 'number');

const usage = await call('usage');
assert.equal(usage.ok, true);
assert.ok(Array.isArray(usage.sections));

const projects = await call('projects');
assert.ok(projects.items?.some(item => item.current && item.path));
const connectors = await call('connectors');
assert.ok(connectors.items?.some(item => item.name === 'Claude Code CLI'));

let access = await call('tool-access');
assert.ok(access.items.includes('Ask'));
access = await call('tool-access', json({ mode: 'Ask' }));
assert.equal(access.mode, 'Ask');
await call('tool-access', json({ mode: 'Auto' }));

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let todos = await call('todos', json({ action: 'add', list: 'mine', text: `smoke-${stamp}` }));
const todo = todos.mine.find(item => item.text === `smoke-${stamp}`);
assert.ok(todo?.id);
todos = await call('todos', json({ action: 'toggle', list: 'mine', id: todo.id }));
assert.equal(todos.mine.find(item => item.id === todo.id)?.done, true);
todos = await call('todos', json({ action: 'del', list: 'mine', id: todo.id }));
assert.equal(todos.mine.some(item => item.id === todo.id), false);

const date = new Date().toISOString().slice(0, 10);
let cal = await call('cal', json({ action: 'add_event', date, text: `smoke-${stamp}`, time: '09:30' }));
const event = cal.cal.events.find(item => item.text === `smoke-${stamp}`);
assert.ok(event?.id);
cal = await call('cal', json({ action: 'day_record', date, mood: '平静', note: 'smoke' }));
assert.equal(cal.cal.period.days[date].mood, '平静');
await call('cal', json({ action: 'del_event', id: event.id }));

const wall = await call('wall?lite=1');
assert.equal(wall.ok, true);
assert.ok(Array.isArray(wall.bricks));
const watch = await call('watch');
assert.equal(watch.ok, true);
assert.equal(typeof watch.connected, 'boolean');
const watchKey = await call('watchkey');
const rejectedHealth = await call('health', json({ device: 'wrong-token' }), 401);
assert.equal(rejectedHealth.error, 'invalid_health_token');
const healthUpload = await fetch(watchKey.url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${watchKey.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ device: 'smoke-watch', steps: 4321, sleep_hours: 7.2 }),
});
assert.equal(healthUpload.status, 200);
const updatedWatch = await call('watch');
assert.equal(updatedWatch.connected, true);
assert.equal(updatedWatch.device, 'smoke-watch');
assert.equal(updatedWatch.metrics.steps.value, 4321);
await call('favlines', json({ text: `# smoke\n\n${stamp}` }));
const favlines = await call('favlines');
assert.match(favlines.text, new RegExp(stamp));

let notes = await call('notes', json({ action: 'add', who: 'her', text: `note-${stamp}` }));
const paper = notes.her.find(item => item.text === `note-${stamp}`);
assert.ok(paper?.id);
notes = await call('notes', json({ action: 'box', who: 'her', id: paper.id }));
assert.equal(notes.her.find(item => item.id === paper.id)?.boxed, true);
notes = await call('notes', json({ action: 'del', who: 'her', id: paper.id }));
assert.equal(notes.her.some(item => item.id === paper.id), false);

const whisperBefore = await call('whisper');
const whisperAfter = await call('whisper', json({ text: `whisper-${stamp}` }));
assert.equal(whisperAfter.items.length, whisperBefore.items.length + 1);
assert.equal(whisperAfter.items.at(-1)?.text, `whisper-${stamp}`);

let diary = await call('herdiary', json({ action: 'add', text: `diary-${stamp}` }));
const diaryItem = diary.items.find(item => item.text === `diary-${stamp}`);
assert.ok(diaryItem?.id);
const foundDiary = await call(`find?q=${encodeURIComponent(`diary-${stamp}`)}`);
assert.ok(foundDiary.hits.some(item => item.snippet === `diary-${stamp}`));
diary = await call('herdiary', json({ action: 'del', id: diaryItem.id }));
assert.equal(diary.items.some(item => item.id === diaryItem.id), false);

const newsDate = '2099-12-31';
const invalidNews = await call('news', json({ date: '../bad', text: 'bad' }), 400);
assert.equal(invalidNews.error, 'invalid_date');
const news = await call('news', json({ date: newsDate, text: `# news\n\n${stamp}` }));
assert.equal(news.date, newsDate);
assert.match(news.text, new RegExp(stamp));
assert.equal((await call(`news?date=${newsDate}`)).date, newsDate);

assert.equal((await call('wake', json({ on: true }))).on, true);
assert.equal((await call('wake', json({ on: false }))).on, false);
assert.equal((await call('nook/progress', json({ slug: '__proto__', ch: 1 }))).error, 'invalid_slug');
assert.equal((await call('push', json({ title: 'smoke', body: stamp }))).sent, 0);

const invalidApi = await call('apiconf', json({ base: 'not-a-url' }), 400);
assert.equal(invalidApi.ok, false);
const invalidTest = await call('apitest', json({ base: 'not-a-url' }));
assert.equal(invalidTest.ok, false);
const missingModel = await call('apiconf', json({ base: 'http://127.0.0.1:1', token: 'x' }), 400);
assert.equal(missingModel.error, 'missing_api_model');

const providerCalls = [];
const mockProvider = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  providerCalls.push({ url: req.url, headers: req.headers, body });
  if (req.url === '/v1/messages') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 2, output_tokens: 1 } }));
    return;
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    return;
  }
  const lastContent = JSON.stringify(body.messages?.at(-1)?.content || '');
  const slow = lastContent.includes('slow-first');
  const timeout = lastContent.includes('timeout-provider');
  if (timeout) await new Promise(resolve => setTimeout(resolve, 1200));
  if (slow) await new Promise(resolve => setTimeout(resolve, 280));
  const answer = slow ? ['old ', 'reply'] : ['mock ', 'reply'];
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer[0] } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer[1] } }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => mockProvider.listen(0, '127.0.0.1', resolve));
const mockAddress = mockProvider.address();
const mockBase = `http://127.0.0.1:${mockAddress.port}`;
try {
  const openAiTest = await call('apitest', json({ base: mockBase, token: 'test-openai', model_opus: 'mock-model' }));
  assert.equal(openAiTest.ok, true);
  assert.equal(openAiTest.reply, 'OK');
  const anthropicTest = await call('apitest', json({ base: `${mockBase}/v1/messages`, token: 'test-anthropic', model_opus: 'mock-anthropic' }));
  assert.equal(anthropicTest.ok, true);
  assert.equal(anthropicTest.reply, 'OK');
  const anthropicCall = providerCalls.find(item => item.url === '/v1/messages');
  assert.equal(anthropicCall.headers['x-api-key'], 'test-anthropic');
  assert.equal(anthropicCall.headers['anthropic-version'], '2023-06-01');

  const configured = await call('apiconf', json({ base: mockBase, token: 'test-openai', model_opus: 'mock-model' }));
  assert.equal(configured.mode, 'api');
  const beforeProviderPoll = await call('poll?since=0&wait=0');
  const providerText = `provider-${stamp}`;
  await call('send', json({
    text: providerText,
    web_search: true,
    attachments: [{ kind: 'image', name: 'pixel.png', media_type: 'image/png', data: 'iVBORw0KGgo=' }],
  }));
  await new Promise(resolve => setTimeout(resolve, 160));
  const providerPoll = await call(`poll?since=${beforeProviderPoll.next}&wait=0`);
  const providerResult = providerPoll.events.find(item => item.type === 'result' && item.result === 'mock reply');
  assert.ok(providerResult);
  assert.ok(providerResult.notification_id > 0);
  const providerMessages = await call('messages?limit=400');
  assert.ok(providerMessages.msgs.some(item => item.kind === 'gu' && item.text === 'mock reply'));
  const streamed = providerCalls.find(item => item.body?.stream === true);
  assert.ok(Array.isArray(streamed?.body?.messages?.[0]?.content));
  assert.ok(streamed.body.messages[0].content.some(item => item.type === 'image_url'));
  assert.match(JSON.stringify(streamed.body), /用户已开启 Web search/);

  const beforeReplacement = await call('messages?limit=400');
  const mockRepliesBefore = beforeReplacement.msgs.filter(item => item.kind === 'gu' && item.text === 'mock reply').length;
  await call('send', json({ text: `slow-first-${stamp}` }));
  await new Promise(resolve => setTimeout(resolve, 25));
  await call('send', json({ text: `replacement-${stamp}` }));
  await new Promise(resolve => setTimeout(resolve, 380));
  const afterReplacement = await call('messages?limit=400');
  assert.equal(afterReplacement.msgs.some(item => item.kind === 'gu' && item.text === 'old reply'), false);
  assert.equal(afterReplacement.msgs.filter(item => item.kind === 'gu' && item.text === 'mock reply').length, mockRepliesBefore + 1);
  const replacementCall = [...providerCalls].reverse().find(item => JSON.stringify(item.body).includes(`replacement-${stamp}`));
  const replacementContext = JSON.stringify(replacementCall?.body?.messages || []);
  assert.ok(replacementContext.includes(providerText));
  assert.ok(replacementContext.includes('mock reply'));
  assert.equal((await call('status')).busy, false);

  const beforeStopPoll = await call('poll?since=0&wait=0');
  await call('send', json({ text: `slow-first-manual-stop-${stamp}` }));
  await new Promise(resolve => setTimeout(resolve, 25));
  const stopped = await call('stop', json({}));
  assert.equal(stopped.stopped, true);
  await new Promise(resolve => setTimeout(resolve, 340));
  const afterStopPoll = await call(`poll?since=${beforeStopPoll.next}&wait=0`);
  assert.ok(afterStopPoll.events.some(item => item.type === 'system' && item.subtype === 'stopped'));
  assert.equal((await call('messages?limit=400')).msgs.some(item => item.kind === 'gu' && item.text === 'old reply'), false);
  assert.equal((await call('status')).busy, false);

  if (process.env.DWELL_SMOKE_EXPECT_TIMEOUT === '1') {
    const beforeTimeoutPoll = await call('poll?since=0&wait=0');
    await call('send', json({ text: `timeout-provider-${stamp}` }));
    await new Promise(resolve => setTimeout(resolve, 750));
    const afterTimeoutPoll = await call(`poll?since=${beforeTimeoutPoll.next}&wait=0`);
    assert.ok(afterTimeoutPoll.events.some(item => item.type === 'result' && item.is_error && item.result === '备用 API 请求超时'));
    assert.equal((await call('status')).busy, false);
  }

  const beforeSwitch = (await call('chats?scope=live')).items.find(item => item.current);
  await call('newchat', json({ arm: true }));
  const cancelledText = `slow-first-switch-${stamp}`;
  await call('send', json({ text: cancelledText }));
  const runningChat = (await call('chats?scope=live')).items.find(item => item.current);
  assert.ok(runningChat?.id && runningChat.id !== beforeSwitch.id);
  await new Promise(resolve => setTimeout(resolve, 25));
  await call('chats', json({ action: 'switch', id: beforeSwitch.id }));
  await new Promise(resolve => setTimeout(resolve, 340));
  assert.equal((await call('status')).busy, false);
  let switchedMessages = await call('messages?limit=400');
  assert.equal(switchedMessages.msgs.some(item => item.text === cancelledText), false);
  await call('chats', json({ action: 'switch', id: runningChat.id }));
  switchedMessages = await call('messages?limit=400');
  assert.ok(switchedMessages.msgs.some(item => item.kind === 'me' && item.text === cancelledText));
  assert.equal(switchedMessages.msgs.some(item => item.kind === 'gu' && item.text === 'old reply'), false);
  await call('chats', json({ action: 'switch', id: beforeSwitch.id }));
} finally {
  await call('apiconf', json({ clear: true }));
  await new Promise(resolve => mockProvider.close(resolve));
}

const uploadId = `smoke-${stamp}`;
const oversizedUpload = await call(`upload?name=too-big.bin&uid=${encodeURIComponent(uploadId)}&idx=32&done=0`, { method: 'POST', body: Buffer.from('x') }, 413);
assert.equal(oversizedUpload.error, 'upload_too_large');
await call(`upload?name=smoke.txt&uid=${encodeURIComponent(uploadId)}&idx=0&done=0`, { method: 'POST', body: Buffer.from('hello ') });
const uploaded = await call(`upload?name=smoke.txt&uid=${encodeURIComponent(uploadId)}&idx=1&done=1`, { method: 'POST', body: Buffer.from('dwell') });
assert.ok(uploaded.path);
const fileResponse = await fetch(`${base}/api/file?name=${encodeURIComponent(uploaded.path)}`, { headers: token ? { 'X-Dwell-Token': token } : {} });
assert.equal(fileResponse.status, 200);
assert.equal(await fileResponse.text(), 'hello dwell');

const beforeChats = await call('chats?scope=live');
const original = beforeChats.items.find(item => item.current);
assert.ok(original?.id);
const renamed = await call('chats', json({ action: 'rename', id: original.id, name: `chat-${stamp}` }));
assert.equal(renamed.items.find(item => item.id === original.id)?.name, `chat-${stamp}`);
await call('newchat', json({ arm: true }));
const isolatedText = `isolated-${stamp}`;
await call('send', json({ text: isolatedText, web_search: true }));
await new Promise(resolve => setTimeout(resolve, 120));
const afterChats = await call('chats?scope=live');
const created = afterChats.items.find(item => item.current);
assert.ok(created?.id && created.id !== original.id);
let currentMessages = await call('messages?limit=400');
assert.ok(currentMessages.msgs.some(item => item.kind === 'me' && item.text === isolatedText));
await call('chats', json({ action: 'switch', id: original.id }));
currentMessages = await call('messages?limit=400');
assert.equal(currentMessages.msgs.some(item => item.text === isolatedText), false);
await call('chats', json({ action: 'switch', id: created.id }));
currentMessages = await call('messages?limit=400');
assert.ok(currentMessages.msgs.some(item => item.text === isolatedText));
await call('chats', json({ action: 'archive', id: 'CURRENT', on: true }));
const afterArchive = await call('chats?scope=live');
assert.notEqual(afterArchive.items.find(item => item.current)?.id, created.id);
const archived = await call('chats?scope=box');
assert.ok(archived.items.some(item => item.id === created.id));
await call('chats', json({ action: 'archive', id: created.id, on: false }));

const poll = await call('poll?since=0&wait=0');
assert.equal(poll.ok, true);
assert.ok(Array.isArray(poll.events));
const notifications = await call('notifications?since=0');
assert.equal(notifications.ok, true);
assert.ok(Array.isArray(notifications.items));

const gong = await call('gong', json({ text: `smoke-${stamp}` }), 500);
assert.equal(gong.ok, false);

console.log(`dwell smoke passed: ${base}`);
