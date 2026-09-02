import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type ElectronAppListener = (...args: unknown[]) => void;

type ElectronHarness = {
  electron: Record<string, unknown>;
  events: string[];
  ipcHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  listeners: Map<string, ElectronAppListener>;
  windowActions: string[];
  createdWindowOptions(): Record<string, unknown> | undefined;
  dispose(): void;
  whenReadyCalls(): number;
};

const requireFromTest = createRequire(import.meta.url);
const mainPath = path.resolve("electron/main.ts");

function createElectronHarness(
  hasLock: boolean,
  existingWindows: unknown[] = [],
  isPackaged = false,
  packagedMetadata?: Record<string, unknown>
): ElectronHarness {
  const events: string[] = [];
  const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, ElectronAppListener>();
  const windowActions: string[] = [];
  let browserWindowOptions: Record<string, unknown> | undefined;
  let readyCalls = 0;
  const pendingReadiness = new Promise<void>(() => undefined);
  const appPath = packagedMetadata
    ? fs.mkdtempSync(path.join(os.tmpdir(), "typingking-main-test-"))
    : path.resolve();
  if (packagedMetadata) {
    fs.writeFileSync(
      path.join(appPath, "package.json"),
      JSON.stringify(packagedMetadata),
      "utf8"
    );
  }

  return {
    events,
    ipcHandlers,
    listeners,
    windowActions,
    createdWindowOptions: () => browserWindowOptions,
    dispose: () => {
      if (packagedMetadata) fs.rmSync(appPath, { recursive: true, force: true });
    },
    whenReadyCalls: () => readyCalls,
    electron: {
      app: {
        commandLine: {
          appendSwitch(name: string) {
            events.push(`switch:${name}`);
          }
        },
        exit(code: number) {
          events.push(`exit:${code}`);
        },
        getAppPath: () => appPath,
        isPackaged,
        on(eventName: string, listener: ElectronAppListener) {
          events.push(`on:${eventName}`);
          listeners.set(eventName, listener);
        },
        requestSingleInstanceLock() {
          events.push("request-lock");
          return hasLock;
        },
        whenReady() {
          readyCalls += 1;
          events.push("when-ready");
          return pendingReadiness;
        }
      },
      BrowserWindow: class BrowserWindow {
        webContents = {
          getURL: () => "",
          loadURL: async () => undefined,
          once: () => undefined,
          on: () => undefined,
          setWindowOpenHandler: () => undefined
        };

        constructor(options: Record<string, unknown>) {
          browserWindowOptions = options;
        }

        static getAllWindows(): unknown[] {
          return existingWindows;
        }

        destroy(): void {}
        focus(): void {}
        isDestroyed(): boolean { return false; }
        loadFile(): Promise<void> { return Promise.resolve(); }
        loadURL(): Promise<void> { return Promise.resolve(); }
        on(): void {}
        once(): void {}
        removeMenu(): void { windowActions.push("remove-menu"); }
        setMenuBarVisibility(visible: boolean): void {
          windowActions.push(`menu-bar:${visible}`);
        }
        setTitle(): void {}
        show(): void {}
      },
      dialog: {},
      ipcMain: {
        handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) {
          ipcHandlers.set(channel, handler);
        }
      },
      safeStorage: {},
      shell: {}
    }
  };
}

function executeMain(
  harness: ElectronHarness,
  launch: { eventProfile?: string; variant?: string } = {}
): Record<string, unknown> {
  const moduleInternals = Module as typeof Module & {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
  };
  const originalLoad = moduleInternals._load;
  const baselineUncaught = new Set(process.listeners("uncaughtException"));
  const baselineRejection = new Set(process.listeners("unhandledRejection"));
  const previousEventProfile = process.env.EVENT_PROFILE;
  const previousVariant = process.env.APP_VARIANT;

  if (launch.eventProfile) process.env.EVENT_PROFILE = launch.eventProfile;
  else delete process.env.EVENT_PROFILE;
  if (launch.variant) process.env.APP_VARIANT = launch.variant;
  else delete process.env.APP_VARIANT;

  moduleInternals._load = function loadWithElectronHarness(request, parent, isMain) {
    if (request === "electron") return harness.electron;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolvedMain = requireFromTest.resolve(mainPath);
    delete requireFromTest.cache[resolvedMain];
    const loaded = requireFromTest(resolvedMain) as Record<string, unknown>;
    delete requireFromTest.cache[resolvedMain];
    return loaded;
  } finally {
    moduleInternals._load = originalLoad;
    harness.dispose();
    if (previousEventProfile === undefined) delete process.env.EVENT_PROFILE;
    else process.env.EVENT_PROFILE = previousEventProfile;
    if (previousVariant === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = previousVariant;
    for (const listener of process.listeners("uncaughtException")) {
      if (!baselineUncaught.has(listener)) process.removeListener("uncaughtException", listener);
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!baselineRejection.has(listener)) process.removeListener("unhandledRejection", listener);
    }
  }
}

test("Geumcheon player variants exit before readiness when another instance owns the lock", () => {
  const cases = [
    { label: "development AI", isPackaged: false, variant: "ai" },
    { label: "development practice", isPackaged: false, variant: "practice" },
    { label: "packaged AI", isPackaged: true, variant: "ai" },
    { label: "packaged practice", isPackaged: true, variant: "practice" }
  ];

  for (const current of cases) {
    const harness = createElectronHarness(
      false,
      [],
      current.isPackaged,
      current.isPackaged
        ? {
            typingKingEventProfile: "geumcheon-2026",
            typingKingVariant: current.variant
          }
        : undefined
    );

    executeMain(
      harness,
      current.isPackaged
        ? {}
        : { eventProfile: "geumcheon-2026", variant: current.variant }
    );

    assert.deepEqual(harness.events, ["request-lock", "exit:0"], current.label);
    assert.equal(harness.whenReadyCalls(), 0, current.label);
  }
});

test("a second launch restores and focuses the existing primary window only", () => {
  const windowActions: string[] = [];
  const existingWindow = {
    isMinimized: () => true,
    restore: () => windowActions.push("restore"),
    focus: () => windowActions.push("focus")
  };
  const harness = createElectronHarness(true, [existingWindow]);

  executeMain(harness, { eventProfile: "geumcheon-2026", variant: "ai" });
  const secondInstance = harness.listeners.get("second-instance");

  assert.equal(typeof secondInstance, "function");
  secondInstance?.();
  assert.deepEqual(windowActions, ["restore", "focus"]);
  assert.equal(harness.whenReadyCalls(), 1);
});

test("SkillUp and Geumcheon leaderboard launches keep the existing unlocked startup", () => {
  const cases: Array<{
    label: string;
    isPackaged: boolean;
    launch?: { eventProfile: string; variant: string };
    metadata?: Record<string, unknown>;
  }> = [
    {
      label: "development SkillUp player",
      isPackaged: false,
      launch: { eventProfile: "skillup-2026", variant: "ai" }
    },
    {
      label: "development SkillUp leaderboard",
      isPackaged: false,
      launch: { eventProfile: "skillup-2026", variant: "ai-leaderboard" }
    },
    {
      label: "development Geumcheon leaderboard",
      isPackaged: false,
      launch: { eventProfile: "geumcheon-2026", variant: "ai-leaderboard" }
    },
    {
      label: "packaged SkillUp player",
      isPackaged: true,
      metadata: {
        typingKingEventProfile: "skillup-2026",
        typingKingVariant: "ai"
      }
    },
    {
      label: "packaged Geumcheon leaderboard",
      isPackaged: true,
      metadata: {
        typingKingEventProfile: "geumcheon-2026",
        typingKingVariant: "ai-leaderboard"
      }
    },
    {
      label: "packaged Geumcheon practice leaderboard",
      isPackaged: true,
      metadata: {
        typingKingEventProfile: "geumcheon-2026",
        typingKingVariant: "practice-leaderboard"
      }
    }
  ];

  for (const current of cases) {
    const harness = createElectronHarness(
      false,
      [],
      current.isPackaged,
      current.metadata
    );

    executeMain(harness, current.launch);

    assert.equal(harness.events.includes("request-lock"), false, current.label);
    assert.equal(harness.events.includes("exit:0"), false, current.label);
    assert.equal(harness.listeners.has("second-instance"), false, current.label);
    assert.equal(harness.whenReadyCalls(), 1, current.label);
  }
});

test("a packaged Geumcheon window disables DevTools and removes its menu", () => {
  const harness = createElectronHarness(false, [], true);
  const mainModule = executeMain(harness);
  const createWindow = mainModule.createWindow as ((
    variant: string,
    eventProfile: Record<string, unknown>,
    resources: Record<string, unknown>
  ) => void) | undefined;

  assert.equal(typeof createWindow, "function");
  createWindow?.(
    "ai",
    {
      profileId: "geumcheon-2026",
      theme: { backgroundColor: "#ffffff" },
      variants: { ai: { windowTitle: "G-Science AI 타자왕" } }
    },
    { iconPath: "icon.ico" }
  );

  const webPreferences = harness.createdWindowOptions()?.webPreferences as
    | Record<string, unknown>
    | undefined;
  assert.equal(webPreferences?.devTools, false);
  assert.deepEqual(harness.windowActions, ["menu-bar:false", "remove-menu"]);
});

test("development and SkillUp windows keep their existing DevTools and menu behavior", () => {
  const cases = [
    { label: "development Geumcheon", isPackaged: false, profileId: "geumcheon-2026" },
    { label: "packaged SkillUp", isPackaged: true, profileId: "skillup-2026" }
  ];

  for (const current of cases) {
    const harness = createElectronHarness(false, [], current.isPackaged);
    const mainModule = executeMain(harness);
    const createWindow = mainModule.createWindow as (
      variant: string,
      eventProfile: Record<string, unknown>,
      resources: Record<string, unknown>
    ) => void;

    createWindow(
      "ai",
      {
        profileId: current.profileId,
        theme: { backgroundColor: "#ffffff" },
        variants: { ai: { windowTitle: "타자왕" } }
      },
      { iconPath: "icon.ico" }
    );

    const webPreferences = harness.createdWindowOptions()?.webPreferences as
      | Record<string, unknown>
      | undefined;
    assert.notEqual(webPreferences?.devTools, false, current.label);
    assert.deepEqual(harness.windowActions, ["menu-bar:false"], current.label);
  }
});

test("sync renderer failures return a safe IPC result instead of undefined", () => {
  const harness = createElectronHarness(false);
  const mainModule = executeMain(harness);
  const safe = mainModule.safe as
    | ((task: () => unknown, fallback?: string) => unknown)
    | undefined;

  assert.equal(typeof safe, "function");
  assert.deepEqual(
    safe?.(() => {
      throw new Error("NAS_WRITE_FAILED C:\\Users\\operator\\secret.json");
    }, "NAS 요청을 처리하지 못했습니다."),
    { ok: false, error: "NAS 요청을 처리하지 못했습니다." }
  );
});

test("legacy local backup IPC fails closed for Geumcheon and remains available for SkillUp", async () => {
  const cases = [
    { profileId: "geumcheon-2026", allowed: false },
    { profileId: "skillup-2026", allowed: true }
  ] as const;

  for (const current of cases) {
    const harness = createElectronHarness(false);
    const mainModule = executeMain(harness);
    const registerLegacyBackupIpcHandlers = mainModule.registerLegacyBackupIpcHandlers as
      | ((profileId: string, operations: {
          exportSessionBackup: (event: unknown) => unknown;
          listBackups: (event: unknown) => unknown;
          restoreBackup: (event: unknown, backupName: string) => Promise<unknown>;
        }) => void)
      | undefined;
    const calls: string[] = [];

    assert.equal(typeof registerLegacyBackupIpcHandlers, "function", current.profileId);
    registerLegacyBackupIpcHandlers?.(current.profileId, {
      exportSessionBackup: () => {
        calls.push("export");
        return "exported";
      },
      listBackups: () => {
        calls.push("list");
        return ["backup-1"];
      },
      restoreBackup: async (_event, backupName) => {
        calls.push(`restore:${backupName}`);
        return "restored";
      }
    });

    const exportResult = await harness.ipcHandlers.get("records:exportSessionBackup")?.({});
    const listResult = await harness.ipcHandlers.get("backups:list")?.({});
    const restoreResult = await harness.ipcHandlers.get("backups:restore")?.({}, "backup-1");

    if (current.allowed) {
      assert.deepEqual(exportResult, { ok: true, data: "exported" });
      assert.deepEqual(listResult, { ok: true, data: ["backup-1"] });
      assert.deepEqual(restoreResult, { ok: true, data: "restored" });
      assert.deepEqual(calls, ["export", "list", "restore:backup-1"]);
    } else {
      assert.equal((exportResult as { ok?: boolean })?.ok, false);
      assert.equal((listResult as { ok?: boolean })?.ok, false);
      assert.equal((restoreResult as { ok?: boolean })?.ok, false);
      assert.deepEqual(calls, []);
    }
  }
});
