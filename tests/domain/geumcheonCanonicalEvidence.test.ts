import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  canonicalAiContradictionCodes,
  isCanonicalAiAttemptV1
} from "../../shared/utils/geumcheonAiAttempt";
import { rankCanonicalAiAttempts } from "../../shared/utils/ranking";

const evidenceRoot = path.resolve("Codex/Work/R3/02_Working");

test("ships hand-derived four-key ranking cases as executable evidence", () => {
  const evidencePath = path.join(evidenceRoot, "ranking-test-cases.json");
  assert.equal(fs.existsSync(evidencePath), true, "ranking-test-cases.json must exist");
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const ranked = rankCanonicalAiAttempts(evidence.cases.map((item: any) => item.record));

  assert.deepEqual(
    ranked.map(({ rank, record }) => [rank, record.recordId]),
    evidence.expectedPublicOrder.map((recordId: string, index: number) => [
      evidence.expectedCompetitionRanks[index],
      recordId
    ])
  );
  assert.deepEqual(
    evidence.rankingKeys,
    [
      "stageReached DESC",
      "wholeGameProgressRaw DESC",
      "participantAverageCpmRaw DESC",
      "totalActiveDuelTimeMs ASC"
    ]
  );
  assert.deepEqual(evidence.displayOnlyTiebreakers, ["recordedAt ASC", "recordId ASC"]);
});
test("ships schema samples whose stored quarantine codes are reproducible", () => {
  const evidencePath = path.join(evidenceRoot, "record-schema-samples.json");
  assert.equal(fs.existsSync(evidencePath), true, "record-schema-samples.json must exist");
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));

  for (const sample of evidence.samples) {
    assert.equal(isCanonicalAiAttemptV1(sample.canonicalAttempt), true, sample.name);
    assert.deepEqual(
      canonicalAiContradictionCodes(sample.canonicalAttempt),
      sample.canonicalAttempt.contradictionCodes,
      sample.name
    );
  }
});
