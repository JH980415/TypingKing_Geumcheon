import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createChallengeSaveInput } from "../../apps/typing-game/src/AIChallengeGame";
import { createGeumcheonRecordRuntime } from "../../electron/geumcheonRecordRuntime";
import { EncryptedNasOutbox } from "../../electron/nas/outbox";
import { ensureRuntime, saveRecord, readRecords, updateOneDriveSettings, validateOneDriveSetup } from "../../shared/csv/fileStore";
import { buildNasRecordEnvelope, GEUMCHEON_NAS_EVENT_ID } from "../../shared/nas/protocol";
import type { DeviceProfile } from "../../shared/events/types";
import type { GeumcheonBattleEvidenceV1, RecordRow, StageTextSelection } from "../../shared/types";
import { buildNasApp } from "../../services/nas-record-api/src/app";
import { validateAndNormalizeRecord } from "../../services/nas-record-api/src/recordSchema";

// Original synthetic measurements, not reconstructed from NAS03 public rows.
// 30+33+36 converted units / 2.168 seconds * 60 = 2739.8524 -> 2740
// with existing nearest-integer CPM serialization. Character count48 is not CPM units99.
const fullTexts: [string, string, string] = ["로봇과 노는 금천과학축제", "AI야, 금천과학축제 놀러가자!", "AI와 소통하는 활기찬 미래 금천"];
const fullBattles: GeumcheonBattleEvidenceV1[] = [
  { stage: 1, text: fullTexts[0], userInput: fullTexts[0], userTimeMs: 718, userCpm: 2507, userAccuracy: 100, aiTimeMs: 16221.2, aiElapsedMs: 718, aiCpm: 0, plannedAiCpm: 112, aiTypedUnits: 0, aiTypedChars: 0, result: "USER_WIN" },
  { stage: 2, text: fullTexts[1], userInput: fullTexts[1], userTimeMs: 717, userCpm: 2762, userAccuracy: 100, aiTimeMs: 13996.2, aiElapsedMs: 717, aiCpm: 0, plannedAiCpm: 143, aiTypedUnits: 0, aiTypedChars: 0, result: "USER_WIN" },
  { stage: 3, text: fullTexts[2], userInput: fullTexts[2], userTimeMs: 733, userCpm: 2947, userAccuracy: 100, aiTimeMs: 12931.2, aiElapsedMs: 733, aiCpm: 0, plannedAiCpm: 169, aiTypedUnits: 0, aiTypedChars: 0, result: "USER_WIN" }
];
const partialTexts: [string, string, string] = ["1234", "5678", "9012"];
const partialBattles: GeumcheonBattleEvidenceV1[] = [
  { stage: 1, text: "1234", userInput: "12x", userTimeMs: 5000, userCpm: 24, userAccuracy: 50, aiTimeMs: 5000, aiElapsedMs: 5000, aiCpm: 48, plannedAiCpm: 100, aiTypedUnits: 4, aiTypedChars: 4, result: "AI_WIN" }
];
const token = "a".repeat(64);
const readToken = "b".repeat(64);
const principal = { tokenId: "writer", eventId: GEUMCHEON_NAS_EVENT_ID, deviceId: "PC01", role: "writer" as const, allowedSessions: ["official" as const] };
const profile: DeviceProfile = { schemaVersion: 1, eventProfileId: "geumcheon-2026", eventId: GEUMCHEON_NAS_EVENT_ID, deviceId: "PC01", role: "player", apiBaseUrl: "https://synthetic.invalid", sessions: { official: { sessionId: "roundtrip", dayNo: 1, roundNo: 1 } }, requestTimeoutMs: 1000, retry: { initialDelayMs: 1000, maxDelayMs: 1000 } };

function selections(texts: [string, string, string]): [StageTextSelection, StageTextSelection, StageTextSelection] {
  return texts.map((text, index) => ({ id: `literal-${text === fullTexts[index] ? "full" : "partial"}-${index + 1}`, catalogVersion: "r7-roundtrip-v1", stageNumber: index + 1, text })) as [StageTextSelection, StageTextSelection, StageTextSelection];
}

async function pipeline(t: { after(callback: () => unknown): unknown }, texts: [string, string, string], battles: GeumcheonBattleEvidenceV1[], uuid = "11111111-1111-4111-8111-111111111111") {
  const root = await mkdtemp(path.join(tmpdir(), "r7-evidence-roundtrip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = ensureRuntime(path.join(root, "local"));
  updateOneDriveSettings(ctx, { syncMode: "onedrive_manual", pcRole: "player", pcId: "PC01", oneDriveRoot: path.join(root, "synthetic-files"), recordBaseFolderName: "records", dayNo: 1, roundNo: 1 }, "player");
  validateOneDriveSetup(ctx, "player");
  const key = Buffer.alloc(32, 7);
  const outbox = new EncryptedNasOutbox({ rootDir: path.join(root, "outbox"), safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
    decryptString(value) { const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"); }
  } });
  const selected = selections(texts);
  const input = createChallengeSaveInput({ participant: { name: "합성 원본 검증", phone1: "010", phone2: "0000", phone3: "1234", birthYear: "2000", birthMonth: "1", birthDay: "2", privacyAgreedAt: "2026-01-01T00:00:00.000Z" }, stageTexts: texts, stageTextSelections: selected, battleRows: battles, status: battles.length === 3 ? "SUCCESS" : "FAILED", failedStage: battles.length === 3 ? "" : "1", terminalStage: battles.length, isGeumcheon: true, debugModeType: "" });
  const originalRendererEvidence = structuredClone(input.recordEvidence);
  let checkpoint: any = null;
  const runtime = createGeumcheonRecordRuntime({ eventProfileId: "geumcheon-2026", variant: "ai", deviceId: "PC01", store: { async read() { return checkpoint; }, async save(value) { checkpoint = structuredClone(value); }, async clear() { checkpoint = null; } }, createAttemptIdentity: () => ({ recordId: `gsc26-pc01-${uuid}`, attemptId: `gsc26-attempt-${uuid}` }), now: () => new Date().toISOString(), persistLocal: (value, identity) => saveRecord(ctx, value, identity.recordId), enqueue: (row) => outbox.enqueue("official", buildNasRecordEnvelope(profile, "official", row)) });
  const saved = await runtime.save(input);
  assert.deepEqual(input.recordEvidence, originalRendererEvidence, "trusted identity must not mutate renderer evidence");
  assert.deepEqual(saved.recordEvidence?.battles, battles, "every raw source primitive must survive real saveRecord");
  assert.equal(saved.recordEvidence?.canonicalAttempt.recordId, saved.record_id);
  assert.equal(saved.recordEvidence?.canonicalAttempt.attemptId, `gsc26-attempt-${uuid}`);
  assert.equal(saved.recordEvidence?.canonicalAttempt.deviceId, "PC01");
  assert.equal(Object.hasOwn(saved, "canonicalAttempt"), false, "public ranking must not switch to canonical-first branch");
  const localJson = JSON.parse(await readFile(path.join(ctx.config.aiIncomingPath, `${saved.record_id}.json`), "utf8"));
  assert.deepEqual(localJson.recordEvidence, saved.recordEvidence);
  assert.deepEqual(readRecords(ctx)[0].recordEvidence, saved.recordEvidence);
  const encrypted = await readFile(path.join(root, "outbox", "official", "pending", `${saved.record_id}.bin`));
  assert.equal(encrypted.includes(Buffer.from("합성 원본 검증")), false);
  assert.equal(encrypted.includes(Buffer.from("userInput")), false);
  const [pending] = await outbox.list("official");
  assert.deepEqual(pending.envelope.row, saved);
  const config = { schemaVersion: 1 as const, eventId: GEUMCHEON_NAS_EVENT_ID, dataRoot: path.join(root, "server"), recordBaseFolderName: "기록저장", stageTextCatalogPath: "synthetic-unused", allowedSessions: { official: [{ sessionId: "roundtrip", dayNo: 1, roundNo: 1 }] }, aiRanges: { official: [[100, 125], [125, 150], [150, 200]] as [[number, number], [number, number], [number, number]] }, participantHmacKey: Buffer.alloc(32, 4), stageTextCatalog: selected.map((s) => ({ id: s.id, catalog_version: s.catalogVersion, game_mode: "ai_challenge", stage_number: String(s.stageNumber), text: s.text, is_active: "true", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" })), tokenManifest: { manifestVersion: 1 as const, eventId: GEUMCHEON_NAS_EVENT_ID, tokens: [{ tokenId: "writer", tokenHash: createHash("sha256").update(token).digest("hex"), deviceId: "PC01", role: "writer" as const, allowedSessions: ["official" as const], expiresAt: "2100-01-01T00:00:00Z", revokedAt: null }, { tokenId: "reader", tokenHash: createHash("sha256").update(readToken).digest("hex"), deviceId: "LEADERBOARD01", role: "leaderboard" as const, allowedSessions: ["official" as const], expiresAt: "2100-01-01T00:00:00Z", revokedAt: null }] } };
  const app = buildNasApp({ config });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${token}`, "x-device-id": "PC01", "idempotency-key": saved.record_id };
  return { root, app, config, headers, saved, envelope: pending.envelope };
}

async function postAndQuery(value: Awaited<ReturnType<typeof pipeline>>) {
  const first = await value.app.inject({ method: "POST", url: "/api/v1/records", headers: value.headers, payload: value.envelope });
  assert.equal(first.statusCode, 201, first.body);
  const duplicate = await value.app.inject({ method: "POST", url: "/api/v1/records", headers: value.headers, payload: value.envelope });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  const query = await value.app.inject({ method: "GET", url: "/api/v1/records?session_kind=official&session_id=roundtrip&day_no=1&round_no=1", headers: { authorization: `Bearer ${readToken}`, "x-device-id": "LEADERBOARD01" } });
  assert.equal(query.statusCode, 200, query.body);
  const { recordEvidence: _raw, ...publicBefore } = value.saved;
  assert.deepEqual(query.json().rows, [publicBefore], "public columns must remain equal separately from protected raw evidence");
  const protectedJson = JSON.parse(await readFile(path.join(value.config.dataRoot, "기록저장", "1일차", "1회차", "incoming", "ai", `${value.saved.record_id}.json`), "utf8"));
  assert.deepEqual(protectedJson.recordEvidence, value.saved.recordEvidence);
}

test("localUnicodePath: exact protected/public data under 임시/typingking leaves a sibling marker unchanged; actual Synology/Docker NOT_RUN", async (t) => {
  const value = await pipeline(t, partialTexts, partialBattles);
  const unicodeParent = path.join(value.root, "임시");
  const dataRoot = path.join(unicodeParent, "typingking");
  await mkdir(unicodeParent, { recursive: true });
  const markerPath = path.join(unicodeParent, "보존할 형제 파일.txt");
  const marker = Buffer.from("synthetic sibling marker: preserve exact bytes\n", "utf8");
  await writeFile(markerPath, marker, { flag: "wx" });
  const originalHash = createHash("sha256").update(marker).digest("hex");
  const config = { ...value.config, dataRoot };
  const unicodeApp = buildNasApp({ config });
  t.after(() => unicodeApp.close());
  await postAndQuery({ ...value, config, app: unicodeApp });
  const after = await readFile(markerPath);
  assert.equal(createHash("sha256").update(after).digest("hex"), originalHash);
  assert.deepEqual(after, marker);
  assert.equal(path.relative(unicodeParent, dataRoot), "typingking");
  // Cleanup owns only the unique mkdtemp root allocated by pipeline, never
  // a configured NAS path, the user's 임시 folder, or a broad shared parent.
});

test("actual NAS03 blocked payload remains negative without reconstructing its discarded original evidence", async (t) => {
  const source = path.resolve("Codex/Evidence/R7/after/runtime-nas-567b3af-03/synthetic-blocked-payload.json");
  let bytes: Buffer;
  try { bytes = await readFile(source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("NOT_RUN: preserved local NAS03 synthetic evidence file unavailable; no replacement fabricated");
    return;
  }
  const originalHash = createHash("sha256").update(bytes).digest("hex");
  const preserved = JSON.parse(bytes.toString("utf8"));
  assert.match(preserved.classification, /SYNTHETIC TEST DATA ONLY/);
  assert.equal(preserved.envelope.row.participant_name, "합성실제도전");
  assert.equal(preserved.envelope.row.phone_full, "010-0000-1234");
  assert.equal(Object.hasOwn(preserved.envelope.row, "recordEvidence"), false);
  assert.equal(Object.hasOwn(preserved.envelope.row, "canonicalAttempt"), false);
  const value = await pipeline(t, fullTexts, fullBattles);
  const config = { ...value.config, allowedSessions: { official: [{ sessionId: "r7-synthetic-official", dayNo: 1, roundNo: 1 }] }, stageTextCatalog: value.config.stageTextCatalog.map((row, index) => ({ ...row, id: ["gsc26-ai-s1-001", "gsc26-ai-s2-002", "gsc26-ai-s3-001"][index], catalog_version: "geumcheon-r5-20260903-v1" })) };
  assert.throws(() => validateAndNormalizeRecord(preserved.envelope, principal, config, new Date().toISOString()));
  assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"), originalHash);
});

test("99 converted units / 2168ms keeps public2740 and full fractional raw evidence through real file/outbox/server/query", async (t) => {
  const value = await pipeline(t, fullTexts, fullBattles);
  assert.equal(value.saved.total_char_count, "48");
  assert.equal(value.saved.total_time_ms, "2168");
  assert.equal(value.saved.final_cpm, "2740");
  assert.notEqual(value.saved.final_cpm, "1328");
  assert.equal(value.saved.recordEvidence?.canonicalAttempt.participantValidInputUnits, 99);
  assert.equal(value.saved.ai_total_time_ms, "43149");
  assert.deepEqual([value.saved.ai_stage1_time_ms, value.saved.ai_stage2_time_ms, value.saved.ai_stage3_time_ms], ["16221", "13996", "12931"]);
  assert.deepEqual(value.saved.recordEvidence?.battles.map((b) => b.aiTimeMs), [16221.2, 13996.2, 12931.2]);
  await postAndQuery(value);
});

test("partial1234/12x/5000 preserves public24, canonical36 and accuracy50 independently", async (t) => {
  const value = await pipeline(t, partialTexts, partialBattles);
  assert.equal(value.saved.final_cpm, "24");
  assert.equal(value.saved.final_accuracy, "50");
  assert.equal(value.saved.recordEvidence?.canonicalAttempt.participantAverageCpmRaw, 36);
  assert.equal(value.saved.recordEvidence?.canonicalAttempt.participantCorrectInputUnits, 2);
  assert.equal(value.saved.recordEvidence?.canonicalAttempt.participantValidInputUnits, 3);
  await postAndQuery(value);
});

test("synthetic missing evidence, malformed versions, raw tampering and wrong identities fail closed", async (t) => {
  const value = await pipeline(t, partialTexts, partialBattles);
  const mutations: Array<(row: any) => void> = [
    (r) => { delete r.recordEvidence; }, // Negative missing-original case: never manufacture evidence.
    (r) => { r.recordEvidence.schemaVersion = 2; },
    (r) => { r.recordEvidence.battles[0].userInput = "123"; },
    (r) => { r.recordEvidence.canonicalAttempt.recordId = "gsc26-pc01-22222222-2222-4222-8222-222222222222"; },
    (r) => { r.recordEvidence.canonicalAttempt.attemptId = "gsc26-attempt-22222222-2222-4222-8222-222222222222"; },
    (r) => { r.recordEvidence.canonicalAttempt.deviceId = "PC02"; },
    (r) => { r.final_cpm = "36"; }
  ];
  for (const mutate of mutations) {
    const payload = structuredClone(value.envelope);
    mutate(payload.row);
    assert.throws(() => validateAndNormalizeRecord(payload, principal, value.config, new Date().toISOString()));
  }
  await postAndQuery(value);
  const conflict = structuredClone(value.envelope);
  conflict.row.participant_name = "합성 다른 참가자";
  const response = await value.app.inject({ method: "POST", url: "/api/v1/records", headers: value.headers, payload: conflict });
  assert.equal(response.statusCode, 409, response.body);
});

test("public order remains victory priority then legacy CPM even when protected canonical CPM would reverse losses", async (t) => {
  const slowWin = await pipeline(t, fullTexts, fullBattles.map((b) => ({ ...b, userTimeMs: b.userTimeMs * 1000, userCpm: 3, aiTimeMs: b.aiTimeMs * 1000, aiElapsedMs: b.aiElapsedMs * 1000 })), "33333333-3333-4333-8333-333333333333");
  const loss24 = await pipeline(t, partialTexts, partialBattles, "44444444-4444-4444-8444-444444444444");
  const loss15 = await pipeline(t, partialTexts, [{ stage: 1, text: "1234", userInput: "1xxx", userTimeMs: 4000, userCpm: 15, userAccuracy: 25, aiTimeMs: 4000, aiElapsedMs: 4000, aiCpm: 60, plannedAiCpm: 100, aiTypedUnits: 4, aiTypedChars: 4, result: "AI_WIN" }], "55555555-5555-4555-8555-555555555555");
  assert.equal(slowWin.saved.final_cpm, "3");
  assert.equal(loss24.saved.final_cpm, "24");
  assert.equal(loss15.saved.final_cpm, "15");
  assert.equal(loss24.saved.recordEvidence?.canonicalAttempt.participantAverageCpmRaw, 36);
  assert.equal(loss15.saved.recordEvidence?.canonicalAttempt.participantAverageCpmRaw, 60);
  slowWin.config.stageTextCatalog.push(...loss24.config.stageTextCatalog);
  for (const value of [loss15, slowWin, loss24]) {
    const response = await slowWin.app.inject({ method: "POST", url: "/api/v1/records", headers: value.headers, payload: value.envelope });
    assert.equal(response.statusCode, 201, response.body);
  }
  const response = await slowWin.app.inject({ method: "GET", url: "/api/v1/records?session_kind=official&session_id=roundtrip&day_no=1&round_no=1", headers: { authorization: `Bearer ${readToken}`, "x-device-id": "LEADERBOARD01" } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().rows.map((row: RecordRow) => row.record_id), [slowWin.saved.record_id, loss24.saved.record_id, loss15.saved.record_id]);
  assert.ok(response.json().rows.every((row: RecordRow) => !Object.hasOwn(row, "recordEvidence") && !Object.hasOwn(row, "canonicalAttempt")));
});
