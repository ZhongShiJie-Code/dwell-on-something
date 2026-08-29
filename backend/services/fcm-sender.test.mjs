import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFcmSender, classifyFcmError } from './fcm-sender.mjs';

const PACKAGE_NAME = 'com.xinwithyu.dwell';
const APP_ID = '1:1234567890:android:abcdef';

async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'dwell-fcm-sender-test-'));
}

function disabledEnv(root) {
  return {
    DWELL_FCM_ENABLED: '0',
    DWELL_WORKSPACE: root,
    DWELL_DATA_DIR: path.join(root, 'data'),
    DWELL_FCM_PROJECT_ID: 'project-test',
    DWELL_FCM_ANDROID_APP_ID: APP_ID,
  };
}

async function invalidCredentialEnv(root) {
  const credentialRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dwell-fcm-credentials-'));
  const credentials = path.join(credentialRoot, 'firebase.json');
  await fsp.writeFile(credentials, JSON.stringify({ project_id: 'project-test' }), { mode: 0o600 });
  return {
    credentialRoot,
    env: {
      DWELL_FCM_ENABLED: '1',
      DWELL_WORKSPACE: root,
      DWELL_DATA_DIR: path.join(root, 'data'),
      DWELL_FCM_PROJECT_ID: 'project-test',
      DWELL_FCM_ANDROID_APP_ID: APP_ID,
      GOOGLE_APPLICATION_CREDENTIALS: credentials,
    },
  };
}

test('enabled status is unavailable when the Firebase Admin client cannot initialize', async t => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const setup = await invalidCredentialEnv(root);
  t.after(() => fsp.rm(setup.credentialRoot, { recursive: true, force: true }));
  const sender = createFcmSender({ env: setup.env, workspace: root });
  const status = await sender.status();
  assert.equal(status.enabled, true);
  assert.equal(status.configured, false);
  assert.equal(status.health, 'unavailable');
  assert.equal(status.project_match, true);
  assert.equal(status.error_code, 'firebase_admin_unavailable');
  await sender.close();
});

test('binding validation rejects the wrong package always and allows storage while disabled', async t => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sender = createFcmSender({ env: disabledEnv(root), workspace: root });
  assert.deepEqual(sender.validateBinding({ packageName: 'wrong.package', firebaseAppId: APP_ID }), {
    ok: false,
    code: 'invalid_package_name',
  });
  assert.deepEqual(sender.validateBinding({ packageName: PACKAGE_NAME, firebaseAppId: APP_ID }), {
    ok: true,
    verified: false,
    reason: 'disabled',
  });
  await sender.close();
});

test('enabled binding validation rejects a Firebase app ID mismatch without initializing Firebase', async t => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const setup = await invalidCredentialEnv(root);
  t.after(() => fsp.rm(setup.credentialRoot, { recursive: true, force: true }));
  const sender = createFcmSender({ env: setup.env, workspace: root });
  const status = await sender.status();
  assert.equal(status.enabled, true);
  assert.deepEqual(sender.validateBinding({ packageName: PACKAGE_NAME, firebaseAppId: '1:1234567890:android:wrong' }, status), {
    ok: false,
    code: 'invalid_firebase_app_id',
  });
  await sender.close();
});

test('internal sender errors keep stable codes and never copy arbitrary messages', () => {
  assert.equal(classifyFcmError(new Error('firebase_admin_unavailable')), 'sender_unavailable');
  assert.equal(classifyFcmError(new Error('fcm_project_mismatch')), 'sender_unavailable');
  assert.equal(classifyFcmError(new Error('do not expose this')), 'sender_error');
  assert.equal(classifyFcmError({ code: 'messaging/invalid-registration-token' }), 'invalid_token');
});
