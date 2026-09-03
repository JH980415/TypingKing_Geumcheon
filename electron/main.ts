import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import {
  addStageText,
  clearRecords,
  cleanupLegacyOneDriveArtifacts,
  deleteRecord,
  drawGeumcheonStageTexts,
  ensureRuntime,
  checkGameStartReadiness,
  exportCurrentSessionBackupClean,
  exportRecords,
  flushQueuedRecords,
  getCsvBackupStatus,
  getCleanLeaderboardSyncStatus,
  getOneDriveSettings,
  getQueuedRecordStatus,
  hardDeleteStageText,
  listBackups,
  pokeOneDriveSync,
  publishStageTextsToOneDrive,
  recalculateRecord,
  readRecords,
  readStageTexts,
  restoreBackup,
  saveRecord,
  setPracticeSessionMode,
  softDeleteStageText,
  updateRecord,
  updateOneDriveSettings,
  updateStageText,
  validateOneDriveSetup,
  validateStageReadiness
} from "../shared/csv/fileStore";
import type { RuntimeContext } from "../shared/csv/fileStore";
import type { AppMode, AppVariant, DrawStageTextsInput, GameStartReadiness, LeaderboardSyncStatus, PcRole, RecordRow, SaveRecordInput, StageText } from "../shared/types";
import { createBootstrapData, redactRendererConfig } from "../shared/events/bootstrapData";
import type { EventProfile, EventVariantPolicy } from "../shared/events/types";
import {
  assertLegacyLocalBackupIpcAllowed,
  assertSafeTlsEnvironment,
  formatStartupErrorForDisplay,
  portableRuntimeMigrationAllowed,
  recordModeFromPolicy,
  resolveApplicationResourcePaths,
  resolveE2eExtraCaPath,
  resolveLaunchPolicy,
  resolvePackagedMetadata,
  resolveReviewUserDataPath,
  shouldHideE2eWindow,
  shouldShowStartupErrorDialog,
  resolveStartupProfile
} from "./startupProfile";
import type { ApplicationResourcePaths, PackagedMetadata } from "./startupProfile";
import { AdminAccessSessions } from "./adminAccessSession";
import { importBootstrapCredential, resolveBootstrapCredentialScopes } from "./nas/bootstrapCredential";
import { NasCredentialStore } from "./nas/credentialStore";
import { checkGeumcheonNasReadiness, requireGeumcheonCredential } from "./nas/readiness";
import { rendererSafeFailure } from "./nas/piiBoundary";
import { createGeumcheonNasRuntime, type GeumcheonNasRuntime } from "./nas/runtime";
import {
  RendererCheckpointFence,
  requestRendererActiveAttemptCheckpoint
} from "./rendererCheckpointHandshake";

let mainWindow: BrowserWindow | null = null;
let startupRuntimeRoot: string | undefined;

const metadata = packagedMetadata();
const variant = resolveVariant(metadata.variant, metadata.reviewContext !== undefined);
const selectedEventProfileId = app.isPackaged
  ? metadata.eventProfileId
  : process.env.EVENT_PROFILE;
const requiresSingleInstanceLock = metadata.reviewContext !== undefined || (selectedEventProfileId === "geumcheon-2026"
  && (variant === "ai" || variant === "practice"));
if (metadata.reviewContext) {
  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!localAppData) throw new Error("REVIEW_LOCALAPPDATA_REQUIRED");
  app.setPath("userData", resolveReviewUserDataPath(localAppData, variant));
}
const mayStartApplication = !requiresSingleInstanceLock || app.requestSingleInstanceLock();
if (!mayStartApplication) app.exit(0);
else if (requiresSingleInstanceLock) {
  app.on("second-instance", () => {
    const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (!existingWindow) return;
    if (existingWindow.isMinimized()) existingWindow.restore();
    existingWindow.focus();
  });
}

type GeumcheonNasConnection = {
  runtime: GeumcheonNasRuntime;
  checkpointFence: RendererCheckpointFence;
  checkReadiness(): Promise<GameStartReadiness>;
  flush(): ReturnType<GeumcheonNasRuntime["flush"]>;
};

if (mayStartApplication) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
}

function appendStartupLog(message: string): void {
  try {
    const logDir = path.join(resolveRuntimeRoot(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "startup_error.log"), `${new Date().toISOString()} ${message}\r\n`, "utf8");
  } catch {
    // Startup logging is best-effort only.
  }
}

function installConfiguredExtraCa(): void {
  const extraCaPath = resolveE2eExtraCaPath(process.env, app.isPackaged);
  if (!extraCaPath) return;
  try {
    const extraCa = fs.readFileSync(extraCaPath, "utf8");
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), extraCa]);
  } catch (error) {
    appendStartupLog(`Extra CA initialization failed: ${errorMessage(error)}`);
  }
}

if (mayStartApplication) {
  process.on("uncaughtException", (error) => {
    appendStartupLog(`uncaughtException: ${errorMessage(error)}`);
  });

  process.on("unhandledRejection", (reason) => {
    appendStartupLog(`unhandledRejection: ${errorMessage(reason)}`);
  });
}

function executableName(): string {
  return path.basename(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
}

function resolveVariant(metadataVariant: AppVariant | undefined, isReview: boolean): AppVariant {
  if (isReview && metadataVariant) return metadataVariant;
  const envVariant = process.env.APP_VARIANT;
  if (
    envVariant === "typing" ||
    envVariant === "typing-leaderboard" ||
    envVariant === "ai" ||
    envVariant === "ai-leaderboard" ||
    envVariant === "practice" ||
    envVariant === "practice-leaderboard"
  ) {
    return envVariant;
  }

  if (metadataVariant) return metadataVariant;

  const joinedArgs = process.argv.join(" ");
  if (joinedArgs.includes("--variant=practice-leaderboard")) return "practice-leaderboard";
  if (joinedArgs.includes("--variant=practice")) return "practice";
  if (joinedArgs.includes("--variant=typing-leaderboard")) return "typing-leaderboard";
  if (joinedArgs.includes("--variant=ai-leaderboard")) return "ai-leaderboard";
  if (joinedArgs.includes("--variant=ai")) return "ai";
  if (joinedArgs.includes("--variant=typing")) return "typing";
  if (joinedArgs.includes("--leaderboard")) return "typing-leaderboard";
  if (joinedArgs.includes("--game")) return "typing";

  const name = executableName();
  if (name.includes("연습모드_리더보드") || name.includes("연습모드 리더보드")) return "practice-leaderboard";
  if (name.includes("연습모드")) return "practice";
  if (name.includes("AI 타자왕을 이겨라_리더보드")) return "ai-leaderboard";
  if (name.includes("일잘러 타자왕은 누구_리더보드")) return "typing-leaderboard";
  if (name.includes("AI 타자왕을 이겨라")) return "ai";
  if (name.includes("일잘러 타자왕은 누구")) return "typing";
  return name.includes("리더보드") ? "typing-leaderboard" : "typing";
}

function appModeFromVariant(variant: AppVariant): AppMode {
  return variant.endsWith("leaderboard") ? "leaderboard" : "game";
}

function resolveRoot(): string {
  if (app.isPackaged) {
    return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  }
  return path.resolve(__dirname, "../..");
}

function resolveRuntimeRoot(): string {
  if (startupRuntimeRoot) return startupRuntimeRoot;
  if (process.env.TYPINGKING_RUNTIME_ROOT) {
    return process.env.TYPINGKING_RUNTIME_ROOT;
  }
  if (app.isPackaged) {
    const localBase = process.env.LOCALAPPDATA || process.env.APPDATA;
    if (localBase) return path.join(localBase, "ThePMD", "TypingKing2026");
  }
  return resolveRoot();
}

function packagedMetadata(): PackagedMetadata {
  if (!app.isPackaged) return {};
  try {
    return resolvePackagedMetadata(
      JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"))
    );
  } catch (error) {
    if (error instanceof Error && error.message === "PACKAGED_REVIEW_METADATA_REJECTED") throw error;
    return {};
  }
}

function copyFileIfMissing(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function copyDirectoryFilesIfMissing(sourceDir: string, targetDir: string): number {
  if (!fs.existsSync(sourceDir)) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) copied += copyDirectoryFilesIfMissing(sourcePath, targetPath);
    else if (entry.isFile() && copyFileIfMissing(sourcePath, targetPath)) copied += 1;
  }
  return copied;
}

function migratePortableRuntime(sourceRoot: string, targetRoot: string): number {
  if (!app.isPackaged || path.resolve(sourceRoot) === path.resolve(targetRoot)) return 0;
  const files = [
    ["config/config.json", "config/config.json"],
    ["config/config.practice.json", "config/config.practice.json"],
    ["data/records.csv", "data/records.csv"],
    ["data/admin_audit.csv", "data/admin_audit.csv"],
    ["data/stage_texts.csv", "data/stage_texts.csv"],
    ["data/stage_texts.csv.local_dirty", "data/stage_texts.csv.local_dirty"]
  ];
  let copied = files.reduce(
    (count, [source, target]) =>
      count + (copyFileIfMissing(path.join(sourceRoot, source), path.join(targetRoot, target)) ? 1 : 0),
    0
  );
  for (const dirName of ["local_queue", "local_queue_practice", "recovery", "processed", "backups"]) {
    copied += copyDirectoryFilesIfMissing(
      path.join(sourceRoot, "data", dirName),
      path.join(targetRoot, "data", dirName)
    );
  }
  return copied;
}

function appUserModelId(profile: EventProfile, policy: EventVariantPolicy): string {
  const namespace = profile.profileId === "geumcheon-2026"
    ? "com.thepmd.gscience.typingking"
    : "com.skillupfesta.typingking";
  return `${namespace}.${policy.variant}`;
}

async function initializeGeumcheonNasConnection(
  eventProfile: EventProfile,
  deviceProfile: NonNullable<ReturnType<typeof resolveStartupProfile>["deviceProfile"]>,
  sessionKind: "official" | "practice",
  ctx: RuntimeContext
): Promise<GeumcheonNasConnection> {
  const runtimeRoot = resolveRuntimeRoot();
  const localContext = (): RuntimeContext => ({
    ...ctx,
    config: { ...ctx.config, syncMode: "local" }
  });
  const runtime = createGeumcheonNasRuntime({
    event: eventProfile,
    device: deviceProfile,
    sessionKind,
    runtimeRoot,
    safeStorage,
    fetch: (input, init) => globalThis.fetch(input, init),
    local: {
      persist: (input, recordId) => saveRecord(localContext(), input, recordId),
      read: async () => readRecords(localContext()),
      admin: {
        edit: async () => { throw new Error("NAS_LOCAL_ADMIN_FORBIDDEN"); },
        hide: async () => { throw new Error("NAS_LOCAL_ADMIN_FORBIDDEN"); },
        resetSession: async () => { throw new Error("NAS_LOCAL_ADMIN_FORBIDDEN"); }
      }
    }
  });
  const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  for (const scope of resolveBootstrapCredentialScopes(deviceProfile.role)) {
    const credentialStore = new NasCredentialStore({
      filePath: path.join(runtimeRoot, "nas", scope.encryptedFileName),
      safeStorage,
      eventId: eventProfile.nasEventId,
      deviceId: deviceProfile.deviceId,
      apiBaseUrl: deviceProfile.apiBaseUrl
    });
    await requireGeumcheonCredential(() =>
      importBootstrapCredential({
        filePath: path.join(executableDirectory, scope.bootstrapFileName),
        expectedEventId: eventProfile.nasEventId,
        expectedDeviceId: deviceProfile.deviceId,
        expectedApiBaseUrl: deviceProfile.apiBaseUrl,
        store: credentialStore,
        verifyCredential: scope.scope === "operator"
          ? () => runtime.checkOperatorReady()
          : () => runtime.checkReady()
      })
    );
  }

  let flushInFlight: ReturnType<GeumcheonNasRuntime["flush"]> | null = null;
  const connection: GeumcheonNasConnection = {
    runtime,
    checkpointFence: new RendererCheckpointFence(),
    checkReadiness: () => checkGeumcheonNasReadiness({
      checkAuthenticatedReady: () => runtime.checkReady()
    }),
    flush: () => {
      if (flushInFlight) return flushInFlight;
      flushInFlight = runtime.flush().finally(() => {
        flushInFlight = null;
      });
      return flushInFlight;
    }
  };
  if (deviceProfile.role === "player") {
    try {
      await runtime.recover();
    } catch (error) {
      appendStartupLog(`Geumcheon active-attempt recovery failed: ${errorMessage(error)}`);
    }
    void connection.flush().catch((error) => {
      appendStartupLog(`Geumcheon NAS startup flush failed: ${errorMessage(error)}`);
    });
  }
  return connection;
}

export function createWindow(
  variant: AppVariant,
  eventProfile: EventProfile,
  applicationResources: ApplicationResourcePaths,
  beforeClose?: (window: BrowserWindow) => Promise<void>
): void {
  const mode = appModeFromVariant(variant);
  const variantPolicy = eventProfile.variants[variant];
  const restrictPackagedGeumcheonWindow = app.isPackaged
    && eventProfile.profileId === "geumcheon-2026";
  const preload = path.join(__dirname, "preload.js");
  const windowTitle = variantPolicy.windowTitle;
  const hideWindowForE2e = shouldHideE2eWindow(process.env, app.isPackaged);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    fullscreenable: true,
    title: windowTitle,
    icon: applicationResources.iconPath,
    backgroundColor: eventProfile.theme.backgroundColor,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(restrictPackagedGeumcheonWindow ? { devTools: false } : {})
    }
  });

  mainWindow.setMenuBarVisibility(false);
  if (restrictPackagedGeumcheonWindow) mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    const currentUrl = mainWindow?.webContents.getURL();
    if (currentUrl && navigationUrl !== currentUrl) event.preventDefault();
  });
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle(windowTitle);
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.setTitle(windowTitle);
    if (!hideWindowForE2e) {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow?.setTitle(windowTitle);
    if (!hideWindowForE2e) {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
  if (beforeClose && mainWindow) {
    let closeInProgress = false;
    const closingWindow = mainWindow;
    closingWindow.on("close", (event) => {
      if (closeInProgress) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      closeInProgress = true;
      void beforeClose(closingWindow)
        .catch((error) => {
          appendStartupLog(`Geumcheon window-close recovery failed: ${errorMessage(error)}`);
        })
        .finally(() => {
          if (closingWindow && !closingWindow.isDestroyed()) closingWindow.destroy();
        });
    });
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (!app.isPackaged && devServer) {
    void mainWindow.loadURL(`${devServer}?mode=${mode}&variant=${variant}`).catch((error) => {
      appendStartupLog(`loadURL failed: ${errorMessage(error)}`);
    });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../dist-renderer/index.html"), {
      query: { mode, variant }
    }).catch((error) => {
      appendStartupLog(`loadFile failed: ${errorMessage(error)}`);
    });
  }
}

type LegacyLocalBackupIpcOperations = {
  exportSessionBackup(event: IpcMainInvokeEvent): unknown;
  listBackups(event: IpcMainInvokeEvent): unknown;
  restoreBackup(event: IpcMainInvokeEvent, backupName: string): Promise<unknown>;
};

export function registerLegacyBackupIpcHandlers(
  profileId: EventProfile["profileId"],
  operations: LegacyLocalBackupIpcOperations
): void {
  ipcMain.handle("records:exportSessionBackup", (event) =>
    safe(() => {
      assertLegacyLocalBackupIpcAllowed(profileId);
      return operations.exportSessionBackup(event);
    }, "현재 회차 CSV 백업 중 오류가 발생했습니다. 저장 위치를 확인해 주세요.")
  );
  ipcMain.handle("backups:list", (event) =>
    safe(() => {
      assertLegacyLocalBackupIpcAllowed(profileId);
      return operations.listBackups(event);
    })
  );
  ipcMain.handle("backups:restore", (event, backupName: string) =>
    safeAsync(async () => {
      assertLegacyLocalBackupIpcAllowed(profileId);
      return operations.restoreBackup(event, backupName);
    }, "백업 파일 복원에 실패했습니다.")
  );
}

async function registerIpc(
  variant: AppVariant,
  eventProfile: EventProfile,
  deviceProfile: ReturnType<typeof resolveStartupProfile>["deviceProfile"],
  pcRole: PcRole,
  applicationResources: ApplicationResourcePaths
): Promise<GeumcheonNasConnection | null> {
  const variantPolicy = eventProfile.variants[variant];
  const isPracticeVariant = variantPolicy.sessionKind === "practice";
  // ensureRuntime(설정 로드) 전에 연습모드를 확정해야 세션 경로가 "연습회차" 폴더로 계산된다.
  setPracticeSessionMode(isPracticeVariant);
  const runtimeRoot = resolveRuntimeRoot();
  const migratedFileCount = portableRuntimeMigrationAllowed(eventProfile.profileId)
    ? migratePortableRuntime(resolveRoot(), runtimeRoot)
    : 0;
  const ctx = ensureRuntime(runtimeRoot, applicationResources.resourceRoot);
  if (migratedFileCount > 0) {
    ctx.notices.push(`기존 실행 폴더의 설정과 누락 기록 ${migratedFileCount}개를 이 PC의 로컬 저장소로 복사했습니다.`);
  }
  const mode = appModeFromVariant(variant);
  const scopedRecordMode = recordModeFromPolicy(variantPolicy);
  const hasMultipleRecordModes = variantPolicy.gameModes.length > 1;
  const rendererAssetBaseUrl = eventProfile.profileId === "geumcheon-2026"
    ? applicationResources.rendererAssetBaseUrl
    : ctx.assetBaseUrl;
  let geumcheonNas: GeumcheonNasConnection | null = null;
  if (eventProfile.profileId === "geumcheon-2026") {
    if (!deviceProfile) throw new Error("Geumcheon launch requires validated device profile");
    geumcheonNas = await initializeGeumcheonNasConnection(
      eventProfile,
      deviceProfile,
      variantPolicy.sessionKind,
      ctx
    );
  }
  const adminAccessSessions = new AdminAccessSessions({
    password: ctx.config.adminPassword,
    ttlMs: 15 * 60 * 1000
  });
  ipcMain.handle("app:getBootstrap", () => ({
    ok: true,
    data: createBootstrapData({
      config: ctx.config,
      assetBaseUrl: rendererAssetBaseUrl,
      notices: ctx.notices,
        mode,
        variant,
        eventProfile,
        deviceProfile,
        reviewContext: startup?.reviewContext
      })
  }));

  ipcMain.handle("admin:validate", (event, password: string, adminName?: string) => {
    const authenticated = adminAccessSessions.authenticate(event.sender, password, adminName);
    if (!authenticated.ok) {
      return {
        ok: false,
        error: password
          ? "관리자 비밀번호가 올바르지 않습니다."
          : "관리자 비밀번호를 입력해 주세요."
      };
    }
    return { ok: true, data: { adminName: authenticated.adminName } };
  });

  ipcMain.handle("stage:list", () => safe(() => readStageTexts(ctx)));
  ipcMain.handle("stage:draw", (_event, input: DrawStageTextsInput) =>
    safe(() => {
      if (eventProfile.profileId !== "geumcheon-2026") throw new Error("Stage catalog draw is unavailable for this event");
      if (!input || variantPolicy.role !== "player" || input.gameMode !== "ai_challenge" || input.sessionKind !== variantPolicy.sessionKind) {
        throw new Error("Invalid stage catalog draw request");
      }
      return drawGeumcheonStageTexts(ctx, {
        ...input,
        eventId: eventProfile.eventId,
        catalogVersion: eventProfile.stageTextCatalogVersion,
        catalogPath: path.join(applicationResources.resourceRoot, "events", eventProfile.profileId, "stage_texts.csv"),
        role: variantPolicy.role
      });
    })
  );
  ipcMain.handle("stage:readiness", (_event, gameMode?: string) => safe(() => validateStageReadiness(ctx, gameMode)));
  ipcMain.handle("stage:add", (event, stageNumber: string, text: string, gameMode?: string) =>
    safeAsync(async () => {
      adminAccessSessions.require(event.sender);
      return addStageText(ctx, stageNumber, text, gameMode);
    })
  );
  ipcMain.handle("stage:update", (event, id: string, patch: Partial<StageText>) =>
    safeAsync(async () => {
      adminAccessSessions.require(event.sender);
      return updateStageText(ctx, id, patch);
    })
  );
  ipcMain.handle("stage:softDelete", (event, id: string) =>
    safeAsync(async () => {
      adminAccessSessions.require(event.sender);
      return softDeleteStageText(ctx, id);
    })
  );
  ipcMain.handle("stage:hardDelete", (event, id: string) =>
    safeAsync(async () => {
      adminAccessSessions.require(event.sender);
      return hardDeleteStageText(ctx, id);
    })
  );
  ipcMain.handle("stage:publishShared", (event) =>
    safeAsync(async () => {
      adminAccessSessions.require(event.sender);
      return publishStageTextsToOneDrive(ctx);
    })
  );

  ipcMain.handle("records:checkpointActiveAttempt", (
    _event,
    input: SaveRecordInput,
    closeRequestId?: string
  ) =>
    safeAsync(async () => {
      if (!geumcheonNas || variantPolicy.role !== "player") {
        throw new Error("Active-attempt checkpoint is unavailable for this event");
      }
      await geumcheonNas.checkpointFence.run(
        _event.sender.id,
        closeRequestId,
        () => geumcheonNas.runtime.checkpoint(input)
      );
    })
  );
  ipcMain.handle("records:save", (_event, input: SaveRecordInput) =>
    safeAsync(async () => {
      if (geumcheonNas) {
        const row = await geumcheonNas.runtime.save(input);
        void geumcheonNas.flush().catch((error) => {
          appendStartupLog(`Geumcheon NAS save flush failed: ${errorMessage(error)}`);
        });
        return row;
      }
      return saveRecord(ctx, input);
    }, "기록 저장에 실패했습니다. 복구 파일에 임시 저장합니다.")
  );
  ipcMain.handle("records:checkStartReady", (_event, gameMode: "normal" | "ai_challenge") =>
    safeAsync(async () => {
      if (eventProfile.profileId !== "geumcheon-2026") {
        return checkGameStartReadiness(ctx, gameMode);
      }
      if (!geumcheonNas) throw new Error("GEUMCHEON_NAS_UNAVAILABLE");
      return geumcheonNas.checkReadiness();
    })
  );
  ipcMain.handle("records:list", () =>
    safeAsync(async () => {
      if (geumcheonNas && variantPolicy.role === "leaderboard") {
        return (await geumcheonNas.runtime.loadRecords()).rows;
      }
      return readRecords(ctx);
    }, "기록 파일을 읽을 수 없습니다. 파일이 열려 있거나 손상되었을 수 있습니다.")
  );
  ipcMain.handle(
    "records:update",
    (event, recordId: string, patch: Partial<RecordRow>) =>
      safeAsync(
        async () => {
          const { adminName } = adminAccessSessions.require(event.sender);
          if (!geumcheonNas) return updateRecord(ctx, recordId, patch, adminName);
          const before = (await geumcheonNas.runtime.loadRecords()).rows.find(
            (record) => record.record_id === recordId
          );
          if (!before) throw new Error("수정 또는 삭제할 기록을 선택해 주세요.");
          const replacement = recalculateRecord({ ...before, ...patch, record_id: recordId });
          await geumcheonNas.runtime.edit(recordId, replacement, adminName);
          return replacement;
        },
        "기록 수정 중 오류가 발생했습니다. 백업 파일을 확인해 주세요."
      )
  );
  ipcMain.handle("records:delete", (event, recordId: string) =>
    safeAsync(
      async () => {
        const { adminName } = adminAccessSessions.require(event.sender);
        if (!geumcheonNas) return deleteRecord(ctx, recordId, adminName);
        await geumcheonNas.runtime.hide(recordId, true, adminName);
      },
      "기록 삭제 중 오류가 발생했습니다. 백업 파일을 확인해 주세요."
    )
  );
  ipcMain.handle("records:clear", (event) =>
    safeAsync(
      async () => {
        const { adminName } = adminAccessSessions.require(event.sender);
        if (geumcheonNas) {
          await geumcheonNas.runtime.resetSession(adminName);
          return;
        }
        // 연습 리더보드는 일반+AI 두 보드를 함께 표시하므로 두 모드 모두 표시 초기화한다.
        if (hasMultipleRecordModes) {
          await clearRecords(ctx, adminName, "normal");
          await clearRecords(ctx, adminName, "ai_challenge");
          return;
        }
        await clearRecords(ctx, adminName, scopedRecordMode);
      },
      "리더보드 초기화 중 오류가 발생했습니다. 백업 파일을 확인해 주세요."
    )
  );
  ipcMain.handle("records:export", (event, rows: RecordRow[], scope: "all" | "filtered" | "leaderboard") =>
    safe(() => {
      adminAccessSessions.require(event.sender);
      // 연습 리더보드는 일반+AI 두 보드를 표시하므로 CSV도 두 모드를 각각 내보낸다.
      // (OneDrive 모드의 exportRecords는 모드별 최신 기록으로 재구성하므로 단일 호출로는 한쪽이 유실됨)
      if (hasMultipleRecordModes) {
        const files: string[] = [];
        const errors: string[] = [];
        for (const mode of variantPolicy.gameModes) {
          try {
            files.push(exportRecords(ctx, rows, scope, mode));
          } catch (error) {
            errors.push(errorMessage(error));
          }
        }
        if (files.length === 0) throw new Error(errors[0] || "내보낼 기록이 없습니다.");
        return files.join("\n");
      }
      return exportRecords(ctx, rows, scope, scopedRecordMode);
    }, "CSV 내보내기 중 오류가 발생했습니다. 저장 위치를 확인해 주세요.")
  );
  registerLegacyBackupIpcHandlers(eventProfile.profileId, {
    exportSessionBackup: (event) => {
      adminAccessSessions.require(event.sender);
      if (hasMultipleRecordModes) {
        const normal = exportCurrentSessionBackupClean(ctx, "normal");
        const ai = exportCurrentSessionBackupClean(ctx, "ai_challenge");
        return { ...normal, message: `[일잘러]\n${normal.message}\n\n[AI]\n${ai.message}` };
      }
      return exportCurrentSessionBackupClean(ctx, scopedRecordMode);
    },
    listBackups: (event) => {
      adminAccessSessions.require(event.sender);
      return listBackups(ctx);
    },
    restoreBackup: async (event, backupName) => {
      const { adminName } = adminAccessSessions.require(event.sender);
      return restoreBackup(ctx, backupName, adminName);
    }
  });
  ipcMain.handle("records:syncStatus", () => safe(() => {
    if (!hasMultipleRecordModes) return getCleanLeaderboardSyncStatus(ctx, scopedRecordMode);
    const normal = getCleanLeaderboardSyncStatus(ctx, "normal");
    const ai = getCleanLeaderboardSyncStatus(ctx, "ai_challenge");
    const status: LeaderboardSyncStatus["status"] =
      normal.status === "오류" || ai.status === "오류"
        ? "오류"
        : normal.status === "주의" || ai.status === "주의"
          ? "주의"
          : normal.status === "기록 없음" && ai.status === "기록 없음"
            ? "기록 없음"
            : "정상";
    return {
      ...normal,
      sourceFileCount: normal.sourceFileCount + ai.sourceFileCount,
      reflectedRecordCount: normal.reflectedRecordCount + ai.reflectedRecordCount,
      ignoredFileCount: normal.ignoredFileCount + ai.ignoredFileCount,
      lastReadAt: [normal.lastReadAt, ai.lastReadAt].sort().at(-1) || normal.lastReadAt,
      status,
      error: [normal.error, ai.error].filter(Boolean).join(" / ") || undefined
    };
  }));
  ipcMain.handle("records:backupStatus", () => safe(() => getCsvBackupStatus(ctx)));
  ipcMain.handle("queue:status", () => safeAsync(async () => {
    if (!geumcheonNas) return getQueuedRecordStatus(ctx);
    const status = await geumcheonNas.runtime.queueStatus();
    return { count: status.pending + status.blocked };
  }));
  ipcMain.handle("queue:flush", (event) =>
    safeAsync(async () => {
      adminAccessSessions.require(event.sender);
      if (!geumcheonNas) return flushQueuedRecords(ctx);
      const result = await geumcheonNas.flush();
      return {
        attempted: result.attempted,
        sent: result.sent,
        failed: result.blocked + result.deferred,
        targetPaths: [],
        failures: []
      };
    }, "기록 서버에 다시 올리지 못했습니다. 인터넷 연결과 NAS 서버 상태를 확인해 주세요.")
  );
  ipcMain.handle("sync:getSettings", () =>
    safe(() => redactRendererConfig(getOneDriveSettings(ctx, pcRole)))
  );
  ipcMain.handle("sync:updateSettings", (event, patch) =>
    safe(() => {
      adminAccessSessions.require(event.sender);
      return redactRendererConfig(updateOneDriveSettings(ctx, patch, pcRole));
    })
  );
  ipcMain.handle("sync:validateSetup", (event) =>
    safe(() => {
      adminAccessSessions.require(event.sender);
      return redactRendererConfig(validateOneDriveSetup(ctx, pcRole));
    })
  );
  ipcMain.handle("sync:poke", (event, reason?: string) => safe(() => {
    adminAccessSessions.require(event.sender);
    return pokeOneDriveSync(ctx, reason || "manual");
  }));
  ipcMain.handle("sync:cleanupLegacyArtifacts", (event) =>
    safe(
      () => {
        adminAccessSessions.require(event.sender);
        return cleanupLegacyOneDriveArtifacts(ctx);
      },
      "OneDrive 불필요 파일 정리에 실패했습니다. OneDrive 상태와 폴더 권한을 확인해 주세요."
    )
  );
  ipcMain.handle("sync:chooseRoot", async (event) => {
    const authorized = safe(() => adminAccessSessions.require(event.sender));
    if (!authorized.ok) return authorized;
    const dialogOptions: OpenDialogOptions = {
      title: "OneDrive 루트 폴더 선택",
      properties: ["openDirectory"]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: "OneDrive 루트 폴더가 선택되지 않았습니다." };
    }
    return safe(() =>
      redactRendererConfig(updateOneDriveSettings(
        ctx,
        {
          syncMode: "onedrive_manual",
          pcRole,
          oneDriveRoot: result.filePaths[0]
        },
        pcRole
      ))
    );
  });
  ipcMain.handle("sync:openSessionFolder", (event) =>
    safeAsync(async () => {
      adminAccessSessions.require(event.sender);
      const settings = getOneDriveSettings(ctx, pcRole);
      const target = settings.sessionDataRoot || settings.oneDriveRoot || resolveRoot();
      await shell.openPath(target);
      return target;
    })
  );

  if (pcRole === "player") {
    setTimeout(() => {
      if (geumcheonNas) {
        void geumcheonNas.flush().catch((error) => {
          appendStartupLog(`Geumcheon NAS delayed flush failed: ${errorMessage(error)}`);
        });
      } else {
        try {
          flushQueuedRecords(ctx);
        } catch {
          // 관리자 모드에서 수동으로 다시 시도할 수 있다.
        }
      }
    }, 1000);
  }
  return geumcheonNas;
}

function errorMessage(error: unknown, fallback?: string): string {
  void error;
  return fallback || "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
}

export function safe<T>(task: () => T, fallback?: string) {
  try {
    return { ok: true, data: task() };
  } catch (error) {
    return rendererSafeFailure(error, fallback);
  }
}

async function safeAsync<T>(task: () => Promise<T>, fallback?: string) {
  try {
    return { ok: true, data: await task() };
  } catch (error) {
    return rendererSafeFailure(error, fallback);
  }
}

let launchPolicy: ReturnType<typeof resolveLaunchPolicy> | undefined;
let startup: ReturnType<typeof resolveStartupProfile> | undefined;
let applicationResources: ApplicationResourcePaths | undefined;
let startupInitializationError: unknown;

function initializeStartup(): void {
  const startupResources = resolveApplicationResourcePaths({
    isPackaged: app.isPackaged,
    projectRoot: resolveRoot(),
    resourcesPath: process.resourcesPath,
    eventProfileId: metadata.eventProfileId || "skillup-2026",
    role: variant.endsWith("leaderboard") ? "leaderboard" : "player"
  });
  startup = resolveStartupProfile({
    isPackaged: app.isPackaged,
    projectRoot: startupResources.resourceRoot,
    executableDirectory: process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath),
    localAppData: process.env.LOCALAPPDATA || process.env.APPDATA,
    eventProfile: process.env.EVENT_PROFILE,
    packagedEventProfile: metadata.eventProfileId,
    runtimeRootOverride: process.env.TYPINGKING_RUNTIME_ROOT,
    reviewContext: metadata.reviewContext
  });
  assertSafeTlsEnvironment(
    process.env,
    app.isPackaged,
    startup.deviceProfile && {
      eventProfileId: startup.deviceProfile.eventProfileId,
      apiBaseUrl: startup.deviceProfile.apiBaseUrl
    }
  );
  installConfiguredExtraCa();
  startupRuntimeRoot = startup.runtimeRoot;
  if (startup.userDataPath) app.setPath("userData", startup.userDataPath);
  launchPolicy = resolveLaunchPolicy(startup, variant);
  applicationResources = resolveApplicationResourcePaths({
    isPackaged: app.isPackaged,
    projectRoot: resolveRoot(),
    resourcesPath: process.resourcesPath,
    eventProfileId: startup.eventProfile.profileId,
    role: startup.eventProfile.variants[variant].role
  });
}

if (mayStartApplication && app.isPackaged && selectedEventProfileId === "geumcheon-2026") {
  try {
    initializeStartup();
  } catch (error) {
    startupInitializationError = error;
  }
}

if (mayStartApplication) void app.whenReady().then(async () => {
  try {
    if (startupInitializationError) throw startupInitializationError;
    if (!launchPolicy || !startup || !applicationResources) initializeStartup();
  } catch (error) {
    appendStartupLog(`Startup profile initialization failed: ${errorMessage(error)}`);
    if (shouldShowStartupErrorDialog(process.env, app.isPackaged)) {
      dialog.showErrorBox("시작할 수 없습니다", formatStartupErrorForDisplay(error));
    }
    app.exit(1);
    return;
  }
  if (!launchPolicy || !startup || !applicationResources) return;
  app.setAppUserModelId(appUserModelId(startup.eventProfile, startup.eventProfile.variants[variant]));
  let geumcheonNas: GeumcheonNasConnection | null;
  try {
    geumcheonNas = await registerIpc(
      variant,
      startup.eventProfile,
      startup.deviceProfile,
      launchPolicy.pcRole,
      applicationResources
    );
  } catch (error) {
    appendStartupLog(`Geumcheon NAS initialization failed: ${errorMessage(error)}`);
    if (shouldShowStartupErrorDialog(process.env, app.isPackaged)) {
      dialog.showErrorBox("시작할 수 없습니다", errorMessage(error));
    }
    app.exit(1);
    return;
  }
  const beforeClose = geumcheonNas && launchPolicy.pcRole === "player"
    ? async (closingWindow: BrowserWindow) => {
        const closeRequestId = randomUUID();
        geumcheonNas.checkpointFence.begin(
          closingWindow.webContents.id,
          closeRequestId
        );
        const checkpointResult = await requestRendererActiveAttemptCheckpoint({
          ipc: ipcMain,
          target: closingWindow.webContents,
          timeoutMs: 900,
          requestId: closeRequestId
        });
        geumcheonNas.checkpointFence.seal(
          closingWindow.webContents.id,
          closeRequestId
        );
        if (checkpointResult !== "completed") {
          appendStartupLog(
            `Geumcheon close-time checkpoint used fallback: ${checkpointResult}`
          );
        }
        const recovered = await geumcheonNas.runtime.recover();
        if (!recovered) return;
        await Promise.race([
          geumcheonNas.flush().then(() => undefined).catch((error) => {
            appendStartupLog(`Geumcheon NAS window-close flush failed: ${errorMessage(error)}`);
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 1500))
        ]);
      }
    : undefined;
  const activeEventProfile = startup.eventProfile;
  const activeApplicationResources = applicationResources;
  createWindow(variant, activeEventProfile, activeApplicationResources, beforeClose);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(variant, activeEventProfile, activeApplicationResources, beforeClose);
    }
  });
});

if (mayStartApplication) {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
