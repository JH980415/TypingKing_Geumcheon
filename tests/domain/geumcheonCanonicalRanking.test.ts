import assert from "node:assert/strict";
import test from "node:test";

type RankingModule = {
  canonicalAiRankKey?: (record: any) => readonly [number, number, number, number];
  compareCanonicalAiRankKeys?: (
    left: readonly [number, number, number, number],
    right: readonly [number, number, number, number]
  ) => number;
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
    completedAt: "2099-01-01T00:00:00.000Z",
    participantName: "순위에 사용하지 않는 이름",
    phone: "01000000000",
    ...overrides
  };
}

test("ranks by exactly four canonical keys with competition-rank gaps", async () => {
  const ranking = await import("../../shared/utils/ranking") as RankingModule;
  assert.equal(typeof ranking.rankCanonicalAiAttempts, "function");

  const ranked = ranking.rankCanonicalAiAttempts!([
    attempt({
      recordId: "record-b",
      participantAverageCpmRaw: 250,
      totalActiveDuelTimeMs: 28_000,
      recordedAt: "2026-08-31T01:02:00.000Z",
      result: "PARTICIPANT_WIN",
      completedAt: "2026-08-31T01:02:30.000Z",
      participantName: "같은 사람 아님",
      phone: "01011111111"
    }),
    attempt({
      recordId: "record-c",
      participantAverageCpmRaw: 250,
      totalActiveDuelTimeMs: 28_000,
      recordedAt: "2026-08-31T01:01:00.000Z",
      result: "GEUMNARAE_WIN",
      completedAt: "2025-01-01T00:00:00.000Z",
      participantName: "다른 사람",
      phone: "01022222222"
    }),
    attempt({ recordId: "record-a" }),
    attempt({
      recordId: "record-d",
      stageReached: 2,
      wholeGameProgressRaw: 99,
      participantAverageCpmRaw: 999,
      totalActiveDuelTimeMs: 1
    }),
    attempt({
      recordId: "quarantined",
      stageReached: 3,
      wholeGameProgressRaw: 100,
      participantAverageCpmRaw: 999,
      totalActiveDuelTimeMs: 1,
      contradictionCodes: ["RESULT_TIMING_CONTRADICTION"]
    })
  ]);

  assert.deepEqual(
    ranked.map(({ rank, record }) => [rank, record.recordId]),
    [
      [1, "record-a"],
      [2, "record-c"],
      [2, "record-b"],
      [4, "record-d"]
    ]
  );
});

test("uses recordedAt and recordId only for stable display order within a full tie", async () => {
  const ranking = await import("../../shared/utils/ranking") as RankingModule;
  assert.equal(typeof ranking.compareCanonicalAiDisplayOrder, "function");

  const earlier = attempt({ recordId: "record-z", recordedAt: "2026-08-31T01:00:00.000Z" });
  const later = attempt({ recordId: "record-a", recordedAt: "2026-08-31T02:00:00.000Z" });
  const sameTimeLowerId = attempt({ recordId: "record-a" });
  const sameTimeHigherId = attempt({ recordId: "record-b" });

  assert.ok(ranking.compareCanonicalAiDisplayOrder!(earlier, later) < 0);
  assert.ok(ranking.compareCanonicalAiDisplayOrder!(sameTimeLowerId, sameTimeHigherId) < 0);
  assert.deepEqual(ranking.canonicalAiRankKey!(earlier), ranking.canonicalAiRankKey!(later));
});

