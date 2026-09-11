import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { safeStorage } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { DeploymentProfileStore, loadDeploymentProfile, profileFingerprint, profilePreview, withDeploymentLocks, replaceDeploymentSelection, assertSafeDeploymentApplication, deploymentErrorForDisplay, readDeploymentSelection, saveDeploymentSelection, type DeploymentProfileV2 } from "./deploymentProfile";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import net from "node:net";
import {appendDeploymentCsvContext} from "./deploymentCsv";
import {saveRecoveryAuthorization,openProfileRecovery} from "./profileRecovery";
import {
  addStageText,
  buildRecordRow,
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
import { AdminAccessSessions, resolveAdminPasswordForRuntime } from "./adminAccessSession";
import { importBootstrapCredential, resolveBootstrapCredentialScopes } from "./nas/bootstrapCredential";
import { NasCredentialStore } from "./nas/credentialStore";
import { checkGeumcheonNasReadiness, requireGeumcheonCredential } from "./nas/readiness";
import { rendererSafeFailure } from "./nas/piiBoundary";
import { createGeumcheonNasRuntime, type GeumcheonNasRuntime } from "./nas/runtime";
import {
  assertGeumcheonRecordEditAllowed,
  assertPlayerRecordSaveAllowed,
  assertReviewExternalStorageIpcAllowed,
  createReviewGeumcheonConnection,
  initializeGeumcheonConnection,
  listGeumcheonRecords,
  validateReviewStorage,
  type ReviewGeumcheonConnection
} from "./geumcheonConnection";
import { toGeumcheonPublicRecordRow } from "../shared/utils/geumcheonRecordEvidence";
import {
  RendererCheckpointFence,
  requestRendererActiveAttemptCheckpoint
} from "./rendererCheckpointHandshake";

let mainWindow: BrowserWindow | null = null;
let startupRuntimeRoot: string | undefined;
let profilePathOverride: string | undefined;
let protectedProfile: DeploymentProfileStore | undefined;
let activeProfile: DeploymentProfileV2 | undefined;
let activeProfilePath: string | undefined;
let lastWriteSuccess: string | undefined;
let lastReadSuccess: string | undefined;

const metadata = packagedMetadata();
const variant = resolveVariant(metadata.variant, metadata.reviewContext !== undefined);
const selectedEventProfileId = app.isPackaged
  ? metadata.eventProfileId
  : process.env.EVENT_PROFILE;
const requiresSingleInstanceLock = metadata.reviewContext !== undefined || selectedEventProfileId === "geumcheon-2026";
if (selectedEventProfileId === "geumcheon-2026" && !metadata.reviewContext) {
  const installId = createHash("sha256").update(path.resolve(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))).digest("hex").slice(0,20);
  app.setPath("userData", path.join(process.env.LOCALAPPDATA || process.env.APPDATA || resolveRoot(), "ThePMD", "TypingKing2026", "launch", installId, variant));
}
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
  source: "production";
  runtime: GeumcheonNasRuntime;
  checkpointFence: RendererCheckpointFence;
  checkReadiness(): Promise<GameStartReadiness>;
  flush(): ReturnType<GeumcheonNasRuntime["flush"]>;
};

type GeumcheonConnection = GeumcheonNasConnection | ReviewGeumcheonConnection;

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
    executionRole: variant.endsWith("leaderboard") ? "leaderboard" : "player",
    credentials: protectedProfile ? { getToken: role => protectedProfile!.token(role), assertCurrent: assertCurrentDeployment, assertLocalIdentity:()=>protectedProfile!.assertLocalIdentity() } : undefined,
    runtimeRoot,
    safeStorage,
    onReadSuccess: () => {markDeploymentSuccess("read");},
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
  for (const scope of protectedProfile ? [] : resolveBootstrapCredentialScopes(deviceProfile.role)) {
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
    source: "production",
    runtime,
    checkpointFence: new RendererCheckpointFence(),
    checkReadiness: () => checkGeumcheonNasReadiness({
      checkAuthenticatedReady: () => runtime.checkReady()
    }),
    flush: () => {
      if (variant.endsWith("leaderboard")) return Promise.resolve({attempted:0,sent:0,blocked:0,deferred:0,authRequired:false});
      if (flushInFlight) return flushInFlight;
      flushInFlight = runtime.flush().then(result=>{if(result.sent>0)markDeploymentSuccess("write");return result;}).finally(() => {
        flushInFlight = null;
      });
      return flushInFlight;
    }
  };
  if (!variant.endsWith("leaderboard")) {
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
  if (eventProfile.profileId === "geumcheon-2026") {
    const fullScreenWindow = mainWindow;
    fullScreenWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key !== "F11"
        || input.control || input.alt || input.meta || input.shift) return;
      event.preventDefault();
      if (!input.isAutoRepeat && !fullScreenWindow.isDestroyed()) {
        fullScreenWindow.setFullScreen(!fullScreenWindow.isFullScreen());
      }
    });
  }
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
): Promise<GeumcheonConnection | null> {
  const variantPolicy = eventProfile.variants[variant];
  const isPracticeVariant = variantPolicy.sessionKind === "practice";
  // ensureRuntime(설정 로드) 전에 연습모드를 확정해야 세션 경로가 "연습회차" 폴더로 계산된다.
  setPracticeSessionMode(isPracticeVariant);
  const runtimeRoot = resolveRuntimeRoot();
  const migratedFileCount = portableRuntimeMigrationAllowed(eventProfile.profileId)
    ? migratePortableRuntime(resolveRoot(), runtimeRoot)
    : 0;
  const ctx = ensureRuntime(runtimeRoot, applicationResources.resourceRoot, { eventProfile });
  if (migratedFileCount > 0) {
    ctx.notices.push(`기존 실행 폴더의 설정과 누락 기록 ${migratedFileCount}개를 이 PC의 로컬 저장소로 복사했습니다.`);
  }
  const mode = appModeFromVariant(variant);
  const scopedRecordMode = recordModeFromPolicy(variantPolicy);
  const hasMultipleRecordModes = variantPolicy.gameModes.length > 1;
  const rendererAssetBaseUrl = eventProfile.profileId === "geumcheon-2026"
    ? applicationResources.rendererAssetBaseUrl
    : ctx.assetBaseUrl;
  if(activeProfile && deviceProfile) {
    const sessionPath=path.join(runtimeRoot,"nas",`session-${variant}.json`);
    if(fs.existsSync(sessionPath)) {
      const saved=JSON.parse(fs.readFileSync(sessionPath,"utf8"));
      const selected=activeProfile.allowedSessions.find(s=>s.sessionId===saved.sessionId && s.dayNo===saved.dayNo && s.roundNo===saved.roundNo);
      if(!selected)throw new Error("PROFILE_SESSION_NOT_ALLOWED");
      deviceProfile={...deviceProfile,sessions:{official:{...selected}}};
    }
    ctx.config={...ctx.config,pcId:deviceProfile.deviceId,dayNo:deviceProfile.sessions.official.dayNo,roundNo:deviceProfile.sessions.official.roundNo};
  }
  let geumcheonNas: GeumcheonConnection | null = null;
  if (eventProfile.profileId === "geumcheon-2026") {
    geumcheonNas = await initializeGeumcheonConnection({
      reviewContext: startup?.reviewContext,
      deviceProfile,
      createProduction: (profile) => initializeGeumcheonNasConnection(
        eventProfile,
        profile,
        variantPolicy.sessionKind,
        ctx
      ),
      createReview: async (reviewContext) => createReviewGeumcheonConnection({
        reviewContext,
        runtimeRoot,
        encryption: safeStorage,
        persistLocal: async (input, recordId) => ({ record_id: recordId, ...buildRecordRow(input) })
      })
    });
  }
  const adminAccessSessions = new AdminAccessSessions({
    password: resolveAdminPasswordForRuntime(ctx.config.adminPassword, startup?.reviewContext?.environment),
    verifier: activeProfile?.administrator,
    allowUnavailable: eventProfile.profileId === "geumcheon-2026" && !startup?.reviewContext,
    ttlMs: 15 * 60 * 1000
  });
  if(activeProfile)saveRecoveryAuthorization(path.join(path.dirname(selectionPath()),"administrator-recovery.bin"),ctx.config.adminPassword,activeProfile,runtimeRoot);
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


  let profileCandidate: {profile:DeploymentProfileV2;filePath:string;senderId:number;fingerprint:string} | undefined;
  async function assertSafeProfileChange(allExecutables: boolean): Promise<void> {
    if (!activeProfile || !geumcheonNas) throw new Error("PROFILE_MANAGEMENT_UNAVAILABLE");
    const queue=await geumcheonNas.runtime.queueStatus();
    if(queue.pending || queue.blocked || fs.existsSync(path.join(runtimeRoot,"nas","active-attempt-official.bin"))) throw new Error("PROFILE_BUSY_RECORDS");
    if(allExecutables) {
      const root=path.join(runtimeRoot,"nas","app-leases");
      for(const entry of fs.readdirSync(root)) {
        const pid=Number(fs.readFileSync(path.join(root,entry),"utf8"));
        if(pid && pid!==process.pid) {try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")continue;throw error;}throw new Error("PROFILE_OTHER_APP_RUNNING");}
      }
    }
  }
  ipcMain.handle("deployment:status", event=>safeAsync(async()=>{
    adminAccessSessions.require(event.sender);assertCurrentDeployment();
    if(!activeProfile || !geumcheonNas) throw new Error("PROFILE_MANAGEMENT_UNAVAILABLE");
    const queue=await geumcheonNas.runtime.queueStatus();
    return {profile:{...profilePreview(activeProfile,activeProfilePath!),session:deviceProfile!.sessions.official},lastWriteSuccess:readDeploymentSuccess("write"),lastReadSuccess:readDeploymentSuccess("read"),pending:queue.pending,blocked:queue.blocked};
  }));
  ipcMain.handle("deployment:choose", async event=>{
    const access=safe(()=>adminAccessSessions.require(event.sender));if(!access.ok)return access;
    const selected=await dialog.showOpenDialog({title:"관리자 PC 프로필 선택",properties:["openFile"],filters:[{name:"원래 이름 장치 프로필",extensions:["json"]}]});
    if(selected.canceled || !selected.filePaths[0]){profileCandidate=undefined;return {ok:true,data:null};}
    return safe(()=>{const filePath=selected.filePaths[0];const profile=loadDeploymentProfile(filePath);profileCandidate={profile,filePath,senderId:event.sender.id,fingerprint:profileFingerprint(profile)};return profilePreview(profile,filePath);});
  });
  ipcMain.handle("deployment:cancel", event=>safe(()=>{adminAccessSessions.require(event.sender);profileCandidate=undefined;return true;}));
  ipcMain.handle("deployment:apply", event=>safeAsync(async()=>{
    adminAccessSessions.require(event.sender);
    if(!activeProfile || !geumcheonNas || geumcheonNas.source!=="production")throw new Error("PROFILE_MANAGEMENT_UNAVAILABLE");
    if(!profileCandidate || profileCandidate.senderId!==event.sender.id) throw new Error("PROFILE_CANDIDATE_MISSING");
    const profile=loadDeploymentProfile(profileCandidate.filePath);
    if(profileFingerprint(profile)!==profileCandidate.fingerprint)throw new Error("PROFILE_CANDIDATE_CHANGED");
    if(variantPolicy.role==="player" && profile.device.role!=="player")throw new Error("PROFILE_GAME_ROLE_INVALID");
    const targetRoot=path.join(process.env.LOCALAPPDATA || process.env.APPDATA!, "ThePMD","TypingKing2026",profile.device.eventProfileId,profile.device.deviceId);
    const selectedPath=profileCandidate.filePath;
    await withDeploymentLocks([runtimeRoot,targetRoot],async()=>{
      await assertSafeDeploymentApplication({currentRuntimeRoot:runtimeRoot,targetRuntimeRoot:targetRoot,replacement:profile,safeStorage});
      replaceDeploymentSelection(path.join(targetRoot,"nas","deployment-profile.bin"),selectionPath(),deploymentDirectory(),profile,selectedPath,safeStorage);
    });
    profileCandidate=undefined;
    setTimeout(()=>{app.relaunch();app.quit();},150);
    return true;
  }));
  ipcMain.handle("deployment:setSession", (event, dayNo:unknown, roundNo:unknown)=>safeAsync(async()=>{
    adminAccessSessions.require(event.sender);assertCurrentDeployment();
    if(!Number.isSafeInteger(dayNo) || Number(dayNo)<1 || !Number.isSafeInteger(roundNo) || Number(roundNo)<1)throw new Error("PROFILE_SESSION_INPUT_INVALID");
    const session=activeProfile?.allowedSessions.find(s=>s.dayNo===dayNo && s.roundNo===roundNo);
    if(!session || !deviceProfile)throw new Error("PROFILE_SESSION_NOT_ALLOWED");
    if(variantPolicy.role==="player") await assertSafeProfileChange(false);
    deviceProfile={...deviceProfile,sessions:{official:{...session}}};
    ctx.config={...ctx.config,dayNo:session.dayNo,roundNo:session.roundNo};
    fs.writeFileSync(path.join(runtimeRoot,"nas",`session-${variant}.json`),JSON.stringify(session));
    Object.assign(geumcheonNas!,await initializeGeumcheonNasConnection(eventProfile,deviceProfile,"official",ctx));
    return createBootstrapData({config:ctx.config,assetBaseUrl:rendererAssetBaseUrl,notices:ctx.notices,mode,variant,eventProfile,deviceProfile});
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
  ipcMain.handle("review:validateStorage", (event) =>
    safeAsync(async () => {
      if (!startup?.reviewContext || !geumcheonNas || geumcheonNas.source !== "review") {
        throw new Error("REVIEW_STORAGE_VALIDATION_UNAVAILABLE");
      }
      return validateReviewStorage({
        reviewContext: startup.reviewContext,
        runtime: geumcheonNas.localRuntime,
        requireAdmin: () => { adminAccessSessions.require(event.sender); }
      });
    }, "로컬 검토 저장소를 확인할 수 없습니다.")
  );

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
      assertReviewExternalStorageIpcAllowed(startup?.reviewContext, "stage:publishShared");
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
        () => geumcheonNas!.runtime.checkpoint(input)
      );
    })
  );
  ipcMain.handle("records:save", (_event, input: SaveRecordInput) =>
    safeAsync(async () => {
      assertPlayerRecordSaveAllowed(variantPolicy.role);
      if (geumcheonNas) {
        const row = await geumcheonNas.runtime.save(input);
        void geumcheonNas.flush().catch((error) => {
          appendStartupLog(`Geumcheon NAS save flush failed: ${errorMessage(error)}`);
        });
        return toGeumcheonPublicRecordRow(row);
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
  ipcMain.handle("records:list", async (_event, request: unknown) => {
    if (request !== undefined) {
      const result = await safeAsync(() => listGeumcheonRecords({
        connection: geumcheonNas,
        role: variantPolicy.role,
        eventProfileId: eventProfile.profileId,
        sessionKind: variantPolicy.sessionKind,
        request,
        readLegacy: () => readRecords(ctx)
      }), "기록을 조회할 수 없습니다. 검색 입력과 연결 상태를 확인해 주세요.");
      if (!result.ok || !("data" in result)) return result;
      return { ok: true, data: result.data.rows, matchingRecordIds: result.data.matchingRecordIds };
    }
    return safeAsync(async () => {
      return listGeumcheonRecords({
        connection: geumcheonNas,
        role: variantPolicy.role,
        readLegacy: () => readRecords(ctx)
      });
    }, "기록 파일을 읽을 수 없습니다. 파일이 열려 있거나 손상되었을 수 있습니다.")
  });
  ipcMain.handle(
    "records:update",
    (event, recordId: string, patch: Partial<RecordRow>) =>
      safeAsync(
        async () => {
          const { adminName } = adminAccessSessions.require(event.sender);
          if (!geumcheonNas) return updateRecord(ctx, recordId, patch, adminName);
          assertGeumcheonRecordEditAllowed(patch);
          const before = (await geumcheonNas.runtime.loadRecords()).rows.find(
            (record) => record.record_id === recordId
          );
          if (!before) throw new Error("수정 또는 삭제할 기록을 선택해 주세요.");
          const replacement = recalculateRecord({ ...before, ...patch, record_id: recordId });
          await geumcheonNas.runtime.edit(recordId, replacement, adminName);
          return toGeumcheonPublicRecordRow(replacement);
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
    safeAsync(async () => {
      adminAccessSessions.require(event.sender);
      if(geumcheonNas && activeProfile) {
        assertCurrentDeployment();
        if(!["all","filtered","leaderboard"].includes(scope) || !Array.isArray(rows))throw new Error("CSV_SCOPE_INVALID");
        const full=(await geumcheonNas.runtime.loadRecords({freshOnly:true})).rows;
        const ids=new Set(rows.map(row=>row.record_id));
        const selected=scope==="all"?full:full.filter(row=>ids.has(row.record_id));
        const generated=exportRecords({...ctx,config:{...ctx.config,syncMode:"local"}},selected,scope,scopedRecordMode);
        const result=await dialog.showSaveDialog({title:"관리자 CSV 저장",defaultPath:path.join(app.getPath("documents"),path.basename(generated)),filters:[{name:"CSV",extensions:["csv"]}]});
        if(result.canceled || !result.filePath)return "";
        const generatedPath=path.join(ctx.paths.exportsDir,generated);
        const csv=appendDeploymentCsvContext(fs.readFileSync(generatedPath,"utf8"),deviceProfile!.sessions.official);
        fs.writeFileSync(result.filePath,csv,"utf8");return result.filePath;
      }
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
    safe(() => {
      assertReviewExternalStorageIpcAllowed(startup?.reviewContext, "sync:getSettings");
      return redactRendererConfig(getOneDriveSettings(ctx, pcRole));
    })
  );
  ipcMain.handle("sync:updateSettings", (event, patch) =>
    safe(() => {
      assertReviewExternalStorageIpcAllowed(startup?.reviewContext, "sync:updateSettings");
      adminAccessSessions.require(event.sender);
      return redactRendererConfig(updateOneDriveSettings(ctx, patch, pcRole));
    })
  );
  ipcMain.handle("sync:validateSetup", (event) =>
    safe(() => {
      assertReviewExternalStorageIpcAllowed(startup?.reviewContext, "sync:validateSetup");
      adminAccessSessions.require(event.sender);
      return redactRendererConfig(validateOneDriveSetup(ctx, pcRole));
    })
  );
  ipcMain.handle("sync:poke", (event, reason?: string) => safe(() => {
    assertReviewExternalStorageIpcAllowed(startup?.reviewContext, "sync:poke");
    adminAccessSessions.require(event.sender);
    return pokeOneDriveSync(ctx, reason || "manual");
  }));
  ipcMain.handle("sync:cleanupLegacyArtifacts", (event) =>
    safe(
      () => {
        assertReviewExternalStorageIpcAllowed(startup?.reviewContext, "sync:cleanupLegacyArtifacts");
        adminAccessSessions.require(event.sender);
        return cleanupLegacyOneDriveArtifacts(ctx);
      },
      "OneDrive 불필요 파일 정리에 실패했습니다. OneDrive 상태와 폴더 권한을 확인해 주세요."
    )
  );
  ipcMain.handle("sync:chooseRoot", async (event) => {
    const authorized = safe(() => {
      assertReviewExternalStorageIpcAllowed(startup?.reviewContext, "sync:chooseRoot");
      return adminAccessSessions.require(event.sender);
    });
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
      assertReviewExternalStorageIpcAllowed(startup?.reviewContext, "sync:openSessionFolder");
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
  const profileError=deploymentErrorForDisplay(error);if(profileError)return profileError;
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


function markDeploymentSuccess(kind:"write"|"read"):void {
  const value=new Date().toISOString();
  if(kind==="write")lastWriteSuccess=value;else lastReadSuccess=value;
  try {const file=path.join(resolveRuntimeRoot(),"nas",`last-${kind}-success.txt`),tmp=file+"."+process.pid+".tmp";fs.writeFileSync(tmp,value,"utf8");fs.renameSync(tmp,file);}catch{}
}
function readDeploymentSuccess(kind:"write"|"read"):string|undefined {
  try {const value=fs.readFileSync(path.join(resolveRuntimeRoot(),"nas",`last-${kind}-success.txt`),"utf8");return Number.isFinite(Date.parse(value))?value:undefined;}catch{return kind==="write"?lastWriteSuccess:lastReadSuccess;}
}

function deploymentDirectory(): string { return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath); }
function selectionPath(): string { return path.join(path.dirname(app.getPath("userData")), "selected-profile.bin"); }
function assertCurrentDeployment(): void {
  protectedProfile?.assertCurrent();
  if (activeProfile) {
    const selected = readDeploymentSelection(selectionPath(), deploymentDirectory(), safeStorage);
    if (!selected || profileFingerprint(selected.profile) !== profileFingerprint(activeProfile)) throw new Error("PROFILE_CONFIGURATION_CHANGED");
  }
}
async function initializeDeployment(): Promise<void> {
  if (!startup?.deploymentProfile) return;
  const initialStartup=startup;
  await withDeploymentLocks([initialStartup.runtimeRoot],async()=>{
  activeProfile = initialStartup.deploymentProfile!;
  activeProfilePath = initialStartup.profileFilePath!;
  protectedProfile = new DeploymentProfileStore(path.join(initialStartup.runtimeRoot, "nas", "deployment-profile.bin"), safeStorage);
  protectedProfile.activate(activeProfile);
  saveDeploymentSelection(selectionPath(), deploymentDirectory(), activeProfile, activeProfilePath, safeStorage);
  if(process.platform==="win32") {
    const pipe="\\\\.\\pipe\\typingking-v4-"+createHash("sha256").update(initialStartup.runtimeRoot+"|"+variant).digest("hex");
    const mutex=net.createServer(socket=>socket.end());
    await new Promise<void>((resolve,reject)=>{mutex.once("error",()=>reject(new Error("PROFILE_APP_ALREADY_RUNNING")));mutex.listen(pipe,()=>resolve());});
    app.once("will-quit",()=>mutex.close());
  }
  const leaseRoot = path.join(initialStartup.runtimeRoot,"nas","app-leases");
  fs.mkdirSync(leaseRoot,{recursive:true});
  const leasePath = path.join(leaseRoot, variant + ".pid");
  const previousPid = fs.existsSync(leasePath) ? Number(fs.readFileSync(leasePath,"utf8")) : 0;
  if(previousPid && previousPid !== process.pid) {
    try {process.kill(previousPid,0);throw new Error("PROFILE_APP_ALREADY_RUNNING");}
    catch(error){if((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;}
  }
  fs.writeFileSync(leasePath,String(process.pid));
  app.once("will-quit",()=>{try{if(fs.readFileSync(leasePath,"utf8")===String(process.pid))fs.unlinkSync(leasePath);}catch{}});
  });
}

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
    reviewContext: metadata.reviewContext,
    profilePathOverride,
    requireDeploymentProfileV2:metadata.deploymentProfileVersion===2,
    deploymentOverride: app.isReady() && !profilePathOverride ? (()=>{const saved=readDeploymentSelection(selectionPath(),deploymentDirectory(),safeStorage);return saved?{profile:saved.profile,filePath:saved.selectedFilePath}:undefined;})() : undefined,
    variant
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
  if (startup.userDataPath && selectedEventProfileId !== "geumcheon-2026") app.setPath("userData", startup.userDataPath);
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
    try { initializeStartup(); }
    catch(error) {
      if (!(error instanceof Error) || error.message !== "PROFILE_FILE_MISSING") throw error;
      const choice=await dialog.showMessageBox({type:"warning",title:"PC 프로필이 필요합니다",message:"해당 PC의 원래 이름 프로필 하나를 EXE 옆에 배치해 주세요.",detail:"처음 복구하는 경우 프로필 선택으로 가져올 수 있습니다.",buttons:["프로필 선택","종료"],defaultId:0,cancelId:1});
      if(choice.response!==0){app.exit(1);return;}
      const selected=await dialog.showOpenDialog({title:"PC 프로필 선택",properties:["openFile"],filters:[{name:"장치 프로필",extensions:["json"]}]});
      if(selected.canceled || !selected.filePaths[0]){app.exit(1);return;}
      profilePathOverride=selected.filePaths[0];initializeStartup();
    }
    await initializeDeployment();
  } catch (error) {
    appendStartupLog(`Startup profile initialization failed: ${errorMessage(error)}`);
    if(await openProfileRecovery({error,authorizationPath:path.join(path.dirname(selectionPath()),"administrator-recovery.bin"),selectionPath:selectionPath(),directory:deploymentDirectory(),variant,localAppData:process.env.LOCALAPPDATA || process.env.APPDATA!}))return;
    if (shouldShowStartupErrorDialog(process.env, app.isPackaged)) {
      dialog.showErrorBox("시작할 수 없습니다", formatStartupErrorForDisplay(error));
    }
    app.exit(1);
    return;
  }
  if (!launchPolicy || !startup || !applicationResources) return;
  app.setAppUserModelId(appUserModelId(startup.eventProfile, startup.eventProfile.variants[variant]));
  let geumcheonNas: GeumcheonConnection | null;
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
      dialog.showErrorBox("시작할 수 없습니다", formatStartupErrorForDisplay(error));
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
