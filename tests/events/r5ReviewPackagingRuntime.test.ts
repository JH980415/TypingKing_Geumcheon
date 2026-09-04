import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as reviewHarness from "../../scripts/r5-standalone-review-check";

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
