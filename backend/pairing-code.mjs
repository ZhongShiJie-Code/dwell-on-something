#!/usr/bin/env node

const port = Number(process.env.DWELL_PORT || 8787);
const headers = { 'Content-Type': 'application/json' };
if (process.env.DWELL_AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.DWELL_AUTH_TOKEN}`;

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/v2/pairing/code`, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
  console.log(`\nDwell 配对码：${data.code}\n`);
  console.log('5 分钟内在手机上输入；使用一次后立即失效。');
} catch (error) {
  console.error(`无法生成配对码：${error.message}`);
  console.error(`请确认 Dwell 后端正在本机 ${port} 端口运行。`);
  process.exitCode = 1;
}
