import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildNasApp } from "../src/app.js";
import { TokenBucketLimiter } from "../src/auth.js";
import type { RecordValidationConfigV1 } from "../src/recordSchema.js";

const token = "1".repeat(64);
const recordId = "gsc26-pc01-11111111-1111-4111-8111-111111111111";

function body(): Record<string, unknown> {
  return { schema_version: 1, event_id: "geumcheon-science-festival-2026", session: { kind: "official", session_id: "official-day1-round1", day_no: 1, round_no: 1 }, record: { record_id: recordId, created_at: "2026-08-26T03:00:00.000Z", completed_at: "2026-08-26T03:00:06.000Z", participant: { name: "synthetic", phone: "01000000001", birthdate: "2000-02-29", privacy_agreed: true, privacy_agreed_at: "2026-08-26T02:59:59.000Z" }, status: "success", stages: [{ stage_no: 1, text_id: "s1", catalog_version: "v1", target_text: "가", typed_text: "가", user_time_ms: 1000, ai_cpm: 150, result: "USER_WIN" }, { stage_no: 2, text_id: "s2", catalog_version: "v1", target_text: "나", typed_text: "나", user_time_ms: 1000, ai_cpm: 200, result: "USER_WIN" }, { stage_no: 3, text_id: "s3", catalog_version: "v1", target_text: "다", typed_text: "다", user_time_ms: 1000, ai_cpm: 250, result: "USER_WIN" }], app_version: "synthetic", is_test: false, is_debug: false, debug_mode_type: "" } };
}

function config(root: string): RecordValidationConfigV1 & { tokenManifest: { manifestVersion: 1; eventId: "geumcheon-science-festival-2026"; tokens: Array<{ tokenId: string; tokenHash: string; deviceId: string; role: "writer"; allowedSessions: Array<"official" | "practice">; expiresAt: string; revokedAt: null }> } } {
  return { schemaVersion: 1, eventId: "geumcheon-science-festival-2026", dataRoot: root, recordBaseFolderName: "기록저장", stageTextCatalogPath: "synthetic", allowedSessions: { official: [{ sessionId: "official-day1-round1", dayNo: 1, roundNo: 1 }], practice: { sessionId: "practice-2026" } }, aiRanges: { official: [[150, 200], [200, 250], [250, 300]], practice: [[100, 150], [150, 200], [200, 250]] }, stageTextCatalog: [{ id: "s1", catalog_version: "v1", game_mode: "ai_challenge", stage_number: "1", text: "가", is_active: "true", created_at: "x", updated_at: "x" }, { id: "s2", catalog_version: "v1", game_mode: "ai_challenge", stage_number: "2", text: "나", is_active: "true", created_at: "x", updated_at: "x" }, { id: "s3", catalog_version: "v1", game_mode: "ai_challenge", stage_number: "3", text: "다", is_active: "true", created_at: "x", updated_at: "x" }], participantHmacKey: Buffer.alloc(32, 2), tokenManifest: { manifestVersion: 1, eventId: "geumcheon-science-festival-2026", tokens: [{ tokenId: "PC01-write", tokenHash: createHash("sha256").update(token).digest("hex"), deviceId: "PC01", role: "writer", allowedSessions: ["official", "practice"], expiresAt: "2026-08-27T00:00:00.000Z", revokedAt: null }] } };
}

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-device-id": "PC01", "idempotency-key": recordId, "content-type": "application/json", ...overrides };
}

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
  const changed = body(); ((changed.record as Record<string, unknown>).participant as Record<string, unknown>).name = "different";
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
