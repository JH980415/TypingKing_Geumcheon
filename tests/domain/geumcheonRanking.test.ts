import assert from "node:assert/strict";
import test from "node:test";
import {
  assignOfficialAttemptEligibility,
  calculateEffectiveCpm,
  compareGeumcheonRecords,
  selectBestEligibleRecordPerParticipant,
  type OfficialAttemptCandidate
} from "../../shared/utils/geumcheonRanking";

function completed(
  overrides: Partial<OfficialAttemptCandidate> = {}
): OfficialAttemptCandidate {
  return {
    recordId: "gsc26-pc01-00000000-0000-4000-8000-000000000001",
    participantKey: "participant-hmac-a",
    serverReceivedAt: "2026-09-18T01:00:00.000Z",
    completedAt: "2026-09-18T01:02:00.000Z",
    completionStatus: "completed",
    completedStages: 3,
    progressPercent: 100,
    totalTypingUnits: 300,
    totalUserTimeMs: 30000,
    isTest: false,
    isDebug: false,
    ...overrides
  };
}

test("calculates unrounded effective CPM from integer typing units and milliseconds", () => {
  assert.equal(calculateEffectiveCpm(385, 33000), 700);
  assert.equal(calculateEffectiveCpm(301, 30000), 602);
});

test("ranks an 11 second 700 CPM completion over a 10 second 600 CPM completion", () => {
  const faster = completed({
    recordId: "gsc26-pc01-00000000-0000-4000-8000-000000000002",
    totalTypingUnits: 385,
    totalUserTimeMs: 33000
  });
  const shorter = completed({ totalTypingUnits: 300, totalUserTimeMs: 30000 });

  assert.ok(compareGeumcheonRecords(faster, shorter) < 0);
});

test("counts completed, failed, and interrupted records among the first three ranking attempts", () => {
  const rows = assignOfficialAttemptEligibility([
    completed({
      recordId: "gsc26-pc01-00000000-0000-4000-8000-000000000003",
      serverReceivedAt: "2026-09-18T01:00:03.000Z"
    }),
    completed({
      recordId: "gsc26-pc01-00000000-0000-4000-8000-000000000001",
      serverReceivedAt: "2026-09-18T01:00:01.000Z",
      completionStatus: "failed",
      completedStages: 2,
      progressPercent: 80
    }),
    completed({
      recordId: "gsc26-pc01-00000000-0000-4000-8000-000000000002",
      serverReceivedAt: "2026-09-18T01:00:02.000Z",
      completionStatus: "interrupted",
      completedStages: 2,
      progressPercent: 70
    }),
    completed({
      recordId: "gsc26-pc01-00000000-0000-4000-8000-000000000004",
      serverReceivedAt: "2026-09-18T01:00:04.000Z"
    })
  ]);

  assert.deepEqual(
    rows.map((row) => [row.recordId.slice(-12), row.attemptNumber, row.rankingEligible]),
    [
      ["000000000001", 1, true],
      ["000000000002", 2, true],
      ["000000000003", 3, true],
      ["000000000004", 4, false]
    ]
  );
});

test("keeps a zero-elapsed countdown interruption visible below finishers", () => {
  const rows = assignOfficialAttemptEligibility([
    completed({
      recordId: "incomplete-only",
      participantKey: "participant-hmac-incomplete",
      serverReceivedAt: "2026-09-18T01:00:01.000Z",
      completionStatus: "interrupted",
      completedStages: 0,
      progressPercent: 0,
      totalTypingUnits: 0,
      totalUserTimeMs: 0
    }),
    completed({
      recordId: "finisher",
      participantKey: "participant-hmac-finisher",
      serverReceivedAt: "2026-09-18T01:00:02.000Z"
    })
  ]);

  assert.deepEqual(
    selectBestEligibleRecordPerParticipant(rows).map((row) => row.recordId),
    ["finisher", "incomplete-only"]
  );
});

test("does not count test or debug rows toward the official attempt limit", () => {
  const rows = assignOfficialAttemptEligibility([
    completed({ recordId: "debug", isDebug: true }),
    completed({ recordId: "test", isTest: true }),
    completed({ recordId: "real-1", serverReceivedAt: "2026-09-18T01:00:01.000Z" })
  ]);

  assert.deepEqual(
    rows.map((row) => [row.recordId, row.attemptNumber, row.rankingEligible]),
    [
      ["debug", null, false],
      ["test", null, false],
      ["real-1", 1, true]
    ]
  );
});

test("selects one best eligible completion per participant", () => {
  const rows = assignOfficialAttemptEligibility([
    completed({
      recordId: "a-slower",
      serverReceivedAt: "2026-09-18T01:00:01.000Z",
      totalTypingUnits: 300,
      totalUserTimeMs: 30000
    }),
    completed({
      recordId: "a-faster",
      serverReceivedAt: "2026-09-18T01:00:02.000Z",
      totalTypingUnits: 385,
      totalUserTimeMs: 33000
    }),
    completed({
      recordId: "a-third",
      serverReceivedAt: "2026-09-18T01:00:03.000Z",
      totalTypingUnits: 310,
      totalUserTimeMs: 30000
    }),
    completed({
      recordId: "b-only",
      participantKey: "participant-hmac-b",
      serverReceivedAt: "2026-09-18T01:00:01.000Z",
      totalTypingUnits: 320,
      totalUserTimeMs: 30000
    }),
    completed({
      recordId: "a-fourth-best-but-ineligible",
      serverReceivedAt: "2026-09-18T01:00:04.000Z",
      totalTypingUnits: 600,
      totalUserTimeMs: 30000
    })
  ]);

  assert.deepEqual(
    selectBestEligibleRecordPerParticipant(rows).map((row) => row.recordId),
    ["a-faster", "b-only"]
  );
});

test("rejects unsafe ranking inputs before exact ratio comparison", () => {
  assert.throws(() => calculateEffectiveCpm(1.5, 1000), /safe integer/i);
  assert.throws(() => calculateEffectiveCpm(1, 0), /positive/i);
  assert.throws(
    () => compareGeumcheonRecords(completed({ totalTypingUnits: -1 }), completed()),
    /nonnegative/i
  );
});
