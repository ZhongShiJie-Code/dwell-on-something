import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeChildEnv, claudeProviderEnv, sanitizedChildEnv } from './child-env.mjs';

test('sanitizedChildEnv preserves safe runtime variables and adds absolute executable directory', () => {
  const env = sanitizedChildEnv({
    executionPath: '/opt/dwell/bin/claude',
    baseEnv: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/test',
      LANG: 'zh_CN.UTF-8',
      SAFE_VALUE: 'kept',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/firebase.json',
      DWELL_FCM_ENABLED: '1',
      DWELL_VAPID_EMAIL: 'mailto:test@example.com',
      DWELL_AUTH_TOKEN: 'auth-secret',
      DWELL_HEALTH_TOKEN: 'health-secret',
      ANTHROPIC_API_KEY: 'api-secret',
      THIRD_PARTY_KEY: 'key-secret',
      THIRD_PARTY_TOKEN: 'token-secret',
      THIRD_PARTY_SECRET: 'secret-secret',
      NODE_OPTIONS: '--require=/tmp/injected.cjs',
      NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
      XPC_SERVICE_NAME: 'com.example.service',
      LAUNCHD_SOCKET: '/tmp/launchd.sock',
    },
  });

  assert.equal(env.HOME, '/Users/test');
  assert.equal(env.LANG, 'zh_CN.UTF-8');
  assert.equal(env.SAFE_VALUE, 'kept');
  assert.equal(env.PATH, '/opt/dwell/bin:/usr/bin:/bin');
  for (const key of [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'DWELL_FCM_ENABLED',
    'DWELL_VAPID_EMAIL',
    'DWELL_AUTH_TOKEN',
    'DWELL_HEALTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'THIRD_PARTY_KEY',
    'THIRD_PARTY_TOKEN',
    'THIRD_PARTY_SECRET',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'XPC_SERVICE_NAME',
    'LAUNCHD_SOCKET',
  ]) assert.equal(Object.hasOwn(env, key), false, key);
});

test('explicit values cannot reintroduce blocked variables', () => {
  const env = sanitizedChildEnv({
    baseEnv: { PATH: '/usr/bin', SAFE_VALUE: 'base' },
    explicit: {
      SAFE_VALUE: 'override',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/firebase.json',
      DWELL_FCM_PROJECT_ID: 'project',
      DWELL_VAPID_PRIVATE_KEY: 'private',
      APP_API_KEY: 'api',
      APP_TOKEN: 'token',
      APP_SECRET: 'secret',
      NODE_OPTIONS: '--inspect',
    },
  });

  assert.equal(env.SAFE_VALUE, 'override');
  assert.equal(env.PATH, '/usr/bin');
  for (const key of [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'DWELL_FCM_PROJECT_ID',
    'DWELL_VAPID_PRIVATE_KEY',
    'APP_API_KEY',
    'APP_TOKEN',
    'APP_SECRET',
    'NODE_OPTIONS',
  ]) assert.equal(Object.hasOwn(env, key), false, key);
});

test('claudeProviderEnv imports only provider settings from an owner-only settings file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dwell-child-env-'));
  const settingsFile = path.join(directory, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
      ANTHROPIC_AUTH_TOKEN: 'test-provider-token',
      ANTHROPIC_API_KEY: 'test-api-key',
      THIRD_PARTY_TOKEN: 'must-not-pass',
      ANTHROPIC_BASE_URL_BAD: 'file:///secret',
    },
  }));
  fs.chmodSync(settingsFile, 0o600);
  try {
    const provider = claudeProviderEnv({ settingsFile });
    assert.deepEqual(provider, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
      ANTHROPIC_AUTH_TOKEN: 'test-provider-token',
      ANTHROPIC_API_KEY: 'test-api-key',
    });
    const env = claudeChildEnv({ settingsFile, baseEnv: { PATH: '/usr/bin' } });
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-provider-token');
    assert.equal(env.ANTHROPIC_API_KEY, 'test-api-key');
    assert.equal(env.PATH, '/usr/bin');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('claudeProviderEnv rejects settings files readable by other users', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dwell-child-env-'));
  const settingsFile = path.join(directory, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'test-provider-token' } }));
  fs.chmodSync(settingsFile, 0o644);
  try {
    assert.deepEqual(claudeProviderEnv({ settingsFile }), {});
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
