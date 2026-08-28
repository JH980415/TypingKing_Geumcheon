import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateGeumcheonRound1NasEvidence } from "../../scripts/generate-geumcheon-round1-nas-evidence";

test("generates round 1 synthetic NAS JSON evidence without secrets", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "geumcheon-round1-evidence-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const summary = await generateGeumcheonRound1NasEvidence({ outputRoot: root });

  assert.equal(summary.official.firstStatus, 201);
  assert.equal(summary.official.retryStatus, 200);
  assert.equal(summary.official.retryDisposition, "duplicate");
  assert.equal(summary.official.conflictStatus, 409);
  assert.equal(summary.practice.firstStatus, 201);
  assert.equal(summary.practice.retryStatus, 200);
  assert.equal(summary.practice.retryDisposition, "duplicate");
  assert.equal(summary.practice.conflictStatus, 409);
  assert.equal(summary.leaderboard.officialRows, 1);
  assert.equal(summary.leaderboard.practiceRows, 1);
  assert.equal(summary.files.copiedJson.length, 2);

  const officialPath = path.join(
    summary.dataRoot,
    "기록저장",
    "1일차",
    "1회차",
    "incoming",
    "ai",
    "gsc26-pc01-11111111-1111-4111-8111-111111111111.json",
  );
  const practicePath = path.join(
    summary.dataRoot,
    "기록저장",
    "연습회차",
    "incoming",
    "ai",
    "gsc26-pc01-22222222-2222-4222-8222-222222222222.json",
  );
  assert.deepEqual(summary.files.sourceJson.sort(), [officialPath, practicePath].sort());

  const report = await readFile(path.join(root, "report.md"), "utf8");
  const summaryText = await readFile(path.join(root, "summary.json"), "utf8");
  const allText = `${report}\n${summaryText}`;
  assert.match(report, /1회차 검토용 합성 NAS JSON 증거/);
  assert.equal(allText.includes("010-0000-0000"), true);
  assert.equal(allText.includes("1111111111111111111111111111111111111111111111111111111111111111"), false);
  assert.equal(allText.includes("2222222222222222222222222222222222222222222222222222222222222222"), false);
  assert.equal(allText.includes("records.example"), false);
  assert.equal(allText.includes("tokenHash"), false);
  assert.equal(allText.includes("PIN"), false);
});
