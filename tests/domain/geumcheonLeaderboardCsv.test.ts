import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "csv-parse/sync";
import { RECORD_HEADERS } from "../../shared/constants/defaults";
import {
  ensureRuntime,
  exportRecords,
  readRecords
} from "../../shared/csv/fileStore";
import type {
  CanonicalAiAttemptV1,
  RecordRow
} from "../../shared/types";
import { buildCanonicalAiAttempt } from "../../shared/utils/geumcheonAiAttempt";

function canonicalAttempt(
  recordId: string,
  overrides: Partial<CanonicalAiAttemptV1> = {}
): CanonicalAiAttemptV1 {
  const stageReached = overrides.stageReached ?? 3;
  const wholeGameProgressRaw = overrides.wholeGameProgressRaw ?? 100;
  const participantAverageCpmRaw = overrides.participantAverageCpmRaw ?? 600;
  const totalActiveDuelTimeMs = overrides.totalActiveDuelTimeMs ?? 6_000;
  const assignedByStage = stageReached === 1
    ? [100, 0, 0]
    : stageReached === 2
      ? [40, 60, 0]
      : [20, 30, 50];
  let remainingCorrect = wholeGameProgressRaw;
  let remainingValid = Math.max(1, Math.round(participantAverageCpmRaw));
  const stages = assignedByStage.map((assignedInputUnits, index) => {
    const entered = index < stageReached;
    const participantCorrectInputUnits = entered
      ? Math.min(assignedInputUnits, remainingCorrect)
      : 0;
    remainingCorrect -= participantCorrectInputUnits;
    const participantValidInputUnits = entered
      ? Math.min(Math.max(0, remainingValid), Math.max(1, participantAverageCpmRaw))
      : 0;
    remainingValid -= participantValidInputUnits;
    return {
      stageNumber: (index + 1) as 1 | 2 | 3,
      entered,
      assignedInputUnits,
      participantCorrectInputUnits,
      participantValidInputUnits,
      participantActiveTypingTimeMs: entered && index === 0 ? 60_000 : 0,
      geumnaraeCorrectInputUnits: entered && wholeGameProgressRaw === 100 ? assignedInputUnits : 0,
      geumnaraeValidInputUnits: entered && wholeGameProgressRaw === 100 ? assignedInputUnits : 0,
      geumnaraeActiveTypingTimeMs: entered && wholeGameProgressRaw === 100 && index === 0 ? 60_000 : 0,
      activeDuelTimeMs: entered && index === 0 ? totalActiveDuelTimeMs : 0
    };
  });
  const participantCompleted = stageReached === 3 && wholeGameProgressRaw === 100;
  return buildCanonicalAiAttempt({
    schemaVersion: 1,
    attemptId: `attempt-${recordId}`,
    recordId,
    deviceId: overrides.deviceId ?? "PC01",
    recordedAt: overrides.recordedAt ?? "2026-09-18T01:00:00.000Z",
    result: participantCompleted ? "PARTICIPANT_WIN" : "INTERRUPTED",
    interruptionReason: participantCompleted ? null : "HOME",
    participantFinishTimeMs: participantCompleted ? totalActiveDuelTimeMs : null,
    geumnaraeFinishTimeMs: participantCompleted ? totalActiveDuelTimeMs : null,
    stages
  });
}

function record(
  recordId: string,
  attempt?: CanonicalAiAttemptV1
): RecordRow {
  const blank = Object.fromEntries(
    RECORD_HEADERS.map((header) => [header, ""])
  ) as unknown as RecordRow;
  return {
    ...blank,
    record_id: recordId,
    created_at: "2026-09-18T01:00:00.000Z",
    completed_at: "2026-09-18T01:01:00.000Z",
    participant_name: "반복참가자",
    phone_full: "01012345678",
    phone_masked: "010-****-5678",
    total_time_ms: "30000",
    final_cpm: "500",
    game_mode: "ai_challenge",
    challenge_result_label: "참여자 승리",
    result_stage: "3",
    participant_progress_percent: "100",
    participant_avg_cpm: "500",
    duel_time_ms: "30000",
    ...(attempt ? { canonicalAttempt: attempt } : {})
  };
}

function builtCanonicalAttemptForRank(
  recordId: string,
  overrides: Partial<CanonicalAiAttemptV1>
): CanonicalAiAttemptV1 {
  const stageReached = overrides.stageReached ?? 3;
  const correctUnits = overrides.wholeGameProgressRaw ?? 100;
  const participantCpm = overrides.participantAverageCpmRaw ?? 600;
  const validUnits = participantCpm === 1 ? 1 : participantCpm / 100;
  const activeTypingTimeMs = validUnits * 60_000 / participantCpm;
  const duelTimeMs = overrides.totalActiveDuelTimeMs ?? 6_000;
  const capacities = [20, 30, 50] as const;
  const distribute = (total: number): number[] => {
    let remaining = total;
    return capacities.map((capacity, index) => {
      if (index >= stageReached) return 0;
      const value = Math.min(capacity, remaining);
      remaining -= value;
      return value;
    });
  };
  const correctByStage = distribute(correctUnits);
  const validByStage = distribute(validUnits);
  const participantCompleted = stageReached === 3 && correctUnits === 100;
  return buildCanonicalAiAttempt({
    schemaVersion: 1,
    attemptId: "attempt-" + recordId,
    recordId,
    deviceId: "PC01",
    recordedAt: overrides.recordedAt ?? "2026-09-18T01:00:00.000Z",
    result: participantCompleted ? "PARTICIPANT_WIN" : "INTERRUPTED",
    interruptionReason: participantCompleted ? null : "HOME",
    participantFinishTimeMs: participantCompleted ? duelTimeMs : null,
    geumnaraeFinishTimeMs: participantCompleted ? duelTimeMs : null,
    stages: capacities.map((capacity, index) => ({
      stageNumber: (index + 1) as 1 | 2 | 3,
      entered: index < stageReached,
      assignedInputUnits: capacity,
      participantCorrectInputUnits: correctByStage[index],
      participantValidInputUnits: validByStage[index],
      participantActiveTypingTimeMs: index === 0 ? activeTypingTimeMs : 0,
      geumnaraeCorrectInputUnits: correctByStage[index],
      geumnaraeValidInputUnits: validByStage[index],
      geumnaraeActiveTypingTimeMs: index === 0 ? activeTypingTimeMs : 0,
      activeDuelTimeMs: index === 0 ? duelTimeMs : 0
    }))
  });
}

function readJsonRecord(
  context: { after: (callback: () => void) => void },
  source: Record<string, unknown>
): RecordRow | undefined {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "typingking-canonical-json-")
  );
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const runtime = ensureRuntime(runtimeRoot, path.resolve("."));
  const oneDriveRoot = path.join(runtimeRoot, "synthetic-onedrive");
  const sessionRoot = path.join(
    oneDriveRoot,
    "records",
    "1일차",
    "1회차"
  );
  const typingIncomingPath = path.join(sessionRoot, "incoming", "typing");
  const aiIncomingPath = path.join(sessionRoot, "incoming", "ai");
  fs.mkdirSync(typingIncomingPath, { recursive: true });
  fs.mkdirSync(aiIncomingPath, { recursive: true });
  fs.writeFileSync(
    path.join(aiIncomingPath, `${String(source.record_id)}.json`),
    JSON.stringify(source),
    "utf8"
  );
  Object.assign(runtime.config, {
    syncMode: "onedrive_manual",
    oneDriveRoot,
    recordBaseFolderName: "records",
    dayNo: 1,
    roundNo: 1,
    setupComplete: true
  });
  return readRecords(runtime).find(
    (row) => row.record_id === source.record_id
  );
}

test("CSV export uses canonical order and competition tie ranks", (context) => {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "typingking-canonical-csv-")
  );
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const runtime = ensureRuntime(runtimeRoot, path.resolve("."));
  runtime.config.syncMode = "local";

  const rows = [
    record("a-fourth", builtCanonicalAttemptForRank("a-fourth", {
      stageReached: 2,
      wholeGameProgressRaw: 40,
      participantAverageCpmRaw: 800,
      totalActiveDuelTimeMs: 5_000
    })),
    record("n-tie-new", builtCanonicalAttemptForRank("n-tie-new", {
      stageReached: 2,
      wholeGameProgressRaw: 45,
      participantAverageCpmRaw: 900,
      totalActiveDuelTimeMs: 10_000,
      recordedAt: "2026-09-18T03:00:00.000Z"
    })),
    record("z-first", builtCanonicalAttemptForRank("z-first", {
      stageReached: 3,
      wholeGameProgressRaw: 55,
      participantAverageCpmRaw: 1,
      totalActiveDuelTimeMs: 99_000
    })),
    record("m-tie-old", builtCanonicalAttemptForRank("m-tie-old", {
      stageReached: 2,
      wholeGameProgressRaw: 45,
      participantAverageCpmRaw: 900,
      totalActiveDuelTimeMs: 10_000,
      recordedAt: "2026-09-18T02:00:00.000Z"
    }))
  ];

  const fileName = exportRecords(
    runtime,
    rows,
    "leaderboard",
    "ai_challenge"
  );
  const csvRows = parse(
    fs.readFileSync(path.join(runtime.paths.exportsDir, fileName), "utf8")
      .replace(/^\uFEFF/, "")
  ) as string[][];

  assert.deepEqual(
    csvRows.slice(1).map((row) => ({
      rank: row[0],
      recordId: row[1]
    })),
    [
      { rank: "1", recordId: "z-first" },
      { rank: "2", recordId: "m-tie-old" },
      { rank: "2", recordId: "n-tie-new" },
      { rank: "4", recordId: "a-fourth" }
    ]
  );
});

test("CSV export neutralizes formula-leading participant names without mutating source records", (context) => {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "typingking-formula-safe-csv-")
  );
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const runtime = ensureRuntime(runtimeRoot, path.resolve("."));
  runtime.config.syncMode = "local";
  const dangerousNames = [
    "=HYPERLINK(\"https://127.0.0.1\",\"x\")",
    "+1+1",
    "-1+1",
    "@SUM(1,1)",
    "\t=1+1",
    "\r=1+1",
    "\n=1+1"
  ];
  const rows = dangerousNames.map((participantName, index) => ({
    ...record(`formula-${index}`),
    participant_name: participantName
  }));

  const fileName = exportRecords(runtime, rows, "all", "ai_challenge");
  const csvRows = parse(
    fs.readFileSync(path.join(runtime.paths.exportsDir, fileName), "utf8")
      .replace(/^\uFEFF/, "")
  ) as string[][];
  const nameIndex = RECORD_HEADERS.indexOf("participant_name") + 1;
  const exportedNamesById = new Map(
    csvRows.slice(1).map((row) => [row[1], row[nameIndex]])
  );

  for (const row of rows) {
    assert.equal(exportedNamesById.get(row.record_id), `'${row.participant_name}`);
  }
  assert.deepEqual(rows.map((row) => row.participant_name), dangerousNames);
});

test("CSV export preserves legacy AI ordering without a canonical extension", (context) => {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "typingking-legacy-csv-")
  );
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const runtime = ensureRuntime(runtimeRoot, path.resolve("."));
  runtime.config.syncMode = "local";
  const slower = {
    ...record("legacy-slower"),
    participant_avg_cpm: "900",
    duel_time_ms: "30000"
  };
  const faster = {
    ...record("legacy-faster"),
    participant_avg_cpm: "500",
    duel_time_ms: "28000"
  };

  const fileName = exportRecords(
    runtime,
    [slower, faster],
    "leaderboard",
    "ai_challenge"
  );
  const csvRows = parse(
    fs.readFileSync(path.join(runtime.paths.exportsDir, fileName), "utf8")
      .replace(/^\uFEFF/, "")
  ) as string[][];

  assert.deepEqual(
    csvRows.slice(1).map((row) => ({ rank: row[0], recordId: row[1] })),
    [
      { rank: "1", recordId: "legacy-faster" },
      { rank: "2", recordId: "legacy-slower" }
    ]
  );
});

test("CSV export retains a quarantined canonical record without a public rank", (context) => {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "typingking-quarantine-csv-")
  );
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const runtime = ensureRuntime(runtimeRoot, path.resolve("."));
  runtime.config.syncMode = "local";
  const publicAttempt = builtCanonicalAttemptForRank("public-record", {
    stageReached: 3,
    wholeGameProgressRaw: 55,
    participantAverageCpmRaw: 500,
    totalActiveDuelTimeMs: 6_000
  });
  const quarantinedAttempt = {
    ...builtCanonicalAttemptForRank("quarantined-record", {
      stageReached: 3,
      wholeGameProgressRaw: 55,
      participantAverageCpmRaw: 500,
      totalActiveDuelTimeMs: 6_000
    }),
    contradictionCodes: ["TOTALS_MISMATCH" as const]
  };

  const fileName = exportRecords(
    runtime,
    [
      record("quarantined-record", quarantinedAttempt),
      record("public-record", publicAttempt)
    ],
    "all",
    "ai_challenge"
  );
  const csvRows = parse(
    fs.readFileSync(path.join(runtime.paths.exportsDir, fileName), "utf8")
      .replace(/^\uFEFF/, "")
  ) as string[][];

  assert.deepEqual(
    csvRows.slice(1).map((row) => ({ rank: row[0], recordId: row[1] })),
    [
      { rank: "1", recordId: "public-record" },
      { rank: "", recordId: "quarantined-record" }
    ]
  );
});

test("JSON normalization preserves a complete canonical attempt", (context) => {
  const attempt = canonicalAttempt("complete-record");
  const normalized = readJsonRecord(context, {
    ...record("complete-record"),
    canonicalAttempt: attempt
  });

  assert.deepEqual(normalized?.canonicalAttempt, attempt);
});

test("JSON normalization drops a partial canonical extension but keeps the record", (context) => {
  const normalized = readJsonRecord(context, {
    ...record("partial-record"),
    canonicalAttempt: {
      schemaVersion: 1,
      recordId: "partial-record"
    }
  });

  assert.equal(normalized?.record_id, "partial-record");
  assert.equal(normalized?.canonicalAttempt, undefined);
});

test("JSON normalization keeps legacy records without a canonical extension", (context) => {
  const normalized = readJsonRecord(
    context,
    record("legacy-record") as unknown as Record<string, unknown>
  );

  assert.equal(normalized?.record_id, "legacy-record");
  assert.equal(normalized?.canonicalAttempt, undefined);
});

test("Geumcheon CSV export names the competitor as Geumnarae", (context) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-geumnarae-csv-"));
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const runtime = ensureRuntime(runtimeRoot, path.resolve("."));
  const fileName = exportRecords(runtime, [record("header-row")], "all", "ai_challenge");
  const [header] = parse(
    fs.readFileSync(path.join(runtime.paths.exportsDir, fileName), "utf8").replace(/^\uFEFF/, "")
  ) as string[][];
  const labelFor = (key: (typeof RECORD_HEADERS)[number]) =>
    header[RECORD_HEADERS.indexOf(key) + 1];

  assert.equal(labelFor("ai_failed_stage"), "AI 챌린지 실패 스테이지");
  assert.equal(labelFor("ai_stage1_cpm"), "금나래 1스테이지 타수");
  assert.equal(labelFor("ai_stage1_time_ms"), "금나래 1스테이지 시간(ms)");
  assert.equal(labelFor("ai_total_time_ms"), "금나래 전체 시간(ms)");
  assert.equal(labelFor("stage1_vs_ai_result"), "1스테이지 금나래 대결 결과");
  assert.equal(labelFor("final_vs_ai_result"), "최종 금나래 대결 결과");
  assert.equal(labelFor("ai_result_time_ms"), "금나래 결과 시간(ms)");
  assert.equal(labelFor("ai_avg_cpm"), "금나래 평균 타수");
  assert.equal(labelFor("challenge_result_label"), "금나래 대결 결과");
  assert.equal(labelFor("ai_progress_percent"), "금나래 진행률");
});
