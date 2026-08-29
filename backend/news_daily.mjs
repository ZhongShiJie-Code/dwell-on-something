#!/usr/bin/env node

/*
 * Optional daily newspaper job.  It is intentionally separate from the HTTP
 * server: a cron/launchd task can retry it without taking the chat offline.
 * The default output is a clean RSS digest; set DWELL_NEWS_USE_CLAUDE=1 to
 * let the local Claude Code CLI turn the digest into the house style.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sanitizedChildEnv } from './child-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DWELL_DATA_DIR || path.join(HERE, 'data'));
const NEWS_DIR = path.join(DATA_DIR, 'news');
const CLAUDE_BIN = process.env.DWELL_CLAUDE_BIN || 'claude';
const SOURCES = [
  ['科技与AI', 'https://news.google.com/rss/search?q=人工智能+OR+大模型+when:1d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'],
  ['关于 Claude', 'https://news.google.com/rss/search?q=Anthropic+OR+Claude+AI+when:3d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'],
  ['中国社会', 'https://news.google.com/rss/search?q=中国+社会+民生+when:1d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'],
];

function cnDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()); }
function strip(text) { return String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim(); }

async function rss(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'dwell-news/0.4' } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 12).map(match => {
    const item = match[1];
    const title = strip(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
    const link = strip(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]);
    const summary = strip(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1]);
    return { title, link, summary };
  }).filter(x => x.title);
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', prompt, '--model', 'haiku', '--output-format', 'text', '--no-session-persistence'], {
      env: sanitizedChildEnv({ executionPath: CLAUDE_BIN }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', x => { out += x; });
    child.stderr.on('data', x => { err += x; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err || `claude exited ${code}`)));
  });
}

const date = cnDate();
const sections = [];
for (const [name, url] of SOURCES) {
  try { sections.push([name, await rss(url)]); }
  catch (error) { console.error(`[news] ${name}: ${error.message}`); }
}
if (!sections.length) throw new Error('no news source returned data');

let markdown = `# 日报 ${date}\n\n`;
for (const [name, items] of sections) {
  markdown += `## ${name}\n\n`;
  for (const item of items.slice(0, 8)) markdown += `- ${item.title}｜${item.link}\n`;
  markdown += '\n';
}

if (process.env.DWELL_NEWS_USE_CLAUDE === '1') {
  try {
    markdown = await runClaude(`你在给一个人写只给她看的日报。保留下面的版块，不要虚构事实；每条用人话概括，保留链接，控制在 1200 字内。直接输出 Markdown，不要解释。\n\n${markdown}`);
  } catch (error) { console.error(`[news] Claude rewrite skipped: ${error.message}`); }
}

await fs.mkdir(NEWS_DIR, { recursive: true });
await fs.writeFile(path.join(NEWS_DIR, `日报-${date}.md`), markdown, { mode: 0o600 });
console.log(`[news] wrote ${path.join(NEWS_DIR, `日报-${date}.md`)}`);
