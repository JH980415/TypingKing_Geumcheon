import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(__dirname, "..", "..");
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const runner = path.join(projectRoot, "scripts", "r2-uat", "standalone-uat.ts");

function runUat(...args: string[]) {
  return spawnSync(process.execPath, [tsxCli, runner, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true
  });
}

test("break: split and equals app syntax must select the same isolated AI player plan", () => {
  for (const args of [["--self-test", "--app", "ai"], ["--self-test", "--app=ai"]]) {
    const result = runUat(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      mode: "self-test",
      selection: ["ai"]
    });
  }
});

test("break: launcher preparation creates the exact Korean one-click file set", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-launchers-"));
  try {
    const result = runUat("--prepare-launchers", root);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(root).sort(), [
      "00_먼저읽어주세요.txt",
      "01_AI타자왕_테스트실행.cmd",
      "02_AI타자왕_리더보드_테스트실행.cmd",
      "03_AI타자왕_연습모드_테스트실행.cmd",
      "04_연습모드_리더보드_테스트실행.cmd",
      "05_전체_순차테스트.cmd",
      "06_공식모드_플레이어+리더보드_동시테스트.cmd",
      "07_연습모드_플레이어+리더보드_동시테스트.cmd",
      "08_샘플데이터_리더보드_화면검수.cmd",
      "09_UAT기록_초기화.cmd",
      "EXE_직접실행금지_UAT안내.txt",
      "Run_R2_UAT.cmd",
      "runtime"
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("break: sample leaderboard records stay isolated from resettable normal official and practice records", () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-uat-store-"));
  try {
    const sample = runUat("--sample-leaderboard", "--storage-root", storageRoot);
    assert.equal(sample.status, 0, sample.stderr);
    const normal = path.join(storageRoot, "normal");
    const sampleStore = path.join(storageRoot, "sample");
    assert.equal(fs.existsSync(path.join(sampleStore, "leaderboard.json")), true);
    assert.equal(fs.existsSync(path.join(normal, "official.json")), false);
    assert.equal(fs.existsSync(path.join(normal, "practice.json")), false);

    const reset = runUat("--reset-records", "--storage-root", storageRoot);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(fs.existsSync(path.join(sampleStore, "leaderboard.json")), true);
    assert.equal(fs.existsSync(normal), false);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});
