import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureRuntime, readRecords, saveRecord, setPracticeSessionMode } from "../../shared/csv/fileStore";
import type { SaveRecordInput } from "../../shared/types";

const selections = [
  { id: "gsc26-ai-s1-001", catalogVersion: "geumcheon-draft-20260825-v1", stageNumber: 1, text: "과학은 질문에서 시작됩니다" },
  { id: "gsc26-ai-s2-001", catalogVersion: "geumcheon-draft-20260825-v1", stageNumber: 2, text: "태양 에너지는 우리 생활에 새로운 힘을 더합니다" },
  { id: "gsc26-ai-s3-001", catalogVersion: "geumcheon-draft-20260825-v1", stageNumber: 3, text: "우리가 던진 작은 질문은 관찰과 실험을 거쳐 새로운 과학의 길을 엽니다" }
] as const;

function saveInput(interrupted: boolean): SaveRecordInput {
  return {
    participant_name: interrupted ? "중단참가자" : "완료참가자",
    phone_part1: "010",
    phone_part2: "1234",
    phone_part3: "5678",
    birth_year: "2014",
    birth_month: "1",
    birth_day: "2",
    privacy_agreed: true,
    privacy_agreed_at: "2026-08-25T00:00:00.000Z",
    stageTexts: selections.map((selection) => selection.text) as [string, string, string],
    stageTimesMs: [100, 200, 300],
    game_mode: "ai_challenge",
    stageTextSelections: selections,
    ...(interrupted
      ? {
          interruption: {
            action: "home" as const,
            resultStage: 2,
            stageCharCounts: [10, 5, 0] as [number, number, number],
            totalTypingUnits: 15,
            participantProgressPercent: 50
          }
        }
      : {})
  };
}

test("persists Geumcheon selected IDs and catalog version for completed and interrupted saves", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-stage-record-"));
  setPracticeSessionMode(false);
  try {
    const ctx = ensureRuntime(runtimeRoot);
    ctx.config.syncMode = "local";
    const completed = await saveRecord(ctx, saveInput(false));
    const interrupted = await saveRecord(ctx, saveInput(true));
    const records = readRecords(ctx) as Array<Record<string, string>>;

    for (const row of [completed, interrupted, ...records]) {
      const persisted = row as unknown as Record<string, string>;
      assert.equal(persisted.stage_text_catalog_version, "geumcheon-draft-20260825-v1");
      assert.equal(persisted.stage1_text_id, "gsc26-ai-s1-001");
      assert.equal(persisted.stage2_text_id, "gsc26-ai-s2-001");
      assert.equal(persisted.stage3_text_id, "gsc26-ai-s3-001");
    }
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
