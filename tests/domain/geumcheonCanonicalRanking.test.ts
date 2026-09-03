import assert from "node:assert/strict";
import test from "node:test";

type RankingModule = {
  canonicalAiRankKey?: (record: any) => readonly [number, number];
  compareCanonicalAiDisplayOrder?: (left: any, right: any) => number;
  rankCanonicalAiAttempts?: (records: readonly any[]) => Array<{ rank: number; record: any }>;
};

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    stageReached: 3,
    wholeGameProgressRaw: 100,
    participantAverageCpmRaw: 300,
    totalActiveDuelTimeMs: 40_000,
    recordedAt: "2026-08-31T01:00:00.000Z",
    recordId: "record-a",
    contradictionCodes: [],
    result: "PARTICIPANT_WIN",
    ...overrides
  };
}

const inversionFixture = [
  attempt({ recordId: "A", result: "GEUMNARAE_WIN", participantAverageCpmRaw: 500, totalActiveDuelTimeMs: 1_000, stageReached: 3, wholeGameProgressRaw: 100 }),
  attempt({ recordId: "B", result: "PARTICIPANT_WIN", participantAverageCpmRaw: 100, totalActiveDuelTimeMs: 99_000, stageReached: 1, wholeGameProgressRaw: 1 }),
  attempt({ recordId: "C", result: "PARTICIPANT_WIN", participantAverageCpmRaw: 350, totalActiveDuelTimeMs: 40_000, stageReached: 2, wholeGameProgressRaw: 50 }),
  attempt({ recordId: "D", result: "PARTICIPANT_WIN", participantAverageCpmRaw: 300, totalActiveDuelTimeMs: 5_000, stageReached: 3, wholeGameProgressRaw: 99 }),
  attempt({ recordId: "E", result: "GEUMNARAE_WIN", participantAverageCpmRaw: 250, totalActiveDuelTimeMs: 80_000, stageReached: 2, wholeGameProgressRaw: 30 }),
  attempt({ recordId: "F", result: "GEUMNARAE_WIN", participantAverageCpmRaw: 200, totalActiveDuelTimeMs: 2_000, stageReached: 1, wholeGameProgressRaw: 10 })
];

test("ranks participant wins before losses and CPM descending within each group", async () => {
  const ranking = await import("../../shared/utils/ranking") as RankingModule;
  assert.equal(typeof ranking.rankCanonicalAiAttempts, "function");

  const ranked = ranking.rankCanonicalAiAttempts!(inversionFixture);

  assert.deepEqual(
    ranked.map(({ rank, record }) => [rank, record.recordId]),
    [[1, "C"], [2, "D"], [3, "B"], [4, "A"], [5, "E"], [6, "F"]]
  );
  assert.deepEqual(ranking.canonicalAiRankKey!(inversionFixture[2]), [0, 350]);
  assert.deepEqual(ranking.canonicalAiRankKey!(inversionFixture[0]), [1, 500]);
});

test("keeps canonical order unchanged when every total duration changes", async () => {
  const ranking = await import("../../shared/utils/ranking") as RankingModule;
  const durationsChanged = inversionFixture.map((record, index) => ({
    ...record,
    totalActiveDuelTimeMs: (index + 1) * 123_456
  }));

  assert.deepEqual(
    ranking.rankCanonicalAiAttempts!(durationsChanged).map(({ record }) => record.recordId),
    ["C", "D", "B", "A", "E", "F"]
  );
});

test("uses recordedAt and recordId only after an exact result and CPM tie", async () => {
  const ranking = await import("../../shared/utils/ranking") as RankingModule;
  assert.equal(typeof ranking.compareCanonicalAiDisplayOrder, "function");

  const earlier = attempt({ recordId: "record-z", participantAverageCpmRaw: 500, recordedAt: "2026-08-31T01:00:00.000Z" });
  const later = attempt({ recordId: "record-a", participantAverageCpmRaw: 500, recordedAt: "2026-08-31T02:00:00.000Z" });
  const sameTimeLowerId = attempt({ recordId: "record-a", participantAverageCpmRaw: 500 });
  const sameTimeHigherId = attempt({ recordId: "record-b", participantAverageCpmRaw: 500 });

  assert.ok(ranking.compareCanonicalAiDisplayOrder!(earlier, later) < 0);
  assert.ok(ranking.compareCanonicalAiDisplayOrder!(sameTimeLowerId, sameTimeHigherId) < 0);
  assert.deepEqual(ranking.canonicalAiRankKey!(earlier), ranking.canonicalAiRankKey!(later));
});
