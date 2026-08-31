import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildNasApp } from "../src/app.js";
import { TokenBucketLimiter, type TokenManifestV1 } from "../src/auth.js";
import { RecordStore } from "../src/recordStore.js";
import type { RecordValidationConfigV1 } from "../src/recordSchema.js";
import { envelope, recordRow } from "./fixtures.js";

const token = "1".repeat(64);
const operatorToken = "3".repeat(64);
const recordId = "gsc26-pc01-11111111-1111-4111-8111-111111111111";
const attemptId = "gsc26-attempt-11111111-1111-4111-8111-111111111111";

function legacyBody(): Record<string, unknown> {
  return { schema_version: 1, event_id: "geumcheon-science-festival-2026", session: { kind: "official", session_id: "official-day1-round1", day_no: 1, round_no: 1 }, record: { record_id: recordId, created_at: "2026-08-26T03:00:00.000Z", completed_at: "2026-08-26T03:00:06.000Z", participant: { name: "synthetic", phone: "01000000001", birthdate: "2000-02-29", privacy_agreed: true, privacy_agreed_at: "2026-08-26T02:59:59.000Z" }, status: "success", stages: [{ stage_no: 1, text_id: "s1", catalog_version: "v1", target_text: "가", typed_text: "가", user_time_ms: 1000, ai_cpm: 150, result: "USER_WIN" }, { stage_no: 2, text_id: "s2", catalog_version: "v1", target_text: "나", typed_text: "나", user_time_ms: 1000, ai_cpm: 200, result: "USER_WIN" }, { stage_no: 3, text_id: "s3", catalog_version: "v1", target_text: "다", typed_text: "다", user_time_ms: 1000, ai_cpm: 250, result: "USER_WIN" }], app_version: "synthetic", is_test: false, is_debug: false, debug_mode_type: "" } };
}

function body(): Record<string, unknown> {
  return envelope(recordRow({
    stage1_text: "가",
    stage2_text: "나",
    stage3_text: "다",
    stage1_char_count: "1",
    stage2_char_count: "1",
    stage3_char_count: "1",
    total_char_count: "3",
    final_cpm: "30",
    participant_avg_cpm: "30",
  })) as unknown as Record<string, unknown>;
}

function config(root: string): RecordValidationConfigV1 & { tokenManifest: { manifestVersion: 1; eventId: "geumcheon-science-festival-2026"; tokens: Array<{ tokenId: string; tokenHash: string; deviceId: string; role: "writer"; allowedSessions: Array<"official" | "practice">; expiresAt: string; revokedAt: null }> } } {
  return { schemaVersion: 1, eventId: "geumcheon-science-festival-2026", dataRoot: root, recordBaseFolderName: "기록저장", stageTextCatalogPath: "synthetic", allowedSessions: { official: [{ sessionId: "official-day1-round1", dayNo: 1, roundNo: 1 }], practice: { sessionId: "practice-2026" } }, aiRanges: { official: [[150, 200], [200, 250], [250, 300]], practice: [[100, 150], [150, 200], [200, 250]] }, stageTextCatalog: [{ id: "s1", catalog_version: "v1", game_mode: "ai_challenge", stage_number: "1", text: "가", is_active: "true", created_at: "x", updated_at: "x" }, { id: "s2", catalog_version: "v1", game_mode: "ai_challenge", stage_number: "2", text: "나", is_active: "true", created_at: "x", updated_at: "x" }, { id: "s3", catalog_version: "v1", game_mode: "ai_challenge", stage_number: "3", text: "다", is_active: "true", created_at: "x", updated_at: "x" }], participantHmacKey: Buffer.alloc(32, 2), tokenManifest: { manifestVersion: 1, eventId: "geumcheon-science-festival-2026", tokens: [{ tokenId: "PC01-write", tokenHash: createHash("sha256").update(token).digest("hex"), deviceId: "PC01", role: "writer", allowedSessions: ["official", "practice"], expiresAt: "2026-08-27T00:00:00.000Z", revokedAt: null }] } };
}

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-device-id": "PC01", "idempotency-key": recordId, "content-type": "application/json", ...overrides };
}

function operatorConfig(root: string): ReturnType<typeof config> {
  const configured = config(root);
  (configured.tokenManifest as TokenManifestV1).tokens.push({
    tokenId: "leaderboard-operator",
    tokenHash: createHash("sha256").update(operatorToken).digest("hex"),
    deviceId: "LEADERBOARD01",
    role: "operator",
    allowedSessions: ["official", "practice"],
    expiresAt: "2026-08-27T00:00:00.000Z",
    revokedAt: null,
  });
  return configured;
}

function operatorHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${operatorToken}`,
    "x-device-id": "LEADERBOARD01",
    "content-type": "application/json",
  };
}

function contradictoryBody(
  session: "official" | "practice" = "official",
  progress = 101,
): Record<string, unknown> {
  const payload = body();
  if (session === "practice") {
    payload.session = { kind: "practice", session_id: "practice-2026" };
  }
  const row = payload.row as Record<string, unknown>;
  row.canonicalAttempt = {
    schemaVersion: 1,
    attemptId,
    recordId,
    deviceId: "PC01",
    recordedAt: "2026-08-26T03:00:06.000Z",
    result: "PARTICIPANT_WIN",
    interruptionReason: null,
    participantFinishTimeMs: 6000,
    geumnaraeFinishTimeMs: 7200,
    stages: [
      {
        stageNumber: 1,
        entered: true,
        assignedInputUnits: 1,
        participantCorrectInputUnits: 1,
        participantValidInputUnits: 1,
        participantActiveTypingTimeMs: 2000,
        geumnaraeCorrectInputUnits: 1,
        geumnaraeValidInputUnits: 1,
        geumnaraeActiveTypingTimeMs: 2400,
        activeDuelTimeMs: 2000,
      },
      {
        stageNumber: 2,
        entered: true,
        assignedInputUnits: 1,
        participantCorrectInputUnits: 1,
        participantValidInputUnits: 1,
        participantActiveTypingTimeMs: 2000,
        geumnaraeCorrectInputUnits: 1,
        geumnaraeValidInputUnits: 1,
        geumnaraeActiveTypingTimeMs: 2400,
        activeDuelTimeMs: 2000,
      },
      {
        stageNumber: 3,
        entered: true,
        assignedInputUnits: 1,
        participantCorrectInputUnits: 1,
        participantValidInputUnits: 1,
        participantActiveTypingTimeMs: 2000,
        geumnaraeCorrectInputUnits: 1,
        geumnaraeValidInputUnits: 1,
        geumnaraeActiveTypingTimeMs: 2400,
        activeDuelTimeMs: 2000,
      },
    ],
    stageReached: 3,
    stageState: "COMPLETED",
    wholeGameProgressRaw: progress,
    participantAverageCpmRaw: 30,
    geumnaraeProgressRaw: 100,
    geumnaraeAverageCpmRaw: 25,
    totalActiveDuelTimeMs: 6000,
    assignedInputUnits: 3,
    participantCorrectInputUnits: 3,
    participantValidInputUnits: 3,
    participantActiveTypingTimeMs: 6000,
    geumnaraeCorrectInputUnits: 3,
    geumnaraeValidInputUnits: 3,
    geumnaraeActiveTypingTimeMs: 7200,
    participantCompleted: true,
    geumnaraeCompleted: true,
    contradictionCodes: [],
  };
  return payload;
}

function quarantinePath(root: string, practice = false): string {
  return practice
    ? join(root, "기록저장", "연습회차", "quarantine", "contradiction", `${recordId}.json`)
    : join(root, "기록저장", "1일차", "1회차", "quarantine", "contradiction", `${recordId}.json`);
}

function incomingPath(root: string): string {
  return join(root, "기록저장", "1일차", "1회차", "incoming", "ai", `${recordId}.json`);
}

const genericQuarantineResponse = {
  schema_version: 1,
  code: "RECORD_QUARANTINED",
  message: "기록 정합성을 확인할 수 없습니다.",
};

test("requires headers, limits JSON to 32 KiB, and does not install CORS", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-routes-")); context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({ config: config(root), now: () => "2026-08-26T03:10:00.000Z" }); context.after(() => app.close());
  const missing = await app.inject({ method: "POST", url: "/api/v1/records", payload: body() });
  assert.equal(missing.statusCode, 401); assert.deepEqual(missing.json(), { schema_version: 1, code: "AUTH_MISSING", message: "AUTH_MISSING" });
  const tooLarge = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers(), payload: JSON.stringify({ data: "x".repeat(33 * 1024) }) });
  assert.equal(tooLarge.statusCode, 413); assert.equal(tooLarge.headers["access-control-allow-origin"], undefined);
});

test("stores once, returns durable duplicate, maps conflict and keeps error bodies safe", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-routes-")); context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({ config: config(root), now: () => "2026-08-26T03:10:00.000Z" }); context.after(() => app.close());
  const first = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers(), payload: body() });
  assert.equal(first.statusCode, 201); assert.equal(first.json().disposition, "stored");
  const retry = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers(), payload: body() });
  assert.equal(retry.statusCode, 200); assert.equal(retry.json().disposition, "duplicate");
  const changed = body(); (changed.row as Record<string, unknown>).participant_name = "different";
  const conflict = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers(), payload: changed });
  assert.equal(conflict.statusCode, 409); assert.deepEqual(Object.keys(conflict.json()).sort(), ["code", "message", "schema_version"]);
  const mismatch = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers({ "idempotency-key": "other" }), payload: body() });
  assert.equal(mismatch.statusCode, 422);
});

test("maps authorization validation and rate-limit failures to safe protocol errors", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-routes-")); context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({ config: config(root), now: () => "2026-08-26T03:10:00.000Z", tokenLimiter: new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 }) }); context.after(() => app.close());
  const denied = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers({ "x-device-id": "PC02" }), payload: body() });
  assert.equal(denied.statusCode, 403); assert.deepEqual(denied.json(), { schema_version: 1, code: "DEVICE_SCOPE", message: "DEVICE_SCOPE" });
  const invalid = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers(), payload: { ...body(), unexpected: true } });
  assert.equal(invalid.statusCode, 422); assert.deepEqual(Object.keys(invalid.json()).sort(), ["code", "message", "schema_version"]);
  const allowed = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers(), payload: body() });
  assert.equal(allowed.statusCode, 201);
  const limited = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers(), payload: body() });
  assert.equal(limited.statusCode, 429); assert.equal(limited.headers["retry-after"], "1"); assert.equal(limited.json().code, "RATE_LIMITED");
});

test("health reports only availability without storage or configuration disclosure", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-routes-")); context.after(() => rmSync(root, { recursive: true, force: true }));
  const healthy = buildNasApp({ config: config(root) }); context.after(() => healthy.close());
  const response = await healthy.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { status: "ok" });
  const unavailable = buildNasApp({ config: config(root), readiness: async () => false }); context.after(() => unavailable.close());
  const down = await unavailable.inject({ method: "GET", url: "/health" });
  assert.equal(down.statusCode, 503); assert.deepEqual(down.json(), { status: "unavailable" }); assert.equal(down.body.includes(root), false);
});

test("maps raw storage errno failures to a safe unavailable response", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-routes-")); context.after(() => rmSync(root, { recursive: true, force: true }));
  const diskFull = Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
  const app = buildNasApp({ config: config(root), now: () => "2026-08-26T03:10:00.000Z", recordStore: new RecordStore({ dataRoot: root, atomicHooks: { beforeWrite: () => { throw diskFull; } } }) }); context.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/v1/records", headers: headers(), payload: body() });
  assert.equal(response.statusCode, 503, response.body);
  assert.deepEqual(response.json(), { schema_version: 1, code: "STORAGE_UNAVAILABLE", message: "STORAGE_UNAVAILABLE" });
  assert.equal(response.body.includes("disk full"), false);
});

test("operator token reads full rows and applies admin edits through authenticated routes", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-routes-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const saved = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: body(),
  });
  assert.equal(saved.statusCode, 201, saved.body);

  const route = "/api/v1/records?session_kind=official&session_id=official-day1-round1&day_no=1&round_no=1";
  const snapshot = await app.inject({
    method: "GET",
    url: route,
    headers: operatorHeaders(),
  });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.equal(snapshot.json().rows[0].phone_full, "01000000001");
  assert.equal("rank" in snapshot.json().rows[0], false);

  const action = {
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: {
      kind: "official",
      session_id: "official-day1-round1",
      day_no: 1,
      round_no: 1,
    },
    action_id: "gsc26-action-44444444-4444-4444-8444-444444444444",
    created_at: "2026-08-26T03:11:00.000Z",
    admin_name: "운영자",
    action_type: "edit",
    target_record_id: recordId,
    changes: { participant_name: "수정 이름" },
  };
  const edited = await app.inject({
    method: "POST",
    url: "/api/v1/admin/actions",
    headers: operatorHeaders(),
    payload: action,
  });
  assert.equal(edited.statusCode, 201, edited.body);

  const after = await app.inject({
    method: "GET",
    url: route,
    headers: operatorHeaders(),
  });
  assert.equal(after.json().rows[0].participant_name, "수정 이름");

  const writerDenied = await app.inject({
    method: "GET",
    url: route,
    headers: headers(),
  });
  assert.equal(writerDenied.statusCode, 403);
});

test("authenticated ready route returns only the bound principal and configured session", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-ready-route-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({ config: config(root), now: () => "2026-08-26T03:10:00.000Z" });
  context.after(() => app.close());
  const url = "/api/v1/ready?session_kind=official&session_id=official-day1-round1&day_no=1&round_no=1";

  const missing = await app.inject({ method: "GET", url });
  assert.equal(missing.statusCode, 401);
  const response = await app.inject({
    method: "GET",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "x-device-id": "PC01",
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    schema_version: 1,
    status: "ready",
    event_id: "geumcheon-science-festival-2026",
    device_id: "PC01",
    role: "writer",
    session: {
      kind: "official",
      session_id: "official-day1-round1",
      day_no: 1,
      round_no: 1,
    },
  });
});

test("authenticated contradictory records are quarantined with a generic 422 and excluded from public records", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-quarantine-route-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody(),
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.deepEqual(response.json(), genericQuarantineResponse);
  assert.equal(response.body.includes("PROGRESS_OUT_OF_RANGE"), false);
  assert.equal(response.body.includes("different"), false);
  assert.equal(response.body.includes(root), false);

  const saved = JSON.parse(readFileSync(quarantinePath(root), "utf8")) as Record<string, unknown>;
  assert.equal(saved.quarantine_type, "contradiction");
  assert.equal(saved.reason_code, "PROGRESS_OUT_OF_RANGE");
  assert.equal(saved.record_id, recordId);

  const snapshot = await app.inject({
    method: "GET",
    url: "/api/v1/records?session_kind=official&session_id=official-day1-round1&day_no=1&round_no=1",
    headers: operatorHeaders(),
  });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.deepEqual(snapshot.json().rows, []);
});

test("identical contradictory retry remains one durable quarantine after API restart", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-quarantine-restart-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const first = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  const initial = await first.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody(),
  });
  assert.equal(initial.statusCode, 422, initial.body);
  await first.close();

  const restarted = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:20:00.000Z",
  });
  context.after(() => restarted.close());
  const retry = await restarted.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody(),
  });
  assert.equal(retry.statusCode, 422, retry.body);
  assert.deepEqual(retry.json(), genericQuarantineResponse);
  assert.equal(readFileSync(quarantinePath(root), "utf8").length > 0, true);
  assert.equal(
    readdirSync(join(root, "기록저장", "1일차", "1회차", "quarantine", "contradiction"))
      .filter((name) => name.endsWith(".json")).length,
    1,
  );
});

test("changed contradictory body for an existing record ID returns 409 without replacing quarantine", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-quarantine-conflict-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody("official", 101),
  });
  assert.equal(first.statusCode, 422, first.body);
  const original = readFileSync(quarantinePath(root), "utf8");

  const conflict = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody("official", 102),
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.deepEqual(conflict.json(), {
    schema_version: 1,
    code: "IDEMPOTENCY_CONFLICT",
    message: "IDEMPOTENCY_CONFLICT",
  });
  assert.equal(readFileSync(quarantinePath(root), "utf8"), original);
});

test("official and practice contradictions stay in isolated quarantine namespaces", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-quarantine-session-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const official = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody("official"),
  });
  const practice = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody("practice"),
  });
  assert.equal(official.statusCode, 422, official.body);
  assert.equal(practice.statusCode, 422, practice.body);
  assert.equal(readFileSync(quarantinePath(root), "utf8").length > 0, true);
  assert.equal(readFileSync(quarantinePath(root, true), "utf8").length > 0, true);
});

test("failed device binding never creates a contradiction quarantine", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-quarantine-auth-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const denied = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers({ "x-device-id": "PC02" }),
    payload: contradictoryBody(),
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(existsSync(quarantinePath(root)), false);
});

test("an accepted record globally owns its ID against a later contradictory body", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-global-id-valid-first-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody("official", 100),
  });
  assert.equal(accepted.statusCode, 201, accepted.body);

  const conflict = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody("official", 101),
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(existsSync(incomingPath(root)), true);
  assert.equal(existsSync(quarantinePath(root)), false);
});

test("a quarantined record globally owns its ID against a later accepted body", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-global-id-quarantine-first-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const quarantined = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody("official", 101),
  });
  assert.equal(quarantined.statusCode, 422, quarantined.body);

  const conflict = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody("official", 100),
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(existsSync(quarantinePath(root)), true);
  assert.equal(existsSync(incomingPath(root)), false);
});

test("simultaneous accepted and contradictory bodies cannot publish the same ID twice", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-global-id-race-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const responses = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/v1/records",
      headers: headers(),
      payload: contradictoryBody("official", 100),
    }),
    app.inject({
      method: "POST",
      url: "/api/v1/records",
      headers: headers(),
      payload: contradictoryBody("official", 101),
    }),
  ]);
  const statuses = responses.map((response) => response.statusCode);
  assert.equal(statuses.filter((status) => status === 409).length, 1);
  assert.equal(statuses.filter((status) => status === 201 || status === 422).length, 1);
  assert.equal(
    Number(existsSync(incomingPath(root))) + Number(existsSync(quarantinePath(root))),
    1,
  );
});

test("admin edits that contradict canonical stage semantics are excluded from effective records", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-canonical-admin-edit-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildNasApp({
    config: operatorConfig(root),
    now: () => "2026-08-26T03:10:00.000Z",
  });
  context.after(() => app.close());

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    headers: headers(),
    payload: contradictoryBody("official", 100),
  });
  assert.equal(accepted.statusCode, 201, accepted.body);

  const edited = await app.inject({
    method: "POST",
    url: "/api/v1/admin/actions",
    headers: operatorHeaders(),
    payload: {
      schema_version: 1,
      event_id: "geumcheon-science-festival-2026",
      session: {
        kind: "official",
        session_id: "official-day1-round1",
        day_no: 1,
        round_no: 1,
      },
      action_id: "gsc26-action-55555555-5555-4555-8555-555555555555",
      created_at: "2026-08-26T03:11:00.000Z",
      admin_name: "운영자",
      action_type: "edit",
      target_record_id: recordId,
      changes: { result_stage: "2" },
    },
  });
  assert.equal(edited.statusCode, 201, edited.body);

  const snapshot = await app.inject({
    method: "GET",
    url: "/api/v1/records?session_kind=official&session_id=official-day1-round1&day_no=1&round_no=1",
    headers: operatorHeaders(),
  });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.deepEqual(snapshot.json().rows, []);
});
