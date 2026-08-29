import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const defaultReleaseDir = path.join(root, "release-geumcheon");
const sentinelName = ".typingking-geumcheon-client-release.json";
const sentinel = { schemaVersion: 1, kind: "typingking-geumcheon-client-release" };
const expected = new Map([
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
  "events/geumcheon-2026/assets/bg_leaderboard_03_typing_hall_of_fame.png",
  "events/geumcheon-2026/assets/bg_main_03_geumcheon_data_city.png",
  "events/geumcheon-2026/assets/robot_03_speed_champion.png",
  "events/geumcheon-2026/assets/robot_04_science_lab.png",
  "events/geumcheon-2026/assets/robot_05_festival_victory.png",
  "events/geumcheon-2026/assets/robot_defeat_01_geumnarae_typer.png",
  "events/geumcheon-2026/assets/stage_01_03_science_classroom.png",
  "events/geumcheon-2026/assets/title_04_science_hologram.png",
  "events/geumcheon-2026/assets/vs_03_science_portal.png",
  "events/geumcheon-2026/assets/ai_challenge/stage_badge_1.png",
  "events/geumcheon-2026/assets/ai_challenge/stage_badge_2.png",
  "events/geumcheon-2026/assets/ai_challenge/stage_badge_3.png",
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

function exists(target) {
  return fs.existsSync(target);
}

function fileList(dir, relative = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const nextRelative = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? fileList(path.join(dir, entry.name), nextRelative) : [nextRelative];
  });
}

function resolveR2ReleaseRoot(override) {
  const releaseRoot = path.resolve(root, "Codex", "Outputs", "R2", "01_Release");
  const resolved = path.resolve(root, override.trim());
  if (resolved === releaseRoot) throw new Error("R2 release output must be a child directory");
  if (!resolved.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error("Refusing R2 release root outside Codex/Outputs/R2/01_Release");
  }
  if (path.dirname(resolved) !== releaseRoot) {
    throw new Error("R2 release root must be a direct child of Codex/Outputs/R2/01_Release");
  }
  return resolved;
}

function parseArgs(args) {
  let allowReplace = false;
  let releaseDir = defaultReleaseDir;
  for (const arg of args) {
    if (arg === "--replace") {
      allowReplace = true;
      continue;
    }
    if (arg.startsWith("--output-root=")) {
      const value = arg.slice("--output-root=".length);
      if (!value.trim()) throw new Error("--output-root requires a path");
      releaseDir = resolveR2ReleaseRoot(value);
      continue;
    }
    throw new Error("Usage: node scripts/prepare-geumcheon-client-release.mjs [--replace] [--output-root=Codex/Outputs/R2/01_Release/<directory>]");
  }
  return { allowReplace, releaseDir };
}

function ensureSafeSource(sourcePath) {
  if (!exists(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error(`Missing required public source: ${sourcePath}`);
  if (fs.statSync(sourcePath).size === 0) throw new Error(`Zero-byte source is not allowed: ${sourcePath}`);
}

function copyFile(sourcePath, targetPath) {
  ensureSafeSource(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function assertExactPortableOutput(variant, fileName) {
  const outputDir = path.join(root, "release-build", "geumcheon", variant);
  if (!exists(outputDir)) throw new Error(`Missing ${variant} builder output`);
  const executables = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".exe")
    .map((entry) => entry.name);
  if (executables.length !== 1 || executables[0] !== fileName) {
    throw new Error(`${variant} builder output must contain exactly ${fileName}`);
  }
  return path.join(outputDir, fileName);
}

function assertGeneratedOutput(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("release output must be a real generated directory");
  const sentinelPath = path.join(target, sentinelName);
  if (!exists(sentinelPath)) throw new Error("Refusing to replace release output without its generated-output sentinel");
  const value = JSON.parse(fs.readFileSync(sentinelPath, "utf8"));
  if (JSON.stringify(value) !== JSON.stringify(sentinel)) throw new Error("Refusing to replace release output with an invalid generated-output sentinel");
}

function assertStagedTree(stageDir) {
  const expectedFiles = new Set([sentinelName, ...expected.values(), ...publicResources]);
  const actualFiles = fileList(stageDir).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
    throw new Error("Staged handoff contains an unexpected or missing file");
  }
  const profilePath = path.join(stageDir, "events/geumcheon-2026/event.config.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  if (profile.profileId !== "geumcheon-2026") throw new Error("Staged handoff has the wrong event profile");
}

function stageRelease(stageDir) {
  fs.mkdirSync(stageDir, { recursive: false });
  fs.writeFileSync(path.join(stageDir, sentinelName), `${JSON.stringify(sentinel)}\n`, "utf8");
  for (const [variant, fileName] of expected) {
    copyFile(assertExactPortableOutput(variant, fileName), path.join(stageDir, fileName));
  }
  for (const resource of publicResources) {
    copyFile(path.join(root, resource), path.join(stageDir, resource));
  }
  assertStagedTree(stageDir);
}

function backupPathFor(target) {
  if (path.resolve(target) === path.resolve(defaultReleaseDir)) {
    return path.join(root, `.release-geumcheon.previous-${crypto.randomUUID()}`);
  }
  return path.join(path.dirname(target), `.${path.basename(target)}.previous-${crypto.randomUUID()}`);
}

function replaceAtomically(stageDir, releaseDir, allowReplace) {
  fs.mkdirSync(path.dirname(releaseDir), { recursive: true });
  if (!exists(releaseDir)) {
    fs.renameSync(stageDir, releaseDir);
    return;
  }
  if (!allowReplace) throw new Error(`${path.relative(root, releaseDir)} already exists; rerun with --replace only for generated output`);
  assertGeneratedOutput(releaseDir);
  const backupDir = backupPathFor(releaseDir);
  fs.renameSync(releaseDir, backupDir);
  try {
    fs.renameSync(stageDir, releaseDir);
  } catch (error) {
    fs.renameSync(backupDir, releaseDir);
    throw error;
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
}

const { allowReplace, releaseDir } = parseArgs(process.argv.slice(2));
const stageDir = path.join(root, `.geumcheon-client-release.staging-${crypto.randomUUID()}`);
try {
  stageRelease(stageDir);
  replaceAtomically(stageDir, releaseDir, allowReplace);
  console.log(`Credential-free Geumcheon client release assembled: ${path.relative(root, releaseDir)}`);
} finally {
  if (exists(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
}