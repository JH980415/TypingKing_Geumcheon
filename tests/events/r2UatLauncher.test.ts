import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(__dirname, "..", "..");
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const runner = path.join(projectRoot, "scripts", "r2-uat", "standalone-uat.ts");

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

test("break: generated common launcher must run its packaged runtime from a Korean staging path", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "AI 타자왕 R2 UAT "));
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "AI 타자왕 release input "));
  try {
    makeRunnableRelease(release);
    const generate = spawnSync(process.execPath, [tsxCli, runner, "--self-test", "--prepare-launchers", packageRoot, "--release-source", release], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(generate.status, 0, generate.stderr);
    const executed = spawnSync("cmd.exe", ["/d", "/c", path.join(packageRoot, "Run_R2_UAT.cmd"), "--self-test"], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(executed.status, 0, executed.stderr);
    assert.match(executed.stdout, /R2_UAT_SELF_TEST=PASS/);
    assert.match(executed.stdout, /TLS verification remains enabled/);
    assert.match(executed.stdout, /EXE files checked: 4/);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.rmSync(release, { recursive: true, force: true });
  }
});