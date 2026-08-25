import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type GeumcheonVariant = "ai" | "ai-leaderboard" | "practice" | "practice-leaderboard";

export type GeumcheonClientBuildSummary = {
  schemaVersion: 1;
  eventProfileId: "geumcheon-2026";
  checkedAt: string;
  artifacts: Array<{ variant: GeumcheonVariant; fileName: string; sha256: string; bytes: number }>;
  checks: {
    exactArtifactNames: true;
    profileIncluded: true;
    assetsIncluded: true;
    normalArtifactAbsent: true;
  };
};

const root = process.cwd();
const releaseDir = path.join(root, "release-geumcheon");
const sentinelName = ".typingking-geumcheon-client-release.json";
const expected = new Map<GeumcheonVariant, string>([
  ["ai", "G-Science AI 타자왕.exe"],
  ["ai-leaderboard", "G-Science AI 타자왕_리더보드.exe"],
  ["practice", "G-Science AI 타자왕_연습모드.exe"],
  ["practice-leaderboard", "G-Science AI 타자왕_연습모드_리더보드.exe"]
]);
const publicResources = [
  "events/geumcheon-2026/event.config.json",
  "events/geumcheon-2026/stage_texts.csv",
  "events/geumcheon-2026/assets/event-title.png",
  "events/geumcheon-2026/assets/key-visual.png",
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
];
const expectedRuntimeAiAssets = publicResources
  .filter((file) => file.startsWith("assets/"))
  .map((file) => file.slice("assets/".length))
  .sort();
const forbiddenPath = /(?:^|[\/_.-])(device|bootstrap|credential|token|pin|nas|record|queue|log|recovery|export|admin)(?:s|[\/_.-]|$)/i;

function fileList(dir: string, relative = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const nextRelative = path.posix.join(relative, entry.name);
    const nextPath = path.join(dir, entry.name);
    return entry.isDirectory() ? fileList(nextPath, nextRelative) : [nextRelative];
  });
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertPortableBuildOutputs(): void {
  for (const [variant, fileName] of expected) {
    const outputDir = path.join(root, "release-build", "geumcheon", variant);
    assert.equal(fs.existsSync(outputDir), true, `Missing ${variant} builder output`);
    const executables = fs.readdirSync(outputDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".exe")
      .map((entry) => entry.name);
    assert.deepEqual(executables, [fileName], `${variant} must contain exactly its approved portable EXE`);
    const runtimeAssetsDir = path.join(outputDir, "win-unpacked", "resources", "assets");
    assert.equal(fs.existsSync(runtimeAssetsDir), true, `${variant} is missing packaged runtime AI assets`);
    const runtimeAssets = fileList(runtimeAssetsDir).sort();
    assert.deepEqual(runtimeAssets, expectedRuntimeAiAssets, `${variant} packages an unexpected runtime asset`);
    for (const asset of runtimeAssets) {
      assert.ok(fs.statSync(path.join(runtimeAssetsDir, asset)).size > 0, `${variant} has a zero-byte runtime asset: ${asset}`);
    }
  }
}

function assertCredentialFreeHandoff(): void {
  assert.equal(fs.existsSync(releaseDir), true, "Missing credential-free release-geumcheon handoff");
  const expectedFiles = new Set([sentinelName, ...expected.values(), ...publicResources]);
  const actualFiles = fileList(releaseDir).sort();
  assert.deepEqual(actualFiles, [...expectedFiles].sort(), "Handoff contains an unexpected or missing file");
  for (const file of actualFiles) {
    if (file === sentinelName) continue;
    assert.equal(forbiddenPath.test(file), false, `Forbidden private artifact in handoff: ${file}`);
  }
  const executables = actualFiles.filter((file) => path.extname(file).toLowerCase() === ".exe").sort();
  assert.deepEqual(executables, [...expected.values()].sort(), "Handoff contains an unapproved executable");
  for (const resource of publicResources.filter((file) => /\.(png|csv|json)$/i.test(file))) {
    assert.ok(fs.statSync(path.join(releaseDir, resource)).size > 0, `Zero-byte public resource: ${resource}`);
  }
  const sentinel = JSON.parse(fs.readFileSync(path.join(releaseDir, sentinelName), "utf8")) as Record<string, unknown>;
  assert.deepEqual(sentinel, { schemaVersion: 1, kind: "typingking-geumcheon-client-release" }, "Invalid generated-output sentinel");
  const profile = JSON.parse(fs.readFileSync(path.join(releaseDir, "events/geumcheon-2026/event.config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(profile.profileId, "geumcheon-2026", "Handoff does not contain the Geumcheon event profile");
}

function writeSummary(): GeumcheonClientBuildSummary {
  const checkedAt = new Date().toISOString();
  const summary: GeumcheonClientBuildSummary = {
    schemaVersion: 1,
    eventProfileId: "geumcheon-2026",
    checkedAt,
    artifacts: [...expected].map(([variant, fileName]) => {
      const artifactPath = path.join(releaseDir, fileName);
      return { variant, fileName, sha256: sha256(artifactPath), bytes: fs.statSync(artifactPath).size };
    }),
    checks: { exactArtifactNames: true, profileIncluded: true, assetsIncluded: true, normalArtifactAbsent: true }
  };
  const summaryDir = path.join(root, "test_artifacts", "geumcheon-client");
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(path.join(summaryDir, "build-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

try {
  assertCredentialFreeHandoff();
  assertPortableBuildOutputs();
  const summary = writeSummary();
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
