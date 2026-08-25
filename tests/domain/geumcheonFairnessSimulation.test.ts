import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseStageTextCatalog } from "../../shared/events/stageTextCatalog";
import { calculateEffectiveCpm, compareGeumcheonRecords, type OfficialAttemptCandidate } from "../../shared/utils/geumcheonRanking";
import { countConvertedTypingUnits } from "../../shared/utils/typing";

const phrases = parseStageTextCatalog(
  fs.readFileSync(path.resolve("events/geumcheon-2026/stage_texts.csv"), "utf8")
);

function completed(
  recordId: string,
  totalTypingUnits: number,
  totalUserTimeMs: number
): OfficialAttemptCandidate {
  return {
    recordId,
    participantKey: recordId,
    serverReceivedAt: `2026-09-18T01:00:${recordId.padStart(2, "0")}.000Z`,
    completedAt: `2026-09-18T01:00:${recordId.padStart(2, "0")}.000Z`,
    completionStatus: "completed",
    completedStages: 3,
    progressPercent: 100,
    totalTypingUnits,
    totalUserTimeMs,
    isTest: false,
    isDebug: false
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

test("keeps every Geumcheon phrase within one display CPM of the same latent speed", () => {
  assert.equal(phrases.length, 60);
  for (let latentCpm = 150; latentCpm <= 800; latentCpm += 1) {
    for (const phrase of phrases) {
      const units = countConvertedTypingUnits(phrase.text);
      const elapsedMs = Math.max(1, Math.round((units * 60000) / latentCpm));
      assert.ok(
        Math.abs(calculateEffectiveCpm(units, elapsedMs) - latentCpm) <= 1,
        `${phrase.id} drifted at ${latentCpm} CPM`
      );
    }
  }
});

test("never ranks a typist that is at least five percent faster below a slower typist", () => {
  for (const phrase of phrases) {
    const units = countConvertedTypingUnits(phrase.text);
    for (let slowerCpm = 150; slowerCpm <= 760; slowerCpm += 10) {
      const fasterCpm = Math.ceil(slowerCpm * 1.05);
      const slower = completed("01", units, Math.max(1, Math.round((units * 60000) / slowerCpm)));
      const faster = completed("02", units, Math.max(1, Math.round((units * 60000) / fasterCpm)));
      assert.ok(compareGeumcheonRecords(faster, slower) < 0, `${phrase.id} ${slowerCpm}/${fasterCpm}`);
    }
  }
});

test("keeps sorted record IDs stable across phrase order and deterministic shuffle seeds", () => {
  const baseline = phrases.slice(0, 12).map((phrase, index) => {
    const units = countConvertedTypingUnits(phrase.text);
    return completed(String(index + 1), units, Math.max(1, Math.round((units * 60000) / (300 + index * 7))));
  });
  const expected = baseline.toSorted(compareGeumcheonRecords).map((record) => record.recordId);

  for (const seed of [1, 7, 42, 20260825]) {
    assert.deepEqual(
      seededShuffle(baseline, seed).toSorted(compareGeumcheonRecords).map((record) => record.recordId),
      expected
    );
  }
});
