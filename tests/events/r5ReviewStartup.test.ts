import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatStartupErrorForDisplay, resolveLaunchPolicy, resolvePackagedMetadata, resolveStartupProfile } from "../../electron/startupProfile";

const reviewPackage = {
  typingKingEnvironment: "review",
  typingKingBuildId: "R2.0.4-R5",
  typingKingEventProfile: "geumcheon-2026",
  typingKingVariant: "ai",
};

test("recognizes only the exact builder-stamped review tuple", () => {
  const metadata = resolvePackagedMetadata(reviewPackage);
  assert.deepEqual(metadata.reviewContext, {
    environment: "review", profileId: "geumcheon-2026", eventId: "geumcheon-science-festival-2026-review",
    buildId: "R2.0.4-R5", deviceId: "review-ai", role: "player", sessionKind: "official", storageKind: "local",
  });
  assert.equal(metadata.variant, "ai");
  assert.equal(metadata.eventProfileId, "geumcheon-2026");
});

test("fails closed for incomplete, mismatched, and unsupported review metadata", () => {
  for (const value of [
    { ...reviewPackage, typingKingBuildId: "R2.0.4" },
    { ...reviewPackage, typingKingEnvironment: "production" },
    { ...reviewPackage, typingKingEventProfile: "skillup-2026" },
    { ...reviewPackage, typingKingVariant: "typing" },
    { typingKingEnvironment: "review" },
  ]) assert.throws(() => resolvePackagedMetadata(value), /PACKAGED_REVIEW_METADATA_REJECTED/);
});

test("starts a packaged review variant without an adjacent device profile", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r5-review-startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventRoot = path.join(root, "events", "geumcheon-2026");
  const localAppData = path.join(root, "LocalAppData");
  fs.mkdirSync(eventRoot, { recursive: true });
  fs.copyFileSync(path.resolve("events/geumcheon-2026/event.config.json"), path.join(eventRoot, "event.config.json"));
  fs.copyFileSync(path.resolve("events/geumcheon-2026/stage_texts.csv"), path.join(eventRoot, "stage_texts.csv"));
  const metadata = resolvePackagedMetadata(reviewPackage);
  const startup = resolveStartupProfile({
    isPackaged: true, projectRoot: root, executableDirectory: path.join(root, "no-device-profile-here"),
    localAppData, packagedEventProfile: metadata.eventProfileId, reviewContext: metadata.reviewContext,
  });
  const reviewBase = path.join(localAppData, "ThePMD", "TypingKing", "Geumcheon2026", "Review");
  assert.equal(startup.deviceProfile, undefined);
  assert.equal(startup.runtimeRoot, path.join(reviewBase, "official"));
  assert.equal(startup.userDataPath, path.join(reviewBase, "userData-ai"));
  assert.deepEqual(startup.reviewContext, metadata.reviewContext);
  assert.deepEqual(resolveLaunchPolicy(startup, "ai"), { pcRole: "player" });
  assert.equal(fs.existsSync(path.join(startup.runtimeRoot, "data", "stage_texts.csv")), true);
});

test("keeps official and practice review storage shared only by matching game and leaderboard variants", () => {
  const variants = ["ai", "ai-leaderboard", "practice", "practice-leaderboard"] as const;
  const paths = variants.map((typingKingVariant) => {
    const metadata = resolvePackagedMetadata({ ...reviewPackage, typingKingVariant });
    const startup = resolveStartupProfile({
      isPackaged: false, projectRoot: path.resolve(), executableDirectory: path.resolve("missing-device-profile"),
      localAppData: "C:\\Local", reviewContext: metadata.reviewContext,
    });
    return { variant: typingKingVariant, runtimeRoot: startup.runtimeRoot, userDataPath: startup.userDataPath };
  });
  assert.equal(paths[0].runtimeRoot, paths[1].runtimeRoot);
  assert.equal(paths[2].runtimeRoot, paths[3].runtimeRoot);
  assert.notEqual(paths[0].runtimeRoot, paths[2].runtimeRoot);
  assert.equal(new Set(paths.map((entry) => entry.userDataPath)).size, 4);
});

test("preserves an outdated review catalog and gives a safe update instruction instead of silently falling back", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-r6-catalog-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventRoot = path.join(root, "events", "geumcheon-2026");
  const localAppData = path.join(root, "LocalAppData");
  fs.mkdirSync(eventRoot, { recursive: true });
  for (const name of ["event.config.json", "stage_texts.csv"]) {
    fs.copyFileSync(path.resolve("events/geumcheon-2026", name), path.join(eventRoot, name));
  }
  const target = path.join(localAppData, "ThePMD", "TypingKing", "Geumcheon2026", "Review", "official", "data", "stage_texts.csv");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const outdated = fs.readFileSync(path.join(eventRoot, "stage_texts.csv"), "utf8").replaceAll("geumcheon-r5-20260903-v1", "obsolete-test-catalog");
  fs.writeFileSync(target, outdated);
  const metadata = resolvePackagedMetadata(reviewPackage);
  let caught: unknown;
  try {
    resolveStartupProfile({
      isPackaged: true, projectRoot: root, executableDirectory: path.join(root, "portable"),
      localAppData, packagedEventProfile: metadata.eventProfileId, reviewContext: metadata.reviewContext,
    });
  } catch (error) { caught = error; }
  assert.ok(caught instanceof Error, "outdated catalog must block startup");
  assert.equal(fs.readFileSync(target, "utf8"), outdated, "existing data must not be overwritten");
  const message = formatStartupErrorForDisplay(caught);
  assert.match(message, /문구 파일.*업데이트/);
  assert.doesNotMatch(message, /obsolete-test-catalog|LocalAppData|typingking-r6-catalog-update/);
  assert.doesNotMatch(formatStartupErrorForDisplay(new Error("unknown-private-detail")), /unknown-private-detail/);
});
