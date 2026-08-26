import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGeumcheonFairness } from "../../apps/typing-game/src/AIChallengeGame";
import {
  loadEventProfile,
  resolveAiChallengeConfig
} from "../../shared/events/eventProfile";
import {
  ensureRuntime,
  flushQueuedRecords,
  readRecords,
  saveRecord,
  setPracticeSessionMode,
  updateOneDriveSettings,
  validateOneDriveSetup
} from "../../shared/csv/fileStore";
import {
  calculateTotalUserTimeMs,
  finalizeUserStageTimeMs,
  resumeStageTimerAfterControl
} from "../../shared/utils/typing";

const profile = loadEventProfile(
  path.resolve("events/geumcheon-2026/event.config.json")
);

test("uses official and practice AI ranges from the event profile", () => {
  assert.deepEqual(resolveAiChallengeConfig(profile, "official").stageSpeedRanges, {
    stage1: { min: 150, max: 200 },
    stage2: { min: 200, max: 250 },
    stage3: { min: 250, max: 300 }
  });
  assert.deepEqual(resolveAiChallengeConfig(profile, "practice").stageSpeedRanges, {
    stage1: { min: 100, max: 150 },
    stage2: { min: 150, max: 200 },
    stage3: { min: 200, max: 250 }
  });
});

test("keeps SkillUp's configured AI plan unchanged", () => {
  const skillup = loadEventProfile(path.resolve("events/skillup-2026/event.config.json"));
  assert.deepEqual(resolveAiChallengeConfig(skillup, "official").stageSpeedRanges, {
    stage1: { min: 300, max: 350 },
    stage2: { min: 350, max: 400 },
    stage3: { min: 400, max: 450 }
  });
});

test("sums stored integer per-stage user time instead of re-rounding a total", () => {
  assert.equal(calculateTotalUserTimeMs([1200, 2300, 3400]), 6900);
  assert.throws(() => calculateTotalUserTimeMs([1200.5]), /Invalid user time/);
  assert.throws(() => calculateTotalUserTimeMs([Number.POSITIVE_INFINITY]), /Invalid user time/);
  assert.throws(() => calculateTotalUserTimeMs([-1]), /Invalid user time/);
});

test("uses SkillUp control-dialog resume timing for Geumcheon too", () => {
  const stageStartedAt = 1_000;
  const controlOpenedAt = 1_500;
  const controlClosedAt = 2_300;
  const finishedAt = 3_400.6;

  const geumcheonStart = resumeStageTimerAfterControl(
    stageStartedAt,
    controlOpenedAt,
    controlClosedAt,
    true
  );

  assert.equal(finalizeUserStageTimeMs(geumcheonStart, finishedAt), 1601);
});

const selections = [
  { id: "gsc26-ai-s1-001", catalogVersion: "geumcheon-draft-20260825-v1", stageNumber: 1, text: "첫 번째 과학 문장" },
  { id: "gsc26-ai-s2-001", catalogVersion: "geumcheon-draft-20260825-v1", stageNumber: 2, text: "두 번째 과학 문장" },
  { id: "gsc26-ai-s3-001", catalogVersion: "geumcheon-draft-20260825-v1", stageNumber: 3, text: "세 번째 과학 문장" }
] as const;

function fairness(stageCount: 1 | 2 | 3, terminal: "USER_WIN" | "AI_WIN" | "INTERRUPTED") {
  const stages = selections.slice(0, stageCount).map((selection, index) => ({
    stageNumber: selection.stageNumber,
    textId: selection.id,
    catalogVersion: selection.catalogVersion,
    targetText: selection.text,
    typedText: index === stageCount - 1 && terminal !== "USER_WIN" ? "입력 중인 끝 텍스트" : selection.text,
    userTimeMs: [1200, 2300, 3400][index],
    typingUnits: [10, 20, 30][index],
    aiCpm: [175, 225, 275][index],
    result: index === stageCount - 1 ? terminal : "USER_WIN"
  }));
  return {
    catalogVersion: "geumcheon-draft-20260825-v1",
    totalUserTimeMs: stages.reduce((sum, stage) => sum + stage.userTimeMs, 0),
    stages
  };
}

function geumcheonSaveInput(value: ReturnType<typeof fairness>) {
  return {
    participant_name: "금천 참가자",
    phone_part1: "010",
    phone_part2: "1234",
    phone_part3: "5678",
    birth_year: "2014",
    birth_month: "1",
    birth_day: "2",
    privacy_agreed: true,
    privacy_agreed_at: "2026-08-26T00:00:00.000Z",
    stageTexts: selections.map((selection) => selection.text),
    stageTextSelections: selections,
    stageTimesMs: [1200, 2300, 3400],
    game_mode: "ai_challenge" as const,
    fairness: value
  };
}

function fairnessKey(value: ReturnType<typeof fairness>) {
  const terminal = value.stages.at(-1)!;
  return `${terminal.stageNumber}:${terminal.result}`;
}

test("persists the planned AI CPM for every countdown-stage interruption", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-geumcheon-countdown-"));
  try {
    const ctx = ensureRuntime(path.join(runtimeRoot, "runtime"));
    ctx.config.syncMode = "local";
    for (const [terminalStage, plannedAiCpm] of [[1, 175], [2, 225], [3, 275]] as const) {
      const battles = selections.slice(0, terminalStage).map((selection, index) => ({
        stage: selection.stageNumber,
        text: selection.text,
        userTimeMs: index === terminalStage - 1 ? 0 : [1200, 2300][index],
        userInput: index === terminalStage - 1 ? "" : selection.text,
        aiCpm: 0,
        plannedAiCpm,
        result: "AI_WIN" as const
      }));
      const produced = createGeumcheonFairness(battles, selections, "home", terminalStage);
      assert.equal(produced.stages.at(-1)?.aiCpm, plannedAiCpm);
      const saved = await saveRecord(ctx, geumcheonSaveInput(produced));
      assert.equal(saved.fairness?.stages.at(-1)?.aiCpm, plannedAiCpm);
      assert.equal(saved.fairness?.stages.at(-1)?.result, "INTERRUPTED");
    }
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("keeps complete, AI-loss, and interrupted Geumcheon fairness data through JSON, queue, and readback", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-geumcheon-fairness-"));
  const oneDriveRoot = path.join(runtimeRoot, "onedrive");
  setPracticeSessionMode(false);
  try {
    const ctx = ensureRuntime(path.join(runtimeRoot, "runtime"));
    updateOneDriveSettings(ctx, {
      syncMode: "onedrive_manual",
      pcRole: "player",
      pcId: "PC01",
      oneDriveRoot,
      recordBaseFolderName: "records",
      dayNo: 1,
      roundNo: 1
    }, "player");
    validateOneDriveSetup(ctx, "player");

    const expected = [fairness(3, "USER_WIN"), fairness(2, "AI_WIN"), fairness(2, "INTERRUPTED")];
    const saved = [];
    for (const value of expected) saved.push(await saveRecord(ctx, geumcheonSaveInput(value)));
    assert.deepEqual(saved.map((row) => row.fairness), expected);

    const firstJson = JSON.parse(fs.readFileSync(path.join(ctx.config.aiIncomingPath, `${saved[0].record_id}.json`), "utf8"));
    assert.deepEqual(firstJson.fairness, expected[0]);
    assert.deepEqual(
      readRecords(ctx).map((row) => row.fairness).sort((left, right) => fairnessKey(left!).localeCompare(fairnessKey(right!))),
      expected.sort((left, right) => fairnessKey(left).localeCompare(fairnessKey(right)))
    );

    fs.rmSync(ctx.config.aiIncomingPath, { recursive: true, force: true });
    const queuedFairness = fairness(1, "INTERRUPTED");
    await assert.rejects(saveRecord(ctx, geumcheonSaveInput(queuedFairness)));
    const queueFile = fs.readdirSync(ctx.paths.localQueueDir).find((name) => name.endsWith(".json"));
    assert.ok(queueFile);
    const queuedJson = JSON.parse(fs.readFileSync(path.join(ctx.paths.localQueueDir, queueFile), "utf8"));
    assert.deepEqual(queuedJson.record.fairness, queuedFairness);

    fs.mkdirSync(ctx.config.aiIncomingPath, { recursive: true });
    assert.equal(flushQueuedRecords(ctx).sent, 1);
    assert.ok(readRecords(ctx).some((row) => row.fairness?.stages[0]?.typedText === "입력 중인 끝 텍스트"));
  } finally {
    setPracticeSessionMode(false);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
