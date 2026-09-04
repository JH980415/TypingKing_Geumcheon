import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createActiveAttemptStore, type ActiveAttemptEncryption } from "../../electron/activeAttemptStore";
import { createGeumcheonRecordRuntime } from "../../electron/geumcheonRecordRuntime";
import type { RecordRow, ReviewRuntimeContext } from "../../shared/types";

const REVIEW_MARKER = "geumcheon-2026-review";

async function loadRuntime() {
  return import("../../electron/review/reviewLocalRuntime");
}

function reviewRecord(recordId: string, overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    record_id: recordId,
    created_at: "2026-09-03T01:00:00.000Z",
    completed_at: "2026-09-03T01:00:00.000Z",
    participant_name: "합성 참가자",
    phone_part1: "010",
    phone_part2: "0000",
    phone_part3: "0001",
    phone_full: "010-0000-0001",
    phone_masked: "010-****-0001",
    birth_year: "2012",
    birth_month: "01",
    birth_day: "02",
    birthdate: "2012-01-02",
    birthdate_masked: "2012-**-**",
    privacy_agreed: "true",
    privacy_agreed_at: "2026-09-03T01:00:00.000Z",
    stage1_text: "1234", stage2_text: "5678", stage3_text: "9012",
    stage_text_catalog_version: "geumcheon-v1",
    stage1_text_id: "s1", stage2_text_id: "s2", stage3_text_id: "s3",
    stage1_char_count: "4", stage2_char_count: "4", stage3_char_count: "4", total_char_count: "12",
    stage1_time_ms: "1000", stage2_time_ms: "1000", stage3_time_ms: "1000", stage1_cumulative_ms: "1000", stage2_cumulative_ms: "2000", total_time_ms: "3000",
    display_stage1_sec: "1.0", display_stage2_sec: "1.0", display_stage3_sec: "1.0", display_total_sec: "3.0",
    final_cpm: "240", final_accuracy: "100", app_version: "R2.0.4-R5", is_test: "false", is_debug: "false", debug_mode_type: "", memo: "", game_mode: "ai_challenge",
    ai_enabled: "true", ai_challenge_status: "SUCCESS", ai_failed_stage: "",
    ai_stage1_cpm: "", ai_stage2_cpm: "", ai_stage3_cpm: "", ai_stage1_time_ms: "", ai_stage2_time_ms: "", ai_stage3_time_ms: "", ai_total_time_ms: "",
    stage1_vs_ai_result: "", stage2_vs_ai_result: "", stage3_vs_ai_result: "", final_vs_ai_result: "",
    stage1_time_diff_ms: "", stage2_time_diff_ms: "", stage3_time_diff_ms: "", final_time_diff_ms: "",
    participant_result_time_ms: "", ai_result_time_ms: "", participant_avg_cpm: "", ai_avg_cpm: "", challenge_result_label: "",
    participant_progress_percent: "", ai_progress_percent: "", duel_time_ms: "", result_stage: "", original_record_id: "", is_admin_edited: "false",
    ...overrides,
  };
}

function session(kind: "official" | "practice") {
  return kind === "official"
    ? { kind, sessionId: "review-official-1", dayNo: 1, roundNo: 1 }
    : { kind, sessionId: "review-practice" };
}

function reviewContext(role: "player" | "leaderboard", sessionKind: "official" | "practice" = "official"): ReviewRuntimeContext {
  return {
    environment: "review",
    profileId: "geumcheon-2026",
    eventId: "geumcheon-science-festival-2026-review",
    buildId: "R2.0.4-R5",
    deviceId: `review-${sessionKind}-${role}`,
    role,
    sessionKind,
    storageKind: "local"
  };
}

function reviewId(): string {
  return `review-r5-record-${crypto.randomUUID()}`;
}

function checkpointInput() {
  return {
    participant_name: "합성 참가자", phone_part1: "010", phone_part2: "0000", phone_part3: "0001",
    birth_year: "2012", birth_month: "01", birth_day: "02", privacy_agreed: true,
    privacy_agreed_at: "2026-09-03T01:00:00.000Z", stageTexts: ["1234", "5678", "9012"] as [string, string, string],
    stageTimesMs: [1000, 1000, 1000] as [number, number, number],
  };
}

const testEncryption: ActiveAttemptEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8"),
};

test("shares an official session between game and leaderboard while keeping practice files separate", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createReviewLocalRuntime } = await loadRuntime();
  const game = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("official"), reviewContext: reviewContext("player") });
  const leaderboard = createReviewLocalRuntime({ rootDir: root, role: "leaderboard", session: session("official"), reviewContext: reviewContext("leaderboard") });
  const practice = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("practice"), reviewContext: reviewContext("player", "practice") });

  const row = reviewRecord(reviewId());
  await game.save(row);

  assert.deepEqual((await leaderboard.list()).map((entry) => entry.record_id), [row.record_id]);
  assert.deepEqual(await practice.list(), []);
  assert.equal(fs.existsSync(path.join(root, "official", "review-official-1", "records", `${row.record_id}.json`)), true);
  assert.equal(fs.existsSync(path.join(root, "practice", "review-practice", "records", `${row.record_id}.json`)), false);
});

test("leaderboard review runtime rejects record creation while retaining paired reads", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createReviewLocalRuntime } = await loadRuntime();
  const player = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("official"), reviewContext: reviewContext("player") });
  const leaderboard = createReviewLocalRuntime({ rootDir: root, role: "leaderboard", session: session("official"), reviewContext: reviewContext("leaderboard") });
  const rejected = reviewRecord(reviewId());

  await assert.rejects(leaderboard.save(rejected), { message: "REVIEW_RECORD_SAVE_PLAYER_ONLY" });
  assert.equal(fs.existsSync(path.join(root, "official", "review-official-1", "records", `${rejected.record_id}.json`)), false);

  const accepted = reviewRecord(reviewId());
  await player.save(accepted);
  assert.deepEqual((await leaderboard.list()).map((entry) => entry.record_id), [accepted.record_id]);
});

test("writes a validated atomic review envelope and ignores unfinished temporary files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createReviewLocalRuntime } = await loadRuntime();
  const runtime = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("official") });
  const row = reviewRecord(reviewId());

  await runtime.save(row);
  const recordDir = path.join(root, "official", "review-official-1", "records");
  const envelope = JSON.parse(fs.readFileSync(path.join(recordDir, `${row.record_id}.json`), "utf8"));
  fs.writeFileSync(path.join(recordDir, ".unfinished.tmp-review"), "{", "utf8");

  assert.deepEqual(envelope.reviewMarker, REVIEW_MARKER);
  assert.deepEqual(envelope.reviewIdentity, {
    environment: "review",
    profileId: "geumcheon-2026",
    eventId: "geumcheon-science-festival-2026-review",
    buildId: "R2.0.4-R5",
    storageKind: "local",
    writerRole: "player"
  });
  assert.deepEqual(envelope.row.record_id, row.record_id);
  assert.equal(JSON.stringify(envelope).includes(root), false);
  assert.deepEqual(fs.readdirSync(recordDir).filter((name) => name.startsWith(`.${row.record_id}.tmp-`)), []);
  assert.deepEqual((await runtime.list()).map((entry) => entry.record_id), [row.record_id]);
});

test("rejects stale mismatched or non-player review envelope identity", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-envelope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createReviewLocalRuntime } = await loadRuntime();
  const player = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("official"), reviewContext: reviewContext("player") });
  const leaderboard = createReviewLocalRuntime({ rootDir: root, role: "leaderboard", session: session("official"), reviewContext: reviewContext("leaderboard") });
  const row = reviewRecord(reviewId());
  await player.save(row);
  const target = path.join(root, "official", "review-official-1", "records", `${row.record_id}.json`);
  const original = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(original.reviewIdentity, {
    environment: "review",
    profileId: "geumcheon-2026",
    eventId: "geumcheon-science-festival-2026-review",
    buildId: "R2.0.4-R5",
    storageKind: "local",
    writerRole: "player"
  });
  const mismatches = {
    environment: "production",
    profileId: "skillup-2026",
    eventId: "stale-event",
    buildId: "R2.0.4-R4",
    storageKind: "onedrive",
    writerRole: "leaderboard"
  } as const;

  for (const [field, value] of Object.entries(mismatches)) {
    fs.writeFileSync(target, `${JSON.stringify({
      ...original,
      reviewIdentity: { ...original.reviewIdentity, [field]: value }
    })}\n`, "utf8");
    await assert.rejects(leaderboard.list(), { message: "REVIEW_RECORD_CORRUPT" }, field);
  }
});

test("fails visibly with a safe code when a final review record is corrupt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createReviewLocalRuntime } = await loadRuntime();
  const runtime = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("official") });
  const row = reviewRecord(reviewId());
  await runtime.save(row);
  fs.writeFileSync(path.join(root, "official", "review-official-1", "records", `${row.record_id}.json`), "not-json", "utf8");

  await assert.rejects(runtime.list(), { message: "REVIEW_RECORD_CORRUPT" });
});

test("validates player and fresh-root leaderboard storage without leaving probe records", async (t) => {
  const playerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-player-ready-"));
  const leaderboardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-board-ready-"));
  t.after(() => {
    fs.rmSync(playerRoot, { recursive: true, force: true });
    fs.rmSync(leaderboardRoot, { recursive: true, force: true });
  });
  const { createReviewLocalRuntime } = await loadRuntime();
  const player = createReviewLocalRuntime({ rootDir: playerRoot, role: "player", session: session("official"), reviewContext: reviewContext("player") });
  const leaderboard = createReviewLocalRuntime({ rootDir: leaderboardRoot, role: "leaderboard", session: session("official"), reviewContext: reviewContext("leaderboard") });

  await player.validateStorage();
  await leaderboard.validateStorage();

  const playerRecords = path.join(playerRoot, "official", "review-official-1", "records");
  const leaderboardRecords = path.join(leaderboardRoot, "official", "review-official-1", "records");
  assert.deepEqual(fs.readdirSync(playerRecords), []);
  assert.deepEqual(fs.readdirSync(leaderboardRecords), []);
  await assert.rejects(leaderboard.save(reviewRecord(reviewId())), { message: "REVIEW_RECORD_SAVE_PLAYER_ONLY" });
  assert.deepEqual(fs.readdirSync(leaderboardRecords), []);
});

test("keeps concurrent unique records lossless and makes a repeated record ID idempotent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createReviewLocalRuntime } = await loadRuntime();
  const left = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("official") });
  const right = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("official") });
  const observer = createReviewLocalRuntime({ rootDir: root, role: "leaderboard", session: session("official") });
  const rows = Array.from({ length: 12 }, () => reviewRecord(reviewId()));

  await Promise.all(rows.map((row, index) => (index % 2 === 0 ? left : right).save(row)));
  const repeated = await Promise.all([left.save(rows[0]), right.save(rows[0])]);

  assert.equal((await observer.list()).length, rows.length);
  assert.deepEqual(repeated.map((entry) => entry.record_id), [rows[0].record_id, rows[0].record_id]);
});

test("serializes edit hide and reset mutations, and uses the shared comparator for best selection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createReviewLocalRuntime } = await loadRuntime();
  const runtime = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("official") });
  const slower = reviewRecord(reviewId(), { total_time_ms: "5000", final_cpm: "200" });
  const faster = reviewRecord(reviewId(), { total_time_ms: "3000", final_cpm: "220" });
  await Promise.all([runtime.save(slower), runtime.save(faster)]);

  assert.deepEqual((await runtime.best()).map((entry) => entry.record_id), [faster.record_id]);
  await runtime.edit(slower.record_id, { participant_name: "수정된 참가자" });
  await runtime.hide(slower.record_id);
  assert.deepEqual((await runtime.list()).map((entry) => entry.record_id), [faster.record_id]);
  await runtime.reset();
  assert.deepEqual(await runtime.list(), []);
});

test("derives a stable opaque participant key without returning an identity or installation salt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-local-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createReviewLocalRuntime } = await loadRuntime();
  const first = createReviewLocalRuntime({ rootDir: root, role: "player", session: session("official") });
  const second = createReviewLocalRuntime({ rootDir: root, role: "leaderboard", session: session("official") });
  const identity = { participantName: "합성 참가자", phoneFull: "010-0000-0001", birthdate: "2012-01-02" };

  const [one, two] = await Promise.all([first.participantKeyFor(identity), second.participantKeyFor(identity)]);
  const stored = await first.save(reviewRecord(reviewId()));

  assert.match(one, /^[a-f0-9]{64}$/);
  assert.equal(one, two);
  assert.equal(stored.participantKey, one);
  assert.equal(one.includes(identity.participantName), false);
  assert.equal(one.includes(identity.phoneFull), false);
  assert.equal(one.includes(root), false);
});

test("accepts review identities only through explicit review policy injection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createReviewAttemptIdentity, reviewAttemptIdentityPolicy } = await loadRuntime();
  const identity = createReviewAttemptIdentity();
  const checkpoint = {
    schemaVersion: 2 as const, eventProfileId: "geumcheon-2026", variant: "ai" as const,
    recordId: identity.recordId, attemptId: identity.attemptId,
    recordedAt: "2026-09-03T01:00:00.000Z", updatedAt: "2026-09-03T01:00:00.000Z", input: checkpointInput(),
  };
  const productionStore = createActiveAttemptStore({
    checkpointPath: path.join(root, "production.bin"), encryption: testEncryption, eventProfileId: "geumcheon-2026",
  });
  const reviewStore = createActiveAttemptStore({
    checkpointPath: path.join(root, "review.bin"), encryption: testEncryption, eventProfileId: "geumcheon-2026",
    identityPolicy: reviewAttemptIdentityPolicy,
  });

  await assert.rejects(productionStore.save(checkpoint), { message: "ACTIVE_ATTEMPT_INVALID_CHECKPOINT" });
  await reviewStore.save(checkpoint);
  const runtime = createGeumcheonRecordRuntime({
    eventProfileId: "geumcheon-2026", variant: "ai", deviceId: "review-ai", store: reviewStore,
    createAttemptIdentity: () => identity, now: () => "2026-09-03T01:00:00.000Z",
    persistLocal: async (_input, savedIdentity) => reviewRecord(savedIdentity.recordId), enqueue: async () => undefined,
    identityPolicy: reviewAttemptIdentityPolicy,
  });

  assert.equal((await runtime.save(checkpointInput())).record_id, identity.recordId);
});
