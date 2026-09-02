import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const geumcheonArtifacts = [
  ["ai", "G-Science AI 타자왕.exe"],
  ["ai-leaderboard", "G-Science AI 타자왕 리더보드.exe"],
  ["practice", "G-Science AI 타자왕 연습모드.exe"],
  ["practice-leaderboard", "G-Science AI 타자왕 연습모드 리더보드.exe"]
] as const;

const publicResources = [
  "events/geumcheon-2026/event.config.json",
  "events/geumcheon-2026/stage_texts.csv",
  "events/geumcheon-2026/assets/event-title.png",
  "events/geumcheon-2026/assets/key-visual.png",
  "events/geumcheon-2026/assets/bg_leaderboard_03_typing_hall_of_fame.png",
  "events/geumcheon-2026/assets/bg_main_03_geumcheon_data_city.png",
  "events/geumcheon-2026/assets/robot_03_speed_champion.png",
  "events/geumcheon-2026/assets/robot_04_science_lab.png",
  "events/geumcheon-2026/assets/robot_05_festival_victory.png",
  "events/geumcheon-2026/assets/robot_defeat_01_geumnarae_typer.png",
  "events/geumcheon-2026/assets/stage_01_03_science_classroom.png",
  "events/geumcheon-2026/assets/ai_타자왕_금나래의_도전.png",
  "events/geumcheon-2026/assets/vs_03_science_portal.png",
  "events/geumcheon-2026/assets/ai_challenge/stage_badge_1_r203.png",
  "events/geumcheon-2026/assets/ai_challenge/stage_badge_2_r203.png",
  "events/geumcheon-2026/assets/ai_challenge/stage_badge_3_r203.png",
  "assets/ai_challenge/ai_boss_typing.png",
  "assets/ai_challenge/ai_boss_victory.png",
  "assets/ai_challenge/ai_boss_defeat.png",
  "assets/ai_challenge/vs_badge.png",
  "assets/ai_challenge/stage_badge_1.png",
  "assets/ai_challenge/stage_badge_2.png",
  "assets/ai_challenge/stage_badge_3.png",
  "assets/ai_challenge/ai_title_compact.png",
  "assets/ai_challenge/ai_title_oneline_trimmed.png",
  "assets/ai_challenge/ai_challenge_title.png"
] as const;

function writeFixtureFile(root: string, relativePath: string, content = "fixture"): void {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function stageFixtureProject(root: string): void {
  for (const [variant, fileName] of geumcheonArtifacts) {
    writeFixtureFile(root, `release-build/geumcheon/${variant}/${fileName}`, `${variant} executable`);
  }
  for (const resource of publicResources) {
    writeFixtureFile(
      root,
      resource,
      resource.endsWith("event.config.json") ? `${JSON.stringify({ profileId: "geumcheon-2026" })}\n` : "public fixture"
    );
  }
}

test("prepares an R2 release override without replacing release-geumcheon", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-release-output-"));
  try {
    stageFixtureProject(fixtureRoot);
    writeFixtureFile(
      fixtureRoot,
      "release-geumcheon/.typingking-geumcheon-client-release.json",
      `${JSON.stringify({ schemaVersion: 1, kind: "typingking-geumcheon-client-release" })}\n`
    );
    writeFixtureFile(fixtureRoot, "release-geumcheon/preexisting.txt", "keep me");

    const outputRoot = "Codex/Outputs/R2/01_Release/geumcheon-client-release";
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/prepare-geumcheon-client-release.mjs"), `--output-root=${outputRoot}`],
      { cwd: fixtureRoot, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.equal(fs.readFileSync(path.join(fixtureRoot, "release-geumcheon", "preexisting.txt"), "utf8"), "keep me");
    assert.equal(
      fs.existsSync(path.join(fixtureRoot, outputRoot, ".typingking-geumcheon-client-release.json")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(fixtureRoot, outputRoot, "G-Science AI 타자왕.exe")),
      true
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("rejects nested R2 release output paths before staging files", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r2-release-path-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/prepare-geumcheon-client-release.mjs"),
        "--output-root=Codex/Outputs/R2/01_Release/nested/release"
      ],
      { cwd: fixtureRoot, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /direct child/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
