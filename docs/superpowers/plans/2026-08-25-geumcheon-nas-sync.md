# Geumcheon NAS Record Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Synology-hosted HTTPS record service and a Windows DPAPI-protected Electron sync path that safely collects PC01-PC10 records, serves a masked leaderboard, survives network/app/NAS interruption, and never exposes raw credentials or participant PII to the renderer or public read API.

**Architecture:** The Geumcheon client first commits each record to an encrypted device-local outbox, then a single Electron-main retry worker posts it over public-certificate HTTPS. The NAS service authenticates scoped device tokens, strictly validates and recalculates each record, and publishes it atomically without overwriting an existing ID. LEADERBOARD01 fetches a server-masked ETag snapshot and retains the last valid local snapshot; operator visibility changes are append-only and require both a short local administrator session and a separate NAS operator token.

**Tech Stack:** TypeScript 5.9, Electron 43 `safeStorage`, Node.js 24 LTS, Fastify 5, React 19, `node:test` through `tsx`, esbuild, Docker/DSM Container Manager.

**Spec:** `docs/superpowers/specs/2026-08-25-geumcheon-typingking-design.md`

**Dependency:** Execute `docs/superpowers/plans/2026-08-25-geumcheon-client-foundation.md` first. This plan consumes its `EventProfileId`, `SessionKind`, `DeviceProfile`, `GeumcheonStageResultInput`, `SaveRecordInput.fairness`, device-isolated runtime root, exact ranking helpers, and four Geumcheon variants.

## Global Constraints

- Work only on local branch `geumcheon-2026`; do not push the Geumcheon branch or artifacts to GitHub before final user approval.
- Preserve the existing SkillUp `local` and `onedrive_manual` behavior and all six existing build paths when `EVENT_PROFILE` is absent.
- The only public ingress is valid-certificate HTTPS 443 through DSM reverse proxy; never expose SMB 139/445, DSM 5000/5001, WebDAV, or the container port to the internet.
- Accept record bodies no larger than 32 KiB, reject unknown fields, and require TLS 1.2 or newer at the DSM boundary.
- PC01-PC10 each use a distinct 256-bit write token. LEADERBOARD01 uses distinct leaderboard-read and operator tokens. The NAS stores only SHA-256 token hashes and token scope metadata.
- `0208` remains a local administrator PIN only. It must not appear in source, examples, tests, logs, URLs, NAS token material, or public API payloads.
- Never delete an outbox item until a valid `200` or `201` response matches both its `record_id` and canonical `payload_sha256`.
- Keep official and practice outboxes, server paths, leaderboard snapshots, and operator actions separate.
- Public leaderboard data is server-masked. Raw name, full phone, birthdate, consent fields, participant HMAC key, record body, and credentials must never cross renderer IPC.
- Server logs may contain only record/action ID, authenticated device ID, response code, byte count, duration, and stable non-PII error code.
- Do not commit real `device-profile.json`, `bootstrap-credentials.json`, token manifests, HMAC keys, records, outboxes, logs, generated releases, or NAS `.env` files.
- Code/unit/container checks do not prove DSM, reverse proxy, DNS, certificate, external Wi-Fi, firewall, or real NAS readiness. Those remain deployment/rehearsal gates.
- Execute this plan only after the client-foundation plan and before the deployment/report plan. Client-owned shared types, Electron bootstrap, renderers, and client scripts are inputs to extend, not concurrent edit targets or replacements.
- This plan owns the NAS additions to `package.json`, `.gitignore`, and `scripts/scan-pii.mjs`. The later deployment/report plan may append deployment commands and generated-root rules, but must preserve the NAS commands, ignore rules, and scanner behavior created here.

## File Structure

- Create `shared/nas/protocol.ts`: canonical wire types, record/action ID validation, canonical JSON hashing, acknowledgement validation.
- Create `services/nas-record-api/package.json`, `package-lock.json`, `tsconfig.json`: isolated Node 24 API package and deterministic scripts.
- Create `services/nas-record-api/src/config.ts`: strict event/token/secret configuration loading.
- Create `services/nas-record-api/src/auth.ts`: constant-time scoped token authentication and token-bucket limits.
- Create `services/nas-record-api/src/recordSchema.ts`: strict structural and semantic record validation and server recalculation.
- Create `services/nas-record-api/src/atomicStore.ts`: no-replace temp/fsync/link/directory-fsync primitive.
- Create `services/nas-record-api/src/recordStore.ts`: idempotent official/practice record persistence.
- Create `services/nas-record-api/src/leaderboardService.ts`: filesystem snapshot, HMAC participant grouping, attempt gating, masking, ETag.
- Create `services/nas-record-api/src/operatorActionStore.ts`: idempotent append-only hide/unhide actions.
- Create `services/nas-record-api/src/app.ts`, `src/cli.ts`: Fastify routes, safe logging, process lifecycle.
- Create `services/nas-record-api/Dockerfile`: Node 24 multi-stage, non-root runtime image.
- Create `services/nas-record-api/test/*.test.ts`: authentication, schema, storage, routes, leaderboard, actions, PII-boundary tests.
- Create `electron/nas/dataProtector.ts`: injectable Electron `safeStorage` adapter.
- Create `electron/nas/credentialStore.ts`: one-time bootstrap ingestion and encrypted credential access.
- Create `electron/nas/outbox.ts`: encrypted official/practice pending, conflict, and recovery queues.
- Create `electron/nas/apiClient.ts`: no-redirect HTTPS record, leaderboard, health, and visibility calls.
- Create `electron/nas/retryWorker.ts`: single-flight retry state machine with backoff, jitter, Retry-After, pause/quarantine rules.
- Create `electron/nas/leaderboardClient.ts`: strict public response validation and last-known-good ETag cache.
- Create `electron/nas/adminSession.ts`: renderer-bound short administrator sessions.
- Create `electron/nas/operationLog.ts`: fixed-field non-PII NDJSON operations log.
- Create `electron/nas/runtime.ts`: compose profile, credentials, outbox, clients, worker, and main-process operations.
- Create `tests/nas-client/*.test.ts`: protocol, credential, outbox, HTTP, worker, cache, admin-session, PII tests.
- Modify `shared/types/index.ts`: add only NAS public status/snapshot/IPC types not already supplied by the client-foundation plan.
- Modify `shared/csv/fileStore.ts`: allow the Geumcheon `nas_https` branch to enqueue before returning while leaving existing persistence branches unchanged.
- Modify `electron/main.ts`, `electron/preload.ts`, `apps/shell/src/global.d.ts`: lifecycle and least-privilege IPC.
- Modify `apps/typing-game/src/AIChallengeGame.tsx`: separate local durability from NAS acknowledgement status.
- Modify `apps/leaderboard/src/LeaderboardApp.tsx`: consume masked snapshots and expose hide/unhide only for Geumcheon.
- Modify `package.json`, `scripts/scan-pii.mjs`, `.gitignore`: focused commands and secret/runtime artifact exclusions.

---

### Task 1: Canonical NAS Protocol and Client Contract

**Files:**

- Create: `shared/nas/protocol.ts`
- Create: `tests/nas-client/protocol.test.ts`
- Modify: `shared/types/index.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes `SessionKind`, `DeviceProfile`, `GeumcheonStageResultInput`, `SaveRecordInput.fairness`, and `RecordRow` from the client-foundation plan.
- Produces `NasRecordEnvelopeV1`, `NasRecordAckV1`, `NasLeaderboardSnapshotV1`, `NasVisibilityActionV1`, `canonicalStringify`, `payloadSha256`, `createGeumcheonRecordId`, `assertNasRecordAck`, and `assertNasLeaderboardSnapshot`.
- Later server and Electron tasks must import these types/functions instead of independently redefining the wire contract.

- [ ] **Step 1: Write failing protocol tests**

```ts
test("creates only device-scoped UUID v4 record IDs", () => {
  const id = createGeumcheonRecordId("PC10", () => "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(id, "gsc26-pc10-123e4567-e89b-42d3-a456-426614174000");
  assert.equal(isGeumcheonRecordId(id), true);
  assert.equal(isGeumcheonRecordId("gsc26-pc10-../../record"), false);
});

test("hashes semantically identical objects identically", () => {
  assert.equal(payloadSha256({ b: 2, a: 1 }), payloadSha256({ a: 1, b: 2 }));
});

test("rejects an acknowledgement for another payload", () => {
  assert.throws(
    () => assertNasRecordAck(ack({ payload_sha256: "0".repeat(64) }), RECORD_ID, "1".repeat(64)),
    /payload hash/i
  );
});
```

- [ ] **Step 2: Run focused test and verify missing-module failure**

Run: `npx tsx --test tests/nas-client/protocol.test.ts`

Expected: FAIL because `shared/nas/protocol.ts` does not exist.

- [ ] **Step 3: Define the exact record envelope**

```ts
export type NasSessionV1 =
  | { kind: "official"; session_id: string; day_no: number; round_no: number }
  | { kind: "practice"; session_id: string };

export type NasStageAttemptV1 = {
  stage_no: 1 | 2 | 3;
  text_id: string;
  catalog_version: string;
  target_text: string;
  typed_text: string;
  user_time_ms: number;
  ai_cpm: number;
  result: "USER_WIN" | "AI_WIN" | "INTERRUPTED";
};

export type NasRecordEnvelopeV1 = {
  schema_version: 1;
  event_id: "geumcheon-science-festival-2026";
  session: NasSessionV1;
  record: {
    record_id: string;
    created_at: string;
    completed_at: string;
    participant: {
      name: string;
      phone: string;
      birthdate: string;
      privacy_agreed: boolean;
      privacy_agreed_at: string;
    };
    status: "success" | "failed" | "interrupted";
    stages: NasStageAttemptV1[];
    app_version: string;
    is_test: boolean;
    is_debug: boolean;
    debug_mode_type: "" | "normal_typing_debug" | "ai_challenge_debug";
    interruption_action?: "home" | "retry";
  };
};

export type NasRecordAckV1 = {
  schema_version: 1;
  disposition: "stored" | "duplicate";
  record_id: string;
  payload_sha256: string;
  stored_sha256: string;
  received_at: string;
};
```

Do not send client-computed CPM, rank, eligibility, attempt number, masked values, participant key, target path, administrator name, or arbitrary memo. `buildNasRecordEnvelope(profile, kind, row, fairness)` must map only the fields above and fail if fairness data is absent or a stage has invalid text/timing data.

- [ ] **Step 4: Implement deterministic canonicalization and strict public-response guards**

Recursively sort object keys, preserve array order, reject non-finite numbers/`undefined`/non-plain objects, and hash UTF-8 canonical JSON with SHA-256. Validate hashes as 64 lowercase hex characters, timestamps as parseable ISO strings, IDs by exact regex and UUID-v4 variant, and public snapshot objects with `additionalProperties` semantics.

- [ ] **Step 5: Add the focused test command and run it**

Add:

```json
"test:nas-client": "tsx --test tests/nas-client/protocol.test.ts tests/nas-client/credentialStore.test.ts tests/nas-client/outbox.test.ts tests/nas-client/apiClient.test.ts tests/nas-client/retryWorker.test.ts tests/nas-client/leaderboardClient.test.ts tests/nas-client/adminSession.test.ts tests/nas-client/piiBoundary.test.ts"
```

Temporarily create the later test files only in their assigned tasks; for this task run the focused command directly.

Run: `npx tsx --test tests/nas-client/protocol.test.ts`

Expected: PASS for canonical order, UUID/path rejection, acknowledgement matching, and public field rejection.

- [ ] **Step 6: Commit**

```text
feat: define Geumcheon NAS wire protocol
```

---

### Task 2: NAS Configuration, Authentication, Rate Limits, and Record Validation

**Files:**

- Create: `services/nas-record-api/package.json`
- Create: `services/nas-record-api/package-lock.json`
- Create: `services/nas-record-api/tsconfig.json`
- Create: `services/nas-record-api/src/config.ts`
- Create: `services/nas-record-api/src/auth.ts`
- Create: `services/nas-record-api/src/recordSchema.ts`
- Create: `services/nas-record-api/test/auth.test.ts`
- Create: `services/nas-record-api/test/recordSchema.test.ts`

**Interfaces:**

- Consumes `NasRecordEnvelopeV1`, the Geumcheon phrase catalog, approved official/practice AI ranges, `countConvertedTypingUnits`, and exact ranking helpers.
- Produces `loadNasConfig(env)`, `authenticateRequest(headers, manifest, now)`, `TokenBucketLimiter.consume(tokenId, now)`, `AuxiliaryIpLimiter.consume(remoteAddress, now)`, and `validateAndNormalizeRecord(body, authenticatedDevice, config, receivedAt)`.
- Task 3 consumes only the normalized `StoredNasRecordV1`; routes never write a raw request body directly.

- [ ] **Step 1: Create the isolated service package and failing tests**

Use this script surface:

```json
{
  "scripts": {
    "test": "tsx --test test/auth.test.ts test/recordSchema.test.ts test/recordStore.test.ts test/routes.test.ts test/leaderboard.test.ts test/operatorActions.test.ts test/piiBoundary.test.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "esbuild src/cli.ts --bundle --platform=node --target=node24 --format=cjs --packages=external --outfile=dist/server.cjs",
    "start": "node dist/server.cjs"
  },
  "dependencies": { "fastify": "^5.6.2" },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "esbuild": "^0.25.10",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3"
  }
}
```

Generate and commit the service lockfile with `npm --prefix services/nas-record-api install` before running tests.

- [ ] **Step 2: Write failing authentication and scope tests**

```ts
test("binds a write token to one device and event", () => {
  const principal = authenticateRequest(headersFor("PC01", WRITE_TOKEN), manifest(), NOW);
  assert.deepEqual(principal, {
    tokenId: "PC01-write",
    deviceId: "PC01",
    eventId: "geumcheon-science-festival-2026",
    role: "writer",
    allowedSessions: ["official", "practice"]
  });
  assert.throws(() => authenticateRequest(headersFor("PC02", WRITE_TOKEN), manifest(), NOW), /DEVICE_SCOPE/);
});

test("limits a token to burst 120 and refills 60 per minute", () => {
  const limiter = new TokenBucketLimiter({ capacity: 120, refillPerSecond: 1 });
  for (let index = 0; index < 120; index += 1) assert.equal(limiter.consume("PC01-write", 0).allowed, true);
  assert.equal(limiter.consume("PC01-write", 0).allowed, false);
  assert.equal(limiter.consume("PC01-write", 1000).allowed, true);
});

test("keeps the shared-IP limiter auxiliary and above normal ten-PC traffic", () => {
  const limiter = new AuxiliaryIpLimiter({ capacity: 2400, refillPerSecond: 40 });
  for (let index = 0; index < 2400; index += 1) assert.equal(limiter.consume("proxy-peer", 0).allowed, true);
  assert.equal(limiter.consume("proxy-peer", 0).allowed, false);
});
```

- [ ] **Step 3: Implement strict configuration contracts**

```ts
export type NasServerConfigV1 = {
  schemaVersion: 1;
  eventId: "geumcheon-science-festival-2026";
  dataRoot: string;
  recordBaseFolderName: "기록저장";
  stageTextCatalogPath: string;
  allowedSessions: {
    official: Array<{ sessionId: string; dayNo: number; roundNo: number }>;
    practice: { sessionId: string };
  };
  aiRanges: {
    official: [[150, 200], [200, 250], [250, 300]];
    practice: [[100, 150], [150, 200], [200, 250]];
  };
};

export type TokenManifestV1 = {
  manifestVersion: 1;
  eventId: "geumcheon-science-festival-2026";
  tokens: Array<{
    tokenId: string;
    tokenHash: string;
    deviceId: string;
    role: "writer" | "leaderboard" | "operator";
    allowedSessions: Array<"official" | "practice">;
    expiresAt: string;
    revokedAt: string | null;
  }>;
};
```

Load paths only from `NAS_EVENT_CONFIG`, `NAS_TOKEN_MANIFEST`, `NAS_DATA_ROOT`, and `NAS_PARTICIPANT_HMAC_KEY_FILE`. Reject unknown config keys, duplicate token IDs/hashes, non-hex hashes, missing/short HMAC material, unknown sessions, and files writable by an unintended service identity where the platform exposes permissions. Never accept plaintext tokens in configuration.

- [ ] **Step 4: Implement constant-time authentication and limiter**

Hash the supplied 256-bit token, compare fixed-length hash buffers with `crypto.timingSafeEqual`, then validate expiration/revocation, event, device header, role, and session scope. The per-token bucket is the operational limit; add a high-ceiling shared-peer auxiliary bucket of 2,400 burst and 40 requests/second solely as flood protection, never as identity or authorization. Return stable codes `AUTH_MISSING`, `AUTH_INVALID`, `AUTH_EXPIRED`, `AUTH_REVOKED`, `DEVICE_SCOPE`, `ROLE_SCOPE`, or `SESSION_SCOPE`; never echo a header, address, or token.

- [ ] **Step 5: Write failing semantic validation tests**

Test exact phrase ID/version/text agreement, stage order without gaps, real calendar date, Korean mobile number normalization, consent, official/practice AI ranges, finite positive timing, `typed_text` as an exact prefix of `target_text`, result/status agreement, additional-field rejection, and a canonical body below 32 KiB.

```ts
const stored = validateAndNormalizeRecord(validEnvelope(), principal("PC01"), config(), RECEIVED_AT);
assert.equal(stored.record.total_typing_units, countConvertedTypingUnits(stored.record.stages[0].typed_text));
assert.equal(stored.record.total_user_time_ms, stored.record.stages[0].user_time_ms);
assert.equal(stored.record.effective_cpm_numerator, stored.record.total_typing_units * 60_000);
assert.equal(stored.record.authenticated_device_id, "PC01");
```

- [ ] **Step 6: Implement server-side recalculation**

Build `StoredNasRecordV1` from validated fields, derive phone/birth masks, HMAC-SHA256 participant key from normalized phone, typing units from each `typed_text`, total user time from stage times, exact CPM numerator/denominator, received time, authenticated device ID, and canonical payload hash. Ignore/reject client-supplied derivatives. Require three `USER_WIN` stages for `success`; allow only the completed prefix plus current losing/interrupted stage otherwise.

- [ ] **Step 7: Run focused service tests**

Run: `npm --prefix services/nas-record-api exec -- tsx --test test/auth.test.ts test/recordSchema.test.ts`

Expected: PASS with write/read/operator separation, rate limits, date/phone/phrase/AI/time checks, and no raw derivative trust.

- [ ] **Step 8: Commit**

```text
feat: validate authenticated NAS records
```

---

### Task 3: Idempotent No-Replace Storage and Record Routes

**Files:**

- Create: `services/nas-record-api/src/atomicStore.ts`
- Create: `services/nas-record-api/src/recordStore.ts`
- Create: `services/nas-record-api/src/app.ts`
- Create: `services/nas-record-api/src/cli.ts`
- Create: `services/nas-record-api/test/recordStore.test.ts`
- Create: `services/nas-record-api/test/routes.test.ts`

**Interfaces:**

- Consumes authenticated principals and `StoredNasRecordV1` from Task 2.
- Produces `writeFileNoReplaceAtomic(targetPath, bytes)`, `RecordStore.put(record)`, `buildNasApp(dependencies)`, `POST /api/v1/records`, and `GET /health`.
- `RecordStore.put` returns `{ disposition, recordId, payloadSha256, storedSha256, receivedAt }` and never exposes the resolved NAS path through the API.

- [ ] **Step 1: Write failing atomic/idempotency tests**

```ts
test("publishes one file for concurrent identical requests", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => store.put(validStoredRecord())));
  assert.equal(results.filter((item) => item.disposition === "stored").length, 1);
  assert.equal(results.filter((item) => item.disposition === "duplicate").length, 19);
  assert.equal(findIncomingJsonFiles(tempRoot).length, 1);
});

test("never replaces an existing ID with different content", async () => {
  await store.put(validStoredRecord());
  await assert.rejects(() => store.put(validStoredRecord({ participantName: "다른값" })), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(readStoredRecord(tempRoot), validStoredRecord());
});
```

- [ ] **Step 2: Run focused tests and verify missing storage failure**

Run: `npm --prefix services/nas-record-api exec -- tsx --test test/recordStore.test.ts`

Expected: FAIL because `atomicStore.ts` and `recordStore.ts` do not exist.

- [ ] **Step 3: Implement no-replace atomic publication**

Resolve and validate the session directory first. Require the resolved final parent to equal the calculated incoming directory exactly. Create a unique same-filesystem temp file with `wx` and mode `0600`, write canonical bytes, call file `sync()`, close, publish with `fs.link()` so an existing target cannot be overwritten, unlink the temp file, then open and sync the directory. On `EEXIST`, remove only the temp file, validate the existing stored document and compare `payload_sha256`; return duplicate only for the same hash. Treat corrupt/empty existing files as `STORAGE_CORRUPT` and preserve them.

- [ ] **Step 4: Implement exact server paths and record route**

```text
official: <dataRoot>/기록저장/<dayNo>일차/<roundNo>회차/incoming/ai/<record_id>.json
practice: <dataRoot>/기록저장/연습회차/incoming/ai/<record_id>.json
```

Require `Authorization`, `X-Device-Id`, `Idempotency-Key`, and JSON content type. Require the idempotency header to equal the body ID. Configure Fastify body limit `32 * 1024`, no CORS plugin, safe request serializers, and schema `additionalProperties:false`. Return `201 stored`, `200 duplicate`, `409 conflict`, `401/403`, `413`, `422`, `429` with `Retry-After`, or `503`; all errors use `{ schema_version:1, code:string, message:string }` without request content.

- [ ] **Step 5: Implement minimal health/readiness route**

`GET /health` returns only `{ "status":"ok" }` when configuration/token catalog/HMAC are loaded and the data root passes a same-directory temp-create/fsync/unlink check. Return `503 {"status":"unavailable"}` otherwise; do not expose paths, OS errors, NAS model, tokens, or participant counts.

- [ ] **Step 6: Test response-loss retry and restart durability**

Store a request without consuming its response, construct a new app/store over the same temp root, resend it, and assert `200 duplicate`, the same `payload_sha256`, one final JSON file, and no temp files. Inject write/link/sync faults at each boundary and assert pending/corrupt evidence is never reported as a completed new save.

- [ ] **Step 7: Run service tests and typecheck**

Run: `npm --prefix services/nas-record-api test`

Expected: all current service tests PASS.

Run: `npm --prefix services/nas-record-api run typecheck`

Expected: PASS without importing Electron or renderer modules.

- [ ] **Step 8: Commit**

```text
feat: store NAS records without overwrite
```

---

### Task 4: Masked Leaderboard and Append-Only Visibility Actions

**Files:**

- Create: `services/nas-record-api/src/leaderboardService.ts`
- Create: `services/nas-record-api/src/operatorActionStore.ts`
- Create: `services/nas-record-api/test/leaderboard.test.ts`
- Create: `services/nas-record-api/test/operatorActions.test.ts`
- Modify: `services/nas-record-api/src/app.ts`

**Interfaces:**

- Consumes stored records, `calculateEffectiveCpm`, `compareGeumcheonRecords`, `assignOfficialAttemptEligibility`, `selectBestEligibleRecordPerParticipant`, and token principals.
- Produces `LeaderboardService.getSnapshot(session)`, `OperatorActionStore.setVisibility(action)`, `GET /api/v1/leaderboard`, and `POST /api/v1/operator/visibility`.
- Electron Task 7 consumes only `NasLeaderboardSnapshotV1`; it never receives `StoredNasRecordV1`.

- [ ] **Step 1: Write failing masking, attempt, and ranking tests**

```ts
test("returns one masked best record from the first three official attempts", async () => {
  seedOfficialAttempts(store, fourAttemptsForOnePhone());
  const snapshot = await leaderboard.getSnapshot(officialSession());
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].attempt_number <= 3, true);
  assert.equal(snapshot.entries[0].display_name.includes("테스트참가자"), false);
  assert.equal(snapshot.entries[0].phone_masked.includes("00000000"), false);
  assert.equal(JSON.stringify(snapshot).includes("participant_key"), false);
});

test("ranks 700 CPM above a 10-second 600 CPM attempt", async () => {
  const snapshot = await leaderboard.getSnapshot(sessionWith600And700());
  assert.equal(snapshot.entries[0].display_cpm, 700);
});
```

- [ ] **Step 2: Implement masked ETag snapshots**

Return only:

```ts
export type NasLeaderboardEntryV1 = {
  rank: number;
  record_id: string;
  display_name: string;
  phone_masked: string;
  display_cpm: number;
  total_user_time_ms: number;
  completed_at: string;
  result_stage: number;
  attempt_number: number;
};
```

Group by server HMAC participant key, exclude test/debug entries, order official attempts by `received_at` then `record_id`, admit only the first three, and select the best admitted record. Practice uses the best record from all valid practice attempts. Compare exact integer numerator/denominator with `BigInt`; round only `display_cpm`. Cache snapshots per session in memory and invalidate only after record/action publication. Hash canonical public JSON for ETag and return `304` when `If-None-Match` matches. Always set `Cache-Control: no-store`.

- [ ] **Step 3: Write failing append-only action tests**

```ts
test("hides and unhides without changing the record file", async () => {
  const before = await fs.readFile(recordPath);
  await actions.setVisibility(hideAction(RECORD_ID));
  assert.equal((await leaderboard.getSnapshot(session())).entries.length, 0);
  await actions.setVisibility(unhideAction(RECORD_ID));
  assert.equal((await leaderboard.getSnapshot(session())).entries.length, 1);
  assert.deepEqual(await fs.readFile(recordPath), before);
});
```

- [ ] **Step 4: Implement the operator route and stable action order**

`POST /api/v1/operator/visibility` requires operator role, `X-Device-Id: LEADERBOARD01`, and `Idempotency-Key` equal to `action.action_id`. Validate `action_id` as `gsc26-action-<UUID v4>`, record ID/session existence, `hidden:boolean`, and no arbitrary reason/name fields. Store under the calculated session `admin_actions/<action_id>.json` with authenticated device, canonical action hash, and server-assigned monotonic `applied_at`; use the Task 3 no-replace primitive. Identical action ID/body returns duplicate, changed content returns 409. Apply the newest `(applied_at, action_id)` state per record.

- [ ] **Step 5: Prove permission and public-field boundaries**

Test writer cannot GET leaderboard or POST visibility, leaderboard token cannot POST records/actions, operator token cannot GET raw records, and no raw-record/CSV/edit/delete route exists. Assert query/body unknown keys are rejected and both official/practice scopes are enforced.

- [ ] **Step 6: Run focused route tests**

Run: `npm --prefix services/nas-record-api exec -- tsx --test test/leaderboard.test.ts test/operatorActions.test.ts`

Expected: PASS for ETag/304/no-store, masking, first-three gate, exact ranking, practice isolation, hide/unhide, idempotency, and role separation.

- [ ] **Step 7: Commit**

```text
feat: serve masked NAS leaderboards and visibility actions
```

---

### Task 5: DPAPI Credential Store and Encrypted Outbox

**Files:**

- Create: `electron/nas/dataProtector.ts`
- Create: `electron/nas/credentialStore.ts`
- Create: `electron/nas/outbox.ts`
- Create: `tests/nas-client/credentialStore.test.ts`
- Create: `tests/nas-client/outbox.test.ts`
- Modify: `shared/csv/fileStore.ts`
- Modify: `.gitignore`

**Interfaces:**

- Consumes validated `DeviceProfile`, device runtime root, `bootstrap-credentials.json`, `NasRecordEnvelopeV1`, and `buildNasRecordEnvelope`.
- Produces `DataProtector`, `CredentialStore`, `NasOutbox`, and an optional NAS enqueue callback for `saveRecord`.
- Task 6 may decrypt a pending entry or the one needed token only inside Electron main; renderer code must have no import path to these modules.

- [ ] **Step 1: Write failing one-time credential ingestion tests**

```ts
test("encrypts, verifies, and removes bootstrap credentials", async () => {
  const store = new CredentialStore(paths, fakeProtector());
  await store.initialize(profile("PC01"));
  assert.equal(await exists(paths.bootstrapCredentials), false);
  assert.equal(await exists(paths.encryptedCredentials), true);
  assert.equal((await store.get()).tokens.write, WRITE_TOKEN);
  assert.equal((await fs.readFile(paths.encryptedCredentials)).includes(Buffer.from(WRITE_TOKEN)), false);
});

test("blocks when encrypted and bootstrap identities disagree", async () => {
  await seedEncryptedCredentials(paths, credentials("PC01"));
  await seedBootstrapCredentials(paths, credentials("PC02"));
  await assert.rejects(() => store.initialize(profile("PC01")), /CREDENTIAL_IDENTITY_MISMATCH/);
});
```

- [ ] **Step 2: Implement the injected protector and credential lifecycle**

```ts
export interface DataProtector {
  isAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export type BootstrapCredentialsV1 = {
  schemaVersion: 1;
  eventId: "geumcheon-science-festival-2026";
  deviceId: string;
  tokens: { write?: string; leaderboardRead?: string; operator?: string };
  localAdminPin: string;
};
```

Production adapter uses Electron `safeStorage`. Reject non-Windows production, unavailable encryption, unknown keys, identity/role mismatch, tokens not decoding to 32 bytes, missing role-required tokens, and an empty local PIN. Atomically write `credentials/credentials.safe`, decrypt/read back and compare before removing executable-adjacent `bootstrap-credentials.json`. If deletion fails, report `BOOTSTRAP_DELETE_FAILED` and block NAS readiness. If both files exist, delete the bootstrap only after exact decrypted equality; otherwise block.

- [ ] **Step 3: Write failing encrypted-outbox tests**

```ts
test("persists before upload and only acknowledges matching hash", async () => {
  const queued = await outbox.enqueue(validEnvelope());
  assert.equal((await outbox.counts()).pending, 1);
  assert.equal((await fs.readFile(queued.filePath)).includes(Buffer.from("01000000000")), false);
  await assert.rejects(() => outbox.acknowledge(queued.recordId, "0".repeat(64)), /ACK_HASH_MISMATCH/);
  assert.equal((await outbox.counts()).pending, 1);
  await outbox.acknowledge(queued.recordId, queued.payloadSha256);
  assert.equal((await outbox.counts()).pending, 0);
});
```

- [ ] **Step 4: Implement official/practice outbox state transitions**

Store encrypted `QueuedNasRecordV1 { queue_version:1, queued_at, payload_sha256, body }` under `outbox/official` or `outbox/practice`, named by validated record ID. Use same-directory temp, file sync, no-replace hard-link, temp removal, and directory sync. Same ID/hash is idempotent; same ID/different hash fails without replacement. `quarantine(recordId, "conflict"|"recovery", code)` atomically moves the ciphertext and a non-PII code, never plaintext. `listPending` sorts by `queued_at` then record ID. Do not write failure receipts containing request body, target URL, participant data, or tokens.

- [ ] **Step 5: Integrate enqueue-before-return into `saveRecord`**

Extend `saveRecord(ctx, input, { enqueueNasRecord? })`. When `syncMode === "nas_https"`, create the Geumcheon ID, construct the row and exact fairness envelope, require valid setup/credentials, await encrypted enqueue, and return the row without writing legacy CSV/OneDrive JSON. Do not attempt network I/O inside `fileStore.ts`. Leave `local` and `onedrive_manual` branches byte-for-byte behaviorally equivalent.

- [ ] **Step 6: Run client and legacy persistence tests**

Run: `npx tsx --test tests/nas-client/credentialStore.test.ts tests/nas-client/outbox.test.ts`

Expected: PASS for DPAPI-adapter lifecycle, plaintext absence, bootstrap removal, queue separation, restart recovery, ack guard, conflict/recovery preservation.

Run: `npm run test:logic`

Expected: existing SkillUp local/OneDrive logic PASS.

- [ ] **Step 7: Commit**

```text
feat: protect NAS credentials and outbox with DPAPI
```

---

### Task 6: HTTPS Client and Background Retry Worker

**Files:**

- Create: `electron/nas/apiClient.ts`
- Create: `electron/nas/retryWorker.ts`
- Create: `electron/nas/operationLog.ts`
- Create: `tests/nas-client/apiClient.test.ts`
- Create: `tests/nas-client/retryWorker.test.ts`

**Interfaces:**

- Consumes `DeviceProfile`, decrypted role token access, `NasOutbox`, protocol guards, and injected `fetch`, clock, random, and timer dependencies.
- Produces `NasApiClient.postRecord`, `NasApiClient.getLeaderboard`, `NasApiClient.postVisibility`, `NasApiClient.health`, `NasRetryWorker.start/stop/wake/flushNow/getStatus`, and `appendNasOperation`.
- Task 7 owns process lifecycle and IPC; this task has no renderer imports.

- [ ] **Step 1: Write failing HTTP classification tests**

```ts
test("sends a canonical record without following redirects", async () => {
  const outcome = await client.postRecord(queuedRecord());
  assert.equal(fetchCall.options.redirect, "error");
  assert.equal(fetchCall.options.headers["Idempotency-Key"], RECORD_ID);
  assert.equal(outcome.kind, "ack");
});

test("classifies responses without exposing their body", async () => {
  assert.deepEqual(await outcomeFor(401), { kind: "pause", code: "AUTH_INVALID" });
  assert.deepEqual(await outcomeFor(409), { kind: "quarantine", target: "conflict", code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(await outcomeFor(422), { kind: "quarantine", target: "recovery", code: "RECORD_INVALID" });
  assert.equal((await outcomeFor(503)).kind, "retry");
});
```

- [ ] **Step 2: Implement least-privilege HTTPS calls**

Use global Node/Electron `fetch` with injected test replacement, `redirect:"error"`, `cache:"no-store"`, profile timeout via `AbortController`, standard certificate verification, and no custom agent that disables TLS. Add Bearer token only inside main immediately before the request. POST canonical JSON with exact headers. Parse only bounded JSON success/error shapes and map failures to stable outcome codes; never concatenate response/request bodies, headers, full URL query, or token into an error/log.

Classify `200/201` as ack only after protocol validation; network/timeout/408/425/429/5xx as retry; 401/403 as paused pending; 409 as conflict; 413/422 as recovery; other 4xx as paused configuration error with the encrypted pending item retained. Honor both integer-seconds and HTTP-date `Retry-After` with a one-second minimum and 15-minute cap.

- [ ] **Step 3: Write failing worker sequence tests with fake time**

```ts
test("retries 2, 4, 8 seconds up to 60 seconds and acknowledges only a matching ack", async () => {
  const worker = createWorker({ initialDelayMs: 2000, maxDelayMs: 60000, random: () => 0 });
  api.queueOutcomes(retry503(), retry503(), ackFor(RECORD_ID, PAYLOAD_HASH));
  worker.start();
  await clock.advanceBy(2000);
  await clock.advanceBy(4000);
  assert.equal((await outbox.counts()).pending, 0);
  assert.deepEqual(api.callTimes, [0, 2000, 6000]);
});

test("keeps pending data and stops on an authentication failure", async () => {
  api.queueOutcomes({ kind: "pause", code: "AUTH_INVALID" });
  await worker.flushNow();
  assert.equal(worker.getStatus().state, "paused_auth");
  assert.equal((await outbox.counts()).pending, 1);
});
```

- [ ] **Step 4: Implement one single-flight retry state machine**

Process one pending file at a time. `wake()` collapses concurrent signals and never creates parallel uploads. Start immediately, then use exponential base delay `min(maxDelay, initialDelay * 2^failureCount)` plus deterministic-in-test jitter in `[0, min(1000, base/4)]`. Reset failure count after each ack. A valid ack deletes the one item; retry keeps it; quarantine moves it; pause stops automatic attempts until credentials/config are reinitialized or the app restarts. `stop()` clears timers and aborts the active fetch while preserving the item.

- [ ] **Step 5: Implement non-PII status and logging**

```ts
export type NasSyncStatus = {
  state: "idle" | "uploading" | "waiting_retry" | "paused_auth" | "paused_config" | "stopped";
  deviceId: string;
  pending: number;
  conflict: number;
  recovery: number;
  lastSuccessAt: string;
  lastErrorCode: string;
  nextRetryAt: string;
};
```

Write only these status fields plus action, response status, record ID, byte count, and duration to `logs/operations.ndjson`. Enforce an allowlist serializer; do not accept arbitrary details/error objects/paths. Rotate by size without copying participant data because none is accepted.

- [ ] **Step 6: Run worker tests**

Run: `npx tsx --test tests/nas-client/apiClient.test.ts tests/nas-client/retryWorker.test.ts`

Expected: PASS for timeout, no redirect, ack mismatch retention, 429 Retry-After, exponential retry, single-flight wake, auth pause, quarantine, restart recovery, and stop/abort retention.

- [ ] **Step 7: Commit**

```text
feat: upload NAS outbox with resilient HTTPS retries
```

---

### Task 7: Masked Leaderboard Cache, Administrator Session, Runtime, and IPC

**Files:**

- Create: `electron/nas/leaderboardClient.ts`
- Create: `electron/nas/adminSession.ts`
- Create: `electron/nas/runtime.ts`
- Create: `tests/nas-client/leaderboardClient.test.ts`
- Create: `tests/nas-client/adminSession.test.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `apps/shell/src/global.d.ts`
- Modify: `apps/typing-game/src/AIChallengeGame.tsx`
- Modify: `apps/leaderboard/src/LeaderboardApp.tsx`

**Interfaces:**

- Consumes the Task 1 public snapshot, Task 5 credentials/outbox, Task 6 client/worker, device profile and app variant.
- Produces `NasLeaderboardClient.refresh/getCached`, `AdminSessionStore.create/assert/revokeForWebContents`, `createNasRuntime`, and IPC `sync:getStatus`, `sync:flushNow`, `leaderboard:getSnapshot`, `operator:setVisibility`.
- Renderer receives only `ApiResult<NasSyncStatus>`, `ApiResult<NasLeaderboardView>`, and visibility acknowledgement; it receives no credential accessor, raw stored record, participant key, path, or arbitrary HTTP method.

- [ ] **Step 1: Write failing ETag/offline cache tests**

```ts
test("uses 304 and returns the last valid masked snapshot", async () => {
  api.queueLeaderboard(snapshotResponse(SNAPSHOT, '"etag-1"'), notModified());
  assert.equal((await client.refresh()).source, "network");
  const second = await client.refresh();
  assert.equal(second.source, "not_modified");
  assert.deepEqual(second.snapshot, SNAPSHOT);
});

test("rejects and does not cache a response containing raw PII", async () => {
  api.queueLeaderboard(snapshotResponse({ ...SNAPSHOT, phone_full: "01000000000" }));
  await assert.rejects(() => client.refresh(), /PUBLIC_SNAPSHOT_INVALID/);
  assert.deepEqual(await client.getCached(), PREVIOUS_SNAPSHOT);
});
```

- [ ] **Step 2: Implement strict last-known-good cache**

Write `{ cacheVersion:1, etag, cachedAt, snapshot }` atomically to `leaderboard-cache/official.json` or `leaderboard-cache/practice.json` only after `assertNasLeaderboardSnapshot`. On 304 return cached data. On network/5xx return cached data with `source:"cache"`, `offline:true`, and a stable code; if no cache exists return an empty masked snapshot marked offline. Never cache an error body. Query session is selected by Electron main from variant/profile, not renderer input.

- [ ] **Step 3: Write failing administrator-session tests**

```ts
test("binds a five-minute session to one renderer", () => {
  const session = sessions.create({ webContentsId: 7, adminName: "admin", now: 0 });
  assert.doesNotThrow(() => sessions.assert(session.id, 7, 299_999));
  assert.throws(() => sessions.assert(session.id, 8, 1), /ADMIN_SESSION_INVALID/);
  assert.throws(() => sessions.assert(session.id, 7, 300_001), /ADMIN_SESSION_EXPIRED/);
});
```

- [ ] **Step 4: Implement main-only administrator and NAS runtime composition**

Store random 256-bit administrator session IDs only in main memory, bind them to `webContents.id`, expire after five minutes, and revoke on renderer destruction/administrator logout. For Geumcheon, `admin:validate` compares the credential-store local PIN and returns `{ adminName, adminSessionId, expiresAt }`; it never returns the PIN. `operator:setVisibility` revalidates the session, creates `gsc26-action-UUIDv4`, and uses the separate operator token. Disable existing Geumcheon record edit/delete/clear/raw CSV operations with `NAS_OPERATION_NOT_ALLOWED`; retain SkillUp behavior.

`createNasRuntime` must validate profile/credentials, construct the outbox/client/worker/cache, expose narrow methods, start the worker for player variants, and stop/abort it on `before-quit`. Geumcheon start readiness requires encrypted credentials, correct role token, valid HTTPS profile, and writable encrypted outbox; internet/NAS unavailability does not block a new game after local readiness succeeds.

- [ ] **Step 5: Wire least-privilege preload and renderer types**

Expose exactly:

```ts
getNasSyncStatus(): Promise<ApiResult<NasSyncStatus>>;
flushNasOutbox(): Promise<ApiResult<NasSyncStatus>>;
getNasLeaderboard(): Promise<ApiResult<NasLeaderboardView>>;
setNasRecordVisibility(
  input: { recordId: string; hidden: boolean; adminSessionId: string }
): Promise<ApiResult<{ actionId: string; disposition: "stored" | "duplicate" }>>;
```

Do not expose base URL, tokens, credential file, raw fetch, arbitrary path, arbitrary action body, or server errors. Validate every IPC argument again in main.

- [ ] **Step 6: Update player and leaderboard UX without changing the ranking formula**

After an accepted Geumcheon save show “이 PC에 안전하게 저장됨” independently from worker state. Poll non-PII sync status and show “NAS 반영 완료”, “NAS 반영 대기 N건”, authentication pause, or recovery/conflict count. Never tell the participant their record was lost when it is still queued.

Geumcheon leaderboards render the server-provided masked/ranked entries, preserve all rows with vertical scrolling, show the last-success time/offline stale indicator, and never unmask in administrator mode. Replace Geumcheon edit/delete controls with hide/unhide; require a fresh local administrator session. Keep existing SkillUp leaderboard editing/export UI unchanged.

- [ ] **Step 7: Run focused client tests and build**

Run: `npx tsx --test tests/nas-client/leaderboardClient.test.ts tests/nas-client/adminSession.test.ts`

Expected: PASS for ETag, 304, offline fallback, corrupt/PII cache rejection, official/practice isolation, renderer binding, timeout, and logout.

Run: `npm run build`

Expected: Electron main/preload and React renderer compile with no token-bearing type exposed globally.

- [ ] **Step 8: Commit**

```text
feat: wire masked NAS leaderboard and operator sessions
```

---

### Task 8: PII Boundary, Container, and Full Regression Gates

**Files:**

- Create: `services/nas-record-api/test/piiBoundary.test.ts`
- Create: `tests/nas-client/piiBoundary.test.ts`
- Create: `services/nas-record-api/Dockerfile`
- Modify: `services/nas-record-api/package.json`
- Modify: `package.json`
- Modify: `scripts/scan-pii.mjs`
- Modify: `.gitignore`

**Interfaces:**

- Produces stable commands `test:nas-client`, `test:nas-api`, `build:nas-api`, and an unprivileged Node 24 container image consumed by the separate Synology deployment plan.
- Produces evidence for code/package readiness only; it does not mark real NAS/external-network deployment complete.

- [ ] **Step 1: Write failing end-to-end PII-boundary tests**

Use synthetic markers `참가자민감표식`, `01000000000`, `2001-01-01`, and a 256-bit test token. Submit a record, fetch the leaderboard, inspect captured API logs, Electron operation logs, cache bytes, encrypted credential bytes, outbox bytes, IPC output, and error responses.

Assert:

```ts
for (const surface of [apiLog, operationLog, publicJson, cacheJson, ipcJson, errorJson]) {
  assert.equal(surface.includes("01000000000"), false);
  assert.equal(surface.includes("2001-01-01"), false);
  assert.equal(surface.includes(TEST_TOKEN), false);
}
assert.equal(encryptedOutbox.includes(Buffer.from("참가자민감표식")), false);
assert.equal(encryptedCredentials.includes(Buffer.from(TEST_TOKEN)), false);
```

The stored NAS record is the one authorized raw-PII surface and must have file mode `0600` in Linux/container tests.

- [ ] **Step 2: Add full protocol/permission/recovery integration cases**

Cover PC01 and PC10 success, PC02 using PC01 token rejection, writer/read/operator cross-role rejection, malformed date/phone/text ID/text body/AI range/time/additional fields/body size, same-ID same-body duplicate, same-ID different-body conflict, 401/403 stop, 429 Retry-After, 5xx backoff, response-loss retry, app restart, API restart, official/practice separation, hide/unhide, CSV-formula nickname staying inert because no public CSV endpoint, and queue deletion only after matching ack.

- [ ] **Step 3: Create the non-root Node 24 image**

Use a multi-stage `node:24-bookworm-slim` Dockerfile. Build the bundled server in the builder stage; install production dependencies from the service lockfile; copy only `dist`, production `node_modules`, and package metadata into the runtime stage; run as `node`; expose only internal `8787`; declare `/tmp` writable expectation; add a Node-based health check against `http://127.0.0.1:8787/health`. Do not bake configs, token hashes, HMAC secrets, records, certificates, or real paths into the image. The deployment plan applies `read_only`, `no-new-privileges`, `unless-stopped`, read-only config/secret mounts, and loopback-only host binding.

- [ ] **Step 4: Add deterministic root commands**

```json
"test:nas-api": "npm --prefix services/nas-record-api test",
"build:nas-api": "npm --prefix services/nas-record-api run build"
```

Keep the explicit file list in `test:nas-client` so Windows does not depend on shell glob expansion. Update PII scanning and ignore rules for `bootstrap-credentials.json`, `credentials.safe`, `outbox/`, `leaderboard-cache/`, `operations.ndjson`, NAS config/token/HMAC files, service coverage, and container output. Do not ignore the safe `.example.json` files owned by the deployment plan.

- [ ] **Step 5: Run all automated gates**

Run:

```powershell
npm run test:nas-client
npm run test:nas-api
npm --prefix services/nas-record-api run typecheck
npm run build:nas-api
npm run test:geumcheon:client
npm run test:logic
npm run build
npm run scan:pii
npm audit
npm --prefix services/nas-record-api audit
```

Expected: all commands exit 0, both audits report zero known vulnerabilities, and the PII tests find zero forbidden values outside the authorized raw NAS record test file.

- [ ] **Step 6: Build and smoke-test the container where Docker is available**

Run:

```powershell
docker build -f services/nas-record-api/Dockerfile -t typingking-nas-api:geumcheon-test .
```

Start it only with synthetic temporary config, token hashes, HMAC secret, and data root; assert `/health`, one record POST, duplicate POST, masked leaderboard GET, hide/unhide, restart persistence, non-root UID, and no secrets in image history. If Docker is unavailable, record this gate as unrun rather than PASS.

- [ ] **Step 7: Recheck Git scope and secret absence**

Run:

```powershell
git status --short
git diff --check
git diff --name-only main...HEAD
git grep -n -E "0208|Authorization: Bearer [A-Za-z0-9_-]{20,}|010-[0-9]{4}-[0-9]{4}" -- . ":(exclude)package-lock.json"
```

Expected: only approved implementation/test/doc files are changed; no actual profiles, bootstrap credentials, runtime queues, records, logs, release artifacts, NAS environment, plaintext tokens, or real participant data are tracked. Do not push.

- [ ] **Step 8: Commit**

```text
test: enforce NAS sync privacy and recovery gates
```

---

## Plan Self-Review Checklist

- [ ] Every spec requirement for HTTPS record submission, DPAPI outbox, scoped tokens, strict validation, idempotent atomic storage, masked leaderboard, ETag/cache, append-only visibility, retry policy, PII logging, and queue retention maps to a task above.
- [ ] Official/practice paths and tokens remain separate in server, outbox, cache, queries, and tests.
- [ ] All later interfaces use the exact Task 1 names and the client-foundation `DeviceProfile`/fairness contracts.
- [ ] There are no placeholder implementation steps; unresolved real NAS facts are explicitly deployment gates rather than guessed values.
- [ ] Existing SkillUp local/OneDrive behavior has an explicit regression command after each persistence/IPC integration boundary.
- [ ] Completion language distinguishes source/unit/container evidence from DSM/reverse-proxy/external-Wi-Fi evidence.
