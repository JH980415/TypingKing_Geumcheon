import assert from "node:assert/strict";
import test from "node:test";

type AttemptModule = {
  buildCanonicalAiAttempt: (input: unknown) => any;
  isCanonicalAiAttemptV1: (value: unknown) => boolean;
  canonicalAiContradictionCodes: (
    attempt: any,
    expectedIdentity?: { recordId?: string; deviceId?: string; attemptId?: string }
  ) => string[];
};

async function loadAttemptModule(): Promise<AttemptModule> {
  try {
    return await import("../../shared/utils/geumcheonAiAttempt") as unknown as AttemptModule;
  } catch {
    assert.fail("canonical AI attempt module must exist");
  }
}

function stage(
  stageNumber: 1 | 2 | 3,
  overrides: Record<string, unknown> = {}
) {
  return {
    stageNumber,
    entered: true,
    assignedInputUnits: [10, 30, 60][stageNumber - 1],
    participantCorrectInputUnits: [10, 15, 0][stageNumber - 1],
    participantValidInputUnits: [10, 18, 0][stageNumber - 1],
    participantActiveTypingTimeMs: [6_000, 9_000, 0][stageNumber - 1],
    geumnaraeCorrectInputUnits: [10, 25, 30][stageNumber - 1],
    geumnaraeValidInputUnits: [10, 25, 30][stageNumber - 1],
    geumnaraeActiveTypingTimeMs: [6_000, 9_000, 15_000][stageNumber - 1],
    activeDuelTimeMs: [6_000, 9_000, 0][stageNumber - 1],
    ...overrides
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    attemptId: "attempt-pc01-001",
    recordId: "record-pc01-001",
    deviceId: "PC01",
    recordedAt: "2026-08-31T01:00:00.000Z",
    result: "INTERRUPTED",
    interruptionReason: "HOME",
    participantFinishTimeMs: null,
    geumnaraeFinishTimeMs: null,
    stages: [
      stage(1),
      stage(2),
      stage(3, {
        entered: false,
        participantCorrectInputUnits: 0,
        participantValidInputUnits: 0,
        participantActiveTypingTimeMs: 0,
        geumnaraeCorrectInputUnits: 0,
        geumnaraeValidInputUnits: 0,
        geumnaraeActiveTypingTimeMs: 0,
        activeDuelTimeMs: 0
      })
    ],
    ...overrides
  };
}

test("weights whole-game progress and CPM from raw integer evidence", async () => {
  const { buildCanonicalAiAttempt } = await loadAttemptModule();
  const attempt = buildCanonicalAiAttempt(evidence());

  assert.deepEqual(
    {
      stageReached: attempt.stageReached,
      stageState: attempt.stageState,
      assignedInputUnits: attempt.assignedInputUnits,
      wholeGameProgressRaw: attempt.wholeGameProgressRaw,
      participantAverageCpmRaw: attempt.participantAverageCpmRaw,
      geumnaraeProgressRaw: attempt.geumnaraeProgressRaw,
      geumnaraeAverageCpmRaw: attempt.geumnaraeAverageCpmRaw,
      totalActiveDuelTimeMs: attempt.totalActiveDuelTimeMs
    },
    {
      stageReached: 2,
      stageState: "IN_PROGRESS",
      assignedInputUnits: 100,
      wholeGameProgressRaw: 25,
      participantAverageCpmRaw: 112,
      geumnaraeProgressRaw: 35,
      geumnaraeAverageCpmRaw: 140,
      totalActiveDuelTimeMs: 15_000
    }
  );
});

test("keeps Stage 1 completed until Stage 2 is actually entered", async () => {
  const { buildCanonicalAiAttempt } = await loadAttemptModule();
  const attempt = buildCanonicalAiAttempt(evidence({
    stages: [
      stage(1),
      stage(2, {
        entered: false,
        participantCorrectInputUnits: 0,
        participantValidInputUnits: 0,
        participantActiveTypingTimeMs: 0,
        geumnaraeCorrectInputUnits: 0,
        geumnaraeValidInputUnits: 0,
        geumnaraeActiveTypingTimeMs: 0,
        activeDuelTimeMs: 0
      }),
      stage(3, {
        entered: false,
        participantCorrectInputUnits: 0,
        participantValidInputUnits: 0,
        participantActiveTypingTimeMs: 0,
        geumnaraeCorrectInputUnits: 0,
        geumnaraeValidInputUnits: 0,
        geumnaraeActiveTypingTimeMs: 0,
        activeDuelTimeMs: 0
      })
    ]
  }));

  assert.deepEqual(
    { stageReached: attempt.stageReached, stageState: attempt.stageState },
    { stageReached: 1, stageState: "COMPLETED" }
  );
});

test("includes all selected stage texts in progress before Stage 2 is entered", async () => {
  const { buildCanonicalAiAttempt } = await loadAttemptModule();
  const unentered = (stageNumber: 2 | 3) => stage(stageNumber, {
    entered: false,
    participantCorrectInputUnits: 0,
    participantValidInputUnits: 0,
    participantActiveTypingTimeMs: 0,
    geumnaraeCorrectInputUnits: 0,
    geumnaraeValidInputUnits: 0,
    geumnaraeActiveTypingTimeMs: 0,
    activeDuelTimeMs: 0
  });
  const attempt = buildCanonicalAiAttempt(evidence({
    stages: [
      stage(1, {
        participantCorrectInputUnits: 10,
        participantValidInputUnits: 10,
        geumnaraeCorrectInputUnits: 9,
        geumnaraeValidInputUnits: 9
      }),
      unentered(2),
      unentered(3)
    ]
  }));

  assert.deepEqual(
    {
      stageReached: attempt.stageReached,
      stageState: attempt.stageState,
      assignedInputUnits: attempt.assignedInputUnits,
      wholeGameProgressRaw: attempt.wholeGameProgressRaw,
      geumnaraeProgressRaw: attempt.geumnaraeProgressRaw,
      contradictionCodes: attempt.contradictionCodes
    },
    {
      stageReached: 1,
      stageState: "COMPLETED",
      assignedInputUnits: 100,
      wholeGameProgressRaw: 10,
      geumnaraeProgressRaw: 9,
      contradictionCodes: []
    }
  );
});

test("derives a consistent participant win when a finish-time tie belongs to the participant", async () => {
  const { buildCanonicalAiAttempt, isCanonicalAiAttemptV1 } = await loadAttemptModule();
  const attempt = buildCanonicalAiAttempt(evidence({
    result: "PARTICIPANT_WIN",
    interruptionReason: null,
    participantFinishTimeMs: 30_000,
    geumnaraeFinishTimeMs: 30_000,
    stages: [
      stage(1, { participantCorrectInputUnits: 10, participantValidInputUnits: 10 }),
      stage(2, {
        participantCorrectInputUnits: 30,
        participantValidInputUnits: 30,
        geumnaraeCorrectInputUnits: 30,
        geumnaraeValidInputUnits: 30
      }),
      stage(3, {
        participantCorrectInputUnits: 60,
        participantValidInputUnits: 60,
        participantActiveTypingTimeMs: 15_000,
        geumnaraeCorrectInputUnits: 60,
        geumnaraeValidInputUnits: 60,
        activeDuelTimeMs: 15_000
      })
    ]
  }));

  assert.equal(attempt.participantCompleted, true);
  assert.equal(attempt.geumnaraeCompleted, true);
  assert.deepEqual(attempt.contradictionCodes, []);
  assert.equal(isCanonicalAiAttemptV1(attempt), true);
  assert.equal(isCanonicalAiAttemptV1({ ...attempt, wholeGameProgressRaw: "100" }), false);
});

test("accepts Geumnarae win at the entered terminal stage before Stage 3", async () => {
  const { buildCanonicalAiAttempt } = await loadAttemptModule();
  const attempt = buildCanonicalAiAttempt(evidence({
    result: "GEUMNARAE_WIN",
    interruptionReason: null,
    participantFinishTimeMs: null,
    geumnaraeFinishTimeMs: 15_000,
    stages: [
      stage(1, { participantCorrectInputUnits: 10, geumnaraeCorrectInputUnits: 10 }),
      stage(2, { participantCorrectInputUnits: 15, geumnaraeCorrectInputUnits: 30 }),
      stage(3, {
        entered: false,
        participantCorrectInputUnits: 0,
        participantValidInputUnits: 0,
        participantActiveTypingTimeMs: 0,
        geumnaraeCorrectInputUnits: 0,
        geumnaraeValidInputUnits: 0,
        geumnaraeActiveTypingTimeMs: 0,
        activeDuelTimeMs: 0
      })
    ]
  }));

  assert.deepEqual(
    {
      result: attempt.result,
      stageReached: attempt.stageReached,
      stageState: attempt.stageState,
      participantCompleted: attempt.participantCompleted,
      geumnaraeCompleted: attempt.geumnaraeCompleted,
      wholeGameProgressRaw: attempt.wholeGameProgressRaw,
      geumnaraeProgressRaw: attempt.geumnaraeProgressRaw,
      contradictionCodes: attempt.contradictionCodes
    },
    {
      result: "GEUMNARAE_WIN",
      stageReached: 2,
      stageState: "IN_PROGRESS",
      participantCompleted: false,
      geumnaraeCompleted: true,
      wholeGameProgressRaw: 25,
      geumnaraeProgressRaw: 40,
      contradictionCodes: []
    }
  );
});

test("accepts Geumnarae win after completing only the highest entered terminal stage", async (t) => {
  const { buildCanonicalAiAttempt } = await loadAttemptModule();
  const notEntered = (stageNumber: 1 | 2 | 3) => stage(stageNumber, {
    entered: false,
    participantCorrectInputUnits: 0,
    participantValidInputUnits: 0,
    participantActiveTypingTimeMs: 0,
    geumnaraeCorrectInputUnits: 0,
    geumnaraeValidInputUnits: 0,
    geumnaraeActiveTypingTimeMs: 0,
    activeDuelTimeMs: 0
  });
  const cases = [
    {
      name: "Stage 1",
      stageReached: 1,
      geumnaraeFinishTimeMs: 6_000,
      stages: [
        stage(1, {
          participantCorrectInputUnits: 5,
          participantValidInputUnits: 5,
          geumnaraeCorrectInputUnits: 10,
          geumnaraeValidInputUnits: 10
        }),
        notEntered(2),
        notEntered(3)
      ]
    },
    {
      name: "Stage 2 after AI did not finish Stage 1",
      stageReached: 2,
      geumnaraeFinishTimeMs: 15_000,
      stages: [
        stage(1, {
          participantCorrectInputUnits: 10,
          participantValidInputUnits: 10,
          geumnaraeCorrectInputUnits: 9,
          geumnaraeValidInputUnits: 9
        }),
        stage(2, {
          participantCorrectInputUnits: 15,
          participantValidInputUnits: 18,
          geumnaraeCorrectInputUnits: 30,
          geumnaraeValidInputUnits: 30
        }),
        notEntered(3)
      ]
    },
    {
      name: "Stage 3 after AI did not finish Stages 1 and 2",
      stageReached: 3,
      geumnaraeFinishTimeMs: 30_000,
      stages: [
        stage(1, {
          participantCorrectInputUnits: 10,
          participantValidInputUnits: 10,
          geumnaraeCorrectInputUnits: 9,
          geumnaraeValidInputUnits: 9
        }),
        stage(2, {
          participantCorrectInputUnits: 30,
          participantValidInputUnits: 30,
          geumnaraeCorrectInputUnits: 29,
          geumnaraeValidInputUnits: 29
        }),
        stage(3, {
          participantCorrectInputUnits: 20,
          participantValidInputUnits: 20,
          participantActiveTypingTimeMs: 15_000,
          geumnaraeCorrectInputUnits: 60,
          geumnaraeValidInputUnits: 60,
          geumnaraeActiveTypingTimeMs: 15_000,
          activeDuelTimeMs: 15_000
        })
      ]
    }
  ] as const;

  for (const value of cases) {
    await t.test(value.name, () => {
      const attempt = buildCanonicalAiAttempt(evidence({
        result: "GEUMNARAE_WIN",
        interruptionReason: null,
        participantFinishTimeMs: null,
        geumnaraeFinishTimeMs: value.geumnaraeFinishTimeMs,
        stages: value.stages
      }));

      assert.deepEqual(
        {
          stageReached: attempt.stageReached,
          participantCompleted: attempt.participantCompleted,
          geumnaraeCompleted: attempt.geumnaraeCompleted,
          contradictionCodes: attempt.contradictionCodes
        },
        {
          stageReached: value.stageReached,
          participantCompleted: false,
          geumnaraeCompleted: true,
          contradictionCodes: []
        }
      );
    });
  }
});

test("quarantines timing, stage, CPM, and identity contradictions with stable codes", async () => {
  const { buildCanonicalAiAttempt, canonicalAiContradictionCodes } = await loadAttemptModule();
  const attempt = buildCanonicalAiAttempt(evidence({
    result: "GEUMNARAE_WIN",
    interruptionReason: null,
    participantFinishTimeMs: 29_000,
    geumnaraeFinishTimeMs: 30_000,
    stages: [
      stage(1, {
        participantCorrectInputUnits: 10,
        participantValidInputUnits: 10,
        participantActiveTypingTimeMs: 0
      }),
      stage(2, { participantCorrectInputUnits: 30, participantValidInputUnits: 30 }),
      stage(3, {
        participantCorrectInputUnits: 60,
        participantValidInputUnits: 60,
        geumnaraeCorrectInputUnits: 60,
        geumnaraeValidInputUnits: 60,
        activeDuelTimeMs: -1
      })
    ]
  }));
  const codes = canonicalAiContradictionCodes(attempt, {
    recordId: "different-record",
    deviceId: "PC01",
    attemptId: "attempt-pc01-001"
  });

  assert.ok(codes.includes("RESULT_TIMING_CONTRADICTION"));
  assert.ok(codes.includes("CPM_UNDEFINED"));
  assert.ok(codes.includes("METRIC_NEGATIVE"));
  assert.ok(codes.includes("IDENTITY_MISMATCH"));
});
