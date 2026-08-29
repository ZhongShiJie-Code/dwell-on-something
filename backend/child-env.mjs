import path from 'node:path';

const ALWAYS_BLOCKED = new Set([
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_API_KEY',
  'DWELL_AUTH_TOKEN',
  'DWELL_HEALTH_TOKEN',
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

export { sensitiveKey };
