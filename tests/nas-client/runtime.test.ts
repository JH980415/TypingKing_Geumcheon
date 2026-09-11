import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGeumcheonNasRuntime,
  type GeumcheonLocalCallbacks,
} from "../../electron/nas/runtime";
import { payloadSha256 } from "../../shared/nas/protocol";
import type { DeviceProfile, EventProfile, RecordRow, SaveRecordInput } from "../../shared/types";
import type { SafeStorageAdapter } from "../../electron/nas/credentialStore";
import type { FetchLike } from "../../electron/nas/apiClient";
import { createChallengeSaveInput } from "../../apps/typing-game/src/AIChallengeGame";
import { buildRecordRow } from "../../shared/csv/fileStore";
import { RecordStore } from "../../services/nas-record-api/src/recordStore";
import { listGeumcheonRecords } from "../../electron/geumcheonConnection";

const recordId = "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000";
const attemptId = "gsc26-attempt-123e4567-e89b-42d3-a456-426614174000";

function safeStorage(): SafeStorageAdapter {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

function event(): EventProfile {
  return { profileId: "geumcheon-2026", nasEventId: "geumcheon-science-festival-2026" } as EventProfile;
}

function device(role: "player" | "leaderboard" = "player"): DeviceProfile {
  return {
    schemaVersion: 1,
    eventProfileId: "geumcheon-2026",
    eventId: "geumcheon-science-festival-2026",
    deviceId: role === "player" ? "PC01" : "LEADERBOARD01",
    role,
    apiBaseUrl: "https://records.example.test",
    sessions: { official: { sessionId: "official-1", dayNo: 1, roundNo: 2 }, practice: { sessionId: "practice-1" } },
    requestTimeoutMs: 1_000,
    retry: { initialDelayMs: 10, maxDelayMs: 40 },
  };
}

function input(): SaveRecordInput {
  return {
    participant_name: "합성참가자",
    phone_part1: "010",
    phone_part2: "0000",
    phone_part3: "0001",
    birth_year: "2014",
    birth_month: "1",
    birth_day: "2",
    privacy_agreed: true,
    privacy_agreed_at: "2026-09-18T01:00:00.000Z",
    stageTexts: ["첫 문장", "둘째 문장", "셋째 문장"],
    stageTimesMs: [1_000, 0, 0],
    game_mode: "ai_challenge",
    interruption: { action: "retry", resultStage: 1, participantProgressPercent: 40, stageCharCounts: [4, 0, 0], totalTypingUnits: 8 },
  };
}

function row(id = recordId): RecordRow {
  return { record_id: id, participant_name: "합성참가자", phone_full: "01000000001", final_cpm: "321", game_mode: "ai_challenge" } as RecordRow;
}

function localCallbacks(persistLocal: GeumcheonLocalCallbacks["persist"]) {
  let readCalls = 0;
  let adminCalls = 0;
  return {
    callbacks: {
      persist: persistLocal,
      read: async () => { readCalls += 1; return []; },
      admin: {
        edit: async () => { adminCalls += 1; },
        hide: async () => { adminCalls += 1; },
        resetSession: async () => { adminCalls += 1; },
      },
    },
    get readCalls() { return readCalls; },
    get adminCalls() { return adminCalls; },
  };
}

test("checkpoints and saves one official RecordRow into encrypted outbox, then flushes it", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "typingking-nas-runtime-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const encryption = safeStorage();
  const persistedIds: string[] = [];
  const persistedIdentities: unknown[] = [];
  let uploaded: any;
  const fetch: FetchLike = async (_url, init) => {
    uploaded = JSON.parse(String(init?.body));
    const hash = payloadSha256(uploaded);
    return new Response(JSON.stringify({ schema_version: 1, disposition: "stored", record_id: uploaded.row.record_id, payload_sha256: hash, stored_sha256: hash, received_at: "2026-09-18T01:03:00.000Z" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const local = localCallbacks(async (_value, id, identity) => {
    persistedIds.push(id);
    persistedIdentities.push(identity);
    return row(id);
  });
  const runtime = createGeumcheonNasRuntime({
    event: event(), device: device(), sessionKind: "official", runtimeRoot, safeStorage: encryption, fetch,
    local: local.callbacks,
    createAttemptIdentity: () => ({ recordId, attemptId }),
    createActionId: () => "gsc26-action-123e4567-e89b-42d3-a456-426614174000",
    now: () => "2026-09-18T01:02:00.000Z", sleep: async () => undefined,
  });
  await runtime.importToken(crypto.randomBytes(32).toString("hex"));

  const checkpoint = await runtime.checkpoint(input());
  const saved = await runtime.save(input());

  assert.equal(saved.record_id, checkpoint.recordId);
  assert.deepEqual(persistedIds, [recordId]);
  assert.deepEqual(persistedIdentities, [{
    recordId,
    attemptId,
    deviceId: "PC01",
    recordedAt: "2026-09-18T01:02:00.000Z",
  }]);
  const pendingDir = path.join(runtimeRoot, "nas", "outbox", "official", "pending");
  assert.deepEqual(await readdir(pendingDir), [`${recordId}.bin`]);
  assert.equal((await readFile(path.join(pendingDir, `${recordId}.bin`))).includes(Buffer.from("합성참가자")), false);
  assert.deepEqual(await runtime.queueStatus(), { pending: 1, blocked: 0 });
  const flush = await runtime.flush();
  assert.equal(flush.sent, 1);
  assert.equal(uploaded.row.record_id, recordId);
  assert.deepEqual(uploaded.session, { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 });
  assert.deepEqual(await readdir(pendingDir), []);
  assert.deepEqual(await runtime.queueStatus(), { pending: 0, blocked: 0 });
});

test("official-only runtime rejects requested practice before any network or persistence", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "typingking-nas-official-only-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const configured = device();
  const common = {
    event: event(), device: { ...configured, sessions: { official: configured.sessions.official } } as DeviceProfile,
    runtimeRoot, safeStorage: safeStorage(),
    fetch: (async () => { throw new Error("unexpected network"); }) as FetchLike,
    local: localCallbacks(async () => { throw new Error("unexpected persistence"); }).callbacks,
  };
  assert.doesNotThrow(() => createGeumcheonNasRuntime({ ...common, sessionKind: "official" }));
  assert.throws(() => createGeumcheonNasRuntime({ ...common, sessionKind: "practice" }), /^Error: NAS_PRACTICE_SESSION_NOT_CONFIGURED$/);
  assert.deepEqual(await readdir(runtimeRoot), []);
});

test("recovers a practice checkpoint into practice outbox with the same stable record ID", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "typingking-nas-runtime-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const encryption = safeStorage();
  const local = localCallbacks(async (_value, id) => row(id));
  const common = { event: event(), device: device(), sessionKind: "practice" as const, runtimeRoot, safeStorage: encryption, fetch: (async () => { throw new Error("unused"); }) as FetchLike, local: local.callbacks, now: () => "2026-09-18T01:02:00.000Z", sleep: async () => undefined };
  const first = createGeumcheonNasRuntime({
    ...common,
    createAttemptIdentity: () => ({ recordId, attemptId }),
    createActionId: () => "gsc26-action-123e4567-e89b-42d3-a456-426614174000",
  });
  await first.checkpoint(input());
  const restarted = createGeumcheonNasRuntime({
    ...common,
    createAttemptIdentity: () => { throw new Error("must reuse checkpoint identity"); },
    createActionId: () => "gsc26-action-123e4567-e89b-42d3-a456-426614174000",
  });

  const recovered = await restarted.recover();

  assert.equal(recovered?.record_id, recordId);
  assert.deepEqual(await readdir(path.join(runtimeRoot, "nas", "outbox", "practice", "pending")), [`${recordId}.bin`]);
});

test("isolates simultaneous official and practice active checkpoints under one device runtime root", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "typingking-nas-runtime-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const encryption = safeStorage();
  const local = localCallbacks(async (_value, id) => row(id));
  const common = { event: event(), device: device(), runtimeRoot, safeStorage: encryption, fetch: (async () => { throw new Error("unused"); }) as FetchLike, local: local.callbacks, createActionId: () => "gsc26-action-123e4567-e89b-42d3-a456-426614174000", now: () => "2026-09-18T01:02:00.000Z", sleep: async () => undefined };
  const official = createGeumcheonNasRuntime({
    ...common,
    sessionKind: "official",
    createAttemptIdentity: () => ({ recordId, attemptId }),
  });
  const practice = createGeumcheonNasRuntime({
    ...common,
    sessionKind: "practice",
    createAttemptIdentity: () => ({
      recordId: "gsc26-pc01-123e4567-e89b-42d3-a456-426614174001",
      attemptId: "gsc26-attempt-123e4567-e89b-42d3-a456-426614174001",
    }),
  });

  await official.checkpoint(input());
  await practice.checkpoint(input());

  await Promise.all([
    access(path.join(runtimeRoot, "nas", "active-attempt-official.bin")),
    access(path.join(runtimeRoot, "nas", "active-attempt-practice.bin")),
  ]);
});

test("leaderboard reads only NAS full RecordRow snapshot and falls back to last-known-good without exposing token", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "typingking-nas-runtime-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const leaderboardToken = "a".repeat(64);
  const operatorToken = "b".repeat(64);
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (requests.length > 2) throw new Error("offline");
    if (String(url).includes("/api/v1/ready?")) {
      return new Response(JSON.stringify({
        schema_version: 1,
        status: "ready",
        event_id: "geumcheon-science-festival-2026",
        device_id: "LEADERBOARD01",
        role: "leaderboard",
        session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ schema_version: 1, event_id: "geumcheon-science-festival-2026", session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 }, generated_at: "2026-09-18T01:03:00.000Z", rows: [row()] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const local = localCallbacks(async () => { throw new Error("leaderboard must not persist"); });
  const runtime = createGeumcheonNasRuntime({ event: event(), device: device("leaderboard"), sessionKind: "official", runtimeRoot, safeStorage: safeStorage(), fetch, local: local.callbacks, createRecordId: () => recordId, createActionId: () => "gsc26-action-123e4567-e89b-42d3-a456-426614174000", now: () => "2026-09-18T01:02:00.000Z", sleep: async () => undefined });
  const scopedRuntime = runtime as typeof runtime & {
    importLeaderboardToken?(token: string): Promise<void>;
    importOperatorToken?(token: string): Promise<void>;
  };
  assert.equal(typeof scopedRuntime.importLeaderboardToken, "function");
  assert.equal(typeof scopedRuntime.importOperatorToken, "function");
  await scopedRuntime.importLeaderboardToken?.(leaderboardToken);
  await scopedRuntime.importOperatorToken?.(operatorToken);

  const live = await runtime.loadRecords();
  const cached = await runtime.loadRecords();
  // Search must report the fresh-read failure; the no-argument fallback above remains intact.
  await assert.rejects((runtime.loadRecords as (options?: { freshOnly: boolean }) => Promise<unknown>)({ freshOnly: true }));

  assert.equal(live.rows[0].phone_full, "01000000001");
  assert.deepEqual(cached, live);
  assert.equal(local.readCalls, 0);
  assert.equal("getToken" in runtime, false);
  assert.equal(requests[0].url.includes("/api/v1/ready?"), true);
  assert.equal(requests[1].url.includes("/api/v1/records?"), true);
  assert.equal(requests.every((request) => request.authorization === `Bearer ${leaderboardToken}`), true);
  await access(path.join(runtimeRoot, "nas", "leaderboard-token.bin"));
  await access(path.join(runtimeRoot, "nas", "operator-token.bin"));
  await assert.rejects(() => access(path.join(runtimeRoot, "nas", "device-token.bin")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(() => runtime.checkpoint(input()), /NAS_ROLE_FORBIDDEN/);
});

for (const failure of ["authorization", "identity", "records", "malformed"] as const) {
  test("fresh protected search rejects " + failure + " after a cached success without query metadata on the NAS wire", async (context) => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "uiv3-search-nas-"));
    context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
    let failing = false;
    const requests: Array<{ url: string; method: string | undefined; authorization: string | null; body: unknown }> = [];
    const session = { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 };
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const runtime = createGeumcheonNasRuntime({ event: event(), device: device("leaderboard"), sessionKind: "official",
      runtimeRoot, safeStorage: safeStorage(), local: localCallbacks(async () => { throw Error("must not persist"); }).callbacks,
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method, authorization: new Headers(init?.headers).get("authorization"), body: init?.body });
        if (String(url).includes("/ready?")) {
          if (failing && failure === "authorization") return response({ error: "private body must not escape" }, 401);
          return response({ schema_version: 1, status: "ready", event_id: "geumcheon-science-festival-2026",
            device_id: "LEADERBOARD01", role: failing && failure === "identity" ? "operator" : "leaderboard", session });
        }
        if (failing && failure === "records") return response({ error: "private body must not escape" }, 500);
        if (failing && failure === "malformed") return response({ rows: "invalid" });
        return response({ schema_version: 1, event_id: "geumcheon-science-festival-2026", session,
          generated_at: "2026-09-10T00:00:00.000Z", rows: [row()] });
      } });
    const listOptions = { connection: { source: "production" as const, runtime }, role: "leaderboard" as const,
      eventProfileId: "geumcheon-2026", sessionKind: "official", readLegacy: () => { throw Error("must not read legacy"); },
      request: { search: { field: "contact", term: "0000" } } };
    await assert.rejects(listGeumcheonRecords(listOptions), /^Error: NAS_CREDENTIAL_MISSING$/);
    assert.equal(requests.length, 0, "missing credential must prevent any request");
    await runtime.importLeaderboardToken("c".repeat(64));
    const live = await listGeumcheonRecords(listOptions);
    assert.deepEqual(live.matchingRecordIds, [recordId]);
    assert.equal(requests.length, 2, "one readiness probe and one full records fetch supply the atomic result");
    failing = true;
    await assert.rejects(listGeumcheonRecords(listOptions));
    assert.deepEqual((await runtime.loadRecords()).rows, live.rows, "legacy fallback stays available");
    for (const request of requests) {
      assert.equal(request.authorization, "Bearer " + "c".repeat(64));
      assert.equal(request.body, undefined);
      assert.doesNotMatch(request.url, /search|contact|0000|participant|phone|operator/);
      const keys = [...new URL(request.url).searchParams.keys()];
      assert.equal(keys.some((key) => /term|search|field|name|phone/.test(key)), false);
    }
  });
}

test("operator sends replacement edit, hide and current-session reset only to NAS", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "typingking-nas-runtime-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const leaderboardToken = "c".repeat(64);
  const operatorToken = "d".repeat(64);
  const actions: any[] = [];
  const authorizations: Array<string | null> = [];
  const fetch: FetchLike = async (_url, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization"));
    if (String(_url).includes("/api/v1/ready?")) {
      return new Response(JSON.stringify({
        schema_version: 1,
        status: "ready",
        event_id: "geumcheon-science-festival-2026",
        device_id: "LEADERBOARD01",
        role: "operator",
        session: { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    actions.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const local = localCallbacks(async () => { throw new Error("unused"); });
  let actionNumber = 0;
  const actionIds = [
    "gsc26-action-123e4567-e89b-42d3-a456-426614174001",
    "gsc26-action-123e4567-e89b-42d3-a456-426614174002",
    "gsc26-action-123e4567-e89b-42d3-a456-426614174003",
  ];
  const runtime = createGeumcheonNasRuntime({ event: event(), device: device("leaderboard"), sessionKind: "official", runtimeRoot, safeStorage: safeStorage(), fetch, local: local.callbacks, createRecordId: () => recordId, createActionId: () => actionIds[actionNumber++], now: () => "2026-09-18T01:02:00.000Z", sleep: async () => undefined });
  const scopedRuntime = runtime as typeof runtime & {
    importLeaderboardToken?(token: string): Promise<void>;
    importOperatorToken?(token: string): Promise<void>;
    checkOperatorReady?(): Promise<unknown>;
  };
  assert.equal(typeof scopedRuntime.importLeaderboardToken, "function");
  assert.equal(typeof scopedRuntime.importOperatorToken, "function");
  assert.equal(typeof scopedRuntime.checkOperatorReady, "function");
  await scopedRuntime.importLeaderboardToken?.(leaderboardToken);
  await scopedRuntime.importOperatorToken?.(operatorToken);
  await scopedRuntime.checkOperatorReady?.();

  await runtime.edit(recordId, row(), "운영자");
  await runtime.hide(recordId, true, "운영자");
  await runtime.resetSession("운영자");

  assert.deepEqual(actions.map((value) => value.action_type), ["edit", "hide", "reset_session"]);
  assert.equal(actions[0].target_record_id, recordId);
  assert.equal(actions[0].changes.participant_name, "합성참가자");
  assert.equal(actions[1].hidden, true);
  assert.deepEqual(actions[2].session, { kind: "official", session_id: "official-1", day_no: 1, round_no: 2 });
  assert.deepEqual(authorizations, [
    `Bearer ${operatorToken}`,
    `Bearer ${operatorToken}`,
    `Bearer ${operatorToken}`,
    `Bearer ${operatorToken}`,
  ]);
  assert.equal(local.adminCalls, 0);
});

test("missing operator credential fails closed before an admin NAS request", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "typingking-nas-runtime-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  let requests = 0;
  const runtime = createGeumcheonNasRuntime({
    event: event(),
    device: device("leaderboard"),
    sessionKind: "official",
    runtimeRoot,
    safeStorage: safeStorage(),
    fetch: async () => { requests += 1; throw new Error("must not request"); },
    local: localCallbacks(async () => { throw new Error("unused"); }).callbacks,
    createActionId: () => "gsc26-action-123e4567-e89b-42d3-a456-426614174004",
    now: () => "2026-09-18T01:02:00.000Z",
    sleep: async () => undefined,
  });
  const scopedRuntime = runtime as typeof runtime & {
    importLeaderboardToken?(token: string): Promise<void>;
  };
  assert.equal(typeof scopedRuntime.importLeaderboardToken, "function");
  await scopedRuntime.importLeaderboardToken?.("e".repeat(64));

  await assert.rejects(
    () => runtime.hide(recordId, true, "운영자"),
    (error: unknown) => error instanceof Error && error.message === "NAS_CREDENTIAL_MISSING",
  );
  assert.equal(requests, 0);
});

test("editing a complete renderer-produced row sends unchanged public columns through the strict server admin boundary", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "r7-admin-record-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const server = new RecordStore({ dataRoot: path.join(runtimeRoot, "server") });
  const source = createChallengeSaveInput({
    participant: { name: "합성참가자", phone1: "010", phone2: "0000", phone3: "0001",
      birthYear: "2000", birthMonth: "01", birthDay: "01", privacyAgreedAt: "2026-09-09T00:00:00.000Z" },
    stageTexts: ["1234", "5678", "9012"],
    stageTextSelections: [1, 2, 3].map((stage) => ({
      id: `synthetic-${stage}`, catalogVersion: "synthetic-v1", stageNumber: stage,
      text: ["1234", "5678", "9012"][stage - 1]
    })) as unknown as NonNullable<SaveRecordInput["stageTextSelections"]>,
    battleRows: [{ stage: 1, text: "1234", userTimeMs: 5000, userCpm: 24, userAccuracy: 50,
      aiTimeMs: 5000, aiElapsedMs: 5000, aiCpm: 48, plannedAiCpm: 100,
      aiTypedUnits: 4, aiTypedChars: 4, result: "AI_WIN", userInput: "12x" }],
    status: "FAILED", failedStage: "1", terminalStage: 1, isGeumcheon: true, debugModeType: ""
  });
  const original = { record_id: recordId, ...buildRecordRow(source), participantKey: "protected-key" };
  const before = JSON.stringify(original);
  const replacement = { ...original, participant_name: "수정 합성", final_cpm: "777", memo: "운영자 확인" };
  let sentChanges: Record<string, unknown> | undefined;
  let receiverFailure: string | undefined;
  let actionNumber = 0;
  const runtime = createGeumcheonNasRuntime({
    event: event(), device: device("leaderboard"), sessionKind: "official", runtimeRoot,
    safeStorage: safeStorage(), local: localCallbacks(async () => { throw new Error("unused"); }).callbacks,
    createActionId: () => `gsc26-action-123e4567-e89b-42d3-a456-42661417400${++actionNumber}`,
    now: () => "2026-09-09T01:00:00.000Z",
    fetch: async (_url, init) => {
      const action = JSON.parse(String(init?.body));
      sentChanges = action.changes;
      try { await server.putAdminAction(action); }
      catch (error) {
        receiverFailure = error instanceof Error ? error.message : "unknown failure";
        return new Response(JSON.stringify({ code: receiverFailure }), { status: 422, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  await runtime.importOperatorToken("f".repeat(64));
  const legacyReplacement = { ...replacement };
  delete legacyReplacement.recordEvidence;
  for (const candidate of [legacyReplacement, replacement]) {
    try { await runtime.edit(recordId, candidate, "합성운영자"); }
    catch (error) {
      assert.equal(receiverFailure, undefined, "strict server rejected outgoing admin fields");
      throw error;
    }
  }
  assert.equal(sentChanges?.participant_name, "수정 합성");
  assert.equal(sentChanges?.final_cpm, "777", "transport must not recalculate editor values");
  assert.equal(sentChanges?.participant_avg_cpm, "24");
  assert.equal(sentChanges?.memo, "운영자 확인");
  for (const field of ["record_id", "fairness", "participantKey", "canonicalAttempt", "recordEvidence"]) {
    assert.equal(Object.hasOwn(sentChanges!, field), false, field);
  }
  assert.equal(JSON.stringify(original), before);
});

test("admin edit rejects malformed public values and unknown keys before sending a request", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "r7-admin-invalid-"));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  let requests = 0;
  const runtime = createGeumcheonNasRuntime({
    event: event(), device: device("leaderboard"), sessionKind: "official", runtimeRoot,
    safeStorage: safeStorage(), local: localCallbacks(async () => { throw new Error("unused"); }).callbacks,
    createActionId: () => "gsc26-action-123e4567-e89b-42d3-a456-426614174008",
    now: () => "2026-09-09T01:00:00.000Z",
    fetch: async () => { requests += 1; return new Response("{}", { headers: { "content-type": "application/json" } }); }
  });
  await runtime.importOperatorToken("f".repeat(64));
  for (const replacement of [
    { ...row(), final_cpm: 777 }, { ...row(), unknownMetric: "777" },
    { record_id: recordId }, null
  ]) {
    await assert.rejects(async () => runtime.edit(recordId, replacement as RecordRow, "합성운영자"),
      /NAS_ADMIN_REPLACEMENT_(?:INVALID|FIELD_INVALID)/);
  }
  assert.equal(requests, 0);
});

test("v4 physical player can launch reader without writer recovery authority", async context => {
  const runtimeRoot=await mkdtemp(path.join(os.tmpdir(),"typingking-v4-role-"));context.after(()=>rm(runtimeRoot,{recursive:true,force:true}));
  const runtime=createGeumcheonNasRuntime({event:event(),device:device("player"),executionRole:"leaderboard",sessionKind:"official",runtimeRoot,safeStorage:safeStorage(),fetch:async()=>new Response("{}",{status:503}),local:localCallbacks().callbacks});
  await assert.doesNotReject(()=>runtime.importLeaderboardToken("b".repeat(64)));
  await assert.rejects(()=>runtime.recover(),/NAS_ROLE_FORBIDDEN/);
  await assert.rejects(()=>runtime.flush(),/NAS_ROLE_FORBIDDEN/);
  assert.equal(typeof runtime.checkLeaderboardReady,"function");
});

test("v4 game admin reads with reader token and cannot inherit operator authority",async context=>{
 const runtimeRoot=await mkdtemp(path.join(os.tmpdir(),"typingking-v4-reader-"));context.after(()=>rm(runtimeRoot,{recursive:true,force:true}));const requests:string[]=[];
 const fetch:FetchLike=async(url,init)=>{requests.push(String(new Headers(init?.headers).get("authorization")));const session={kind:"official",session_id:"official-1",day_no:1,round_no:2};const body=String(url).includes("/ready?")?{schema_version:1,status:"ready",event_id:"geumcheon-science-festival-2026",device_id:"PC01",role:"leaderboard",session}:{schema_version:1,event_id:"geumcheon-science-festival-2026",session,generated_at:"2026-09-18T01:03:00.000Z",rows:[]};return new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}});};
 const runtime=createGeumcheonNasRuntime({event:event(),device:device("player"),executionRole:"player",sessionKind:"official",runtimeRoot,safeStorage:safeStorage(),fetch,local:localCallbacks().callbacks,credentials:{getToken:role=>role==="leaderboard"?"b".repeat(64):"a".repeat(64),assertCurrent:()=>{}}});
 assert.deepEqual((await runtime.loadRecords({freshOnly:true})).rows,[]);assert.ok(requests.every(value=>value==="Bearer "+"b".repeat(64)));
 await assert.rejects(async()=>runtime.checkOperatorReady(),/NAS_ROLE_FORBIDDEN|NAS_OPERATOR_NOT_PROVISIONED/);
});

test("v4 expiry during an existing game preserves local progress and queue while new readiness and network remain blocked",async context=>{
 const runtimeRoot=await mkdtemp(path.join(os.tmpdir(),"typingking-v4-expiry-"));context.after(()=>rm(runtimeRoot,{recursive:true,force:true}));let expired=false,fetchCalls=0;
 const runtime=createGeumcheonNasRuntime({event:event(),device:device("player"),executionRole:"player",sessionKind:"official",runtimeRoot,safeStorage:safeStorage(),fetch:async()=>{fetchCalls++;throw new Error("NETWORK_MUST_NOT_RUN");},local:localCallbacks(async(_input,id)=>row(id)).callbacks,credentials:{getToken:()=>{if(expired)throw new Error("PROFILE_EXPIRED");return "a".repeat(64);},assertCurrent:()=>{if(expired)throw new Error("PROFILE_EXPIRED");},assertLocalIdentity:()=>{}},sleep:async()=>{}});
 const initial=await runtime.checkpoint(input());expired=true;const continued=await runtime.checkpoint(input());assert.equal(continued.recordId,initial.recordId);const saved=await runtime.save(input());assert.equal(saved.record_id,initial.recordId);assert.equal((await runtime.queueStatus()).pending,1);
 await assert.rejects(async()=>runtime.checkpoint(input()),/PROFILE_EXPIRED/);
 await assert.rejects(async()=>runtime.save(input()),/PROFILE_EXPIRED/);
 await assert.rejects(async()=>runtime.checkReady(),/PROFILE_EXPIRED/);await runtime.flush();assert.equal(fetchCalls,0);assert.equal((await runtime.queueStatus()).pending,1);
});
test("v4 cold expired checkpoint can renew same scope without rewriting checkpoint and recovers original identity",async context=>{
 const {profileFixture}=await import("../events/rentalV4Fixture");const {assertSafeDeploymentApplication,DeploymentProfileStore,parseDeploymentProfile,replaceDeploymentSelection,withDeploymentLocks}=await import("../../electron/deploymentProfile");
 const runtimeRoot=await mkdtemp(path.join(os.tmpdir(),"typingking-v4-cold-expiry-"));context.after(()=>rm(runtimeRoot,{recursive:true,force:true}));const encryption=safeStorage();const raw:any=profileFixture();raw.device.sessions.official={sessionId:"official-1",dayNo:1,roundNo:2};raw.allowedSessions=[raw.device.sessions.official];const profile=parseDeploymentProfile(raw);let sent:any;
 const makeRuntime=(credentials:any)=>createGeumcheonNasRuntime({event:event(),device:profile.device,executionRole:"player",sessionKind:"official",runtimeRoot,safeStorage:encryption,fetch:async(_url,init)=>{sent=JSON.parse(String(init?.body));const hash=payloadSha256(sent);return new Response(JSON.stringify({schema_version:1,disposition:"stored",record_id:sent.row.record_id,payload_sha256:hash,stored_sha256:hash,received_at:"2026-09-18T01:03:00.000Z"}),{status:201,headers:{"content-type":"application/json"}});},local:localCallbacks(async(_input,id)=>row(id)).callbacks,credentials,sleep:async()=>{}});
 const initial=makeRuntime({getToken:()=>profile.credentials.writer!.token,assertCurrent:()=>{},assertLocalIdentity:()=>{}});const checkpoint=await initial.checkpoint(input());const checkpointPath=path.join(runtimeRoot,"nas","active-attempt-official.bin"),before=await readFile(checkpointPath);
 const fs=await import("node:fs");const expired={...profile,issuedAt:"2026-01-01T00:00:00.000Z",notBefore:"2026-01-01T00:00:00.000Z",expiresAt:"2026-02-01T00:00:00.000Z"};const storePath=path.join(runtimeRoot,"nas","deployment-profile.bin");fs.writeFileSync(storePath,encryption.encryptString(JSON.stringify(expired)));const next={...profile,deploymentId:"cold-renewed"};
 await assert.rejects(()=>assertSafeDeploymentApplication({currentRuntimeRoot:runtimeRoot,targetRuntimeRoot:runtimeRoot,replacement:next,safeStorage:encryption}),/PROFILE_BUSY_RECORDS/);
 await withDeploymentLocks([runtimeRoot],async()=>{assert.equal(await assertSafeDeploymentApplication({currentRuntimeRoot:runtimeRoot,targetRuntimeRoot:runtimeRoot,replacement:next,safeStorage:encryption,coldRecovery:true}),"credential-renewal");const directory=path.join(runtimeRoot,"client");fs.mkdirSync(directory);const source=path.join(directory,"player_01.device-profile.json");fs.writeFileSync(source,JSON.stringify(next));replaceDeploymentSelection(storePath,path.join(runtimeRoot,"selected.bin"),directory,next,source,encryption);});
 assert.deepEqual(await readFile(checkpointPath),before);const store=new DeploymentProfileStore(storePath,encryption);store.activate(next);const resumed=makeRuntime({getToken:(role:any)=>store.token(role),assertCurrent:()=>store.assertCurrent(),assertLocalIdentity:()=>store.assertLocalIdentity()});const recovered=await resumed.recover();assert.equal(recovered?.record_id,checkpoint.recordId);assert.equal((await resumed.flush()).sent,1);assert.equal(sent.session.session_id,"official-1");assert.equal(sent.session.round_no,2);assert.equal(sent.row.record_id,checkpoint.recordId);
});
