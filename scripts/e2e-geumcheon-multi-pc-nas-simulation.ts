import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { NasApiError } from "../electron/nas/apiClient";
import { EncryptedNasOutbox } from "../electron/nas/outbox";
import { NasRetryWorker } from "../electron/nas/retryWorker";
import { DEFAULT_CONFIG, RECORD_HEADERS } from "../shared/constants/defaults";
import { canonicalStringify, type NasRecordEnvelopeV1 } from "../shared/nas/protocol";
import type { CanonicalAiAttemptV1, RecordRow } from "../shared/types";
import {
  buildCanonicalAiAttempt,
  isCanonicalAiAttemptPubliclyRankable,
} from "../shared/utils/geumcheonAiAttempt";
import { rankCanonicalAiAttempts } from "../shared/utils/ranking";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const EVENT_ID = "geumcheon-science-festival-2026";
const OFFICIAL = { kind: "official" as const, session_id: "r2-uat-official", day_no: 1, round_no: 1 };
const PRACTICE = { kind: "practice" as const, session_id: "r2-uat-practice" };
const WRITERS = Array.from({ length: 10 }, (_, index) => `PC${String(index + 1).padStart(2, "0")}`);
const READER = "LEADERBOARD01";
const OWNED = [
  "multi-pc-nas-simulation-summary.json",
  "multi-pc-record-inventory.csv",
  "multi-pc-leaderboard-screenshot.png",
  "multi-pc-latency-report.md",
] as const;

type Mock = { server: { listening: boolean }; baseUrl: string; caPemPath: string };
type Response = { status: number; protocol?: string; body: Record<string, unknown> };
type Runner = {
  startPersistentMock(input: { temporaryRoot: string; packageRoot: string; tokens: Record<string, string> }): Promise<Mock>;
  closeMock(mock?: Mock): Promise<void>;
  requestJson(url: string, ca: string, headers: Record<string, string>, body?: unknown): Promise<Response>;
  writeSyntheticProfile(input: {
    caseRoot: string; executableDirectory: string;
    app: { deviceId: string; role: "leaderboard" };
    baseUrl: string; token: string;
  }): { runtimeRoot: string };
  buildIsolatedChildEnvironment(input: {
    inherited: NodeJS.ProcessEnv; caseRoot: string; executablePath: string; caPemPath: string;
  }): NodeJS.ProcessEnv;
};
const runner = require(path.join(scriptDir, "r2-uat", "uat-runner.js")) as Runner;

function args(argv: string[]) {
  let outputRoot = path.join(projectRoot, "Codex", "Evidence", "R3", "02_Tests");
  let skipScreenshot = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") outputRoot = argv[++index] ?? "";
    else if (value.startsWith("--output=")) outputRoot = value.slice(9);
    else if (value === "--skip-screenshot") skipScreenshot = true;
    else throw new Error("MULTI_PC_ARGUMENT_INVALID");
  }
  outputRoot = path.resolve(outputRoot);
  if (!outputRoot || outputRoot === path.parse(outputRoot).root) throw new Error("MULTI_PC_OUTPUT_INVALID");
  return { outputRoot, skipScreenshot };
}

function credentials() {
  const result: Record<string, string> = {};
  for (const device of [...WRITERS, READER]) result[device] = crypto.randomBytes(32).toString("base64url");
  if (new Set(Object.values(result)).size !== 11) throw new Error("SYNTHETIC_CREDENTIAL_COLLISION");
  return result;
}

function makeRecordId(device: string, attempt: number, suffix = 0) {
  const deviceNumber = Number(device.slice(2));
  const hex = (deviceNumber * 100 + attempt * 10 + suffix).toString(16);
  return `gsc26-${device.toLowerCase()}-${hex.padStart(8, "0")}-${hex.padStart(4, "0")}-4${hex.padStart(3, "0")}-8${deviceNumber.toString(16).padStart(3, "0")}-${hex.padStart(12, "0")}`;
}

function makeRow(device: string, attempt: number, option: "official" | "practice" | "contradiction" = "official"): RecordRow {
  const base = Object.fromEntries(RECORD_HEADERS.map((key) => [key, ""])) as unknown as RecordRow;
  const deviceNumber = Number(device.slice(2));
  const complete = attempt >= 3 && !(attempt === 3 && device === "PC10");
  const stageReached = complete ? 3 : attempt;
  const id = makeRecordId(device, attempt, option === "contradiction" ? 1 : option === "practice" ? 2 : 0);
  const recordedAt = new Date(Date.UTC(2026, 7, 31, 1, deviceNumber, attempt)).toISOString();
  const units = [18, 27, 45] as const;
  const stages = units.map((assignedInputUnits, index) => {
    const stageNumber = (index + 1) as 1 | 2 | 3;
    const entered = stageNumber <= stageReached;
    const done = entered && (stageNumber < stageReached || complete);
    const correct = !entered ? 0 : done ? assignedInputUnits : Math.floor(assignedInputUnits * 0.45);
    const active = entered ? 7_000 + stageNumber * 900 + deviceNumber * 13 : 0;
    return {
      stageNumber, entered, assignedInputUnits,
      participantCorrectInputUnits: correct, participantValidInputUnits: correct,
      participantActiveTypingTimeMs: active,
      geumnaraeCorrectInputUnits: !entered ? 0 : done ? assignedInputUnits : Math.floor(assignedInputUnits * 0.55),
      geumnaraeValidInputUnits: !entered ? 0 : done ? assignedInputUnits : Math.floor(assignedInputUnits * 0.55),
      geumnaraeActiveTypingTimeMs: active, activeDuelTimeMs: active,
    };
  });
  const duelMs = stages.reduce((sum, value) => sum + value.activeDuelTimeMs, 0);
  const builtAttempt = buildCanonicalAiAttempt({
    schemaVersion: 1,
    attemptId: `attempt-${device.toLowerCase()}-${attempt}-${option[0]}`,
    recordId: id, deviceId: device, recordedAt,
    result: complete ? "PARTICIPANT_WIN" : "INTERRUPTED",
    interruptionReason: complete ? null : attempt === 1 ? "HOME" : "RETRY",
    participantFinishTimeMs: complete ? duelMs : null,
    geumnaraeFinishTimeMs: complete ? duelMs + 800 : null,
    stages,
  });
  const canonicalAttempt: CanonicalAiAttemptV1 = option === "contradiction"
    ? {
        ...builtAttempt,
        participantFinishTimeMs: (builtAttempt.geumnaraeFinishTimeMs ?? duelMs) + 1,
        contradictionCodes: ["RESULT_TIMING_CONTRADICTION"],
      }
    : builtAttempt;
  const phone = `${String(deviceNumber).padStart(2, "0")}${String(attempt).padStart(2, "0")}`;
  return Object.assign(base, {
    record_id: id, created_at: recordedAt,
    completed_at: new Date(Date.parse(recordedAt) + duelMs).toISOString(),
    participant_name: `합성${device}${attempt}`,
    phone_part1: "010", phone_part2: "0000", phone_part3: phone,
    phone_full: `0100000${phone}`, phone_masked: `010-****-${phone}`,
    privacy_agreed: "true", privacy_agreed_at: recordedAt,
    stage1_text: "과학은 질문에서 시작됩니다",
    stage2_text: "관찰과 실험은 새로운 발견을 만듭니다",
    stage3_text: "함께 탐구한 작은 질문이 미래 과학의 길을 엽니다",
    stage_text_catalog_version: "synthetic-r3-v1",
    stage1_text_id: "synthetic-s1", stage2_text_id: "synthetic-s2", stage3_text_id: "synthetic-s3",
    stage1_char_count: String(stages[0].participantCorrectInputUnits),
    stage2_char_count: String(stages[1].participantCorrectInputUnits),
    stage3_char_count: String(stages[2].participantCorrectInputUnits),
    total_char_count: String(canonicalAttempt.participantCorrectInputUnits),
    stage1_time_ms: String(stages[0].participantActiveTypingTimeMs),
    stage2_time_ms: String(stages[1].participantActiveTypingTimeMs),
    stage3_time_ms: String(stages[2].participantActiveTypingTimeMs),
    total_time_ms: String(duelMs), final_cpm: String(canonicalAttempt.participantAverageCpmRaw), final_accuracy: "100",
    display_total_sec: (duelMs / 1_000).toFixed(2), app_version: "r2.0.2-synthetic",
    is_test: "false", is_debug: "false", game_mode: "ai_challenge", ai_enabled: "true",
    ai_challenge_status: complete ? "SUCCESS" : "FAILED",
    ai_failed_stage: complete ? "" : String(stageReached),
    stage1_vs_ai_result: complete ? "USER_WIN" : "AI_WIN",
    stage2_vs_ai_result: stageReached >= 2 ? (complete ? "USER_WIN" : "AI_WIN") : "",
    stage3_vs_ai_result: complete ? "USER_WIN" : "",
    final_vs_ai_result: complete ? "USER_WIN" : "AI_WIN",
    participant_result_time_ms: String(duelMs), ai_result_time_ms: String(duelMs + 800),
    participant_avg_cpm: String(canonicalAttempt.participantAverageCpmRaw), ai_avg_cpm: String(canonicalAttempt.geumnaraeAverageCpmRaw),
    challenge_result_label: complete ? "참여자 승리" : "중단 패배",
    participant_progress_percent: String(canonicalAttempt.wholeGameProgressRaw), ai_progress_percent: String(canonicalAttempt.geumnaraeProgressRaw),
    duel_time_ms: String(duelMs), result_stage: String(stageReached),
    memo: complete ? "" : `사용자 중단: ${stageReached}단계`,
    original_record_id: "", is_admin_edited: "false",
    canonicalAttempt, attemptNumber: attempt,
    rankingEligible: option !== "contradiction",
    participantKey: `synthetic-${device}`, serverReceivedAt: recordedAt,
    completionStatus: complete ? "completed" : "interrupted",
  });
}

function wrap(row: RecordRow, session = OFFICIAL): NasRecordEnvelopeV1 {
  return { schema_version: 1, event_id: EVENT_ID, session, row };
}

function deviceOf(value: NasRecordEnvelopeV1) {
  const match = /^gsc26-(pc(?:0[1-9]|10))-/.exec(value.row.record_id);
  if (!match) throw new Error("SIMULATION_RECORD_ID_INVALID");
  return match[1].toUpperCase();
}

function hash(value: unknown) {
  return crypto.createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

function headers(tokens: Record<string, string>, device: string, id?: string) {
  return { authorization: `Bearer ${tokens[device]}`, "x-device-id": device, ...(id ? { "idempotency-key": id } : {}) };
}

function query(kind: "official" | "practice") {
  return kind === "official"
    ? "session_kind=official&session_id=r2-uat-official&day_no=1&round_no=1"
    : "session_kind=practice&session_id=r2-uat-practice";
}

function p95(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw new Error("LATENCY_SAMPLE_EMPTY");
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function aesGcmStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value: Buffer) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(1, 13));
      decipher.setAuthTag(value.subarray(13, 29));
      return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString("utf8");
    },
  };
}

async function captureScreenshot(
  mock: Mock,
  tokens: Record<string, string>,
  tempRoot: string,
  target: string,
  expectedRows: number,
) {
  const electronExe = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
  const mainJs = path.join(projectRoot, "dist-electron", "electron", "main.js");
  if (!fs.existsSync(electronExe) || !fs.existsSync(mainJs)) throw new Error("BUILT_ELECTRON_LEADERBOARD_REQUIRED");
  const scenarioRoot = path.join(tempRoot, "electron-leaderboard");
  fs.mkdirSync(scenarioRoot, { recursive: true });
  const profile = runner.writeSyntheticProfile({
    caseRoot: scenarioRoot,
    executableDirectory: scenarioRoot,
    app: { deviceId: READER, role: "leaderboard" },
    baseUrl: mock.baseUrl,
    token: tokens[READER],
  });
  const runtimeConfigDirectory = path.join(profile.runtimeRoot, "config");
  fs.mkdirSync(runtimeConfigDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeConfigDirectory, "config.json"),
    `${JSON.stringify({
      ...DEFAULT_CONFIG,
      adminPassword: crypto.randomBytes(24).toString("base64url")
    }, null, 2)}\n`,
    "utf8"
  );
  const childEnvironment = runner.buildIsolatedChildEnvironment({
    inherited: process.env,
    caseRoot: scenarioRoot,
    executablePath: path.join(scenarioRoot, "synthetic-ai-leaderboard.exe"),
    caPemPath: mock.caPemPath,
  });
  const { _electron } = await import("playwright-core");
  const app = await _electron.launch({
    executablePath: electronExe,
    args: ["--disable-gpu", mainJs, "--variant=ai-leaderboard"],
    timeout: 30_000,
      env: {
        ...childEnvironment,
        TYPINGKING_E2E_PROFILE: "functional-flow",
        APP_VARIANT: "ai-leaderboard",
      EVENT_PROFILE: "geumcheon-2026",
      TYPINGKING_RUNTIME_ROOT: profile.runtimeRoot,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
  });
  try {
    const bypassed = await app.evaluate(() => Boolean(process.env.NODE_TLS_REJECT_UNAUTHORIZED));
    if (bypassed) throw new Error("ELECTRON_TLS_BYPASS_DETECTED");
    const page = await app.firstWindow({ timeout: 30_000 }).catch((error) => {
      const startupLog = path.join(profile.runtimeRoot, "logs", "startup_error.log");
      if (fs.existsSync(startupLog)) {
        console.error(`ELECTRON_STARTUP_LOG\n${fs.readFileSync(startupLog, "utf8")}`);
      }
      throw error;
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".leaderboard-app").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(
      (count) => document.querySelectorAll(".ranking-table.ai-ranking .ranking-row.ai-row").length === count,
      expectedRows,
      { timeout: 30_000 },
    );
    if (/010\d{8}/.test(await page.locator("body").innerText())) throw new Error("RAW_PHONE_VISIBLE_IN_SCREENSHOT");
    const visibleRows = await page.locator(".ranking-table.ai-ranking .ranking-row.ai-row").count();
    await page.screenshot({ path: target, fullPage: false, animations: "disabled" });
    const png = fs.readFileSync(target);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (png.subarray(1, 4).toString("ascii") !== "PNG" || width !== 1920 || height !== 1080) {
      throw new Error("LEADERBOARD_SCREENSHOT_INVALID");
    }
    return { captured: true, width, height, visibleRows };
  } finally {
    await app.close().catch(() => undefined);
  }
}

function atomicText(target: string, value: string) {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

type Evidence = {
  duplicate: { status: number; rowGrowth: number };
  conflict: { status: number; rowGrowth: number };
  newAttempt: { status: number; rowGrowth: number };
  mismatchStatus: number;
  concurrentStatuses: number[];
  practiceRowsInOfficial: number;
  rows: RecordRow[];
  publicRows: RecordRow[];
  lostRecords: number;
  restartPreserved: boolean;
  plaintextLeak: boolean;
  pendingBefore: number;
  pendingAfter: number;
  recoveredStatus: number;
  protocols: string[];
  screenshot: { captured: boolean; width?: number; height?: number; visibleRows?: number; reason?: string };
  publicEligibilityValidated: true;
};

async function runSimulation(options: { outputRoot: string; skipScreenshot: boolean }) {
  fs.mkdirSync(options.outputRoot, { recursive: true });
  for (const name of OWNED) fs.rmSync(path.join(options.outputRoot, name), { force: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-multi-pc-"));
  const durableRoot = path.join(tempRoot, "durable");
  const outboxRoot = path.join(tempRoot, "outbox");
  fs.mkdirSync(durableRoot, { recursive: true });
  const tokens = credentials();
  const saveLatency: number[] = [];
  const visibilityLatency: number[] = [];
  const acceptedOfficial = new Set<string>();
  let mock: Mock | undefined;
  let bothServersClosed = false;
  let evidence: Evidence | undefined;

  try {
    mock = await runner.startPersistentMock({
      temporaryRoot: path.join(tempRoot, "server-a"),
      packageRoot: durableRoot,
      tokens,
    });
    if (!new crypto.X509Certificate(fs.readFileSync(mock.caPemPath)).ca) {
      throw new Error("TEMPORARY_CA_REQUIRED");
    }
    const protocols: string[] = [];
    const readRows = async (kind: "official" | "practice") => {
      if (!mock) throw new Error("MOCK_NAS_NOT_RUNNING");
      const response = await runner.requestJson(
        `${mock.baseUrl}/api/v1/records?${query(kind)}`,
        mock.caPemPath,
        headers(tokens, READER),
      );
      if (response.status !== 200 || !Array.isArray(response.body.rows)) throw new Error("LEADERBOARD_READ_FAILED");
      if (response.protocol) protocols.push(response.protocol);
      return response.body.rows as RecordRow[];
    };
    const post = async (value: NasRecordEnvelopeV1, expected = 201) => {
      if (!mock) throw new Error("MOCK_NAS_NOT_RUNNING");
      const device = deviceOf(value);
      const started = performance.now();
      const response = await runner.requestJson(
        `${mock.baseUrl}/api/v1/records`,
        mock.caPemPath,
        headers(tokens, device, value.row.record_id),
        value,
      );
      const acknowledged = performance.now();
      if (response.status !== expected) throw new Error(`POST_STATUS_${response.status}_EXPECTED_${expected}`);
      if (response.protocol) protocols.push(response.protocol);
      if (expected === 200 || expected === 201) {
        if (response.body.record_id !== value.row.record_id) throw new Error("ACK_RECORD_ID_MISMATCH");
        if (response.body.payload_sha256 !== hash(value) || response.body.stored_sha256 !== hash(value.row)) {
          throw new Error("ACK_HASH_MISMATCH");
        }
      }
      if (expected === 201) {
        const rows = await readRows(value.session.kind);
        if (!rows.some((row) => row.record_id === value.row.record_id)) throw new Error("LEADERBOARD_VISIBILITY_FAILED");
        if (value.session.kind === "official") {
          saveLatency.push(acknowledged - started);
          visibilityLatency.push(performance.now() - acknowledged);
          acceptedOfficial.add(value.row.record_id);
        }
      }
      return response;
    };

    for (const device of WRITERS) {
      await post(wrap(makeRow(device, 1)));
      await post(wrap(makeRow(device, 2)));
    }
    const concurrent = await Promise.all(WRITERS.map((device) => post(wrap(makeRow(device, 3)))));
    const concurrentStatuses = concurrent.map((value) => value.status);
    if ((await readRows("official")).length !== 30) throw new Error("THIRTY_ATTEMPTS_NOT_PRESERVED");

    const duplicateEnvelope = wrap(makeRow("PC01", 1));
    const duplicateBefore = (await readRows("official")).length;
    const duplicateResponse = await post(duplicateEnvelope, 200);
    const duplicateAfter = (await readRows("official")).length;

    const conflictEnvelope = wrap({ ...makeRow("PC01", 1), memo: "합성 충돌" });
    const conflictBefore = (await readRows("official")).length;
    const conflictResponse = await post(conflictEnvelope, 409);
    const conflictAfter = (await readRows("official")).length;

    const mismatched = wrap(makeRow("PC01", 9));
    const mismatchResponse = await runner.requestJson(
      `${mock.baseUrl}/api/v1/records`,
      mock.caPemPath,
      headers(tokens, "PC02", mismatched.row.record_id),
      mismatched,
    );
    if (mismatchResponse.status !== 422) throw new Error("DEVICE_BINDING_NOT_ENFORCED");

    const practice = wrap(makeRow("PC10", 9, "practice"), PRACTICE);
    await post(practice);
    const practiceRowsInOfficial = (await readRows("official"))
      .filter((row) => row.record_id === practice.row.record_id).length;

    const recovery = wrap(makeRow("PC01", 4));
    const outbox = new EncryptedNasOutbox({ rootDir: outboxRoot, safeStorage: aesGcmStorage() });
    await outbox.enqueue("official", recovery);
    const encrypted = fs.readFileSync(path.join(outboxRoot, "official", "pending", `${recovery.row.record_id}.bin`));
    const plaintextLeak = encrypted.includes(Buffer.from(recovery.row.record_id))
      || encrypted.includes(Buffer.from(recovery.row.participant_name));
    const beforeRestart = new Set((await readRows("official")).map((row) => row.record_id));
    const stale = { baseUrl: mock.baseUrl, caPemPath: mock.caPemPath };
    await runner.closeMock(mock);
    bothServersClosed = !mock.server.listening;
    mock = undefined;
    let endpoint = stale;
    let recoveredStatus = 0;
    const retryWorker = new NasRetryWorker({
      outbox,
      transport: {
        postRecord: async (value) => {
          try {
            const started = performance.now();
            const response = await runner.requestJson(
              `${endpoint.baseUrl}/api/v1/records`,
              endpoint.caPemPath,
              headers(tokens, deviceOf(value), value.row.record_id),
              value,
            );
            const acknowledged = performance.now();
            if (response.status !== 200 && response.status !== 201) {
              throw new NasApiError(response.status, String(response.body.code ?? "REJECTED"));
            }
            if (!mock) throw new Error("MOCK_NAS_NOT_RUNNING");
            const rows = await readRows("official");
            if (!rows.some((row) => row.record_id === value.row.record_id)) throw new Error("RECOVERY_NOT_VISIBLE");
            recoveredStatus = response.status;
            saveLatency.push(acknowledged - started);
            visibilityLatency.push(performance.now() - acknowledged);
            acceptedOfficial.add(value.row.record_id);
            return response.body as never;
          } catch (error) {
            if (error instanceof NasApiError) throw error;
            throw new NasApiError(0, "NETWORK_UNAVAILABLE");
          }
        },
      },
      initialDelayMs: 1,
      maxDelayMs: 1,
      maxAttempts: 1,
      sleep: async () => undefined,
    });
    const deferred = await retryWorker.flush("official");
    if (deferred.deferred !== 1) throw new Error("OUTBOX_OUTAGE_NOT_PRESERVED");
    const pendingBefore = (await outbox.list("official")).length;

    mock = await runner.startPersistentMock({
      temporaryRoot: path.join(tempRoot, "server-b"),
      packageRoot: durableRoot,
      tokens,
    });
    endpoint = { baseUrl: mock.baseUrl, caPemPath: mock.caPemPath };
    const afterRestart = await readRows("official");
    const restartPreserved = [...beforeRestart].every((id) => afterRestart.some((row) => row.record_id === id));
    const beforeNewAttempt = afterRestart.length;
    const recovered = await retryWorker.flush("official");
    if (recovered.sent !== 1) throw new Error("OUTBOX_RECOVERY_FAILED");
    const pendingAfter = (await outbox.list("official")).length;
    const afterNewAttempt = await readRows("official");

    await post(wrap(makeRow("PC02", 4, "contradiction")));
    const rows = await readRows("official");
    const publiclyEligible = rows.flatMap((row) => {
      const attempt = row.canonicalAttempt;
      return attempt && attempt.recordId === row.record_id
        && isCanonicalAiAttemptPubliclyRankable(attempt, { recordId: row.record_id })
        ? [attempt]
        : [];
    });
    const ranked = rankCanonicalAiAttempts(publiclyEligible);
    const publicIds = new Set(ranked.map(({ record }) => record.recordId));
    const publicRows = rows.filter((row) => publicIds.has(row.record_id));
    const lostRecords = [...acceptedOfficial].filter((id) => !rows.some((row) => row.record_id === id)).length;
    const screenshot = options.skipScreenshot
      ? { captured: false, reason: "test-mode" }
      : await captureScreenshot(mock, tokens, tempRoot, path.join(options.outputRoot, OWNED[2]), publicRows.length);

    evidence = {
      duplicate: { status: duplicateResponse.status, rowGrowth: duplicateAfter - duplicateBefore },
      conflict: { status: conflictResponse.status, rowGrowth: conflictAfter - conflictBefore },
      newAttempt: { status: recoveredStatus, rowGrowth: afterNewAttempt.length - beforeNewAttempt },
      mismatchStatus: mismatchResponse.status,
      concurrentStatuses,
      practiceRowsInOfficial,
      rows,
      publicRows,
      lostRecords,
      restartPreserved,
      plaintextLeak,
      pendingBefore,
      pendingAfter,
      recoveredStatus,
      protocols,
      screenshot,
      publicEligibilityValidated: true,
    };
  } finally {
    const finalMock = mock;
    await runner.closeMock(finalMock).catch(() => undefined);
    bothServersClosed = bothServersClosed && (!finalMock || !finalMock.server.listening);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (!evidence) throw new Error("MULTI_PC_SIMULATION_INCOMPLETE");
  const tempRemoved = !fs.existsSync(tempRoot);
  await writeEvidence(options, evidence, tokens, saveLatency, visibilityLatency, bothServersClosed, tempRemoved);
}

async function writeEvidence(
  options: { outputRoot: string; skipScreenshot: boolean },
  evidence: Evidence,
  tokens: Record<string, string>,
  saveLatency: number[],
  visibilityLatency: number[],
  serverClosed: boolean,
  tempRemoved: boolean,
) {
  const publicIds = new Set(evidence.publicRows.map((row) => row.record_id));
  const quarantined = evidence.rows.filter((row) => !publicIds.has(row.record_id));
  const publicContradictions = evidence.publicRows.filter(
    (row) => (row.canonicalAttempt?.contradictionCodes.length ?? 0) > 0,
  ).length;
  const visibleDevices = new Set(evidence.publicRows.map((row) => deviceOf(wrap(row))));
  const interruptionStages = [...new Set(evidence.publicRows
    .filter((row) => row.canonicalAttempt?.result === "INTERRUPTED")
    .map((row) => row.canonicalAttempt!.stageReached))].sort();
  const collisions = evidence.rows.length - new Set(evidence.rows.map((row) => row.record_id)).size;
  const statusCounts = Object.fromEntries(
    [...new Set(evidence.concurrentStatuses)].sort()
      .map((status) => [String(status), evidence.concurrentStatuses.filter((value) => value === status).length]),
  );
  const tlsVerified = evidence.protocols.length > 0
    && evidence.protocols.every((protocol) => /^TLSv1\.[23]$/.test(protocol));
  const screenshotValid = options.skipScreenshot
    || (evidence.screenshot.captured && evidence.screenshot.visibleRows === 31
      && evidence.screenshot.width === 1920 && evidence.screenshot.height === 1080);
  const gates = [
    evidence.rows.length === 32,
    evidence.publicRows.length === 31,
    quarantined.length === 1,
    WRITERS.every((device) => visibleDevices.has(device)),
    JSON.stringify(interruptionStages) === JSON.stringify([1, 2, 3]),
    collisions === 0,
    evidence.duplicate.status === 200 && evidence.duplicate.rowGrowth === 0,
    evidence.conflict.status === 409 && evidence.conflict.rowGrowth === 0,
    evidence.newAttempt.status === 201 && evidence.newAttempt.rowGrowth === 1,
    evidence.mismatchStatus === 422,
    JSON.stringify(statusCounts) === JSON.stringify({ "201": 10 }),
    evidence.practiceRowsInOfficial === 0,
    evidence.lostRecords === 0,
    publicContradictions === 0,
    evidence.restartPreserved,
    !evidence.plaintextLeak,
    evidence.pendingBefore === 1 && evidence.pendingAfter === 0,
    tlsVerified,
    serverClosed,
    tempRemoved,
    screenshotValid,
  ];
  if (gates.some((value) => !value)) throw new Error("MULTI_PC_ACCEPTANCE_GATE_FAILED");

  const saveP95 = p95(saveLatency);
  const visibilityP95 = p95(visibilityLatency);
  const summary = {
    schemaVersion: 1,
    status: "PASS",
    topology: { writerDeviceIds: WRITERS, readerDeviceId: READER },
    officialAttempts: {
      total: evidence.rows.length,
      visible: evidence.publicRows.length,
      quarantined: quarantined.length,
      allDevicesVisible: WRITERS.every((device) => visibleDevices.has(device)),
      recordIdCollisions: collisions,
      interruptionStages,
    },
    contract: {
      duplicate: evidence.duplicate,
      conflict: evidence.conflict,
      newAttempt: evidence.newAttempt,
    },
    concurrentPost: { statusCounts },
    isolation: { practiceRowsInOfficial: evidence.practiceRowsInOfficial },
    integrity: {
      lostRecords: evidence.lostRecords,
      contradictionsPublic: publicContradictions,
      publicEligibilityValidated: evidence.publicEligibilityValidated,
    },
    restart: { sameDurableRoot: true, recordsPreserved: evidence.restartPreserved },
    outbox: {
      cipher: "AES-256-GCM",
      plaintextLeak: evidence.plaintextLeak,
      pendingBeforeRecovery: evidence.pendingBefore,
      pendingAfterRecovery: evidence.pendingAfter,
      recoveredStatus: evidence.recoveredStatus,
    },
    latency: {
      method: "nearest-rank ceil(0.95 × n)",
      recordSaveSamples: saveLatency.length,
      recordSaveP95Ms: Number(saveP95.toFixed(3)),
      leaderboardVisibilitySamples: visibilityLatency.length,
      leaderboardVisibilityP95Ms: Number(visibilityP95.toFixed(3)),
    },
    screenshot: evidence.screenshot,
    security: {
      loopbackHttpsOnly: true,
      tlsVerificationEnabled: tlsVerified,
      minimumTlsVersion: "TLSv1.2",
      temporaryCaValidated: true,
      writerCredentialCount: 10,
      distinctWriterCredentialCount: new Set(WRITERS.map((device) => tokens[device])).size,
      deviceBindingMismatchStatus: evidence.mismatchStatus,
      actualNasUsed: false,
      productionCredentialsUsed: false,
      rawPiiUsed: false,
    },
    cleanup: { serverClosed, temporaryRootRemoved: tempRemoved },
  };
  const inventory = evidence.rows.map((row) => {
    if (!row.canonicalAttempt) throw new Error("CANONICAL_ATTEMPT_MISSING");
    return [
      row.canonicalAttempt.deviceId,
      row.record_id,
      row.canonicalAttempt.attemptId,
      "official",
      String(row.attemptNumber),
      row.canonicalAttempt.stageReached,
      row.canonicalAttempt.stageState,
      row.canonicalAttempt.wholeGameProgressRaw,
      row.canonicalAttempt.participantAverageCpmRaw,
      row.canonicalAttempt.totalActiveDuelTimeMs,
      row.canonicalAttempt.contradictionCodes.length ? "quarantined" : "public",
    ].join(",");
  }).sort();
  const inventoryHeader = [
    "device_id", "record_id", "attempt_id", "session_kind", "attempt_number",
    "stage_reached", "stage_state", "whole_game_progress_raw",
    "participant_average_cpm_raw", "total_active_duel_time_ms", "visibility",
  ].join(",");
  const latencyReport = [
    "# Multi-PC latency report",
    "",
    "All measurements use one loopback HTTPS Mock Record API with TLS certificate verification enabled.",
    "",
    "- p95 method: nearest-rank; sort ascending and select item ceil(0.95 × n).",
    `- record save samples: ${saveLatency.length}`,
    `- record save p95: ${saveP95.toFixed(3)} ms`,
    `- leaderboard visibility samples: ${visibilityLatency.length}`,
    `- leaderboard visibility p95: ${visibilityP95.toFixed(3)} ms`,
    "- record save interval: request start through validated 201 acknowledgement.",
    "- leaderboard visibility interval: acknowledgement through first verified official snapshot containing the record.",
    "",
    "Actual NAS, operating credentials, and participant PII were not used.",
    "",
  ].join("\n");
  atomicText(path.join(options.outputRoot, OWNED[0]), `${JSON.stringify(summary, null, 2)}\n`);
  atomicText(path.join(options.outputRoot, OWNED[1]), `${inventoryHeader}\n${inventory.join("\n")}\n`);
  atomicText(path.join(options.outputRoot, OWNED[3]), latencyReport);
  console.log(JSON.stringify({ ok: true, status: "PASS", officialRows: evidence.rows.length, publicRows: evidence.publicRows.length }));
}

const scriptPath = fileURLToPath(import.meta.url);
const scriptArgIndex = process.argv.findIndex((arg, index) =>
  index > 0 && path.resolve(arg) === scriptPath
);

if (scriptArgIndex >= 0) {
runSimulation(args(process.argv.slice(scriptArgIndex + 1))).catch((error) => {
console.error(error instanceof Error ? error.message : String(error));
process.exitCode = 2;
});
}

export { runSimulation };
