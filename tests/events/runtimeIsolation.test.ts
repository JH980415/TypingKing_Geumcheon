import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as startupProfileModule from "../../electron/startupProfile";
import { ensureRuntime } from "../../shared/csv/fileStore";
import { loadEventProfile } from "../../shared/events/eventProfile";
import {
  resolveDeviceRuntimeRoot,
  resolveLaunchPolicy,
  shouldShowStartupErrorDialog,
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

test("seeds a packaged Geumcheon runtime from the bundled catalog without a fallback notice", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typingking-packaged-catalog-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const resourceRoot = path.join(tempRoot, "resources");
  const eventRoot = path.join(resourceRoot, "events", "geumcheon-2026");
  const executableDirectory = path.join(tempRoot, "portable");
  const localAppData = path.join(tempRoot, "local-app-data");
  fs.mkdirSync(eventRoot, { recursive: true });
  fs.mkdirSync(executableDirectory, { recursive: true });
  fs.copyFileSync(path.resolve("events/geumcheon-2026/event.config.json"), path.join(eventRoot, "event.config.json"));
  fs.copyFileSync(path.resolve("events/geumcheon-2026/stage_texts.csv"), path.join(eventRoot, "stage_texts.csv"));
  fs.writeFileSync(
    path.join(executableDirectory, "device-profile.json"),
    JSON.stringify({
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
    }),
    "utf8"
  );

  const startup = resolveStartupProfile({
    isPackaged: true,
    packagedEventProfile: "geumcheon-2026",
    projectRoot: resourceRoot,
    executableDirectory,
    localAppData
  });
  const runtime = ensureRuntime(startup.runtimeRoot, resourceRoot);
  const runtimeCatalog = fs.readFileSync(runtime.paths.stageTextsFile, "utf8");

  assert.equal(runtime.notices.includes("문구 파일이 없어 기본 문구로 생성합니다."), false);
  assert.match(runtimeCatalog, /과학은 질문에서 시작됩니다/);
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

test("suppresses startup error dialogs only for a mode-matched explicit E2E profile", () => {
  const showDialog = shouldShowStartupErrorDialog as (
    environment: Record<string, string | undefined>,
    isPackaged: boolean
  ) => boolean;
  const approvedUiEnvironment = {
    TYPINGKING_E2E_PROFILE: "approved-ui",
    TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS: "1"
  };

  assert.equal(showDialog({}, false), true);
  assert.equal(showDialog({ TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS: "1" }, false), true);
  assert.equal(showDialog(approvedUiEnvironment, false), false);
  assert.equal(showDialog(approvedUiEnvironment, true), true);
  assert.equal(showDialog({
    TYPINGKING_E2E_PROFILE: "functional-flow",
    TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS: "1"
  }, false), false);
  assert.equal(showDialog({
    TYPINGKING_E2E_PROFILE: "packaged-smoke",
    TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS: "1"
  }, true), false);
  assert.equal(showDialog({
    TYPINGKING_E2E_PROFILE: "functional-flow",
    TYPINGKING_E2E_SUPPRESS_STARTUP_DIALOGS: "1"
  }, true), true);
});

test("hides windows only for a mode-matched explicit E2E profile", () => {
  const shouldHideWindow = (
    startupProfileModule as typeof startupProfileModule & {
      shouldHideE2eWindow?: (
        environment: Record<string, string | undefined>,
        isPackaged: boolean
      ) => boolean;
    }
  ).shouldHideE2eWindow;
  const approvedUiEnvironment = {
    TYPINGKING_E2E_PROFILE: "approved-ui",
    TYPINGKING_E2E_HIDE_WINDOW: "1"
  };

  assert.equal(typeof shouldHideWindow, "function");
  assert.equal(shouldHideWindow?.({}, false), false);
  assert.equal(shouldHideWindow?.({ TYPINGKING_E2E_HIDE_WINDOW: "1" }, false), false);
  assert.equal(shouldHideWindow?.(approvedUiEnvironment, false), true);
  assert.equal(shouldHideWindow?.(approvedUiEnvironment, true), false);
  assert.equal(shouldHideWindow?.({
    TYPINGKING_E2E_PROFILE: "functional-flow",
    TYPINGKING_E2E_HIDE_WINDOW: "1"
  }, false), true);
  assert.equal(shouldHideWindow?.({
    TYPINGKING_E2E_PROFILE: "packaged-smoke",
    TYPINGKING_E2E_HIDE_WINDOW: "1"
  }, true), true);
  assert.equal(shouldHideWindow?.({
    TYPINGKING_E2E_PROFILE: "packaged-smoke",
    TYPINGKING_E2E_HIDE_WINDOW: "1"
  }, false), false);
});

test("accepts an extra CA only for a mode-matched explicit E2E profile", () => {
  const resolveExtraCaPath = (
    startupProfileModule as typeof startupProfileModule & {
      resolveE2eExtraCaPath?: (
        environment: Record<string, string | undefined>,
        isPackaged: boolean
      ) => string | undefined;
    }
  ).resolveE2eExtraCaPath;
  const approvedUiEnvironment = {
    TYPINGKING_E2E_PROFILE: "approved-ui",
    NODE_EXTRA_CA_CERTS: "C:\\test\\mock-ca.pem"
  };

  assert.equal(typeof resolveExtraCaPath, "function");
  assert.equal(resolveExtraCaPath?.({}, false), undefined);
  assert.equal(resolveExtraCaPath?.(approvedUiEnvironment, true), undefined);
  assert.equal(resolveExtraCaPath?.(approvedUiEnvironment, false), "C:\\test\\mock-ca.pem");
  assert.equal(resolveExtraCaPath?.({
    TYPINGKING_E2E_PROFILE: "functional-flow",
    NODE_EXTRA_CA_CERTS: "C:\\test\\flow-ca.pem"
  }, false), "C:\\test\\flow-ca.pem");
  assert.equal(resolveExtraCaPath?.({
    TYPINGKING_E2E_PROFILE: "packaged-smoke",
    NODE_EXTRA_CA_CERTS: "C:\\test\\packaged-ca.pem"
  }, true), "C:\\test\\packaged-ca.pem");
  assert.equal(resolveExtraCaPath?.({
    TYPINGKING_E2E_PROFILE: "functional-flow",
    NODE_EXTRA_CA_CERTS: "C:\\test\\flow-ca.pem"
  }, true), undefined);
  assert.equal(resolveExtraCaPath?.({
    TYPINGKING_E2E_PROFILE: "packaged-smoke",
    NODE_EXTRA_CA_CERTS: "C:\\test\\packaged-ca.pem"
  }, false), undefined);
});

test("removes inherited secrets and TLS overrides from the approved UI E2E child environment", () => {
  const sanitizeEnvironment = (
    startupProfileModule as typeof startupProfileModule & {
      sanitizeE2eChildEnvironment?: (
        environment: Record<string, string | undefined>
      ) => Record<string, string | undefined>;
    }
  ).sanitizeE2eChildEnvironment;

  assert.equal(typeof sanitizeEnvironment, "function");
  assert.deepEqual(
    sanitizeEnvironment?.({
      PATH: "C:\\Windows",
      NODE_EXTRA_CA_CERTS: "C:\\host\\ca.pem",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      node_tls_reject_unauthorized: "0",
      Node_Extra_Ca_Certs: "C:\\host\\mixed-case-ca.pem",
      GEUMCHEON_NAS_TOKEN: "synthetic-secret",
      TYPINGKING_TEST_ADMIN_PASSWORD: "synthetic-password",
      THIRD_PARTY_API_KEY: "synthetic-api-key"
    }),
    { PATH: "C:\\Windows" }
  );
});
