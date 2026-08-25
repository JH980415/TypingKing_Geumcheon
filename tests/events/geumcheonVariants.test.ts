import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  recordModeFromPolicy,
  resolveApplicationResourcePaths,
  resolvePackagedMetadata
} from "../../electron/startupProfile";
import { createBootstrapData, mergeRuntimeConfigWithEventProfile } from "../../shared/events/bootstrapData";
import { DEFAULT_CONFIG } from "../../shared/constants/defaults";
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

for (const [variant, sessionKind] of [["ai", "official"], ["practice", "practice"]] as const) {
  test(`Geumcheon ${sessionKind} runtime refresh keeps profile-owned settings`, () => {
    const bootstrap = createBootstrapData({
      config: DEFAULT_CONFIG,
      assetBaseUrl: "file:///assets",
      notices: [],
      mode: "game",
      variant,
      eventProfile: geumcheonProfile
    });
    const runtimeRefresh = {
      ...DEFAULT_CONFIG,
      eventName: "raw runtime event name",
      theme: { ...DEFAULT_CONFIG.theme, primaryColor: "#000000" },
      aiChallenge: DEFAULT_CONFIG.aiChallenge,
      oneDriveRoot: "C:/temporary/onedrive",
      recordBaseFolderName: "FreshRecords",
      dayNo: 2,
      roundNo: 3
    };

    const refreshed = mergeRuntimeConfigWithEventProfile(runtimeRefresh, bootstrap.eventProfile, sessionKind);

    assert.equal(refreshed.eventName, geumcheonProfile.eventName);
    assert.deepEqual(refreshed.theme, geumcheonProfile.theme);
    assert.deepEqual(refreshed.aiChallenge, geumcheonProfile.aiChallenge[sessionKind]);
    assert.equal(refreshed.oneDriveRoot, runtimeRefresh.oneDriveRoot);
    assert.equal(refreshed.recordBaseFolderName, runtimeRefresh.recordBaseFolderName);
    assert.equal(refreshed.dayNo, runtimeRefresh.dayNo);
    assert.equal(refreshed.roundNo, runtimeRefresh.roundNo);
  });
}

test("SkillUp runtime refresh remains raw settings", () => {
  const skillupProfile = loadEventProfile(path.resolve("events/skillup-2026/event.config.json"));
  const runtimeRefresh = {
    ...DEFAULT_CONFIG,
    eventName: "runtime SkillUp name",
    theme: { ...DEFAULT_CONFIG.theme, primaryColor: "#123456" },
    oneDriveRoot: "C:/temporary/skillup",
    dayNo: 4,
    roundNo: 5
  };

  assert.deepEqual(mergeRuntimeConfigWithEventProfile(runtimeRefresh, skillupProfile, "official"), runtimeRefresh);
});

const geumcheonArtifacts = [
  ["ai", "G-Science AI 타자왕.exe"],
  ["ai-leaderboard", "G-Science AI 타자왕_리더보드.exe"],
  ["practice", "G-Science AI 타자왕_연습모드.exe"],
  ["practice-leaderboard", "G-Science AI 타자왕_연습모드_리더보드.exe"]
] as const;
const approvedEventResources = [
  "event.config.json",
  "stage_texts.csv",
  "assets/event-title.png",
  "assets/key-visual.png"
];
const approvedAiAssets = [
  "ai_boss_typing.png",
  "ai_boss_victory.png",
  "ai_boss_defeat.png",
  "vs_badge.png",
  "stage_badge_1.png",
  "stage_badge_2.png",
  "stage_badge_3.png",
  "ai_title_compact.png",
  "ai_title_oneline_trimmed.png",
  "ai_challenge_title.png"
];

function writeFixtureFile(root: string, relativePath: string, content = "fixture"): void {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createClientBuildGateFixture(root: string, unexpectedResource: string): void {
  writeFixtureFile(
    root,
    "release-geumcheon/.typingking-geumcheon-client-release.json",
    `${JSON.stringify({ schemaVersion: 1, kind: "typingking-geumcheon-client-release" })}\n`
  );
  for (const [, fileName] of geumcheonArtifacts) {
    writeFixtureFile(root, `release-geumcheon/${fileName}`);
  }
  for (const resource of approvedEventResources) {
    const content = resource === "event.config.json"
      ? `${JSON.stringify({ profileId: "geumcheon-2026" })}\n`
      : "public fixture";
    writeFixtureFile(root, `release-geumcheon/events/geumcheon-2026/${resource}`, content);
  }
  for (const asset of approvedAiAssets) {
    writeFixtureFile(root, `release-geumcheon/assets/ai_challenge/${asset}`);
  }

  for (const [variant, fileName] of geumcheonArtifacts) {
    const outputRoot = `release-build/geumcheon/${variant}`;
    writeFixtureFile(root, `${outputRoot}/${fileName}`);
    for (const asset of approvedAiAssets) {
      writeFixtureFile(root, `${outputRoot}/win-unpacked/resources/assets/ai_challenge/${asset}`);
    }
    for (const resource of approvedEventResources) {
      writeFixtureFile(root, `${outputRoot}/win-unpacked/resources/events/geumcheon-2026/${resource}`);
    }
    writeFixtureFile(
      root,
      `${outputRoot}/win-unpacked/resources/events/geumcheon-2026/${unexpectedResource}`,
      "fixture-secret-token"
    );
  }
}

test("client build gate rejects an unexpected secret-bearing packaged event resource", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-client-gate-"));
  try {
    createClientBuildGateFixture(fixtureRoot, "private/device-token.log");
    const result = spawnSync(
      process.execPath,
      [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/geumcheon-client-build-check.ts")],
      { cwd: fixtureRoot, encoding: "utf8" }
    );

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /device-token\.log|unexpected event resource/i);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("PII scanner inspects executables for supplied secret needles", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-pii-exe-"));
  const secret = "client-security-secret-20260826";
  try {
    const executable = path.join(fixtureRoot, "fixture.exe");
    fs.writeFileSync(executable, Buffer.from(`binary-prefix\0${secret}\0binary-suffix`, "utf8"));
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/scan-pii.mjs"), "--target", executable],
      {
        cwd: path.resolve(),
        encoding: "utf8",
        env: { ...process.env, TYPINGKING_PII_NEEDLES: secret }
      }
    );

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
