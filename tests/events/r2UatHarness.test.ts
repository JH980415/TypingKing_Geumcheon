import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("break: a missing standalone runner cannot complete the observable self-test contract", () => {
  const result = runUat("--self-test");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    mode: "self-test"
  });
});
