import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

const ALWAYS_BLOCKED = new Set([
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_API_KEY',
  'DWELL_AUTH_TOKEN',
  'DWELL_HEALTH_TOKEN',
]);
const CLAUDE_PROVIDER_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]);

function sensitiveKey(key) {
  const name = String(key || '').toUpperCase();
  if (ALWAYS_BLOCKED.has(name)) return true;
  if (/^DWELL_(?:FCM|VAPID)_/.test(name)) return true;
  if (/(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/.test(name)) return true;
  if (/^(?:AWS_SESSION_TOKEN|GITHUB_TOKEN|NPM_TOKEN)$/.test(name)) return true;
  return false;
}

function keepKey(key) {
  const name = String(key || '');
  if (!name || sensitiveKey(name)) return false;
  if (name === 'NODE_OPTIONS' || name === 'NODE_EXTRA_CA_CERTS') return false;
  if (name === 'XPC_SERVICE_NAME' || name.startsWith('LAUNCHD_')) return false;
  return true;
}

export function sanitizedChildEnv({ executionPath = '', baseEnv = process.env, explicit = {} } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (keepKey(key) && value != null) env[key] = String(value);
  }
  for (const [key, value] of Object.entries(explicit || {})) {
    if (keepKey(key) && value != null) env[key] = String(value);
  }
  const executable = String(executionPath || '');
  if (path.isAbsolute(executable)) {
    const directory = path.dirname(executable);
    const currentPath = String(env.PATH || '');
    const entries = currentPath.split(path.delimiter).filter(Boolean);
    if (!entries.includes(directory)) env.PATH = [directory, ...entries].join(path.delimiter);
  }
  return env;
}

function defaultClaudeSettingsFile() {
  return process.env.DWELL_CLAUDE_SETTINGS
    || path.join(process.env.HOME || '', '.claude', 'settings.json');
}

function validProviderBase(value) {
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function claudeProviderEnv({ settingsFile = defaultClaudeSettingsFile() } = {}) {
  const file = path.resolve(String(settingsFile || ''));
  if (!file || file === path.parse(file).root) return {};
  try {
    const stat = fs.lstatSync(file);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || (uid != null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return {};
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const source = settings?.env;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    const env = {};
    for (const key of CLAUDE_PROVIDER_KEYS) {
      const value = source[key];
      if (typeof value !== 'string' || !value) continue;
      if (key === 'ANTHROPIC_BASE_URL' && !validProviderBase(value)) continue;
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

export function claudeChildEnv(options = {}) {
  const { settingsFile = defaultClaudeSettingsFile(), ...baseOptions } = options;
  return {
    ...sanitizedChildEnv(baseOptions),
    ...claudeProviderEnv({ settingsFile }),
  };
}

export { sensitiveKey };
