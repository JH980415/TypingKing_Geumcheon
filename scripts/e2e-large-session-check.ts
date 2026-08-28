import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  ensureRuntime,
  readRecords,
  saveRecord,
  setPracticeSessionMode,
  updateOneDriveSettings,
  validateOneDriveSetup
} from "../shared/csv/fileStore";
import type { RuntimeContext } from "../shared/csv/fileStore";
import type { RecordRow, SaveRecordInput } from "../shared/types";

const artifactRoot = path.resolve("test_artifacts", "large_session_4000");
const sharedRoot = path.join(artifactRoot, "shared_onedrive");
const baseFolder = "LargeSession_E2E";

function filesBelow(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(filePath) : [filePath];
  });
}

function createCtx(name: string, pcId: string, role: "player" | "leaderboard"): RuntimeContext {
  const ctx = ensureRuntime(path.join(artifactRoot, "runtime", name));
  updateOneDriveSettings(ctx, {
    syncMode: "onedrive_manual",
    pcRole: role,
    pcId,
    oneDriveRoot: sharedRoot,
    recordBaseFolderName: baseFolder,
    dayNo: 1,
    roundNo: 1
  }, role);
  validateOneDriveSetup(ctx, role);
  return ctx;
}

async function main() {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
  fs.mkdirSync(sharedRoot, { recursive: true });
  setPracticeSessionMode(false);
  const player = createCtx("player", "PC01", "player");
  const input: SaveRecordInput = {
    participant_name: "Load Test 0001",
    phone_part1: "010",
    phone_part2: "1000",
    phone_part3: "0001",
    birth_year: "2000",
    birth_month: "1",
    birth_day: "1",
    privacy_agreed: true,
    privacy_agreed_at: new Date().toISOString(),
    stageTexts: ["Load test stage one.", "Load test stage two.", "Load test stage three."],
    stageTimesMs: [5000, 6000, 7000],
    game_mode: "normal",
    final_accuracy: 100
  };
  const sample = await saveRecord(player, input);
  for (let index = 2; index <= 4000; index += 1) {
    const id = `LOAD_${String(index).padStart(4, "0")}`;
    const row: RecordRow = {
      ...sample,
      record_id: id,
      participant_name: `Load Test ${String(index).padStart(4, "0")}`,
      phone_part3: String(index).padStart(4, "0").slice(-4),
      phone_full: `010-1000-${String(index).padStart(4, "0").slice(-4)}`,
      phone_masked: `010-****-${String(index).padStart(4, "0").slice(-4)}`,
      created_at: new Date(Date.now() + index).toISOString(),
      completed_at: new Date(Date.now() + index).toISOString(),
      total_time_ms: String(18000 + index)
    };
    fs.writeFileSync(path.join(player.config.typingIncomingPath, `${id}.json`), `${JSON.stringify(row)}\n`, "utf8");
  }

  const leaders = Array.from({ length: 6 }, (_, index) =>
    createCtx(`leader_${index + 1}`, `PC${String(index + 7).padStart(2, "0")}`, "leaderboard")
  );
  const beforeFiles = filesBelow(sharedRoot);
  const firstStarted = performance.now();
  const firstCounts = leaders.map((ctx) => readRecords(ctx).length);
  const firstReadMs = performance.now() - firstStarted;
  const cachedStarted = performance.now();
  for (let repeat = 0; repeat < 10; repeat += 1) {
    leaders.forEach((ctx) => readRecords(ctx));
  }
  const cachedReadsMs = performance.now() - cachedStarted;
  const afterFiles = filesBelow(sharedRoot);
  const records = readRecords(leaders[0]);
  assert.deepEqual(firstCounts, [4000, 4000, 4000, 4000, 4000, 4000]);
  assert.equal(new Set(records.map((row) => row.record_id)).size, 4000);
  assert.equal(afterFiles.length, beforeFiles.length);
  assert.equal(afterFiles.filter((file) => file.endsWith(".tmp")).length, 0);
  assert.equal(afterFiles.filter((file) => file.toLowerCase().endsWith(".log")).length, 0);
  const recordFiles = fs.readdirSync(player.config.typingIncomingPath).filter((name) => name.endsWith(".json"));
  const totalRecordBytes = recordFiles.reduce((sum, name) => sum + fs.statSync(path.join(player.config.typingIncomingPath, name)).size, 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    leaderboards: leaders.length,
    firstReadAllLeaderboardsMs: Math.round(firstReadMs),
    cachedTenReadsAllLeaderboardsMs: Math.round(cachedReadsMs),
    sharedFileCountBefore: beforeFiles.length,
    sharedFileCountAfter: afterFiles.length,
    sharedLogCount: 0,
    tempFileCount: 0,
    totalRecordBytes,
    averageRecordBytes: Math.round(totalRecordBytes / recordFiles.length),
    heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10
  };
  fs.writeFileSync(path.join(artifactRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
