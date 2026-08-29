import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizedChildEnv } from './child-env.mjs';

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
