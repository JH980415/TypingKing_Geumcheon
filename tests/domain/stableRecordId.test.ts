import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureRuntime, readRecords, saveRecord } from "../../shared/csv/fileStore";
import type { SaveRecordInput } from "../../shared/types";

const input: SaveRecordInput = {
  participant_name: "합성참가자",
  phone_part1: "010",
  phone_part2: "0000",
  phone_part3: "0001",
  birth_year: "2012",
  birth_month: "1",
  birth_day: "2",
  privacy_agreed: true,
  privacy_agreed_at: "2026-09-18T01:00:00.000Z",
  stageTexts: ["첫 문장", "둘째 문장", "셋째 문장"],
  stageTimesMs: [1_000, 2_000, 3_000],
  game_mode: "ai_challenge",
  final_accuracy: 100,
  ai: {
    status: "SUCCESS",
    failedStage: "",
    stageCpms: [150, 200, 250],
    stageTimesMs: [1_100, 2_100, 3_100],
    stageResults: ["USER_WIN", "USER_WIN", "USER_WIN"],
    finalResult: "USER_WIN",
    stageDiffsMs: [-100, -100, -100],
    finalDiffMs: -300
  }
};

test("uses one supplied Geumcheon record ID across save retries without duplicate rows", async (context) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-stable-record-id-"));
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const ctx = ensureRuntime(runtimeRoot, path.resolve("."));
  ctx.config.syncMode = "local";
  const recordId = "gsc26-pc01-123e4567-e89b-42d3-a456-426614174000";

  const first = await saveRecord(ctx, input, recordId);
  const repeated = await saveRecord(ctx, input, recordId);
  const matching = readRecords(ctx).filter((row) => row.record_id === recordId);

  assert.equal(first.record_id, recordId);
  assert.equal(repeated.record_id, recordId);
  assert.equal(matching.length, 1);
});
