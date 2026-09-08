import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("repeated NAS client packaging preserves every prior ZIP under unique hash-specific names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r6-client-package-"));
  try {
    fs.mkdirSync(path.join(root, "release-geumcheon", "events"), { recursive: true });
    fs.mkdirSync(path.join(root, "Codex", "Outputs", "R6_v2"), { recursive: true });
    fs.writeFileSync(path.join(root, "release-geumcheon", "app.exe"), "synthetic-exe");
    fs.writeFileSync(path.join(root, "release-geumcheon", "events", "event.config.json"), "{}");
    const output = path.join(root, "Codex", "Outputs", "R6_v2", "R6_NAS_CLIENT_RELEASE.zip");
    fs.writeFileSync(output, "first-old-archive");

    runPackager(root);
    fs.writeFileSync(path.join(root, "release-geumcheon", "app.exe"), "synthetic-exe-v2");
    runPackager(root);

    const preservedDir = path.join(root, "Codex", "Artifacts", "R6_v2", "Superseded_Packaging");
    const preserved = fs.readdirSync(preservedDir).sort();
    assert.equal(preserved.length, 2);
    assert.ok(preserved.every((name) => /^R6_NAS_CLIENT_RELEASE_superseded_[0-9a-f]{12}(?:_\d+)?\.zip$/.test(name)));
    assert.equal(new Set(preserved).size, 2);
    assert.ok(preserved.some((name) => fs.readFileSync(path.join(preservedDir, name), "utf8") === "first-old-archive"));
    assert.ok(fs.statSync(output).size > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runPackager(projectRoot) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.resolve("scripts/package-r6-nas-client-release.ps1"),
    "-ProjectRoot", projectRoot,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
