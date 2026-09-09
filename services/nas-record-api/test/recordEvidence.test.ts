import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SaveRecordInput } from "../../../shared/types/index.js";
import type { AuthenticatedPrincipal } from "../src/auth.js";
import { buildRecordRow } from "../../../shared/csv/fileStore.js";
import { canonicalStringify } from "../../../shared/nas/protocol.js";
import { calculateAccuracy, calculateCurrentCpm, countTypeableChars, getTextPrefixByTypingUnits, finalizeUserStageTimeMs } from "../../../shared/utils/typing.js";
import { RecordContradictionError, validateAndNormalizeRecord } from "../src/recordSchema.js";
import { RecordStore } from "../src/recordStore.js";
import { buildNasApp } from "../src/app.js";
import { validationConfig, RECORD_ID, RECEIVED_AT, envelope, headers, tokenManifest, OFFICIAL_SESSION, recordRow } from "./fixtures.js";

// The test runner's tsx hook loads the real renderer; server production has no JSX dependency.
const { createChallengeSaveInput } = createRequire(import.meta.url)("../../../apps/typing-game/src/AIChallengeGame.tsx") as { createChallengeSaveInput(input: any): SaveRecordInput };
const principal: AuthenticatedPrincipal = { tokenId: "PC01-write", deviceId: "PC01", eventId: "geumcheon-science-festival-2026", role: "writer", allowedSessions: ["official"] };
const texts = ["로봇과 노는 금천과학축제", "AI야, 금천과학축제 놀러가자!", "AI와 소통하는 활기찬 미래 금천"] as [string, string, string];

// Explicit synthetic raw evidence, not reconstructed from the discarded runtime03 input.
function sample(failed = false, empty = false, interrupted = false, aiDeadline?: number) {
  const scenarioTexts: [string, string, string] = failed ? ["1234", texts[1], texts[2]] : texts;
  const selections = scenarioTexts.map((text, i) => ({ id: `e${i + 1}`, catalogVersion: "evidence-v1", stageNumber: i + 1, text })) as any;
  const battles: any[] = scenarioTexts.map((text, i) => {
    const userTimeMs = [718, 717, 733][i]!;
    return { stage: i + 1, text, userTimeMs, userCpm: calculateCurrentCpm(text, userTimeMs, text), userAccuracy: calculateAccuracy(text, text), aiTimeMs: [16221.2, 13996.2, 12931.2][i]!, aiElapsedMs: userTimeMs, aiCpm: 0, plannedAiCpm: [112, 143, 169][i]!, aiTypedUnits: 0, aiTypedChars: countTypeableChars(getTextPrefixByTypingUnits(text, 0)), result: "USER_WIN" as const, userInput: text };
  });
  if (failed) battles.splice(0, battles.length, { stage: 1, text: "1234", userTimeMs: 5000, userCpm: 24, userAccuracy: 50, aiTimeMs: 4500, aiElapsedMs: 4500, aiCpm: 53, plannedAiCpm: 112, aiTypedUnits: 4, aiTypedChars: 4, result: "AI_WIN", userInput: "12x" });
  if (aiDeadline !== undefined) Object.assign(battles[0], { aiTimeMs: aiDeadline, ...(failed ? { aiElapsedMs: aiDeadline, aiCpm: Math.round(240000 / aiDeadline) } : {}) });
  if (empty) Object.assign(battles[0], { userInput: "", userCpm: 0, userAccuracy: 0 });
  if (interrupted) Object.assign(battles[0], { aiTimeMs: 5000, aiElapsedMs: 5000, aiCpm: 112, aiTypedUnits: 0, aiTypedChars: 0 });
  const input = createChallengeSaveInput({ participant: { name: "합성참가자", phone1: "010", phone2: "0000", phone3: "0001", birthYear: "2000", birthMonth: "02", birthDay: "29", privacyAgreedAt: "2026-08-26T02:59:00.000Z" }, stageTexts: scenarioTexts, stageTextSelections: selections, battleRows: battles, status: failed ? "FAILED" : "SUCCESS", failedStage: failed ? "1" : "", terminalStage: failed ? 1 : 3, isGeumcheon: true, debugModeType: "", ...(interrupted ? { interruptionAction: "home" } : {}) });
  const canonical = { ...input.canonicalAttempt!, recordId: RECORD_ID, attemptId: "gsc26-attempt-11111111-1111-4111-8111-111111111111", deviceId: "PC01", recordedAt: "2026-08-26T03:00:00.000Z", contradictionCodes: [] };
  const row = { record_id: RECORD_ID, ...buildRecordRow(input), created_at: "2026-08-26T03:00:00.000Z", completed_at: "2026-08-26T03:00:03.000Z", recordEvidence: { schemaVersion: 1 as const, canonicalAttempt: canonical, battles } };
  const config = validationConfig("X:\\unused");
  config.stageTextCatalog = selections.map((s: any) => ({ id: s.id, catalog_version: s.catalogVersion, game_mode: "ai_challenge", stage_number: String(s.stageNumber), text: s.text, is_active: "true", created_at: "2026-08-26T00:00:00.000Z", updated_at: "2026-08-26T00:00:00.000Z" }));
  return { row, config };
}

test("protected raw evidence accepts unchanged rounded legacy totals and converted-unit CPM", () => {
  const { row, config } = sample();
  assert.equal(row.total_char_count, "48");
  assert.equal(row.total_time_ms, "2168");
  assert.equal(row.final_cpm, "2740");
  assert.equal(row.ai_total_time_ms, "43149");
  assert.equal(row.final_time_diff_ms, "-40981");
  assert.deepEqual([row.ai_stage1_time_ms, row.ai_stage2_time_ms, row.ai_stage3_time_ms], ["16221", "13996", "12931"]);
  const before = canonicalStringify(row);
  const stored = validateAndNormalizeRecord(envelope(row), principal, config, RECEIVED_AT);
  assert.equal(canonicalStringify(stored.row), before);
  assert.equal(Object.hasOwn(stored.row, "canonicalAttempt"), false);
});

test("loss keeps approved matching-prefix CPM 24 rather than canonical valid-input CPM 36", () => {
  const { row, config } = sample(true);
  assert.equal(row.final_cpm, "24");
  assert.equal(row.final_accuracy, "50");
  assert.equal(row.recordEvidence.canonicalAttempt.participantAverageCpmRaw, 36);
  assert.equal(row.participant_result_time_ms, "10000");
  const stored = validateAndNormalizeRecord(envelope(row), principal, config, RECEIVED_AT);
  assert.equal(stored.row.final_cpm, "24");
  assert.equal(Object.hasOwn(stored.row, "canonicalAttempt"), false);
});

test("missing, malformed and unknown evidence never receive defaults", () => {
  for (const value of [undefined, null, {}, { schemaVersion: 2 }, { ...sample().row.recordEvidence, unexpected: true }]) {
    const { row, config } = sample();
    (row as any).recordEvidence = value;
    assert.throws(() => validateAndNormalizeRecord(envelope(row), principal, config, RECEIVED_AT));
  }
});

test("zero-input loss preserves unknown completion estimate as blank; interruption preserves its own elapsed time", () => {
  const loss = sample(true, true);
  assert.equal(loss.row.participant_result_time_ms, "");
  assert.equal(loss.row.final_cpm, "0");
  assert.equal(validateAndNormalizeRecord(envelope(loss.row), principal, loss.config, RECEIVED_AT).row.participant_result_time_ms, "");
  const stopped = sample(true, true, true);
  assert.equal(stopped.row.participant_result_time_ms, "5000");
  assert.equal(stopped.row.ai_total_time_ms, "5000");
  assert.equal(stopped.row.challenge_result_label, "중단 패배");
  assert.equal(validateAndNormalizeRecord(envelope(stopped.row), principal, stopped.config, RECEIVED_AT).row.final_cpm, "0");
});

test("failed records reject unplayed-stage time even when legacy cumulative fields agree", () => {
  const { row, config } = sample(true);
  Object.assign(row, { stage2_time_ms: "1000", stage2_cumulative_ms: "6000", total_time_ms: "6000", display_stage2_sec: "1.000", display_total_sec: "6.000" });
  assert.throws(() => validateAndNormalizeRecord(envelope(row), principal, config, RECEIVED_AT), /RECORD_EVIDENCE_MISMATCH/);
});

test("nested canonical identity contradictions retain the established quarantine path", () => {
  for (const field of ["deviceId", "recordId", "attemptId"] as const) {
    const { row, config } = sample();
    row.recordEvidence.canonicalAttempt[field] = field === "deviceId" ? "PC02" : "gsc26-attempt-22222222-2222-4222-8222-222222222222";
    assert.throws(() => validateAndNormalizeRecord(envelope(row), principal, config, RECEIVED_AT), (error: unknown) => error instanceof RecordContradictionError && error.reasonCodes.includes("IDENTITY_MISMATCH"));
  }
});

test("raw AI timeout and separately finalized participant time use their exact declared precision", () => {
  assert.equal(finalizeUserStageTimeMs(0, 5000.3), 5000);
  const valid = sample(true, false, false, 5000.2);
  assert.equal(valid.row.stage1_time_ms, "5000");
  assert.equal(valid.row.recordEvidence.battles[0].aiTimeMs, 5000.2);
  assert.equal(validateAndNormalizeRecord(envelope(valid.row), principal, valid.config, RECEIVED_AT).row.final_cpm, "24");
  const impossible = sample(true, false, false, 5000.6);
  assert.throws(() => validateAndNormalizeRecord(envelope(impossible.row), principal, impossible.config, RECEIVED_AT), /RECORD_EVIDENCE_MISMATCH/);
  const invalidWin = sample(false, false, false, 717.6);
  assert.throws(() => validateAndNormalizeRecord(envelope(invalidWin.row), principal, invalidWin.config, RECEIVED_AT), /RECORD_EVIDENCE_MISMATCH/);
});

test("intrinsic canonical totals contradictions retain quarantine for legacy and protected evidence", () => {
  const current = sample();
  const legacy = { row: recordRow(), config: validationConfig("X:\\unused") };
  for (const item of [current, legacy]) {
    const attempt = item.row.recordEvidence?.canonicalAttempt ?? item.row.canonicalAttempt!;
    attempt.participantAverageCpmRaw += 1;
    assert.throws(() => validateAndNormalizeRecord(envelope(item.row), principal, item.config, RECEIVED_AT), (error: unknown) => error instanceof RecordContradictionError && error.reasonCodes.includes("TOTALS_MISMATCH"));
  }
});

test("tampering one raw, canonical, fairness or legacy field is rejected", () => {
  const mutations = [
    (r: any) => { r.ai_total_time_ms = "43148"; },
    (r: any) => { r.final_cpm = "1328"; r.participant_avg_cpm = "1328"; },
    (r: any) => { r.recordEvidence.battles[0].userTimeMs += 1; },
    (r: any) => { r.recordEvidence.battles[0].aiTimeMs *= 1000; },
    (r: any) => { r.recordEvidence.battles[0].plannedAiCpm = 999; },
    (r: any) => { r.recordEvidence.canonicalAttempt.deviceId = "PC02"; },
    (r: any) => { r.recordEvidence.canonicalAttempt.stages[0].assignedInputUnits += 1; },
    (r: any) => { r.fairness.stages[0].typedText = "forged"; },
    (r: any) => { r.recordEvidence.battles[0].unknown = true; },
    (r: any) => { r.recordEvidence.battles[0].aiTimeMs = Number.NaN; },
    (r: any) => { r.rankingEligible = true; },
    (r: any) => { r.canonicalAttempt = r.recordEvidence.canonicalAttempt; },
  ];
  for (const mutate of mutations) {
    const { row, config } = sample();
    mutate(row);
    assert.throws(() => validateAndNormalizeRecord(envelope(row), principal, config, RECEIVED_AT));
  }
});

test("protected evidence survives idempotent storage and approved admin overlays but never public GET", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "nas-record-evidence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { row, config } = sample(true);
  config.dataRoot = root;
  const store = new RecordStore({ dataRoot: root });
  const app = buildNasApp({ config: { ...config, tokenManifest: tokenManifest() }, recordStore: store, now: () => RECEIVED_AT });
  context.after(() => app.close());
  const post = () => app.inject({ method: "POST", url: "/api/v1/records", headers: headers("writer", { "idempotency-key": RECORD_ID }), payload: envelope(row) });
  assert.equal((await post()).statusCode, 201);
  assert.equal((await post()).statusCode, 200);
  const original = canonicalStringify((await store.list(OFFICIAL_SESSION))[0]);
  assert.equal(original, canonicalStringify(row));
  const query = "/api/v1/records?session_kind=official&session_id=official-day1-round1&day_no=1&round_no=1";
  const response = await app.inject({ method: "GET", url: query, headers: headers("leaderboard") });
  assert.equal(response.statusCode, 200);
  const publicRow = response.json().rows[0];
  assert.equal(Object.hasOwn(publicRow, "recordEvidence"), false);
  assert.equal(Object.hasOwn(publicRow, "canonicalAttempt"), false);
  assert.equal(publicRow.final_cpm, "24");
  const action = { schema_version: 1 as const, event_id: principal.eventId, session: OFFICIAL_SESSION, action_id: "gsc26-action-22222222-2222-4222-8222-222222222222", created_at: RECEIVED_AT, admin_name: "합성운영자", action_type: "edit" as const, target_record_id: RECORD_ID, changes: { participant_name: "수정 합성참가자", final_cpm: "25" } };
  assert.equal((await store.putAdminAction(action)).disposition, "stored");
  const edited = (await store.listEffective(OFFICIAL_SESSION))[0]!;
  assert.equal(edited.final_cpm, "25");
  assert.deepEqual(edited.recordEvidence, row.recordEvidence);
  assert.equal(canonicalStringify((await store.list(OFFICIAL_SESSION))[0]), original);
  await assert.rejects(store.putAdminAction({ ...action, changes: { recordEvidence: row.recordEvidence } } as any), /ADMIN_EDIT_FIELD_FORBIDDEN/);
  row.recordEvidence.canonicalAttempt.recordedAt = "2026-08-26T02:59:59.000Z";
  assert.equal((await post()).statusCode, 409);
});

test("identity contradiction is durably quarantined unchanged, idempotent, and never publicly returned", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "nas-evidence-quarantine-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { row, config } = sample();
  config.dataRoot = root;
  row.recordEvidence.canonicalAttempt.deviceId = "PC02";
  const app = buildNasApp({ config: { ...config, tokenManifest: tokenManifest() }, now: () => RECEIVED_AT });
  context.after(() => app.close());
  const post = () => app.inject({ method: "POST", url: "/api/v1/records", headers: headers("writer", { "idempotency-key": RECORD_ID }), payload: envelope(row) });
  const first = await post();
  assert.equal(first.statusCode, 422);
  assert.equal(first.json().code, "RECORD_QUARANTINED");
  const file = join(root, "기록저장", "1일차", "1회차", "quarantine", "contradiction", `${RECORD_ID}.json`);
  const bytes = await readFile(file, "utf8");
  const quarantined = JSON.parse(bytes);
  assert.equal(quarantined.reason_code, "IDENTITY_MISMATCH");
  assert.deepEqual(quarantined.envelope.row, row);
  assert.equal((await post()).statusCode, 422);
  assert.equal(await readFile(file, "utf8"), bytes);
  const response = await app.inject({ method: "GET", url: "/api/v1/records?session_kind=official&session_id=official-day1-round1&day_no=1&round_no=1", headers: headers("leaderboard") });
  assert.deepEqual(response.json().rows, []);
  row.recordEvidence.canonicalAttempt.deviceId = "PC01";
  assert.equal((await post()).statusCode, 409);
});

test("stored nested canonical corruption fails closed before public admin overlays", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "nas-evidence-corrupt-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { row, config } = sample(true);
  const store = new RecordStore({ dataRoot: root });
  await store.put(validateAndNormalizeRecord(envelope(row), principal, config, RECEIVED_AT));
  const file = join(root, "기록저장", "1일차", "1회차", "incoming", "ai", `${RECORD_ID}.json`);
  const original = await readFile(file, "utf8");
  const mutations = [
    (r: any) => { r.recordEvidence.canonicalAttempt.participantAverageCpmRaw += 1; },
    (r: any) => { r.recordEvidence.canonicalAttempt.deviceId = "PC02"; },
    (r: any) => { r.recordEvidence.canonicalAttempt.stageReached = 3; },
  ];
  for (const mutate of mutations) {
    const corrupted = JSON.parse(original);
    mutate(corrupted);
    await writeFile(file, canonicalStringify(corrupted), "utf8");
    await assert.rejects(store.listEffective(OFFICIAL_SESSION), /STORAGE_CORRUPT/);
  }
  await writeFile(file, original, "utf8");
  await store.putAdminAction({ schema_version: 1, event_id: principal.eventId, session: OFFICIAL_SESSION, action_id: "gsc26-action-33333333-3333-4333-8333-333333333333", created_at: RECEIVED_AT, admin_name: "합성운영자", action_type: "edit", target_record_id: RECORD_ID, changes: { final_cpm: "25", result_stage: "2" } });
  const edited = await store.listEffective(OFFICIAL_SESSION);
  assert.equal(edited.length, 1);
  assert.equal(edited[0]!.final_cpm, "25");
  assert.deepEqual(edited[0]!.recordEvidence, row.recordEvidence);
});
