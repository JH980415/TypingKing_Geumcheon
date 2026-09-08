import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareNasProductionDelivery } from "../../scripts/prepare-nas-production-delivery.mjs";

test("prepares five fail-closed production profiles and a server bundle without secrets", () => {
  const fixture = fakeProject();
  const outputRoot = path.join(fixture.root, "Codex", "Artifacts", "R6_v2", "nas-production-delivery");
  try {
    const result = prepareNasProductionDelivery({ projectRoot: fixture.root, outputRoot });
    assert.deepEqual(result.profileFiles, [
      "leaderboard_01.device-profile.json",
      "player_01.device-profile.json",
      "player_02.device-profile.json",
      "player_03.device-profile.json",
      "player_04.device-profile.json",
    ]);

    const profiles = result.profileFiles.map((name) =>
      JSON.parse(fs.readFileSync(path.join(outputRoot, "device-profiles", name), "utf8")),
    );
    assert.deepEqual(profiles.map((profile) => profile.deviceId), ["LEADERBOARD01", "PC01", "PC02", "PC03", "PC04"]);
    assert.equal(new Set(profiles.map((profile) => profile.deviceId)).size, 5);
    assert.deepEqual(profiles.map((profile) => profile.role), ["leaderboard", "player", "player", "player", "player"]);
    for (const profile of profiles) {
      assert.equal(profile.eventProfileId, "geumcheon-2026");
      assert.equal(profile.eventId, "geumcheon-science-festival-2026");
      assert.equal(profile.apiBaseUrl, "__NAS_RECORD_API_URL__");
      assert.equal(profile.sessions.official.sessionId, "__OFFICIAL_SESSION_ID__");
      assert.equal(profile.sessions.practice.sessionId, "__PRACTICE_SESSION_ID__");
      assert.equal(profile.sessions.official.dayNo, "__OFFICIAL_DAY_NO__");
      assert.equal(profile.sessions.official.roundNo, "__OFFICIAL_ROUND_NO__");
    }

    const map = JSON.parse(fs.readFileSync(path.join(outputRoot, "deployment-map.json"), "utf8"));
    assert.deepEqual(map.devices.map(({ profileFile, deviceId, role, variant, environment }) => ({ profileFile, deviceId, role, variant, environment })), [
      { profileFile: "leaderboard_01.device-profile.json", deviceId: "LEADERBOARD01", role: "leaderboard", variant: "ai-leaderboard", environment: "production" },
      { profileFile: "player_01.device-profile.json", deviceId: "PC01", role: "player", variant: "ai", environment: "production" },
      { profileFile: "player_02.device-profile.json", deviceId: "PC02", role: "player", variant: "ai", environment: "production" },
      { profileFile: "player_03.device-profile.json", deviceId: "PC03", role: "player", variant: "ai", environment: "production" },
      { profileFile: "player_04.device-profile.json", deviceId: "PC04", role: "player", variant: "ai", environment: "production" },
    ]);

    const allText = walkFiles(outputRoot).map((file) => fs.readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(allText, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
    assert.doesNotMatch(allText, /"token"\s*:\s*"(?!__)[^"]+"/);
    assert.equal(fs.existsSync(path.join(outputRoot, "server", "services", "nas-record-api", "src", "cli.ts")), true);
    assert.equal(fs.existsSync(path.join(outputRoot, "server", "shared", "nas", "protocol.ts")), true);
    assert.equal(fs.existsSync(path.join(outputRoot, "server", "services", "nas-record-api", "package-lock.json")), true);
    const builtServer = path.join(outputRoot, "server", "services", "nas-record-api", "dist", "server.cjs");
    assert.equal(fs.existsSync(builtServer), true);
    assert.ok(fs.statSync(builtServer).size > 50_000);
    const manifestLines = fs.readFileSync(path.join(outputRoot, "MANIFEST_SHA256.txt"), "utf8").trim().split(/\r?\n/);
    assert.ok(manifestLines.length > 10);
    for (const line of manifestLines) {
      const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
      assert.ok(match, `invalid manifest line: ${line}`);
      const file = path.join(outputRoot, ...match[2].split("/"));
      assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), match[1]);
    }
  } finally {
    fixture.cleanup();
  }
});

test("rejects destructive output targets before changing source or external content", () => {
  for (const target of ["root", "deployment", "services", "outside", "nonempty", "symlink"]) {
    const fixture = fakeProject();
    try {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r6-outside-"));
      fs.writeFileSync(path.join(outside, "preserve.txt"), "outside-preserved");
      let outputRoot;
      if (target === "root") outputRoot = fixture.root;
      else if (target === "deployment") outputRoot = path.join(fixture.root, "deployment");
      else if (target === "services") outputRoot = path.join(fixture.root, "services");
      else if (target === "outside") outputRoot = outside;
      else {
        outputRoot = path.join(fixture.root, "Codex", "Artifacts", "R6_v2", "nas-production-delivery");
        fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
        if (target === "nonempty") {
          fs.mkdirSync(outputRoot);
          fs.writeFileSync(path.join(outputRoot, "preserve.txt"), "unowned-preserved");
        } else {
          fs.symlinkSync(outside, outputRoot, "junction");
        }
      }

      assert.throws(() => prepareNasProductionDelivery({ projectRoot: fixture.root, outputRoot }), /OUTPUT_PATH_UNSAFE|OUTPUT_NOT_OWNED/);
      assert.equal(fs.readFileSync(path.join(fixture.root, "deployment", "nas-production", "README_NAS_PROVISIONING.md"), "utf8").length > 0, true);
      assert.equal(fs.existsSync(path.join(fixture.root, "services", "nas-record-api", "src", "cli.ts")), true);
      assert.equal(fs.readFileSync(path.join(outside, "preserve.txt"), "utf8"), "outside-preserved");
      if (target === "nonempty") assert.equal(fs.readFileSync(path.join(outputRoot, "preserve.txt"), "utf8"), "unowned-preserved");
      fs.rmSync(outside, { recursive: true, force: true });
    } finally {
      fixture.cleanup();
    }
  }
});

function fakeProject() {
  const realRoot = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r6-project-"));
  fs.cpSync(path.join(realRoot, "deployment", "nas-production"), path.join(root, "deployment", "nas-production"), { recursive: true });
  fs.cpSync(path.join(realRoot, "services", "nas-record-api", "src"), path.join(root, "services", "nas-record-api", "src"), { recursive: true });
  fs.cpSync(path.join(realRoot, "services", "nas-record-api", "dist"), path.join(root, "services", "nas-record-api", "dist"), { recursive: true });
  fs.cpSync(path.join(realRoot, "shared"), path.join(root, "shared"), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) {
    fs.copyFileSync(path.join(realRoot, "services", "nas-record-api", name), path.join(root, "services", "nas-record-api", name));
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function walkFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}
