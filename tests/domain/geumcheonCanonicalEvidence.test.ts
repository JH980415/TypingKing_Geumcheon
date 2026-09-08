import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  canonicalAiContradictionCodes,
  isCanonicalAiAttemptV1
} from "../../shared/utils/geumcheonAiAttempt";
import { rankCanonicalAiAttempts } from "../../shared/utils/ranking";

const evidenceRoot = path.resolve("tests/fixtures/geumcheon-r2-0-2");

test("applies approved win then CPM ranking to archived R2 records without restoring the obsolete four-key policy", () => {
  const evidencePath = path.join(evidenceRoot, "ranking-test-cases.json");
  assert.equal(fs.existsSync(evidencePath), true, "ranking-test-cases.json must exist");
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const records = evidence.cases.map((item: any) => item.record);
  // The archived fixture remains unchanged. R5/R6 superseded its expected order:
  // winners 300 > 250 CPM, then non-winners 999 > 250; contradictory rows stay excluded.
  const expected = [[1, "record-a"], [2, "record-b"], [3, "record-d"], [4, "record-c"]];
  for (const inputs of [records, records.map((record: any, index: number) => ({
    ...record, totalActiveDuelTimeMs: (index + 1) * 98765,
  }))]) {
    assert.deepEqual(
      rankCanonicalAiAttempts(inputs).map(({ rank, record }) => [rank, record.recordId]),
      expected
    );
  }
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
