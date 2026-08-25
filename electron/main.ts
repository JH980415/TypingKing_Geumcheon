import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { OpenDialogOptions } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  addStageText,
  clearRecords,
  cleanupLegacyOneDriveArtifacts,
  deleteRecord,
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
import type { AppMode, AppVariant, LeaderboardSyncStatus, PcRole, RecordRow, SaveRecordInput, StageText } from "../shared/types";
import { resolveStartupProfile } from "./startupProfile";

let mainWindow: BrowserWindow | null = null;
let startupRuntimeRoot: string | undefined;

const WINDOW_TITLES: Record<AppVariant, string> = {
  typing: "일잘러 타자왕은 누구!?",
  "typing-leaderboard": "일잘러 타자왕은 누구!? 리더보드",
  ai: "AI 타자왕을 이겨라!",
  "ai-leaderboard": "AI 타자왕을 이겨라! 리더보드",
  practice: "타자왕 연습모드",
  "practice-leaderboard": "타자왕 연습모드 리더보드"
};

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

function appendStartupLog(message: string): void {
  try {
    const logDir = path.join(resolveRuntimeRoot(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "startup_error.log"), `${new Date().toISOString()} ${message}\r\n`, "utf8");
  } catch {
    // Startup logging is best-effort only.
  }
}

process.on("uncaughtException", (error) => {
  appendStartupLog(`uncaughtException: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});

process.on("unhandledRejection", (reason) => {
  appendStartupLog(`unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});

function executableName(): string {
  return path.basename(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
}

function resolveVariant(): AppVariant {
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

function recordModeFromVariant(variant: AppVariant): "normal" | "ai_challenge" {
  return variant === "ai" || variant === "ai-leaderboard" ? "ai_challenge" : "normal";
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

function packagedEventProfile(): string | undefined {
  if (!app.isPackaged) return undefined;
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")) as {
      typingKingEventProfile?: unknown;
    };
    return typeof packageJson.typingKingEventProfile === "string" ? packageJson.typingKingEventProfile : undefined;
  } catch {
    return undefined;
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

function appUserModelId(variant: AppVariant): string {
  return `com.skillupfesta.typingking.${variant}`;
}

function iconPath(mode: AppMode): string {
  return path.join(
    resolveRoot(),
    "assets",
    "icons",
    mode === "leaderboard" ? "leaderboard_app_icon.ico" : "typing_app_icon.ico"
  );
}

function createWindow(variant: AppVariant): void {
  const mode = appModeFromVariant(variant);
  const preload = path.join(__dirname, "preload.js");
  const windowTitle = WINDOW_TITLES[variant];
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    fullscreenable: true,
    title: windowTitle,
    icon: iconPath(mode),
    backgroundColor: "#F7F8F2",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
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
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow?.setTitle(windowTitle);
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (!app.isPackaged && devServer) {
    void mainWindow.loadURL(`${devServer}?mode=${mode}&variant=${variant}`).catch((error) => {
      appendStartupLog(`loadURL failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../dist-renderer/index.html"), {
      query: { mode, variant }
    }).catch((error) => {
      appendStartupLog(`loadFile failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    });
  }
}

function registerIpc(variant: AppVariant): void {
  const isPracticeVariant = variant === "practice" || variant === "practice-leaderboard";
  // ensureRuntime(설정 로드) 전에 연습모드를 확정해야 세션 경로가 "연습회차" 폴더로 계산된다.
  setPracticeSessionMode(isPracticeVariant);
  const runtimeRoot = resolveRuntimeRoot();
  const migratedFileCount = migratePortableRuntime(resolveRoot(), runtimeRoot);
  const ctx = ensureRuntime(runtimeRoot, resolveRoot());
  if (migratedFileCount > 0) {
    ctx.notices.push(`기존 실행 폴더의 설정과 누락 기록 ${migratedFileCount}개를 이 PC의 로컬 저장소로 복사했습니다.`);
  }
  const mode = appModeFromVariant(variant);
  const scopedRecordMode = recordModeFromVariant(variant);
  const pcRole: PcRole = mode === "leaderboard" ? "leaderboard" : "player";

  ipcMain.handle("app:getBootstrap", () => ({
    ok: true,
    data: {
      config: ctx.config,
      assetBaseUrl: ctx.assetBaseUrl,
      notices: ctx.notices,
      mode,
      variant
    }
  }));

  ipcMain.handle("admin:validate", (_event, password: string, adminName?: string) => {
    if (!password) return { ok: false, error: "관리자 비밀번호를 입력해 주세요." };
    if (password !== ctx.config.adminPassword) {
      return { ok: false, error: "관리자 비밀번호가 올바르지 않습니다." };
    }
    return { ok: true, data: { adminName: adminName?.trim() || "admin" } };
  });

  ipcMain.handle("stage:list", () => safe(() => readStageTexts(ctx)));
  ipcMain.handle("stage:readiness", (_event, gameMode?: string) => safe(() => validateStageReadiness(ctx, gameMode)));
  ipcMain.handle("stage:add", (_event, stageNumber: string, text: string, gameMode?: string) =>
    safeAsync(() => addStageText(ctx, stageNumber, text, gameMode))
  );
  ipcMain.handle("stage:update", (_event, id: string, patch: Partial<StageText>) =>
    safeAsync(() => updateStageText(ctx, id, patch))
  );
  ipcMain.handle("stage:softDelete", (_event, id: string) =>
    safeAsync(() => softDeleteStageText(ctx, id))
  );
  ipcMain.handle("stage:hardDelete", (_event, id: string) =>
    safeAsync(() => hardDeleteStageText(ctx, id))
  );
  ipcMain.handle("stage:publishShared", () =>
    safeAsync(() => publishStageTextsToOneDrive(ctx))
  );

  ipcMain.handle("records:save", (_event, input: SaveRecordInput) =>
    safeAsync(async () => {
      return saveRecord(ctx, input);
    }, "기록 저장에 실패했습니다. 복구 파일에 임시 저장합니다.")
  );
  ipcMain.handle("records:checkStartReady", (_event, gameMode: "normal" | "ai_challenge") =>
    safe(() => checkGameStartReadiness(ctx, gameMode))
  );
  ipcMain.handle("records:list", () =>
    safe(() => {
      return readRecords(ctx);
    }, "기록 파일을 읽을 수 없습니다. 파일이 열려 있거나 손상되었을 수 있습니다.")
  );
  ipcMain.handle(
    "records:update",
    (_event, recordId: string, patch: Partial<RecordRow>, adminName: string) =>
      safeAsync(
        () => updateRecord(ctx, recordId, patch, adminName),
        "기록 수정 중 오류가 발생했습니다. 백업 파일을 확인해 주세요."
      )
  );
  ipcMain.handle("records:delete", (_event, recordId: string, adminName: string) =>
    safeAsync(
      () => deleteRecord(ctx, recordId, adminName),
      "기록 삭제 중 오류가 발생했습니다. 백업 파일을 확인해 주세요."
    )
  );
  ipcMain.handle("records:clear", (_event, adminName: string) =>
    safeAsync(
      async () => {
        // 연습 리더보드는 일반+AI 두 보드를 함께 표시하므로 두 모드 모두 표시 초기화한다.
        if (variant === "practice-leaderboard") {
          await clearRecords(ctx, adminName, "normal");
          await clearRecords(ctx, adminName, "ai_challenge");
          return;
        }
        await clearRecords(ctx, adminName, scopedRecordMode);
      },
      "리더보드 초기화 중 오류가 발생했습니다. 백업 파일을 확인해 주세요."
    )
  );
  ipcMain.handle("records:export", (_event, rows: RecordRow[], scope: "all" | "filtered" | "leaderboard") =>
    safe(() => {
      // 연습 리더보드는 일반+AI 두 보드를 표시하므로 CSV도 두 모드를 각각 내보낸다.
      // (OneDrive 모드의 exportRecords는 모드별 최신 기록으로 재구성하므로 단일 호출로는 한쪽이 유실됨)
      if (variant === "practice-leaderboard") {
        const files: string[] = [];
        const errors: string[] = [];
        for (const mode of ["normal", "ai_challenge"] as const) {
          try {
            files.push(exportRecords(ctx, rows, scope, mode));
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (files.length === 0) throw new Error(errors[0] || "내보낼 기록이 없습니다.");
        return files.join("\n");
      }
      return exportRecords(ctx, rows, scope, scopedRecordMode);
    }, "CSV 내보내기 중 오류가 발생했습니다. 저장 위치를 확인해 주세요.")
  );
  ipcMain.handle("records:exportSessionBackup", () =>
    safe(() => {
      if (variant === "practice-leaderboard") {
        const normal = exportCurrentSessionBackupClean(ctx, "normal");
        const ai = exportCurrentSessionBackupClean(ctx, "ai_challenge");
        return { ...normal, message: `[일잘러]\n${normal.message}\n\n[AI]\n${ai.message}` };
      }
      return exportCurrentSessionBackupClean(ctx, scopedRecordMode);
    }, "현재 회차 CSV 백업 중 오류가 발생했습니다. 저장 위치를 확인해 주세요.")
  );
  ipcMain.handle("records:syncStatus", () => safe(() => {
    if (variant !== "practice-leaderboard") return getCleanLeaderboardSyncStatus(ctx, scopedRecordMode);
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
  ipcMain.handle("queue:status", () => safe(() => getQueuedRecordStatus(ctx)));
  ipcMain.handle("queue:flush", () =>
    safe(() => flushQueuedRecords(ctx), "기록 폴더에 다시 올리지 못했습니다. OneDrive 상태, 기록 폴더 설정, 디스크 권한을 확인해 주세요.")
  );
  ipcMain.handle("backups:list", () => safe(() => listBackups(ctx)));
  ipcMain.handle("backups:restore", (_event, backupName: string, adminName: string) =>
    safeAsync(() => restoreBackup(ctx, backupName, adminName), "백업 파일 복원에 실패했습니다.")
  );

  ipcMain.handle("sync:getSettings", () => safe(() => getOneDriveSettings(ctx, pcRole)));
  ipcMain.handle("sync:updateSettings", (_event, patch) =>
    safe(() => updateOneDriveSettings(ctx, patch, pcRole))
  );
  ipcMain.handle("sync:validateSetup", () =>
    safe(() => {
      return validateOneDriveSetup(ctx, pcRole);
    })
  );
  ipcMain.handle("sync:poke", (_event, reason?: string) => safe(() => pokeOneDriveSync(ctx, reason || "manual")));
  ipcMain.handle("sync:cleanupLegacyArtifacts", () =>
    safe(
      () => cleanupLegacyOneDriveArtifacts(ctx),
      "OneDrive 불필요 파일 정리에 실패했습니다. OneDrive 상태와 폴더 권한을 확인해 주세요."
    )
  );
  ipcMain.handle("sync:chooseRoot", async () => {
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
      updateOneDriveSettings(
        ctx,
        {
          syncMode: "onedrive_manual",
          pcRole,
          oneDriveRoot: result.filePaths[0]
        },
        pcRole
      )
    );
  });
  ipcMain.handle("sync:openSessionFolder", () =>
    safeAsync(async () => {
      const settings = getOneDriveSettings(ctx, pcRole);
      const target = settings.sessionDataRoot || settings.oneDriveRoot || resolveRoot();
      await shell.openPath(target);
      return target;
    })
  );

  if (pcRole === "player") {
    setTimeout(() => {
      try {
        flushQueuedRecords(ctx);
      } catch {
        // 관리자 모드에서 수동으로 다시 시도할 수 있다.
      }
    }, 1000);
  }
}

function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback || "알 수 없는 오류가 발생했습니다.";
}

function safe<T>(task: () => T, fallback?: string) {
  try {
    return { ok: true, data: task() };
  } catch (error) {
    return { ok: false, error: errorMessage(error, fallback), code: error instanceof Error ? error.name : undefined };
  }
}

async function safeAsync<T>(task: () => Promise<T>, fallback?: string) {
  try {
    return { ok: true, data: await task() };
  } catch (error) {
    return { ok: false, error: errorMessage(error, fallback), code: error instanceof Error ? error.name : undefined };
  }
}

void app.whenReady().then(() => {
  try {
    const startup = resolveStartupProfile({
      isPackaged: app.isPackaged,
      projectRoot: resolveRoot(),
      executableDirectory: process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath),
      localAppData: process.env.LOCALAPPDATA || process.env.APPDATA,
      eventProfile: process.env.EVENT_PROFILE,
      packagedEventProfile: packagedEventProfile(),
      runtimeRootOverride: process.env.TYPINGKING_RUNTIME_ROOT
    });
    startupRuntimeRoot = startup.runtimeRoot;
    if (startup.userDataPath) app.setPath("userData", startup.userDataPath);
  } catch (error) {
    dialog.showErrorBox("시작할 수 없습니다", error instanceof Error ? error.message : String(error));
    app.exit(1);
    return;
  }
  const variant = resolveVariant();
  app.setAppUserModelId(appUserModelId(variant));
  registerIpc(variant);
  createWindow(variant);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(variant);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
