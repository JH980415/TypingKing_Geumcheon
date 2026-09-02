import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decodedUrlFileName,
  formatPackagedSmokeFallbackError,
  writePackagedSmokeReports
} from "../../scripts/e2e-geumcheon-packaged-smoke-check";

test("preserves the primary CDP failure when the native fallback also fails", () => {
  const message = formatPackagedSmokeFallbackError(
    "CDP connect failed",
    new Error("native title missing")
  );

  assert.match(message, /CDP connect failed/);
  assert.match(message, /native title missing/);
});

test("records only the decoded packaged asset filename instead of a local user path", () => {
  const assetUrl = new URL(
    "file:///C:/Users/Example/AppData/Local/Temp/runtime/resources/events/geumcheon-2026/assets/ai_타자왕_금나래의_도전.png"
  ).href;

  assert.equal(decodedUrlFileName(assetUrl), "ai_타자왕_금나래의_도전.png");
});

test("recreates a missing packaged-smoke report directory before writing results", () => {
  const fixtureParent = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-packaged-report-"));
  const reportRoot = path.join(fixtureParent, "reports");
  const builds = new Map([
    ["ai", { hash: "ai-hash", bytes: 1 }],
    ["ai-leaderboard", { hash: "ai-leaderboard-hash", bytes: 2 }],
    ["practice", { hash: "practice-hash", bytes: 3 }],
    ["practice-leaderboard", { hash: "practice-leaderboard-hash", bytes: 4 }]
  ] as const);

  try {
    writePackagedSmokeReports([], builds, reportRoot);

    assert.equal(fs.existsSync(path.join(reportRoot, "summary.json")), true);
    assert.equal(fs.existsSync(path.join(reportRoot, "report.md")), true);
  } finally {
    fs.rmSync(fixtureParent, { recursive: true, force: true });
  }
});
