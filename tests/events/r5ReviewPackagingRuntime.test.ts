import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as reviewHarness from "../../scripts/r5-standalone-review-check";
import { buildRecordRow } from "../../shared/csv/fileStore";
import type { RecordRow } from "../../shared/types";
import { buildCanonicalAiAttempt } from "../../shared/utils/geumcheonAiAttempt";
import { EventEmitter } from "node:events";

test("artifact preflight rejects launchers, sidecars, and duplicate portable payloads", (t) => {
  const inspect = (reviewHarness as unknown as {
    inspectReviewArtifacts?: (inputs: Array<{ variant: string; exePath: string }>) => { violations: string[] };
  }).inspectReviewArtifacts;
  assert.equal(typeof inspect, "function");

  const tempRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? path.resolve(), "typingking-r5-artifact-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const firstDir = path.join(tempRoot, "first");
  const secondDir = path.join(tempRoot, "second");
  fs.mkdirSync(firstDir);
  fs.mkdirSync(secondDir);
  const firstExe = path.join(firstDir, "first.exe");
  const secondExe = path.join(secondDir, "second.exe");
  fs.writeFileSync(firstExe, Buffer.from("not-pe"));
  fs.copyFileSync(firstExe, secondExe);
  fs.writeFileSync(path.join(firstDir, "Run_R2_UAT.cmd"), "exit /b 0\n");
  fs.writeFileSync(path.join(secondDir, "device-profile.json"), "{}\n");

  const result = inspect!([
    { variant: "ai", exePath: firstExe },
    { variant: "practice", exePath: secondExe }
  ]);
  for (const code of ["NON_PE", "UNDERSIZED", "UNEXPECTED_SIBLING", "DUPLICATE_HASH"]) {
    assert.ok(result.violations.some((entry) => entry.includes(code)), code);
  }
});

test("runtime gate rejects helper, credential, fallback, residue, and missing review context", () => {
  const assess = (reviewHarness as unknown as {
    assessRuntimeObservation?: (input: Record<string, unknown>) => string[];
  }).assessRuntimeObservation;
  assert.equal(typeof assess, "function");
  const violations = assess!({
    expectedVariant: "ai",
    expectedRole: "player",
    expectedSession: "official",
    bootstrap: {},
    notices: ["문구 파일이 없어 기본 문구로 생성합니다."],
    observedHelperProcesses: ["node.exe"],
    credentialPopupCount: 1,
    commandWindowCount: 1,
    cleanExit: false,
    residualProcessCount: 1,
    unexpectedFiles: ["runtime/node.exe"]
  });
  for (const code of [
    "REVIEW_CONTEXT_MISSING",
    "STAGE_TEXT_FALLBACK",
    "UNEXPECTED_HELPER_PROCESS",
    "CREDENTIAL_POPUP",
    "COMMAND_WINDOW",
    "UNCLEAN_EXIT",
    "RESIDUAL_PROCESS",
    "UNEXPECTED_RUNTIME_FILE"
  ]) {
    assert.ok(violations.includes(code), code);
  }
});

test("packaged player window gate requires default outer bounds and contained five-line guide", () => {
  type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
  type Observation = {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
    heroPanel: Rect | null;
    heroGuideCard: Rect | null;
    fifthGuideLine: Rect | null;
    guideLineCount: number;
  };
  const assess = (reviewHarness as unknown as {
    assessPlayerWindowLayout?: (observation: Observation) => string[];
  }).assessPlayerWindowLayout;
  assert.equal(typeof assess, "function");
  const valid: Observation = {
    innerWidth: 1424,
    innerHeight: 861,
    outerWidth: 1440,
    outerHeight: 900,
    heroPanel: { left: 40, top: 80, right: 900, bottom: 820, width: 860, height: 740 },
    heroGuideCard: { left: 80, top: 300, right: 860, bottom: 780, width: 780, height: 480 },
    fifthGuideLine: { left: 100, top: 700, right: 840, bottom: 760, width: 740, height: 60 },
    guideLineCount: 5
  };

  assert.deepEqual(assess!(valid), []);
  assert.deepEqual(assess!({ ...valid, outerWidth: 1439 }), ["WINDOW_OUTER_BOUNDS:1439x900"]);
  assert.deepEqual(assess!({
    ...valid,
    heroGuideCard: { ...valid.heroGuideCard!, right: 901, width: 821 }
  }), ["HERO_GUIDE_CARD_NOT_CONTAINED"]);
  assert.deepEqual(assess!({
    ...valid,
    fifthGuideLine: { ...valid.fifthGuideLine!, bottom: 821, height: 121 }
  }), ["FIFTH_GUIDE_LINE_NOT_CONTAINED"]);
  assert.deepEqual(assess!({ ...valid, guideLineCount: 4 }), ["HERO_GUIDE_LINE_COUNT:4"]);
});

test("review storage gate requires the exact normal tuple even when IPC reports ok", () => {
  const assess = (reviewHarness as unknown as {
    assessReviewStorageValidation?: (
      response: unknown,
      expected: { role: string; session: string }
    ) => string[];
  }).assessReviewStorageValidation;
  assert.equal(typeof assess, "function");
  const valid = {
    ok: true,
    data: {
      storage: "local",
      environment: "review",
      role: "player",
      session: "official",
      result: "normal"
    }
  };

  assert.deepEqual(assess!(valid, { role: "player", session: "official" }), []);
  assert.deepEqual(assess!({
    ...valid,
    data: { ...valid.data, result: "error" }
  }, { role: "player", session: "official" }), ["REVIEW_STORAGE_RESULT_NOT_NORMAL"]);
  assert.deepEqual(assess!({
    ok: true,
    data: {
      storage: "onedrive",
      environment: "production",
      role: "leaderboard",
      session: "practice",
      result: "error"
    }
  }, { role: "player", session: "official" }), [
    "REVIEW_STORAGE_KIND_MISMATCH",
    "REVIEW_STORAGE_ENVIRONMENT_MISMATCH",
    "REVIEW_STORAGE_ROLE_MISMATCH",
    "REVIEW_STORAGE_SESSION_MISMATCH",
    "REVIEW_STORAGE_RESULT_NOT_NORMAL"
  ]);
  assert.deepEqual(assess!({ ok: false }, { role: "player", session: "official" }), [
    "REVIEW_STORAGE_VALIDATION_NOT_OK"
  ]);
});

test("packaged gate requires rejection from every exposed external-storage API", () => {
  const methods = (reviewHarness as unknown as {
    REVIEW_EXTERNAL_STORAGE_API_METHODS?: readonly string[];
  }).REVIEW_EXTERNAL_STORAGE_API_METHODS;
  const assess = (reviewHarness as unknown as {
    assessReviewExternalStorageBoundary?: (
      observations: Array<{ method: string; rejected: boolean }>
    ) => string[];
  }).assessReviewExternalStorageBoundary;
  assert.deepEqual(methods, [
    "publishStageTextsToOneDrive",
    "getOneDriveSettings",
    "updateOneDriveSettings",
    "validateOneDriveSetup",
    "pokeOneDriveSync",
    "cleanupLegacyOneDriveArtifacts",
    "chooseOneDriveRoot",
    "openSessionFolder"
  ]);
  assert.equal(typeof assess, "function");

  const rejected = methods!.map((method) => ({ method, rejected: true }));
  assert.deepEqual(assess!(rejected), []);
  assert.deepEqual(assess!(rejected.filter((entry) => entry.method !== "getOneDriveSettings")), [
    "REVIEW_EXTERNAL_STORAGE_MISSING:getOneDriveSettings"
  ]);
  assert.deepEqual(assess!(rejected.map((entry) =>
    entry.method === "chooseOneDriveRoot" ? { ...entry, rejected: false } : entry
  )), ["REVIEW_EXTERNAL_STORAGE_ACCEPTED:chooseOneDriveRoot"]);
});

test("runtime title contract stays distinct from packaged product names", () => {
  const titleFor = (reviewHarness as unknown as {
    expectedRendererTitle?: (variant: string) => string;
  }).expectedRendererTitle;
  assert.equal(typeof titleFor, "function");
  assert.deepEqual(
    ["ai", "ai-leaderboard", "practice", "practice-leaderboard"].map((variant) => titleFor!(variant)),
    [
      "G-Science AI 타자왕",
      "G-Science AI 타자왕 리더보드",
      "G-Science AI 타자왕 연습모드",
      "G-Science AI 타자왕 연습모드 리더보드"
    ]
  );
});
test("unauthorized review search uses masked phone suffix instead of raw identity", () => {
  const searchNeedleFor = (reviewHarness as unknown as {
    expectedMaskedPhoneSearchNeedle?: (variant: string) => string;
  }).expectedMaskedPhoneSearchNeedle;
  assert.equal(typeof searchNeedleFor, "function");
  assert.deepEqual(
    ["ai", "practice"].map((variant) => searchNeedleFor!(variant)),
    ["6101", "6201"]
  );
  assert.doesNotMatch(searchNeedleFor!("ai"), /합성공식검증/);
  assert.doesNotMatch(searchNeedleFor!("practice"), /합성연습검증/);
});
test("stage seed gate uses pre-initialize fallback evidence and canonical draws", () => {
  const assessStageSeed = (reviewHarness as unknown as {
    assessStageSeedEvidence?: (input: { exists: boolean; notices: unknown[]; drawnStageTexts: string[] }) => {
      seededBeforeInitialization: boolean;
      canonicalDrawObserved: boolean;
    };
  }).assessStageSeedEvidence;
  assert.equal(typeof assessStageSeed, "function");
  assert.deepEqual(
    assessStageSeed!({
      exists: true,
      notices: ["설정 파일이 없어 기본 설정으로 생성합니다."],
      drawnStageTexts: ["로봇과 노는 금천과학축제", "인공지능 로봇의 신나는 축제!", "AI와 소통하는 활기찬 미래 금천"]
    }),
    { seededBeforeInitialization: true, canonicalDrawObserved: true }
  );
  assert.equal(
    assessStageSeed!({
      exists: true,
      notices: ["문구 파일이 없어 기본 문구로 생성합니다."],
      drawnStageTexts: ["로봇과 노는 금천과학축제", "인공지능 로봇의 신나는 축제!", "AI와 소통하는 활기찬 미래 금천"]
    }).seededBeforeInitialization,
    false
  );
  assert.equal(
    assessStageSeed!({ exists: true, notices: [], drawnStageTexts: ["not-canonical", "also-wrong", "wrong"] }).canonicalDrawObserved,
    false
  );
});
test("review local store stays atomic across independent child processes", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? path.resolve(), "typingking-r5-child-atomic-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const childSource = `
    import crypto from "node:crypto";
    const { createReviewLocalRuntime } = await import("./electron/review/reviewLocalRuntime.ts");
    const runtime = createReviewLocalRuntime({
      rootDir: process.env.TK_R5_ROOT,
      role: "player",
      session: { kind: "official", dayNo: 1, roundNo: 1, sessionId: "review-official-1" }
    });
    const worker = Number(process.env.TK_R5_WORKER);
    const count = Number(process.env.TK_R5_COUNT);
    for (let index = 0; index < count; index += 1) {
      const recordId = process.env.TK_R5_COLLISION_ID || \`review-r5-record-\${crypto.randomUUID()}\`;
      await runtime.save({
        record_id: recordId,
        participant_name: "합성 자식 프로세스",
        phone_full: "010-0000-7700",
        birthdate: "2012-01-02",
        total_time_ms: String(1000 + worker + index),
        game_mode: "ai_challenge"
      });
    }
  `;
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/i.test(key))
  );
  const runChild = (worker: number, count: number, collisionId?: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
      cwd: path.resolve(),
      windowsHide: true,
      env: {
        ...childEnvironment,
        TK_R5_ROOT: tempRoot,
        TK_R5_WORKER: String(worker),
        TK_R5_COUNT: String(count),
        ...(collisionId ? { TK_R5_COLLISION_ID: collisionId } : {})
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child ${worker} exited ${code}: ${stderr}`)));
  });

  await Promise.all(Array.from({ length: 6 }, (_, worker) => runChild(worker, 10)));
  const recordDir = path.join(tempRoot, "official", "review-official-1", "records");
  let recordFiles = fs.readdirSync(recordDir).filter((name) => name.endsWith(".json"));
  assert.equal(recordFiles.length, 60);
  const envelopes = recordFiles.map((name) => JSON.parse(fs.readFileSync(path.join(recordDir, name), "utf8")));
  assert.equal(new Set(envelopes.map((entry) => entry.row.record_id)).size, 60);
  assert.equal(new Set(envelopes.map((entry) => entry.row.participantKey)).size, 1);

  const collisionId = "review-r5-record-00000000-0000-4000-8000-000000000001";
  await Promise.all(Array.from({ length: 6 }, (_, worker) => runChild(worker, 1, collisionId)));
  const collision = JSON.parse(fs.readFileSync(path.join(recordDir, `${collisionId}.json`), "utf8"));
  assert.equal(collision.row.record_id, collisionId);
  recordFiles = fs.readdirSync(recordDir).filter((name) => name.endsWith(".json"));
  assert.equal(recordFiles.length, 61);
  const residue = fs.readdirSync(recordDir).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(residue, []);
});

test("R6 concurrency gate requires all four variants alive together and both shared pairs within two refreshes", () => {
  const assess = (reviewHarness as unknown as {
    assessConcurrentEvidence?: (input: Record<string, unknown>) => string[];
  }).assessConcurrentEvidence;
  assert.equal(typeof assess, "function");
  const valid = {
    simultaneouslyReadyVariants: ["ai", "ai-leaderboard", "practice", "practice-leaderboard"],
    officialRefreshes: 1,
    practiceRefreshes: 2,
    crossLeakCount: 0,
    residualProcessCount: 0
  };
  assert.deepEqual(assess!(valid), []);
  assert.deepEqual(assess!({ ...valid, simultaneouslyReadyVariants: ["ai", "practice"] }), [
    "FOUR_VARIANTS_NOT_SIMULTANEOUS"
  ]);
  assert.deepEqual(assess!({ ...valid, officialRefreshes: 3, practiceRefreshes: 0 }), [
    "OFFICIAL_SHARE_EXCEEDED_TWO_REFRESHES",
    "PRACTICE_SHARE_NOT_OBSERVED"
  ]);
  assert.deepEqual(assess!({ ...valid, crossLeakCount: 1, residualProcessCount: 2 }), [
    "CROSS_SESSION_LEAK:1",
    "RESIDUAL_PROCESS:2"
  ]);
});

test("R6 leaderboard gate requires a real all-versus-best row reduction from repeat participants", () => {
  const assess = (reviewHarness as unknown as {
    assessLeaderboardViewDifference?: (input: Record<string, unknown>) => string[];
  }).assessLeaderboardViewDifference;
  assert.equal(typeof assess, "function");
  assert.deepEqual(assess!({ allRowCount: 2, bestRowCount: 1, repeatParticipantAttempts: 2 }), []);
  assert.deepEqual(assess!({ allRowCount: 1, bestRowCount: 1, repeatParticipantAttempts: 1 }), [
    "REPEAT_PARTICIPANT_ATTEMPTS_MISSING",
    "BEST_VIEW_DID_NOT_REDUCE_ROWS"
  ]);
});

test("R6 launch evidence discloses debugger argument and every overridden runtime directory", () => {
  const evidence = (reviewHarness as unknown as {
    reviewHarnessLaunchEvidence?: () => Record<string, unknown>;
  }).reviewHarnessLaunchEvidence;
  assert.equal(typeof evidence, "function");
  assert.deepEqual(evidence!(), {
    method: "PowerShell Start-Process (ShellExecute)",
    extraArguments: ["--remote-debugging-port=<ephemeral>", "--user-data-dir=<variant-isolated>"],
    environmentOverrides: ["LOCALAPPDATA", "APPDATA", "TEMP", "TMP"],
    viewportMethod: "Playwright CDP renderer viewport emulation on actual packaged EXE",
    ordinaryNoArgumentLaunch: false,
    defaultUserDirectories: false
  });
});

test("R6 reset gate requires the visible rows to clear without deleting source records", () => {
  const assess = (reviewHarness as unknown as {
    assessResetEvidence?: (input: Record<string, unknown>) => string[];
  }).assessResetEvidence;
  assert.equal(typeof assess, "function");
  assert.deepEqual(assess!({ rowsBefore: 2, rowsAfter: 0, sourceRecordsBefore: 2, sourceRecordsAfter: 2 }), []);
  assert.deepEqual(assess!({ rowsBefore: 2, rowsAfter: 1, sourceRecordsBefore: 2, sourceRecordsAfter: 1 }), [
    "RESET_DID_NOT_CLEAR_VISIBLE_ROWS",
    "RESET_DELETED_SOURCE_RECORDS"
  ]);
});

test("R6 standalone verdict cannot pass a failed variant, forced cleanup, or invalid stage seed", () => {
  const assess = (reviewHarness as unknown as {
    assessStandaloneReviewVerdict?: (input: Record<string, unknown>) => string[];
  }).assessStandaloneReviewVerdict;
  assert.equal(typeof assess, "function");
  const valid = {
    concurrentViolations: [],
    results: ["ai", "ai-leaderboard", "practice", "practice-leaderboard"].map((variant) => ({
      variant, verdict: "PASS", cleanExit: true, forcedCleanup: false
    })),
    stageSeeds: ["official", "practice"].map((session) => ({
      session, exists: true, seededBeforeInitialization: true, canonicalDrawObserved: true
    }))
  };
  assert.deepEqual(assess!(valid), []);
  assert.deepEqual(assess!({ ...valid, results: valid.results.map((result, index) => index === 0 ? { ...result, verdict: "FAIL" } : result) }), [
    "VARIANT_NOT_PASS:ai"
  ]);
  assert.deepEqual(assess!({ ...valid, results: valid.results.map((result, index) => index === 1 ? { ...result, cleanExit: false, forcedCleanup: true } : result) }), [
    "VARIANT_UNCLEAN_EXIT:ai-leaderboard",
    "VARIANT_FORCED_CLEANUP:ai-leaderboard"
  ]);
  assert.deepEqual(assess!({ ...valid, stageSeeds: valid.stageSeeds.map((seed, index) => index === 0 ? { ...seed, canonicalDrawObserved: false } : seed) }), [
    "STAGE_SEED_INVALID:official"
  ]);
});

test("R6 concurrent runtime shares record LocalAppData but isolates Electron AppData per variant", () => {
  const resolve = (reviewHarness as unknown as {
    concurrentRuntimeDirectories?: (root: string, variant: string) => Record<string, string>;
  }).concurrentRuntimeDirectories;
  assert.equal(typeof resolve, "function");
  const ai = resolve!("C:\\evidence", "ai");
  const board = resolve!("C:\\evidence", "ai-leaderboard");
  assert.equal(ai.LOCALAPPDATA, board.LOCALAPPDATA);
  assert.notEqual(ai.APPDATA, board.APPDATA);
  assert.match(ai.APPDATA, /AppData[\\/]ai$/);
  assert.match(board.APPDATA, /AppData[\\/]ai-leaderboard$/);
});

test("R6 visible mapped image evidence hashes the exact file URL bytes and rejects a wrong approved hash", (t) => {
  const hashImages = (reviewHarness as unknown as {
    hashVisibleMappedImages?: (
      images: Array<{ src: string; alt: string; naturalWidth: number; naturalHeight: number }>,
      approved: Record<string, string>
    ) => { images: Array<Record<string, unknown>>; violations: string[] };
  }).hashVisibleMappedImages;
  assert.equal(typeof hashImages, "function");
  const tempRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? path.resolve(), "typingking-r6-image-hash-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const asset = path.join(tempRoot, "금나래 승리.png");
  fs.writeFileSync(asset, "approved-bytes", "utf8");
  const input = [{ src: pathToFileURL(asset).href, alt: "승리한 AI", naturalWidth: 100, naturalHeight: 200 }];
  const expected = "69BA39D42450CFF311E8C12BE31F5534E8619E625E618B34B6841EC9E79EF321";
  const valid = hashImages!(input, { "금나래 승리.png": expected });
  assert.deepEqual(valid.violations, []);
  assert.equal(valid.images[0].sha256, expected);
  assert.equal(valid.images[0].approvedBytesMatch, true);
  assert.equal("filePath" in valid.images[0], false);
  assert.equal("readError" in valid.images[0], false);
  assert.deepEqual(hashImages!(input, { "금나래 승리.png": "0".repeat(64) }).violations, [
    "VISIBLE_ASSET_HASH_MISMATCH:금나래 승리.png"
  ]);
});

test("R6 observed CPM parser preserves decimals and does not invent a value when absent", () => {
  const parse = (reviewHarness as unknown as {
    parseObservedCpm?: (text: string) => number | null;
  }).parseObservedCpm;
  assert.equal(typeof parse, "function");
  assert.equal(parse!("금나래 123.4 CPM"), 123.4);
  assert.equal(parse!("관측 98.75 타/분"), 98.75);
  assert.equal(parse!("대기 중"), null);
});

test("R6 synthetic AI fixture rebuilds a validator-approved input from the real flat UI row", () => {
  const rebuild = (reviewHarness as unknown as {
    buildSyntheticAiFixtureInput?: (row: RecordRow, identity: { name: string; phone2: string; phone3: string }) => unknown;
  }).buildSyntheticAiFixtureInput;
  assert.equal(typeof rebuild, "function");
  const row = {
    participant_name: "실제승리", phone_part1: "010", phone_part2: "5101", phone_part3: "6101",
    birth_year: "2012", birth_month: "01", birth_day: "02", privacy_agreed_at: "2026-09-08T00:00:00.000Z",
    stage1_text: "첫 문장", stage2_text: "둘 문장", stage3_text: "셋 문장",
    stage1_time_ms: "1100", stage2_time_ms: "1200", stage3_time_ms: "1300", final_accuracy: "100",
    ai_challenge_status: "SUCCESS", ai_failed_stage: "",
    ai_stage1_cpm: "150", ai_stage2_cpm: "200", ai_stage3_cpm: "250",
    ai_stage1_time_ms: "1400", ai_stage2_time_ms: "1500", ai_stage3_time_ms: "1600",
    stage1_vs_ai_result: "USER_WIN", stage2_vs_ai_result: "USER_WIN", stage3_vs_ai_result: "USER_WIN",
    final_vs_ai_result: "USER_WIN", stage1_time_diff_ms: "-300", stage2_time_diff_ms: "-300",
    stage3_time_diff_ms: "-300", final_time_diff_ms: "-900", participant_result_time_ms: "3600",
    ai_result_time_ms: "4500", participant_avg_cpm: "300", ai_avg_cpm: "240",
    challenge_result_label: "참여자 승리", participant_progress_percent: "100", ai_progress_percent: "80",
    duel_time_ms: "4500", result_stage: "3"
  } as RecordRow;
  const input = rebuild!(row, { name: "합성검증01", phone2: "7101", phone3: "8101" }) as Parameters<typeof buildRecordRow>[0];
  const rebuilt = buildRecordRow(input);
  assert.equal(input.phone_part1, "010");
  assert.equal(input.game_mode, "ai_challenge");
  assert.equal(rebuilt.game_mode, "ai_challenge");
  assert.equal(rebuilt.final_vs_ai_result, "USER_WIN");
  assert.equal(rebuilt.participant_name, "합성검증01");
  assert.equal(rebuilt.phone_part2, "7101");
  assert.equal(rebuilt.phone_part3, "8101");
  assert.throws(() => buildRecordRow({ ...input, phone_part1: "5101" }), /휴대폰번호는 010-0000-0000 형식/);
});

test("R6 captured renderer canonical gate rejects missing wrong contradictory or misaligned input", () => {
  const assess = (reviewHarness as unknown as { assessCapturedCanonicalInput?: (input: any) => string[] }).assessCapturedCanonicalInput;
  assert.equal(typeof assess, "function");
  const valid = {
    stageTexts: ["a", "b", "c"], stageTimesMs: [11, 22, 33],
    stageTextSelections: [{ text: "a" }, { text: "b" }, { text: "c" }],
    canonicalAttempt: buildCanonicalAiAttempt({
      schemaVersion: 1, attemptId: "gsc26-attempt-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      recordId: "gsc26-pc10-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", deviceId: "PC10",
      recordedAt: "2026-09-08T00:00:00.000Z", result: "PARTICIPANT_WIN", interruptionReason: null,
      participantFinishTimeMs: 66, geumnaraeFinishTimeMs: null,
      stages: [11, 22, 33].map((time, index) => ({
        stageNumber: (index + 1) as 1 | 2 | 3, entered: true, assignedInputUnits: 1,
        participantCorrectInputUnits: 1, participantValidInputUnits: 1, participantActiveTypingTimeMs: time,
        geumnaraeCorrectInputUnits: 0, geumnaraeValidInputUnits: 0, geumnaraeActiveTypingTimeMs: time,
        activeDuelTimeMs: time
      }))
    })
  };
  assert.deepEqual(assess!(valid), []);
  assert.ok(assess!({ ...valid, canonicalAttempt: undefined }).includes("CANONICAL_CAPTURE_MISSING"));
  assert.ok(assess!({ ...valid, canonicalAttempt: { ...valid.canonicalAttempt, result: "GEUMNARAE_WIN" } }).includes("CANONICAL_CAPTURE_RESULT"));
  assert.ok(assess!({ ...valid, canonicalAttempt: { ...valid.canonicalAttempt, contradictionCodes: ["TOTALS_MISMATCH"] } }).includes("CANONICAL_CAPTURE_CONTRADICTION"));
  assert.ok(assess!({ ...valid, canonicalAttempt: { ...valid.canonicalAttempt, stageReached: 2 } }).includes("CANONICAL_CAPTURE_STAGE"));
  assert.ok(assess!({ ...valid, stageTimesMs: [11, 22, 44] }).includes("CANONICAL_CAPTURE_ALIGNMENT"));
  assert.ok(assess!({ ...valid, stageTexts: ["aa", "b", "c"], stageTextSelections: [{ text: "aa" }, { text: "b" }, { text: "c" }] }).includes("CANONICAL_CAPTURE_ALIGNMENT"));
});

test("R6 captured input correlation and synthetic copies preserve full canonical evidence", () => {
  const correlate = (reviewHarness as any).assessCapturedStoredRow;
  const copy = (reviewHarness as any).copyCapturedSyntheticInput;
  assert.equal(typeof correlate, "function");
  assert.equal(typeof copy, "function");
  const input = {
    participant_name: "실제승리", phone_part1: "010", phone_part2: "5101", phone_part3: "6101",
    birth_year: "2012", birth_month: "01", birth_day: "02", privacy_agreed: true,
    privacy_agreed_at: "2026-09-08T00:00:00.000Z", game_mode: "ai_challenge",
    stageTexts: ["a", "b", "c"], stageTimesMs: [11, 22, 33],
    stageTextSelections: [
      { text: "a", id: "stage-1", catalogVersion: "test", stageNumber: 1 },
      { text: "b", id: "stage-2", catalogVersion: "test", stageNumber: 2 },
      { text: "c", id: "stage-3", catalogVersion: "test", stageNumber: 3 }
    ],
    fairness: { catalogVersion: "test", totalUserTimeMs: 66, stages: [11, 22, 33].map((time, index) => ({
      stageNumber: (index + 1) as 1 | 2 | 3, textId: `stage-${index + 1}`, catalogVersion: "test",
      targetText: ["a", "b", "c"][index], typedText: ["a", "b", "c"][index], userTimeMs: time,
      typingUnits: 1, aiCpm: index + 1, result: "USER_WIN" as const
    })) },
    ai: { status: "SUCCESS", failedStage: "", stageCpms: [1, 2, 3], stageTimesMs: [null, null, null],
      stageResults: ["USER_WIN", "USER_WIN", "USER_WIN"], finalResult: "USER_WIN", stageDiffsMs: [null, null, null], finalDiffMs: null },
    canonicalAttempt: buildCanonicalAiAttempt({
      schemaVersion: 1, attemptId: "gsc26-attempt-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      recordId: "gsc26-pc10-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", deviceId: "PC10",
      recordedAt: "2026-09-08T00:00:00.000Z", result: "PARTICIPANT_WIN", interruptionReason: null,
      participantFinishTimeMs: 66, geumnaraeFinishTimeMs: null,
      stages: [11, 22, 33].map((time, index) => ({
        stageNumber: (index + 1) as 1 | 2 | 3, entered: true, assignedInputUnits: 1,
        participantCorrectInputUnits: 1, participantValidInputUnits: 1, participantActiveTypingTimeMs: time,
        geumnaraeCorrectInputUnits: 0, geumnaraeValidInputUnits: 0, geumnaraeActiveTypingTimeMs: time, activeDuelTimeMs: time
      }))
    })
  } as Parameters<typeof buildRecordRow>[0];
  const row = { record_id: "review-r5-record-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...buildRecordRow(input) };
  assert.equal(row.canonicalAttempt, undefined, "flat persistence is not canonical persistence evidence");
  assert.deepEqual(correlate(input, row), []);
  for (const [field, value] of [["participant_name", "다른사람"], ["stage1_text", "wrong"], ["stage2_time_ms", "999"], ["game_mode", "normal"], ["final_vs_ai_result", "AI_WIN"]]) {
    assert.ok(correlate(input, { ...row, [field]: value }).length > 0, field);
  }
  assert.ok(correlate({ ...input, canonicalAttempt: undefined }, row).includes("CANONICAL_CAPTURE_MISSING"));
  const repeated = copy(input);
  assert.deepEqual(repeated, input);
  const seeded = copy(input, { name: "합성01", phone2: "0001", phone3: "0101" });
  assert.deepEqual(seeded, { ...input, participant_name: "합성01", phone_part2: "0001", phone_part3: "0101" });
  assert.notEqual(seeded.canonicalAttempt, input.canonicalAttempt);
  assert.notEqual(seeded.stageTextSelections, input.stageTextSelections);
  assert.notEqual(seeded.fairness, input.fairness);
  assert.equal(seeded.phone_part1, "010");
  assert.equal(seeded.game_mode, "ai_challenge");
  assert.equal(buildRecordRow(seeded).final_vs_ai_result, "USER_WIN");
  assert.throws(() => copy({ ...input, phone_part1: "7101" }));
  assert.throws(() => copy({ ...input, game_mode: undefined }));
  assert.throws(() => copy({ ...input, canonicalAttempt: undefined }));
});

test("R6 source breakpoint capture resumes and detaches after success or evaluation failure", async () => {
  const setup = (reviewHarness as any).captureRendererSaveInputs;
  assert.equal(typeof setup, "function");
  for (const failEvaluation of [false, true]) {
    const cdp = new EventEmitter() as any;
    const calls: Array<{ method: string; params?: any }> = [];
    cdp.send = async (method: string, params?: any) => {
      calls.push({ method, params });
      if (method === "Debugger.enable") cdp.emit("Debugger.scriptParsed", { scriptId: "7", url: "file:///final/dist-renderer/assets/index-Bwd9K4-0.js" });
      if (method === "Debugger.getScriptSource") return { scriptSource: "const pe = input;\nwindow.typingKing.saveRecord(pe);" };
      if (method === "Debugger.setBreakpoint") return { breakpointId: "save-1", actualLocation: params.location };
      if (method === "Debugger.evaluateOnCallFrame") {
        if (failEvaluation) throw new Error("capture read failed");
        return { result: { value: JSON.stringify({ participant_name: "actual", canonicalAttempt: { result: "PARTICIPANT_WIN" } }) } };
      }
      return {};
    };
    cdp.detach = async () => { calls.push({ method: "detach" }); };
    const page = { context: () => ({ newCDPSession: async () => cdp }) };
    const capture = await setup(page);
    cdp.emit("Debugger.paused", { hitBreakpoints: ["save-1"], callFrames: [{ callFrameId: "frame-1", location: { scriptId: "7" } }] });
    await capture.stop();
    assert.equal(calls.filter((call) => call.method === "Debugger.resume").length, 1);
    assert.equal(calls.filter((call) => call.method === "Debugger.removeBreakpoint").length, 1);
    assert.equal(calls.at(-1)?.method, "detach");
    assert.equal(cdp.listenerCount("Debugger.paused"), 0);
    assert.equal(cdp.listenerCount("Debugger.scriptParsed"), 0);
    if (failEvaluation) {
      assert.equal(capture.inputs.length, 0);
      assert.match(capture.errors.join(" "), /capture read failed/);
    } else {
      assert.equal(capture.inputs[0].input.participant_name, "actual");
      assert.equal(capture.inputs[0].resumedImmediately, true);
      const read = calls.find((call) => call.method === "Debugger.evaluateOnCallFrame")!;
      assert.equal(read.params.expression, "JSON.stringify(pe)");
      assert.equal(read.params.throwOnSideEffect, true);
    }
    await capture.stop();
    assert.equal(calls.filter((call) => call.method === "detach").length, 1);
  }
});

test("R6 capture setup and cleanup failures cannot leave a subscribed debugger", async () => {
  const setup = (reviewHarness as any).captureRendererSaveInputs;
  for (const missingCall of [false, true]) {
    const cdp = new EventEmitter() as any;
    const calls: string[] = [];
    let setCount = 0;
    cdp.send = async (method: string, params?: any) => {
      calls.push(method);
      if (method === "Debugger.enable") cdp.emit("Debugger.scriptParsed", { scriptId: "7", url: "file:///final/dist-renderer/assets/index-final.js" });
      if (method === "Debugger.getScriptSource") return { scriptSource: missingCall ? "const value = 1;" : "window.typingKing.saveRecord(pe);window.typingKing.saveRecord(Ke);" };
      if (method === "Debugger.setBreakpoint") {
        if (++setCount === 2) throw new Error("second breakpoint failed");
        return { breakpointId: "save-1", actualLocation: params.location };
      }
      if (method === "Debugger.removeBreakpoint") throw new Error("remove failed");
      return {};
    };
    cdp.detach = async () => { calls.push("detach"); };
    await assert.rejects(setup({ context: () => ({ newCDPSession: async () => cdp }) }), missingCall ? /source breakpoint missing/ : /second breakpoint failed/);
    assert.equal(calls.at(-1), "detach");
    assert.equal(cdp.listenerCount("Debugger.paused"), 0);
    assert.equal(cdp.listenerCount("Debugger.scriptParsed"), 0);
    assert.equal(calls.filter((call) => call === "Debugger.removeBreakpoint").length, missingCall ? 0 : 1);
  }
});

test("R6 native process observer rejects missing or failed enumeration evidence", () => {
  const parse = (reviewHarness as any).parseNativeProcessSnapshot;
  assert.equal(typeof parse, "function");
  const row = { ProcessId: 100, ParentProcessId: 50, Name: "review.exe", MainWindowTitle: "review", ExecutablePath: "C:\\review\\review.exe", CreatedAtUtc: "2026-09-08T09:00:00.000Z" };
  const envelope = { method: "Toolhelp32Snapshot + Get-Process", snapshotComplete: true, snapshotProcessCount: 4, rootPid: 100, rootPresent: true, processes: [row] };
  const response = { status: 0, stdout: JSON.stringify(envelope), stderr: "" };
  assert.deepEqual(parse(response, 100), [row]);
  assert.deepEqual(parse({ ...response, stdout: JSON.stringify({ ...envelope, rootPresent: false, processes: [] }) }, 100), []);
  for (const failed of [
    { status: null, stdout: "", error: { code: "ETIMEDOUT" } },
    { status: 1, stdout: "", stderr: "access denied" },
    { status: 0, stdout: "" },
    { status: 0, stdout: "{" },
    { status: 0, stdout: JSON.stringify({ ...envelope, snapshotComplete: false }) },
    { status: 0, stdout: JSON.stringify({ ...envelope, rootPresent: true, processes: [] }) },
    { status: 0, stdout: JSON.stringify({ ...envelope, rootPid: 101 }) },
    { status: 0, stdout: JSON.stringify({ ...envelope, processes: [{ ...row, MainWindowTitle: null }] }) }
  ]) assert.throws(() => parse(failed, 100), /PROCESS_TREE_/);
  assert.throws(() => parse(response, 100, { executablePath: "C:\\other.exe", notBeforeMs: 0 }), /PROCESS_TREE_ROOT_IDENTITY/);
  assert.throws(() => parse(response, 100, { executablePath: row.ExecutablePath, notBeforeMs: Date.parse("2026-09-08T10:00:00Z") }), /PROCESS_TREE_ROOT_IDENTITY/);
  assert.ok(reviewHarness.assessRuntimeObservation({ observedHelperProcesses: ["cmd.exe"], credentialPopupCount: 1, commandWindowCount: 1 }).includes("CREDENTIAL_POPUP"));
});

test("R6 native process observer proves a real child relationship and post-exit absence", async (t) => {
  const observe = (reviewHarness as any).processTree;
  assert.equal(typeof observe, "function");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill(); });
  assert.ok(child.pid);
  const rows = observe(process.pid);
  const childRow = rows.find((entry: any) => entry.ProcessId === child.pid);
  assert.equal(childRow?.ParentProcessId, process.pid);
  assert.equal(childRow?.Name.toLowerCase(), "node.exe");
  assert.ok(childRow?.ExecutablePath);
  assert.ok(Number.isFinite(Date.parse(childRow?.CreatedAtUtc)));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
  assert.deepEqual(observe(child.pid), []);
});

test("R6 unknown final process evidence cannot pass runtime or concurrent cleanup gates", () => {
  assert.ok(reviewHarness.assessRuntimeObservation({ residualProcessCount: null } as any).includes("PROCESS_OBSERVATION_UNKNOWN"));
  assert.ok(reviewHarness.assessConcurrentEvidence({
    simultaneouslyReadyVariants: ["ai", "ai-leaderboard", "practice", "practice-leaderboard"],
    officialRefreshes: 1, practiceRefreshes: 1, crossLeakCount: 0, residualProcessCount: null
  } as any).includes("PROCESS_OBSERVATION_UNKNOWN"));
});

test("R6 synthetic seed evidence requires ten new distinct persisted records and one repeat increment", () => {
  const assess = (reviewHarness as any).assessSyntheticSeedEvidence;
  assert.equal(typeof assess, "function");
  const beforeIds = ["review-r5-record-00000000-0000-4000-8000-000000000000"];
  const returnedIds = Array.from({ length: 10 }, (_, index) => `review-r5-record-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  const valid = { beforeIds, returnedIds, afterIds: [...beforeIds, ...returnedIds], repeatBefore: 2, repeatAfter: 3 };
  assert.deepEqual(assess(valid), []);
  for (const input of [
    { ...valid, returnedIds: [beforeIds[0], ...returnedIds.slice(1)] },
    { ...valid, returnedIds: [returnedIds[1], ...returnedIds.slice(1)] },
    { ...valid, returnedIds: returnedIds.slice(1) },
    { ...valid, afterIds: valid.afterIds.slice(1) },
    { ...valid, repeatAfter: 2 }
  ]) assert.ok(assess(input).length > 0);
});

test("R6 all-record search requires every fixture attempt with exact masked identity", () => {
  const assess = (reviewHarness as any).assessMaskedSearchEvidence;
  assert.equal(typeof assess, "function");
  const row = { name: "합****증", phone: "010-****-6101", text: "합****증 010-****-6101 참여자 승리" };
  const valid = {
    expectedCount: 3, expectedMaskedName: "합****증", phoneSuffix: "6101",
    rawParticipantNames: ["합성공식검증", "합성공식01"], rawPhoneNumbers: ["010-5101-6101", "010-0001-0101"],
    rows: [row, { ...row, text: "합****증 010-****-6101 금나래 승리" }, row]
  };
  assert.deepEqual(assess(valid), []);
  for (const rows of [[], [row], [row, row], [...valid.rows, row]]) {
    assert.ok(assess({ ...valid, rows }).includes("SEARCH_ATTEMPT_COUNT_MISMATCH"));
  }
  for (const changed of [
    { ...row, name: "합****1" },
    { ...row, phone: "010-****-0101" },
    { ...row, phone: "010-5101-6101" },
    { ...row, text: `${row.text} 합성공식검증` },
    { ...row, text: `${row.text} 합성공식01` },
    { ...row, text: `${row.text} 010-0001-0101` }
  ]) {
    assert.ok(assess({ ...valid, rows: [row, row, changed] }).length > 0, "all rows, including the last, must be checked");
  }
});

test("R6 storage boundary waits for all four completed initializations before any snapshot", async () => {
  const observe = (reviewHarness as any).observeInitializedReviewStorageBoundary;
  assert.equal(typeof observe, "function");
  const variants = ["ai", "ai-leaderboard", "practice", "practice-leaderboard"];
  const initializedVariants = new Set<string>();
  let storage = ["logs/", "logs/app.log:1:startup-one", "session/.review-readiness.probe:32:probe"];
  const events: string[] = [];
  const start = (variant: string) => observe({
    variant, initializedVariants, timeoutMs: 2_000,
    snapshot: () => {
      assert.equal(initializedVariants.size, 4);
      events.push(`snapshot:${variant}`);
      return [...storage];
    },
    observe: async () => {
      events.push(`boundary:${variant}`);
      return [{ method: "getOneDriveSettings", rejected: true }];
    }
  });
  const pending = variants.slice(0, 3).map(start);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.length, 0, "no boundary work while sibling startup/validation is incomplete");
  storage = ["logs/", "logs/app.log:2:startup-two", "session/", "session/.review-mutation:0:lock"];
  pending.push(start(variants[3]));
  const results = await Promise.all(pending);
  for (const result of results) {
    assert.deepEqual(result.initializedVariants, variants);
    assert.deepEqual(result.storageBefore, storage);
    assert.deepEqual(result.storageAfter, storage);
    assert.deepEqual(result.storageDifference, { beforeOnly: [], afterOnly: [] });
    assert.equal(result.storageUnchanged, true);
  }
  assert.equal(events.filter((event) => event.startsWith("snapshot:")).length, 8);
  assert.equal(events.filter((event) => event.startsWith("boundary:")).length, 4);
});

test("R6 storage boundary fails closed when a required initialization never completes", async () => {
  const observe = (reviewHarness as any).observeInitializedReviewStorageBoundary;
  assert.equal(typeof observe, "function");
  let calls = 0;
  await assert.rejects(observe({
    variant: "ai", initializedVariants: new Set(["ai-leaderboard", "practice", "unexpected-variant"]),
    timeoutMs: 1,
    snapshot: () => { calls += 1; return []; },
    observe: async () => { calls += 1; return []; }
  }), /Timed out waiting for all four portable variants initialized before storage boundary/);
  assert.equal(calls, 0, "a set of four names must not substitute for the four required variants");
});

test("R6 storage boundary preserves full snapshots and both sides of every change", async () => {
  const observe = (reviewHarness as any).observeInitializedReviewStorageBoundary;
  assert.equal(typeof observe, "function");
  const before = ["logs/", "logs/app.log:1:old-hash", "session/", "session/old.probe:32:probe-hash"];
  const after = ["logs/", "logs/app.log:2:new-hash", "session/", "session/.review-mutation:0:lock-hash", "new-directory/"];
  let storage = before;
  const observations = [{ method: "getOneDriveSettings", rejected: true }];
  const result = await observe({
    variant: "ai", initializedVariants: new Set(["ai", "ai-leaderboard", "practice", "practice-leaderboard"]),
    snapshot: () => [...storage],
    observe: async () => { storage = after; return observations; }
  });
  assert.deepEqual(result.observations, observations);
  assert.equal(result.storageUnchanged, false, "rejected IPC does not imply unchanged storage");
  assert.deepEqual(result.storageBefore, before);
  assert.deepEqual(result.storageAfter, after);
  assert.deepEqual(result.storageDifference, {
    beforeOnly: ["logs/app.log:1:old-hash", "session/old.probe:32:probe-hash"],
    afterOnly: ["logs/app.log:2:new-hash", "session/.review-mutation:0:lock-hash", "new-directory/"]
  });
});

test("R6 leaderboard capture rejects an obscuring modal or wrong table row count", () => {
  const assess = (reviewHarness as any).assessLeaderboardTableCapture;
  assert.equal(typeof assess, "function");
  const observation = { bodyCount: 1, rowCount: 12, adminModalCount: 0, modalBackdropCount: 0 };
  assert.deepEqual(assess(12, observation), []);
  assert.deepEqual(assess(0, { ...observation, rowCount: 0 }), []);
  for (const change of [
    { bodyCount: 0 }, { bodyCount: 2 }, { rowCount: 10 },
    { adminModalCount: 1 }, { modalBackdropCount: 1 }
  ]) assert.ok(assess(12, { ...observation, ...change }).length > 0);
});

test("R6 leaderboard scroll requires movement from top to bottom and a visible last row", () => {
  const assess = (reviewHarness as any).assessLeaderboardScrollEvidence;
  assert.equal(typeof assess, "function");
  const before = {
    bodyCount: 1, rowCount: 12, adminModalCount: 0, modalBackdropCount: 0,
    scrollTop: 0, scrollHeight: 900, clientHeight: 400, lastRowVisible: false
  };
  const after = { ...before, scrollTop: 500, lastRowVisible: true };
  assert.deepEqual(assess({ before, after }), []);
  assert.ok(assess({ before: { ...before, scrollTop: 1 }, after }).length > 0);
  for (const change of [
    { scrollTop: 0 }, { scrollTop: NaN }, { scrollTop: 250 }, { scrollHeight: 400 }, { clientHeight: 0 },
    { rowCount: 10 }, { lastRowVisible: false }, { adminModalCount: 1 }, { modalBackdropCount: 1 }
  ]) assert.ok(assess({ before, after: { ...after, ...change } }).length > 0);
});

test("R6 all versus best comparison requires both unobscured resolutions with matching counts", () => {
  const assess = (reviewHarness as any).assessLeaderboardResolutionComparison;
  assert.equal(typeof assess, "function");
  const capture = (rowCount: number) => [
    { requestedViewport: { width: 1280, height: 720 } },
    { requestedViewport: { width: 1920, height: 1080 } }
  ].map((entry) => ({ ...entry, leaderboardTable: { bodyCount: 1, rowCount, adminModalCount: 0, modalBackdropCount: 0 } }));
  const valid = { allRowCount: 12, bestRowCount: 10, all: capture(12), best: capture(10) };
  assert.deepEqual(assess(valid), []);
  for (const invalid of [
    { ...valid, best: valid.best.slice(0, 1) },
    { ...valid, best: [valid.best[0], valid.best[0]] },
    { ...valid, all: capture(11) },
    { ...valid, best: capture(9) },
    { ...valid, bestRowCount: 12, best: capture(12) },
    { ...valid, best: valid.best.map((entry) => ({ ...entry, leaderboardTable: { ...entry.leaderboardTable, adminModalCount: 1 } })) }
  ]) assert.ok(assess(invalid).length > 0);
});

test("R6 image readiness requires the exact loaded image for each captured outcome", () => {
  const expectedFor = (reviewHarness as any).expectedMappedImageForScreen;
  const assess = (reviewHarness as any).assessMappedImageReadiness;
  assert.equal(typeof expectedFor, "function");
  assert.equal(typeof assess, "function");
  for (const stage of [1, 2, 3]) assert.deepEqual(expectedFor(`stage-${stage}`), {
    selector: ".challenge-modal .challenge-modal-art", fileName: `금나래패배_스테이지${stage}.png`
  });
  assert.deepEqual(expectedFor("result"), { selector: ".challenge-result-panel .challenge-result-art", fileName: "금나래패배_스테이지3.png" });
  assert.deepEqual(expectedFor("ai-win-stage-1"), { selector: ".challenge-modal .challenge-modal-art", fileName: "금나래 승리.png" });
  assert.equal(expectedFor("main"), null);
  assert.equal(expectedFor("leaderboard-all-records"), null);
  const expected = expectedFor("stage-2");
  const src = pathToFileURL(path.resolve("events/geumcheon-2026/assets/금나래패배_스테이지2.png")).href;
  const image = { src, currentSrc: src, complete: true, naturalWidth: 1254, naturalHeight: 1254, bounds: { width: 280, height: 280 } };
  const viewport = { width: 1280, height: 720 };
  const observation = { innerWidth: 1280, innerHeight: 720, images: [image] };
  assert.deepEqual(assess(expected, observation, viewport), []);
  for (const change of [
    { complete: false }, { naturalWidth: 0 }, { naturalHeight: 0 }, { currentSrc: "" },
    { bounds: { width: 280, height: 0 } },
    { src: src.replace("2.png", "1.png") }, { currentSrc: src.replace("2.png", "3.png") }
  ]) assert.ok(assess(expected, { ...observation, images: [{ ...image, ...change }] }, viewport).length > 0);
  for (const images of [[], [image, image]]) assert.ok(assess(expected, { ...observation, images }, viewport).length > 0);
  assert.ok(assess(expected, { ...observation, innerWidth: 1920 }, viewport).length > 0);
});

test("R6 visible image hashing uses the actually selected currentSrc bytes", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? path.resolve(), "typingking-r6-current-src-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const source = path.join(tempRoot, "금나래 승리.png");
  const selectedDirectory = path.join(tempRoot, "selected");
  fs.mkdirSync(selectedDirectory);
  const selected = path.join(selectedDirectory, "금나래 승리.png");
  fs.writeFileSync(source, "approved-bytes", "utf8");
  fs.writeFileSync(selected, "wrong-selected-bytes", "utf8");
  const result = reviewHarness.hashVisibleMappedImages([{
    src: pathToFileURL(source).href, currentSrc: pathToFileURL(selected).href,
    alt: "승리한 AI", naturalWidth: 100, naturalHeight: 200
  } as any], { "금나래 승리.png": "69BA39D42450CFF311E8C12BE31F5534E8619E625E618B34B6841EC9E79EF321" });
  assert.deepEqual(result.violations, ["VISIBLE_ASSET_HASH_MISMATCH:금나래 승리.png"]);
  assert.equal(result.images[0].approvedBytesMatch, false);
});

test("R6 image readiness browser callback serializes without external helper bindings", () => {
  const observe = (reviewHarness as any).observeMappedImageReadiness;
  assert.equal(typeof observe, "function");
  assert.doesNotMatch(observe.toString(), /__name/);
  const serialized = new Function("document", "window", `return (${observe.toString()})(".challenge-modal .challenge-modal-art");`);
  const result = serialized({ querySelectorAll: () => [{
    src: "file:///stage.png", currentSrc: "file:///stage.png", alt: "test", complete: true,
    naturalWidth: 1254, naturalHeight: 1254, getBoundingClientRect: () => ({ toJSON: () => ({ width: 280, height: 280 }) })
  }] }, { innerWidth: 1280, innerHeight: 720 });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].complete, true);
  assert.equal(result.images[0].bounds.height, 280);
});

test("R6 failed image readiness preserves raw observations before taking any screenshot", async (t) => {
  const capture = (reviewHarness as any).captureResolutionEvidence;
  assert.equal(typeof capture, "function");
  const tempRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? path.resolve(), "typingking-r6-image-failure-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  let screenshotCount = 0;
  const page = {
    setViewportSize: async () => undefined,
    evaluate: async (callback: Function) => callback === (reviewHarness as any).observeMappedImageReadiness
      ? { observedAt: "2026-09-08T00:00:00.000Z", innerWidth: 1280, innerHeight: 720, images: [] }
      : true,
    screenshot: async () => { screenshotCount += 1; }
  };
  await assert.rejects(capture(page, "ai", "stage-2", tempRoot), /exact image ready at 1280x720/);
  const observed = JSON.parse(fs.readFileSync(path.join(tempRoot, "image-observations", "ai-stage-2-1280x720.json"), "utf8"));
  assert.equal(observed.status, "FAIL");
  assert.equal(observed.expectedImage.fileName, "금나래패배_스테이지2.png");
  assert.deepEqual(observed.requestedViewport, { width: 1280, height: 720 });
  assert.ok(observed.readinessSamples.length > 0);
  assert.deepEqual(observed.readinessSamples[0].images, []);
  assert.deepEqual(observed.readinessSamples[0].violations, ["EXPECTED_IMAGE_MISSING_OR_DUPLICATED"]);
  assert.equal(screenshotCount, 0);
});
