import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveDeviceRuntimeRoot, resolveStartupProfile } from "../../electron/startupProfile";

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
