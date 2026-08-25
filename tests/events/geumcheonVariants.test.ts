import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  recordModeFromPolicy,
  resolveApplicationResourcePaths,
  resolvePackagedMetadata
} from "../../electron/startupProfile";
import { createBootstrapData } from "../../shared/events/bootstrapData";
import { loadEventProfile, variantPolicyFor } from "../../shared/events/eventProfile";

const geumcheonProfile = loadEventProfile(
  path.resolve("events/geumcheon-2026/event.config.json")
);

const deviceProfile = {
  schemaVersion: 1,
  eventProfileId: "geumcheon-2026",
  eventId: "geumcheon-science-festival-2026",
  deviceId: "PC01",
  role: "player",
  apiBaseUrl: "https://records.example.test",
  sessions: {
    official: { sessionId: "day-1-round-1", dayNo: 1, roundNo: 1 },
    practice: { sessionId: "practice" }
  },
  requestTimeoutMs: 5000,
  retry: { initialDelayMs: 2000, maxDelayMs: 60000 }
} as const;

test("adds the validated Geumcheon profile policy and device to renderer bootstrap", () => {
  const bootstrap = createBootstrapData({
    config: {} as never,
    assetBaseUrl: "file:///assets",
    notices: [],
    mode: "game",
    variant: "ai",
    eventProfile: geumcheonProfile,
    deviceProfile
  });
  assert.equal(bootstrap.eventProfile.profileId, "geumcheon-2026");
  assert.equal(bootstrap.variantPolicy.variant, "ai");
  assert.equal(bootstrap.deviceProfile?.deviceId, "PC01");
});

for (const variant of ["ai", "ai-leaderboard", "practice", "practice-leaderboard"] as const) {
  test(`${variant} is enabled and AI-only`, () => {
    const policy = variantPolicyFor(geumcheonProfile, variant);
    assert.equal(policy.enabled, true);
    assert.deepEqual(policy.gameModes, ["ai_challenge"]);
  });
}

test("normal variants are disabled", () => {
  assert.equal(variantPolicyFor(geumcheonProfile, "typing").enabled, false);
  assert.equal(variantPolicyFor(geumcheonProfile, "typing-leaderboard").enabled, false);
});

for (const variant of ["ai", "practice"] as const) {
  test(`${variant} production record mode is AI challenge`, () => {
    assert.equal(recordModeFromPolicy(variantPolicyFor(geumcheonProfile, variant)), "ai_challenge");
  });
}

test("packaged SkillUp keeps executable-adjacent sidecar assets", () => {
  const executableDirectory = path.resolve("test_artifacts", "legacy-skillup-portable");
  const resourcesPath = path.resolve("test_artifacts", "electron-resources");
  const resources = resolveApplicationResourcePaths({
    isPackaged: true,
    projectRoot: executableDirectory,
    resourcesPath,
    eventProfileId: "skillup-2026",
    role: "player"
  });

  assert.equal(resources.resourceRoot, executableDirectory);
  assert.equal(
    resources.iconPath,
    path.join(executableDirectory, "assets", "icons", "typing_app_icon.ico")
  );
  assert.equal(
    resources.rendererAssetBaseUrl,
    pathToFileURL(path.join(executableDirectory, "assets")).toString()
  );
});

test("packaged Geumcheon launch resolves profiles and assets from resourcesPath", () => {
  const executableDirectory = path.resolve("test_artifacts", "portable-exe");
  const resourcesPath = path.resolve();
  const metadata = resolvePackagedMetadata({
    typingKingEventProfile: "geumcheon-2026",
    typingKingVariant: "practice-leaderboard"
  });
  const resources = resolveApplicationResourcePaths({
    isPackaged: true,
    projectRoot: executableDirectory,
    resourcesPath,
    eventProfileId: metadata.eventProfileId!,
    role: "leaderboard"
  });

  assert.equal(metadata.variant, "practice-leaderboard");
  assert.equal(resources.resourceRoot, resourcesPath);
  assert.notEqual(resources.resourceRoot, executableDirectory);
  assert.equal(
    resources.eventProfilePath,
    path.join(resourcesPath, "events", "geumcheon-2026", "event.config.json")
  );
  assert.equal(
    resources.iconPath,
    path.join(resourcesPath, "assets", "icons", "leaderboard_app_icon.ico")
  );
  assert.equal(
    resources.rendererAssetBaseUrl,
    pathToFileURL(path.join(resourcesPath, "assets")).toString()
  );

  const profile = loadEventProfile(resources.eventProfilePath);
  const policy = variantPolicyFor(profile, metadata.variant!);
  assert.equal(policy.windowTitle, "G-Science AI 타자왕 연습모드 리더보드");
  assert.deepEqual(policy.gameModes, ["ai_challenge"]);
});
