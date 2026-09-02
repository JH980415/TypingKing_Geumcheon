import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(__dirname, "..", "..");
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const builder = path.join(projectRoot, "scripts", "r2-uat", "standalone-uat.ts");
const directLaunchers = [
  { fileName: "G-Science AI 타자왕.exe", app: "ai" },
  { fileName: "G-Science AI 타자왕 리더보드.exe", app: "ai-leaderboard" },
  { fileName: "G-Science AI 타자왕 연습모드.exe", app: "practice" },
  { fileName: "G-Science AI 타자왕 연습모드 리더보드.exe", app: "practice-leaderboard" }
] as const;

function buildPackage(root: string, releaseSource?: string, selfTest = false): void {
  const args = [tsxCli, builder, "--prepare-launchers", root];
  if (selfTest) args.splice(2, 0, "--self-test");
  if (releaseSource) args.push("--release-source", releaseSource);
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot, encoding: "utf8", windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
}

function runPackage(root: string, ...args: string[]) {
  return spawnSync(path.join(root, "runtime", "node.exe"), [path.join(root, "runtime", "uat-runner.js"), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true
  });
}

function makeRunnableRelease(root: string): void {
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "scripts", "r2-uat", "uat-default-config.json"), "utf8")) as { apps: Array<{ fileName: string }>; requiredResources: string[] };
  for (const app of config.apps) fs.copyFileSync(process.execPath, path.join(root, app.fileName));
  for (const resource of config.requiredResources) {
    const target = path.join(root, resource);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, resource.endsWith("stage_texts.csv") ? [
      "id,catalog_version,game_mode,stage_number,text,is_active,created_at,updated_at",
      "s1,v1,ai_challenge,1,첫 번째 합성 문구,true,2026-08-31T00:00:00.000Z,2026-08-31T00:00:00.000Z",
      "s2,v1,ai_challenge,2,두 번째 합성 문구,true,2026-08-31T00:00:00.000Z,2026-08-31T00:00:00.000Z",
      "s3,v1,ai_challenge,3,세 번째 합성 문구,true,2026-08-31T00:00:00.000Z,2026-08-31T00:00:00.000Z"
    ].join("\n") : "synthetic UAT resource", "utf8");
  }
}

test("break: package-root Windows launchers select the matching UAT app and wait for its runner", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-direct-launcher-"));
  const marker = path.join(root, "launcher-result.json");
  try {
    fs.writeFileSync(path.join(root, "EXE_직접실행금지_UAT안내.txt"), "stale direct-launch ban", "utf8");
    buildPackage(root);
    fs.writeFileSync(path.join(root, "runtime", "uat-runner.js"), [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'setTimeout(() => fs.writeFileSync(path.join(__dirname, "..", "launcher-result.json"),',
      '  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })), 150);'
    ].join("\n"), "utf8");

    for (const launcher of directLaunchers) {
      const executable = path.join(root, launcher.fileName);
      assert.equal(fs.existsSync(executable), true, `${launcher.fileName} was not generated`);
      assert.ok(fs.statSync(executable).size < 128 * 1024, `${launcher.fileName} is not a small launcher`);
      fs.rmSync(marker, { force: true });
      const result = spawnSync(executable, [], {
        cwd: os.tmpdir(), encoding: "utf8", windowsHide: true, timeout: 10_000
      });
      assert.equal(result.status, 0, result.error?.message ?? `${launcher.fileName} failed`);
      const captured = JSON.parse(fs.readFileSync(marker, "utf8")) as { args: string[]; cwd: string };
      assert.deepEqual(captured.args, [`--app=${launcher.app}`]);
      assert.equal(path.resolve(captured.cwd).toLowerCase(), path.resolve(root).toLowerCase());
    }
    assert.equal(fs.existsSync(path.join(root, "EXE_직접실행금지_UAT안내.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("break: packaging fails explicitly when the Windows .NET Framework C# compiler is unavailable", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-no-csc-output-"));
  const emptyWindowsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-no-csc-windows-"));
  try {
    const result = spawnSync(process.execPath, [tsxCli, builder, "--prepare-launchers", root], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, WINDIR: emptyWindowsRoot }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Windows \.NET Framework C# 컴파일러\(csc\.exe\)를 찾을 수 없습니다/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyWindowsRoot, { recursive: true, force: true });
  }
});

test("break: a package without release EXEs fails in Korean instead of synthesizing a successful run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-missing-release-"));
  try {
    buildPackage(root);
    const result = runPackage(root, "--app", "ai");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UAT 실행 파일 또는 리소스가 누락되었습니다/);
    assert.equal(fs.existsSync(path.join(root, "records", "normal", "official.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("break: builder self-test rejects a generated package without release EXEs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-builder-selftest-"));
  try {
    const result = spawnSync(process.execPath, [tsxCli, builder, "--self-test", "--prepare-launchers", root], {
      cwd: projectRoot, encoding: "utf8", windowsHide: true
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UAT 실행 파일 또는 리소스가 누락되었습니다/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("break: a Korean-path UAT package is self-contained and proves HTTPS trust without a TLS bypass", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "AI 타자왕 독립 UAT "));
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "AI 타자왕 release input "));
  try {
    makeRunnableRelease(release);
    buildPackage(root, release, true);
    assert.equal(fs.existsSync(path.join(root, "runtime", "node.exe")), true);
    assert.equal(fs.existsSync(path.join(root, "runtime", "uat-runner.js")), true);
    const result = runPackage(root, "--self-test");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /R2_UAT_SELF_TEST=PASS/);
    assert.match(result.stdout, /TLS verification remains enabled/);
    assert.match(result.stdout, /EXE files checked: 4/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(release, { recursive: true, force: true });
  }
});

test("break: real Mock API record posts persist across runs until reset while the sample fixture remains isolated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-persistent-store-"));
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-release-input-"));
  const tempOne = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-api-one-"));
  const tempTwo = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-api-two-"));
  try {
    makeRunnableRelease(release);
    buildPackage(root, release);
    const runner = require(path.join(root, "runtime", "uat-runner.js")) as {
      requestJson(url: string, ca: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
      startPersistentMock(input: { temporaryRoot: string; packageRoot: string; tokens: Record<string, string> }): Promise<{ baseUrl: string; caPemPath: string; server: { close(callback: () => void): void } }>;
      writeSample(root: string): void;
    };
    const tokens = { PC01: "a".repeat(43), LEADERBOARD01: "b".repeat(43) };
    const envelope = {
      schema_version: 1,
      event_id: "geumcheon-science-festival-2026",
      session: { kind: "official", session_id: "r2-uat-official", day_no: 1, round_no: 1 },
      row: { record_id: "gsc26-pc01-00000000-0000-4000-8000-000000000001", game_mode: "ai_challenge" }
    };
    const first = await runner.startPersistentMock({ temporaryRoot: tempOne, packageRoot: root, tokens });
    const writerHeaders = { authorization: `Bearer ${tokens.PC01}`, "x-device-id": "PC01", "idempotency-key": envelope.row.record_id };
    const post = await runner.requestJson(`${first.baseUrl}/api/v1/records`, first.caPemPath, writerHeaders, envelope);
    assert.equal(post.status, 201);
    assert.equal(post.body.disposition, "stored");
    assert.deepEqual(Object.keys(post.body).sort(), ["disposition", "payload_sha256", "received_at", "record_id", "schema_version", "stored_sha256"].sort());
    assert.match(String(post.body.payload_sha256), /^[0-9a-f]{64}$/);
    assert.match(String(post.body.stored_sha256), /^[0-9a-f]{64}$/);
    const duplicate = await runner.requestJson(`${first.baseUrl}/api/v1/records`, first.caPemPath, writerHeaders, envelope);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.disposition, "duplicate");
    const conflictEnvelope = { ...envelope, row: { ...envelope.row, game_mode: "typing" } };
    const conflict = await runner.requestJson(`${first.baseUrl}/api/v1/records`, first.caPemPath, writerHeaders, conflictEnvelope);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
    const mismatch = await runner.requestJson(`${first.baseUrl}/api/v1/records`, first.caPemPath, { ...writerHeaders, "idempotency-key": "different-record-id" }, envelope);
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.body.code, "IDEMPOTENCY_KEY_MISMATCH");
    await new Promise<void>(resolve => first.server.close(() => resolve()));
    const second = await runner.startPersistentMock({ temporaryRoot: tempTwo, packageRoot: root, tokens });
    const get = await runner.requestJson(`${second.baseUrl}/api/v1/records?session_kind=official&session_id=r2-uat-official&day_no=1&round_no=1`, second.caPemPath, { authorization: `Bearer ${tokens.LEADERBOARD01}`, "x-device-id": "LEADERBOARD01" });
    assert.equal(get.status, 200);
    assert.equal((get.body.rows as Array<{ record_id: string }>).length, 1);
    await new Promise<void>(resolve => second.server.close(() => resolve()));
    runner.writeSample(root);
    assert.equal((JSON.parse(fs.readFileSync(path.join(root, "records", "sample", "leaderboard.json"), "utf8")).records as unknown[]).length, 12);
    assert.equal(runPackage(root, "--reset-records").status, 0);
    assert.equal(fs.existsSync(path.join(root, "records", "normal")), false);
    assert.equal(fs.existsSync(path.join(root, "records", "sample", "leaderboard.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(release, { recursive: true, force: true });
    fs.rmSync(tempOne, { recursive: true, force: true });
    fs.rmSync(tempTwo, { recursive: true, force: true });
  }
});

test("break: a paired UAT lease keeps one mock server alive until both applications release it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-lease-"));
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-release-input-"));
  try {
    makeRunnableRelease(release);
    buildPackage(root, release);
    const { MockApiLease } = require(path.join(root, "runtime", "uat-runner.js")) as {
      MockApiLease: new (root: string) => { acquire(): Promise<{ baseUrl: string }>; release(): Promise<void>; activeCount(): number };
    };
    const lease = new MockApiLease(root);
    const first = await lease.acquire();
    const second = await lease.acquire();
    assert.equal(first.baseUrl, second.baseUrl);
    assert.equal(lease.activeCount(), 2);
    const temporaryRoot = (lease as unknown as { temp: string }).temp;
    assert.equal(fs.existsSync(temporaryRoot), true);
    await lease.release();
    assert.equal(lease.activeCount(), 1);
    await lease.release();
    assert.equal(lease.activeCount(), 0);
    assert.equal(fs.existsSync(temporaryRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(release, { recursive: true, force: true });
  }
});

test("break: a mock lease removes its temporary root when startup fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-lease-failure-package-"));
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-lease-failure-release-"));
  try {
    makeRunnableRelease(release);
    buildPackage(root, release);
    let failedTemporaryRoot = "";
    const { MockApiLease } = require(path.join(root, "runtime", "uat-runner.js")) as {
      MockApiLease: new (packageRoot: string, starter?: (input: { temporaryRoot: string }) => Promise<never>) => { acquire(): Promise<unknown>; activeCount(): number };
    };
    const lease = new MockApiLease(root, async input => {
      failedTemporaryRoot = input.temporaryRoot;
      throw new Error("synthetic mock startup failure");
    });
    await assert.rejects(lease.acquire(), /synthetic mock startup failure/);
    assert.notEqual(failedTemporaryRoot, "");
    assert.equal(fs.existsSync(failedTemporaryRoot), false);
    assert.equal(lease.activeCount(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(release, { recursive: true, force: true });
  }
});

test("break: package validation rejects a junction root before following its files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-root-"));
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-release-input-"));
  const link = `${root}-junction`;
  try {
    makeRunnableRelease(release);
    buildPackage(root, release);
    fs.symlinkSync(root, link, "junction");
    const { validateRunnablePackage } = require(path.join(root, "runtime", "uat-runner.js")) as { validateRunnablePackage(value: string): void };
    assert.throws(() => validateRunnablePackage(link), /UAT 실행 파일 또는 리소스가 누락되었습니다|PACKAGE_REPARSE_POINT_REJECTED/);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(release, { recursive: true, force: true });
  }
});

test("break: a release-staged official pair actually spawns two child apps and cleans their shared mock session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-real-pair-"));
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-release-input-"));
  try {
    makeRunnableRelease(release);
    buildPackage(root, release);
    const result = runPackage(root, "--pair", "official");
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/\[UAT\] Starting:/g) ?? []).length, 2);
    assert.match(result.stdout, /R2_UAT_SESSION_CLEANUP=PASS/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(release, { recursive: true, force: true });
  }
});

test("break: sample mode launches only the leaderboard against a 12-record isolated fixture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-sample-launch-"));
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-release-input-"));
  try {
    makeRunnableRelease(release);
    buildPackage(root, release);
    const result = runPackage(root, "--sample-leaderboard");
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/\[UAT\] Starting:/g) ?? []).length, 1);
    assert.equal(fs.existsSync(path.join(root, "records", "normal")), false);
    assert.equal((JSON.parse(fs.readFileSync(path.join(root, "records", "sample", "leaderboard.json"), "utf8")).records as unknown[]).length, 12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(release, { recursive: true, force: true });
  }
});

test("break: an isolated device profile uses synthetic loopback credentials and rejects missing package files in Korean", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-profile-"));
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-release-input-"));
  try {
    makeRunnableRelease(release);
    buildPackage(root, release);
    const runner = require(path.join(root, "runtime", "uat-runner.js")) as {
      buildIsolatedChildEnvironment(input: { inherited: NodeJS.ProcessEnv; caseRoot: string; executablePath: string; caPemPath: string }): NodeJS.ProcessEnv;
      writeSyntheticProfile(input: { caseRoot: string; executableDirectory: string; app: { deviceId: string; role: string; sessionKind: string }; baseUrl: string; token: string }): { userDataPath: string };
      validateRunnablePackage(root: string): void;
    };
    const caseRoot = path.join(root, "scratch");
    const executableDirectory = path.join(caseRoot, "executable");
    const profile = runner.writeSyntheticProfile({ caseRoot, executableDirectory, app: { deviceId: "PC01", role: "player", sessionKind: "official" }, baseUrl: "https://127.0.0.1:14443", token: "a".repeat(43) });
    const environment = runner.buildIsolatedChildEnvironment({ inherited: { NODE_TLS_REJECT_UNAUTHORIZED: "0", API_BASE_URL: "https://production.invalid", PATH: process.env.PATH }, caseRoot, executablePath: path.join(executableDirectory, "synthetic.exe"), caPemPath: path.join(caseRoot, "ca.pem") });
    const device = JSON.parse(fs.readFileSync(path.join(executableDirectory, "device-profile.json"), "utf8"));
    assert.equal(device.apiBaseUrl, "https://127.0.0.1:14443");
    assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    assert.equal(environment.API_BASE_URL, undefined);
    assert.equal(environment.TYPINGKING_E2E_PROFILE, "functional-flow");
    assert.equal(profile.userDataPath.includes("electron-user-data"), true);
    fs.unlinkSync(path.join(root, "00_먼저읽어주세요.txt"));
    assert.throws(() => runner.validateRunnablePackage(root), /UAT 실행 파일 또는 리소스가 누락되었습니다|UAT 필수 파일이 누락되었습니다/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(release, { recursive: true, force: true });
  }
});
