import assert from "node:assert/strict";
import test from "node:test";
import * as challengeGame from "../../apps/typing-game/src/AIChallengeGame";
import type { SaveRecordInput } from "../../shared/types";

const { createInterruptedChallengeSaveInput } = challengeGame;

const participant = {
  name: "금천 참가자",
  phone1: "010",
  phone2: "1234",
  phone3: "5678",
  birthYear: "2014",
  birthMonth: "1",
  birthDay: "2",
  privacyAgreedAt: "2026-08-31T00:00:00.000Z"
};

const selections = [
  { id: "stage-1", catalogVersion: "test-v1", stageNumber: 1, text: "1234" },
  { id: "stage-2", catalogVersion: "test-v1", stageNumber: 2, text: "1234567890" },
  { id: "stage-3", catalogVersion: "test-v1", stageNumber: 3, text: "12345678901234567890" }
] as const;

const completedStageOne = {
  stage: 1,
  text: selections[0].text,
  userTimeMs: 4_000,
  userCpm: 60,
  userAccuracy: 100,
  aiTimeMs: 5_000,
  aiElapsedMs: 4_000,
  aiCpm: 45,
  plannedAiCpm: 175,
  aiTypedUnits: 3,
  aiTypedChars: 3,
  result: "USER_WIN" as const,
  userInput: selections[0].text
};

function finishedBattle({
  stage,
  userInput,
  userTimeMs,
  aiTypedUnits,
  aiElapsedMs,
  result
}: {
  stage: 1 | 2 | 3;
  userInput: string;
  userTimeMs: number;
  aiTypedUnits: number;
  aiElapsedMs: number;
  result: "USER_WIN" | "AI_WIN";
}) {
  const text = selections[stage - 1].text;
  return {
    stage,
    text,
    userTimeMs,
    userCpm: 100,
    userAccuracy: 100,
    aiTimeMs: aiElapsedMs,
    aiElapsedMs,
    aiCpm: 100,
    plannedAiCpm: 175,
    aiTypedUnits,
    aiTypedChars: aiTypedUnits,
    result,
    userInput
  };
}

function createFinishedSaveInput(input: Record<string, unknown>): SaveRecordInput {
  const create = (challengeGame as typeof challengeGame & {
    createChallengeSaveInput?: (value: Record<string, unknown>) => SaveRecordInput;
  }).createChallengeSaveInput;
  assert.equal(
    typeof create,
    "function",
    "the production challenge save serializer must be available for contract tests"
  );
  return create(input);
}

test("Stage 1 Geumnarae win records terminal raw evidence", () => {
  const input = createFinishedSaveInput({
    participant,
    stageTexts: selections.map((selection) => selection.text),
    stageTextSelections: selections,
    battleRows: [
      finishedBattle({
        stage: 1,
        userInput: "12x",
        userTimeMs: 5_000,
        aiTypedUnits: 4,
        aiElapsedMs: 5_000,
        result: "AI_WIN"
      })
    ],
    status: "FAILED",
    failedStage: "1",
    terminalStage: 1,
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.equal(input.ai?.display.resultLabel, "금나래 승리");

  assert.deepEqual(
    {
      result: input.canonicalAttempt?.result,
      stageReached: input.canonicalAttempt?.stageReached,
      stageState: input.canonicalAttempt?.stageState,
      wholeGameProgressRaw: input.canonicalAttempt?.wholeGameProgressRaw,
      participantAverageCpmRaw: input.canonicalAttempt?.participantAverageCpmRaw,
      geumnaraeProgressRaw: input.canonicalAttempt?.geumnaraeProgressRaw,
      geumnaraeAverageCpmRaw: input.canonicalAttempt?.geumnaraeAverageCpmRaw,
      totalActiveDuelTimeMs: input.canonicalAttempt?.totalActiveDuelTimeMs,
      participantFinishTimeMs: input.canonicalAttempt?.participantFinishTimeMs,
      geumnaraeFinishTimeMs: input.canonicalAttempt?.geumnaraeFinishTimeMs,
      contradictionCodes: input.canonicalAttempt?.contradictionCodes
    },
    {
      result: "GEUMNARAE_WIN",
      stageReached: 1,
      stageState: "IN_PROGRESS",
      wholeGameProgressRaw: 2 / 34 * 100,
      participantAverageCpmRaw: 36,
      geumnaraeProgressRaw: 4 / 34 * 100,
      geumnaraeAverageCpmRaw: 48,
      totalActiveDuelTimeMs: 5_000,
      participantFinishTimeMs: null,
      geumnaraeFinishTimeMs: 5_000,
      contradictionCodes: []
    }
  );
});

test("Stage 2 Geumnarae win completes the terminal stage without quarantining prior AI loss", () => {
  const input = createFinishedSaveInput({
    participant,
    stageTexts: selections.map((selection) => selection.text),
    stageTextSelections: selections,
    battleRows: [
      finishedBattle({
        stage: 1,
        userInput: selections[0].text,
        userTimeMs: 4_000,
        aiTypedUnits: 3,
        aiElapsedMs: 4_000,
        result: "USER_WIN"
      }),
      finishedBattle({
        stage: 2,
        userInput: "1234567x",
        userTimeMs: 6_000,
        aiTypedUnits: 10,
        aiElapsedMs: 6_000,
        result: "AI_WIN"
      })
    ],
    status: "FAILED",
    failedStage: "2",
    terminalStage: 2,
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.deepEqual(
    {
      result: input.canonicalAttempt?.result,
      stageReached: input.canonicalAttempt?.stageReached,
      wholeGameProgressRaw: input.canonicalAttempt?.wholeGameProgressRaw,
      participantAverageCpmRaw: input.canonicalAttempt?.participantAverageCpmRaw,
      geumnaraeProgressRaw: input.canonicalAttempt?.geumnaraeProgressRaw,
      geumnaraeAverageCpmRaw: input.canonicalAttempt?.geumnaraeAverageCpmRaw,
      totalActiveDuelTimeMs: input.canonicalAttempt?.totalActiveDuelTimeMs,
      geumnaraeCompleted: input.canonicalAttempt?.geumnaraeCompleted,
      geumnaraeFinishTimeMs: input.canonicalAttempt?.geumnaraeFinishTimeMs,
      contradictionCodes: input.canonicalAttempt?.contradictionCodes
    },
    {
      result: "GEUMNARAE_WIN",
      stageReached: 2,
      wholeGameProgressRaw: 11 / 34 * 100,
      participantAverageCpmRaw: 72,
      geumnaraeProgressRaw: 13 / 34 * 100,
      geumnaraeAverageCpmRaw: 78,
      totalActiveDuelTimeMs: 10_000,
      geumnaraeCompleted: true,
      geumnaraeFinishTimeMs: 10_000,
      contradictionCodes: []
    }
  );
});

test("full participant win records weighted raw progress CPM and finish time", () => {
  const input = createFinishedSaveInput({
    participant,
    stageTexts: selections.map((selection) => selection.text),
    stageTextSelections: selections,
    battleRows: [
      finishedBattle({
        stage: 1,
        userInput: selections[0].text,
        userTimeMs: 4_000,
        aiTypedUnits: 3,
        aiElapsedMs: 4_000,
        result: "USER_WIN"
      }),
      finishedBattle({
        stage: 2,
        userInput: selections[1].text,
        userTimeMs: 5_000,
        aiTypedUnits: 8,
        aiElapsedMs: 5_000,
        result: "USER_WIN"
      }),
      finishedBattle({
        stage: 3,
        userInput: selections[2].text,
        userTimeMs: 10_000,
        aiTypedUnits: 18,
        aiElapsedMs: 10_000,
        result: "USER_WIN"
      })
    ],
    status: "SUCCESS",
    failedStage: "",
    terminalStage: 3,
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.deepEqual(
    {
      result: input.canonicalAttempt?.result,
      stageReached: input.canonicalAttempt?.stageReached,
      stageState: input.canonicalAttempt?.stageState,
      assignedInputUnits: input.canonicalAttempt?.assignedInputUnits,
      wholeGameProgressRaw: input.canonicalAttempt?.wholeGameProgressRaw,
      participantAverageCpmRaw: input.canonicalAttempt?.participantAverageCpmRaw,
      geumnaraeProgressRaw: input.canonicalAttempt?.geumnaraeProgressRaw,
      geumnaraeAverageCpmRaw: input.canonicalAttempt?.geumnaraeAverageCpmRaw,
      totalActiveDuelTimeMs: input.canonicalAttempt?.totalActiveDuelTimeMs,
      participantCompleted: input.canonicalAttempt?.participantCompleted,
      participantFinishTimeMs: input.canonicalAttempt?.participantFinishTimeMs,
      geumnaraeCompleted: input.canonicalAttempt?.geumnaraeCompleted,
      geumnaraeFinishTimeMs: input.canonicalAttempt?.geumnaraeFinishTimeMs,
      contradictionCodes: input.canonicalAttempt?.contradictionCodes
    },
    {
      result: "PARTICIPANT_WIN",
      stageReached: 3,
      stageState: "COMPLETED",
      assignedInputUnits: 34,
      wholeGameProgressRaw: 100,
      participantAverageCpmRaw: 34 / 19_000 * 60_000,
      geumnaraeProgressRaw: 29 / 34 * 100,
      geumnaraeAverageCpmRaw: 29 / 19_000 * 60_000,
      totalActiveDuelTimeMs: 19_000,
      participantCompleted: true,
      participantFinishTimeMs: 19_000,
      geumnaraeCompleted: false,
      geumnaraeFinishTimeMs: null,
      contradictionCodes: []
    }
  );
});

test("active interruption stores raw participant, Geumnarae, and duel evidence", () => {
  const input = createInterruptedChallengeSaveInput({
    participant,
    stageTexts: selections.map((selection) => selection.text) as [string, string, string],
    stageTextSelections: selections,
    battles: [completedStageOne],
    stageIndex: 1,
    currentInput: "12x45",
    currentElapsedMs: 3_000,
    currentAiTypedUnits: 6,
    plannedAiCpm: 225,
    action: "exit",
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.deepEqual(input.canonicalAttempt?.stages, [
    {
      stageNumber: 1,
      entered: true,
      assignedInputUnits: 4,
      participantCorrectInputUnits: 4,
      participantValidInputUnits: 4,
      participantActiveTypingTimeMs: 4_000,
      geumnaraeCorrectInputUnits: 3,
      geumnaraeValidInputUnits: 3,
      geumnaraeActiveTypingTimeMs: 4_000,
      activeDuelTimeMs: 4_000
    },
    {
      stageNumber: 2,
      entered: true,
      assignedInputUnits: 10,
      participantCorrectInputUnits: 2,
      participantValidInputUnits: 5,
      participantActiveTypingTimeMs: 3_000,
      geumnaraeCorrectInputUnits: 6,
      geumnaraeValidInputUnits: 6,
      geumnaraeActiveTypingTimeMs: 3_000,
      activeDuelTimeMs: 3_000
    },
    {
      stageNumber: 3,
      entered: false,
      assignedInputUnits: 20,
      participantCorrectInputUnits: 0,
      participantValidInputUnits: 0,
      participantActiveTypingTimeMs: 0,
      geumnaraeCorrectInputUnits: 0,
      geumnaraeValidInputUnits: 0,
      geumnaraeActiveTypingTimeMs: 0,
      activeDuelTimeMs: 0
    }
  ]);
  assert.equal(input.canonicalAttempt?.result, "INTERRUPTED");
  assert.equal(input.canonicalAttempt?.interruptionReason, "EXIT");
  assert.equal(input.canonicalAttempt?.wholeGameProgressRaw, 6 / 34 * 100);
  assert.equal(input.canonicalAttempt?.participantAverageCpmRaw, 9 / 7_000 * 60_000);
  assert.equal(input.canonicalAttempt?.totalActiveDuelTimeMs, 7_000);
});

test("countdown interruption enters the displayed stage without adding active time", () => {
  const input = createInterruptedChallengeSaveInput({
    participant,
    stageTexts: selections.map((selection) => selection.text) as [string, string, string],
    stageTextSelections: selections,
    battles: [completedStageOne],
    stageIndex: 1,
    currentInput: "",
    currentElapsedMs: 0,
    currentAiTypedUnits: 0,
    plannedAiCpm: 225,
    action: "retry",
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.deepEqual(
    {
      entered: input.canonicalAttempt?.stages.map((stage) => stage.entered),
      participantStageTwoTime: input.canonicalAttempt?.stages[1]?.participantActiveTypingTimeMs,
      geumnaraeStageTwoTime: input.canonicalAttempt?.stages[1]?.geumnaraeActiveTypingTimeMs,
      stageTwoDuelTime: input.canonicalAttempt?.stages[1]?.activeDuelTimeMs,
      stageReached: input.canonicalAttempt?.stageReached,
      stageState: input.canonicalAttempt?.stageState,
      interruptionReason: input.canonicalAttempt?.interruptionReason,
      totalActiveDuelTimeMs: input.canonicalAttempt?.totalActiveDuelTimeMs
    },
    {
      entered: [true, true, false],
      participantStageTwoTime: 0,
      geumnaraeStageTwoTime: 0,
      stageTwoDuelTime: 0,
      stageReached: 2,
      stageState: "IN_PROGRESS",
      interruptionReason: "RETRY",
      totalActiveDuelTimeMs: 4_000
    }
  );
});

test("Stage 1 completion stays at its completed boundary before Stage 2 entry", () => {
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

  assert.deepEqual(
    {
      entered: input.canonicalAttempt?.stages.map((stage) => stage.entered),
      stageReached: input.canonicalAttempt?.stageReached,
      stageState: input.canonicalAttempt?.stageState
    },
    {
      entered: [true, false, false],
      stageReached: 1,
      stageState: "COMPLETED"
    }
  );
});

test("whole-game weighting includes every selected phrase before Stage 2 entry", () => {
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

  assert.deepEqual(
    {
      assignedInputUnits: input.canonicalAttempt?.assignedInputUnits,
      wholeGameProgressRaw: input.canonicalAttempt?.wholeGameProgressRaw,
      contradictionCodes: input.canonicalAttempt?.contradictionCodes
    },
    {
      assignedInputUnits: 34,
      wholeGameProgressRaw: 4 / 34 * 100,
      contradictionCodes: []
    }
  );
});

test("Geumnarae evidence counts only typing units actually rendered from fractional simulation", () => {
  const hangulSelections = [
    { id: "hangul-1", catalogVersion: "test-v1", stageNumber: 1, text: "가나" },
    { id: "hangul-2", catalogVersion: "test-v1", stageNumber: 2, text: "다라" },
    { id: "hangul-3", catalogVersion: "test-v1", stageNumber: 3, text: "마바" }
  ] as const;
  const input = createInterruptedChallengeSaveInput({
    participant,
    stageTexts: hangulSelections.map((selection) => selection.text) as [string, string, string],
    stageTextSelections: hangulSelections,
    battles: [],
    stageIndex: 0,
    currentInput: "",
    currentElapsedMs: 1_000,
    currentAiTypedUnits: 1.9,
    plannedAiCpm: 175,
    action: "exit",
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.deepEqual(
    {
      geumnaraeCorrectInputUnits:
        input.canonicalAttempt?.stages[0]?.geumnaraeCorrectInputUnits,
      geumnaraeValidInputUnits:
        input.canonicalAttempt?.stages[0]?.geumnaraeValidInputUnits,
      geumnaraeProgressRaw: input.canonicalAttempt?.geumnaraeProgressRaw
    },
    {
      geumnaraeCorrectInputUnits: 0,
      geumnaraeValidInputUnits: 0,
      geumnaraeProgressRaw: 0
    }
  );
});

test("fractional AI plan elapsed time rounds to the nearest canonical millisecond", () => {
  const input = createFinishedSaveInput({
    participant,
    stageTexts: selections.map((selection) => selection.text),
    stageTextSelections: selections,
    battleRows: [
      finishedBattle({
        stage: 1,
        userInput: "12x",
        userTimeMs: 5_001,
        aiTypedUnits: 4,
        aiElapsedMs: 5_000.75,
        result: "AI_WIN"
      })
    ],
    status: "FAILED",
    failedStage: "1",
    terminalStage: 1,
    isGeumcheon: true,
    debugModeType: ""
  });

  assert.deepEqual(
    {
      geumnaraeActiveTypingTimeMs:
        input.canonicalAttempt?.stages[0]?.geumnaraeActiveTypingTimeMs,
      activeDuelTimeMs: input.canonicalAttempt?.stages[0]?.activeDuelTimeMs,
      geumnaraeFinishTimeMs: input.canonicalAttempt?.geumnaraeFinishTimeMs
    },
    {
      geumnaraeActiveTypingTimeMs: 5_001,
      activeDuelTimeMs: 5_001,
      geumnaraeFinishTimeMs: 5_001
    }
  );
});
