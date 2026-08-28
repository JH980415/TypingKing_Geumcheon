import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RecordStore } from "../src/recordStore.js";
import { validateAndNormalizeRecord } from "../src/recordSchema.js";
import type { AuthenticatedPrincipal } from "../src/auth.js";
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
