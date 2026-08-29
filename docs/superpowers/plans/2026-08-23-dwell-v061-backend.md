# Dwell v0.6.1 Backend Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v0.6.1 FCM outbox fail closed across device revocation, token rotation, Firebase binding, leases, and sender initialization, while preventing backend secrets from reaching child processes and preventing stopped or failed runs from creating success notifications.

**Architecture:** Keep SQLite as the authority for paired-device, token, delivery, and durable-notification state. Make FCM sender status perform the same Admin-client initialization that sending needs, and pass an explicit package/app binding through notification creation and delivery claiming. Centralize child-process environment construction in a small pure module, then use it at every backend spawn/execFile boundary. Keep stream delivery device-scoped at the SSE write boundary so one durable event can be replayed to each authenticated device safely.

**Tech Stack:** Node.js 18+ ESM, `better-sqlite3`, Node test runner, `firebase-admin` for enabled FCM, Node child-process APIs.

## Global Constraints

- Do not read, generate, copy, print, or record any real credential.
- Do not modify `night/` or `backend/data/`.
- Keep `DWELL_CLAUDE_MODEL=deepseek-v4-flash` unchanged.
- FCM remains disabled unless `DWELL_FCM_ENABLED=1` and valid configuration is present.
- Production Luna remains NO-GO.
- Preserve existing uncommitted work; do not commit or push.
- Follow the repository's Node ESM style and avoid dependencies other than the required declared `firebase-admin` runtime dependency.

---

### Task 1: FCM dependency, sender fail-closed behavior, and retry boundary tests

**Files:**
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/package.json`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/package-lock.json`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/services/fcm-sender.mjs`
- Create: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/services/fcm-sender.test.mjs`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/services/fcm-dispatcher.mjs`
- Create: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/services/fcm-dispatcher.test.mjs`

**Interfaces:**
- `createFcmSender({ env, workspace })` continues to return `status()`, `send()`, and `close()`, and adds `validateBinding({ packageName, firebaseAppId })`.
- Sender `status()` returns stable fields `{ enabled, configured, health, project_match, app_id_configured, package_name, android_app_id, error_code }` without exposing arbitrary exception text.
- Dispatcher treats `sender_unavailable` as a sender-wide fail-closed condition and cancels nonterminal deliveries instead of consuming per-token retry budgets.

- [ ] **Step 1: Write failing sender tests**

```js
test('enabled status is false when the Firebase Admin client cannot initialize', async () => {
  const sender = createFcmSender({ env: invalidCredentialEnv() });
  const status = await sender.status();
  assert.equal(status.enabled, true);
  assert.equal(status.configured, false);
  assert.equal(status.health, 'unavailable');
  assert.equal(status.error_code, 'firebase_admin_unavailable');
  await sender.close();
});

test('binding validation rejects the wrong Android app only when FCM is ready', async () => {
  const sender = createFcmSender({ env: disabledEnv() });
  assert.deepEqual(sender.validateBinding({ packageName: 'wrong.package', firebaseAppId: 'app' }), { ok: false, code: 'invalid_package_name' });
  assert.deepEqual(sender.validateBinding({ packageName: 'com.xinwithyu.dwell', firebaseAppId: 'app' }), { ok: true, verified: false, reason: 'disabled' });
  await sender.close();
});

test('internal sender errors keep stable codes and never copy arbitrary messages', () => {
  assert.equal(classifyFcmError(new Error('firebase_admin_unavailable')), 'sender_unavailable');
  assert.equal(classifyFcmError(new Error('do not expose this')), 'sender_error');
  assert.equal(classifyFcmError({ code: 'messaging/invalid-registration-token' }), 'invalid_token');
});
```

- [ ] **Step 2: Run the focused sender test and verify the expected failures**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test services/fcm-sender.test.mjs`

Expected: FAIL because the sender currently reports file-only configuration, has no binding validator, and classifies internal initialization errors as ordinary sender errors.

- [ ] **Step 3: Add the declared Firebase Admin dependency**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && npm install --save firebase-admin@^13.0.0`

Expected: `package.json` and `package-lock.json` contain the same declared dependency and `npm install` completes without reading any application credential.

- [ ] **Step 4: Make sender status initialize the same Admin client used by send**

Use an explicit parsed credential object from the configured JSON file, require exact `project_id` equality, initialize the named `dwell-fcm` app once, and have `status()` catch only stable internal codes. Do not return `error.message` or arbitrary Firebase text.

- [ ] **Step 5: Add package/app binding validation and sender-wide error classification**

Reject a wrong package always. When FCM is enabled and the sender is configured, reject a wrong `firebase_app_id`; while disabled or unavailable, accept storage but mark it unverified so database notification creation cannot enqueue it. Map `firebase_admin_unavailable`, `fcm_not_configured`, and `fcm_project_mismatch` to a sender-wide class.

- [ ] **Step 6: Run the focused sender test and verify it passes**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test services/fcm-sender.test.mjs`

Expected: PASS with no credential values printed.

- [ ] **Step 7: Write failing dispatcher tests**

```js
test('random zero is the retry-delay lower bound', () => {
  assert.equal(retryDelay('chat', 1, () => 0), 27);
  assert.equal(retryDelay('chat', 1, () => 0.5), 30);
  assert.equal(retryDelay('chat', 1, () => 1), 33);
});

test('sender-wide unavailability cancels the outbox without a token retry', async () => {
  const calls = [];
  const database = fakeDatabase({ cancelPushDeliveries: at => calls.push(['cancel', at]) });
  const sender = { status: async () => ({ enabled: true, configured: true, project_match: true }), send: async () => ({ ok: false, class: 'sender_unavailable', code: 'firebase_admin_unavailable' }) };
  const dispatcher = createFcmDispatcher({ database, sender, clock: () => 100_000 });
  const result = await dispatcher.tick();
  assert.equal(result.results[0].state, 'unavailable');
  assert.deepEqual(calls[0][0], 'cancel');
});
```

- [ ] **Step 8: Run the focused dispatcher test and verify it fails**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test services/fcm-dispatcher.test.mjs`

Expected: FAIL because zero is replaced with the midpoint and `sender_unavailable` currently follows the ordinary retry path.

- [ ] **Step 9: Fix retry random handling and sender-wide cancellation**

Use `Number.isFinite` plus clamping so `0` remains valid. In `sendOne`, cancel all nonterminal deliveries and return `state: 'unavailable'` when the sender reports a sender-wide configuration/client failure.

- [ ] **Step 10: Run sender and dispatcher tests together**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test services/fcm-sender.test.mjs services/fcm-dispatcher.test.mjs`

Expected: PASS.

---

### Task 2: SQLite lifecycle fencing, token binding, and database tests

**Files:**
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/db/database.mjs`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/db/database.test.mjs`

**Interfaces:**
- `registerPushToken(input)` rejects missing/revoked devices and accepts package/app metadata for storage.
- `createNotification(event, { senderEnabled, senderPackageName, senderFirebaseAppId, ttlSeconds })` queues only exact binding matches.
- `claimPushDeliveries({ workerId, limit, at, leaseSeconds, packageName, firebaseAppId })` defensively requires an active paired device and exact binding when a policy is supplied.
- `revokeDevice(id, at)` atomically revokes the device, deletes its token, and cancels all pending/retry/sending deliveries while clearing leases.
- `quarantineMismatchedPushTokens({ packageName, firebaseAppId, at })` quarantines and cancels existing mismatched bindings.

- [ ] **Step 1: Add failing database tests for revoke, fencing, rotation, and app binding**

Create a temporary SQLite fixture outside `backend/data/`, add a paired device and token, create a notification with the expected binding, and assert:

```js
const revoked = database.revokeDevice('device-1', 110);
assert.equal(revoked, true);
assert.equal(database.pushStatus('device-1').registered, false);
assert.equal(database.claimPushDeliveries({ workerId: 'worker-2', at: 110, packageName: PACKAGE, firebaseAppId: APP_ID }).length, 0);
assert.equal(readDelivery(dbPath).state, 'cancelled');
assert.equal(readDelivery(dbPath).lease_token, null);
```

Also assert that an old lease cannot complete after a boundary-time re-claim, token rotation cancels nonterminal deliveries, and a wrong Firebase app never enters the filtered outbox.

- [ ] **Step 2: Run the focused database tests and verify failures**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test db/database.test.mjs`

Expected: FAIL on the current `registered=true`, claim-after-revoke, boundary lease, and mismatched app behavior.

- [ ] **Step 3: Implement the atomic revoke transaction**

Update `revoked_at` first inside one immediate transaction; on a successful transition delete the device token and update every nonterminal delivery for that device to `cancelled` with `lease_token` and `lease_until` set to `NULL`.

- [ ] **Step 4: Add defensive active-device and binding predicates to registration, notification creation, and claim**

Join `paired_devices` with `revoked_at IS NULL`, require exact package/app values when the caller supplies them, and cancel/quarantine mismatched existing token rows before claiming. Use `lease_until <= ?` consistently in claim recovery.

- [ ] **Step 5: Run focused database tests and verify green**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test db/database.test.mjs`

Expected: PASS, including the pre-existing migration tests.

---

### Task 3: API binding enforcement and device-scoped SSE

**Files:**
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/server.mjs`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/api-v2.test.mjs`
- Create: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/services/sse-context.mjs`
- Create: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/services/sse-context.test.mjs`

**Interfaces:**
- `withSseDeviceContext(event, deviceId)` returns a copy of a canonical `notification.created` event whose notification data contains the authenticated device ID; non-notification events remain unchanged.
- `serveEventStream` receives the authenticated v2 device and applies `withSseDeviceContext` both to replayed and live events.

- [ ] **Step 1: Write failing SSE context tests**

```js
test('notification replay gets the authenticated device context without mutating the stored event', () => {
  const original = { id: 7, type: 'notification.created', data: { notification_id: 7, device_id: '' } };
  const scoped = withSseDeviceContext(original, 'device-7');
  assert.equal(scoped.data.device_id, 'device-7');
  assert.equal(original.data.device_id, '');
});
```

- [ ] **Step 2: Run the focused SSE test and verify failure**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test services/sse-context.test.mjs`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Add the context helper and use it for replay/broadcast**

Pass `auth.deviceId` into `serveEventStream`, store it on each SSE client, and scope every `notification.created` event at write time. Pass sender package/app fields into durable-notification creation. Call `fcmSender.validateBinding` in the push-token API so wrong package is rejected always and wrong app is rejected once enabled/configured.

- [ ] **Step 4: Add API assertions for package/app registration and bootstrap device identity**

Use the existing isolated temporary data directory fixture. Assert `bootstrap.device_id` matches the paired device, wrong package returns `invalid_package_name`, disabled FCM accepts storage without creating a delivery, and the push status reports the stored binding without exposing the token.

- [ ] **Step 5: Run API and SSE tests**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test api-v2.test.mjs services/sse-context.test.mjs`

Expected: PASS.

---

### Task 4: Child-process environment isolation

**Files:**
- Create: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/services/child-env.mjs`
- Create: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/services/child-env.test.mjs`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/server.mjs`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/desktop-task-bridge.mjs`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/desktop-tasks.mjs`
- Modify: `/Users/tom/Documents/Claude/../Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/news_daily.mjs`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/api-v2.test.mjs`

**Interfaces:**
- `sanitizedChildEnv({ executionPath, baseEnv, explicit })` returns a fresh environment containing only basic runtime keys plus the explicitly approved nonsecret keys for that path.
- Claude children never receive `GOOGLE_APPLICATION_CREDENTIALS`, any `DWELL_FCM_*`, `DWELL_AUTH_TOKEN`, `DWELL_HEALTH_TOKEN`, `DWELL_VAPID_*`, or arbitrary `*_KEY`/`*_TOKEN` values.
- Internal worker/bridge children receive only the specific nonsecret `DWELL_*` path/config keys needed to locate their own input files; those keys are not forwarded again to Claude/MCP children.

- [ ] **Step 1: Write failing environment tests**

```js
test('Claude route strips backend secrets and keeps only an explicit safe endpoint', () => {
  const env = sanitizedChildEnv({
    executionPath: 'claude',
    baseEnv: { PATH: '/bin', HOME: '/tmp/home', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/cred.json', DWELL_FCM_ENABLED: '1', DWELL_AUTH_TOKEN: 'sentinel', ANTHROPIC_API_KEY: 'sentinel-key' },
    explicit: { ANTHROPIC_BASE_URL: 'https://api.example.test' },
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.example.test');
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'DWELL_FCM_ENABLED', 'DWELL_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(Object.hasOwn(env, key), false);
});

test('route variables are not copied to git or host helper paths', () => {
  const env = sanitizedChildEnv({ executionPath: 'git', baseEnv: { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://api.example.test' }, explicit: { ANTHROPIC_BASE_URL: 'https://api.example.test' } });
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_BASE_URL'), false);
});
```

- [ ] **Step 2: Run the focused environment test and verify failure**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test services/child-env.test.mjs`

Expected: FAIL because the centralized environment helper does not exist.

- [ ] **Step 3: Implement the allowlist helper**

Allow only `PATH`, `HOME`, `TMPDIR`/`TMP`/`TEMP`, locale/terminal identity basics, and `NO_COLOR`. Allow `ANTHROPIC_BASE_URL` only when explicitly supplied to the Claude route. Add narrowly named internal path/config keys for detached worker and control bridge execution; never allow names matching credential, token, key, FCM, auth, health, or VAPID patterns.

- [ ] **Step 4: Replace every backend child-process environment expansion**

Use explicit `env` values for server Claude CLI and Gong, news rewrite, desktop task Claude, host MCP helper, detached worker, desktop control bridge, git, and the API test server. Do not leave `env` omitted and do not spread `process.env` at a child call site.

- [ ] **Step 5: Run environment tests and syntax checks**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test services/child-env.test.mjs && npm run check`

Expected: PASS and no sensitive sentinel key appears in any collected child environment.

---

### Task 5: Final success/timeout lifecycle and complete verification

**Files:**
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/server.mjs`
- Create or modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/server-lifecycle.test.mjs`
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/package.json`

**Interfaces:**
- Each turn has a current-run guard that is checked before/after awaited output work and before message, usage, durable-notification, and result writes.
- A CLI run is successful only with an original non-error result, exit code 0, no timeout, and no stop/supersede state.
- Timeout, missing result, nonzero exit, error result, stopped, and superseded runs never create a success result or completion notification.

- [ ] **Step 1: Write failing lifecycle tests with a fake CLI**

Cover a delayed CLI that receives SIGTERM, exits 0 without a result, a synthetic-only stream, an `is_error: true` result, and a successful result. Assert timeout/error output and the absence of `assistant_turn_completions`/`notification.created` for all non-success cases.

- [ ] **Step 2: Run lifecycle tests and verify they fail**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test server-lifecycle.test.mjs`

Expected: FAIL because timeout currently can fall through to an empty successful result and assistant notifications can be committed before final success.

- [ ] **Step 3: Add one `isCurrentRun`/finalize guard and defer CLI assistant notification**

Set `run.timedOut` in the timeout handler, stop processing after timeout/stop/supersede, defer durable completion until the terminal success predicate passes, and make the finalizer emit an explicit error instead of an empty success when no valid result exists.

- [ ] **Step 4: Run lifecycle tests and the full backend suite**

Run: `cd /Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend && node --test server-lifecycle.test.mjs && npm run check && npm test`

Expected: PASS. Report the actual test counts and any unimplemented audit items rather than claiming more.

---

## Deferred Items To Report Explicitly

- Encrypting existing FCM bearer tokens at rest is not included in this change because the repository has no established external key source or rotation/migration protocol; implementing ad-hoc key storage beside the database would not be safe.
- Moving the default data directory outside the workspace and migrating existing deployments is not included because it changes deployment semantics and needs a user-approved migration path; no `backend/data/` content is touched.
- Full requested/observed/attempt/route-fingerprint model observability across main chat, Gong, News, and desktop tasks is not included unless the existing server lifecycle tests expose a safe, bounded seam; current work focuses on preventing false success and secret propagation.
