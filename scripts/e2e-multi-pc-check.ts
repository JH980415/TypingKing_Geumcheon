import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  checkGameStartReadiness,
  clearRecords,
  cleanupLegacyOneDriveArtifacts,
  deleteRecord,
  ensureRuntime,
  exportCurrentSessionBackupClean,
  flushQueuedRecords,
  getCsvBackupStatus,
  getCleanLeaderboardSyncStatus,
  publishStageTextsToOneDrive,
  readRecords,
  saveRecord,
  setPracticeSessionMode,
  updateOneDriveSettings,
  updateRecord,
  validateOneDriveSetup
} from "../shared/csv/fileStore";
import type { RuntimeContext } from "../shared/csv/fileStore";
import type { AppConfig, PcRole, RecordRow, SaveRecordInput } from "../shared/types";

type RecordMode = "normal" | "ai_challenge";
type Verdict = "PASS" | "FAIL" | "PARTIAL" | "NOT TESTED";

type CheckRow = {
  section: string;
  item: string;
  expected: string;
  actual: string;
  verdict: Verdict;
  evidence?: string;
};

const artifactRoot = path.resolve("test_artifacts", "e2e_4pc");
const sharedRoot = path.join(artifactRoot, "shared_onedrive");
const recordBaseFolderName = "TypingKing_E2E";
const dayNo = 1;
const roundNo = 1;
const checks: CheckRow[] = [];

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function hashRecordIds(ids: string[]): string {
  return crypto.createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
}

function addCheck(row: CheckRow): void {
  checks.push(row);
}

function expect(
  section: string,
  item: string,
  ok: boolean,
  expected: string,
  actual: string,
  evidence?: string
): void {
  addCheck({ section, item, expected, actual, evidence, verdict: ok ? "PASS" : "FAIL" });
}

function pcRoot(pcId: string, role: PcRole): string {
  return path.join(artifactRoot, pcId, role);
}

function createCtx(pcId: string, role: PcRole): RuntimeContext {
  const ctx = ensureRuntime(pcRoot(pcId, role));
  updateOneDriveSettings(
    ctx,
    {
      syncMode: "onedrive_manual",
      pcRole: role,
      pcId,
      oneDriveRoot: sharedRoot,
      recordBaseFolderName,
      dayNo,
      roundNo
    },
    role
  );
  validateOneDriveSetup(ctx, role);
  const configName = role === "player" ? "player_config.json" : "leaderboard_config.json";
  writeJson(path.join(artifactRoot, pcId, configName), ctx.config);
  return ctx;
}

function createIsolatedCtx(
  name: string,
  pcId: string,
  role: PcRole,
  root = sharedRoot,
  day = dayNo,
  round = roundNo
): RuntimeContext {
  const ctx = ensureRuntime(path.join(artifactRoot, name, role));
  updateOneDriveSettings(
    ctx,
    {
      syncMode: "onedrive_manual",
      pcRole: role,
      pcId,
      oneDriveRoot: root,
      recordBaseFolderName,
      dayNo: day,
      roundNo: round
    },
    role
  );
  validateOneDriveSetup(ctx, role);
  return ctx;
}

function makeInput(pcId: string, mode: RecordMode, index: number): SaveRecordInput {
  const base: SaveRecordInput = {
    participant_name: `Tester ${pcId}`,
    phone_part1: "010",
    phone_part2: String(1000 + index).padStart(4, "0"),
    phone_part3: String(2000 + index).padStart(4, "0"),
    birth_year: "2000",
    birth_month: "1",
    birth_day: "1",
    privacy_agreed: true,
    privacy_agreed_at: new Date().toISOString(),
    stageTexts: [
      `Normal sample line one for ${pcId}.`,
      `Normal sample line two for ${pcId}.`,
      `Normal sample line three for ${pcId}.`
    ],
    stageTimesMs: [8000 + index, 9000 + index, 10000 + index],
    final_accuracy: 100,
    is_debug: false,
    is_test: false,
    game_mode: mode,
    pc_id: pcId,
    app_variant: mode === "ai_challenge" ? "ai" : "typing"
  };
  if (mode === "ai_challenge") {
    Object.assign(base, {
      ai: {
        status: index % 2 === 0 ? "SUCCESS" : "FAILED",
        failedStage: index % 3 === 0 ? "3" : "2",
        stageCpms: [310, 360, 410],
        stageTimesMs: [9000 + index, 9500 + index, 10000 + index],
        stageResults: index % 2 === 0 ? ["USER_WIN", "USER_WIN", "USER_WIN"] : ["USER_WIN", "USER_WIN", "AI_WIN"],
        finalResult: index % 2 === 0 ? "USER_WIN" : "AI_WIN",
        stageDiffsMs: [100, 200, 300],
        finalDiffMs: index % 2 === 0 ? -500 : 500,
        display: {
          participantResultTimeMs: 27000 + index,
          aiResultTimeMs: 28500 + index,
          participantAvgCpm: 350 + index,
          aiAvgCpm: 330 + index,
    resultLabel: index % 2 === 0 ? "참여자 승리" : "참여자 패배",
          participantProgressPercent: index % 2 === 0 ? 100 : 86.7,
          aiProgressPercent: index % 2 === 0 ? 74.3 : 100,
          duelTimeMs: 29000 + index,
          resultStage: index % 3 === 0 ? 3 : 2
        }
      },
      app_variant: "ai"
    });
  }
  return base;
}

async function save(ctx: RuntimeContext, pcId: string, mode: RecordMode, index: number): Promise<RecordRow> {
  return saveRecord(ctx, makeInput(pcId, mode, index));
}

function recordsFor(ctx: RuntimeContext, mode: RecordMode): RecordRow[] {
  return readRecords(ctx).filter((record) => (record.game_mode || "normal") === mode);
}

function incomingFiles(config: AppConfig, mode: RecordMode): string[] {
  const dir = mode === "ai_challenge" ? config.aiIncomingPath : config.typingIncomingPath;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function latestMarker(config: AppConfig, mode: RecordMode): { file: string; marker: any } | null {
  const dir = config.exportPath;
  if (!fs.existsSync(dir)) return null;
  const prefix = mode === "ai_challenge" ? "csv_backup_ai_challenge" : "csv_backup_normal";
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  const file = files.at(-1);
  return file ? { file, marker: readJson(path.join(dir, file)) } : null;
}

function writeQueueFile(ctx: RuntimeContext, row: RecordRow, name = row.record_id): string {
  const filePath = path.join(ctx.paths.localQueueDir, `${name}.json`);
  writeJson(filePath, row);
  return filePath;
}

function filesBelow(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(filePath) : [filePath];
  });
}

function writeQueuedEnvelope(
  ctx: RuntimeContext,
  row: RecordRow,
  target: { root: string; base: string; day: number; round: number; practice?: boolean },
  name = row.record_id
): string {
  const filePath = path.join(ctx.paths.localQueueDir, `${name}.json`);
  writeJson(filePath, {
    queue_version: 2,
    queued_at: new Date().toISOString(),
    target: {
      oneDriveRoot: target.root,
      recordBaseFolderName: target.base,
      dayNo: target.day,
      roundNo: target.round,
      practice: Boolean(target.practice)
    },
    record: row
  });
  return filePath;
}

function writeCorruptFiles(config: AppConfig, normalRecord: RecordRow, aiRecord: RecordRow): void {
  const typing = config.typingIncomingPath;
  const ai = config.aiIncomingPath;
  ensureDir(typing);
  ensureDir(ai);
  fs.writeFileSync(path.join(typing, "broken_0byte.json"), "");
  fs.writeFileSync(path.join(typing, "broken_syntax.json"), "{ broken");
  writeJson(path.join(typing, "missing_record_id.json"), { game_mode: "normal", participant_name: "missing id" });
  writeJson(path.join(typing, "wrong_game_mode.json"), { ...normalRecord, record_id: "BAD_MODE", game_mode: "unknown" });
  writeJson(path.join(typing, "ai_in_typing.json"), { ...aiRecord, record_id: "AI_IN_TYPING" });
  writeJson(path.join(ai, "typing_in_ai.json"), { ...normalRecord, record_id: "TYPING_IN_AI", game_mode: "normal" });
  fs.writeFileSync(path.join(ai, "not_json.txt"), "ignore me");
  writeJson(path.join(typing, "long_name.json"), { ...normalRecord, record_id: "LONG_NAME", participant_name: "LongName".repeat(20) });
  writeJson(path.join(typing, "special_name.json"), { ...normalRecord, record_id: "SPECIAL_NAME", participant_name: "Name!@#" });
  writeJson(path.join(typing, "duplicate_record_id.json"), { ...normalRecord });
  writeJson(path.join(typing, "missing_privacy.json"), { record_id: "MISSING_PRIVACY", game_mode: "normal" });
  writeJson(path.join(typing, "string_number.json"), { ...normalRecord, record_id: "STRING_NUMBER", total_time_ms: "12345" });
}

function writeReport(): string {
  const reportPath = path.join(artifactRoot, "report.md");
  const lines: string[] = [];
  lines.push("# 4PC operation E2E verification report");
  lines.push("");
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push("- Test method: 1PC simulation with separated PC01-PC08 runtime folders");
  lines.push(`- Shared OneDrive root: ${sharedRoot}`);
  lines.push(`- Artifact root: ${artifactRoot}`);
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| Section | Item | Expected | Actual | Verdict | Evidence |");
  lines.push("| -- | -- | -- | -- | -- | -- |");
  for (const check of checks) {
    lines.push(
      `| ${check.section} | ${check.item} | ${check.expected} | ${check.actual} | ${check.verdict} | ${check.evidence ?? ""} |`
    );
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  for (const verdict of ["PASS", "FAIL", "PARTIAL", "NOT TESTED"] as Verdict[]) {
    lines.push(`- ${verdict}: ${checks.filter((check) => check.verdict === verdict).length}`);
  }
  fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
  return reportPath;
}

function writeSummary(reportPath: string, diagnosticsZip: string): string {
  const summaryPath = path.join(artifactRoot, "summary.json");
  writeJson(summaryPath, {
    generatedAt: new Date().toISOString(),
    artifactRoot,
    sharedRoot,
    reportPath,
    diagnosticsZip,
    checks
  });
  return summaryPath;
}

function createDiagnosticsZip(): string {
  const zipPath = path.join(artifactRoot, "diagnostics_e2e_4pc.zip");
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${artifactRoot}\\*' -DestinationPath '${zipPath}' -Force`
    ],
    { stdio: "ignore" }
  );
  return zipPath;
}

async function main() {
  cleanDir(artifactRoot);
  ensureDir(sharedRoot);

  const playerCtxs = new Map<string, RuntimeContext>();
  const leaderboardCtxs = new Map<string, RuntimeContext>();
  for (const pc of ["PC01", "PC02", "PC03", "PC04", "PC05", "PC06"]) {
    playerCtxs.set(pc, createCtx(pc, "player"));
  }
  for (const pc of ["PC01", "PC02", "PC03", "PC04", "PC07", "PC08"]) {
    leaderboardCtxs.set(pc, createCtx(pc, "leaderboard"));
  }

  const normalRows = await Promise.all(["PC01", "PC02", "PC03", "PC04"].map((pc, index) => save(playerCtxs.get(pc)!, pc, "normal", index + 1)));
  const aiRows = await Promise.all(["PC01", "PC02", "PC03", "PC04"].map((pc, index) => save(playerCtxs.get(pc)!, pc, "ai_challenge", index + 11)));
  await save(playerCtxs.get("PC05")!, "PC05", "normal", 21);
  await save(playerCtxs.get("PC06")!, "PC06", "ai_challenge", 22);

  const leaderNormal = leaderboardCtxs.get("PC07")!;
  const leaderAi = leaderboardCtxs.get("PC08")!;
  const normalIncomingCount = incomingFiles(leaderNormal.config, "normal").length;
  const aiIncomingCount = incomingFiles(leaderAi.config, "ai_challenge").length;
  const normalReadCount = recordsFor(leaderNormal, "normal").length;
  const aiReadCount = recordsFor(leaderAi, "ai_challenge").length;
  expect("normal operation", "normal 4PC+spare save/read", normalIncomingCount >= 5 && normalReadCount === normalIncomingCount, "incoming/typing >=5 and leaderboard same", `incoming ${normalIncomingCount}, read ${normalReadCount}`, leaderNormal.config.typingIncomingPath);
  expect("normal operation", "AI 4PC+spare save/read", aiIncomingCount >= 5 && aiReadCount === aiIncomingCount, "incoming/ai >=5 and leaderboard same", `incoming ${aiIncomingCount}, read ${aiReadCount}`, leaderAi.config.aiIncomingPath);
  expect("normal operation", "mode separation", recordsFor(leaderNormal, "normal").length === normalIncomingCount && recordsFor(leaderAi, "ai_challenge").length === aiIncomingCount, "normal/AI not mixed", `normal ${normalReadCount}, ai ${aiReadCount}`);

  const normalIds = recordsFor(leaderNormal, "normal").map((row) => row.record_id);
  const aiIds = recordsFor(leaderAi, "ai_challenge").map((row) => row.record_id);
  expect("normal operation", "record_id uniqueness", new Set([...normalIds, ...aiIds]).size === normalIds.length + aiIds.length, "all record_ids unique", `total ${normalIds.length + aiIds.length}`);

  const normalExport = exportCurrentSessionBackupClean(leaderNormal, "normal");
  const aiExport = exportCurrentSessionBackupClean(leaderAi, "ai_challenge");
  const normalMarker = latestMarker(leaderNormal.config, "normal");
  const aiMarker = latestMarker(leaderAi.config, "ai_challenge");
  expect("CSV backup", "normal CSV/marker count", normalMarker?.marker.exported_record_count === normalReadCount && normalExport.exportedRecordCount === normalReadCount, "CSV and marker match current normal records", `csv ${normalExport.exportedRecordCount}, marker ${normalMarker?.marker.exported_record_count}`);
  expect("CSV backup", "AI CSV/marker count", aiMarker?.marker.exported_record_count === aiReadCount && aiExport.exportedRecordCount === aiReadCount, "CSV and marker match current AI records", `csv ${aiExport.exportedRecordCount}, marker ${aiMarker?.marker.exported_record_count}`);
  expect("CSV backup", "normal marker hash", normalMarker?.marker.record_id_hash === hashRecordIds(normalIds), "marker hash equals current records hash", normalMarker?.marker.record_id_hash ?? "");
  expect("CSV backup", "AI marker hash", aiMarker?.marker.record_id_hash === hashRecordIds(aiIds), "marker hash equals current records hash", aiMarker?.marker.record_id_hash ?? "");

  const badCtx = ensureRuntime(path.join(artifactRoot, "bad_config_pc02"));
  updateOneDriveSettings(badCtx, { syncMode: "onedrive_manual", pcRole: "player", pcId: "PC02", oneDriveRoot: "", recordBaseFolderName, dayNo, roundNo }, "player");
  const badReady = checkGameStartReadiness(badCtx, "normal");
  let badSaveBlocked = false;
  try {
    await saveRecord(badCtx, makeInput("PC02", "normal", 99));
  } catch {
    badSaveBlocked = true;
  }
  expect("setup failure", "empty oneDriveRoot blocks start/save", !badReady.ready && badSaveBlocked, "start blocked and no local_queue bypass", `ready=${badReady.ready}, saveBlocked=${badSaveBlocked}`);

  const setupFalseCtx = ensureRuntime(path.join(artifactRoot, "setup_false_pc03"));
  updateOneDriveSettings(setupFalseCtx, { syncMode: "onedrive_manual", pcRole: "player", pcId: "PC03", oneDriveRoot: sharedRoot, recordBaseFolderName, dayNo, roundNo }, "player");
  const setupFalseReady = checkGameStartReadiness(setupFalseCtx, "ai_challenge");
  expect("setup failure", "setupComplete=false blocks AI start", !setupFalseReady.ready, "AI start blocked", `ready=${setupFalseReady.ready}`);

  const deleteFolderSharedRoot = path.join(artifactRoot, "delete_folder_case", "shared_onedrive");
  const deleteFolderCtx = createIsolatedCtx("delete_folder_case_PC01", "PC01", "player", deleteFolderSharedRoot);
  fs.rmSync(deleteFolderCtx.config.typingIncomingPath, { recursive: true, force: true });
  const deletedReady = checkGameStartReadiness(deleteFolderCtx, "normal");
  validateOneDriveSetup(deleteFolderCtx, "player");
  fs.rmSync(deleteFolderCtx.config.typingIncomingPath, { recursive: true, force: true });
  let deletedDuringGameQueued = false;
  try {
    await saveRecord(deleteFolderCtx, makeInput("PC01", "normal", 98));
  } catch {
    deletedDuringGameQueued = fs.readdirSync(deleteFolderCtx.paths.localQueueDir).some((name) => name.endsWith(".json"));
  }
  expect("setup failure", "missing incoming/typing blocks start before validation", !deletedReady.ready, "folder validation blocks start", `ready=${deletedReady.ready}`);
  validateOneDriveSetup(deleteFolderCtx, "player");
  const deletedFolderFlush = flushQueuedRecords(deleteFolderCtx);
  expect(
    "local_queue",
    "folder lost after game start preserves completed record",
    deletedDuringGameQueued && deletedFolderFlush.sent === 1 && deletedFolderFlush.failed === 0,
    "completed record queued locally and uploaded after folder recovery",
    `queued=${deletedDuringGameQueued}, sent=${deletedFolderFlush.sent}, failed=${deletedFolderFlush.failed}`
  );

  const activeSessionRoot = path.join(artifactRoot, "active_session_case", "shared_onedrive");
  const oldSessionCtx = createIsolatedCtx("active_session_case_PC01", "PC01", "player", activeSessionRoot, 1, 1);
  const newSessionCtx = createIsolatedCtx("active_session_case_PC07", "PC07", "leaderboard", activeSessionRoot, 1, 2);
  const oldSessionReady = checkGameStartReadiness(oldSessionCtx, "normal");
  const newSessionReady = checkGameStartReadiness(newSessionCtx, "normal");
  expect(
    "setup failure",
    "active session syncs old-round players",
    oldSessionReady.ready && oldSessionCtx.config.dayNo === 1 && oldSessionCtx.config.roundNo === 2,
    "old PC auto-updates to latest active session and remains playable",
    `oldReady=${oldSessionReady.ready}, synced=${oldSessionCtx.config.dayNo}/${oldSessionCtx.config.roundNo}`
  );
  expect(
    "setup failure",
    "active session current-round player allowed",
    newSessionReady.ready,
    "latest session PC remains playable",
    `newReady=${newSessionReady.ready}`
  );

  const concurrentRows = await Promise.all(["PC01", "PC02", "PC03", "PC04"].flatMap((pc, index) => [
    save(playerCtxs.get(pc)!, pc, "normal", 50 + index),
    save(playerCtxs.get(pc)!, pc, "ai_challenge", 60 + index)
  ]));
  expect("concurrency", "4PC concurrent saves unique", new Set(concurrentRows.map((row) => row.record_id)).size === concurrentRows.length, "all concurrent record_ids unique", `${concurrentRows.length} saves`);

  const beforeCorruptNormal = recordsFor(leaderNormal, "normal").length;
  writeCorruptFiles(leaderNormal.config, normalRows[0], aiRows[0]);
  const afterCorruptNormal = recordsFor(leaderNormal, "normal").length;
  const syncStatus = getCleanLeaderboardSyncStatus(leaderNormal, "normal");
  expect("corrupt files", "broken JSON does not crash reads", afterCorruptNormal >= beforeCorruptNormal, "readRecords completes without exception", `before ${beforeCorruptNormal}, after ${afterCorruptNormal}, status ${syncStatus.status}`);
  const corruptIds = new Set(readRecords(leaderNormal).map((row) => row.record_id));
  const rejectedIds = ["BAD_MODE", "AI_IN_TYPING", "TYPING_IN_AI", "MISSING_PRIVACY"];
  expect(
    "corrupt files",
    "wrong-mode and incomplete JSON excluded from rankings",
    rejectedIds.every((id) => !corruptIds.has(id)) && afterCorruptNormal === beforeCorruptNormal + 3,
    "wrong folder/mode and missing required fields ignored; valid edge names remain",
    `before ${beforeCorruptNormal}, after ${afterCorruptNormal}, rejected present=${rejectedIds.filter((id) => corruptIds.has(id)).join(",") || "none"}`
  );

  const queueCtx = createCtx("PC05", "player");
  writeQueueFile(queueCtx, { ...normalRows[0], record_id: "QUEUE_NORMAL_OK", pc_id: "PC05" } as RecordRow);
  writeQueueFile(queueCtx, { ...aiRows[0], record_id: "QUEUE_AI_OK", pc_id: "PC05", game_mode: "ai_challenge" } as RecordRow);
  const queueFlush = flushQueuedRecords(queueCtx);
  expect("local_queue", "normal/AI queue recovery success", queueFlush.sent === 2 && queueFlush.failed === 0, "2 queued records uploaded", `sent ${queueFlush.sent}, failed ${queueFlush.failed}`, queueCtx.paths.processedDir);

  const corruptQueueCtx = createCtx("PC06", "player");
  fs.writeFileSync(path.join(corruptQueueCtx.paths.localQueueDir, "queued_broken.json"), "{ broken");
  const corruptFlush = flushQueuedRecords(corruptQueueCtx);
  expect("local_queue", "corrupt queue file preserved", corruptFlush.sent === 0 && corruptFlush.failed === 1 && fs.existsSync(path.join(corruptQueueCtx.paths.localQueueDir, "queued_broken.json")), "failed file remains in queue", `sent ${corruptFlush.sent}, failed ${corruptFlush.failed}`, corruptQueueCtx.paths.recoveryDir);

  const duplicateCtx = createCtx("PC05", "player");
  writeQueueFile(duplicateCtx, { ...normalRows[0] }, "duplicate_existing");
  const duplicateFlush = flushQueuedRecords(duplicateCtx);
  expect("local_queue", "duplicate record_id replay is idempotent", duplicateFlush.sent === 1 && duplicateFlush.failed === 0, "existing same record treated as sent", `sent ${duplicateFlush.sent}, failed ${duplicateFlush.failed}`);

  const queueRoundRoot = path.join(artifactRoot, "queue_round_isolation", "shared_onedrive");
  const queueRoundCtx = createIsolatedCtx("queue_round_isolation_PC01", "PC01", "player", queueRoundRoot, 1, 1);
  const queuedOldRound = { ...normalRows[0], record_id: "QUEUE_OLD_ROUND", game_mode: "normal" } as RecordRow;
  writeQueuedEnvelope(
    queueRoundCtx,
    queuedOldRound,
    { root: queueRoundRoot, base: recordBaseFolderName, day: 1, round: 1 },
    "queue_old_round"
  );
  updateOneDriveSettings(queueRoundCtx, { roundNo: 2 }, "player");
  validateOneDriveSetup(queueRoundCtx, "player");
  const queueRoundFlush = flushQueuedRecords(queueRoundCtx);
  const oldRoundQueuedPath = path.join(queueRoundRoot, recordBaseFolderName, "1일차", "1회차", "incoming", "typing", "QUEUE_OLD_ROUND.json");
  const newRoundQueuedPath = path.join(queueRoundRoot, recordBaseFolderName, "1일차", "2회차", "incoming", "typing", "QUEUE_OLD_ROUND.json");
  expect(
    "local_queue",
    "queued record keeps original round destination",
    queueRoundFlush.sent === 1 && fs.existsSync(oldRoundQueuedPath) && !fs.existsSync(newRoundQueuedPath),
    "round 1 queued record uploads only to round 1 after current session changes",
    `sent=${queueRoundFlush.sent}, old=${fs.existsSync(oldRoundQueuedPath)}, new=${fs.existsSync(newRoundQueuedPath)}`,
    oldRoundQueuedPath
  );

  const inGameRoot = path.join(artifactRoot, "in_game_session_change", "shared_onedrive");
  const inGameCtx = createIsolatedCtx("in_game_session_change_PC01", "PC01", "player", inGameRoot, 1, 1);
  createIsolatedCtx("in_game_session_change_PC07", "PC07", "leaderboard", inGameRoot, 1, 2);
  const inGameSaved = await saveRecord(inGameCtx, makeInput("PC01", "normal", 131));
  const inGameOldPath = path.join(inGameRoot, recordBaseFolderName, "1일차", "1회차", "incoming", "typing", `${inGameSaved.record_id}.json`);
  const inGameNewPath = path.join(inGameRoot, recordBaseFolderName, "1일차", "2회차", "incoming", "typing", `${inGameSaved.record_id}.json`);
  expect(
    "session change",
    "in-progress game saves to its starting round",
    fs.existsSync(inGameOldPath) && !fs.existsSync(inGameNewPath),
    "record remains in the round active when the game started",
    `old=${fs.existsSync(inGameOldPath)}, new=${fs.existsSync(inGameNewPath)}`,
    inGameOldPath
  );

  const csvOnlyCtx = createIsolatedCtx("csv_round_change", "PC07", "leaderboard");
  const beforeRoundChangeStatus = getCsvBackupStatus(csvOnlyCtx);
  let blockedAfterNewRecord = false;
  await save(playerCtxs.get("PC01")!, "PC01", "normal", 80);
  try {
    updateOneDriveSettings(csvOnlyCtx, { roundNo: 2 }, "leaderboard");
  } catch {
    blockedAfterNewRecord = true;
  }
  expect("CSV round", "round change blocked after new record", blockedAfterNewRecord, "blocked after record added since last backup", `blocked=${blockedAfterNewRecord}, beforeComplete=${beforeRoundChangeStatus.normal.complete}`);

  exportCurrentSessionBackupClean(csvOnlyCtx, "normal");
  exportCurrentSessionBackupClean(csvOnlyCtx, "ai_challenge");
  let roundChangeAllowed = true;
  try {
    updateOneDriveSettings(csvOnlyCtx, { roundNo: 2 }, "leaderboard");
  } catch {
    roundChangeAllowed = false;
  }
  expect("CSV round", "round change allowed after backups", roundChangeAllowed, "round change allowed", `allowed=${roundChangeAllowed}`);

  const zeroCtx = createIsolatedCtx("zero_session", "PC07", "leaderboard", sharedRoot, 9, 9);
  let zeroAllowed = true;
  try {
    updateOneDriveSettings(zeroCtx, { roundNo: 10 }, "leaderboard");
  } catch {
    zeroAllowed = false;
  }
  expect("CSV round", "zero-record session can change round", zeroAllowed, "allowed without backup", `allowed=${zeroAllowed}`);

  validateOneDriveSetup(leaderNormal, "leaderboard");
  validateOneDriveSetup(leaderAi, "leaderboard");
  const editTarget = recordsFor(leaderNormal, "normal")[0];
  await deleteRecord(leaderNormal, editTarget.record_id, "admin");
  const afterHide = recordsFor(leaderNormal, "normal").some((row) => row.record_id === editTarget.record_id);
  expect("admin_actions", "hide preserves incoming JSON and hides display", !afterHide && fs.existsSync(path.join(leaderNormal.config.typingIncomingPath, `${editTarget.record_id}.json`)), "source JSON exists, display excluded", `visible=${afterHide}`);

  const editTarget2 = recordsFor(leaderNormal, "normal")[0];
  await updateRecord(leaderNormal, editTarget2.record_id, { participant_name: "Edited Tester" }, "admin");
  const editedRows = recordsFor(leaderNormal, "normal").filter((row) => row.original_record_id === editTarget2.record_id || row.is_admin_edited === "true");
  expect("admin_actions", "edit replacement keeps trace fields", editedRows.length > 0, "original_record_id/is_admin_edited exist", `${editedRows.length} rows`);

  await clearRecords(leaderAi, "admin", "ai_challenge");
  expect("admin_actions", "AI reset hides AI display only", recordsFor(leaderAi, "ai_challenge").length === 0, "AI display records 0", `${recordsFor(leaderAi, "ai_challenge").length}`);

  const officialNormalFilesBeforePractice = incomingFiles(leaderNormal.config, "normal").length;
  const officialAiFilesBeforePractice = incomingFiles(leaderAi.config, "ai_challenge").length;
  const practiceRuntimeRoot = path.join(artifactRoot, "practice_isolation_PC01", "player");
  setPracticeSessionMode(false);
  ensureRuntime(practiceRuntimeRoot);
  setPracticeSessionMode(true);
  const practiceCtx = ensureRuntime(practiceRuntimeRoot);
  updateOneDriveSettings(
    practiceCtx,
    {
      syncMode: "onedrive_manual",
      pcRole: "player",
      pcId: "PC01",
      oneDriveRoot: sharedRoot,
      recordBaseFolderName,
      dayNo: 1,
      roundNo: 1
    },
    "player"
  );
  validateOneDriveSetup(practiceCtx, "player");
  await saveRecord(practiceCtx, makeInput("PC01", "normal", 141));
  await saveRecord(practiceCtx, makeInput("PC01", "ai_challenge", 142));
  const practiceRows = readRecords(practiceCtx);
  const practiceNormalPath = practiceCtx.config.typingIncomingPath;
  const practiceAiPath = practiceCtx.config.aiIncomingPath;
  expect(
    "practice isolation",
    "practice records use dedicated session folder",
    practiceRows.filter((row) => row.game_mode === "normal").length === 1 &&
      practiceRows.filter((row) => row.game_mode === "ai_challenge").length === 1 &&
      practiceNormalPath.includes(`${path.sep}연습회차${path.sep}`) &&
      practiceAiPath.includes(`${path.sep}연습회차${path.sep}`),
    "normal and AI practice records exist only under 연습회차",
    `normal=${practiceNormalPath}, ai=${practiceAiPath}`
  );
  expect(
    "practice isolation",
    "practice saves do not add official incoming files",
    incomingFiles(leaderNormal.config, "normal").length === officialNormalFilesBeforePractice &&
      incomingFiles(leaderAi.config, "ai_challenge").length === officialAiFilesBeforePractice,
    "official incoming counts unchanged",
    `normal ${officialNormalFilesBeforePractice}->${incomingFiles(leaderNormal.config, "normal").length}, ai ${officialAiFilesBeforePractice}->${incomingFiles(leaderAi.config, "ai_challenge").length}`
  );
  let practicePublishBlocked = false;
  try {
    await publishStageTextsToOneDrive(practiceCtx);
  } catch {
    practicePublishBlocked = true;
  }
  expect(
    "practice isolation",
    "practice stage-text publishing is blocked",
    practicePublishBlocked,
    "practice cannot change official shared stage texts",
    `blocked=${practicePublishBlocked}`
  );
  await clearRecords(practiceCtx, "admin", "normal");
  expect(
    "practice isolation",
    "practice reset affects only practice mode",
    recordsFor(practiceCtx, "normal").length === 0 && incomingFiles(leaderNormal.config, "normal").length === officialNormalFilesBeforePractice,
    "practice normal display cleared while official files remain",
    `practiceVisible=${recordsFor(practiceCtx, "normal").length}, officialFiles=${incomingFiles(leaderNormal.config, "normal").length}`
  );
  expect(
    "practice isolation",
    "practice config and queue are separate",
    practiceCtx.paths.configFile.endsWith("config.practice.json") && practiceCtx.paths.localQueueDir.endsWith("local_queue_practice"),
    "config.practice.json and local_queue_practice used",
    `${practiceCtx.paths.configFile} / ${practiceCtx.paths.localQueueDir}`
  );
  setPracticeSessionMode(false);

  const interruptionRoot = path.join(artifactRoot, "interruption_case", "shared_onedrive");
  const interruptionCtx = createIsolatedCtx("interruption_case_PC01", "PC01", "player", interruptionRoot);
  const interruptedNormalInput = makeInput("PC01", "normal", 201);
  interruptedNormalInput.stageTimesMs = [2500, 0, 0];
  interruptedNormalInput.final_accuracy = 75;
  interruptedNormalInput.interruption = {
    action: "retry",
    resultStage: 1,
    participantProgressPercent: 12.5,
    stageCharCounts: [4, 0, 0],
    totalTypingUnits: 7
  };
  const interruptedNormal = await saveRecord(interruptionCtx, interruptedNormalInput);
  expect(
    "interruption",
    "normal retry saves partial record",
    interruptedNormal.challenge_result_label === "중단" &&
      interruptedNormal.memo === "사용자 중단:다시하기" &&
      interruptedNormal.total_char_count === "4" &&
      interruptedNormal.result_stage === "1",
    "partial record saved as interrupted with actual typed character count",
    `${interruptedNormal.challenge_result_label}/${interruptedNormal.memo}/${interruptedNormal.total_char_count}`
  );

  const interruptedAiInput = makeInput("PC01", "ai_challenge", 202);
  interruptedAiInput.stageTimesMs = [3200, 0, 0];
  interruptedAiInput.ai!.status = "FAILED";
  interruptedAiInput.ai!.failedStage = "1";
  interruptedAiInput.ai!.stageResults = ["AI_WIN", "", ""];
  interruptedAiInput.ai!.finalResult = "AI_WIN";
  interruptedAiInput.ai!.display = {
    participantResultTimeMs: 3200,
    aiResultTimeMs: 3200,
    participantAvgCpm: 75,
    aiAvgCpm: 82,
    resultLabel: "중단 패배",
    participantProgressPercent: 8.5,
    aiProgressPercent: 9.2,
    duelTimeMs: 3200,
    resultStage: 1
  };
  interruptedAiInput.interruption = {
    action: "home",
    resultStage: 1,
    participantProgressPercent: 8.5,
    stageCharCounts: [3, 0, 0],
    totalTypingUnits: 5
  };
  const interruptedAi = await saveRecord(interruptionCtx, interruptedAiInput);
  expect(
    "interruption",
    "AI home saves partial loss",
    interruptedAi.challenge_result_label === "중단 패배" &&
      interruptedAi.final_vs_ai_result === "AI_WIN" &&
      interruptedAi.ai_progress_percent === "9.2" &&
      interruptedAi.memo === "사용자 중단:메인화면",
    "AI interruption stored as loss while preserving actual progress",
    `${interruptedAi.challenge_result_label}/${interruptedAi.ai_progress_percent}/${interruptedAi.memo}`
  );

  const snapshotRoot = path.join(artifactRoot, "bounded_state_case", "shared_onedrive");
  const snapshotCtx = createIsolatedCtx("bounded_state_case_PC01", "PC01", "player", snapshotRoot);
  const stateDir = path.join(snapshotRoot, "_typingking_state", "active_sessions");
  const stateCountBefore = filesBelow(stateDir).filter((file) => file.endsWith(".json")).length;
  validateOneDriveSetup(snapshotCtx, "player");
  validateOneDriveSetup(snapshotCtx, "player");
  const stateCountAfter = filesBelow(stateDir).filter((file) => file.endsWith(".json")).length;
  expect(
    "OneDrive capacity",
    "active-session state count is bounded per device",
    stateCountBefore === 1 && stateCountAfter === 1,
    "repeated validation replaces one device state file",
    `${stateCountBefore}->${stateCountAfter}`,
    stateDir
  );

  await publishStageTextsToOneDrive(snapshotCtx);
  await publishStageTextsToOneDrive(snapshotCtx);
  const stageSnapshotDir = path.join(snapshotRoot, recordBaseFolderName, "_typingking_state", "stage_texts");
  const stageSnapshotCount = filesBelow(stageSnapshotDir).filter((file) => file.endsWith(".csv")).length;
  expect(
    "OneDrive capacity",
    "stage-text state count is bounded per device",
    stageSnapshotCount === 1,
    "repeated publishing replaces one device snapshot",
    `${stageSnapshotCount}`,
    stageSnapshotDir
  );

  const legacyTargets = [
    path.join(snapshotRoot, "_typingking_active_sessions", "session_old.json"),
    path.join(snapshotRoot, recordBaseFolderName, "_active_sessions", "session_old.json"),
    path.join(snapshotRoot, recordBaseFolderName, "_stage_text_versions", "stage_texts_old.csv"),
    path.join(snapshotCtx.config.logsPath, "session_old.log"),
    path.join(snapshotCtx.config.sessionDataRoot, "_sync", "heartbeat_old.json")
  ];
  legacyTargets.forEach((filePath) => {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, "legacy", "utf8");
  });
  const protectedRecord = await saveRecord(snapshotCtx, makeInput("PC01", "normal", 211));
  const protectedRecordPath = path.join(snapshotCtx.config.typingIncomingPath, `${protectedRecord.record_id}.json`);
  const cleanupResult = cleanupLegacyOneDriveArtifacts(snapshotCtx);
  expect(
    "OneDrive capacity",
    "legacy cleanup removes only generated sync artifacts",
    cleanupResult.deletedFileCount === legacyTargets.length &&
      legacyTargets.every((filePath) => !fs.existsSync(filePath)) &&
      fs.existsSync(protectedRecordPath),
    "legacy logs/markers removed while incoming record remains",
    `deleted=${cleanupResult.deletedFileCount}, failed=${cleanupResult.failedFileCount}, record=${fs.existsSync(protectedRecordPath)}`
  );

  const sharedFilesBeforeReads = filesBelow(sharedRoot).length;
  for (let index = 0; index < 20; index += 1) {
    readRecords(leaderNormal);
    readRecords(leaderAi);
  }
  const sharedFilesAfterReads = filesBelow(sharedRoot).length;
  const sharedLogFiles = filesBelow(sharedRoot).filter((file) => file.toLowerCase().endsWith(".log"));
  expect(
    "OneDrive read-only",
    "six-leaderboard style repeated reads create no shared files",
    sharedFilesAfterReads === sharedFilesBeforeReads && sharedLogFiles.length === 0,
    "leaderboard reads are read-only and shared logs stay empty",
    `files ${sharedFilesBeforeReads}->${sharedFilesAfterReads}, logs=${sharedLogFiles.length}`
  );

  const compactMarker = latestMarker(leaderNormal.config, "normal");
  expect(
    "OneDrive capacity",
    "CSV marker stores hash instead of thousands of record IDs",
    compactMarker != null && !Object.prototype.hasOwnProperty.call(compactMarker.marker, "record_ids"),
    "new marker omits record_ids and keeps record_id_hash",
    compactMarker ? Object.keys(compactMarker.marker).join(",") : "missing"
  );

  const logFiles = fs.readdirSync(playerCtxs.get("PC01")!.paths.logsDir).filter((name) => name.endsWith(".log"));
  expect("logs", "per-PC logs created", logFiles.length > 0, "logs/*.log exists", `${logFiles.length}`, playerCtxs.get("PC01")!.paths.logsDir);

  addCheck({
    section: "UI",
    item: "resolution screenshot automation",
    expected: "separate UI screenshot script is run",
    actual: "data-flow verified here; UI is tested by test:e2e:ui",
    verdict: "PARTIAL"
  });

  const reportPath = writeReport();
  const diagnosticsZip = createDiagnosticsZip();
  const summaryPath = writeSummary(reportPath, diagnosticsZip);
  const pass = checks.filter((check) => check.verdict === "PASS").length;
  const fail = checks.filter((check) => check.verdict === "FAIL").length;
  console.log(JSON.stringify({ artifactRoot, reportPath, summaryPath, diagnosticsZip, pass, fail }, null, 2));
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
