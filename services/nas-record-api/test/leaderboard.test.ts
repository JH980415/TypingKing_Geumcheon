import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RecordStore } from "../src/recordStore.js";
import { validateAndNormalizeRecord } from "../src/recordSchema.js";
import type { AuthenticatedPrincipal } from "../src/auth.js";
import { buildCanonicalAiAttempt } from "../../../shared/utils/geumcheonAiAttempt.js";
import {
  OFFICIAL_SESSION,
  PRACTICE_SESSION,
  RECEIVED_AT,
  envelope,
  recordRow,
  validationConfig,
} from "./fixtures.js";

const principal: AuthenticatedPrincipal = {
  tokenId: "PC01-write",
  deviceId: "PC01",
  eventId: "geumcheon-science-festival-2026",
  role: "writer",
  allowedSessions: ["official", "practice"],
};

function canonicalAttemptForRank(
  recordId: string,
  result: "PARTICIPANT_WIN" | "GEUMNARAE_WIN",
  participantCpm: number,
  totalDuelTimeMs: number
) {
  const suffix = recordId.slice("gsc26-pc01-".length);
  const participantWon = result === "PARTICIPANT_WIN";
  return buildCanonicalAiAttempt({
    schemaVersion: 1,
    attemptId: `gsc26-attempt-${suffix}`,
    recordId,
    deviceId: "PC01",
    recordedAt: "2026-08-26T03:00:06.000Z",
    result,
    interruptionReason: null,
    participantFinishTimeMs: participantWon ? totalDuelTimeMs : null,
    geumnaraeFinishTimeMs: participantWon ? null : totalDuelTimeMs,
    stages: [1, 2, 3].map((stageNumber, index) => ({
      stageNumber: stageNumber as 1 | 2 | 3,
      entered: true,
      assignedInputUnits: 500,
      participantCorrectInputUnits: participantWon ? 500 : 0,
      participantValidInputUnits: index === 0 ? participantCpm : 0,
      participantActiveTypingTimeMs: index === 0 ? 60_000 : 0,
      geumnaraeCorrectInputUnits: participantWon ? 0 : 500,
      geumnaraeValidInputUnits: participantWon || index !== 0 ? 0 : 1,
      geumnaraeActiveTypingTimeMs: participantWon || index !== 0 ? 0 : 60_000,
      activeDuelTimeMs: index === 0 ? totalDuelTimeMs : 0,
    })),
  });
}

test("stores raw full RecordRow JSON and lists official/practice separately without masking or ranking", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-full-row-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RecordStore({ dataRoot: root });

  const official = validateAndNormalizeRecord(
    envelope(recordRow({
      memo: "사용자 중단:프로그램 종료",
      ai_challenge_status: "FAILED",
      ai_failed_stage: "2",
      stage2_vs_ai_result: "AI_WIN",
      stage3_vs_ai_result: "",
      final_vs_ai_result: "AI_WIN",
      challenge_result_label: "중단 패배",
      result_stage: "2",
      stage1_char_count: "4", stage2_char_count: "2", stage3_char_count: "0", total_char_count: "6",
      stage1_time_ms: "1000", stage2_time_ms: "500", stage3_time_ms: "0",
      stage1_cumulative_ms: "1000", stage2_cumulative_ms: "1500", total_time_ms: "1500",
      display_stage1_sec: "1.000", display_stage2_sec: "0.500", display_stage3_sec: "0.000", display_total_sec: "1.500",
      ai_stage1_time_ms: "1600", ai_stage2_time_ms: "400", ai_stage3_time_ms: "", ai_total_time_ms: "2000",
      ai_stage3_cpm: "",
      stage1_time_diff_ms: "-600", stage2_time_diff_ms: "100", stage3_time_diff_ms: "", final_time_diff_ms: "-500",
      participant_result_time_ms: "1500", ai_result_time_ms: "2000",
      participant_progress_percent: "50", ai_progress_percent: "100", duel_time_ms: "1500",
    })),
    principal,
    validationConfig(root),
    RECEIVED_AT,
  );
  const practiceId = "gsc26-pc01-22222222-2222-4222-8222-222222222222";
  const practice = validateAndNormalizeRecord(
    envelope(recordRow({ record_id: practiceId }), PRACTICE_SESSION),
    principal,
    validationConfig(root),
    RECEIVED_AT,
  );

  await store.put(official);
  await store.put(practice);

  const officialRows = await store.list(OFFICIAL_SESSION);
  const practiceRows = await store.list(PRACTICE_SESSION);
  assert.equal(officialRows.length, 1);
  assert.equal(practiceRows.length, 1);
  assert.equal(officialRows[0].phone_full, "01000000001");
  assert.equal(officialRows[0].memo, "사용자 중단:프로그램 종료");
  assert.equal("rank" in officialRows[0], false);
  assert.equal(practiceRows[0].record_id, practiceId);

  const rawPath = join(root, "기록저장", "1일차", "1회차", "incoming", "ai", `${official.row.record_id}.json`);
  const raw = JSON.parse(readFileSync(rawPath, "utf8")) as Record<string, unknown>;
  assert.equal(raw.record_id, official.row.record_id);
  assert.equal(raw.phone_full, "01000000001");
  assert.equal("row" in raw, false);
  assert.equal("payload_sha256" in raw, false);
});

test("lists canonical AI records by participant win then CPM, independent of total duration", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "nas-canonical-ranking-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RecordStore({ dataRoot: root });
  const rows = [
    ["A", "GEUMNARAE_WIN", 500, 1_000],
    ["B", "PARTICIPANT_WIN", 100, 99_000],
    ["C", "PARTICIPANT_WIN", 350, 40_000],
    ["D", "PARTICIPANT_WIN", 300, 5_000],
    ["E", "GEUMNARAE_WIN", 250, 80_000],
    ["F", "GEUMNARAE_WIN", 200, 2_000],
  ] as const;

  for (const [label, result, cpm, duration] of rows) {
    const recordId = `gsc26-pc01-0000000${label.charCodeAt(0) - 64}-0001-4001-8001-00000000000${label.charCodeAt(0) - 64}`;
    const row = recordRow({
      record_id: recordId,
      canonicalAttempt: canonicalAttemptForRank(recordId, result, cpm, duration),
      ai_challenge_status: result === "PARTICIPANT_WIN" ? "SUCCESS" : "FAILED",
      final_vs_ai_result: result === "PARTICIPANT_WIN" ? "USER_WIN" : "AI_WIN",
      challenge_result_label: result === "PARTICIPANT_WIN" ? "참여자 승리" : "참여자 패배",
    });
    await store.put({
      schema_version: 1,
      event_id: "geumcheon-science-festival-2026",
      session: OFFICIAL_SESSION,
      row,
      payload_sha256: "ranking-fixture",
      authenticated_device_id: "PC01",
      received_at: RECEIVED_AT,
    });
  }

  assert.deepEqual(
    (await store.list(OFFICIAL_SESSION)).map((row) => row.record_id.slice("gsc26-pc01-".length, "gsc26-pc01-".length + 8)),
    ["00000003", "00000004", "00000002", "00000001", "00000005", "00000006"]
  );

  const targetRecordId = "gsc26-pc01-00000003-0001-4001-8001-000000000003";
  await store.putAdminAction({
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: OFFICIAL_SESSION,
    action_id: "gsc26-action-77777777-7777-4777-8777-777777777777",
    created_at: "2026-08-26T03:11:00.000Z",
    admin_name: "운영자",
    action_type: "hide",
    target_record_id: targetRecordId,
    hidden: true,
  });
  await store.putAdminAction({
    schema_version: 1,
    event_id: "geumcheon-science-festival-2026",
    session: OFFICIAL_SESSION,
    action_id: "gsc26-action-88888888-8888-4888-8888-888888888888",
    created_at: "2026-08-26T03:12:00.000Z",
    admin_name: "운영자",
    action_type: "hide",
    target_record_id: targetRecordId,
    hidden: false,
  });

  assert.deepEqual(
    (await store.listEffective(OFFICIAL_SESSION)).map((row) => row.record_id.slice("gsc26-pc01-".length, "gsc26-pc01-".length + 8)),
    ["00000003", "00000004", "00000002", "00000001", "00000005", "00000006"]
  );
});
