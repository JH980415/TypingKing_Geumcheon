import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import * as startupProfileModule from "../../electron/startupProfile";
import { loadEventProfile } from "../../shared/events/eventProfile";
import {
  resolveDeviceRuntimeRoot,
  resolveLaunchPolicy,
  resolveStartupProfile,
  type StartupProfile
} from "../../electron/startupProfile";

const geumcheonEventProfile = loadEventProfile(path.resolve("events/geumcheon-2026/event.config.json"));

function geumcheonStartup(role: "player" | "leaderboard"): StartupProfile {
  const deviceId = role === "player" ? "PC01" : "LEADERBOARD01";
  return {
    eventProfile: geumcheonEventProfile,
    deviceProfile: {
      schemaVersion: 1,
      eventProfileId: "geumcheon-2026",
      eventId: "geumcheon-science-festival-2026",
      deviceId,
      role,
      apiBaseUrl: "https://records.example.test",
      sessions: {
        official: { sessionId: "day-1-round-1", dayNo: 1, roundNo: 1 },
        practice: { sessionId: "practice" }
      },
      requestTimeoutMs: 5000,
      retry: { initialDelayMs: 2000, maxDelayMs: 60000 }
    },
    runtimeRoot: path.join("C:\\Local", deviceId),
    userDataPath: path.join("C:\\Local", deviceId, "electron-user-data")
  };
}

test("isolates Geumcheon runtime by device", () => {
  assert.equal(
    resolveDeviceRuntimeRoot("C:\\Local", "geumcheon-2026", "PC10"),
    path.join("C:\\Local", "ThePMD", "TypingKing2026", "geumcheon-2026", "PC10")
  );
});

test("keeps each permitted device in a distinct runtime directory", () => {
  const roots = new Set(
    (["PC01", "PC10", "LEADERBOARD01"] as const).map((deviceId) =>
      resolveDeviceRuntimeRoot("C:\\Local", "geumcheon-2026", deviceId)
    )
  );
  assert.equal(roots.size, 3);
});

test("keeps the SkillUp project runtime when no event selector exists", () => {
  const projectRoot = path.resolve();
  const startup = resolveStartupProfile({
    isPackaged: false,
    projectRoot,
    executableDirectory: projectRoot,
    localAppData: "C:\\Local"
  });
  assert.equal(startup.eventProfile.profileId, "skillup-2026");
  assert.equal(startup.runtimeRoot, projectRoot);
  assert.equal(startup.userDataPath, undefined);
});

test("keeps packaged SkillUp compatible without a copied event profile", () => {
  const executableDirectory = path.resolve("test_artifacts", "legacy-skillup-portable");
  const startup = resolveStartupProfile({
    isPackaged: true,
    projectRoot: executableDirectory,
    executableDirectory,
    localAppData: "C:\\Local"
  });
  assert.equal(startup.eventProfile.profileId, "skillup-2026");
  assert.equal(startup.runtimeRoot, path.join("C:\\Local", "ThePMD", "TypingKing2026"));
});

test("allows executable-adjacent runtime migration only for legacy SkillUp", () => {
  const migrationAllowed = (
    startupProfileModule as typeof startupProfileModule & {
      portableRuntimeMigrationAllowed?: (profileId: string) => boolean;
    }
  ).portableRuntimeMigrationAllowed;

  assert.equal(typeof migrationAllowed, "function");
  assert.equal(migrationAllowed?.("skillup-2026"), true);
  assert.equal(migrationAllowed?.("geumcheon-2026"), false);
});

test("stops a packaged Geumcheon launch without its device profile", () => {
  assert.throws(
    () =>
      resolveStartupProfile({
        isPackaged: true,
        packagedEventProfile: "geumcheon-2026",
        projectRoot: path.resolve(),
        executableDirectory: path.resolve("test_artifacts", "missing-device-profile"),
        localAppData: "C:\\Local"
      }),
    /device profile/i
  );
});

test("rejects disabled Geumcheon normal variants before launch", () => {
  const startup = geumcheonStartup("player");
  assert.throws(() => resolveLaunchPolicy(startup, "typing"), /disabled/i);
  assert.throws(() => resolveLaunchPolicy(startup, "typing-leaderboard"), /disabled/i);
});

test("rejects a player device launching a leaderboard variant", () => {
  assert.throws(() => resolveLaunchPolicy(geumcheonStartup("player"), "ai-leaderboard"), /role/i);
});

test("rejects a leaderboard device launching a player variant", () => {
  assert.throws(() => resolveLaunchPolicy(geumcheonStartup("leaderboard"), "ai"), /role/i);
});

test("returns the validated device role for allowed Geumcheon launches", () => {
  assert.deepEqual(resolveLaunchPolicy(geumcheonStartup("player"), "ai"), { pcRole: "player" });
  assert.deepEqual(resolveLaunchPolicy(geumcheonStartup("leaderboard"), "ai-leaderboard"), { pcRole: "leaderboard" });
});
