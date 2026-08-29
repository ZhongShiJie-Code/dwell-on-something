import fsp from 'node:fs/promises';
import path from 'node:path';

const PACKAGE_NAME = 'com.xinwithyu.dwell';
const MAX_DATA_BYTES = 3500;
const MAX_ROUTE_BYTES = 1024;
const MAX_TEXT_BYTES = 64;
const DATA_KEYS = new Set(['v', 'notification_epoch', 'device_id', 'notification_id', 'kind', 'title', 'body', 'route', 'at']);
const INTERNAL_CODES = new Set([
  'fcm_not_configured',
  'fcm_credentials_unreadable',
  'fcm_credential_path_invalid',
  'fcm_project_mismatch',
  'firebase_admin_unavailable',
  'fcm_app_id_not_configured',
  'invalid_package_name',
  'invalid_firebase_app_id',
  'invalid_fcm_data_key',
  'invalid_fcm_version',
  'invalid_fcm_kind',
  'invalid_fcm_notification_id',
  'invalid_fcm_scope',
  'invalid_fcm_route',
  'invalid_fcm_token',
  'payload_too_large',
]);
const SENDER_UNAVAILABLE_CODES = new Set([
  'fcm_not_configured',
  'fcm_credentials_unreadable',
  'fcm_credential_path_invalid',
  'fcm_project_mismatch',
  'firebase_admin_unavailable',
  'fcm_app_id_not_configured',
]);

function bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function pathInside(child, parent) {
  if (!child || !parent) return false;
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

function stableCode(error) {
  const candidate = String(error?.code || error?.errorInfo?.code || '').trim();
  if (candidate.startsWith('messaging/')) return candidate.slice(0, 120);
  if (INTERNAL_CODES.has(candidate)) return candidate;
  const message = String(error?.message || '').trim();
  if (INTERNAL_CODES.has(message)) return message;
  return 'send_failed';
}

function internalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function errorCode(error) {
  return stableCode(error);
}

function classify(error) {
  const code = errorCode(error);
  if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) return 'invalid_token';
  if (code === 'messaging/mismatched-credential') return 'credential_mismatch';
  if (SENDER_UNAVAILABLE_CODES.has(code)) return 'sender_unavailable';
  if (['messaging/quota-exceeded', 'messaging/unavailable', 'messaging/internal-error', 'messaging/server-unavailable'].includes(code)) return 'temporary';
  return 'sender_error';
}

function validateData(data) {
  const normalized = Object.fromEntries(Object.entries(data || {}).map(([key, value]) => [key, String(value ?? '')]));
  if (Object.keys(normalized).some(key => !DATA_KEYS.has(key))) throw internalError('invalid_fcm_data_key');
  if (normalized.v !== '1') throw internalError('invalid_fcm_version');
  if (!['chat', 'task'].includes(normalized.kind)) throw internalError('invalid_fcm_kind');
  const notificationId = Number(normalized.notification_id);
  if (!/^\d+$/.test(normalized.notification_id || '') || !Number.isSafeInteger(notificationId) || notificationId < 1) {
    throw internalError('invalid_fcm_notification_id');
  }
  if (!normalized.notification_epoch || !normalized.device_id || !/^\d+$/.test(normalized.at || '')) throw internalError('invalid_fcm_scope');
  if (bytes(normalized.route) > MAX_ROUTE_BYTES) throw internalError('payload_too_large');
  if (bytes(normalized.title) > MAX_TEXT_BYTES || bytes(normalized.body) > MAX_TEXT_BYTES) throw internalError('payload_too_large');
  if (!new RegExp(`^${normalized.kind}/[^/\\s]+$`).test(normalized.route)) throw internalError('invalid_fcm_route');
  if (bytes(JSON.stringify(normalized)) > MAX_DATA_BYTES) throw internalError('payload_too_large');
  return normalized;
}

export function createFcmSender({ env = process.env, workspace = env.DWELL_WORKSPACE || process.cwd() } = {}) {
  const enabled = env.DWELL_FCM_ENABLED === '1';
  const credentials = String(env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  const expectedProjectId = String(env.DWELL_FCM_PROJECT_ID || '').trim();
  const expectedAppId = String(env.DWELL_FCM_ANDROID_APP_ID || '').trim();
  const dataDir = String(env.DWELL_DATA_DIR || '').trim();
  let appPromise = null;
  let appInstance = null;
  let appOwned = false;
  let deleteApp = null;

  async function credentialState() {
    if (!enabled || !path.isAbsolute(credentials) || !expectedProjectId || !expectedAppId) {
      return { configured: false, projectMatch: false, errorCode: 'fcm_not_configured', credential: null };
    }
    if (pathInside(credentials, workspace) || pathInside(credentials, dataDir)) {
      return { configured: false, projectMatch: false, errorCode: 'fcm_credential_path_invalid', credential: null };
    }
    try {
      const stat = await fsp.stat(credentials);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
        return { configured: false, projectMatch: false, errorCode: 'fcm_credentials_unreadable', credential: null };
      }
      const parsed = JSON.parse(await fsp.readFile(credentials, 'utf8'));
      const projectMatch = String(parsed.project_id || '') === expectedProjectId;
      if (!projectMatch) return { configured: false, projectMatch: false, errorCode: 'fcm_project_mismatch', credential: null };
      return { configured: true, projectMatch: true, errorCode: '', credential: parsed };
    } catch {
      return { configured: false, projectMatch: false, errorCode: 'fcm_credentials_unreadable', credential: null };
    }
  }

  async function messaging() {
    const state = await credentialState();
    if (!state.configured) throw internalError(state.errorCode || 'fcm_not_configured');
    if (!appPromise) {
      appPromise = (async () => {
        let appModule;
        let messagingModule;
        try {
          appModule = await import('firebase-admin/app');
          messagingModule = await import('firebase-admin/messaging');
        } catch {
          throw internalError('firebase_admin_unavailable');
        }
        try {
          const existing = appModule.getApps().find(candidate => candidate.name === 'dwell-fcm');
          appInstance = existing || appModule.initializeApp({
            credential: appModule.cert(state.credential),
            projectId: expectedProjectId,
          }, 'dwell-fcm');
          appOwned = !existing;
          deleteApp = appModule.deleteApp;
          const initializedProjectId = String(
            appInstance.options?.projectId
              || appInstance.options?.credential?.projectId
              || appInstance.options?.credential?.projectId,
          );
          if (!initializedProjectId || initializedProjectId !== expectedProjectId) throw internalError('fcm_project_mismatch');
          return messagingModule.getMessaging(appInstance);
        } catch (error) {
          if (SENDER_UNAVAILABLE_CODES.has(errorCode(error))) throw error;
          throw internalError('firebase_admin_unavailable');
        }
      })();
      appPromise = appPromise.catch(error => {
        appPromise = null;
        appInstance = null;
        appOwned = false;
        deleteApp = null;
        throw error;
      });
    }
    return appPromise;
  }

  async function status() {
    const state = await credentialState();
    const base = {
      enabled,
      configured: false,
      health: 'unavailable',
      project_match: state.projectMatch,
      app_id_configured: !!expectedAppId,
      package_name: PACKAGE_NAME,
      android_app_id: expectedAppId,
      error_code: state.errorCode || '',
    };
    if (!enabled || !state.configured) return base;
    try {
      await messaging();
      return { ...base, configured: true, health: 'ready', error_code: '' };
    } catch (error) {
      return { ...base, error_code: errorCode(error) };
    }
  }

  function validateBinding({ packageName, firebaseAppId } = {}, senderStatus = null) {
    if (String(packageName || '') !== PACKAGE_NAME) return { ok: false, code: 'invalid_package_name' };
    if (!enabled) return { ok: true, verified: false, reason: 'disabled' };
    if (!expectedAppId) return { ok: false, code: 'fcm_app_id_not_configured' };
    if (String(firebaseAppId || '') !== expectedAppId) return { ok: false, code: 'invalid_firebase_app_id' };
    return { ok: true, verified: !!senderStatus?.configured };
  }

  return {
    packageName: PACKAGE_NAME,
    androidAppId: expectedAppId,
    async status() { return status(); },
    validateBinding,
    async send({ token, data, ttlMs }) {
      try {
        const payload = validateData(data);
        const normalizedToken = String(token || '').trim();
        if (!normalizedToken) throw internalError('invalid_fcm_token');
        const ttl = Math.min(Math.max(Number(ttlMs) || 1000, 1000), 86_400_000);
        const client = await messaging();
        await client.send({
          token: normalizedToken,
          data: payload,
          android: {
            priority: 'high',
            restrictedPackageName: PACKAGE_NAME,
            ttl,
          },
        });
        return { ok: true };
      } catch (error) {
        const code = errorCode(error);
        return { ok: false, class: classify(error), code };
      }
    },
    async close() {
      const pending = appPromise;
      appPromise = null;
      const app = appInstance;
      const owned = appOwned;
      appInstance = null;
      appOwned = false;
      if (pending) await pending.catch(() => {});
      if (app && owned && deleteApp) await deleteApp(app).catch(() => {});
      deleteApp = null;
    },
  };
}

export { classify as classifyFcmError, errorCode as fcmErrorCode, validateData as validateFcmData };
