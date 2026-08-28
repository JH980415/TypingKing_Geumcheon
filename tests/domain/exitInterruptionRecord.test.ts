import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRuntime, readRecords, saveRecord } from "../../shared/csv/fileStore";
import type { SaveRecordInput } from "../../shared/types";

test("persists a program exit as an AI defeat with the exit-time result", async (context) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-exit-record-"));
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

  const ctx = ensureRuntime(runtimeRoot, path.resolve("."));
  ctx.config.syncMode = "local";
  const input: SaveRecordInput = {
    participant_name: "종료참가자",
    phone_part1: "010",
    phone_part2: "1234",
    phone_part3: "5678",
    birth_year: "2013",
    birth_month: "8",
    birth_day: "26",
    privacy_agreed: true,
    privacy_agreed_at: "2026-08-26T01:00:00.000Z",
    stageTexts: ["첫 번째 문장", "두 번째 문장", "세 번째 문장"],
    stageTimesMs: [7_000, 4_500, 0],
    game_mode: "ai_challenge",
    final_accuracy: 92,
    ai: {
      status: "FAILED",
      failedStage: "2",
      stageCpms: [175, 225, null],
      stageTimesMs: [8_000, 4_000, null],
      stageResults: ["USER_WIN", "AI_WIN", ""],
      finalResult: "AI_WIN",
      stageDiffsMs: [-1_000, 500, null],
      finalDiffMs: 500,
      display: {
        participantResultTimeMs: 11_500,
        aiResultTimeMs: 12_000,
        participantAvgCpm: 287,
        aiAvgCpm: 225,
        resultLabel: "중단 패배",
        participantProgressPercent: 64.5,
        aiProgressPercent: 100,
        duelTimeMs: 11_500,
        resultStage: 2
      }
    },
    interruption: {
      action: "exit",
      resultStage: 2,
      participantProgressPercent: 64.5,
      stageCharCounts: [30, 25, 0],
      totalTypingUnits: 55
    }
  };

  const saved = await saveRecord(ctx, input);
  const row = readRecords(ctx).find((record) => record.record_id === saved.record_id);

  assert.ok(row);

  assert.deepEqual(
    {
      memo: row.memo,
      status: row.ai_challenge_status,
      finalResult: row.final_vs_ai_result,
      resultLabel: row.challenge_result_label,
      resultStage: row.result_stage,
      cpm: row.participant_avg_cpm,
      finalCpm: row.final_cpm,
      participantTimeMs: row.participant_result_time_ms,
      totalTimeMs: row.total_time_ms,
      progressPercent: row.participant_progress_percent,
      duelTimeMs: row.duel_time_ms
    },
    {
      memo: "사용자 중단:프로그램 종료",
      status: "FAILED",
      finalResult: "AI_WIN",
      resultLabel: "중단 패배",
      resultStage: "2",
      cpm: "287",
      finalCpm: "287",
      participantTimeMs: "11500",
      totalTimeMs: "11500",
      progressPercent: "64.5",
      duelTimeMs: "11500"
    }
  );
});
