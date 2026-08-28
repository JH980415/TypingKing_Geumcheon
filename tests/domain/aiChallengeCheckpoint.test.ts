import assert from "node:assert/strict";
import test from "node:test";
import {
  createInterruptedChallengeSaveInput,
  persistInterruptedChallengeBeforeLeave,
  requiresBattlePopupInterruption,
  startActiveAttemptCheckpointLoop
} from "../../apps/typing-game/src/AIChallengeGame";
import type { SaveRecordInput } from "../../shared/types";

const participant = {
  name: "금천 참가자",
  phone1: "010",
  phone2: "1234",
  phone3: "5678",
  birthYear: "2014",
  birthMonth: "1",
  birthDay: "2",
  privacyAgreedAt: "2026-08-26T00:00:00.000Z"
};

const selections = [
  { id: "gsc26-ai-s1-001", catalogVersion: "geumcheon-v1", stageNumber: 1, text: "1234" },
  { id: "gsc26-ai-s2-001", catalogVersion: "geumcheon-v1", stageNumber: 2, text: "1234567890" },
  { id: "gsc26-ai-s3-001", catalogVersion: "geumcheon-v1", stageNumber: 3, text: "123456789012" }
] as const;

const completedStageOne = {
  stage: 1,
  text: "1234",
  userTimeMs: 4000,
  userCpm: 60,
  userAccuracy: 100,
  aiTimeMs: 5000,
  aiElapsedMs: 4000,
  aiCpm: 45,
  plannedAiCpm: 175,
  aiTypedUnits: 3,
  aiTypedChars: 3,
  result: "USER_WIN" as const,
  userInput: "1234"
};

test("exit checkpoint preserves completed stages and captures the live stage metrics", () => {
  const input = createInterruptedChallengeSaveInput({
    participant,
    stageTexts: selections.map((selection) => selection.text) as [string, string, string],
    stageTextSelections: selections,
    battles: [completedStageOne],
    stageIndex: 1,
    currentInput: "123",
    currentElapsedMs: 3000,
    currentAiTypedUnits: 2,
    plannedAiCpm: 225,
    action: "exit",
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.deepEqual(input.stageTimesMs, [4000, 3000, 0]);
  assert.equal(input.final_accuracy, 30);
  assert.deepEqual(input.ai?.stageResults, ["USER_WIN", "AI_WIN", ""]);
  assert.equal(input.ai?.status, "FAILED");
  assert.equal(input.ai?.failedStage, "2");
  assert.equal(input.ai?.finalResult, "AI_WIN");
  assert.equal(input.ai?.display?.resultLabel, "중단 패배");
  assert.equal(input.ai?.display?.resultStage, 2);
  assert.equal(input.ai?.display?.participantResultTimeMs, 7000);
  assert.equal(input.ai?.display?.participantAvgCpm, 60);
  assert.equal(input.ai?.display?.participantProgressPercent, 43.3);
  assert.deepEqual(input.interruption, {
    action: "exit",
    resultStage: 2,
    participantProgressPercent: 43.3,
    stageCharCounts: [4, 3, 0],
    totalTypingUnits: 7
  });
  assert.deepEqual(input.fairness?.stages.map((stage) => ({
    stageNumber: stage.stageNumber,
    typedText: stage.typedText,
    result: stage.result
  })), [
    { stageNumber: 1, typedText: "1234", result: "USER_WIN" },
    { stageNumber: 2, typedText: "123", result: "INTERRUPTED" }
  ]);
});

test("stage-win popup exit keeps the won-stage measurements but records the attempt as interrupted loss", () => {
  const input = createInterruptedChallengeSaveInput({
    participant,
    stageTexts: selections.map((selection) => selection.text) as [string, string, string],
    stageTextSelections: selections,
    battles: [completedStageOne],
    stageIndex: 0,
    currentInput: "",
    currentElapsedMs: 0,
    currentAiTypedUnits: 0,
    plannedAiCpm: 225,
    action: "home",
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.deepEqual(input.stageTimesMs, [4000, 0, 0]);
  assert.deepEqual(input.ai?.stageResults, ["USER_WIN", "AI_WIN", ""]);
  assert.equal(input.ai?.status, "FAILED");
  assert.equal(input.ai?.finalResult, "AI_WIN");
  assert.equal(input.ai?.display?.resultLabel, "중단 패배");
  assert.equal(input.ai?.display?.resultStage, 2);
  assert.equal(input.fairness?.stages[0]?.result, "USER_WIN");
  assert.equal(input.fairness?.stages[1]?.result, "INTERRUPTED");
  assert.deepEqual(input.interruption?.stageCharCounts, [4, 0, 0]);
});

test("immediate exit keeps the selected AI plan CPM for a server-valid interruption", () => {
  const input = createInterruptedChallengeSaveInput({
    participant,
    stageTexts: selections.map((selection) => selection.text) as [string, string, string],
    stageTextSelections: selections,
    battles: [],
    stageIndex: 0,
    currentInput: "",
    currentElapsedMs: 852,
    currentAiTypedUnits: 0,
    plannedAiCpm: 175,
    action: "exit",
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.deepEqual(input.ai?.stageCpms, [175, null, null]);
  assert.equal(input.fairness?.stages[0]?.aiCpm, 175);
  assert.equal(input.ai?.display?.participantResultTimeMs, 852);
  assert.equal(input.ai?.display?.participantProgressPercent, 0);
});

test("only unfinished Geumcheon stage wins require popup interruption confirmation", () => {
  assert.equal(requiresBattlePopupInterruption("geumcheon-2026", { stage: 2, result: "USER_WIN" }), true);
  assert.equal(requiresBattlePopupInterruption("skillup-2026", { stage: 2, result: "USER_WIN" }), false);
  assert.equal(requiresBattlePopupInterruption("geumcheon-2026", { stage: 2, result: "AI_WIN" }), false);
  assert.equal(requiresBattlePopupInterruption("geumcheon-2026", { stage: 3, result: "USER_WIN" }), false);
});

test("checkpoint loop writes every 350ms without overlapping and can pause before final save", async () => {
  let intervalMs = 0;
  let intervalCallback = () => {};
  let clearedTimer = 0;
  let snapshot = 1;
  let releaseFirst = () => {};
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const writes: number[] = [];
  const loop = startActiveAttemptCheckpointLoop({
    createInput: () => snapshot,
    writeCheckpoint: async (value) => {
      writes.push(value);
      if (value === 1) await firstWrite;
      return { ok: true };
    },
    onError: () => assert.fail("successful checkpoint must not report an error"),
    setIntervalFn: (callback, delayMs) => {
      intervalCallback = callback;
      intervalMs = delayMs;
      return 17;
    },
    clearIntervalFn: (timer) => {
      clearedTimer = timer;
    }
  });

  assert.equal(intervalMs, 350);
  assert.deepEqual(writes, [1]);
  snapshot = 2;
  intervalCallback();
  assert.deepEqual(writes, [1]);

  releaseFirst();
  await loop.waitForPending();
  intervalCallback();
  await loop.waitForPending();
  assert.deepEqual(writes, [1, 2]);

  loop.pause();
  snapshot = 3;
  intervalCallback();
  assert.deepEqual(writes, [1, 2]);
  loop.resume();
  await loop.waitForPending();
  assert.deepEqual(writes, [1, 2, 3]);

  loop.stop();
  assert.equal(clearedTimer, 17);
});

test("does not leave the challenge when interruption defeat persistence fails", async () => {
  let leaveCalls = 0;
  const result = await persistInterruptedChallengeBeforeLeave({
    input: {} as SaveRecordInput,
    saveRecord: async () => ({ ok: false, error: "private storage detail" }),
    leave: () => {
      leaveCalls += 1;
    }
  });

  assert.deepEqual(result, {
    ok: false,
    error: "중단 기록을 저장하지 못했습니다. 기록이 저장될 때까지 다시 시도해 주세요."
  });
  assert.equal(leaveCalls, 0);
});

test("leaves the challenge only after interruption defeat persistence succeeds", async () => {
  let leaveCalls = 0;
  const result = await persistInterruptedChallengeBeforeLeave({
    input: {} as SaveRecordInput,
    saveRecord: async () => ({ ok: true }),
    leave: () => {
      leaveCalls += 1;
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(leaveCalls, 1);
});
